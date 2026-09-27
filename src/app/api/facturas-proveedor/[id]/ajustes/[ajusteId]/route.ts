import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { eliminarAjusteLegado } from "@/lib/cxp/aplicar";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";
import { respuestaErrorPagos } from "@/lib/pagos/respuesta-error";
import { eliminarAjusteLegadoSchema } from "@/lib/validations/pagos";

type RouteContext = {
  params: Promise<{ id: string; ajusteId: string }>;
};

/**
 * DELETE /api/facturas-proveedor/[id]/ajustes/[ajusteId] — quita un ajuste
 * LEGADO de la migración y reabre la factura (Abonada/Pendiente). Solo ADMIN,
 * con motivo (body `{ motivo }`, ≥ 10 caracteres). No hay creación de ajustes
 * en v2 (D-8).
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id, ajusteId } = await context.params;
    // El motivo llega en el cuerpo ({ motivo }) o, para clientes que no mandan
    // cuerpo en DELETE, como `?motivo=`.
    const cuerpo: unknown = await request.json().catch(() => ({}));
    const { motivo } = eliminarAjusteLegadoSchema.parse({
      motivo: request.nextUrl.searchParams.get("motivo") ?? undefined,
      ...(typeof cuerpo === "object" && cuerpo !== null ? cuerpo : {}),
    });

    const ajuste = await prisma.ajusteFacturaProveedor.findUnique({
      where: { id: ajusteId },
      select: { facturaId: true },
    });
    if (!ajuste || ajuste.facturaId !== id) {
      return NextResponse.json({ error: "Ajuste no encontrado en esta factura" }, { status: 404 });
    }

    const resultado = await eliminarAjusteLegado(ajusteId, motivo, session.user.id);
    return jsonResponse(resultado);
  } catch (error) {
    const respuesta = respuestaErrorPagos(error);
    if (respuesta) return respuesta;
    throw error;
  }
}
