/**
 * Servicio de líneas manuales del borrador de factura — Galcomex
 * Flujo del socio (Lucho): las líneas se escriben a mano y se vinculan N↔N a
 * facturas de proveedor. En trámites SOCIO_LM la suma de las líneas DEFINE el
 * total (se promueve a totalFactura + saldos); en PROPIO es solo referencia.
 *
 * Patrón: $transaction + pg_advisory_xact_lock por borrador + AuditLog.
 */

import { EstadoBorrador, Prisma, TipoCliente } from "@prisma/client";

import { calcularSaldosPorLineas } from "@/lib/calculations/total-lineas";
import { prisma } from "@/lib/db/prisma";

import { getBorrador } from "./service";

// ─── Errores tipados ──────────────────────────────────────────────────────────

export class BorradorNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Borrador ${id} no encontrado`);
    this.name = "BorradorNoEncontradoError";
  }
}

export class LineaNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Línea ${id} no encontrada`);
    this.name = "LineaNoEncontradaError";
  }
}

export class BorradorNoEditableError extends Error {
  public readonly status = 422;
  constructor(estado: EstadoBorrador) {
    super(
      `No se pueden editar líneas de un borrador en estado ${estado}. Solo BORRADOR o EN_REVISION.`,
    );
    this.name = "BorradorNoEditableError";
  }
}

