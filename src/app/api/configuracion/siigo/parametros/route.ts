/**
 * Endpoints de los 6 parámetros de configuración del envío a Siigo.
 *
 * Claves manejadas (whitelist estricto, todo lo demás se ignora):
 *   - SIIGO_TIPO_COMPROBANTE_ID
 *   - SIIGO_VENDEDOR_ID
 *   - SIIGO_PRODUCTO_COMISION_ID
 *   - SIIGO_FORMA_PAGO_DEFAULT_ID
 *   - SIIGO_PRODUCTO_4X1000_ID
 *   - SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID
 *   - SIIGO_BENEFICIARIO_BANCOLOMBIA_ID
 *
 * GET → devuelve los valores actuales (null si no están configurados).
 * PUT → upsert atómico (omitir una = no cambiarla).
 *
 * Roles: ADMIN (mutación) · ADMIN/REVISOR (lectura).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

const CLAVES_SIIGO = [
  "SIIGO_TIPO_COMPROBANTE_ID",
  "SIIGO_VENDEDOR_ID",
  "SIIGO_PRODUCTO_COMISION_ID",
  "SIIGO_FORMA_PAGO_DEFAULT_ID",
  "SIIGO_PRODUCTO_4X1000_ID",
  "SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID",
  "SIIGO_BENEFICIARIO_BANCOLOMBIA_ID",
] as const;

const putSchema = z.object({
  parametros: z
    .array(
      z.object({
        clave: z.enum(CLAVES_SIIGO),
        // Valor vacío = mantener el actual (no enviamos null para borrar — los
        // FKs en service.ts ya manejan ausencia con fallback).
        valor: z.string().trim().min(1, "El valor no puede estar vacío"),
      }),
    )
    .min(1),
});

export async function GET(_request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const rows = await prisma.parametro.findMany({
    where: { clave: { in: [...CLAVES_SIIGO] } },
    select: { clave: true, valor: true, descripcion: true, updatedAt: true },
  });

  const map = new Map(rows.map((r) => [r.clave, r]));
  const parametros = CLAVES_SIIGO.map((clave) => {
    const row = map.get(clave);
    return {
      clave,
      valor: row?.valor ?? null,
      descripcion: row?.descripcion ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  });

  return jsonResponse({ parametros });
}

export async function PUT(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let payload: z.infer<typeof putSchema>;
  try {
    payload = putSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const anteriores = await prisma.parametro.findMany({
    where: { clave: { in: payload.parametros.map((p) => p.clave) } },
    select: { clave: true, valor: true },
  });
  const antesMap = Object.fromEntries(anteriores.map((p) => [p.clave, p.valor]));

  await prisma.$transaction([
    ...payload.parametros.map((p) =>
      prisma.parametro.upsert({
        where: { clave: p.clave },
        update: { valor: p.valor },
        create: { clave: p.clave, valor: p.valor },
      }),
    ),
    prisma.auditLog.create({
      data: {
        entidad: "Parametro",
        entidadId: "siigo-config",
        accion: "UPDATE",
        usuarioId: session.user.id,
        antes: antesMap,
        despues: Object.fromEntries(
          payload.parametros.map((p) => [p.clave, p.valor]),
        ),
      },
    }),
  ]);

  return jsonResponse({
    ok: true,
    actualizados: payload.parametros.map((p) => p.clave),
  });
}
