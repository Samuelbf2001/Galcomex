import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  getCuentaCorriente,
  registrarMovimientoCuenta,
} from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { movimientoCuentaSchema } from "@/lib/validations/cuenta-corriente";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

/**
 * Cuenta corriente de una contraparte (M5): junta en un solo saldo lo que la
 * empresa nos debe como cliente y lo que le debemos como proveedor.
 *
 * GET  — ADMIN y REVISOR (los mismos roles que ven cartera).
 * POST — ADMIN: registra un movimiento manual (mensualidad, comisión, ajuste).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const cuenta = await getCuentaCorriente(id);

    return jsonResponse({ cuenta });
  } catch (error) {
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = movimientoCuentaSchema.parse(await request.json());

    if (payload.tramiteId) {
      const tramite = await prisma.tramiteDO.findUnique({
        where: { id: payload.tramiteId },
        select: { id: true },
      });

      if (!tramite) {
        return NextResponse.json({ error: "Tramite no encontrado" }, { status: 404 });
      }
    }

    await registrarMovimientoCuenta({
      empresaId: id,
      ...payload,
      usuarioId: session.user.id,
    });

    const cuenta = await getCuentaCorriente(id);

    return jsonResponse({ cuenta }, { status: 201 });
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
