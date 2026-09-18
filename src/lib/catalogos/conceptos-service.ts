/**
 * Maestro de conceptos de venta (Configuración → Catálogos) — capa de BD.
 *
 * Es la única lista de "lo que Galcomex vende". Los ítems del tarifario la
 * referencian con `TarifaItem.conceptoId` y de ahí salen el producto Siigo por
 * defecto, el IVA por defecto y —sobre todo— el nombre que ve el cliente en la
 * factura (ver `nombre-linea.ts` y docs/CATALOGOS.md).
 *
 * Los conceptos NUNCA se borran: hay tarifarios apuntando y facturas emitidas
 * con ese nombre. Se dan de baja con `activo = false`.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ConceptoParaLinea } from "@/lib/catalogos/nombre-linea";
import type {
  ConceptoVentaActualizarPayload,
  ConceptoVentaCrearPayload,
} from "@/lib/validations/catalogos";

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class ConceptoVentaNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`El concepto ${id} no existe`);
    this.name = "ConceptoVentaNoEncontradoError";
  }
}

export class ConceptoVentaDuplicadoError extends Error {
  public readonly status = 409;
  constructor(codigo: string) {
    super(`Ya existe un concepto con el código ${codigo}`);
    this.name = "ConceptoVentaDuplicadoError";
  }
}

export class SiigoProductoNoEncontradoError extends Error {
  public readonly status = 422;
  constructor(id: string) {
    super(
      `El producto Siigo ${id} no está en el catálogo local. Sincroniza los productos en Configuración → Siigo.`,
    );
    this.name = "SiigoProductoNoEncontradoError";
  }
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface ConceptoVentaDto {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  aplicaIva: boolean;
  tipoCalculoSugerido: string | null;
  unidadSugerida: string | null;
  orden: number;
  activo: boolean;
  notas: string | null;
  siigoProducto: { id: string; codigo: string; nombre: string } | null;
  /** Cuántos ítems de tarifario lo usan hoy (para avisar antes de desactivarlo). */
  itemsEnlazados: number;
}

const INCLUDE_CONCEPTO = {
  siigoProducto: { select: { id: true, codigo: true, nombre: true } },
  _count: { select: { items: true } },
} satisfies Prisma.ConceptoVentaInclude;

type ConceptoConRelaciones = Prisma.ConceptoVentaGetPayload<{ include: typeof INCLUDE_CONCEPTO }>;

function aDto(c: ConceptoConRelaciones): ConceptoVentaDto {
  return {
    id: c.id,
    codigo: c.codigo,
    nombre: c.nombre,
    descripcion: c.descripcion,
    aplicaIva: c.aplicaIva,
    tipoCalculoSugerido: c.tipoCalculoSugerido,
    unidadSugerida: c.unidadSugerida,
    orden: c.orden,
    activo: c.activo,
    notas: c.notas,
    siigoProducto: c.siigoProducto,
    itemsEnlazados: c._count.items,
  };
}

