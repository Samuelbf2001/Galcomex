/**
 * Servicio de borradores de factura — Galcomex
 * A1-T8: Motor de cálculo integrado con BD + ciclo de vida del borrador + cartera
 *
 * Implementa:
 * - generarBorrador: arma el DTO desde BD, llama al motor puro, persiste BorradorFactura
 * - transicionarBorrador: BORRADOR→EN_REVISION→APROBADO→FACTURADO con validaciones
 * - listarBorradores: lista borradores de un trámite
 */

import { EstadoBorrador, Prisma } from "@prisma/client";

import { calcularBorrador } from "@/lib/calculations/motor-factura";
import { prisma } from "@/lib/db/prisma";
import { getParametrosSistema } from "@/lib/parametros/service";

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

async function getBorradorCompleto(borradorId: string) {
  return prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    include: {
      lineasRevision: { orderBy: { orden: "asc" } },
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
    select: { estado: true },
  });
  if (!tramiteEstado) {
    throw new TramiteNoFacturableError("no encontrado");
  }
  if (!(ESTADOS_FACTURABLES as readonly string[]).includes(tramiteEstado.estado)) {
    throw new TramiteNoFacturableError(tramiteEstado.estado);
  }

  // ── Leer datos del trámite en paralelo ────────────────────────────────────
  const [aplicaciones, pagos, params] = await Promise.all([
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

  // ── Persistir en transacción ──────────────────────────────────────────────
  return prisma.$transaction(async (tx) => {
    const borrador = await tx.borradorFactura.create({
      data: {
        tramiteId,
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
        retenciones: resultado.retenciones,
        conceptosOperacionales: conceptosOperacionales
          ? normalizeSerializable(conceptosOperacionales)
          : undefined,
        estado: EstadoBorrador.BORRADOR,
        lineasRevision: {
          create: pagos.map((p, idx) => ({
            concepto: p.concepto,
            numSoporte: p.numSoporte ?? undefined,
            valor: p.valor,
            orden: idx + 1,
          })),
        },
      },
      include: { lineasRevision: { orderBy: { orden: "asc" } } },
    });

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

    return borrador;
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
        lineasRevision: { orderBy: { orden: "asc" } },
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
          lineasRevision: { orderBy: { orden: "asc" } },
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
 * Lista todos los borradores de un trámite, ordenados del más reciente al más antiguo.
 */
export async function listarBorradores(tramiteId: string) {
  return prisma.borradorFactura.findMany({
    where: { tramiteId },
    include: {
      lineasRevision: { orderBy: { orden: "asc" } },
      factura: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Obtiene un borrador por ID.
 */
export async function getBorrador(borradorId: string) {
  return getBorradorCompleto(borradorId);
}
