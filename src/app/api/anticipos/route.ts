import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { crearAnticipo, listarAnticipos } from "@/lib/anticipos/service";
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
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = crearAnticipoSchema.parse(await request.json());

    const anticipo = await crearAnticipo({
      clienteId: payload.clienteId,
      monto: payload.monto,
      fecha: payload.fecha,
      tipoRecaudo: payload.tipoRecaudo,
      soporteKey: payload.soporteKey,
      verificadoBanco: payload.verificadoBanco,
    });

    return jsonResponse({ anticipo }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
