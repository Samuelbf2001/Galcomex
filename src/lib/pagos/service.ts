/**
 * Servicio de pagos del trámite — Galcomex
 * A1-T6: Libro de pagos del trámite + saldo en vivo.
 * Sprint 8: N↔N con FacturaProveedor (PagoTramiteFactura), EstadoMovimiento, sin fechaEsperadaPago.
 */

import { randomUUID } from "node:crypto";

import { type Beneficiario, CanalPago, EstadoBorrador, type EstadoTramite, EstadoFacturaProveedor, EstadoMovimiento, Prisma, Rol, type PagoTramite, type PagoTramiteBeneficiario } from "@prisma/client";

import { calcularSaldosIntermedios } from "@/lib/calculations/motor-factura";
import { tiene } from "@/lib/capacidades/resolver";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
} from "@/lib/facturas-proveedor/service";
import { assertTramiteModificable } from "@/lib/tramites/guard";

type CrearPagoInput = {
  tramiteId: string;
  concepto: string;
  /** IDs de beneficiarios a vincular (N↔N). */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  /** Comprobante bancario (Bancolombia) — el que vale ante reclamos. Opcional (no bloquea el pago). */
  documentoId?: string | null;
  /** Comprobante de la página del comercio (puerto/PSE) — opcional, complementa el bancario. */
  comprobanteComercioId?: string | null;
  valor: bigint;
  canalPago: CanalPago;
  fechaRealPago?: Date | null;
  /** IDs de facturas de proveedor a vincular (N↔N). Vacío = pago manual. */
  facturaProveedorIds?: string[];
  /**
   * Banco usado como tercero del 4x1000 (FK a Beneficiario).
   * Si no se envía y canalPago == TRANSF_BANCOLOMBIA → auto-fill desde
   * SIIGO_BENEFICIARIO_BANCOLOMBIA_ID. Para otros canales puede quedar null.
   */
  bancoBeneficiarioId?: string | null;
  usuarioId: string;
};

type AplicacionDetalle = {
  id: string;
  montoAplicado: bigint;
  anticipo: {
    id: string;
    monto: bigint;
    fecha: Date;
    tipoRecaudo: string;
    costoRecaudo: bigint;
    verificadoBanco: boolean;
    costoBancario: bigint;
  };
};

type FacturaProveedorVinculada = {
  numFactura: string;
  proveedorNombre: string;
};

type BeneficiarioMinimo = Pick<Beneficiario, "id" | "nombre" | "nit">;

/** Otro DO del mismo grupoPagoId (pago multi-DO) — para el badge "Pago multi-DO". */
export type GrupoPagoDOInfo = { tramiteId: string; consecutivo: string };

