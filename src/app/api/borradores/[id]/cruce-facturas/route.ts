/**
 * GET /api/borradores/[id]/cruce-facturas
 *
 * Devuelve dos vistas de cruce, solo lectura, sin modificar estado:
 *
 * 1. `cruce` — por cada FacturaProveedor del trámite: montoPagado
 *    (Σ `monto` del puente PagoTramiteFactura: lo aplicado a la factura, CxP
 *    v2), montoFacturado (Σ LineaRevisionFactura) y la diferencia. Las que no
 *    se trasladan al cliente (`repercutible = false`) no son desviación.
 * 2. `validaciones` — por cada proveedor/beneficiario del trámite: Σ
 *    FacturaProveedor.valor vs Σ monto aplicado del puente, más los pagos
 *    sueltos (sin ninguna factura de proveedor vinculada). Vista agregada
 *    para la sección "Validaciones" del revisor.
 *
 * Fase centavos: montos en CENTAVOS hasta el serializador (pesos texto con 2
 * decimales en la respuesta). Los ajustes `REDONDEO` de cada factura cuentan
 * como pagado, con `nota` «incluye redondeo de $0,45» (D-8).
 *
 * Rol requerido: ADMIN, REVISOR.
 */

import { TipoAjusteFacturaProveedor } from "@prisma/client";
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
          valorCentavos: true,
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
      valorCentavos: true,
      repercutible: true,
      pagos: {
        select: {
          pagoId: true,
          montoCentavos: true,
        },
      },
      ajustes: {
        where: { tipo: TipoAjusteFacturaProveedor.REDONDEO },
        select: { tipo: true, montoCentavos: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Pagos del trámite que no tienen NINGUNA factura de proveedor vinculada
  // ("pagos sueltos" — spec 2: nota "sin factura vinculada").
  const pagosSueltosRaw = await prisma.pagoTramite.findMany({
    where: { tramiteId: borrador.tramiteId, facturasProveedor: { none: {} } },
    select: { id: true, concepto: true, numSoporte: true, valorCentavos: true },
    orderBy: { orden: "asc" },
  });

  // Construir pivot de líneas: LineaRevisionFactura del borrador actual
  const lineasPivot = borrador.lineasRevision.flatMap((linea) =>
    linea.facturas.map((pivot) => ({
      facturaId: pivot.facturaId,
      linea: { valor: linea.valorCentavos },
    })),
  );

  const pagosPivot = facturasProveedor.flatMap((fp) =>
    fp.pagos.map((pivot) => ({
      facturaId: fp.id,
      monto: pivot.montoCentavos,
    })),
  );

  const ajustesRedondeo = facturasProveedor.flatMap((fp) =>
    fp.ajustes.map((a) => ({ facturaId: fp.id, tipo: a.tipo, monto: a.montoCentavos })),
  );

  const facturaInputs = facturasProveedor.map((fp) => ({
    id: fp.id,
    proveedorNombre: fp.proveedorNombre,
    numFactura: fp.numFactura,
    valor: fp.valorCentavos,
    // FPR-02: la ruta olvidaba el flag y toda asesoría salía como desviación.
    repercutible: fp.repercutible,
  }));

  const cruce = calcularCruceFacturas(facturaInputs, pagosPivot, lineasPivot, ajustesRedondeo);

  // ── Validaciones por proveedor/beneficiario (spec 2) ──────────────────────
  const facturasParaValidacion = facturasProveedor.map((fp) => ({
    id: fp.id,
    proveedorId: fp.beneficiarioId ?? `nombre:${fp.proveedorNombre.trim().toLowerCase()}`,
    proveedorNombre: fp.proveedorNombre,
    valor: fp.valorCentavos,
  }));
  const pagosVinculadosParaValidacion = facturasProveedor.flatMap((fp) =>
    fp.pagos.map((pivot) => ({ facturaId: fp.id, valor: pivot.montoCentavos })),
  );
  const pagosSueltosParaValidacion = pagosSueltosRaw.map((p) => ({
    pagoId: p.id,
    concepto: p.concepto,
    numSoporte: p.numSoporte,
    valor: p.valorCentavos,
  }));

  const validaciones = calcularValidacionesCruce(
    facturasParaValidacion,
    pagosVinculadosParaValidacion,
    pagosSueltosParaValidacion,
    ajustesRedondeo,
  );

  return jsonResponse({ cruce, validaciones });
}
