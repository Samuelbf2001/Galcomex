import { OrigenImpuestoProducto, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  getProductos,
  getToken,
  SiigoApiError,
  SiigoConfigError,
  type SiigoProductoRaw,
} from "@/lib/siigo/client";
import {
  planImpuestosProducto,
  type FilaProductoImpuesto,
} from "@/lib/siigo/impuestos-producto";

export type SyncResult =
  | { ok: true; total: number; impuestosVinculados: number; impuestosRetirados: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

/**
 * Sincroniza `siigo_producto` **y** `siigo_producto_impuesto` desde
 * `GET /v1/products`.
 *
 * Los impuestos que trae cada producto (`taxes`) se guardan con
 * `origen = SIIGO`; las filas que alguien asoció a mano desde la UI quedan
 * `MANUAL` y este sync no las toca nunca (ver docs/CATALOGOS.md §2).
 */
export async function sincronizarProductosSiigo(usuarioId: string): Promise<SyncResult> {
  try {
    const token = await getToken();
    const productos = await getProductos(token);

    const antesCount = await prisma.siigoProducto.count();

    await prisma.$transaction(
      productos.map((p) =>
        prisma.siigoProducto.upsert({
          where: { id: p.id },
          update: {
            codigo: p.code,
            nombre: p.name,
            tipo: p.type,
            activo: p.active,
            grupoContableId: p.account_group.id,
            grupoContableNombre: p.account_group.name,
            clasificacionIva: p.tax_classification,
          },
          create: {
            id: p.id,
            codigo: p.code,
            nombre: p.name,
            tipo: p.type,
            activo: p.active,
            grupoContableId: p.account_group.id,
            grupoContableNombre: p.account_group.name,
            clasificacionIva: p.tax_classification,
          },
        }),
      ),
    );

    const impuestos = await sincronizarImpuestosDeProductos(productos);

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoProducto",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: productos.length,
          impuestosVinculados: impuestos.vinculados,
          impuestosRetirados: impuestos.retirados,
          impuestosManualesConservados: impuestos.manualesConservados,
          sincronizadoEn: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    return {
      ok: true,
      total: productos.length,
      impuestosVinculados: impuestos.vinculados,
      impuestosRetirados: impuestos.retirados,
    };
  } catch (error) {
    if (error instanceof SiigoConfigError) {
      return { ok: false, error: error.message, tipo: "config" };
    }
    if (error instanceof SiigoApiError) {
      return { ok: false, error: error.message, tipo: "api" };
    }
    throw error;
  }
}

interface ResumenImpuestos {
  vinculados: number;
  retirados: number;
  manualesConservados: number;
}

async function sincronizarImpuestosDeProductos(
  productos: readonly SiigoProductoRaw[],
): Promise<ResumenImpuestos> {
  const conTaxes = productos.filter((p) => (p.taxes?.length ?? 0) > 0);
  const resumen: ResumenImpuestos = { vinculados: 0, retirados: 0, manualesConservados: 0 };

  // El pivot tiene FK a `siigo_impuesto`: los impuestos que aún no estén en el
  // catálogo local se crean desde el payload del producto (mismos campos que
  // /v1/taxes). Si ya existen no se tocan: manda el sync de impuestos.
  const impuestosVistos = new Map<number, { nombre: string; tipo: string; porcentaje: string }>();
  for (const producto of conTaxes) {
    for (const tax of producto.taxes ?? []) {
      if (!impuestosVistos.has(tax.id)) {
        impuestosVistos.set(tax.id, {
          nombre: tax.name,
          tipo: tax.type,
          porcentaje: tax.percentage.toString(),
        });
      }
    }
  }

  if (impuestosVistos.size > 0) {
    await prisma.$transaction(
      [...impuestosVistos.entries()].map(([id, datos]) =>
        prisma.siigoImpuesto.upsert({
          where: { id },
          update: {},
          create: { id, nombre: datos.nombre, tipo: datos.tipo, porcentaje: datos.porcentaje },
        }),
      ),
    );
  }

  // Un producto que dejó de traer `taxes` no pierde sus filas SIIGO: Siigo
  // omite el bloque en algunas respuestas y borrarlas sería perder datos. Solo
  // se reconcilian los productos que SÍ vinieron con `taxes`.
  const existentes = await prisma.siigoProductoImpuesto.findMany({
    where: { productoId: { in: conTaxes.map((p) => p.id) } },
    select: { productoId: true, impuestoId: true, origen: true },
  });

  const porProducto = new Map<string, FilaProductoImpuesto[]>();
  for (const fila of existentes) {
    const lista = porProducto.get(fila.productoId) ?? [];
    lista.push({ impuestoId: fila.impuestoId, origen: fila.origen });
    porProducto.set(fila.productoId, lista);
  }

  const operaciones: Prisma.PrismaPromise<unknown>[] = [];
  for (const producto of conTaxes) {
    const plan = planImpuestosProducto(producto.taxes ?? [], porProducto.get(producto.id) ?? []);
    resumen.vinculados += plan.crear.length;
    resumen.retirados += plan.borrar.length;
    resumen.manualesConservados += plan.conservarManual.length;

    if (plan.crear.length > 0) {
      operaciones.push(
        prisma.siigoProductoImpuesto.createMany({
          data: plan.crear.map((impuestoId) => ({
            productoId: producto.id,
            impuestoId,
            origen: OrigenImpuestoProducto.SIIGO,
          })),
          skipDuplicates: true,
        }),
      );
    }
    if (plan.borrar.length > 0) {
      operaciones.push(
        prisma.siigoProductoImpuesto.deleteMany({
          where: {
            productoId: producto.id,
            impuestoId: { in: plan.borrar },
            origen: OrigenImpuestoProducto.SIIGO,
          },
        }),
      );
    }
  }

  if (operaciones.length > 0) await prisma.$transaction(operaciones);

  return resumen;
}
