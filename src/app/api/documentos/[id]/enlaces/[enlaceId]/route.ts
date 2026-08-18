/**
 * DELETE /api/documentos/[id]/enlaces/[enlaceId] — revoca un enlace compartido.
 *
 * Revocar no borra el registro: lo marca. Así queda el rastro de que ese enlace
 * existió, cuántas veces se abrió y quién decidió cortarlo — que es justamente
 * la información que se necesita si alguna vez hay que responder por dónde
 * salió un documento.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { evaluarEstadoEnlace } from "@/lib/documentos/enlaces";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string; enlaceId: string }> };

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id, enlaceId } = await context.params;

  const enlace = await prisma.enlaceDocumento.findUnique({
    where: { id: enlaceId },
    select: { id: true, documentoId: true, expiresAt: true, revocadoEn: true },
  });

  if (!enlace || enlace.documentoId !== id) {
    return NextResponse.json({ error: "Enlace no encontrado" }, { status: 404 });
  }

  if (enlace.revocadoEn !== null) {
    // Revocar dos veces no es un error: el enlace ya está cortado, que es lo
    // que el usuario quería.
    return jsonResponse({ enlace: { ...enlace, estado: "REVOCADO" as const } });
  }

  const actualizado = await prisma.enlaceDocumento.update({
    where: { id: enlaceId },
    data: { revocadoEn: new Date() },
    select: { id: true, expiresAt: true, revocadoEn: true, aperturas: true },
  });

  await prisma.auditLog.create({
    data: {
      entidad: "EnlaceDocumento",
      entidadId: enlaceId,
      accion: "REVOCAR",
      usuarioId: session.user.id,
      antes: { revocadoEn: null },
      despues: {
        revocadoEn: actualizado.revocadoEn?.toISOString() ?? null,
        aperturas: actualizado.aperturas,
      },
    },
  });

  return jsonResponse({
    enlace: { ...actualizado, estado: evaluarEstadoEnlace(actualizado) },
  });
}
