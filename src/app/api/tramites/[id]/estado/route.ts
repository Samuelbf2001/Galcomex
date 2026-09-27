import { Prisma } from "@prisma/client";
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

/**
 * Cerrar el DO espera su candado, que un pago en bloque o la anulación de un
 * bloque pueden retener. Si aun así la transacción vence (P2028) o choca
 * (P2034), no es una falla del servidor: el DO está ocupado y basta con
 * reintentar.
 */
const CODIGOS_DO_OCUPADO = new Set(["P2028", "P2034"]);

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
      // Facturado sin factura emitida: solo el ADMIN lo fuerza, con motivo.
      { motivoExcepcion: payload.motivoExcepcion },
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          faltantes: result.faltantes,
          // Bloqueos por reglas (tarifa vigente, BL y factura comercial,
          // factura emitida): código estable + datos para que la UI guíe al usuario.
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

    if (error instanceof Prisma.PrismaClientKnownRequestError && CODIGOS_DO_OCUPADO.has(error.code)) {
      return NextResponse.json(
        {
          error: "El DO está ocupado registrando un pago; reintenta en unos segundos.",
          codigo: "DO_OCUPADO",
        },
        { status: 409 },
      );
    }

    throw error;
  }
}