type PagoConRelaciones = PagoTramite & {
  facturasProveedor: { factura: FacturaProveedorVinculada }[];
  beneficiarios: (PagoTramiteBeneficiario & { beneficiario: BeneficiarioMinimo })[];
  bancoBeneficiario: BeneficiarioMinimo | null;
  /** Otros DOs del mismo grupoPagoId (vacío si el pago no pertenece a un grupo multi-DO). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
};

/**
 * Cruce real con el cliente: sale del BorradorFactura cuando está APROBADO o
 * FACTURADO. El cruce siempre se evalúa contra el TOTAL de la factura de venta
 * (Σ líneas + comisión + IVA − retenciones), no contra Σ pagos del trámite.
 * Ver memoria `project_cruce_factura.md` y `lib/calculations/total-lineas.ts`.
 *
 * - estado: "APROBADO" → borrador aprobado pero aún sin estampar en Siigo.
 * - estado: "FACTURADO" → ya tiene `numSiigo`.
 */
type CruceFactura = {
  estado: "APROBADO" | "FACTURADO";
  numSiigo: string | null;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
};

type LibroPagosResult = {
  pagos: PagoConRelaciones[];
  aplicaciones: AplicacionDetalle[];
  totalPagos: bigint;
  costosBancarios: bigint;
  costosBancariosAnticipo: bigint;
  totalAnticipoAplicado: bigint;
  saldos: bigint[];
  saldoFinal: bigint;
  cruceFactura: CruceFactura | null;
};

type ListarPagosFiltros = {
  clienteId?: string;
  tramiteId?: string;
  canalPago?: CanalPago;
  soloPendientes?: boolean;
};

export type PagoGlobalRow = PagoTramite & {
  tramite: {
    id: string;
    consecutivo: string;
    estado: string;
    cliente: { id: string; nombre: string; nit: string };
  };
  beneficiarios: (PagoTramiteBeneficiario & { beneficiario: BeneficiarioMinimo })[];
  /** Otros DOs del mismo grupoPagoId (vacío si el pago no pertenece a un grupo multi-DO). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
};

type ListarPagosResult = {
  pagos: PagoGlobalRow[];
  totalPagos: bigint;
  costosBancarios: bigint;
  totalPendiente: bigint;
};

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

async function resolverCostoBancario(
  canal: CanalPago,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<bigint> {
  const db = tx ?? prisma;
  const entrada = await db.matrizPago.findUnique({
    where: { canalPago: canal },
    select: { costoFijo: true },
  });

  if (!entrada) {
    throw new MatrizCanalNoEncontradoError(canal);
  }

  return entrada.costoFijo;
}

/**
 * Resuelve el Beneficiario configurado como Bancolombia
 * (SIIGO_BENEFICIARIO_BANCOLOMBIA_ID). Devuelve null si no está configurado o
 * si el FK ya no existe; el caller decide si tratar la ausencia como warning.
 */
async function resolverBancoBancolombiaId(
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<string | null> {
  const db = tx ?? prisma;
  const param = await db.parametro.findUnique({
    where: { clave: "SIIGO_BENEFICIARIO_BANCOLOMBIA_ID" },
    select: { valor: true },
  });
  const id = param?.valor?.trim();
  if (!id) return null;
  const benef = await db.beneficiario.findUnique({
    where: { id },
    select: { id: true },
  });
  return benef?.id ?? null;
}

/**
 * Para un lote de pagos, resuelve — por cada uno que tenga grupoPagoId — la
 * lista de OTROS DOs (tramiteId + consecutivo) que comparten el mismo grupo.
 * Usado para el badge "Pago multi-DO" con tooltip en el libro de pagos y en
 * la vista global.
 */
async function cargarGrupoInfo(
  pagos: { id: string; grupoPagoId: string | null; tramiteId: string }[],
): Promise<Map<string, GrupoPagoDOInfo[]>> {
  const grupoIds = [
    ...new Set(
      pagos
        .map((p) => p.grupoPagoId)
        .filter((g): g is string => g !== null),
    ),
  ];

  if (grupoIds.length === 0) {
    return new Map();
  }

  const relacionados = await prisma.pagoTramite.findMany({
    where: { grupoPagoId: { in: grupoIds } },
    select: {
      grupoPagoId: true,
      tramiteId: true,
      tramite: { select: { consecutivo: true } },
    },
  });

  const porGrupo = new Map<string, GrupoPagoDOInfo[]>();
  for (const r of relacionados) {
    if (!r.grupoPagoId) continue;
    const lista = porGrupo.get(r.grupoPagoId) ?? [];
    // Evitar duplicados (varios pagos del mismo DO en el mismo grupo no deberían
    // existir, pero por seguridad deduplicamos por tramiteId).
    if (!lista.some((x) => x.tramiteId === r.tramiteId)) {
      lista.push({ tramiteId: r.tramiteId, consecutivo: r.tramite.consecutivo });
    }
    porGrupo.set(r.grupoPagoId, lista);
  }

  const resultado = new Map<string, GrupoPagoDOInfo[]>();
  for (const p of pagos) {
    if (!p.grupoPagoId) continue;
    const todos = porGrupo.get(p.grupoPagoId) ?? [];
    resultado.set(
      p.id,
      todos.filter((t) => t.tramiteId !== p.tramiteId),
    );
  }
  return resultado;
}

export class MatrizCanalNoEncontradoError extends Error {
  public readonly canal: CanalPago;
  public readonly status = 400;

  constructor(canal: CanalPago) {
    super(`Canal de pago '${canal}' no encontrado en la matriz de recaudo`);
    this.name = "MatrizCanalNoEncontradoError";
    this.canal = canal;
  }
}

export class PagoFacturaDeOtroTramiteError extends Error {
  public readonly status = 422;
  constructor(facturaProveedorId: string, tramiteId: string) {
    super(`La factura de proveedor ${facturaProveedorId} no pertenece al trámite ${tramiteId}`);
    this.name = "PagoFacturaDeOtroTramiteError";
  }
}

export class VerificarMovimientoPermisoError extends Error {
  public readonly status = 403;
  constructor() {
    super("No tienes permiso para verificar este movimiento");
    this.name = "VerificarMovimientoPermisoError";
  }
}

export class SinAnticipoAplicadoError extends Error {
  public readonly status = 422;
  constructor(tramiteId: string) {
    super(`No se puede registrar un pago sin anticipo aplicado al trámite (${tramiteId})`);
    this.name = "SinAnticipoAplicadoError";
  }
}

/** Variante de SinAnticipoAplicadoError para el pago multi-DO: identifica QUÉ DO falla. */
export class SinAnticipoAplicadoMultiDOError extends Error {
  public readonly status = 422;
  public readonly tramiteId: string;
  public readonly consecutivo: string;
  constructor(tramiteId: string, consecutivo: string) {
    super(
      `El DO ${consecutivo} no tiene anticipo aplicado — no se puede incluir en el pago multi-DO`,
    );
    this.name = "SinAnticipoAplicadoMultiDOError";
    this.tramiteId = tramiteId;
    this.consecutivo = consecutivo;
  }
}

export class DocumentoNoEncontradoParaPagoError extends Error {
  public readonly status = 404;
  constructor(documentoId: string) {
    super(`Documento ${documentoId} no encontrado`);
    this.name = "DocumentoNoEncontradoParaPagoError";
  }
}

export class DocumentoDeOtroTramiteError extends Error {
  public readonly status = 422;
  constructor(documentoId: string, tramiteId: string, campo: string) {
    super(`El documento ${documentoId} (${campo}) no pertenece al trámite ${tramiteId}`);
    this.name = "DocumentoDeOtroTramiteError";
  }
}

export class PagoMultiDOSinFacturasError extends Error {
  public readonly status = 422;
  constructor() {
    super("Debes seleccionar al menos una factura de proveedor para el pago multi-DO");
    this.name = "PagoMultiDOSinFacturasError";
  }
}

export class PagoMultiDOBeneficiarioMismatchError extends Error {
  public readonly status = 422;
  constructor(facturaProveedorId: string) {
    super(
      `La factura de proveedor ${facturaProveedorId} no pertenece al beneficiario seleccionado`,
    );
    this.name = "PagoMultiDOBeneficiarioMismatchError";
  }
}

/**
 * Valida (dentro de una transacción) que un Documento exista y pertenezca al
 * trámite indicado. Usado por crearPago/actualizarPago para documentoId
 * (comprobante bancario) y comprobanteComercioId (comprobante de comercio).
 * NO se usa en crearPagoMultiDO: ahí el comprobante es compartido entre
 * varios trámites por diseño (un solo comprobante cubre varios DOs).
 */
async function validarDocumentoDelTramite(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  documentoId: string,
  tramiteId: string,
  campo: string,
): Promise<void> {
  const doc = await tx.documento.findUnique({
    where: { id: documentoId },
    select: { id: true, tramiteId: true },
  });
  if (!doc) {
    throw new DocumentoNoEncontradoParaPagoError(documentoId);
  }
  if (doc.tramiteId !== tramiteId) {
    throw new DocumentoDeOtroTramiteError(documentoId, tramiteId, campo);
  }
}

/**
 * Crea un pago en el libro del trámite.
 * - Resuelve costoBancario automáticamente desde MatrizPago según canalPago.
 * - Vincula N facturas de proveedor vía tabla pivot (N↔N).
 * - Genera AuditLog.
 */
/**
 * Un pago que solo cubre costos propios (facturas que NO se le cobran al
 * cliente, p. ej. la clasificadora) no sale del anticipo del cliente: lo
 * asume Galcomex. Por eso no le aplica "sin anticipo no hay pagos" — una
 * clasificación no tiene anticipo y la clasificadora igual se paga.
 */
function soloCostosPropios(facturas: { repercutible: boolean }[]): boolean {
  return facturas.length > 0 && facturas.every((f) => !f.repercutible);
}

/**
 * "Sin anticipo no hay pagos" solo tiene sentido para las empresas que trabajan
 * con fondo previo (capacidad `anticipos_cliente`). Las que van a crédito
 * (Polyrec ZF, CW ASIA, Sesderma, Coldex, Pierco…: 0 anticipos en 2026 según
 * Siigo) pagan el puerto/VUCE con plata de Galcomex y se les cobra en la
 * factura; exigirles anticipo bloqueaba el libro de pagos (simulación del
 * 2026-09-21).
 */
async function exigeAnticipo(tx: Prisma.TransactionClient, tramiteId: string): Promise<boolean> {
  const tramite = await tx.tramiteDO.findUnique({ where: { id: tramiteId }, select: { clienteId: true } });
  if (!tramite) return true;
  return tiene(await capacidadesDeEmpresa(tramite.clienteId), "anticipos_cliente");
}

export async function crearPago(input: CrearPagoInput): Promise<PagoTramite> {
  const {
    tramiteId,
    concepto,
    beneficiarioIds = [],
    numSoporte,
    documentoId,
    comprobanteComercioId,
    valor,
    canalPago,
    fechaRealPago,
    facturaProveedorIds = [],
    bancoBeneficiarioId,
    usuarioId,
  } = input;

  return prisma.$transaction(async (tx) => {
    await assertTramiteModificable(tx, tramiteId);

    const anticipo = await tx.aplicacionAnticipo.findFirst({
      where: { tramiteId },
      select: { id: true },
    });
    if (!anticipo && (await exigeAnticipo(tx, tramiteId))) {
      const facturasDelPago = facturaProveedorIds.length
        ? await tx.facturaProveedor.findMany({
            where: { id: { in: facturaProveedorIds } },
            select: { repercutible: true },
          })
        : [];
      if (!soloCostosPropios(facturasDelPago)) {
        throw new SinAnticipoAplicadoError(tramiteId);
      }
    }

    // Comprobantes opcionales: si se envían, deben existir y ser del mismo
    // trámite. NO bloquean el pago si se omiten (decisión de negocio: alertar,
    // no bloquear — ver caso Karina).
    if (documentoId) {
      await validarDocumentoDelTramite(tx, documentoId, tramiteId, "comprobante bancario");
    }
    if (comprobanteComercioId) {
      await validarDocumentoDelTramite(tx, comprobanteComercioId, tramiteId, "comprobante de comercio");
    }

    const costoBancario = await resolverCostoBancario(canalPago, tx);

    // Banco asociado al pago (tercero del 4x1000).
    // - TRANSF_BANCOLOMBIA: si el operario no envió banco explícito, se
    //   auto-resuelve desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID. Si el operario
    //   pasó uno (override), se respeta.
    // - Otros canales: lo elige el operario en el modal; puede quedar null.
    let bancoFinal: string | null = bancoBeneficiarioId ?? null;
    if (bancoFinal === null && canalPago === "TRANSF_BANCOLOMBIA") {
      bancoFinal = await resolverBancoBancolombiaId(tx);
    }

    const ultimoPago = await tx.pagoTramite.findFirst({
      where: { tramiteId },
      orderBy: { orden: "desc" },
      select: { orden: true },
    });

    const orden = (ultimoPago?.orden ?? 0) + 1;

    // Validar y marcar facturas de proveedor como PAGADA
    for (const fpId of facturaProveedorIds) {
      const fp = await tx.facturaProveedor.findUnique({ where: { id: fpId } });

      if (!fp) {
        throw new FacturaProveedorNoEncontradaError(fpId);
      }

      if (fp.tramiteId !== tramiteId) {
        throw new PagoFacturaDeOtroTramiteError(fpId, tramiteId);
      }

      if (fp.estado === EstadoFacturaProveedor.FACTURADA_CLIENTE) {
        throw new FacturaProveedorNoModificableError(fpId, fp.estado);
      }
    }

    const pago = await tx.pagoTramite.create({
      data: {
        tramiteId,
        concepto,
        numSoporte,
        documentoId,
        comprobanteComercioId,
        valor,
        canalPago,
        costoBancario,
        orden,
        fechaRealPago,
        bancoBeneficiarioId: bancoFinal,
      },
    });

    // Vincular beneficiarios (N↔N)
    for (const bid of beneficiarioIds) {
      await tx.pagoTramiteBeneficiario.create({
        data: { pagoId: pago.id, beneficiarioId: bid },
      });
    }

    // Crear pivot records y marcar facturas como PAGADA
    for (const fpId of facturaProveedorIds) {
      await tx.pagoTramiteFactura.create({
        data: { pagoId: pago.id, facturaId: fpId },
      });

      await tx.facturaProveedor.update({
        where: { id: fpId },
        data: { estado: EstadoFacturaProveedor.PAGADA },
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: fpId,
          accion: "UPDATE_ESTADO",
          usuarioId,
          tramiteId,
          antes: normalizeSerializable({ estado: EstadoFacturaProveedor.REGISTRADA }),
          despues: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId,
        tramiteId,
        despues: normalizeSerializable({ ...pago, beneficiarioIds, facturaProveedorIds }),
      },
    });

    return pago;
  });
}

/**
 * Actualiza el canal de pago de un pago existente (y/o valor/concepto/etc).
 * Recalcula costoBancario automáticamente si cambia el canal.
 */
export async function actualizarPago(
  pagoId: string,
  cambios: {
    canalPago?: CanalPago;
    valor?: bigint;
    concepto?: string;
    /** Si se provee, reemplaza todos los beneficiarios vinculados. */
    beneficiarioIds?: string[];
    numSoporte?: string | null;
    fechaRealPago?: Date | null;
    /** Banco (Beneficiario) para el 4x1000. null = limpiar. */
    bancoBeneficiarioId?: string | null;
    /** Comprobante bancario (Bancolombia). null = limpiar. */
    documentoId?: string | null;
    /** Comprobante de la página del comercio (puerto/PSE), opcional. null = limpiar. */
    comprobanteComercioId?: string | null;
  },
  usuarioId: string,
): Promise<PagoTramite> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
    });

    if (!actual) {
      throw new Error(`Pago ${pagoId} no encontrado`);
    }

    await assertTramiteModificable(tx, actual.tramiteId);

    // Comprobantes opcionales: si se envían (no null/undefined), deben existir
    // y ser del mismo trámite del pago.
    if (cambios.documentoId) {
      await validarDocumentoDelTramite(tx, cambios.documentoId, actual.tramiteId, "comprobante bancario");
    }
    if (cambios.comprobanteComercioId) {
      await validarDocumentoDelTramite(
        tx,
        cambios.comprobanteComercioId,
        actual.tramiteId,
        "comprobante de comercio",
      );
    }

    const canalEfectivo = cambios.canalPago ?? actual.canalPago;
    const costoBancario =
      cambios.canalPago !== undefined
        ? await resolverCostoBancario(canalEfectivo, tx)
        : actual.costoBancario;

    const { beneficiarioIds, ...camposPago } = cambios;

    // Si el canal cambia a TRANSF_BANCOLOMBIA y no se envió banco explícito,
    // auto-resolver al Beneficiario configurado en SIIGO_BENEFICIARIO_BANCOLOMBIA_ID.
    if (
      cambios.canalPago === "TRANSF_BANCOLOMBIA" &&
      camposPago.bancoBeneficiarioId === undefined
    ) {
      const auto = await resolverBancoBancolombiaId(tx);
      if (auto) camposPago.bancoBeneficiarioId = auto;
    }

    const updated = await tx.pagoTramite.update({
      where: { id: pagoId },
      data: {
        ...camposPago,
        costoBancario,
      },
    });

    // Sincronizar pivot de beneficiarios si se enviaron
    if (beneficiarioIds !== undefined) {
      await tx.pagoTramiteBeneficiario.deleteMany({ where: { pagoId } });
      for (const bid of beneficiarioIds) {
        await tx.pagoTramiteBeneficiario.create({
          data: { pagoId, beneficiarioId: bid },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pagoId,
        accion: "UPDATE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(actual),
        despues: normalizeSerializable({ ...updated, beneficiarioIds }),
      },
    });

    return updated;
  });
}

