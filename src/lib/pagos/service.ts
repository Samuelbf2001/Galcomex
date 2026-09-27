/**
 * Servicio de pagos del trámite — Galcomex
 * A1-T6: Libro de pagos del trámite + saldo en vivo.
 * Sprint 8: N↔N con FacturaProveedor (PagoTramiteFactura), EstadoMovimiento, sin fechaEsperadaPago.
 * CxP v2 (docs/CXP-PROVEEDORES.md, diseño §B): la factura de proveedor tiene un
 * SALDO (valor − pagado − ajustes − cruzado) y todo lo que lo baja o lo sube
 * pasa por `aplicarSaldo` / `revertirSaldo` (`src/lib/cxp/aplicar.ts`), con
 * bloqueo de fila y el guardián de BD encendido (M5). Una factura pagada no se
 * vuelve a pagar por ningún camino; un pago menor deja la factura Abonada.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  type Beneficiario,
  CanalPago,
  type CostoBancarioAsumidoPor,
  EstadoBorrador,
  EstadoMovimiento,
  Prisma,
  Rol,
  type PagoTramite,
  type PagoTramiteBeneficiario,
} from "@prisma/client";

import { cargarPagosParaCobro } from "@/lib/borradores/pagos-para-cobro";
import { calcularSaldosIntermedios } from "@/lib/calculations/motor-factura";
import { aplicarSaldo, bloquearFacturas, revertirSaldo } from "@/lib/cxp/aplicar";
import { bloquearTramites } from "@/lib/cxp/bloqueos";
import {
  BloqueConDoCerradoError,
  ComprobanteObligatorioError,
  errorDeAplicacion,
  FacturaDeOtroProveedorError,
  FacturaRepetidaError,
  FacturaSinMontoError,
  IdempotenciaConflictoError,
  MontoInvalidoError,
  PagoDeBloqueError,
  PagoExcedeSaldoError,
  PagoNoCuadraError,
  PagoNoEditableError,
  SinAnticipoError,
} from "@/lib/cxp/errores";
import {
  cargarFilasFacturas,
  fichasDeEmpresa,
  fichasHermanas,
  type FilaFacturaCxp,
  resumenPorProveedor,
} from "@/lib/cxp/estado-cuenta";
import {
  type AdvertenciaPago,
  advertenciaAnticipoInsuficiente,
  advertenciaAnticipoSinVerificar,
  advertenciaCostoNoCobrable,
  advertenciaValorTransferido,
} from "@/lib/cxp/pagabilidad";
import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import {
  claveProveedorDeFicha,
  costoPorPago,
  formatoPesos,
  numeroFacturaVisible,
  type ProveedorDePago,
  reglaCostoPorDefecto,
  repartirFIFO,
  type ResumenCxp,
  saldoDe,
  type SolicitudAplicacion,
  validarAplicaciones,
} from "@/lib/cxp/saldos";
import type { CostoAsumidoPor, FacturaBloqueada } from "@/lib/cxp/tipos";
import { prisma } from "@/lib/db/prisma";
import { fechaCalendarioAInput } from "@/lib/tiempo/bogota";
import { assertTramiteModificable, TramiteCerradoError } from "@/lib/tramites/guard";

type Tx = Prisma.TransactionClient;

/** Una aplicación del pago a una factura de proveedor (COP > 0, nunca más que su saldo). */
export type AplicacionPagoInput = { facturaProveedorId: string; monto: bigint };

type CrearPagoInput = {
  tramiteId: string;
  concepto: string;
  /** IDs de beneficiarios a vincular (N↔N). Vacío + facturas = se completa con el proveedor de la factura. */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  /** Comprobante bancario — el que vale ante reclamos. Opcional en el pago suelto (no bloquea). */
  documentoId?: string | null;
  /** Comprobante de la página del comercio (puerto/PSE) — opcional, complementa el bancario. */
  comprobanteComercioId?: string | null;
  valor: bigint;
  canalPago: CanalPago;
  fechaRealPago?: Date | null;
  /**
   * CxP v2: cuánto de este pago va a cada factura. Σ montos = `valor` (si no,
   * 422 PAGO_NO_CUADRA). Es la entrada que usa la pantalla.
   */
  aplicaciones?: AplicacionPagoInput[];
  /**
   * Entrada heredada (MCP / scripts): el `valor` se reparte FIFO (fecha,
   * creación, id) entre estas facturas, cada una hasta su saldo. Rechaza si
   * sobra (PAGO_EXCEDE_SALDO) o si alguna queda sin monto (FACTURA_SIN_MONTO):
   * nunca enlaza a medias en silencio. No se combina con `aplicaciones`.
   */
  facturaProveedorIds?: string[];
  /**
   * Banco usado como tercero del 4x1000 (FK a Beneficiario).
   * Si no se envía y canalPago == TRANSF_BANCOLOMBIA → auto-fill desde
   * SIIGO_BENEFICIARIO_BANCOLOMBIA_ID. Para otros canales puede quedar null.
   */
  bancoBeneficiarioId?: string | null;
  /** Pago en efectivo del socio (Lucho). */
  viaSocio?: boolean;
  /** Idempotencia (UUID que genera la pantalla): el doble clic devuelve el mismo pago con `repetido: true`. */
  claveIdempotencia?: string | null;
  /** Interno: con qué modo queda auditada la aplicación (GENERAR_PAGO desde la factura). */
  modo?: "PAGO_SIMPLE" | "GENERAR_PAGO";
  usuarioId: string;
};

/** Pago recién creado (o el ya existente si la clave de idempotencia se repitió). */
export type PagoCreado = PagoTramite & { repetido: boolean };

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

/** Una factura cubierta por un pago, con el monto aplicado (CxP v2). */
export type AplicacionDePago = {
  facturaId: string;
  numFactura: string;
  /** "FE 12481" según la ficha del proveedor. */
  numFacturaVisible: string;
  monto: bigint;
};

/** Cabecera del pago en bloque, vista desde uno de sus pagos. */
export type GrupoDePago = {
  estado: "ACTIVO" | "ANULADO";
  costoBancario: bigint;
  costoAsumidoPor: CostoAsumidoPor;
  esHistorico: boolean;
  otrosDOs: GrupoPagoDOInfo[];
};

/** Campos CxP v2 que llevan las filas de pago del libro y de /pagos. */
type CamposCxpPago = {
  tieneFacturas: boolean;
  esBloque: boolean;
  /** false = valor y canal de solo lectura (pago con facturas o de un bloque): anula y registra de nuevo. */
  editableDinero: boolean;
  aplicaciones: AplicacionDePago[];
  grupo: GrupoDePago | null;
};

/**
 * Parte del pago que se le cobra al cliente (`lib/calculations/pagos-cobrables`,
 * la misma que usa el borrador). Lo pagado por facturas NO SE COBRA (asesoría)
 * lo asume Galcomex: no baja el saldo del cliente ni suma costos bancarios.
 */
type ParteCobrableLibro = {
  /** Valor que se le cobra al cliente (= valor en pagos sueltos o 100 % repercutibles). */
  valorCobrable: bigint;
  /** Valor que asume Galcomex (asesoría NO SE COBRA). */
  noCobrable: bigint;
  /** Costo bancario que se le cobra al cliente (0 si el pago es todo asesoría). */
  costoBancarioCobrable: bigint;
};

type PagoConRelaciones = PagoTramite & {
  facturasProveedor: { facturaId: string; monto: bigint; factura: FacturaProveedorVinculada }[];
  beneficiarios: (PagoTramiteBeneficiario & { beneficiario: BeneficiarioMinimo })[];
  bancoBeneficiario: BeneficiarioMinimo | null;
  /** Otros DOs del mismo grupoPagoId (vacío si el pago no pertenece a un grupo multi-DO). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
  /**
   * true cuando el pago NO tiene comprobante bancario (`documentoId` null).
   * Derivado por el backend para que la UI no tenga que deducirlo — dispara el
   * distintivo ámbar "Falta comprobante" (decisión: alertar, no bloquear).
   */
  faltaComprobante: boolean;
} & CamposCxpPago;

type PagoDelLibroConCobro = PagoConRelaciones & ParteCobrableLibro;

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
  pagos: PagoDelLibroConCobro[];
  aplicaciones: AplicacionDetalle[];
  /** Σ valor de todos los pagos (lo que salió del banco). */
  totalPagos: bigint;
  /** Σ costo bancario de todos los pagos. */
  costosBancarios: bigint;
  /** Σ lo que se le cobra al cliente (sin la asesoría NO SE COBRA). */
  totalPagosCobrables: bigint;
  /** Σ lo que asume Galcomex (asesoría NO SE COBRA). */
  totalNoCobrable: bigint;
  /** Σ costo bancario que se le cobra al cliente. */
  costosBancariosCobrables: bigint;
  costosBancariosAnticipo: bigint;
  totalAnticipoAplicado: bigint;
  /** Saldo del cliente tras cada pago: anticipo − Σ parte cobrable (como el borrador). */
  saldos: bigint[];
  saldoFinal: bigint;
  cruceFactura: CruceFactura | null;
};

type ListarPagosFiltros = {
  clienteId?: string;
  tramiteId?: string;
  canalPago?: CanalPago;
  /** Alias heredado de `soloSinFecha` (solo_pendientes): pagos sin fecha real de pago. */
  soloPendientes?: boolean;
  /** Pagos a los que les falta la fecha real de pago. */
  soloSinFecha?: boolean;
  /** Filtro por proveedor (empresa): pagos a sus fichas ∪ pagos que cubren facturas de sus fichas. */
  proveedorEmpresaId?: string;
  /** Filtro por proveedor (ficha de pago y las que comparten su NIT base), misma unión. */
  beneficiarioId?: string;
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
  /** true cuando el pago NO tiene comprobante bancario (`documentoId` null). */
  faltaComprobante: boolean;
} & CamposCxpPago;

