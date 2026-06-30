/**
 * Servicio de borradores de factura — Galcomex
 * A1-T8: Motor de cálculo integrado con BD + ciclo de vida del borrador + cartera
 *
 * Implementa:
 * - generarBorrador: arma el DTO desde BD, llama al motor puro, persiste BorradorFactura
 * - transicionarBorrador: BORRADOR→EN_REVISION→APROBADO→FACTURADO con validaciones
 * - listarBorradores: lista borradores de un trámite
 */

import { CanalPago, EstadoBorrador, Prisma, TipoCliente, TipoRecaudo } from "@prisma/client";

import { COMISION_INTERNA_LM_MINIMO } from "@/lib/validations/borradores";

import { calcularBorrador } from "@/lib/calculations/motor-factura";
import { calcularSaldoLMInterno } from "@/lib/calculations/cruce-lm";
import { prisma } from "@/lib/db/prisma";
import { getParametrosSistema } from "@/lib/parametros/service";

import {
  actualizarLineasComision,
  definirLineasFijasParaCreate,
  ensureLineasFijas,
  resolverProductosLineasFijas,
} from "./lineas-fijas";
import { recalcularTotalBorrador } from "./recalculo";

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Un concepto operacional con nombre y valor (para el desglose de la comisión). */
export type ConceptoOperacional = {
  concepto: string;
  valor: bigint;
};

type GenerarBorradorInput = {
  tramiteId: string;
  comision?: bigint;
  ivaComision?: bigint;
  montoLM?: bigint;
  /**
   * Total de retenciones (RETE IVA + RETE FTE + RETE ICA).
   * Pasa directo al motor. Default 0n.
   */
  retenciones?: bigint;
  /**
   * Desglose de la comisión en conceptos operacionales.
   * Si se pasa, su suma DEBE igualar la comisión efectiva; si no, lanza error de validación.
   * Ej: [{concepto: "REVISIÓN DOCUMENTOS", valor: 20000n}, ...]
   */
  conceptosOperacionales?: ConceptoOperacional[];
  usuarioId: string;
};

type TransicionarBorradorInput = {
  borradorId: string;
  nuevoEstado: EstadoBorrador;
  usuarioId: string;
  numFacturaSiigo?: string;
  fechaFactura?: Date;
};

type TransicionResult =
  | { ok: true; borrador: Awaited<ReturnType<typeof getBorradorCompleto>> }
  | { ok: false; status: number; message: string };

const ESTADOS_FACTURABLES = [
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
  "CERRADO",
] as const;

// ─── Errores tipados ──────────────────────────────────────────────────────────

