import { prisma } from "@/lib/db/prisma";
import {
  getDocumentTypes,
  getToken,
  SiigoApiError,
  SiigoConfigError,
} from "@/lib/siigo/client";

export type SyncTiposComprobanteResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

export async function sincronizarTiposComprobanteSiigo(
  usuarioId: string,
): Promise<SyncTiposComprobanteResult> {
  try {
    const token = await getToken();
    const tipos = await getDocumentTypes(token);

    const antesCount = await prisma.siigoTipoComprobante.count();

    await prisma.$transaction(
      tipos.map((t) =>
        prisma.siigoTipoComprobante.upsert({
          where: { id: t.id },
          update: {
            code: t.code,
            nombre: t.name,
            tipo: t.type ?? null,
            activo: t.active ?? true,
          },
          create: {
            id: t.id,
            code: t.code,
            nombre: t.name,
            tipo: t.type ?? null,
            activo: t.active ?? true,
          },
        }),
      ),
    );

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoTipoComprobante",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: tipos.length,
          sincronizadoEn: new Date().toISOString(),
        },
      },
    });

    return { ok: true, total: tipos.length };
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