type ListarPagosResult = {
  pagos: PagoGlobalRow[];
  totalPagos: bigint;
  /** Σ costo bancario de los pagos + costo de los bloques que asume Galcomex (una vez por bloque). */
  costosBancarios: bigint;
  /** De `costosBancarios`, lo que asume Galcomex (bloques GALCOMEX activos). */
  costosAsumidosGalcomex: bigint;
  /** Σ valor de los pagos sin fecha real de pago ("Pagos sin fecha de pago"). */
  totalSinFecha: bigint;
  /** @deprecated Alias de `totalSinFecha` (una versión). No es lo que se le debe a proveedores. */
  totalPendiente: bigint;
  /** Solo con filtro de proveedor: misma cifra que la ficha (Total de sus facturas / Pagado / Pendiente). */
  resumenProveedor?: ResumenCxp;
  proveedor?: { nombre: string; facturasConSaldo: number; dosConSaldo: number };
};

/**
 * Deriva si a un pago le falta el comprobante bancario (el que vale ante
 * reclamos). No bloquea el pago suelto (caso Karina) — solo dispara el
 * distintivo ámbar en la UI. Centralizado aquí para que getLibroPagos,
 * listarPagosGlobal y getPagoConBeneficiario calculen el mismo criterio.
 */
function calcularFaltaComprobante(documentoId: string | null): boolean {
  return documentoId === null;
}

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

async function resolverCostoBancario(canal: CanalPago, tx?: Tx): Promise<bigint> {
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
async function resolverBancoBancolombiaId(tx?: Tx): Promise<string | null> {
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

/** Aplicaciones y cabecera de bloque de un lote de pagos (filas del libro y de /pagos). */
async function cargarCamposCxp(
  pagos: { id: string; grupoPagoId: string | null; tramiteId: string }[],
): Promise<Map<string, CamposCxpPago>> {
  const resultado = new Map<string, CamposCxpPago>();
  if (pagos.length === 0) return resultado;
  const pagoIds = pagos.map((p) => p.id);
  const grupoIds = [...new Set(pagos.flatMap((p) => (p.grupoPagoId ? [p.grupoPagoId] : [])))];
  const [puentes, grupos, otros] = await Promise.all([
    prisma.pagoTramiteFactura.findMany({
      where: { pagoId: { in: pagoIds } },
      select: {
        pagoId: true,
        facturaId: true,
        monto: true,
        factura: { select: { numFactura: true, beneficiario: { select: { numFacturaConEspacio: true } } } },
      },
    }),
    grupoIds.length
      ? prisma.pagoGrupo.findMany({
          where: { id: { in: grupoIds } },
          select: { id: true, estado: true, costoBancario: true, costoAsumidoPor: true, esHistorico: true },
        })
      : Promise.resolve([]),
    cargarGrupoInfo(pagos),
  ]);
  for (const p of pagos) {
    const aplicaciones = puentes
      .filter((x) => x.pagoId === p.id)
      .map((x) => ({
        facturaId: x.facturaId,
        numFactura: x.factura.numFactura,
        numFacturaVisible: numeroFacturaVisible(x.factura.numFactura, x.factura.beneficiario?.numFacturaConEspacio ?? false),
        monto: x.monto,
      }));
    const g = p.grupoPagoId ? grupos.find((x) => x.id === p.grupoPagoId) : undefined;
    const tieneFacturas = aplicaciones.length > 0;
    const esBloque = p.grupoPagoId !== null;
    resultado.set(p.id, {
      tieneFacturas,
      esBloque,
      editableDinero: !tieneFacturas && !esBloque,
      aplicaciones,
      grupo: g
        ? {
            estado: g.estado,
            costoBancario: g.costoBancario,
            costoAsumidoPor: g.costoAsumidoPor,
            esHistorico: g.esHistorico,
            otrosDOs: otros.get(p.id) ?? [],
          }
        : null,
    });
  }
  return resultado;
}

// ─── Errores ──────────────────────────────────────────────────────────────────

export class MatrizCanalNoEncontradoError extends Error {
  public readonly canal: CanalPago;
  public readonly status = 400;

  constructor(canal: CanalPago) {
    super(`Canal de pago '${canal}' no encontrado en la matriz de recaudo`);
    this.name = "MatrizCanalNoEncontradoError";
    this.canal = canal;
  }
}

/** @deprecated CxP v2: `crearPago` responde `FacturaDeOtroDoError` (FACTURA_DE_OTRO_DO). Se conserva la clase por compatibilidad. */
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

/** "Sin anticipo no hay pago" en el pago suelto del DO (SIN_ANTICIPO, 422). */
export class SinAnticipoAplicadoError extends SinAnticipoError {
  public readonly tramiteId: string;
  constructor(tramiteId: string, consecutivo: string, clienteNombre: string) {
    super(consecutivo, clienteNombre);
    this.name = "SinAnticipoAplicadoError";
    this.tramiteId = tramiteId;
  }
}

/** Variante del pago en bloque: identifica QUÉ DO falla (SIN_ANTICIPO, 422). */
export class SinAnticipoAplicadoMultiDOError extends SinAnticipoError {
  public readonly tramiteId: string;
  public readonly consecutivo: string;
  constructor(tramiteId: string, consecutivo: string, clienteNombre: string) {
    super(consecutivo, clienteNombre);
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
    super("Debes seleccionar al menos una factura de proveedor para el pago en bloque");
    this.name = "PagoMultiDOSinFacturasError";
  }
}

/** @deprecated CxP v2: el bloque responde `FacturaDeOtroProveedorError` (misma clave NIT). Se conserva por compatibilidad. */
export class PagoMultiDOBeneficiarioMismatchError extends Error {
  public readonly status = 422;
  constructor(facturaProveedorId: string) {
    super(
      `La factura de proveedor ${facturaProveedorId} no pertenece al beneficiario seleccionado`,
    );
    this.name = "PagoMultiDOBeneficiarioMismatchError";
  }
}

export class PagoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(pagoId: string) {
    super(`Pago ${pagoId} no encontrado`);
    this.name = "PagoNoEncontradoError";
  }
}

export class PagoGrupoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(grupoId: string) {
    super(`Pago en bloque ${grupoId} no encontrado`);
    this.name = "PagoGrupoNoEncontradoError";
  }
}

export class PagoGrupoAnuladoError extends Error {
  public readonly status = 409;
  constructor() {
    super("Este pago en bloque ya está anulado.");
    this.name = "PagoGrupoAnuladoError";
  }
}

export class BeneficiarioDePagoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(beneficiarioId: string) {
    super(`Ficha de pago ${beneficiarioId} no encontrada`);
    this.name = "BeneficiarioDePagoNoEncontradoError";
  }
}

/** `aplicaciones` y `facturaProveedorIds` a la vez: no se adivina cuál vale. */
export class PagoEntradaAmbiguaError extends Error {
  public readonly status = 422;
  constructor() {
    super("Envía las facturas del pago de una sola forma: `aplicaciones` (con el monto de cada una) o `facturaProveedorIds`, no las dos.");
    this.name = "PagoEntradaAmbiguaError";
  }
}

/** Enlazar un pago existente: lo que se quiere aplicar supera lo que el pago tiene sin aplicar. */
export class EnlaceExcedePagoError extends Error {
  public readonly status = 422;
  constructor(disponible: bigint, pedido: bigint) {
    super(
      `Este pago solo tiene ${formatoPesos(disponible)} sin aplicar a facturas; no se le pueden enlazar ${formatoPesos(pedido)}.`,
    );
    this.name = "EnlaceExcedePagoError";
  }
}

export class MotivoAnulacionInvalidoError extends Error {
  public readonly status = 422;
  constructor() {
    super("Escribe el motivo de la anulación (al menos 10 caracteres).");
    this.name = "MotivoAnulacionInvalidoError";
  }
}

// ─── Ayudas ───────────────────────────────────────────────────────────────────

/**
 * Valida (dentro de una transacción) que un Documento exista y pertenezca al
 * trámite indicado. Usado por crearPago/actualizarPago para documentoId
 * (comprobante bancario) y comprobanteComercioId (comprobante de comercio).
 * En el pago en bloque el comprobante es compartido entre varios trámites por
 * diseño (un solo comprobante cubre varios DOs): ahí solo se valida que exista.
 */
async function validarDocumentoDelTramite(
  tx: Tx,
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

async function validarDocumentoExiste(tx: Tx, documentoId: string): Promise<void> {
  const doc = await tx.documento.findUnique({ where: { id: documentoId }, select: { id: true } });
  if (!doc) throw new DocumentoNoEncontradoParaPagoError(documentoId);
}

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
 * D-1 extendida: el DO puede absorber el costo bancario del bloque si cumple
 * la regla del DO (`puedeAbsorberCosto`: cliente sin conceptos IVA, borrador
 * abierto) Y su tramo del bloque tiene algo que se le cobra al cliente. Un DO
 * de solo asesoría (NO SE COBRA) no lo puede absorber: su pago no tiene parte
 * cobrable y el borrador deja su transferencia en 0 (`pagos-cobrables`).
 */
export function puedeAbsorberCostoDelBloque(
  puedeAbsorberDo: boolean,
  facturas: { repercutible: boolean }[],
): boolean {
  return puedeAbsorberDo && !soloCostosPropios(facturas);
}

function sha256(valor: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(valor, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))
    .digest("hex");
}

function fechaHash(fecha: Date | null | undefined): string | null {
  return fecha ? fechaCalendarioAInput(fecha) : null;
}

/** ¿El error es la unicidad de `claveIdempotencia` (doble clic que llegó a la vez)? */
function esChoqueDeClave(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    JSON.stringify(e.meta ?? {}).includes("claveIdempotencia")
  );
}