/** Snapshot para el AuditLog: solo los campos propios, sin relaciones. */
function snapshot(c: ConceptoConRelaciones): Prisma.InputJsonValue {
  return {
    codigo: c.codigo,
    nombre: c.nombre,
    descripcion: c.descripcion,
    siigoProductoId: c.siigoProductoId,
    aplicaIva: c.aplicaIva,
    tipoCalculoSugerido: c.tipoCalculoSugerido,
    unidadSugerida: c.unidadSugerida,
    orden: c.orden,
    activo: c.activo,
    notas: c.notas,
  };
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

export async function listarConceptosVenta(
  opciones: { soloActivos?: boolean } = {},
): Promise<ConceptoVentaDto[]> {
  const conceptos = await prisma.conceptoVenta.findMany({
    where: opciones.soloActivos ? { activo: true } : undefined,
    include: INCLUDE_CONCEPTO,
    orderBy: [{ activo: "desc" }, { orden: "asc" }, { codigo: "asc" }],
  });
  return conceptos.map(aDto);
}

/**
 * Conceptos por código, listos para `resolverLineaConcepto`. Se usa al generar
 * el borrador: una sola consulta para todas las líneas del tarifario.
 */
export async function conceptosParaLineas(
  codigos: readonly string[],
): Promise<Map<string, ConceptoParaLinea>> {
  const unicos = [...new Set(codigos.filter((c) => c.length > 0))];
  if (unicos.length === 0) return new Map();

  const conceptos = await prisma.conceptoVenta.findMany({
    where: { codigo: { in: unicos } },
    select: {
      codigo: true,
      nombre: true,
      aplicaIva: true,
      siigoProducto: { select: { id: true, codigo: true, nombre: true } },
    },
  });

  return new Map(
    conceptos.map((c) => [
      c.codigo,
      {
        codigo: c.codigo,
        nombre: c.nombre,
        aplicaIva: c.aplicaIva,
        siigoProducto: c.siigoProducto,
      },
    ]),
  );
}

// ─── Escritura ────────────────────────────────────────────────────────────────

async function assertProductoExiste(siigoProductoId: string | null | undefined): Promise<void> {
  if (!siigoProductoId) return;
  const producto = await prisma.siigoProducto.findUnique({
    where: { id: siigoProductoId },
    select: { id: true },
  });
  if (!producto) throw new SiigoProductoNoEncontradoError(siigoProductoId);
}

export async function crearConceptoVenta(
  payload: ConceptoVentaCrearPayload,
  usuarioId: string,
): Promise<ConceptoVentaDto> {
  await assertProductoExiste(payload.siigoProductoId);

  const yaExiste = await prisma.conceptoVenta.findUnique({
    where: { codigo: payload.codigo },
    select: { id: true },
  });
  if (yaExiste) throw new ConceptoVentaDuplicadoError(payload.codigo);

  const creado = await prisma.$transaction(async (tx) => {
    const concepto = await tx.conceptoVenta.create({
      data: {
        codigo: payload.codigo,
        nombre: payload.nombre,
        descripcion: payload.descripcion ?? null,
        siigoProductoId: payload.siigoProductoId ?? null,
        aplicaIva: payload.aplicaIva,
        tipoCalculoSugerido: payload.tipoCalculoSugerido ?? null,
        unidadSugerida: payload.unidadSugerida ?? null,
        orden: payload.orden,
        activo: payload.activo,
        notas: payload.notas ?? null,
      },
      include: INCLUDE_CONCEPTO,
    });

    await tx.auditLog.create({
      data: {
        entidad: "ConceptoVenta",
        entidadId: concepto.id,
        accion: "CREATE",
        usuarioId,
        despues: snapshot(concepto),
      },
    });

    return concepto;
  });

  return aDto(creado);
}

export async function actualizarConceptoVenta(
  payload: ConceptoVentaActualizarPayload,
  usuarioId: string,
): Promise<ConceptoVentaDto> {
  const antes = await prisma.conceptoVenta.findUnique({
    where: { id: payload.id },
    include: INCLUDE_CONCEPTO,
  });
  if (!antes) throw new ConceptoVentaNoEncontradoError(payload.id);

  await assertProductoExiste(payload.siigoProductoId);

  // Solo se escriben las claves presentes: un PATCH no puede borrar sin querer
  // el producto o el IVA de un concepto que el usuario no tocó.
  const data: Prisma.ConceptoVentaUpdateInput = {};
  if (payload.nombre !== undefined) data.nombre = payload.nombre;
  if (payload.descripcion !== undefined) data.descripcion = payload.descripcion ?? null;
  if (payload.aplicaIva !== undefined) data.aplicaIva = payload.aplicaIva;
  if (payload.tipoCalculoSugerido !== undefined) {
    data.tipoCalculoSugerido = payload.tipoCalculoSugerido ?? null;
  }
  if (payload.unidadSugerida !== undefined) data.unidadSugerida = payload.unidadSugerida ?? null;
  if (payload.orden !== undefined) data.orden = payload.orden;
  if (payload.activo !== undefined) data.activo = payload.activo;
  if (payload.notas !== undefined) data.notas = payload.notas ?? null;
  if (payload.siigoProductoId !== undefined) {
    data.siigoProducto = payload.siigoProductoId
      ? { connect: { id: payload.siigoProductoId } }
      : { disconnect: true };
  }

  const actualizado = await prisma.$transaction(async (tx) => {
    const despues = await tx.conceptoVenta.update({
      where: { id: payload.id },
      data,
      include: INCLUDE_CONCEPTO,
    });

    await tx.auditLog.create({
      data: {
        entidad: "ConceptoVenta",
        entidadId: despues.id,
        accion: "UPDATE",
        usuarioId,
        antes: snapshot(antes),
        despues: snapshot(despues),
      },
    });

    return despues;
  });

  return aDto(actualizado);
}
