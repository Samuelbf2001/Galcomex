/**
 * GET /api/tarifarios/[id]/pdf — la propuesta comercial en PDF (M2).
 * Roles: ADMIN, REVISOR, OPERATIVO. Necesita Node runtime (react-pdf).
 */

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { domainErrorResponse, isDomainError } from "@/lib/http/errors";
import { renderTarifarioPdf, type TarifaItemPdfDto } from "@/lib/pdf/tarifario-pdf";
import { getTarifario } from "@/lib/tarifas/service";

type RouteContext = { params: Promise<{ id: string }> };

function tramosDe(json: unknown): TarifaItemPdfDto["tramos"] {
  if (!Array.isArray(json)) return null;
  const out: NonNullable<TarifaItemPdfDto["tramos"]> = [];
  for (const t of json) {
    if (!t || typeof t !== "object") continue;
    const { hasta, valor } = t as Record<string, unknown>;
    if (typeof valor === "string" && /^\d+$/.test(valor) && (hasta === null || typeof hasta === "number")) {
      out.push({ hasta: hasta as number | null, valor });
    }
  }
  return out.length ? out : null;
}

function minimosDe(json: unknown): TarifaItemPdfDto["minimos"] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const rec = json as Record<string, unknown>;
  const out: NonNullable<TarifaItemPdfDto["minimos"]> = {};
  for (const k of ["SUELTA", "CONTENEDOR_20", "CONTENEDOR_40"] as const) {
    if (typeof rec[k] === "string") out[k] = rec[k] as string;
  }
  return out;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await context.params;
    const tarifario = await getTarifario(id);
    const empresa = await prisma.cliente.findUnique({
      where: { id: tarifario.empresaId },
      select: { nombre: true, nit: true, contactoNombre: true },
    });

    const pdf = await renderTarifarioPdf({
      empresaNombre: empresa?.nombre ?? tarifario.empresa.nombre,
      empresaNit: empresa?.nit ?? tarifario.empresa.nit,
      contactoNombre: empresa?.contactoNombre ?? null,
      nombre: tarifario.nombre,
      alcance: tarifario.alcance,
      version: tarifario.version,
      estado: tarifario.estado,
      vigenteDesde: tarifario.vigenteDesde,
      vigenteHasta: tarifario.vigenteHasta,
      fechaEmision: new Date(),
      notas: tarifario.notas,
      items: tarifario.items.map((i) => ({
        nombrePublico: i.nombrePublico,
        tipoCalculo: i.tipoCalculo,
        disparador: i.disparador,
        unidad: i.unidad,
        valor: i.valor,
        valorAdicional: i.valorAdicional,
        porcentajeBps: i.porcentajeBps,
        minimos: minimosDe(i.minimos),
        conceptoCosto: i.conceptoCosto,
        tramos: tramosDe(i.tramos),
        aplicaIva: i.aplicaIva,
        notas: i.notas,
      })),
    });

    const filename = `tarifas-${tarifario.empresa.nombre}-v${tarifario.version}.pdf`
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "");

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isDomainError(error)) return domainErrorResponse(error);
    throw error;
  }
}