async function siguienteOrden(tx: Tx, tramiteId: string): Promise<number> {
  const ultimoPago = await tx.pagoTramite.findFirst({
    where: { tramiteId },
    orderBy: { orden: "desc" },
    select: { orden: true },
  });
  return (ultimoPago?.orden ?? 0) + 1;
}

const fichaPagoSelect = { id: true, nombre: true, nombreCorto: true, nitBase: true } satisfies Prisma.BeneficiarioSelect;

function aProveedorDePago(f: { id: string; nombre: string; nombreCorto: string | null; nitBase: string | null }): ProveedorDePago {
  return { id: f.id, nombre: f.nombreCorto ?? f.nombre, clave: claveProveedorDeFicha(f) };
}

/**
 * "Sin anticipo no hay pago" en el DO (R9): si el cliente exige anticipo
 * (`anticipos_cliente && pago_exige_anticipo`) y el DO no tiene ninguno
 * aplicado, se rechaza, salvo que el pago solo cubra costos propios.
 */
async function assertAnticipoDelDo(
  tx: Tx,
  tramiteId: string,
  facturas: { repercutible: boolean }[],
): Promise<void> {
  if (soloCostosPropios(facturas)) return;
  const c = (await cargarContextoDos(tx, [tramiteId])).get(tramiteId);
  if (c && c.exigeAnticipo && !c.tieneAnticipoAplicado) {
    throw new SinAnticipoAplicadoError(tramiteId, c.consecutivo, c.clienteNombre);
  }
}

// ─── Pago simple (pago suelto del DO, libro de pagos, generar pago, MCP) ─────

function hashPagoSimple(input: CrearPagoInput): string {
  return sha256({
    tramiteId: input.tramiteId,
    valor: input.valor,
    canalPago: input.canalPago,
    fecha: fechaHash(input.fechaRealPago),
    beneficiarioIds: [...(input.beneficiarioIds ?? [])].sort(),
    aplicaciones: [...(input.aplicaciones ?? [])]
      .map((a) => `${a.facturaProveedorId}:${a.monto}`)
      .sort(),
    facturaProveedorIds: [...(input.facturaProveedorIds ?? [])].sort(),
  });
}

async function pagoPorClave(clave: string, hash: string): Promise<PagoCreado | null> {
  const previo = await prisma.pagoTramite.findUnique({ where: { claveIdempotencia: clave } });
  if (!previo) return null;
  if (previo.hashSolicitud !== hash) throw new IdempotenciaConflictoError("OTRO_CONTENIDO");
  return { ...previo, repetido: true };
}

/**
 * Crea un pago en el libro del trámite (CxP v2, diseño §B.3).
 * - Resuelve costoBancario desde MatrizPago según canalPago (costo del canal en
 *   ESTE pago, como hoy: R4).
 * - Con facturas: valida saldo, DO, proveedor y anticipo, y aplica los montos
 *   por `aplicarSaldo` (la factura queda Abonada o Pagada). Una factura sin
 *   saldo se rechaza (FACTURA_SIN_SALDO); nunca se paga más que el saldo.
 * - Genera AuditLog.
 */
export async function crearPago(input: CrearPagoInput): Promise<PagoCreado> {
  const aplicacionesEntrada = input.aplicaciones ?? [];
  const idsHeredados = input.facturaProveedorIds ?? [];
  if (aplicacionesEntrada.length > 0 && idsHeredados.length > 0) {
    throw new PagoEntradaAmbiguaError();
  }

  const clave = input.claveIdempotencia ?? null;
  const hash = clave ? hashPagoSimple(input) : null;
  if (clave && hash) {
    const previo = await pagoPorClave(clave, hash);
    if (previo) return previo;
  }

  try {
    return await prisma.$transaction((tx) => crearPagoEnTx(tx, input, clave, hash), {
      maxWait: 10_000,
      timeout: 20_000,
    });
  } catch (e) {
    if (clave && hash && esChoqueDeClave(e)) {
      const previo = await pagoPorClave(clave, hash);
      if (previo) return previo;
    }
    throw e;
  }
}

async function crearPagoEnTx(
  tx: Tx,
  input: CrearPagoInput,
  claveIdempotencia: string | null,
  hashSolicitud: string | null,
): Promise<PagoCreado> {
  const {
    tramiteId,
    concepto,
    numSoporte,
    documentoId,
    comprobanteComercioId,
    valor,
    canalPago,
    fechaRealPago,
    bancoBeneficiarioId,
    usuarioId,
  } = input;
  const aplicacionesEntrada = input.aplicaciones ?? [];
  const idsHeredados = input.facturaProveedorIds ?? [];
  const modo = input.modo ?? "PAGO_SIMPLE";

  // (2) DO bloqueado antes de validar que no esté CERRADO (R10) y antes que las facturas (§B.5).
  await bloquearTramites(tx, [tramiteId]);

  // (1b) Idempotencia bajo el bloqueo del DO (CA-43): un doble clic simultáneo
  // espera aquí al primero y, al entrar, ya ve su pago confirmado. Se revisa
  // ANTES del saldo de las facturas; si no, el segundo envío vería saldo 0 y
  // respondería 409 "ya está pagada" en vez del pago original.
  if (claveIdempotencia) {
    const previo = await tx.pagoTramite.findUnique({ where: { claveIdempotencia } });
    if (previo) {
      if (previo.hashSolicitud !== hashSolicitud) throw new IdempotenciaConflictoError("OTRO_CONTENIDO");
      return { ...previo, repetido: true };
    }
  }

  await assertTramiteModificable(tx, tramiteId);

  // Comprobantes opcionales: si se envían, deben existir y ser del mismo
  // trámite. NO bloquean el pago suelto si se omiten (alertar, no bloquear).
  if (documentoId) {
    await validarDocumentoDelTramite(tx, documentoId, tramiteId, "comprobante bancario");
  }
  if (comprobanteComercioId) {
    await validarDocumentoDelTramite(tx, comprobanteComercioId, tramiteId, "comprobante de comercio");
  }

  // (3) Facturas bloqueadas con saldos frescos.
  const pedidas = aplicacionesEntrada.length > 0 ? aplicacionesEntrada.map((a) => a.facturaProveedorId) : idsHeredados;
  const facturas = await bloquearFacturas(tx, pedidas);

  const beneficiarioIds = [...new Set(input.beneficiarioIds ?? [])];
  const fichasPago = beneficiarioIds.length
    ? await tx.beneficiario.findMany({ where: { id: { in: beneficiarioIds } }, select: fichaPagoSelect })
    : [];
  const proveedoresPago = fichasPago.map(aProveedorDePago);

  let aplicaciones: SolicitudAplicacion[] = [];
  if (aplicacionesEntrada.length > 0) {
    const suma = aplicacionesEntrada.reduce((s, a) => s + a.monto, 0n);
    if (suma !== valor) throw new PagoNoCuadraError(valor, suma);
    aplicaciones = aplicacionesEntrada.map((a) => ({ facturaProveedorId: a.facturaProveedorId, monto: a.monto }));
    const v = validarAplicaciones({ solicitudes: aplicaciones, facturas, tramiteIdPago: tramiteId, proveedoresPago });
    if (!v.ok) throw errorDeAplicacion(v.errores);
  } else if (idsHeredados.length > 0) {
    // Primero lo estructural (existe, mismo DO, mismo proveedor, tiene saldo)…
    const estructura = validarAplicaciones({
      solicitudes: idsHeredados.map((id) => {
        const f = facturas.get(id);
        const saldo = f ? saldoDe(f) : 0n;
        return { facturaProveedorId: id, monto: saldo > 0n ? saldo : 1n };
      }),
      facturas,
      tramiteIdPago: tramiteId,
      proveedoresPago,
    });
    if (!estructura.ok) throw errorDeAplicacion(estructura.errores);
    const ordenadas = idsHeredados.map((id) => facturas.get(id)!);
    if (valor <= 0n) throw new MontoInvalidoError(ordenadas[0].numFactura);
    // …luego el reparto FIFO del valor, cada factura hasta su saldo.
    const reparto = repartirFIFO(
      valor,
      ordenadas.map((f) => ({ id: f.id, saldo: saldoDe(f), fecha: f.fecha, createdAt: f.createdAt })),
    );
    if (reparto.sobrante > 0n) {
      throw new PagoExcedeSaldoError(valor, ordenadas.reduce((s, f) => s + saldoDe(f), 0n));
    }
    if (reparto.sinMonto.length > 0) {
      throw new FacturaSinMontoError(
        valor,
        reparto.aplicaciones.map((a) => facturas.get(a.facturaProveedorId)!.numFactura),
        reparto.sinMonto.map((id) => facturas.get(id)!.numFactura),
      );
    }
    aplicaciones = reparto.aplicaciones;
  }

  const facturasDelPago = aplicaciones.map((a) => facturas.get(a.facturaProveedorId)!);
  await assertAnticipoDelDo(tx, tramiteId, facturasDelPago);

  const costoBancario = await resolverCostoBancario(canalPago, tx);

  // Banco asociado al pago (tercero del 4x1000).
  // - TRANSF_BANCOLOMBIA: si el operario no envió banco explícito, se
  //   auto-resuelve desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID.
  // - Otros canales: lo elige el operario en el modal; puede quedar null.
  let bancoFinal: string | null = bancoBeneficiarioId ?? null;
  if (bancoFinal === null && canalPago === "TRANSF_BANCOLOMBIA") {
    bancoFinal = await resolverBancoBancolombiaId(tx);
  }

  const orden = await siguienteOrden(tx, tramiteId);

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
      viaSocio: input.viaSocio ?? false,
      bancoBeneficiarioId: bancoFinal,
      claveIdempotencia,
      hashSolicitud,
    },
  });

  // Beneficiarios (N↔N). Si el pago cubre facturas y no trae beneficiarios, se
  // completa con el proveedor de la factura (filtro por proveedor de /pagos).
  const beneficiariosFinales =
    beneficiarioIds.length > 0
      ? beneficiarioIds
      : [...new Set(facturasDelPago.flatMap((f) => (f.beneficiarioId ? [f.beneficiarioId] : [])))];
  for (const bid of beneficiariosFinales) {
    await tx.pagoTramiteBeneficiario.create({
      data: { pagoId: pago.id, beneficiarioId: bid },
    });
  }

  if (aplicaciones.length > 0) {
    await aplicarSaldo(tx, {
      origen: { tipo: "PAGO", pagoId: pago.id, tramiteId, esHistorico: false },
      aplicaciones,
      facturas,
      proveedoresPago: proveedoresPago.length > 0 ? proveedoresPago : undefined,
      modo,
      usuarioId,
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
        beneficiarioIds: beneficiariosFinales,
        facturaProveedorIds: aplicaciones.map((a) => a.facturaProveedorId),
        aplicaciones,
        modo,
      }),
    },
  });

  return { ...pago, repetido: false };
}

