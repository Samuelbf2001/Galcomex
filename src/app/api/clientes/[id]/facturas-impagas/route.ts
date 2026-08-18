/**
 * GET /api/clientes/[id]/facturas-impagas
 *
 * Facturas de proveedor pendientes de pago de un cliente, atravesando todos sus
 * trámites. Es el insumo del lote de pago: Karina paga la cartera del puerto de
 * una sola vez y necesita ver las facturas del cliente sin recorrer DO por DO
 * (reunión 1-jul, min 00:48).
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError, z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { listarFacturasImpagasPorCliente } from "@/lib/facturas-proveedor/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { puedeVerDocumentosDeCliente } from "@/lib/documentos/acceso-cliente";

type RouteContext = { params: Promise<{ id: string }> };

const querySchema = z.object({
  take: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);
  if (session instanceof NextResponse) return session;

  const { id } = await context.params;

  let query: z.infer<typeof querySchema>;
  try {
    query = querySchema.parse({
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  const cliente = await prisma.cliente.findUnique({
    where: { id },
    select: { id: true, tipo: true },
  });

  if (!cliente) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  // Mismo criterio de scoping que el resto del sistema: un SOCIO solo alcanza
  // clientes SOCIO_LM.
  if (!puedeVerDocumentosDeCliente(session.user.rol, cliente.tipo)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const { facturas, total } = await listarFacturasImpagasPorCliente(id, {
    take: query.take,
    skip: query.skip,
  });

  return jsonResponse({ facturas, total });
}
