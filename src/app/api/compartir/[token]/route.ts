/**
 * GET /api/compartir/[token] — abre un enlace compartido de documento.
 *
 * Es el ÚNICO endpoint del sistema sin autenticación, así que está acotado a
 * propósito:
 *  - el token es lo único que autoriza, y son 32 bytes aleatorios (no derivable
 *    del id del documento ni adivinable);
 *  - no expone el archivo directamente: emite una URL prefirmada corta, la
 *    misma que usa el resto del sistema, así que aunque alguien reenvíe el
 *    enlace final este caduca en minutos;
 *  - responde igual (404) para token inexistente, expirado o revocado, para no
 *    confirmarle a nadie que un token existió;
 *  - cuenta cada apertura, que es lo que permite notar si un enlace circuló más
 *    de lo previsto.
 */

import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { enlaceEsUtilizable } from "@/lib/documentos/enlaces";
import { jsonResponse } from "@/lib/http/json";
import { createPresignedDownloadUrl } from "@/lib/storage/service";

type RouteContext = { params: Promise<{ token: string }> };

/** Misma respuesta para inexistente, expirado y revocado: no filtrar nada. */
function noDisponible() {
  return NextResponse.json(
    { error: "Este enlace no está disponible." },
    { status: 404 },
  );
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { token } = await context.params;

  const enlace = await prisma.enlaceDocumento.findUnique({
    where: { token },
    select: {
      id: true,
      expiresAt: true,
      revocadoEn: true,
      documento: {
        select: {
          id: true,
          nombreArchivo: true,
          mimeType: true,
          storageKey: true,
          eliminado: true,
        },
      },
    },
  });

  if (!enlace || !enlaceEsUtilizable(enlace)) {
    return noDisponible();
  }

  // El documento pudo eliminarse (soft-delete) después de compartirse.
  if (enlace.documento.eliminado) {
    return noDisponible();
  }

  const presigned = await createPresignedDownloadUrl({
    storageKey: enlace.documento.storageKey,
  });

  // Contador de aperturas: incremento atómico, y si fallara no debe impedir la
  // descarga — el contador es para auditoría, no una precondición de acceso.
  await prisma.enlaceDocumento
    .update({ where: { id: enlace.id }, data: { aperturas: { increment: 1 } } })
    .catch(() => undefined);

  return jsonResponse({
    nombreArchivo: enlace.documento.nombreArchivo,
    mimeType: enlace.documento.mimeType,
    url: presigned.url,
    expiraEn: presigned.expiresInSeconds,
  });
}
