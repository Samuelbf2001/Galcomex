import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { SoporteCuentaValidationError, solicitarSubidaSoporteCuenta } from "@/lib/cuenta-corriente/soporte";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const bodySchema = z.object({
  fileName: z.string().trim().min(1),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

/**
 * URL prefirmada de subida para el PDF de soporte de una factura de proveedor
 * en la cuenta corriente ("Registrar factura de <proveedor>"). Solo ADMIN,
 * mismo rol que registra el movimiento. El cliente sube el archivo directo a
 * `uploadUrl` y luego manda `key` en el `POST …/cuenta` junto con el resto.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;
    const payload = bodySchema.parse(await request.json());

    const { uploadUrl, key } = await solicitarSubidaSoporteCuenta({
      empresaId: id,
      fileName: payload.fileName,
      contentType: payload.contentType,
      sizeBytes: payload.sizeBytes,
    });

    return jsonResponse({ uploadUrl, key }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Payload invalido",
          details: error.issues.map((issue) => ({ campo: issue.path.join("."), mensaje: issue.message })),
        },
        { status: 400 },
      );
    }
    if (error instanceof SoporteCuentaValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
