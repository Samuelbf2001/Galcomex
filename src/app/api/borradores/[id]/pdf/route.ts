/**
 * GET /api/borradores/[id]/pdf
 *
 * Genera y devuelve el PDF del borrador de factura aprobado.
 * - Roles: ADMIN, REVISOR
 * - Content-Type: application/pdf
 * - Content-Disposition: inline; filename="borrador-{DO}-{numSiigo}.pdf"
 *
 * Necesita Node runtime (react-pdf no corre en Edge).
 */

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import {
  renderBorradorPdf,
  type BorradorPdfDto,
  type LineaPdfDto,
} from "@/lib/pdf/borrador-pdf";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  void request; // no usamos el body, pero Next lo pide en la firma

  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  const { id: borradorId } = await params;

  // ── Leer el borrador ──────────────────────────────────────────────────────
  const borrador = await getBorrador(borradorId);

  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  // ── Leer datos del trámite y cliente ─────────────────────────────────────
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: borrador.tramiteId },
    select: {
      consecutivo: true,
      cliente: { select: { nombre: true } },
    },
  });

  if (!tramite) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }

  // ── Preparar DTO ─────────────────────────────────────────────────────────
  // Agrupar TERCEROS antes que OPERACIONAL para que el PDF refleje el formato
  // de factura (ingresos para terceros + costos operacionales).
  const PESO_SECCION = { TERCEROS: 0, OPERACIONAL: 1 } as const;
  const lineas: LineaPdfDto[] = [...borrador.lineasRevision]
    .sort((a, b) => {
      const peso = PESO_SECCION[a.seccion] - PESO_SECCION[b.seccion];
      return peso !== 0 ? peso : a.orden - b.orden;
    })
    .map((l) => ({
      orden: l.orden,
      concepto: l.concepto,
      numSoporte: l.numSoporte ?? null,
      valor: l.valorCentavos,
    }));

  const dto: BorradorPdfDto = {
    consecutivoDO: tramite.consecutivo,
    nombreCliente: tramite.cliente.nombre,
    numFacturaSiigo: borrador.numFacturaSiigo ?? null,
    fechaEmision: borrador.fechaFactura ?? borrador.createdAt,
    estado: borrador.estado,

    lineas,

    // Centavos de COP (el PDF los muestra siempre con ",00").
    totalAnticipo: borrador.totalAnticipoCentavos,
    totalPagos: borrador.totalPagosCentavos,
    comision: borrador.comisionCentavos,
    ivaComision: borrador.ivaComisionCentavos,
    costosBancarios: borrador.costosBancariosCentavos,
    impuesto4x1000: borrador.impuesto4x1000Centavos,
    totalFactura: borrador.totalFacturaCentavos,

    saldoAFavorCliente: borrador.saldoAFavorClienteCentavos,
    saldoACargoCliente: borrador.saldoACargoClienteCentavos,
    saldoAFavorLM: borrador.saldoAFavorLMCentavos,
    saldoACargoLM: borrador.saldoACargoLMCentavos,
  };

  // ── Renderizar PDF ────────────────────────────────────────────────────────
  const pdfBuffer = await renderBorradorPdf(dto);

  const siigo = borrador.numFacturaSiigo ?? "borrador";
  const filename = `borrador-${tramite.consecutivo}-${siigo}.pdf`
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "");

  // NextResponse acepta Uint8Array — pasamos el Buffer directamente (es subclase)
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": pdfBuffer.length.toString(),
      "Cache-Control": "no-store",
    },
  });
}