/**
 * Elimina un pago del libro del trámite.
 * Revierte el estado PAGADA→REGISTRADA de las facturas de proveedor vinculadas (pivot).
 */
export async function eliminarPago(
  pagoId: string,
  usuarioId: string,
): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      include: { facturasProveedor: { select: { facturaId: true } } },
    });

    if (!actual) {
      throw new Error(`Pago ${pagoId} no encontrado`);
    }

    await assertTramiteModificable(tx, actual.tramiteId);

    // Recalcular estado de FPs vinculadas antes de borrar el pago
    for (const { facturaId } of actual.facturasProveedor) {
      const pagosRestantes = await tx.pagoTramiteFactura.count({
        where: {
          facturaId,
          NOT: { pagoId },
        },
      });
      const siguienteEstado =
        pagosRestantes > 0
          ? EstadoFacturaProveedor.PAGADA
          : EstadoFacturaProveedor.REGISTRADA;

      await tx.facturaProveedor.update({
        where: { id: facturaId },
        data: { estado: siguienteEstado },
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaId,
          accion: "UPDATE_ESTADO",
          usuarioId,
          tramiteId: actual.tramiteId,
          antes: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
          despues: normalizeSerializable({ estado: siguienteEstado }),
        },
      });
    }

    // Los pivot records se borran en cascada (onDelete: Cascade)
    await tx.pagoTramite.delete({ where: { id: pagoId } });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pagoId,
        accion: "DELETE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(actual),
      },
    });
  });
}