// ─── Editar, borrar, verificar ────────────────────────────────────────────────

type CambiosPago = {
  canalPago?: CanalPago;
  valor?: bigint;
  concepto?: string;
  /** Si se provee, reemplaza todos los beneficiarios vinculados. */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  fechaRealPago?: Date | null;
  /** Banco (Beneficiario) para el 4x1000. null = limpiar. */
  bancoBeneficiarioId?: string | null;
  /** Comprobante bancario. null = limpiar. */
  documentoId?: string | null;
  /** Comprobante de la página del comercio (puerto/PSE), opcional. null = limpiar. */
  comprobanteComercioId?: string | null;
};

type CambiosGrupo = {
  concepto?: string;
  fechaRealPago?: Date | null;
  documentoId?: string | null;
  comprobanteComercioId?: string | null;
  valorTransferido?: bigint | null;
};

/** Propaga a la cabecera y a TODOS los pagos del bloque lo que es de la transferencia (§B.4). */
async function propagarCambiosGrupo(
  tx: Tx,
  grupo: { id: string; esHistorico: boolean },
  cambios: CambiosGrupo,
): Promise<void> {
  if (cambios.documentoId === null && !grupo.esHistorico) throw new ComprobanteObligatorioError();
  if (cambios.documentoId) await validarDocumentoExiste(tx, cambios.documentoId);
  if (cambios.comprobanteComercioId) await validarDocumentoExiste(tx, cambios.comprobanteComercioId);

  const comunes: Prisma.PagoTramiteUncheckedUpdateManyInput = {};
  if (cambios.concepto !== undefined) comunes.concepto = cambios.concepto;
  if (cambios.fechaRealPago !== undefined) comunes.fechaRealPago = cambios.fechaRealPago;
  if (cambios.documentoId !== undefined) comunes.documentoId = cambios.documentoId;
  if (cambios.comprobanteComercioId !== undefined) comunes.comprobanteComercioId = cambios.comprobanteComercioId;

  await tx.pagoGrupo.update({
    where: { id: grupo.id },
    data: {
      ...(cambios.concepto !== undefined ? { concepto: cambios.concepto } : {}),
      ...(cambios.fechaRealPago !== undefined ? { fechaRealPago: cambios.fechaRealPago } : {}),
      ...(cambios.documentoId !== undefined ? { documentoId: cambios.documentoId } : {}),
      ...(cambios.comprobanteComercioId !== undefined ? { comprobanteComercioId: cambios.comprobanteComercioId } : {}),
      ...(cambios.valorTransferido !== undefined ? { valorTransferido: cambios.valorTransferido } : {}),
    },
  });
  if (Object.keys(comunes).length > 0) {
    await tx.pagoTramite.updateMany({ where: { grupoPagoId: grupo.id }, data: comunes });
  }
}

/**
 * Actualiza un pago (canal, valor, concepto, fechas, comprobantes, beneficiarios).
 * CxP v2 (§B.4): si el pago cubre facturas o es de un bloque, NO se cambia el
 * valor ni el canal (PAGO_NO_EDITABLE: anula y registra de nuevo); se compara
 * contra la fila actual porque la pantalla manda todos los campos en cada
 * guardado. En un pago de bloque, concepto/fecha/comprobantes se propagan a
 * todo el bloque. Pagos sin facturas ni bloque: igual que siempre (recalcula el
 * costo del canal).
 */
