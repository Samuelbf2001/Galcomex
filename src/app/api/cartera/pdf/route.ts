/**
 * GET /api/cartera/pdf?clienteId=...
 *
 * Genera y devuelve el estado de cuenta de cartera por cliente en PDF.
 * - Roles: ADMIN, REVISOR
 * - Content-Type: application/pdf
 * - Content-Disposition: inline; filename="estado-cuenta-{cliente}.pdf"
 *
 * Necesita Node runtime (react-pdf no corre en Edge).
 */

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { getCarteraCliente } from "@/lib/cartera/service";
import { prisma } from "@/lib/db/prisma";
import {
  renderEstadoCuentaPdf,
  type EstadoCuentaPdfDto,
  type FacturaEstadoCuentaDto,
} from "@/lib/pdf/estado-cuenta-pdf";

const querySchema = z.object({
  clienteId: z.string().min(1, "clienteId es obligatorio"),
  pendientes: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);
  if (session instanceof NextResponse) return session;

  // ── Validar query params ─────────────────────────────────────────────────
  const parseResult = querySchema.safeParse({
    clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
    pendientes: request.nextUrl.searchParams.get("pendientes") ?? undefined,
  });

  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Parámetros inválidos",
        details: parseResult.error.issues.map((i) => ({
          campo: i.path.join("."),
          mensaje: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const { clienteId, pendientes } = parseResult.data;

  // ── Leer cliente ─────────────────────────────────────────────────────────
  const cliente = await prisma.cliente.findUnique({
    where: { id: clienteId },
    select: { nombre: true, nit: true },
  });

  if (!cliente) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  // ── Leer cartera ─────────────────────────────────────────────────────────
  const cartera = await getCarteraCliente({
    clienteId,
    soloPendientes: pendientes,
  });

  // ── Preparar DTO de PDF ──────────────────────────────────────────────────
  const facturasDtos: FacturaEstadoCuentaDto[] = cartera.facturas.map((f) => ({
    id: f.id,
    numSiigo: f.numSiigo,
    consecutivoDO: f.borrador.tramite?.consecutivo ?? "—",
    fecha: f.fecha,
    totalFactura: f.totalFactura,
    saldoAFavorCliente: f.saldoAFavorCliente,
    saldoACargoCliente: f.saldoACargoCliente,
    saldoAFavorLM: f.saldoAFavorLM,
    saldoACargoLM: f.saldoACargoLM,
    fechaPagoCliente: f.fechaPagoCliente,
    fechaPagoLM: f.fechaPagoLM,
  }));

  const dto: EstadoCuentaPdfDto = {
    nombreCliente: cliente.nombre,
    nitCliente: cliente.nit,
    fechaEmision: new Date(),
    facturas: facturasDtos,
    cruceCliente: cartera.cruceCliente,
    cruceLM: cartera.cruceLM,
    totalFacturas: cartera.totalFacturas,
  };

  // ── Renderizar PDF ────────────────────────────────────────────────────────
  const pdfBuffer = await renderEstadoCuentaPdf(dto);

  const filename = `estado-cuenta-${cliente.nombre}-${new Date().toISOString().slice(0, 10)}.pdf`
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
