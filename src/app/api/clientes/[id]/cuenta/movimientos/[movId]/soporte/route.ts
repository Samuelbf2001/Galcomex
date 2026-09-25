import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { createPresignedDownloadUrl } from "@/lib/storage/service";

type RouteContext = {
  params: Promise<{ id: string; movId: string }>;
};

/**
 * Descarga del PDF de soporte de un movimiento manual de la cuenta corriente
 * ("Ver PDF" junto a "Factura 1234 · Quincenas septiembre"). ADMIN y REVISOR
 * (los mismos roles que ven la cuenta corriente, ver `GET …/cuenta`).
 * Redirige a la URL prefirmada de descarga (vence en minutos).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id, movId } = await context.params;

  const movimiento = await prisma.movimientoCuenta.findFirst({
    where: { id: movId, empresaId: id },
    select: { soporteKey: true },
  });

  if (!movimiento || !movimiento.soporteKey) {
    return NextResponse.json({ error: "Este movimiento no tiene un soporte adjunto" }, { status: 404 });
  }

  const { url } = await createPresignedDownloadUrl({ storageKey: movimiento.soporteKey });

  return NextResponse.redirect(url);
}
