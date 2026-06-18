/**
 * GET /api/cartera/export?clienteId=...
 * Genera y devuelve la relación de facturas del cliente como archivo XLSX.
 * Roles: ADMIN, REVISOR
 */

import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getCarteraCliente } from "@/lib/cartera/service";
import { validationError } from "@/lib/http/errors";
import { construirRelacionFacturasXlsx, nombreArchivoXlsx, XLSX_CONTENT_TYPE } from "@/lib/export/siigo-xlsx";

const carteraExportQuerySchema = z.object({
  clienteId: z.string().min(1, "clienteId es obligatorio"),
});

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) {
    return session;
  }

  let query: { clienteId: string };
  try {
    query = carteraExportQuerySchema.parse({
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  const cartera = await getCarteraCliente({ clienteId: query.clienteId });

  const buffer = construirRelacionFacturasXlsx({
    facturas: cartera.facturas.map((f) => ({
      id: f.id,
      numSiigo: f.numSiigo,
      fecha: f.fecha,
      totalFactura: f.totalFactura,
      saldoAFavorCliente: f.saldoAFavorCliente,
      saldoACargoCliente: f.saldoACargoCliente,
      saldoAFavorLM: f.saldoAFavorLM,
      saldoACargoLM: f.saldoACargoLM,
      fechaPagoCliente: f.fechaPagoCliente,
      fechaPagoLM: f.fechaPagoLM,
      borrador: f.borrador
        ? {
            tramiteId: f.borrador.tramiteId,
            tramite: f.borrador.tramite
              ? { consecutivo: f.borrador.tramite.consecutivo }
              : null,
          }
        : null,
    })),
    cruceCliente: cartera.cruceCliente,
    cruceLM: cartera.cruceLM,
    totalFacturas: cartera.totalFacturas,
  });

  const filename = nombreArchivoXlsx("cartera", query.clienteId);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