/**
 * Cambia el estado de un pago (BORRADOR → REALIZADO → VERIFICADO).
 * Regla de permiso:
 *   - Trámite con cliente SOCIO_LM: solo ADMIN puede verificar.
 *   - Trámite con cliente PROPIO: ADMIN o OPERATIVO pueden verificar.
 */
export async function verificarPago(
  pagoId: string,
  nuevoEstado: EstadoMovimiento,
  usuarioRol: Rol,
): Promise<PagoTramite> {
  return prisma.$transaction(async (tx) => {
    const pago = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      include: { tramite: { include: { cliente: { select: { tipo: true } } } } },
    });

    if (!pago) {
      throw new Error(`Pago ${pagoId} no encontrado`);
    }

    await assertTramiteModificable(tx, pago.tramite);

    const esClienteSocioLM = pago.tramite.cliente.tipo === "SOCIO_LM";
    const puedeVerificar = usuarioRol === Rol.ADMIN ||
      (!esClienteSocioLM && usuarioRol === Rol.OPERATIVO);

    if (!puedeVerificar) {
      throw new VerificarMovimientoPermisoError();
    }

    return tx.pagoTramite.update({
      where: { id: pagoId },
      data: { estado: nuevoEstado },
    });
  });
}

export async function getPagoConBeneficiario(pagoId: string) {
  return prisma.pagoTramite.findUnique({
    where: { id: pagoId },
    include: {
      beneficiarios: {
        include: { beneficiario: { select: { id: true, nombre: true, nit: true } } },
      },
      facturasProveedor: {
        include: {
          factura: { select: { numFactura: true, proveedorNombre: true } },
        },
      },
      bancoBeneficiario: { select: { id: true, nombre: true, nit: true } },
    },
  });
}

