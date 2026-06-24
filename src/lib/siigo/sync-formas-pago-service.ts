import { prisma } from "@/lib/db/prisma";
import {
  getPaymentTypes,
  getToken,
  SiigoApiError,
  SiigoConfigError,
} from "@/lib/siigo/client";

export type SyncFormasPagoResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: "config" | "api" | "db" };

export async function sincronizarFormasPagoSiigo(
  usuarioId: string,
): Promise<SyncFormasPagoResult> {
  try {
    const token = await getToken();
    const formasPago = await getPaymentTypes(token);

    const antesCount = await prisma.siigoFormaPago.count();

    await prisma.$transaction(
      formasPago.map((fp) =>
        prisma.siigoFormaPago.upsert({
          where: { id: fp.id },
          update: {
            nombre: fp.name,
            tipo: fp.type ?? null,
            activo: fp.active ?? true,
          },
          create: {
            id: fp.id,
            nombre: fp.name,
            tipo: fp.type ?? null,
            activo: fp.active ?? true,
          },
        }),
      ),
    );

    await prisma.auditLog.create({
      data: {
        entidad: "SiigoFormaPago",
        entidadId: "catalog",
        accion: "SYNC",
        usuarioId,
        antes: { totalAntes: antesCount },
        despues: {
          totalDespues: formasPago.length,
          sincronizadoEn: new Date().toISOString(),
        },
      },
    });

    return { ok: true, total: formasPago.length };
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
