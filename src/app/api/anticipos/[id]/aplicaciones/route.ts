import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { aplicarAnticipo } from "@/lib/anticipos/service";
import { aplicarAnticipoSchema } from "@/lib/validations/anticipos";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Karina (OPERATIVO) puede aplicar anticipos a un DO — decisión del dueño 2026-09-22.
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id: anticipoId } = await params;
    const payload = aplicarAnticipoSchema.parse(await request.json());

    const result = await aplicarAnticipo(
      {
        anticipoId,
        tramiteId: payload.tramiteId,
        montoAplicado: payload.montoAplicado,
      },
      session.user.id,
    );

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message },
        { status: result.status },
      );
    }

    return jsonResponse({ aplicacion: result.aplicacion }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