export async function actualizarPago(
  pagoId: string,
  cambios: CambiosPago,
  usuarioId: string,
): Promise<PagoTramite> {
  return prisma.$transaction(async (tx) => {
    const previo = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      select: { tramiteId: true, grupoPagoId: true },
    });
    if (!previo) {
      throw new PagoNoEncontradoError(pagoId);
    }

    // Mismo orden que anularPagoGrupo / actualizarPagoGrupo (§B.5): cabecera del
    // bloque → DOs → facturas. Al revés, editar la fecha de un pago del bloque
    // mientras otro lo anula terminaba en deadlock (500).
    if (previo.grupoPagoId) {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "pago_grupo" WHERE id = ${previo.grupoPagoId} FOR UPDATE`,
      );
    }

    // DOs a bloquear: el del pago o, si es de un bloque, todos los del bloque (un solo lote ordenado).
    const tramitesABloquear = previo.grupoPagoId
      ? (
          await tx.pagoTramite.findMany({ where: { grupoPagoId: previo.grupoPagoId }, select: { tramiteId: true } })
        ).map((p) => p.tramiteId)
      : [previo.tramiteId];
    await bloquearTramites(tx, [...tramitesABloquear, previo.tramiteId]);

    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      include: {
        facturasProveedor: {
          select: { facturaId: true, factura: { select: { numFactura: true, beneficiarioId: true } } },
        },
        grupo: { select: { id: true, esHistorico: true, estado: true } },
      },
    });
    if (!actual) {
      throw new PagoNoEncontradoError(pagoId);
    }

    await assertTramiteModificable(tx, actual.tramiteId);

    const tieneFacturas = actual.facturasProveedor.length > 0;
    const esBloque = actual.grupoPagoId !== null;
    const cambiaValor = cambios.valor !== undefined && cambios.valor !== actual.valor;
    const cambiaCanal = cambios.canalPago !== undefined && cambios.canalPago !== actual.canalPago;
    if ((tieneFacturas || esBloque) && (cambiaValor || cambiaCanal)) {
      throw new PagoNoEditableError();
    }

    if (esBloque) {
      // Los otros DOs del bloque también deben admitir cambios.
      const otros = await tx.tramiteDO.findMany({
        where: { id: { in: tramitesABloquear } },
        select: { id: true, consecutivo: true, estado: true },
      });
      for (const t of otros) await assertTramiteModificable(tx, t);
    } else {
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
    }

    const { beneficiarioIds, ...camposPago } = cambios;

    // Beneficiarios: con facturas, se debe conservar el proveedor de sus facturas (R6).
    let beneficiariosFinales = beneficiarioIds;
    if (beneficiarioIds !== undefined && tieneFacturas) {
      const idsFacturas = actual.facturasProveedor.map((x) => x.facturaId);
      const facturas = await bloquearFacturas(tx, idsFacturas);
      const unicos = [...new Set(beneficiarioIds)];
      if (unicos.length === 0) {
        beneficiariosFinales = [
          ...new Set([...facturas.values()].flatMap((f) => (f.beneficiarioId ? [f.beneficiarioId] : []))),
        ];
      } else {
        const fichas = await tx.beneficiario.findMany({ where: { id: { in: unicos } }, select: fichaPagoSelect });
        const proveedores = fichas.map(aProveedorDePago);
        for (const f of facturas.values()) {
          const claveFactura = f.proveedorClave ?? (f.beneficiarioId ? `BEN:${f.beneficiarioId}` : null);
          if (claveFactura === null) continue;
          if (!proveedores.some((p) => p.clave === claveFactura || p.id === f.beneficiarioId)) {
            throw new FacturaDeOtroProveedorError(
              f.numFactura,
              f.nombreProveedor,
              proveedores.map((p) => p.nombre).join(" / ") || "sin proveedor",
            );
          }
        }
      }
    }

    let costoBancario = actual.costoBancario;
    if (!tieneFacturas && !esBloque) {
      const canalEfectivo = cambios.canalPago ?? actual.canalPago;
      costoBancario =
        cambios.canalPago !== undefined ? await resolverCostoBancario(canalEfectivo, tx) : actual.costoBancario;
      // Si el canal cambia a TRANSF_BANCOLOMBIA y no se envió banco explícito,
      // auto-resolver al Beneficiario configurado en SIIGO_BENEFICIARIO_BANCOLOMBIA_ID.
      if (cambios.canalPago === "TRANSF_BANCOLOMBIA" && camposPago.bancoBeneficiarioId === undefined) {
        const auto = await resolverBancoBancolombiaId(tx);
        if (auto) camposPago.bancoBeneficiarioId = auto;
      }
    }

    if (esBloque && actual.grupo) {
      if (actual.grupo.estado === "ANULADO") throw new PagoGrupoAnuladoError();
      // Lo de la transferencia se propaga a todo el bloque; numSoporte y banco son por pago.
      await propagarCambiosGrupo(tx, actual.grupo, {
        concepto: camposPago.concepto,
        fechaRealPago: camposPago.fechaRealPago,
        documentoId: camposPago.documentoId,
        comprobanteComercioId: camposPago.comprobanteComercioId,
      });
    }

    // Con facturas o de bloque, valor y canal no cambian (ya se validó que vienen iguales).
    const datos: Prisma.PagoTramiteUncheckedUpdateInput = { ...camposPago, costoBancario };
    if (tieneFacturas || esBloque) {
      delete datos.valor;
      delete datos.canalPago;
    }
    const updated = await tx.pagoTramite.update({ where: { id: pagoId }, data: datos });

    // Sincronizar pivot de beneficiarios si se enviaron
    if (beneficiariosFinales !== undefined) {
      await tx.pagoTramiteBeneficiario.deleteMany({ where: { pagoId } });
      for (const bid of new Set(beneficiariosFinales)) {
        await tx.pagoTramiteBeneficiario.create({
          data: { pagoId, beneficiarioId: bid },
        });
      }
    }

    const antes: Record<string, unknown> = { ...actual };
    delete antes.facturasProveedor;
    delete antes.grupo;
    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pagoId,
        accion: "UPDATE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(antes),
        despues: normalizeSerializable({ ...updated, beneficiarioIds: beneficiariosFinales }),
      },
    });

    return updated;
  });
}

/**
 * Elimina un pago suelto del libro del trámite (§B.4). Un pago que es parte de
 * un bloque NO se borra solo (PAGO_DE_BLOQUE): se anula el bloque completo.
 * Devuelve el saldo a sus facturas con `revertirSaldo` (quedan Abonada o
 * Pendiente según lo que les quede pagado).
 */
export async function eliminarPago(
  pagoId: string,
  usuarioId: string,
): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const previo = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      select: { tramiteId: true, grupoPagoId: true },
    });

    if (!previo) {
      throw new PagoNoEncontradoError(pagoId);
    }

    if (previo.grupoPagoId) {
      const dos = await tx.pagoTramite.findMany({
        where: { grupoPagoId: previo.grupoPagoId },
        select: { tramiteId: true },
        distinct: ["tramiteId"],
      });
      throw new PagoDeBloqueError(Math.max(dos.length, 1));
    }

    await bloquearTramites(tx, [previo.tramiteId]);
    await assertTramiteModificable(tx, previo.tramiteId);

    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
      include: { facturasProveedor: { select: { facturaId: true, monto: true } } },
    });
    if (!actual) throw new PagoNoEncontradoError(pagoId);

    await revertirSaldo(tx, { tipo: "PAGOS", pagoIds: [pagoId] }, usuarioId, "Pago eliminado del libro de pagos");

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
      throw new PagoNoEncontradoError(pagoId);
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
  const pago = await prisma.pagoTramite.findUnique({
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

  if (!pago) return null;

  const cxp = (await cargarCamposCxp([pago])).get(pago.id)!;
  return { ...pago, ...cxp, faltaComprobante: calcularFaltaComprobante(pago.documentoId) };
}

// ─── Enlazar un pago que ya existe (conciliación P7, §B.3) ───────────────────

/**
 * Enlaza facturas a un pago que YA salió (categoría PAGO_PREVIO_SIN_ENLAZAR de
 * la conciliación): no crea plata nueva. Σ montos ≤ valor − lo ya aplicado del
 * pago. Pasa por `aplicarSaldo` (modo CONCILIACION, sin regla de anticipo: el
 * pago ya existe). Si se pasa `tx`, corre dentro de ella.
 */
export async function enlazarPagoExistente(
  input: { pagoId: string; aplicaciones: AplicacionPagoInput[]; usuarioId: string },
  txExterna?: Tx,
): Promise<{ pagoId: string; aplicado: bigint }> {
  const run = async (tx: Tx) => {
    const previo = await tx.pagoTramite.findUnique({ where: { id: input.pagoId }, select: { tramiteId: true } });
    if (!previo) throw new PagoNoEncontradoError(input.pagoId);
    await bloquearTramites(tx, [previo.tramiteId]);
    await assertTramiteModificable(tx, previo.tramiteId);

    const pago = await tx.pagoTramite.findUnique({
      where: { id: input.pagoId },
      select: {
        id: true,
        tramiteId: true,
        valor: true,
        facturasProveedor: { select: { facturaId: true, monto: true } },
        beneficiarios: { select: { beneficiario: { select: fichaPagoSelect } } },
      },
    });
    if (!pago) throw new PagoNoEncontradoError(input.pagoId);

    const facturas = await bloquearFacturas(
      tx,
      input.aplicaciones.map((a) => a.facturaProveedorId),
    );
    for (const a of input.aplicaciones) {
      if (pago.facturasProveedor.some((x) => x.facturaId === a.facturaProveedorId)) {
        throw new FacturaRepetidaError(facturas.get(a.facturaProveedorId)?.numFactura ?? a.facturaProveedorId);
      }
    }
    const ya = pago.facturasProveedor.reduce((s, x) => s + x.monto, 0n);
    const pedido = input.aplicaciones.reduce((s, a) => s + a.monto, 0n);
    if (ya + pedido > pago.valor) throw new EnlaceExcedePagoError(pago.valor - ya, pedido);

    const proveedoresPago = pago.beneficiarios.map((b) => aProveedorDePago(b.beneficiario));
    await aplicarSaldo(tx, {
      origen: { tipo: "PAGO", pagoId: pago.id, tramiteId: pago.tramiteId, esHistorico: true },
      aplicaciones: input.aplicaciones.map((a) => ({ facturaProveedorId: a.facturaProveedorId, monto: a.monto })),
      facturas,
      proveedoresPago: proveedoresPago.length > 0 ? proveedoresPago : undefined,
      modo: "CONCILIACION",
      usuarioId: input.usuarioId,
    });

    if (pago.beneficiarios.length === 0) {
      const ids = [...new Set([...facturas.values()].flatMap((f) => (f.beneficiarioId ? [f.beneficiarioId] : [])))];
      for (const bid of ids) {
        await tx.pagoTramiteBeneficiario.create({ data: { pagoId: pago.id, beneficiarioId: bid } });
      }
    }

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "ENLAZAR_PAGO_EXISTENTE",
        usuarioId: input.usuarioId,
        tramiteId: pago.tramiteId,
        antes: normalizeSerializable({ aplicado: ya }),
        despues: normalizeSerializable({ aplicado: ya + pedido, aplicaciones: input.aplicaciones }),
      },
    });
    return { pagoId: pago.id, aplicado: ya + pedido };
  };
  return txExterna ? run(txExterna) : prisma.$transaction(run, { maxWait: 10_000, timeout: 20_000 });
}

// ─── Libro de pagos del DO ────────────────────────────────────────────────────

/**
 * Retorna el libro de pagos del trámite con saldo corriente línea a línea.
 * CxP v2: cada pago trae sus facturas con monto, si es de un bloque (con su
 * cabecera) y si su valor/canal se pueden editar.
 *
 * Asesoría (facturas NO SE COBRA): cada pago trae además su parte cobrable
 * (`cargarPagosParaCobro`, la misma del borrador). El saldo corriente es el del
 * cliente: solo baja por lo que se le cobra, así cuadra con el borrador; lo
 * que asume Galcomex va aparte (`noCobrable`, `totalNoCobrable`).
 */
export async function getLibroPagos(tramiteId: string): Promise<LibroPagosResult> {
  const [pagos, rawAplicaciones, borradorCruce, paraCobro] = await Promise.all([
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
    cargarPagosParaCobro(prisma, tramiteId),
  ]);

  // Parte cobrable por pago (mismo orden: los dos leen por `orden` asc; se
  // cruza por id por si dos pagos comparten orden).
  const cobroPorPago = new Map(
    paraCobro.map((p) => [
      p.pago.id,
      {
        valorCobrable: p.desglose.cobrable.valor,
        noCobrable: p.desglose.noCobrable,
        costoBancarioCobrable: p.desglose.cobrable.costoBancario,
      },
    ]),
  );
  const parteDe = (p: { id: string; valor: bigint; costoBancario: bigint }): ParteCobrableLibro =>
    cobroPorPago.get(p.id) ?? { valorCobrable: p.valor, noCobrable: 0n, costoBancarioCobrable: p.costoBancario };

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
  const partes = pagos.map(parteDe);
  const totalPagosCobrables = partes.reduce((sum, p) => sum + p.valorCobrable, 0n);
  const totalNoCobrable = partes.reduce((sum, p) => sum + p.noCobrable, 0n);
  const costosBancariosCobrables = partes.reduce((sum, p) => sum + p.costoBancarioCobrable, 0n);

  const saldos = calcularSaldosIntermedios(
    totalAnticipoAplicado,
    partes.map((p) => ({ valor: p.valorCobrable })),
  );
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
  // badge "Pago multi-DO" con tooltip, y los campos CxP v2.
  const claves = pagos.map((p) => ({ id: p.id, grupoPagoId: p.grupoPagoId, tramiteId: p.tramiteId }));
  const [grupoInfo, cxp] = await Promise.all([cargarGrupoInfo(claves), cargarCamposCxp(claves)]);
  const pagosConGrupo: PagoDelLibroConCobro[] = pagos.map((p, i) => ({
    ...p,
    ...cxp.get(p.id)!,
    grupoOtrosDOs: grupoInfo.get(p.id) ?? [],
    faltaComprobante: calcularFaltaComprobante(p.documentoId),
    ...partes[i],
  }));

  return {
    pagos: pagosConGrupo,
    aplicaciones,
    totalPagos,
    costosBancarios,
    totalPagosCobrables,
    totalNoCobrable,
    costosBancariosCobrables,
    costosBancariosAnticipo,
    totalAnticipoAplicado,
    saldos,
    saldoFinal,
    cruceFactura,
  };
}

// ─── Módulo Pagos (/pagos) ────────────────────────────────────────────────────

/**
 * Lista los pagos de todos los trámites para el módulo global de pagos.
 * CxP v2 (§D.5): filtro por proveedor = pagos a sus fichas ∪ pagos que cubren
 * facturas de sus fichas; con proveedor elegido devuelve también su resumen
 * (misma cifra que la ficha). "Costos bancarios" suma el costo de los bloques
 * que asume Galcomex, UNA vez por bloque.
 */
export async function listarPagosGlobal(
  filtros: ListarPagosFiltros = {},
  opciones: { rol?: string } = {},
): Promise<ListarPagosResult> {
  const { clienteId, tramiteId, canalPago } = filtros;
  const soloSinFecha = filtros.soloSinFecha === true || filtros.soloPendientes === true;

  let fichaIds: string[] | null = null;
  if (filtros.proveedorEmpresaId) {
    const empresa = await prisma.cliente.findUnique({
      where: { id: filtros.proveedorEmpresaId },
      select: { nit: true },
    });
    fichaIds = empresa ? (await fichasDeEmpresa(prisma, filtros.proveedorEmpresaId, empresa.nit)).map((f) => f.id) : [];
  } else if (filtros.beneficiarioId) {
    fichaIds = (await fichasHermanas(prisma, filtros.beneficiarioId)).map((f) => f.id);
  }

  const where: Prisma.PagoTramiteWhereInput = {
    ...(tramiteId ? { tramiteId } : {}),
    ...(canalPago ? { canalPago } : {}),
    ...(soloSinFecha ? { fechaRealPago: null } : {}),
    ...(clienteId ? { tramite: { clienteId } } : {}),
    ...(fichaIds !== null
      ? {
          OR: [
            { beneficiarios: { some: { beneficiarioId: { in: fichaIds } } } },
            { facturasProveedor: { some: { factura: { beneficiarioId: { in: fichaIds } } } } },
          ],
        }
      : {}),
  };

  const pagos = await prisma.pagoTramite.findMany({
    where,
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
  const costosPagos = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);
  const totalSinFecha = pagos.reduce(
    (sum, p) => (p.fechaRealPago === null ? sum + p.valor : sum),
    0n,
  );

  const grupoIds = [...new Set(pagos.flatMap((p) => (p.grupoPagoId ? [p.grupoPagoId] : [])))];
  const gruposGalcomex = grupoIds.length
    ? await prisma.pagoGrupo.findMany({
        where: { id: { in: grupoIds }, estado: "ACTIVO", costoAsumidoPor: "GALCOMEX" },
        select: { costoBancario: true },
      })
    : [];
  const costosAsumidosGalcomex = gruposGalcomex.reduce((s, g) => s + g.costoBancario, 0n);

  const claves = pagos.map((p) => ({ id: p.id, grupoPagoId: p.grupoPagoId, tramiteId: p.tramiteId }));
  const [grupoInfo, cxp] = await Promise.all([cargarGrupoInfo(claves), cargarCamposCxp(claves)]);
  const pagosConGrupo: PagoGlobalRow[] = pagos.map((p) => ({
    ...p,
    ...cxp.get(p.id)!,
    grupoOtrosDOs: grupoInfo.get(p.id) ?? [],
    faltaComprobante: calcularFaltaComprobante(p.documentoId),
  }));

  const resultado: ListarPagosResult = {
    pagos: pagosConGrupo,
    totalPagos,
    costosBancarios: costosPagos + costosAsumidosGalcomex,
    costosAsumidosGalcomex,
    totalSinFecha,
    totalPendiente: totalSinFecha,
  };

  if (filtros.proveedorEmpresaId || filtros.beneficiarioId) {
    const r = await resumenPorProveedor({
      empresaId: filtros.proveedorEmpresaId,
      beneficiarioId: filtros.proveedorEmpresaId ? undefined : filtros.beneficiarioId,
    });
    if (r) {
      // D-6 / R16: OPERATIVO no ve los totales del proveedor (la ficha tampoco
      // se los muestra: SOLO_PENDIENTES). Sí ve el nombre y cuántas facturas
      // tienen saldo, que la ficha también le lista.
      if (opciones.rol !== "OPERATIVO") resultado.resumenProveedor = r.resumen;
      resultado.proveedor = { nombre: r.nombre, facturasConSaldo: r.facturasConSaldo, dosConSaldo: r.dosConSaldo };
    }
  }

  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pago en bloque (multi-DO)
//
// Una sola transferencia al proveedor cubre facturas de VARIOS DOs. Se crea,
// en UNA transacción, una cabecera `PagoGrupo` (la transferencia: comprobante,
// canal, fecha y costo bancario UNA vez) y un PagoTramite POR DO (valor = Σ
// montos de sus facturas), ordenados por consecutivo. Cada factura recibe su
// monto por `aplicarSaldo` (abono permitido, nunca más que el saldo).
// ─────────────────────────────────────────────────────────────────────────────

/** Fila del selector "Pagar en bloque" (dominio, BigInt). La ruta la serializa a `FacturaElegibleJson`. */
export type FacturaElegibleMultiDO = FilaFacturaCxp;

/**
 * Costo de la transferencia por canal (matriz de pago), para que el modal
 * "Pagar en bloque" diga cuánto cuesta antes de decidir quién lo asume (§D.2).
 * El servidor lo vuelve a resolver al registrar el bloque (`resolverCostoBancario`).
 */
export async function costosBancariosPorCanal(): Promise<Record<string, bigint>> {
  const filas = await prisma.matrizPago.findMany({ select: { canalPago: true, costoFijo: true } });
  return Object.fromEntries(filas.map((f) => [f.canalPago, f.costoFijo]));
}

/**
 * Facturas con saldo (Pendientes y Abonadas) de un proveedor, de TODOS los
 * DOs, con su pagabilidad (las no pagables vienen con el motivo). Acepta la
 * ficha (y las que comparten su NIT base) o la empresa (todas sus fichas).
 */
export async function listarFacturasElegiblesMultiDO(
  filtro: string | { beneficiarioId?: string; empresaId?: string },
): Promise<FacturaElegibleMultiDO[]> {
  const f = typeof filtro === "string" ? { beneficiarioId: filtro } : filtro;
  let fichaIds: string[] = [];
  if (f.empresaId) {
    const empresa = await prisma.cliente.findUnique({ where: { id: f.empresaId }, select: { nit: true } });
    if (!empresa) return [];
    fichaIds = (await fichasDeEmpresa(prisma, f.empresaId, empresa.nit)).map((x) => x.id);
  } else if (f.beneficiarioId) {
    fichaIds = (await fichasHermanas(prisma, f.beneficiarioId)).map((x) => x.id);
  }
  if (fichaIds.length === 0) return [];

  const filas = await cargarFilasFacturas(prisma, {
    beneficiarioId: { in: fichaIds },
    estado: { in: ["REGISTRADA", "PARCIAL"] },
  });
  return filas.filter((x) => x.saldo > 0n);
}

export type CrearPagoMultiDOInput = {
  beneficiarioId: string;
  /** Facturas seleccionadas con el monto a pagar por cada una (abono permitido; nunca más que el saldo). */
  facturas: { facturaProveedorId: string; monto: bigint }[];
  canalPago: CanalPago;
  fechaRealPago?: Date | null;
  concepto?: string;
  /** Comprobante bancario — obligatorio salvo registro histórico (D-5). Compartido por todo el bloque. */
  documentoId?: string | null;
  /** Comprobante de comercio (opcional) — compartido por todos los pagos del grupo. */
  comprobanteComercioId?: string | null;
  bancoBeneficiarioId?: string | null;
  /** Lo que salió del banco (informativo, D-2): si no cuadra, solo aviso. */
  valorTransferido?: bigint | null;
  /** Quién asume el costo de la transferencia (D-1). Por defecto: `reglaCostoPorDefecto`. */
  costoAsumidoPor?: CostoAsumidoPor;
  /** Registro de conciliación con el Excel (solo ADMIN — lo exige la ruta): costo 0, sin comprobante ni anticipo. */
  esHistorico?: boolean;
  claveIdempotencia?: string | null;
  usuarioId: string;
};

export type CrearPagoMultiDOResult = {
  grupoPagoId: string;
  pagos: PagoTramite[];
  advertencias: AdvertenciaPago[];
  /** true = la clave de idempotencia ya existía: no se creó nada nuevo (doble clic / reintento). */
  repetido: boolean;
  costoBancario: bigint;
  costoAsumidoPor: CostoAsumidoPor;
};

function hashBloque(input: CrearPagoMultiDOInput): string {
  return sha256({
    beneficiarioId: input.beneficiarioId,
    facturas: input.facturas.map((f) => `${f.facturaProveedorId}:${f.monto}`).sort(),
    canalPago: input.canalPago,
    fecha: fechaHash(input.fechaRealPago),
    esHistorico: input.esHistorico === true,
  });
}

async function bloquePorClave(clave: string, hash: string): Promise<CrearPagoMultiDOResult | null> {
  const g = await prisma.pagoGrupo.findUnique({
    where: { claveIdempotencia: clave },
    select: { id: true, estado: true, hashSolicitud: true, costoBancario: true, costoAsumidoPor: true },
  });
  if (!g) return null;
  if (g.estado === "ANULADO") throw new IdempotenciaConflictoError("ANULADO");
  if (g.hashSolicitud !== hash) throw new IdempotenciaConflictoError("OTRO_CONTENIDO");
  const pagos = await prisma.pagoTramite.findMany({
    where: { grupoPagoId: g.id },
    orderBy: { tramite: { consecutivo: "asc" } },
  });
  return {
    grupoPagoId: g.id,
    pagos,
    advertencias: [],
    repetido: true,
    costoBancario: g.costoBancario,
    costoAsumidoPor: g.costoAsumidoPor,
  };
}

/**
 * Crea un pago en bloque (§B.3). Orden de validación:
 *   DOs no CERRADOS → comprobante bancario obligatorio (salvo histórico) →
 *   cabecera `PagoGrupo` con la clave de idempotencia → `bloquearTramites` +
 *   `bloquearFacturas` → mismo proveedor y monto ≤ saldo (abono permitido) →
 *   anticipo por DO → un PagoTramite por DO ordenado por consecutivo → costo
 *   bancario UNA vez según D-1 → `aplicarSaldo` (modo BLOQUE) para todas.
 *
 * Costo bancario (D-1, R8): cada DO "puede absorberlo" si su cliente no usa el
 * formato `factura_conceptos_iva` y su borrador no está APROBADO/FACTURADO. Por
 * defecto va entero al primer DO que puede (como hoy con Lucho); si ninguno
 * puede (Litoplas, BAQ-18385), lo asume Galcomex (los PagoTramite quedan en 0 y
 * el costo vive solo en la cabecera). PRORRATEADO reparte al peso entre los que
 * pueden. `costoAsumidoPor` guardado = el valor YA resuelto.
 *
 * Un DO cuyo tramo del bloque es SOLO asesoría (facturas NO SE COBRA) tampoco
 * puede absorberlo (`puedeAbsorberCostoDelBloque`): el borrador no le cobra al
 * cliente la transferencia de un pago sin nada cobrable, así que el costo se
 * perdería. Va al primer DO con algo que se cobra.
 */
export async function crearPagoMultiDO(
  input: CrearPagoMultiDOInput,
): Promise<CrearPagoMultiDOResult> {
  if (input.facturas.length === 0) {
    throw new PagoMultiDOSinFacturasError();
  }

  const clave = input.claveIdempotencia ?? null;
  const hash = hashBloque(input);
  if (clave) {
    const previo = await bloquePorClave(clave, hash);
    if (previo) return previo;
  }

  try {
    return await prisma.$transaction((tx) => crearPagoMultiDOEnTx(tx, input, clave, hash), {
      maxWait: 10_000,
      timeout: 30_000,
    });
  } catch (e) {
    if (clave && esChoqueDeClave(e)) {
      const previo = await bloquePorClave(clave, hash);
      if (previo) return previo;
    }
    throw e;
  }
}

async function crearPagoMultiDOEnTx(
  tx: Tx,
  input: CrearPagoMultiDOInput,
  claveIdempotencia: string | null,
  hashSolicitud: string,
): Promise<CrearPagoMultiDOResult> {
  const {
    beneficiarioId,
    facturas: pedidas,
    canalPago,
    fechaRealPago,
    concepto,
    documentoId,
    comprobanteComercioId,
    bancoBeneficiarioId,
    usuarioId,
  } = input;
  const esHistorico = input.esHistorico === true;

  const ficha = await tx.beneficiario.findUnique({ where: { id: beneficiarioId }, select: fichaPagoSelect });
  if (!ficha) throw new BeneficiarioDePagoNoEncontradoError(beneficiarioId);
  const proveedorBloque = { clave: claveProveedorDeFicha(ficha), nombre: ficha.nombreCorto ?? ficha.nombre };

  // 1. DOs no CERRADOS (antes que el comprobante: contrato con P2).
  const facturaIds = pedidas.map((f) => f.facturaProveedorId);
  const previas = await tx.facturaProveedor.findMany({
    where: { id: { in: facturaIds } },
    select: { tramite: { select: { id: true, consecutivo: true, estado: true } } },
  });
  const tramitesPrevios = [...new Map(previas.map((p) => [p.tramite.id, p.tramite])).values()].sort((a, b) =>
    a.consecutivo.localeCompare(b.consecutivo),
  );
  for (const t of tramitesPrevios) await assertTramiteModificable(tx, t);

  // 2. Comprobante bancario obligatorio salvo histórico (D-5).
  if (!esHistorico && !documentoId) throw new ComprobanteObligatorioError();
  if (documentoId) await validarDocumentoExiste(tx, documentoId);
  if (comprobanteComercioId) await validarDocumentoExiste(tx, comprobanteComercioId);

  // 3. Cabecera con la clave de idempotencia ANTES de bloquear facturas: la
  //    unicidad serializa el doble clic (la segunda petición espera y choca).
  const grupoPagoId = randomUUID();
  const totalPedido = pedidas.reduce((s, f) => s + f.monto, 0n);
  const costoBancario = esHistorico ? 0n : await resolverCostoBancario(canalPago, tx);
  const conceptoBloque =
    concepto ?? `Pago en bloque ${proveedorBloque.nombre} — ${pedidas.length} factura(s)`;
  await tx.pagoGrupo.create({
    data: {
      id: grupoPagoId,
      beneficiarioId,
      concepto: conceptoBloque,
      canalPago,
      fechaRealPago: fechaRealPago ?? null,
      documentoId: documentoId ?? null,
      comprobanteComercioId: comprobanteComercioId ?? null,
      valorTransferido: input.valorTransferido ?? null,
      totalAplicado: totalPedido,
      costoBancario,
      costoAsumidoPor: "GALCOMEX", // provisional: se resuelve abajo con la regla D-1
      esHistorico,
      claveIdempotencia,
      hashSolicitud,
      creadoPorId: usuarioId,
    },
  });

  // 4. Bloqueos: DOs (orden por id) y luego facturas (orden por id).
  await bloquearTramites(
    tx,
    tramitesPrevios.map((t) => t.id),
  );
  const facturas = await bloquearFacturas(tx, facturaIds);
  // El estado del DO pudo cambiar mientras se esperaba el bloqueo.
  for (const f of facturas.values()) {
    if (f.tramite.estado === "CERRADO") {
      throw new TramiteCerradoError({ id: f.tramite.id, consecutivo: f.tramite.consecutivo });
    }
  }

  // 5. Mismo proveedor, sin repetir, monto > 0 y ≤ saldo (todas a la vez).
  const solicitudes: SolicitudAplicacion[] = pedidas.map((p) => ({ facturaProveedorId: p.facturaProveedorId, monto: p.monto }));
  const validacion = validarAplicaciones({ solicitudes, facturas, proveedorBloque });
  if (!validacion.ok) throw errorDeAplicacion(validacion.errores);

  // 6. Agrupar por DO, ordenados por consecutivo (R5).
  // `cobrable` = lo del tramo que se le cobra al cliente (facturas
  // repercutibles): pesa en el prorrateo del costo y es lo que baja su saldo.
  type GrupoDo = {
    tramiteId: string;
    consecutivo: string;
    aplicaciones: SolicitudAplicacion[];
    total: bigint;
    cobrable: bigint;
    facturas: FacturaBloqueada[];
  };
  const porDo = new Map<string, GrupoDo>();
  for (const s of solicitudes) {
    const f = facturas.get(s.facturaProveedorId)!;
    const g = porDo.get(f.tramiteId) ?? {
      tramiteId: f.tramiteId,
      consecutivo: f.tramite.consecutivo,
      aplicaciones: [],
      total: 0n,
      cobrable: 0n,
      facturas: [],
    };
    g.aplicaciones.push(s);
    g.total += s.monto;
    if (f.repercutible) g.cobrable += s.monto;
    g.facturas.push(f);
    porDo.set(f.tramiteId, g);
  }
  const dos = [...porDo.values()].sort((a, b) => a.consecutivo.localeCompare(b.consecutivo));
  const contexto = await cargarContextoDos(tx, dos.map((d) => d.tramiteId));

  // 7. Sin anticipo no hay pago, por DO (salvo costos propios e histórico).
  if (!esHistorico) {
    for (const d of dos) {
      if (soloCostosPropios(d.facturas)) continue;
      const c = contexto.get(d.tramiteId);
      if (c && c.exigeAnticipo && !c.tieneAnticipoAplicado) {
        throw new SinAnticipoAplicadoMultiDOError(d.tramiteId, c.consecutivo, c.clienteNombre);
      }
    }
  }

  // 8. Costo bancario UNA vez (D-1). PRORRATEADO pesa por lo que cada DO le
  // cobra a su cliente: la asesoría (NO SE COBRA) no atrae costo bancario.
  const paraCosto = dos.map((d) => ({
    valor: d.cobrable,
    puedeAbsorber: puedeAbsorberCostoDelBloque(contexto.get(d.tramiteId)?.puedeAbsorberCosto ?? false, d.facturas),
  }));
  const reglaPedida: CostoAsumidoPor = esHistorico
    ? "GALCOMEX"
    : (input.costoAsumidoPor ?? reglaCostoPorDefecto(paraCosto));
  const costos = costoPorPago(reglaPedida, costoBancario, paraCosto);
  const sumaCostos = costos.reduce((s, c) => s + c, 0n);
  const reglaResuelta: CostoBancarioAsumidoPor =
    costoBancario > 0n && sumaCostos === 0n ? "GALCOMEX" : reglaPedida;
  await tx.pagoGrupo.update({ where: { id: grupoPagoId }, data: { costoAsumidoPor: reglaResuelta } });

  const advertencias: AdvertenciaPago[] = [];
  if (costoBancario > 0n && reglaResuelta !== "GALCOMEX") {
    const primero = costos.findIndex((c) => c > 0n);
    dos.forEach((d, i) => {
      const c = contexto.get(d.tramiteId);
      const estado = c?.estadoBorrador;
      const saltado = reglaResuelta === "PRIMER_DO" ? i < primero : costos[i] === 0n;
      if (c && saltado && (estado === "APROBADO" || estado === "FACTURADO")) {
        advertencias.push(
          advertenciaCostoNoCobrable({
            tramiteId: d.tramiteId,
            consecutivo: c.consecutivo,
            anio: c.anio,
            numero: c.numero,
            estadoBorrador: estado,
          }),
        );
      }
    });
  }

  let bancoFinal: string | null = bancoBeneficiarioId ?? null;
  if (bancoFinal === null && canalPago === "TRANSF_BANCOLOMBIA") {
    bancoFinal = await resolverBancoBancolombiaId(tx);
  }

  // 9. Un PagoTramite por DO + aplicarSaldo de sus facturas.
  const pagosCreados: PagoTramite[] = [];
  for (const [i, d] of dos.entries()) {
    const orden = await siguienteOrden(tx, d.tramiteId);
    const pago = await tx.pagoTramite.create({
      data: {
        tramiteId: d.tramiteId,
        concepto: concepto ?? `Pago en bloque ${proveedorBloque.nombre} — ${d.aplicaciones.length} factura(s)`,
        documentoId: documentoId ?? null,
        comprobanteComercioId: comprobanteComercioId ?? null,
        grupoPagoId,
        valor: d.total,
        canalPago,
        costoBancario: costos[i],
        orden,
        fechaRealPago: fechaRealPago ?? null,
        bancoBeneficiarioId: bancoFinal,
      },
    });

    await tx.pagoTramiteBeneficiario.create({
      data: { pagoId: pago.id, beneficiarioId },
    });

    await aplicarSaldo(tx, {
      origen: { tipo: "PAGO", pagoId: pago.id, tramiteId: d.tramiteId, esHistorico },
      aplicaciones: d.aplicaciones,
      facturas,
      proveedorBloque,
      modo: esHistorico ? "CONCILIACION" : "BLOQUE",
      usuarioId,
    });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId,
        tramiteId: d.tramiteId,
        despues: normalizeSerializable({
          ...pago,
          grupoPagoId,
          beneficiarioId,
          facturaProveedorIds: d.aplicaciones.map((a) => a.facturaProveedorId),
          aplicaciones: d.aplicaciones,
        }),
      },
    });

    const c = contexto.get(d.tramiteId);
    if (c && !esHistorico && !soloCostosPropios(d.facturas)) {
      const insuficiente = advertenciaAnticipoInsuficiente({
        tramiteId: d.tramiteId,
        consecutivo: c.consecutivo,
        anio: c.anio,
        numero: c.numero,
        // Saldo del cliente: solo baja lo que se le cobra (sin asesoría).
        saldoDespues: c.saldoTramite - d.cobrable,
      });
      if (insuficiente) advertencias.push(insuficiente);
      if (c.anticipoSinVerificar) {
        advertencias.push(
          advertenciaAnticipoSinVerificar({ tramiteId: d.tramiteId, consecutivo: c.consecutivo, anio: c.anio, numero: c.numero }),
        );
      }
    }

    pagosCreados.push(pago);
  }

  const transferido = advertenciaValorTransferido(input.valorTransferido, totalPedido);
  if (transferido) advertencias.push(transferido);

  // Auditoría a nivel de grupo (no pertenece a un único trámite). La entidad se
  // conserva ("PagoTramiteGrupo"): la migración lee de aquí el creador del bloque.
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
        costoBancarioTotal: costoBancario,
        costoAsumidoPor: reglaResuelta,
        esHistorico,
        valorTransferido: input.valorTransferido ?? null,
        tramites: dos.map((d, i) => ({
          tramiteId: d.tramiteId,
          consecutivo: d.consecutivo,
          valor: d.total,
          costoBancario: costos[i],
        })),
      }),
    },
  });

  return {
    grupoPagoId,
    pagos: pagosCreados,
    advertencias,
    repetido: false,
    costoBancario,
    costoAsumidoPor: reglaResuelta,
  };
}

// ─── Anular / editar un bloque (§B.4) ────────────────────────────────────────

/**
 * Anula un pago en bloque COMPLETO (solo ADMIN — lo exige la ruta — con
 * motivo ≥ 10 caracteres). Atómico: devuelve el saldo a todas sus facturas,
 * borra sus PagoTramite (los DOs recuperan su saldo) y deja la cabecera
 * ANULADA con la foto de DOs, facturas y montos para el historial. Si algún DO
 * del bloque está CERRADO no toca nada (BLOQUE_CON_DO_CERRADO).
 */
export async function anularPagoGrupo(
  grupoId: string,
  motivo: string,
  usuarioId: string,
): Promise<{ grupoPagoId: string; facturasReabiertas: string[] }> {
  const motivoLimpio = motivo.trim();
  if (motivoLimpio.length < 10) throw new MotivoAnulacionInvalidoError();

  return prisma.$transaction(
    async (tx) => {
      // (1) cabecera
      const filas = await tx.$queryRaw<{ id: string; estado: string }[]>(
        Prisma.sql`SELECT id, estado::text AS estado FROM "pago_grupo" WHERE id = ${grupoId} FOR UPDATE`,
      );
      const cabecera = filas[0];
      if (!cabecera) throw new PagoGrupoNoEncontradoError(grupoId);
      if (cabecera.estado === "ANULADO") throw new PagoGrupoAnuladoError();

      const previos = await tx.pagoTramite.findMany({ where: { grupoPagoId: grupoId }, select: { tramiteId: true } });
      // (2) DOs
      await bloquearTramites(tx, previos.map((p) => p.tramiteId));
      const tramites = await tx.tramiteDO.findMany({
        where: { id: { in: previos.map((p) => p.tramiteId) } },
        select: { id: true, consecutivo: true, estado: true },
        orderBy: { consecutivo: "asc" },
      });
      const cerrados = tramites.filter((t) => t.estado === "CERRADO").map((t) => t.consecutivo);
      if (cerrados.length > 0) throw new BloqueConDoCerradoError(cerrados);

      const pagos = await tx.pagoTramite.findMany({
        where: { grupoPagoId: grupoId },
        select: {
          id: true,
          tramiteId: true,
          valor: true,
          costoBancario: true,
          concepto: true,
          tramite: { select: { consecutivo: true } },
          facturasProveedor: {
            select: {
              facturaId: true,
              monto: true,
              factura: { select: { numFactura: true, beneficiario: { select: { numFacturaConEspacio: true } } } },
            },
          },
        },
        orderBy: { tramite: { consecutivo: "asc" } },
      });

      const snapshot = {
        pagos: pagos.map((p) => ({
          pagoId: p.id,
          tramiteId: p.tramiteId,
          consecutivo: p.tramite.consecutivo,
          valor: p.valor.toString(),
          costoBancario: p.costoBancario.toString(),
          facturas: p.facturasProveedor.map((x) => ({
            facturaId: x.facturaId,
            numFactura: x.factura.numFactura,
            numFacturaVisible: numeroFacturaVisible(x.factura.numFactura, x.factura.beneficiario?.numFacturaConEspacio ?? false),
            monto: x.monto.toString(),
          })),
        })),
      };

      // (3) facturas: devolver saldo
      const facturasReabiertas = await revertirSaldo(
        tx,
        { tipo: "PAGOS", pagoIds: pagos.map((p) => p.id) },
        usuarioId,
        `Anulación del pago en bloque: ${motivoLimpio}`,
      );

      await tx.pagoTramite.deleteMany({ where: { grupoPagoId: grupoId } });
      for (const p of pagos) {
        await tx.auditLog.create({
          data: {
            entidad: "PagoTramite",
            entidadId: p.id,
            accion: "DELETE",
            usuarioId,
            tramiteId: p.tramiteId,
            antes: normalizeSerializable(p),
            despues: normalizeSerializable({ motivo: `Anulación del pago en bloque ${grupoId}: ${motivoLimpio}` }),
          },
        });
      }

      await tx.pagoGrupo.update({
        where: { id: grupoId },
        data: {
          estado: "ANULADO",
          motivoAnulacion: motivoLimpio,
          anuladoPorId: usuarioId,
          anuladoEn: new Date(),
          snapshotAnulacion: snapshot,
        },
      });

      await tx.auditLog.create({
        data: {
          entidad: "PagoGrupo",
          entidadId: grupoId,
          accion: "ANULAR_PAGO_GRUPO",
          usuarioId,
          antes: normalizeSerializable(snapshot),
          despues: normalizeSerializable({ estado: "ANULADO", motivo: motivoLimpio, facturasReabiertas }),
        },
      });

      return { grupoPagoId: grupoId, facturasReabiertas };
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/**
 * Edita lo que es de la transferencia en un bloque (ADMIN/OPERATIVO): concepto,
 * fecha, comprobantes y valor que salió del banco. Se propaga a todos sus
 * pagos. El valor y el canal no se editan (anula y registra de nuevo).
 */
export async function actualizarPagoGrupo(
  grupoId: string,
  cambios: CambiosGrupo,
  usuarioId: string,
) {
  return prisma.$transaction(async (tx) => {
    const filas = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "pago_grupo" WHERE id = ${grupoId} FOR UPDATE`,
    );
    if (filas.length === 0) throw new PagoGrupoNoEncontradoError(grupoId);
    const antes = await tx.pagoGrupo.findUniqueOrThrow({ where: { id: grupoId } });
    if (antes.estado === "ANULADO") throw new PagoGrupoAnuladoError();

    const pagos = await tx.pagoTramite.findMany({ where: { grupoPagoId: grupoId }, select: { tramiteId: true } });
    await bloquearTramites(tx, pagos.map((p) => p.tramiteId));
    const tramites = await tx.tramiteDO.findMany({
      where: { id: { in: pagos.map((p) => p.tramiteId) } },
      select: { id: true, consecutivo: true, estado: true },
    });
    for (const t of tramites) await assertTramiteModificable(tx, t);

    await propagarCambiosGrupo(tx, { id: grupoId, esHistorico: antes.esHistorico }, cambios);
    const despues = await tx.pagoGrupo.findUniqueOrThrow({ where: { id: grupoId } });

    await tx.auditLog.create({
      data: {
        entidad: "PagoGrupo",
        entidadId: grupoId,
        accion: "UPDATE",
        usuarioId,
        antes: normalizeSerializable(antes),
        despues: normalizeSerializable(despues),
      },
    });

    const advertencias: AdvertenciaPago[] = [];
    const aviso = advertenciaValorTransferido(despues.valorTransferido, despues.totalAplicado);
    if (aviso) advertencias.push(aviso);
    return { grupo: despues, advertencias };
  });
}
