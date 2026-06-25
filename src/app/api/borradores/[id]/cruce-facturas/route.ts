/**
 * GET /api/borradores/[id]/cruce-facturas
 *
 * Devuelve, por cada FacturaProveedor del trámite asociado al borrador,
 * el montoPagado (Σ PagoTramiteFactura), el montoFacturado (Σ LineaRevisionFactura)
 * y la diferencia. Solo lectura; no modifica estado.
 *
 * Rol requerido: ADMIN, REVISOR.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { calcularCruceFacturas } from "@/lib/borradores/cruce-facturas";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) {
    return session;
  }

  const { id: borradorId } = await params;

  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: {
      tramiteId: true,
      lineasRevision: {
        select: {
          valor: true,
          facturas: {
            select: { facturaId: true },
          },
        },
      },
    },
  });

  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  const facturasProveedor = await prisma.facturaProveedor.findMany({
    where: { tramiteId: borrador.tramiteId },
    select: {
      id: true,
      proveedorNombre: true,
      numFactura: true,
      valor: true,
      pagos: {
        select: {
          pagoId: true,
          pago: { select: { valor: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Construir pivot de líneas: LineaRevisionFactura del borrador actual
  const lineasPivot = borrador.lineasRevision.flatMap((linea) =>
    linea.facturas.map((pivot) => ({
      facturaId: pivot.facturaId,
      linea: { valor: linea.valor },
    })),
  );

  const pagosPivot = facturasProveedor.flatMap((fp) =>
    fp.pagos.map((pivot) => ({
      facturaId: fp.id,
      pago: { valor: pivot.pago.valor },
    })),
  );

  const facturaInputs = facturasProveedor.map((fp) => ({
    id: fp.id,
    proveedorNombre: fp.proveedorNombre,
    numFactura: fp.numFactura,
    valor: fp.valor,
  }));

  const cruce = calcularCruceFacturas(facturaInputs, pagosPivot, lineasPivot);

  return jsonResponse({ cruce });
}
