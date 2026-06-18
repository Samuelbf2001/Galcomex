/**
 * @deprecated POST /api/facturas/[id]/pago  — Registrar fecha de pago de factura (rol ADMIN)
 *
 * DEPRECADO (WS-D). La UI migrará a POST /api/facturas/[id]/pagos en WS-E.
 * Este endpoint escribe directamente fechaPagoCliente/LM sin crear PagoFactura.
 * Conservado para compatibilidad hasta que WS-E complete la migración del modal.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { registrarPagoFactura } from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { registrarPagoFacturaPayloadSchema } from "@/lib/validations/borradores";

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id: facturaId } = await params;

  try {
    const payload = registrarPagoFacturaPayloadSchema.parse(await request.json());

    const result = await registrarPagoFactura({
      facturaId,
      fechaPagoCliente: payload.fechaPagoCliente,
      fechaPagoLM: payload.fechaPagoLM,
      usuarioId: session.user.id,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    return jsonResponse({ factura: result.factura });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    throw error;
  }
}
