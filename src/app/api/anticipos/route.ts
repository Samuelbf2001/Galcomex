import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  AnticipoSoporteObligatorioError,
  crearAnticipo,
  listarAnticipos,
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
      sinSoporte: request.nextUrl.searchParams.get("sin_soporte") ?? undefined,
    });

    const anticipos = await listarAnticipos({
      clienteId: params.clienteId,
      conSaldo: params.conSaldo,
      sinSoporte: params.sinSoporte,
    });

    return jsonResponse({ anticipos });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}

// Registrar un anticipo es rol ADMIN u OPERATIVO, como siempre documentó la
// matriz de roles de CLAUDE.md ("Registrar anticipos/pagos": ADMIN, OPERATIVO).
// El código había quedado en solo-ADMIN, lo que rompía la separación de
// funciones que se describió en la reunión del 1-jul (min 00:04): "ellos pueden
// montar el anticipo, pero los que definen si entró a la cuenta son ustedes".
// Quien monta ya no es necesariamente quien verifica: para clientes SOCIO_LM
// la verificación sigue reservada a ADMIN (ver `verificarAnticipo`), así que el
// control de cuatro ojos sobre los anticipos de Lucho queda intacto.
export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

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
      usuarioId: session.user.id,
    });

    return jsonResponse({ anticipo }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof AnticipoSoporteObligatorioError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    throw error;
  }
}
