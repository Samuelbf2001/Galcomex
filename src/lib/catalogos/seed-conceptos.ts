/**
 * Siembra del maestro de conceptos de venta a partir de las plantillas.
 *
 * Fuente única: `src/lib/tarifas/plantillas.ts` — `CONCEPTOS_VENTA_DEMO` (el
 * cruce concepto ↔ producto Siigo que Camila dictó en la reunión del 10-sep) y
 * los ítems de las propuestas 2026 (de donde sale el nombre que ve el cliente y
 * la forma de cálculo sugerida).
 *
 * Es IDEMPOTENTE: vuelve a correrse sin duplicar nada y sin pisar lo que un
 * ADMIN haya editado después (solo completa los campos que estén vacíos).
 * Además hace el backfill: enlaza los `tarifa_item` existentes cuyo `concepto`
 * coincida con el código de un concepto del maestro.
 */

import { Prisma, type TipoCalculoTarifa, type UnidadTarifa } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { CONCEPTOS_VENTA_DEMO, PLANTILLAS_TARIFARIO } from "@/lib/tarifas/plantillas";

export interface ConceptoSembrado {
  codigo: string;
  nombre: string;
  siigoCodigo: string | null;
  siigoProductoId: string | null;
  aplicaIva: boolean;
  tipoCalculoSugerido: TipoCalculoTarifa | null;
  unidadSugerida: UnidadTarifa | null;
  orden: number;
  notas: string | null;
  /** Qué haría/hizo la siembra con este concepto. */
  accion: "CREAR" | "COMPLETAR" | "SIN_CAMBIOS";
}

export interface ResultadoSeedConceptos {
  conceptos: ConceptoSembrado[];
  creados: number;
  completados: number;
  /** Conceptos cuyo producto Siigo no está sincronizado todavía. */
  sinProducto: string[];
  /** `tarifa_item` que quedaron (o quedarían) enlazados al maestro. */
  itemsEnlazados: number;
  dryRun: boolean;
}

/** Primer ítem de plantilla que usa el concepto: de ahí salen nombre y forma de cálculo. */
function itemDePlantilla(codigo: string) {
  for (const plantilla of PLANTILLAS_TARIFARIO) {
    const item = plantilla.items.find((i) => i.concepto === codigo);
    if (item) return item;
  }
  return null;
}

/** Lo que se sembraría, calculado sin tocar la BD salvo para resolver productos. */
export async function planSeedConceptos(): Promise<
  Omit<ConceptoSembrado, "accion">[]
> {
  const codigosSiigo = [...new Set(CONCEPTOS_VENTA_DEMO.map((c) => c.siigoCodigo))];
  const productos = await prisma.siigoProducto.findMany({
    where: { codigo: { in: codigosSiigo } },
    select: { id: true, codigo: true },
  });
  const productoPorCodigo = new Map(productos.map((p) => [p.codigo, p.id]));

  return CONCEPTOS_VENTA_DEMO.map((c, index) => {
    const item = itemDePlantilla(c.concepto);
    const notas = c.confirmar
      ? `Producto Siigo por confirmar con Camila: se llevó al más cercano (${c.siigoCodigo} ${c.nombreSiigo}).`
      : null;

    return {
      codigo: c.concepto,
      // El nombre de la propuesta comercial es el que el cliente reconoce; si
      // el concepto no está en ninguna plantilla, el del producto Siigo.
      nombre: item?.nombrePublico ?? c.nombreSiigo,
      siigoCodigo: c.siigoCodigo,
      siigoProductoId: productoPorCodigo.get(c.siigoCodigo) ?? null,
      aplicaIva: c.iva,
      tipoCalculoSugerido: item?.tipoCalculo ?? null,
      unidadSugerida: item?.unidad ?? null,
      orden: (index + 1) * 10,
      notas,
    };
  });
}

