import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { transitionTramite } from "@/lib/tramites/service";
import { estadoTransitionSchema } from "@/lib/validations/tramites";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = estadoTransitionSchema.parse(await request.json());
    const result = await transitionTramite(
      id,
      payload.estado,
      session.user.id,
      session.user.rol === "ADMIN",
      session.user.rol,
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          faltantes: result.faltantes,
          // Bloqueos por reglas de la empresa (tarifa vigente, BL y factura
          // comercial): código estable + datos para que la UI guíe al usuario.
          codigo: result.codigo,
          detalles: result.detalles,
        },
        { status: result.status },
      );
    }

    // `advertencias`: requisitos que el ADMIN se saltó con su excepción.
    return jsonResponse({ tramite: result.tramite, advertencias: result.advertencias });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
