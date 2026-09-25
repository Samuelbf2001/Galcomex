import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  crearAnticipo,
  listarAnticipos,
  SoporteAnticipoRequeridoError,
} from "@/lib/anticipos/service";
import {
  crearAnticipoSchema,
  listarAnticiposQuerySchema,
} from "@/lib/validations/anticipos";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const params = listarAnticiposQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      conSaldo: request.nextUrl.searchParams.get("con_saldo") ?? undefined,
    });

    const anticipos = await listarAnticipos({
      clienteId: params.clienteId,
      conSaldo: params.conSaldo,
    });

    return jsonResponse({ anticipos });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}

export async function POST(request: NextRequest) {
  // Karina (OPERATIVO) puede registrar anticipos — decisión del dueño 2026-09-22.
  // Sin restricción por tipo de cliente: a diferencia de verificar, crear no
  // distingue SOCIO_LM (mismo patrón que crearPago en lib/pagos/service.ts).
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = crearAnticipoSchema.parse(await request.json());

    const anticipo = await crearAnticipo(
      {
        clienteId: payload.clienteId,
        monto: payload.monto,
        fecha: payload.fecha,
        tipoRecaudo: payload.tipoRecaudo,
        soporteKey: payload.soporteKey,
        verificadoBanco: payload.verificadoBanco,
      },
      session.user.id,
    );

    return jsonResponse({ anticipo }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof SoporteAnticipoRequeridoError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    // F1: empresa marcada solo-proveedor (`EmpresaNoEsClienteError`, 422) y
    // cualquier otro error de dominio con `.status` caen aquí.
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
