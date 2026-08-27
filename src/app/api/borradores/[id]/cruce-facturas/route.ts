/**
 * GET /api/borradores/[id]/cruce-facturas
 *
 * Devuelve dos vistas de cruce, solo lectura, sin modificar estado:
 *
 * 1. `cruce` — por cada FacturaProveedor del trámite: montoPagado
 *    (Σ PagoTramiteFactura), montoFacturado (Σ LineaRevisionFactura) y la
 *    diferencia. Vista fina, a nivel de factura de venta / línea.
 * 2. `validaciones` — por cada proveedor/beneficiario del trámite: Σ
 *    FacturaProveedor.valor vs Σ PagoTramite.valor vinculados, más los pagos
 *    sueltos (sin ninguna factura de proveedor vinculada). Vista agregada
 *    para la sección "Validaciones" del revisor.
 *
 * Rol requerido: ADMIN, REVISOR.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { calcularCruceFacturas } from "@/lib/borradores/cruce-facturas";
import { calcularValidacionesCruce } from "@/lib/borradores/validaciones";
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
      beneficiarioId: true,
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

  // Pagos del trámite que no tienen NINGUNA factura de proveedor vinculada
  // ("pagos sueltos" — spec 2: nota "sin factura vinculada").
  const pagosSueltosRaw = await prisma.pagoTramite.findMany({
    where: { tramiteId: borrador.tramiteId, facturasProveedor: { none: {} } },
    select: { id: true, concepto: true, numSoporte: true, valor: true },
    orderBy: { orden: "asc" },
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

  // ── Validaciones por proveedor/beneficiario (spec 2) ──────────────────────
  const facturasParaValidacion = facturasProveedor.map((fp) => ({
    id: fp.id,
    proveedorId: fp.beneficiarioId ?? `nombre:${fp.proveedorNombre.trim().toLowerCase()}`,
    proveedorNombre: fp.proveedorNombre,
    valor: fp.valor,
  }));
  const pagosVinculadosParaValidacion = facturasProveedor.flatMap((fp) =>
    fp.pagos.map((pivot) => ({ facturaId: fp.id, valor: pivot.pago.valor })),
  );
  const pagosSueltosParaValidacion = pagosSueltosRaw.map((p) => ({
    pagoId: p.id,
    concepto: p.concepto,
    numSoporte: p.numSoporte,
    valor: p.valor,
  }));

  const validaciones = calcularValidacionesCruce(
    facturasParaValidacion,
    pagosVinculadosParaValidacion,
    pagosSueltosParaValidacion,
  );

  return jsonResponse({ cruce, validaciones });
}
