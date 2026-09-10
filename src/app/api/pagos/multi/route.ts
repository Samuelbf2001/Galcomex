import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
} from "@/lib/facturas-proveedor/service";
import {
  DocumentoDeOtroTramiteError,
  DocumentoNoEncontradoParaPagoError,
  MatrizCanalNoEncontradoError,
  PagoMultiDOBeneficiarioMismatchError,
  PagoMultiDOSinFacturasError,
  SinAnticipoAplicadoMultiDOError,
  crearPagoMultiDO,
  listarFacturasElegiblesMultiDO,
} from "@/lib/pagos/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  crearPagoMultiDOSchema,
  listarFacturasElegiblesMultiDOQuerySchema,
} from "@/lib/validations/pagos";

/**
 * GET /api/pagos/multi?beneficiarioId=xxx
 *   Lista TODAS las FacturaProveedor REGISTRADA de un beneficiario, de TODOS
 *   los trámites — usado por el selector del modal "Pago multi-DO".
 *
 * POST /api/pagos/multi
 *   Crea el pago multi-DO (caso Karina/Occidente): un solo comprobante/canal
 *   cubre facturas de proveedor de varios trámites. Ver crearPagoMultiDO().
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { beneficiarioId } = listarFacturasElegiblesMultiDOQuerySchema.parse({
      beneficiarioId: request.nextUrl.searchParams.get("beneficiarioId") ?? undefined,
    });

    const facturas = await listarFacturasElegiblesMultiDO(beneficiarioId);

    return jsonResponse({ facturas });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = crearPagoMultiDOSchema.parse(await request.json());

    const resultado = await crearPagoMultiDO({
      ...payload,
      usuarioId: session.user.id,
    });

    return jsonResponse(resultado, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    if (error instanceof PagoMultiDOSinFacturasError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof MatrizCanalNoEncontradoError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (error instanceof FacturaProveedorNoEncontradaError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }

    if (error instanceof FacturaProveedorNoModificableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof PagoMultiDOBeneficiarioMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }

    if (error instanceof SinAnticipoAplicadoMultiDOError) {
      return NextResponse.json(
        { error: error.message, tramiteId: error.tramiteId, consecutivo: error.consecutivo },
        { status: 422 },
      );
    }

    if (
      error instanceof DocumentoNoEncontradoParaPagoError ||
      error instanceof DocumentoDeOtroTramiteError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
