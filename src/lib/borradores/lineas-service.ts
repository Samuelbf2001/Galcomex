/**
 * Servicio de líneas manuales del borrador de factura — Galcomex
 * Las líneas (AUTO de pagos + fijas 4x1000/costos bancarios + manuales) son la
 * fuente de verdad para el total y los saldos del borrador, tanto para
 * trámites PROPIO como SOCIO_LM (los gates por tipo de cliente quedan en
 * permisos, no en la matemática).
 *
 * Patrón: $transaction + pg_advisory_xact_lock por borrador + AuditLog.
 */

import { EstadoBorrador, Prisma, SeccionLinea } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

import { recalcularTotalBorrador } from "./recalculo";
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

/**
 * Se lanza cuando un mismo `LineaRevision` intenta vincular facturas de
 * proveedor con beneficiarios (o NITs) distintos. Cada línea TERCEROS debe
 * mapear a un único "Id. Tercero" en Siigo; si necesitas dos terceros, abre
 * dos líneas separadas.
 */
export class FacturasDeBeneficiariosDistintosError extends Error {
  public readonly status = 422;
  constructor() {
    super(
      "Una línea solo puede vincular facturas del mismo proveedor/beneficiario. Crea una línea aparte para cada tercero.",
    );
    this.name = "FacturasDeBeneficiariosDistintosError";
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

/**
 * Deriva el N° de soporte a partir de las facturas de proveedor vinculadas,
 * respetando el orden en que el usuario las seleccionó. Para la subsección
 * TERCEROS el soporte SIEMPRE proviene de la(s) factura(s) asociadas, nunca
 * se captura a mano. Devuelve null si no hay facturas con número válido.
 */
async function soporteDesdeFacturas(
  tx: Tx,
  facturaIds: string[],
): Promise<string | null> {
  if (facturaIds.length === 0) return null;
  const facturas = await tx.facturaProveedor.findMany({
    where: { id: { in: facturaIds } },
    select: { id: true, numFactura: true },
  });
  const porId = new Map(facturas.map((f) => [f.id, f.numFactura]));
  const numeros = facturaIds
    .map((id) => porId.get(id))
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  return numeros.length > 0 ? numeros.join(" / ") : null;
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

/**
 * Valida que todas las facturas vinculadas a una línea apunten al mismo
 * tercero (beneficiarioId si está presente; en su defecto el NIT del
 * proveedor). Una línea con facturas de proveedores distintos no se puede
 * mapear unívocamente a un `customer.identification` en Siigo.
 *
 * Permite que una factura sin `beneficiarioId` y sin `proveedorNit` pase
 * (queda como clave "sin nit") — la validación de envío exige que el revisor
 * complete el NIT en otra capa.
 */
async function validarFacturasMismoBeneficiario(
  tx: Tx,
  facturaIds: string[],
): Promise<void> {
  if (facturaIds.length < 2) return;
  const facturas = await tx.facturaProveedor.findMany({
    where: { id: { in: facturaIds } },
    select: { id: true, beneficiarioId: true, proveedorNit: true },
  });
  const claves = new Set(
    facturas.map((f) =>
      f.beneficiarioId
        ? `b:${f.beneficiarioId}`
        : `n:${(f.proveedorNit ?? "").trim().toLowerCase()}`,
    ),
  );
  if (claves.size > 1) {
    throw new FacturasDeBeneficiariosDistintosError();
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

type CrearLineaInput = {
  borradorId: string;
  concepto: string;
  numSoporte?: string | null;
  valor: bigint;
  observacion?: string | null;
  seccion?: SeccionLinea;
  facturaIds?: string[];
  siigoProductoId?: string | null;
  /** NIT del tercero a usar cuando la línea no vincula factura. */
  nitTercero?: string | null;
  usuarioId: string;
};

export async function crearLineaManual(input: CrearLineaInput) {
  const { borradorId, concepto, numSoporte, valor, observacion, usuarioId, siigoProductoId, nitTercero } = input;
  const facturaIds = input.facturaIds ?? [];
  const seccion = input.seccion ?? SeccionLinea.TERCEROS;
  const lockKey = `borrador_lineas:${borradorId}`;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const borrador = await cargarBorradorEditable(tx, borradorId);
    await validarFacturasDelTramite(tx, borrador.tramiteId, facturaIds);
    await validarFacturasMismoBeneficiario(tx, facturaIds);

    const ultima = await tx.lineaRevision.findFirst({
      where: { borradorId },
      orderBy: { orden: "desc" },
      select: { orden: true },
    });
    const orden = (ultima?.orden ?? 0) + 1;

    // En TERCEROS el soporte se deriva del número de factura vinculada.
    const numSoporteFinal =
      seccion === SeccionLinea.TERCEROS
        ? await soporteDesdeFacturas(tx, facturaIds)
        : (numSoporte ?? null);

    const linea = await tx.lineaRevision.create({
      data: {
        borradorId,
        concepto,
        numSoporte: numSoporteFinal ?? undefined,
        valor,
        observacion: observacion ?? undefined,
        orden,
        origen: "MANUAL",
        seccion,
        siigoProductoId: siigoProductoId ?? undefined,
        nitTercero: nitTercero ?? undefined,
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
  seccion?: SeccionLinea;
  facturaIds?: string[];
  siigoProductoId?: string | null;
  /** NIT del tercero (null limpia el campo). */
  nitTercero?: string | null;
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
      await validarFacturasMismoBeneficiario(tx, input.facturaIds);
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
    if (input.seccion !== undefined) data.seccion = input.seccion;
    if (input.siigoProductoId !== undefined) {
      data.siigoProducto =
        input.siigoProductoId === null
          ? { disconnect: true }
          : { connect: { id: input.siigoProductoId } };
    }
    if (input.nitTercero !== undefined) data.nitTercero = input.nitTercero;

    // En TERCEROS el soporte se mantiene sincronizado con las facturas vinculadas,
    // recalculándolo cuando cambian las facturas o la sección de la línea.
    const seccionEfectiva = input.seccion ?? antes?.seccion ?? SeccionLinea.TERCEROS;
    if (
      seccionEfectiva === SeccionLinea.TERCEROS &&
      (input.facturaIds !== undefined || input.seccion !== undefined)
    ) {
      const facturasEfectivas =
        input.facturaIds ?? antes?.facturas.map((f) => f.facturaId) ?? [];
      data.numSoporte = await soporteDesdeFacturas(tx, facturasEfectivas);
    }

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
