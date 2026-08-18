/**
 * Enlaces compartibles de un documento (G4 — reunión 1-jul, min 01:29).
 *
 * GET  → lista los enlaces del documento con su estado (vigente/expirado/revocado)
 * POST → crea uno nuevo con vigencia acotada
 *
 * Quien comparte deja rastro: cada enlace guarda quién lo creó, cuándo caduca y
 * cuántas veces se abrió.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError, z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import {
  ENLACE_VIGENCIA_DIAS_MAX,
  calcularExpiracion,
  evaluarEstadoEnlace,
  generarTokenEnlace,
  normalizarVigenciaDias,
} from "@/lib/documentos/enlaces";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = { params: Promise<{ id: string }> };

const crearEnlaceSchema = z.object({
  vigenciaDias: z.number().int().positive().max(ENLACE_VIGENCIA_DIAS_MAX).optional(),
});

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  const enlaces = await prisma.enlaceDocumento.findMany({
    where: { documentoId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      token: true,
      expiresAt: true,
      revocadoEn: true,
      aperturas: true,
      createdAt: true,
      creadoPor: { select: { id: true, name: true } },
    },
  });

  return jsonResponse({
    enlaces: enlaces.map((enlace) => ({
      ...enlace,
      estado: evaluarEstadoEnlace(enlace),
    })),
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  let payload: z.infer<typeof crearEnlaceSchema>;
  try {
    const body: unknown = await request.json().catch(() => ({}));
    payload = crearEnlaceSchema.parse(body ?? {});
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const documento = await prisma.documento.findUnique({
    where: { id },
    select: { id: true, eliminado: true, nombreArchivo: true },
  });

  if (!documento || documento.eliminado) {
    return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  }

  const vigenciaDias = normalizarVigenciaDias(payload.vigenciaDias);

  const enlace = await prisma.enlaceDocumento.create({
    data: {
      documentoId: id,
      token: generarTokenEnlace(),
      expiresAt: calcularExpiracion(vigenciaDias),
      creadoPorId: session.user.id,
    },
    select: {
      id: true,
      token: true,
      expiresAt: true,
      revocadoEn: true,
      aperturas: true,
      createdAt: true,
    },
  });

  await prisma.auditLog.create({
    data: {
      entidad: "EnlaceDocumento",
      entidadId: enlace.id,
      accion: "CREATE",
      usuarioId: session.user.id,
      despues: {
        documentoId: id,
        nombreArchivo: documento.nombreArchivo,
        expiresAt: enlace.expiresAt.toISOString(),
        vigenciaDias,
      },
    },
  });

  return jsonResponse(
    {
      enlace: { ...enlace, estado: evaluarEstadoEnlace(enlace) },
      // Ruta relativa: quien la consuma la compone con su propio dominio.
      ruta: `/compartir/${enlace.token}`,
    },
    { status: 201 },
  );
}
