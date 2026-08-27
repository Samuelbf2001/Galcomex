import { NextResponse, type NextRequest } from "next/server";

import { resolverEnlacePublico } from "@/lib/documentos/enlaces";
import { jsonResponse } from "@/lib/http/json";
import { createPresignedDownloadUrl } from "@/lib/storage/service";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ token: string }>;
};

/**
 * GET /api/compartir/[token]
 * Endpoint PÚBLICO (sin sesión) usado por la página /compartir/[token].
 * Valida el token (existe, no revocado, no vencido, documento no eliminado)
 * y, si es válido, devuelve el nombre del archivo + una URL de descarga
 * prefirmada de MinIO generada server-side (mismo mecanismo que el resto de
 * la app — createPresignedDownloadUrl de src/lib/storage/service.ts).
 *
 * Si el token no es válido, responde SIEMPRE el mismo mensaje genérico
 * (404 "Enlace no disponible") sin filtrar si el motivo fue que no existe,
 * está vencido, revocado o el documento fue eliminado.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { token } = await context.params;
  const resultado = await resolverEnlacePublico(token);

  if (!resultado.valido) {
    return NextResponse.json({ error: "Enlace no disponible" }, { status: 404 });
  }

  try {
    const presigned = await createPresignedDownloadUrl({
      storageKey: resultado.documento.storageKey,
    });

    return jsonResponse({
      nombreArchivo: resultado.documento.nombreArchivo,
      downloadUrl: presigned.url,
    });
  } catch {
    return NextResponse.json(
      { error: "No fue posible generar el enlace de descarga" },
      { status: 502 },
    );
  }
}
