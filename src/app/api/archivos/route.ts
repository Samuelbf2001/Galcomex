/**
 * GET /api/archivos?prefix=tramites/DO-BUN26-0026/
 *
 * Explorador de archivos del bucket (ver `lib/storage/explorador.ts`): devuelve
 * SOLO el nivel pedido (carpetas + archivos) con enlaces firmados de ver y
 * descargar que vencen en 10 minutos. Vacío = raíz del bucket.
 *
 * ADMIN, REVISOR y OPERATIVO. SOCIO no: solo ve sus trámites y este listado
 * es de todo el bucket. La papelera (`deleted/`) solo la ve ADMIN.
 */

export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import type { Rol } from "@/lib/auth/auth";
import { jsonResponse } from "@/lib/http/json";
import { StorageConfigError } from "@/lib/storage/config";
import { listarCarpeta } from "@/lib/storage/explorador";
import { StorageValidationError } from "@/lib/storage/service";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const carpeta = await listarCarpeta({
      prefix: request.nextUrl.searchParams.get("prefix"),
      rol: session.user.rol as Rol,
    });

    return jsonResponse(carpeta);
  } catch (error) {
    if (error instanceof StorageValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof StorageConfigError) {
      return NextResponse.json(
        { error: `El almacenamiento no está configurado: ${error.message}` },
        { status: 503 },
      );
    }
    const mensaje = error instanceof Error ? error.message : "Fallo al listar el almacenamiento";
    return NextResponse.json(
      { error: `No fue posible consultar el almacenamiento: ${mensaje}` },
      { status: 502 },
    );
  }
}
