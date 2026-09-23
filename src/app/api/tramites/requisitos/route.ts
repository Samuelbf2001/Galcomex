import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { EmpresaNoEncontradaError } from "@/lib/capacidades/service";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { requisitosDeDo } from "@/lib/tramites/service";
import { requisitosQuerySchema } from "@/lib/validations/tramites";

/**
 * Requisitos de un DO ANTES de crearlo, para que el formulario los muestre y
 * no ofrezca algo que el servidor va a rechazar:
 *
 *   GET /api/tramites/requisitos?clienteId=…&tipoTramiteCodigo=IMPORTACION
 *
 * - `tarifaVigente`: capacidad `do_exige_tarifa_vigente` + tarifario vigente
 *   de la línea de servicio del tipo (mismo texto que el 422 de la creación).
 * - `documentosObligatorios.requeridos`: capacidad
 *   `docs_bl_factura_obligatorios` para ese tipo (BL y FACTURA_COMERCIAL). El
 *   servidor los exige al pasar de APERTURA a EN_TRAMITE; la UI los pide al
 *   crear, porque se suben justo después del POST.
 *
 * Mismos roles que `POST /api/tramites`.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  let query: ReturnType<typeof requisitosQuerySchema.parse>;
  try {
    query = requisitosQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      tipoTramiteCodigo: request.nextUrl.searchParams.get("tipoTramiteCodigo") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  try {
    const requisitos = await requisitosDeDo(query);
    return jsonResponse(requisitos);
  } catch (error) {
    if (error instanceof EmpresaNoEncontradaError) {
      return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
    }

    // Tipo de trámite inexistente o inactivo (422).
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    throw error;
  }
}
