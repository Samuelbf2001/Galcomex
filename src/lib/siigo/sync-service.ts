import { prisma } from "@/lib/db/prisma";
import {
  getProductos,
  getToken,
  SiigoApiError,
  SiigoConfigError,
} from "@/lib/siigo/client";

export type SyncResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

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

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoProducto",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: productos.length,
          sincronizadoEn: new Date().toISOString(),
        },
      },
    });

    return { ok: true, total: productos.length };
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
