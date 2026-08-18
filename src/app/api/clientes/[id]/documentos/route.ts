import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { puedeVerDocumentosDeCliente } from "@/lib/documentos/acceso-cliente";
import { listarDocumentosCliente } from "@/lib/documentos/service";
import { documentosClienteQuerySchema } from "@/lib/documentos/validaciones-cliente";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/clientes/[id]/documentos
 * Repositorio documental agregado por cliente ("carpetica virtual" —
 * reunión 2026-07-01, min 01:15 y 01:29): reúne los documentos de TODOS los
 * trámites del cliente en una sola vista, en vez de tener que entrar DO por
 * DO como exige hoy GET /api/tramites/[id]/documentos.
 *
 * Query params (todos opcionales salvo take/skip que tienen default):
 *   - categoria: CategoriaDocumento (BL, FACTURA_COMERCIAL, ...)
 *   - desde / hasta: rango de fecha de subida (ISO, ej. "2026-01-31")
 *   - take: máx. resultados por página (1-100, default 50)
 *   - skip: offset de paginación (default 0)
 *
 * Autorización: mismos roles que pueden listar documentos de un trámite
 * (ADMIN, REVISOR, OPERATIVO, SOCIO). Un SOCIO solo puede ver documentos de
 * clientes SOCIO_LM — mismo criterio que resolverTramiteConPermiso
 * (src/lib/auth/tramite-acceso.ts), extraído aquí como la función pura
 * puedeVerDocumentosDeCliente para poder testearla sin BD.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  const cliente = await prisma.cliente.findUnique({
    where: { id },
    select: { id: true, tipo: true },
  });

  // Mismo comportamiento que GET /api/clientes/[id]: 404 tanto si el cliente
  // no existe como si un SOCIO intenta ver un cliente que no es suyo (no se
  // revela la existencia del cliente a un usuario sin acceso).
  if (!cliente || !puedeVerDocumentosDeCliente(session.user.rol, cliente.tipo)) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  let query: ReturnType<typeof documentosClienteQuerySchema.parse>;
  try {
    query = documentosClienteQuerySchema.parse({
      categoria: request.nextUrl.searchParams.get("categoria") ?? undefined,
      desde: request.nextUrl.searchParams.get("desde") ?? undefined,
      hasta: request.nextUrl.searchParams.get("hasta") ?? undefined,
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const { documentos, total } = await listarDocumentosCliente(id, query);

  return jsonResponse({ documentos, total });
}
