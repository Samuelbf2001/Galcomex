import { prisma } from "@/lib/db/prisma";
import {
  getTaxes,
  getToken,
  SiigoApiError,
  SiigoConfigError,
} from "@/lib/siigo/client";

export type SyncImpuestosResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

export async function sincronizarImpuestosSiigo(
  usuarioId: string,
): Promise<SyncImpuestosResult> {
  try {
    const token = await getToken();
    const impuestos = await getTaxes(token);

    const antesCount = await prisma.siigoImpuesto.count();

    await prisma.$transaction(
      impuestos.map((i) =>
        prisma.siigoImpuesto.upsert({
          where: { id: i.id },
          update: {
            nombre: i.name,
            tipo: i.type,
            porcentaje: i.percentage.toString(),
            activo: i.active ?? true,
          },
          create: {
            id: i.id,
            nombre: i.name,
            tipo: i.type,
            porcentaje: i.percentage.toString(),
            activo: i.active ?? true,
          },
        }),
      ),
    );

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoImpuesto",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: impuestos.length,
          sincronizadoEn: new Date().toISOString(),
        },
      },
    });

    return { ok: true, total: impuestos.length };
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