export class FacturaDeOtroTramiteError extends Error {
  public readonly status = 422;
  constructor(facturaId: string) {
    super(`La factura de proveedor ${facturaId} no pertenece al trámite del borrador`);
    this.name = "FacturaDeOtroTramiteError";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

const ESTADOS_EDITABLES: EstadoBorrador[] = [
  EstadoBorrador.BORRADOR,
  EstadoBorrador.EN_REVISION,
];

type Tx = Prisma.TransactionClient;

/**
 * Recalcula totalFacturaLineas para un borrador y, si el cliente es SOCIO_LM,
 * promueve la suma de líneas a totalFactura + saldos derivados.
 * Debe ejecutarse dentro de una transacción que ya tomó el advisory lock.
 */
async function recalcularTotalBorrador(tx: Tx, borradorId: string): Promise<void> {
  const borrador = await tx.borradorFactura.findUnique({
    where: { id: borradorId },
    select: {
      comision: true,
      ivaComision: true,
      retenciones: true,
      totalAnticipo: true,
      saldoAFavorLM: true,
      lineasRevision: { select: { valor: true } },
      tramite: { select: { cliente: { select: { tipo: true } } } },
    },
  });

  if (!borrador) {
    throw new BorradorNoEncontradoError(borradorId);
  }

  const calc = calcularSaldosPorLineas({
    lineas: borrador.lineasRevision,
    comision: borrador.comision,
    ivaComision: borrador.ivaComision,
    retenciones: borrador.retenciones,
    totalAnticipo: borrador.totalAnticipo,
    montoLM: borrador.saldoAFavorLM,
  });

  const esSocioLM = borrador.tramite.cliente.tipo === TipoCliente.SOCIO_LM;

  await tx.borradorFactura.update({
    where: { id: borradorId },
    data: esSocioLM
      ? {
          totalFacturaLineas: calc.totalFacturaLineas,
          totalFactura: calc.totalFactura,
          saldoAFavorCliente: calc.saldoAFavorCliente,
          saldoACargoCliente: calc.saldoACargoCliente,
          saldoAFavorLM: calc.saldoAFavorLM,
          saldoACargoLM: calc.saldoACargoLM,
        }
      : { totalFacturaLineas: calc.totalFacturaLineas },
  });
}

/** Carga el borrador con estado + tramiteId y valida que sea editable. */
async function cargarBorradorEditable(tx: Tx, borradorId: string) {
  const borrador = await tx.borradorFactura.findUnique({
    where: { id: borradorId },
    select: { id: true, estado: true, tramiteId: true },
  });
  if (!borrador) {
    throw new BorradorNoEncontradoError(borradorId);
  }
  if (!ESTADOS_EDITABLES.includes(borrador.estado)) {
    throw new BorradorNoEditableError(borrador.estado);
  }
  return borrador;
}

/** Valida que cada facturaId pertenezca al trámite del borrador. */
async function validarFacturasDelTramite(
  tx: Tx,
  tramiteId: string,
  facturaIds: string[],
): Promise<void> {
  if (facturaIds.length === 0) return;
  const facturas = await tx.facturaProveedor.findMany({
    where: { id: { in: facturaIds } },
    select: { id: true, tramiteId: true },
  });
  const encontradas = new Map(facturas.map((f) => [f.id, f.tramiteId]));
  for (const fid of facturaIds) {
    if (encontradas.get(fid) !== tramiteId) {
      throw new FacturaDeOtroTramiteError(fid);
    }
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

type CrearLineaInput = {
  borradorId: string;
  concepto: string;
  numSoporte?: string | null;
  valor: bigint;
  observacion?: string | null;
  facturaIds?: string[];
  usuarioId: string;
};

export async function crearLineaManual(input: CrearLineaInput) {
  const { borradorId, concepto, numSoporte, valor, observacion, usuarioId } = input;
  const facturaIds = input.facturaIds ?? [];
  const lockKey = `borrador_lineas:${borradorId}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const borrador = await cargarBorradorEditable(tx, borradorId);
    await validarFacturasDelTramite(tx, borrador.tramiteId, facturaIds);

    const ultima = await tx.lineaRevision.findFirst({
      where: { borradorId },
      orderBy: { orden: "desc" },
      select: { orden: true },
    });
    const orden = (ultima?.orden ?? 0) + 1;

    const linea = await tx.lineaRevision.create({
      data: {
        borradorId,
        concepto,
        numSoporte: numSoporte ?? undefined,
        valor,
        observacion: observacion ?? undefined,
        orden,
        origen: "MANUAL",
        facturas: { create: facturaIds.map((facturaId) => ({ facturaId })) },
      },
    });

    await recalcularTotalBorrador(tx, borradorId);

    await tx.auditLog.create({
      data: {
        entidad: "LineaRevision",
        entidadId: linea.id,
        accion: "CREATE",
        usuarioId,
        tramiteId: borrador.tramiteId,
        despues: normalizeSerializable({ ...linea, facturaIds }),
      },
    });
  });

  return getBorrador(borradorId);
}

type ActualizarLineaInput = {
  lineaId: string;
  concepto?: string;
  numSoporte?: string | null;
  valor?: bigint;
  observacion?: string | null;
  facturaIds?: string[];
  usuarioId: string;
};

export async function actualizarLinea(input: ActualizarLineaInput) {
  const { lineaId, usuarioId } = input;

  const borradorId = await prisma.$transaction(async (tx) => {
    const linea = await tx.lineaRevision.findUnique({
      where: { id: lineaId },
      select: { id: true, borradorId: true },
    });
    if (!linea) {
      throw new LineaNoEncontradaError(lineaId);
    }

    const lockKey = `borrador_lineas:${linea.borradorId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const borrador = await cargarBorradorEditable(tx, linea.borradorId);

    const antes = await tx.lineaRevision.findUnique({
      where: { id: lineaId },
      include: { facturas: { select: { facturaId: true } } },
    });

    if (input.facturaIds !== undefined) {
      await validarFacturasDelTramite(tx, borrador.tramiteId, input.facturaIds);
      await tx.lineaRevisionFactura.deleteMany({ where: { lineaId } });
      await tx.lineaRevisionFactura.createMany({
        data: input.facturaIds.map((facturaId) => ({ lineaId, facturaId })),
      });
    }

    const data: Prisma.LineaRevisionUpdateInput = {};
    if (input.concepto !== undefined) data.concepto = input.concepto;
    if (input.numSoporte !== undefined) data.numSoporte = input.numSoporte;
    if (input.valor !== undefined) data.valor = input.valor;
    if (input.observacion !== undefined) data.observacion = input.observacion;

    const actualizada = await tx.lineaRevision.update({ where: { id: lineaId }, data });

    await recalcularTotalBorrador(tx, linea.borradorId);

    await tx.auditLog.create({
      data: {
        entidad: "LineaRevision",
        entidadId: lineaId,
        accion: "UPDATE",
        usuarioId,
        tramiteId: borrador.tramiteId,
        antes: normalizeSerializable(antes),
        despues: normalizeSerializable({ ...actualizada, facturaIds: input.facturaIds }),
      },
    });

    return linea.borradorId;
  });

  return getBorrador(borradorId);
}

export async function eliminarLinea(lineaId: string, usuarioId: string) {
  const borradorId = await prisma.$transaction(async (tx) => {
    const linea = await tx.lineaRevision.findUnique({
      where: { id: lineaId },
      include: { facturas: { select: { facturaId: true } } },
    });
    if (!linea) {
      throw new LineaNoEncontradaError(lineaId);
    }

    const lockKey = `borrador_lineas:${linea.borradorId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const borrador = await cargarBorradorEditable(tx, linea.borradorId);

    // El pivot se borra en cascada (onDelete: Cascade desde la línea).
    await tx.lineaRevision.delete({ where: { id: lineaId } });

    await recalcularTotalBorrador(tx, linea.borradorId);

    await tx.auditLog.create({
      data: {
        entidad: "LineaRevision",
        entidadId: lineaId,
        accion: "DELETE",
        usuarioId,
        tramiteId: borrador.tramiteId,
        antes: normalizeSerializable(linea),
      },
    });

    return linea.borradorId;
  });

  return getBorrador(borradorId);
}