export class BorradorNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Borrador ${id} no encontrado`);
    this.name = "BorradorNoEncontradoError";
  }
}

export class TransicionInvalidaError extends Error {
  public readonly status = 422;
  constructor(desde: EstadoBorrador, hacia: EstadoBorrador) {
    super(`Transición inválida: ${desde} → ${hacia}`);
    this.name = "TransicionInvalidaError";
  }
}

export class BorradorNoAprobadoError extends Error {
  public readonly status = 422;
  constructor() {
    super("No se puede facturar un borrador que no está en estado APROBADO");
    this.name = "BorradorNoAprobadoError";
  }
}

export class ConceptosOperacionalesInvalidosError extends Error {
  public readonly status = 422;
  constructor(sumaConceptos: bigint, comision: bigint) {
    super(
      `La suma de conceptosOperacionales (${sumaConceptos}) debe igualar la comisión (${comision})`,
    );
    this.name = "ConceptosOperacionalesInvalidosError";
  }
}

export class TramiteNoFacturableError extends Error {
  public readonly status = 422;
  constructor(estado: string) {
    super(
      `El trámite debe estar en estado ENVIADO_A_FACTURAR o posterior para generar un borrador. Estado actual: ${estado}.`,
    );
    this.name = "TramiteNoFacturableError";
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

const TRANSITIONS: Record<EstadoBorrador, EstadoBorrador[]> = {
  [EstadoBorrador.BORRADOR]: [EstadoBorrador.EN_REVISION],
  [EstadoBorrador.EN_REVISION]: [EstadoBorrador.APROBADO],
  [EstadoBorrador.APROBADO]: [EstadoBorrador.FACTURADO],
  [EstadoBorrador.FACTURADO]: [],
};

/**
 * Lee el parámetro SIIGO_FORMA_PAGO_DEFAULT_ID y verifica que la forma de pago
 * exista localmente. Devuelve null si no está configurado o si el FK no existe
 * (evita romper el create por FK inválido — el admin lo asigna manualmente luego).
 */
async function resolveFormaPagoDefault(): Promise<number | null> {
  const param = await prisma.parametro.findUnique({
    where: { clave: "SIIGO_FORMA_PAGO_DEFAULT_ID" },
    select: { valor: true },
  });
  if (!param?.valor) return null;
  const id = Number(param.valor);
  if (!Number.isFinite(id)) return null;
  const existe = await prisma.siigoFormaPago.findUnique({
    where: { id },
    select: { id: true },
  });
  return existe ? id : null;
}

async function getBorradorCompleto(borradorId: string) {
  return prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    include: {
      lineasRevision: {
        orderBy: { orden: "asc" },
        include: {
          facturas: { include: { factura: true } },
          siigoProducto: {
            select: { id: true, codigo: true, nombre: true, clasificacionIva: true },
          },
        },
      },
      formaPago: { select: { id: true, nombre: true, tipo: true } },
      factura: true,
    },
  });
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Genera un BorradorFactura para un trámite:
 * 1. Lee anticipos aplicados, pagos y parámetros desde BD.
 * 2. Llama al motor puro calcularBorrador().
 * 3. Persiste el borrador con estado BORRADOR y sus líneas de revisión.
 * 4. Genera AuditLog.
 */
export async function generarBorrador(input: GenerarBorradorInput) {
  const { tramiteId, usuarioId, retenciones = 0n, conceptosOperacionales } = input;

  // ── Verificar que el trámite está en estado facturable ────────────────────
  const tramiteEstado = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: { estado: true, cliente: { select: { tipo: true } } },
  });
  if (!tramiteEstado) {
    throw new TramiteNoFacturableError("no encontrado");
  }
  if (!(ESTADOS_FACTURABLES as readonly string[]).includes(tramiteEstado.estado)) {
    throw new TramiteNoFacturableError(tramiteEstado.estado);
  }
  const tipoCliente = tramiteEstado.cliente.tipo;

  // ── Leer datos del trámite en paralelo ────────────────────────────────────
  const [aplicaciones, pagos, params, formaPagoDefault, productosFijos] =
    await Promise.all([
      prisma.aplicacionAnticipo.findMany({
        where: { tramiteId },
        select: {
          montoAplicado: true,
          anticipo: {
            select: {
              id: true,
              costoRecaudo: true,
            },
          },
        },
      }),
      prisma.pagoTramite.findMany({
        where: { tramiteId },
        orderBy: { orden: "asc" },
        select: {
          valor: true,
          costoBancario: true,
          concepto: true,
          numSoporte: true,
        },
      }),
      getParametrosSistema(),
      resolveFormaPagoDefault(),
      resolverProductosLineasFijas(),
    ]);

  // ── Armar DTO para el motor ───────────────────────────────────────────────

  // totalAnticipoAplicado = Σ montoAplicado de AplicacionAnticipo
  const totalAnticipoAplicado = aplicaciones.reduce(
    (sum, a) => sum + a.montoAplicado,
    0n,
  );

  // costoRecaudoAnticipo = Σ costoRecaudo (snapshot) de cada anticipo DISTINTO aplicado
  const anticiposDistintosIds = new Set(aplicaciones.map((a) => a.anticipo.id));
  const costoRecaudoAnticipo = aplicaciones
    .filter((a, idx, arr) => arr.findIndex((b) => b.anticipo.id === a.anticipo.id) === idx)
    .reduce((sum, a) => sum + a.anticipo.costoRecaudo, 0n);
  void anticiposDistintosIds; // referenciado implícitamente

  const comision = input.comision ?? params.comisionDefault;

  // Validar conceptosOperacionales si se proporcionan
  if (conceptosOperacionales && conceptosOperacionales.length > 0) {
    const sumaConceptos = conceptosOperacionales.reduce((sum, c) => sum + c.valor, 0n);
    if (sumaConceptos !== comision) {
      throw new ConceptosOperacionalesInvalidosError(sumaConceptos, comision);
    }
  }

  const dto = {
    totalAnticipoAplicado,
    costoRecaudoAnticipo,
    pagos: pagos.map((p) => ({ valor: p.valor, costoBancario: p.costoBancario })),
    comision,
    ivaComision: input.ivaComision,
    tasaIva: params.tasaIva,
    tasa4x1000: params.tasa4x1000,
    montoLM: input.montoLM ?? 0n,
    retenciones,
  };

  // ── Calcular ──────────────────────────────────────────────────────────────
  const resultado = calcularBorrador(dto);

  // ── Cruce interno con Lucho (solo SOCIO_LM) ───────────────────────────────
  // La comisión interna (mínima, ej. 150.000) es DISTINTA de la comisión de
  // factura: solo afecta este cruce, no el saldo a favor del cliente. Se calcula
  // con los outputs CRUDOS del motor (costosBancarios real, incl. recaudo $1.950),
  // antes de que el espejo de líneas fijas ponga costos/comisión en 0 para SOCIO_LM.
  const esSocioLM = tipoCliente === TipoCliente.SOCIO_LM;
  const comisionInternaLM = esSocioLM ? params.comisionDefault : 0n;
  const saldoLMInterno = esSocioLM
    ? calcularSaldoLMInterno({
        totalAnticipo: totalAnticipoAplicado,
        totalPagos: resultado.totalPagos,
        comisionInternaLM,
        ivaComision: resultado.ivaComision,
        costosBancarios: resultado.costosBancarios,
        tasa4x1000: params.tasa4x1000,
      }).saldoLMInterno
    : 0n;

  // El borrador nace con las 4 líneas fijas (COMISION, IVA_COMISION,
  // COSTOS_BANCARIOS, IMPUESTO_4X1000) sembradas desde los outputs del motor.
  // Cada una lleva su `siigoProductoId` resuelto desde parámetros; si falta el
  // FK, queda en null y el revisor lo asigna en el editor.
  const lineasFijasCreate = definirLineasFijasParaCreate(
    {
      comision: resultado.comision,
      ivaComision: resultado.ivaComision,
      costosBancarios: resultado.costosBancarios,
      impuesto4x1000: resultado.impuesto4x1000,
    },
    productosFijos,
    tipoCliente,
  );

  // Para SOCIO_LM: observación de cabecera obligatoria que indica al receptor de
  // la factura Siigo que NO se deben practicar retenciones en la fuente ni de ICA.
  const OBSERVACION_NO_RETENCIONES = "NO PRACTICAR RETEFUENTE NI RETEICA";
  const comentariosCabeceraInicial: string[] =
    tipoCliente === TipoCliente.SOCIO_LM ? [OBSERVACION_NO_RETENCIONES] : [];

  // ── Persistir en transacción ──────────────────────────────────────────────
  return prisma.$transaction(async (tx) => {
    const borrador = await tx.borradorFactura.create({
      data: {
        tramiteId,
        // Estos campos se espejan desde las líneas fijas en `recalcularTotalBorrador`;
        // los inicializamos aquí para que el primer audit log refleje el motor.
        comision: resultado.comision,
        ivaComision: resultado.ivaComision,
        impuesto4x1000: resultado.impuesto4x1000,
        costosBancarios: resultado.costosBancarios,
        totalAnticipo: totalAnticipoAplicado,
        totalPagos: resultado.totalPagos,
        totalFactura: resultado.totalFactura,
        saldoAFavorCliente: resultado.saldoAFavorCliente,
        saldoACargoCliente: resultado.saldoACargoCliente,
        saldoAFavorLM: resultado.saldoAFavorLM,
        saldoACargoLM: resultado.saldoACargoLM,
        comisionInternaLM,
        saldoLMInterno,
        retenciones: resultado.retenciones,
        totalFacturaLineas: 0n,
        formaPagoSiigoId: formaPagoDefault,
        conceptosOperacionales: conceptosOperacionales
          ? normalizeSerializable(conceptosOperacionales)
          : undefined,
        // Para SOCIO_LM: observación de no retenciones sembrada automáticamente.
        comentariosCabecera:
          comentariosCabeceraInicial.length > 0
            ? normalizeSerializable(comentariosCabeceraInicial)
            : undefined,
        estado: EstadoBorrador.BORRADOR,
        lineasRevision: {
          create: lineasFijasCreate,
        },
      },
      include: { lineasRevision: { orderBy: { orden: "asc" } } },
    });

    // Recalcular: con las 4 líneas fijas ya creadas, `totalFacturaLineas` queda
    // igual al motor (con retenciones=0n y montoLM=0n) o consistente con líneas
    // manuales si las hay (caso SOCIO_LM, agregadas después).
    await recalcularTotalBorrador(tx, borrador.id);

    await tx.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borrador.id,
        accion: "CREATE",
        usuarioId,
        tramiteId,
        despues: normalizeSerializable({ ...borrador, resultado }),
      },
    });

    return tx.borradorFactura.findUniqueOrThrow({
      where: { id: borrador.id },
      include: { lineasRevision: { orderBy: { orden: "asc" } } },
    });
  });
}

/**
 * Transiciona un borrador de estado.
 *
 * Mapa válido: BORRADOR → EN_REVISION → APROBADO → FACTURADO
 *
 * - Al aprobar: guarda snapshotCalculo + aprobadoPorId + fechaAprobacion
 * - Al facturar: exige numFacturaSiigo + fechaFactura; solo si estado == APROBADO;
 *   crea registro Factura (cartera)
 */
export async function transicionarBorrador(
  input: TransicionarBorradorInput,
): Promise<TransicionResult> {
  const { borradorId, nuevoEstado, usuarioId, numFacturaSiigo, fechaFactura } = input;

  return prisma.$transaction(async (tx) => {
    const borrador = await tx.borradorFactura.findUnique({
      where: { id: borradorId },
      include: {
        tramite: { select: { id: true, clienteId: true } },
      },
    });

    if (!borrador) {
      return { ok: false, status: 404, message: `Borrador ${borradorId} no encontrado` };
    }

    // Validar transición
    if (!TRANSITIONS[borrador.estado].includes(nuevoEstado)) {
      return {
        ok: false,
        status: 422,
        message: `Transición inválida: ${borrador.estado} → ${nuevoEstado}`,
      };
    }

    // Validar facturación
    if (nuevoEstado === EstadoBorrador.FACTURADO) {
      if (borrador.estado !== EstadoBorrador.APROBADO) {
        return {
          ok: false,
          status: 422,
          message: "No se puede facturar un borrador que no está en estado APROBADO",
        };
      }
      if (!numFacturaSiigo || !fechaFactura) {
        return {
          ok: false,
          status: 422,
          message: "numFacturaSiigo y fechaFactura son obligatorios al facturar",
        };
      }
    }

    // Snapshot inmutable al aprobar
    const snapshot =
      nuevoEstado === EstadoBorrador.APROBADO
        ? normalizeSerializable({
            comision: borrador.comision,
            ivaComision: borrador.ivaComision,
            impuesto4x1000: borrador.impuesto4x1000,
            costosBancarios: borrador.costosBancarios,
            totalAnticipo: borrador.totalAnticipo,
            totalPagos: borrador.totalPagos,
            totalFactura: borrador.totalFactura,
            saldoAFavorCliente: borrador.saldoAFavorCliente,
            saldoACargoCliente: borrador.saldoACargoCliente,
            saldoAFavorLM: borrador.saldoAFavorLM,
            saldoACargoLM: borrador.saldoACargoLM,
            retenciones: borrador.retenciones,
            conceptosOperacionales: borrador.conceptosOperacionales,
          })
        : undefined;

    // Actualizar borrador
    const updated = await tx.borradorFactura.update({
      where: { id: borradorId },
      data: {
        estado: nuevoEstado,
        ...(nuevoEstado === EstadoBorrador.APROBADO && {
          aprobadoPorId: usuarioId,
          fechaAprobacion: new Date(),
          snapshotCalculo: snapshot,
        }),
        ...(nuevoEstado === EstadoBorrador.FACTURADO && {
          facturadoPorId: usuarioId,
          numFacturaSiigo,
          fechaFactura,
        }),
      },
      include: {
        lineasRevision: {
          orderBy: { orden: "asc" },
          include: {
            facturas: { include: { factura: true } },
            siigoProducto: {
              select: { id: true, codigo: true, nombre: true, clasificacionIva: true },
            },
          },
        },
        formaPago: { select: { id: true, nombre: true, tipo: true } },
        factura: true,
      },
    });

    // Al facturar: crear registro Factura (alimenta cartera)
    if (nuevoEstado === EstadoBorrador.FACTURADO) {
      await tx.factura.create({
        data: {
          borradorId: borradorId,
          clienteId: borrador.tramite.clienteId,
          numSiigo: numFacturaSiigo!,
          fecha: fechaFactura!,
          totalFactura: borrador.totalFactura,
          saldoAFavorCliente: borrador.saldoAFavorCliente,
          saldoACargoCliente: borrador.saldoACargoCliente,
          saldoAFavorLM: borrador.saldoAFavorLM,
          saldoACargoLM: borrador.saldoACargoLM,
        },
      });

      // Recargar el borrador para que la relación `factura` sea visible
      const reloaded = await tx.borradorFactura.findUnique({
        where: { id: borradorId },
        include: {
          lineasRevision: {
            orderBy: { orden: "asc" },
            include: {
              facturas: { include: { factura: true } },
              siigoProducto: {
                select: { id: true, codigo: true, nombre: true, clasificacionIva: true },
              },
            },
          },
          formaPago: { select: { id: true, nombre: true, tipo: true } },
          factura: true,
        },
      });

      // AuditLog de la facturación — antes del early return
      await tx.auditLog.create({
        data: {
          entidad: "BorradorFactura",
          entidadId: borradorId,
          accion: "FACTURAR",
          usuarioId,
          tramiteId: borrador.tramiteId,
          antes: normalizeSerializable({ estado: borrador.estado }),
          despues: normalizeSerializable({
            estado: nuevoEstado,
            numFacturaSiigo,
            fechaFactura,
          }),
        },
      });

      return { ok: true, borrador: reloaded };
    }

    // Para llegar aquí nuevoEstado solo puede ser EN_REVISION o APROBADO
    const accion = nuevoEstado === EstadoBorrador.APROBADO ? "APPROVE" : "UPDATE_ESTADO";

    await tx.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion,
        usuarioId,
        tramiteId: borrador.tramiteId,
        antes: normalizeSerializable({ estado: borrador.estado }),
        despues: normalizeSerializable({
          estado: nuevoEstado,
          ...(nuevoEstado === EstadoBorrador.APROBADO && { snapshotCalculo: snapshot }),
        }),
      },
    });

    return { ok: true, borrador: updated };
  });
}

/**
 * Reemplaza los comentarios de cabecera de un borrador.
 * Solo permitido en estados editables (BORRADOR, EN_REVISION).
 */
export async function actualizarComentariosCabecera(
  borradorId: string,
  comentarios: string[],
  usuarioId: string,
): Promise<{ ok: true; borrador: Awaited<ReturnType<typeof getBorradorCompleto>> } | { ok: false; status: number; message: string }> {
  const actual = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { estado: true, tramiteId: true, comentariosCabecera: true },
  });
  if (!actual) {
    return { ok: false, status: 404, message: `Borrador ${borradorId} no encontrado` };
  }
  if (
    actual.estado !== EstadoBorrador.BORRADOR &&
    actual.estado !== EstadoBorrador.EN_REVISION
  ) {
    return {
      ok: false,
      status: 422,
      message: `No se pueden editar comentarios en estado ${actual.estado}`,
    };
  }

  const limpios = comentarios
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  await prisma.$transaction([
    prisma.borradorFactura.update({
      where: { id: borradorId },
      data: {
        // Siempre se almacena como array (vacío si no hay) para evitar la
        // ambigüedad entre Prisma.JsonNull y Prisma.DbNull.
        comentariosCabecera: normalizeSerializable(limpios),
      },
    }),
    prisma.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion: "UPDATE_COMENTARIOS",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable({ comentariosCabecera: actual.comentariosCabecera }),
        despues: normalizeSerializable({ comentariosCabecera: limpios }),
      },
    }),
  ]);

  const borrador = await getBorradorCompleto(borradorId);
  return { ok: true as const, borrador };
}

/**
 * Actualiza la comisión del borrador y recalcula IVA + total + saldos.
 * IVA = comision × tasaIva / 100 (truncado, mismo cálculo que el motor).
 * Solo permitido en estados editables (BORRADOR, EN_REVISION).
 */
export async function actualizarComisionBorrador(
  borradorId: string,
  nuevaComision: bigint,
  usuarioId: string,
): Promise<
  | { ok: true; borrador: Awaited<ReturnType<typeof getBorradorCompleto>> }
  | { ok: false; status: number; message: string }
> {
  const lockKey = `borrador_lineas:${borradorId}`;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const actual = await tx.borradorFactura.findUnique({
      where: { id: borradorId },
      select: {
        estado: true,
        tramiteId: true,
        comision: true,
        ivaComision: true,
      },
    });
    if (!actual) {
      return {
        ok: false as const,
        status: 404,
        message: `Borrador ${borradorId} no encontrado`,
      };
    }
    if (
      actual.estado !== EstadoBorrador.BORRADOR &&
      actual.estado !== EstadoBorrador.EN_REVISION
    ) {
      return {
        ok: false as const,
        status: 422,
        message: `No se puede editar la comisión en estado ${actual.estado}`,
      };
    }

    const params = await getParametrosSistema();
    const nuevoIva = (nuevaComision * params.tasaIva) / 100n;

    // La comisión + IVA viven como LineaRevision (tipoFija COMISION /
    // IVA_COMISION). Si el borrador es heredado y aún no las tiene, se crean.
    await actualizarLineasComision(tx, borradorId, nuevaComision, params.tasaIva);

    // El recálculo espeja `borrador.comision`/`ivaComision` desde las líneas.
    await recalcularTotalBorrador(tx, borradorId);

    await tx.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion: "UPDATE_COMISION",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable({
          comision: actual.comision,
          ivaComision: actual.ivaComision,
        }),
        despues: normalizeSerializable({
          comision: nuevaComision,
          ivaComision: nuevoIva,
        }),
      },
    });

    return { ok: true as const };
  });

  if (!result.ok) return result;

  const borrador = await getBorradorCompleto(borradorId);
  return { ok: true as const, borrador };
}

/**
 * Actualiza la comisión interna Galcomex→Lucho y recalcula `saldoLMInterno`.
 * SOLO afecta el cruce interno; NO toca el saldo a favor del cliente.
 *
 * Los costos bancarios reales (incl. recaudo $1.950) se recomputan desde
 * pagos + anticipos porque `borrador.costosBancarios` queda en 0 para SOCIO_LM
 * (la línea COSTOS_BANCARIOS no se materializa en ese flujo).
 *
 * Solo permitido para trámites SOCIO_LM en estados editables (BORRADOR, EN_REVISION).
 */
export type ActualizarComisionInternaLMInput = {
  comisionInternaLM: bigint;
  /** Exactamente uno debe estar set; el otro debe ser null. */
  tipoRecaudoComisionInternaLM: TipoRecaudo | null;
  canalPagoComisionInternaLM: CanalPago | null;
};

export async function actualizarComisionInternaLM(
  borradorId: string,
  input: ActualizarComisionInternaLMInput,
  usuarioId: string,
): Promise<
  | { ok: true; borrador: Awaited<ReturnType<typeof getBorradorCompleto>> }
  | { ok: false; status: number; message: string }
> {
  const lockKey = `borrador_lineas:${borradorId}`;

  // Defensa en profundidad: el schema Zod ya valida el mínimo, pero el servicio
  // también lo aplica para callers internos que no pasen por la validación HTTP.
  if (input.comisionInternaLM < COMISION_INTERNA_LM_MINIMO) {
    return {
      ok: false as const,
      status: 422,
      message: `La comisión interna LM no puede ser menor a ${COMISION_INTERNA_LM_MINIMO} COP`,
    };
  }

  const tieneRecaudo = input.tipoRecaudoComisionInternaLM !== null;
  const tieneCanal = input.canalPagoComisionInternaLM !== null;
  if (tieneRecaudo === tieneCanal) {
    return {
      ok: false as const,
      status: 422,
      message:
        "Debe especificarse exactamente uno de tipoRecaudoComisionInternaLM o canalPagoComisionInternaLM",
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const actual = await tx.borradorFactura.findUnique({
      where: { id: borradorId },
      select: {
        estado: true,
        tramiteId: true,
        comisionInternaLM: true,
        tipoRecaudoComisionInternaLM: true,
        canalPagoComisionInternaLM: true,
        costoComisionInternaLM: true,
        saldoLMInterno: true,
        totalAnticipo: true,
        totalPagos: true,
        ivaComision: true,
        tramite: { select: { cliente: { select: { tipo: true } } } },
      },
    });
    if (!actual) {
      return {
        ok: false as const,
        status: 404,
        message: `Borrador ${borradorId} no encontrado`,
      };
    }
    if (actual.tramite.cliente.tipo !== TipoCliente.SOCIO_LM) {
      return {
        ok: false as const,
        status: 422,
        message: "La comisión interna LM solo aplica a trámites SOCIO_LM",
      };
    }
    if (
      actual.estado !== EstadoBorrador.BORRADOR &&
      actual.estado !== EstadoBorrador.EN_REVISION
    ) {
      return {
        ok: false as const,
        status: 422,
        message: `No se puede editar la comisión interna en estado ${actual.estado}`,
      };
    }

    // Resolver el costo bancario del tipo de pago elegido para la comisión LM
    // contra matriz_recaudo (Lucho paga a Galcomex = entra plata) o matriz_pago
    // (Galcomex paga = sale plata). Falla si la matriz no tiene el canal.
    let costoComisionInternaLM = 0n;
    if (input.tipoRecaudoComisionInternaLM !== null) {
      const m = await tx.matrizRecaudo.findUnique({
        where: { tipoRecaudo: input.tipoRecaudoComisionInternaLM },
        select: { costoFijo: true },
      });
      if (!m) {
        return {
          ok: false as const,
          status: 422,
          message: `Tipo de recaudo ${input.tipoRecaudoComisionInternaLM} no está en la matriz`,
        };
      }
      costoComisionInternaLM = m.costoFijo;
    } else if (input.canalPagoComisionInternaLM !== null) {
      const m = await tx.matrizPago.findUnique({
        where: { canalPago: input.canalPagoComisionInternaLM },
        select: { costoFijo: true },
      });
      if (!m) {
        return {
          ok: false as const,
          status: 422,
          message: `Canal de pago ${input.canalPagoComisionInternaLM} no está en la matriz`,
        };
      }
      costoComisionInternaLM = m.costoFijo;
    }

    // Costos bancarios reales: Σ costos de pagos + Σ costoRecaudo de anticipos
    // distintos + costo del tipo de pago de la comisión interna LM.
    const [pagos, aplicaciones, params] = await Promise.all([
      tx.pagoTramite.findMany({
        where: { tramiteId: actual.tramiteId },
        select: { costoBancario: true },
      }),
      tx.aplicacionAnticipo.findMany({
        where: { tramiteId: actual.tramiteId },
        select: { anticipo: { select: { id: true, costoRecaudo: true } } },
      }),
      getParametrosSistema(),
    ]);

    const costosPagos = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);
    const costoRecaudoAnticipo = aplicaciones
      .filter(
        (a, idx, arr) =>
          arr.findIndex((b) => b.anticipo.id === a.anticipo.id) === idx,
      )
      .reduce((sum, a) => sum + a.anticipo.costoRecaudo, 0n);
    const costosBancarios = costosPagos + costoRecaudoAnticipo + costoComisionInternaLM;

    const { saldoLMInterno } = calcularSaldoLMInterno({
      totalAnticipo: actual.totalAnticipo,
      totalPagos: actual.totalPagos,
      comisionInternaLM: input.comisionInternaLM,
      ivaComision: actual.ivaComision,
      costosBancarios,
      tasa4x1000: params.tasa4x1000,
    });

    await tx.borradorFactura.update({
      where: { id: borradorId },
      data: {
        comisionInternaLM: input.comisionInternaLM,
        tipoRecaudoComisionInternaLM: input.tipoRecaudoComisionInternaLM,
        canalPagoComisionInternaLM: input.canalPagoComisionInternaLM,
        costoComisionInternaLM,
        saldoLMInterno,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion: "UPDATE_COMISION_INTERNA_LM",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable({
          comisionInternaLM: actual.comisionInternaLM,
          tipoRecaudoComisionInternaLM: actual.tipoRecaudoComisionInternaLM,
          canalPagoComisionInternaLM: actual.canalPagoComisionInternaLM,
          costoComisionInternaLM: actual.costoComisionInternaLM,
          saldoLMInterno: actual.saldoLMInterno,
        }),
        despues: normalizeSerializable({
          comisionInternaLM: input.comisionInternaLM,
          tipoRecaudoComisionInternaLM: input.tipoRecaudoComisionInternaLM,
          canalPagoComisionInternaLM: input.canalPagoComisionInternaLM,
          costoComisionInternaLM,
          saldoLMInterno,
        }),
      },
    });

    return { ok: true as const };
  });

  if (!result.ok) return result;

  const borrador = await getBorradorCompleto(borradorId);
  return { ok: true as const, borrador };
}

/**
 * Lista todos los borradores de un trámite, ordenados del más reciente al más antiguo.
 */
export async function listarBorradores(tramiteId: string) {
  return prisma.borradorFactura.findMany({
    where: { tramiteId },
    include: {
      lineasRevision: {
        orderBy: { orden: "asc" },
        include: { facturas: { include: { factura: true } } },
      },
      factura: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Asegura que un trámite en estado ENVIADO_A_FACTURAR tenga al menos un
 * borrador de factura. Idempotente: no hace nada si ya existe uno o si el
 * trámite no cumple las condiciones (estado previo o posterior, etc.).
 * Sirve como red de seguridad para trámites que pasaron a ENVIADO_A_FACTURAR
 * sin haber generado borrador todavía — aplica a PROPIO y SOCIO_LM por igual.
 */
export async function ensureBorrador(
  tramiteId: string,
  usuarioId: string,
): Promise<void> {
  const existente = await prisma.borradorFactura.findFirst({
    where: { tramiteId },
    select: { id: true },
  });
  if (existente) return;

  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: { estado: true },
  });
  if (!tramite) return;
  // Solo creamos borrador en ENVIADO_A_FACTURAR. Para estados posteriores
  // (FACTURADO/PAGADO/CERRADO) el borrador ya debió crearse en su momento.
  if (tramite.estado !== "ENVIADO_A_FACTURAR") return;

  try {
    await generarBorrador({ tramiteId, usuarioId });
  } catch {
    // Falla silenciosa: si el motor o la BD rechazan, la UI seguirá mostrando
    // el estado "sin borrador" y el ADMIN podrá generarlo manualmente.
  }
}

/**
 * Obtiene un borrador por ID.
 */
export async function getBorrador(borradorId: string) {
  return getBorradorCompleto(borradorId);
}
