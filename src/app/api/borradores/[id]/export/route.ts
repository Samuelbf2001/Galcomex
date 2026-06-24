/**
 * GET /api/borradores/[id]/export
 * Genera y devuelve el borrador de factura como archivo XLSX para SIIGO.
 * Roles: ADMIN, REVISOR
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { construirBorradorXlsx, nombreArchivoXlsx, XLSX_CONTENT_TYPE } from "@/lib/export/siigo-xlsx";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    include: {
      lineasRevision: { orderBy: { orden: "asc" } },
      tramite: {
        select: {
          consecutivo: true,
          cliente: { select: { nombre: true } },
        },
      },
    },
  });

  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const buffer = construirBorradorXlsx({
    id: borrador.id,
    numFacturaSiigo: borrador.numFacturaSiigo,
    tramite: borrador.tramite
      ? {
          consecutivo: borrador.tramite.consecutivo,
          cliente: borrador.tramite.cliente
            ? { nombre: borrador.tramite.cliente.nombre }
            : null,
        }
      : null,
    lineasRevision: [...borrador.lineasRevision]
      .sort((a, b) => {
        const peso =
          (a.seccion === "TERCEROS" ? 0 : 1) - (b.seccion === "TERCEROS" ? 0 : 1);
        return peso !== 0 ? peso : a.orden - b.orden;
      })
      .map((l) => ({
        concepto: l.concepto,
        numSoporte: l.numSoporte,
        valor: l.valor,
        orden: l.orden,
      })),
    comision: borrador.comision,
    ivaComision: borrador.ivaComision,
    impuesto4x1000: borrador.impuesto4x1000,
    costosBancarios: borrador.costosBancarios,
    totalFactura: borrador.totalFactura,
    saldoAFavorCliente: borrador.saldoAFavorCliente,
    saldoACargoCliente: borrador.saldoACargoCliente,
    saldoAFavorLM: borrador.saldoAFavorLM,
    saldoACargoLM: borrador.saldoACargoLM,
  });

  const filename = nombreArchivoXlsx("borrador", borradorId, borrador.numFacturaSiigo);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