/**
 * Retorna el libro de pagos del trámite con saldo corriente línea a línea.
 */
export async function getLibroPagos(tramiteId: string): Promise<LibroPagosResult> {
  const [pagos, rawAplicaciones, borradorCruce] = await Promise.all([
    prisma.pagoTramite.findMany({
      where: { tramiteId },
      orderBy: { orden: "asc" },
      include: {
        facturasProveedor: {
          include: {
            factura: { select: { numFactura: true, proveedorNombre: true } },
          },
        },
        beneficiarios: {
          include: { beneficiario: { select: { id: true, nombre: true, nit: true } } },
        },
        bancoBeneficiario: { select: { id: true, nombre: true, nit: true } },
      },
    }),
    prisma.aplicacionAnticipo.findMany({
      where: { tramiteId },
      include: {
        anticipo: {
          select: { id: true, monto: true, fecha: true, tipoRecaudo: true, costoRecaudo: true, verificadoBanco: true },
        },
      },
      orderBy: { anticipo: { fecha: "asc" } },
    }),
    // El cruce con el cliente sale del borrador aprobado o facturado más
    // reciente. `totalFactura`, `saldoAFavorCliente` y `saldoACargoCliente` ya
    // están promovidos desde Σ líneas vía `recalcularTotalBorrador`, por eso
    // sirven directamente como cruce real (no se rederiva).
    prisma.borradorFactura.findFirst({
      where: {
        tramiteId,
        estado: { in: [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        estado: true,
        numFacturaSiigo: true,
        totalFactura: true,
        saldoAFavorCliente: true,
        saldoACargoCliente: true,
      },
    }),
  ]);

  const aplicaciones: AplicacionDetalle[] = rawAplicaciones.map((a) => ({
    id: a.id,
    montoAplicado: a.montoAplicado,
    anticipo: {
      id: a.anticipo.id,
      monto: a.anticipo.monto,
      fecha: a.anticipo.fecha,
      tipoRecaudo: a.anticipo.tipoRecaudo,
      costoRecaudo: a.anticipo.costoRecaudo,
      verificadoBanco: a.anticipo.verificadoBanco,
      costoBancario: a.anticipo.costoRecaudo,
    },
  }));

  const totalAnticipoAplicado = aplicaciones.reduce(
    (sum, a) => sum + a.montoAplicado,
    0n,
  );
  const costosBancariosAnticipo = aplicaciones.reduce(
    (sum, a) => sum + a.anticipo.costoBancario,
    0n,
  );

  const totalPagos = pagos.reduce((sum, p) => sum + p.valor, 0n);
  const costosBancarios = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);

  const saldos = calcularSaldosIntermedios(totalAnticipoAplicado, pagos);
  const saldoFinal =
    saldos.length > 0 ? saldos[saldos.length - 1] : totalAnticipoAplicado;

  const cruceFactura: CruceFactura | null = borradorCruce
    ? {
        estado: borradorCruce.estado as "APROBADO" | "FACTURADO",
        numSiigo: borradorCruce.numFacturaSiigo,
        totalFactura: borradorCruce.totalFactura,
        saldoAFavorCliente: borradorCruce.saldoAFavorCliente,
        saldoACargoCliente: borradorCruce.saldoACargoCliente,
      }
    : null;

  // Pago multi-DO (grupoPagoId): resolver los OTROS DOs del grupo para el
  // badge "Pago multi-DO" con tooltip.
  const grupoInfo = await cargarGrupoInfo(
    pagos.map((p) => ({ id: p.id, grupoPagoId: p.grupoPagoId, tramiteId: p.tramiteId })),
  );
  const pagosConGrupo = pagos.map((p) => ({
    ...p,
    grupoOtrosDOs: grupoInfo.get(p.id) ?? [],
  }));

  return {
    pagos: pagosConGrupo as PagoConRelaciones[],
    aplicaciones,
    totalPagos,
    costosBancarios,
    costosBancariosAnticipo,
    totalAnticipoAplicado,
    saldos,
    saldoFinal,
    cruceFactura,
  };
}

/**
 * Lista TODOS los pagos de TODOS los trámites para el módulo global de pagos.
 */
export async function listarPagosGlobal(
  filtros: ListarPagosFiltros = {},
): Promise<ListarPagosResult> {
  const { clienteId, tramiteId, canalPago, soloPendientes } = filtros;

  const pagos = await prisma.pagoTramite.findMany({
    where: {
      ...(tramiteId ? { tramiteId } : {}),
      ...(canalPago ? { canalPago } : {}),
      ...(soloPendientes ? { fechaRealPago: null } : {}),
      ...(clienteId ? { tramite: { clienteId } } : {}),
    },
    include: {
      tramite: {
        select: {
          id: true,
          consecutivo: true,
          estado: true,
          cliente: { select: { id: true, nombre: true, nit: true } },
        },
      },
      beneficiarios: {
        include: { beneficiario: { select: { id: true, nombre: true, nit: true } } },
      },
    },
    orderBy: [
      { tramite: { consecutivo: "asc" } },
      { orden: "asc" },
    ],
  });

  const totalPagos = pagos.reduce((sum, p) => sum + p.valor, 0n);
  const costosBancarios = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);
  const totalPendiente = pagos.reduce(
    (sum, p) => (p.fechaRealPago === null ? sum + p.valor : sum),
    0n,
  );

  const grupoInfo = await cargarGrupoInfo(
    pagos.map((p) => ({ id: p.id, grupoPagoId: p.grupoPagoId, tramiteId: p.tramiteId })),
  );
  const pagosConGrupo = pagos.map((p) => ({
    ...p,
    grupoOtrosDOs: grupoInfo.get(p.id) ?? [],
  }));

  return {
    pagos: pagosConGrupo as PagoGlobalRow[],
    totalPagos,
    costosBancarios,
    totalPendiente,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pago multi-DO (caso Karina/Occidente)
//
// Una sola transferencia del beneficiario cubre facturas de proveedor que
// pertenecen a VARIOS trámites (DOs) distintos. En vez de obligar a Camila a
// registrar N pagos manuales con copy/paste de carpetas externas, este flujo:
//   1. Lista TODAS las FacturaProveedor REGISTRADA del beneficiario, sin
//      importar el trámite (listarFacturasElegiblesMultiDO).
//   2. Recibe la selección + monto a pagar por factura y crea, en UNA sola
//      transacción, UN PagoTramite POR CADA trámite involucrado — valor =
//      Σ montos de las facturas seleccionadas de ese DO — todos con el mismo
//      grupoPagoId, documentoId y comprobanteComercioId (crearPagoMultiDO).
// ─────────────────────────────────────────────────────────────────────────────

export type FacturaElegibleMultiDO = {
  id: string;
  numFactura: string;
  valor: bigint;
  fecha: Date;
  tramiteId: string;
  tramiteConsecutivo: string;
  clienteNombre: string;
  /** true si el DO ya tiene al menos una AplicacionAnticipo (regla "sin anticipo no hay pagos"). */
  tieneAnticipoAplicado: boolean;
};

/**
 * Lista todas las FacturaProveedor en estado REGISTRADA de un beneficiario,
 * de TODOS los trámites, para el selector del pago multi-DO.
 */
export async function listarFacturasElegiblesMultiDO(
  beneficiarioId: string,
): Promise<FacturaElegibleMultiDO[]> {
  const facturas = await prisma.facturaProveedor.findMany({
    where: { beneficiarioId, estado: EstadoFacturaProveedor.REGISTRADA },
    include: {
      tramite: {
        select: { id: true, consecutivo: true, cliente: { select: { nombre: true } } },
      },
    },
    orderBy: [{ tramite: { consecutivo: "asc" } }, { fecha: "asc" }],
  });

  const tramiteIds = [...new Set(facturas.map((f) => f.tramiteId))];
  const aplicaciones = tramiteIds.length
    ? await prisma.aplicacionAnticipo.findMany({
        where: { tramiteId: { in: tramiteIds } },
        select: { tramiteId: true },
      })
    : [];
  const tramitesConAnticipo = new Set(aplicaciones.map((a) => a.tramiteId));

  return facturas.map((f) => ({
    id: f.id,
    numFactura: f.numFactura,
    valor: f.valor,
    fecha: f.fecha,
    tramiteId: f.tramiteId,
    tramiteConsecutivo: f.tramite.consecutivo,
    clienteNombre: f.tramite.cliente.nombre,
    // Un costo propio se paga aunque el DO no tenga anticipo (`soloCostosPropios`).
    tieneAnticipoAplicado: tramitesConAnticipo.has(f.tramiteId) || !f.repercutible,
  }));
}

export type CrearPagoMultiDOInput = {
  beneficiarioId: string;
  /** Facturas seleccionadas con el monto a pagar por cada una (puede ser parcial). */
  facturas: { facturaProveedorId: string; monto: bigint }[];
  canalPago: CanalPago;
  fechaRealPago?: Date | null;
  concepto?: string;
  /** Comprobante bancario (Bancolombia) — compartido por todos los pagos del grupo. */
  documentoId?: string | null;
  /** Comprobante de comercio (opcional) — compartido por todos los pagos del grupo. */
  comprobanteComercioId?: string | null;
  bancoBeneficiarioId?: string | null;
  usuarioId: string;
};

export type CrearPagoMultiDOResult = {
  grupoPagoId: string;
  pagos: PagoTramite[];
};

/**
 * Crea un pago multi-DO: un solo comprobante/canal cubre facturas de
 * proveedor de varios trámites distintos.
 *
 * Reglas:
 * - Un PagoTramite por trámite involucrado (valor = Σ montos de sus facturas).
 * - Mismo grupoPagoId (UUID), documentoId y comprobanteComercioId en todos.
 * - El costo bancario del canal se cobra UNA sola vez — en el PRIMER pago
 *   creado del grupo (orden de iteración = orden de trámites en `facturas`
 *   deduplicado). Los demás pagos del grupo quedan con costoBancario = 0 para
 *   no inflar los costos bancarios totales del cliente (el banco solo cobra
 *   una transferencia real, aunque el sistema la reparta en N registros).
 * - Regla "sin anticipo no hay pagos" (punto 3) aplica por cada DO
 *   involucrado: si alguno no tiene AplicacionAnticipo, se rechaza TODO el
 *   pago multi-DO indicando cuál DO falla (SinAnticipoAplicadoMultiDOError).
 * - NO se valida documentoId/comprobanteComercioId contra "mismo trámite"
 *   (a diferencia de crearPago) porque por diseño el comprobante es
 *   compartido entre varios trámites — solo se valida que el Documento exista.
 */
export async function crearPagoMultiDO(
  input: CrearPagoMultiDOInput,
): Promise<CrearPagoMultiDOResult> {
  const {
    beneficiarioId,
    facturas,
    canalPago,
    fechaRealPago,
    concepto,
    documentoId,
    comprobanteComercioId,
    bancoBeneficiarioId,
    usuarioId,
  } = input;

  if (facturas.length === 0) {
    throw new PagoMultiDOSinFacturasError();
  }

  return prisma.$transaction(async (tx) => {
    if (documentoId) {
      const doc = await tx.documento.findUnique({ where: { id: documentoId }, select: { id: true } });
      if (!doc) throw new DocumentoNoEncontradoParaPagoError(documentoId);
    }
    if (comprobanteComercioId) {
      const doc = await tx.documento.findUnique({
        where: { id: comprobanteComercioId },
        select: { id: true },
      });
      if (!doc) throw new DocumentoNoEncontradoParaPagoError(comprobanteComercioId);
    }

    // Cargar todas las facturas seleccionadas y validar estado/beneficiario.
    const facturaIds = facturas.map((f) => f.facturaProveedorId);
    const fps = await tx.facturaProveedor.findMany({
      where: { id: { in: facturaIds } },
      include: { tramite: { select: { id: true, consecutivo: true, estado: true } } },
    });
    const fpsPorId = new Map(fps.map((fp) => [fp.id, fp]));

    for (const { facturaProveedorId } of facturas) {
      const fp = fpsPorId.get(facturaProveedorId);
      if (!fp) {
        throw new FacturaProveedorNoEncontradaError(facturaProveedorId);
      }
      if (fp.beneficiarioId !== beneficiarioId) {
        throw new PagoMultiDOBeneficiarioMismatchError(facturaProveedorId);
      }
      if (fp.estado === EstadoFacturaProveedor.FACTURADA_CLIENTE) {
        throw new FacturaProveedorNoModificableError(facturaProveedorId, fp.estado);
      }
    }

    // Agrupar por trámite: Σ montos + lista de facturas de ese DO.
    // Map preserva el orden de inserción (= orden en que aparecen en `facturas`),
    // que es lo que determina cuál pago del grupo se lleva el costoBancario.
    type GrupoTramite = {
      consecutivo: string;
      estado: EstadoTramite;
      facturas: { facturaId: string; monto: bigint }[];
      total: bigint;
      soloCostosPropios: boolean;
    };
    const porTramite = new Map<string, GrupoTramite>();
    for (const { facturaProveedorId, monto } of facturas) {
      const fp = fpsPorId.get(facturaProveedorId)!;
      const entry = porTramite.get(fp.tramiteId) ?? {
        consecutivo: fp.tramite.consecutivo,
        estado: fp.tramite.estado,
        facturas: [],
        total: 0n,
        soloCostosPropios: true,
      };
      entry.facturas.push({ facturaId: facturaProveedorId, monto });
      entry.soloCostosPropios &&= !fp.repercutible;
      entry.total += monto;
      porTramite.set(fp.tramiteId, entry);
    }

    // Trámite cerrado no admite pagos — valida CADA DO del grupo antes de
    // seguir (un solo DO cerrado rechaza el pago multi-DO completo).
    for (const [tramiteId, grupo] of porTramite) {
      await assertTramiteModificable(tx, {
        id: tramiteId,
        consecutivo: grupo.consecutivo,
        estado: grupo.estado,
      });
    }

    // Regla "sin anticipo no hay pagos" — aplica a CADA DO del grupo, salvo
    // a los que solo tienen costos propios (ver `soloCostosPropios`) y a las
    // empresas que van a crédito (ver `exigeAnticipo`).
    for (const [tramiteId, grupo] of porTramite) {
      if (grupo.soloCostosPropios) continue;
      const anticipo = await tx.aplicacionAnticipo.findFirst({
        where: { tramiteId },
        select: { id: true },
      });
      if (!anticipo && (await exigeAnticipo(tx, tramiteId))) {
        throw new SinAnticipoAplicadoMultiDOError(tramiteId, grupo.consecutivo);
      }
    }

    const costoBancarioTotal = await resolverCostoBancario(canalPago, tx);

    let bancoFinal: string | null = bancoBeneficiarioId ?? null;
    if (bancoFinal === null && canalPago === "TRANSF_BANCOLOMBIA") {
      bancoFinal = await resolverBancoBancolombiaId(tx);
    }

    const grupoPagoId = randomUUID();
    const pagosCreados: PagoTramite[] = [];
    let esPrimerPagoDelGrupo = true;

    for (const [tramiteId, grupo] of porTramite) {
      const ultimoPago = await tx.pagoTramite.findFirst({
        where: { tramiteId },
        orderBy: { orden: "desc" },
        select: { orden: true },
      });
      const orden = (ultimoPago?.orden ?? 0) + 1;

      const conceptoFinal =
        concepto ??
        `Pago multi-DO — ${grupo.facturas.length} factura(s) de proveedor`;

      const pago = await tx.pagoTramite.create({
        data: {
          tramiteId,
          concepto: conceptoFinal,
          documentoId: documentoId ?? null,
          comprobanteComercioId: comprobanteComercioId ?? null,
          grupoPagoId,
          valor: grupo.total,
          canalPago,
          // El banco solo cobra el costo del canal UNA vez por transferencia
          // real; solo el primer pago del grupo lo registra para no inflar
          // los costos bancarios totales del cliente.
          costoBancario: esPrimerPagoDelGrupo ? costoBancarioTotal : 0n,
          orden,
          fechaRealPago,
          bancoBeneficiarioId: bancoFinal,
        },
      });
      esPrimerPagoDelGrupo = false;

      await tx.pagoTramiteBeneficiario.create({
        data: { pagoId: pago.id, beneficiarioId },
      });

      for (const { facturaId, monto } of grupo.facturas) {
        await tx.pagoTramiteFactura.create({
          data: { pagoId: pago.id, facturaId },
        });

        const fpAntes = fpsPorId.get(facturaId)!;
        await tx.facturaProveedor.update({
          where: { id: facturaId },
          data: { estado: EstadoFacturaProveedor.PAGADA },
        });

        await tx.auditLog.create({
          data: {
            entidad: "FacturaProveedor",
            entidadId: facturaId,
            accion: "UPDATE_ESTADO",
            usuarioId,
            tramiteId,
            antes: normalizeSerializable({ estado: fpAntes.estado, montoPagadoEnGrupo: monto }),
            despues: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          entidad: "PagoTramite",
          entidadId: pago.id,
          accion: "CREATE",
          usuarioId,
          tramiteId,
          despues: normalizeSerializable({
            ...pago,
            grupoPagoId,
            beneficiarioId,
            facturaProveedorIds: grupo.facturas.map((f) => f.facturaId),
          }),
        },
      });

      pagosCreados.push(pago);
    }

    // Auditoría a nivel de grupo (no pertenece a un único trámite).
    await tx.auditLog.create({
      data: {
        entidad: "PagoTramiteGrupo",
        entidadId: grupoPagoId,
        accion: "CREATE",
        usuarioId,
        despues: normalizeSerializable({
          grupoPagoId,
          beneficiarioId,
          canalPago,
          costoBancarioTotal,
          tramites: [...porTramite.entries()].map(([tramiteId, g]) => ({
            tramiteId,
            consecutivo: g.consecutivo,
            valor: g.total,
          })),
        }),
      },
    });

    return { grupoPagoId, pagos: pagosCreados };
  });
}