export async function sembrarConceptosVenta(
  opciones: { dryRun?: boolean; usuarioId?: string | null } = {},
): Promise<ResultadoSeedConceptos> {
  const dryRun = opciones.dryRun ?? false;
  const plan = await planSeedConceptos();

  const existentes = await prisma.conceptoVenta.findMany({
    where: { codigo: { in: plan.map((p) => p.codigo) } },
  });
  const porCodigo = new Map(existentes.map((e) => [e.codigo, e]));

  const conceptos: ConceptoSembrado[] = [];
  const operaciones: Prisma.PrismaPromise<unknown>[] = [];

  for (const p of plan) {
    const actual = porCodigo.get(p.codigo);

    if (!actual) {
      conceptos.push({ ...p, accion: "CREAR" });
      operaciones.push(
        prisma.conceptoVenta.create({
          data: {
            codigo: p.codigo,
            nombre: p.nombre,
            siigoProductoId: p.siigoProductoId,
            aplicaIva: p.aplicaIva,
            tipoCalculoSugerido: p.tipoCalculoSugerido,
            unidadSugerida: p.unidadSugerida,
            orden: p.orden,
            notas: p.notas,
          },
        }),
      );
      continue;
    }

    // Solo se completa lo que esté vacío: si un ADMIN cambió el nombre o el
    // producto desde la UI, la siembra no lo pisa.
    const data: Prisma.ConceptoVentaUpdateInput = {};
    if (actual.siigoProductoId === null && p.siigoProductoId !== null) {
      data.siigoProducto = { connect: { id: p.siigoProductoId } };
    }
    if (actual.tipoCalculoSugerido === null && p.tipoCalculoSugerido !== null) {
      data.tipoCalculoSugerido = p.tipoCalculoSugerido;
    }
    if (actual.unidadSugerida === null && p.unidadSugerida !== null) {
      data.unidadSugerida = p.unidadSugerida;
    }

    if (Object.keys(data).length === 0) {
      conceptos.push({ ...p, accion: "SIN_CAMBIOS" });
      continue;
    }
    conceptos.push({ ...p, accion: "COMPLETAR" });
    operaciones.push(prisma.conceptoVenta.update({ where: { codigo: p.codigo }, data }));
  }

  // Backfill: los ítems de tarifario que ya existen se enlazan por `concepto`.
  const itemsPorEnlazar = await prisma.tarifaItem.count({
    where: { conceptoId: null, concepto: { in: plan.map((p) => p.codigo) } },
  });

  if (!dryRun) {
    if (operaciones.length > 0) await prisma.$transaction(operaciones);

    // Se hace después de crear los conceptos para que todos los códigos existan.
    const creados = await prisma.conceptoVenta.findMany({
      where: { codigo: { in: plan.map((p) => p.codigo) } },
      select: { id: true, codigo: true },
    });
    await prisma.$transaction(
      creados.map((c) =>
        prisma.tarifaItem.updateMany({
          where: { conceptoId: null, concepto: c.codigo },
          data: { conceptoId: c.id },
        }),
      ),
    );

    if (opciones.usuarioId) {
      await prisma.auditLog.create({
        data: {
          entidad: "ConceptoVenta",
          entidadId: "catalog",
          accion: "SEED",
          usuarioId: opciones.usuarioId,
          despues: {
            creados: conceptos.filter((c) => c.accion === "CREAR").map((c) => c.codigo),
            completados: conceptos.filter((c) => c.accion === "COMPLETAR").map((c) => c.codigo),
            itemsEnlazados: itemsPorEnlazar,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  return {
    conceptos,
    creados: conceptos.filter((c) => c.accion === "CREAR").length,
    completados: conceptos.filter((c) => c.accion === "COMPLETAR").length,
    sinProducto: plan.filter((p) => p.siigoProductoId === null).map((p) => p.codigo),
    itemsEnlazados: itemsPorEnlazar,
    dryRun,
  };
}
