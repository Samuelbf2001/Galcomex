/**
 * GET /api/borradores/[id]/siigo-import
 * Descarga el archivo XLSX en formato de importación de FACTURAS DE VENTA de SIIGO Nube.
 * Roles: ADMIN, REVISOR.
 *
 * Los códigos contables propios de la cuenta SIIGO se leen de variables de entorno
 * (ver .env.example: SIIGO_IMPORT_*). Mientras no estén configurados se emiten con
 * marcadores para que el contador los complete antes de cargar a SIIGO.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { esObservacionDevolucion } from "@/lib/borradores/devolver";
import { prisma } from "@/lib/db/prisma";
import {
  construirFacturaSiigoImportXlsx,
  lineasImportDesdeBorrador,
  nombreArchivoSiigoImport,
  SIIGO_IMPORT_CONTENT_TYPE,
  type SiigoFacturaImportDto,
  type SiigoImportConfig,
} from "@/lib/export/siigo-import";

type RouteParams = { params: Promise<{ id: string }> };

function leerConfig(): SiigoImportConfig {
  return {
    tipoComprobante: process.env.SIIGO_IMPORT_TIPO_COMPROBANTE ?? "<TIPO_FV>",
    codProducto: process.env.SIIGO_IMPORT_COD_PRODUCTO ?? "<COD_PRODUCTO>",
    idVendedor: process.env.SIIGO_IMPORT_ID_VENDEDOR ?? "",
    codIva: process.env.SIIGO_IMPORT_COD_IVA ?? "",
    codFormaPago: process.env.SIIGO_IMPORT_COD_FORMA_PAGO ?? "",
  };
}

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
          cliente: { select: { nit: true } },
        },
      },
      factura: { select: { fecha: true } },
    },
  });

  if (!borrador) {
    return NextResponse.json({ error: "Borrador no encontrado" }, { status: 404 });
  }

  // Líneas de la factura = las LineaRevision (manuales + fijas), sin volver a
  // sumar los campos espejo: Σ S − retenciones = AC = totalFactura al centavo.
  const lineas = lineasImportDesdeBorrador(borrador.lineasRevision, {
    comisionCentavos: borrador.comisionCentavos,
    ivaComisionCentavos: borrador.ivaComisionCentavos,
    impuesto4x1000Centavos: borrador.impuesto4x1000Centavos,
    costosBancariosCentavos: borrador.costosBancariosCentavos,
  });

  // Observaciones SIIGO (col AE): comentarios de cabecera unidos con saltos de
  // línea. Si el borrador no tiene comentarios, fallback al DO consecutivo.
  // Se excluyen las notas internas "DEVUELTO POR …" (lib/borradores/devolver.ts):
  // son de revisión, no texto para la factura del cliente.
  const comentarios = Array.isArray(borrador.comentariosCabecera)
    ? (borrador.comentariosCabecera as unknown[]).filter(
        (c): c is string =>
          typeof c === "string" && c.trim().length > 0 && !esObservacionDevolucion(c),
      )
    : [];

  const observaciones =
    comentarios.length > 0
      ? comentarios.join("\n")
      : borrador.tramite
        ? `DO ${borrador.tramite.consecutivo}`
        : null;

  const dto: SiigoFacturaImportDto = {
    identificacionTercero: borrador.tramite?.cliente?.nit ?? "",
    fecha: borrador.factura?.fecha ?? borrador.fechaFactura ?? new Date(),
    observaciones,
    lineas,
    totalFormaPago: borrador.totalFacturaCentavos,
  };

  const config = leerConfig();
  config.consecutivo = borrador.numFacturaSiigo ?? undefined;

  const buffer = construirFacturaSiigoImportXlsx(dto, config);
  const filename = nombreArchivoSiigoImport(borrador.numFacturaSiigo, borradorId);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": SIIGO_IMPORT_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
