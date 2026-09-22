/**
 * GET /api/archivos/clientes
 *
 * Vista "Por cliente" del explorador de archivos: todos los clientes con
 * cuántos DOs y documentos tienen. Datos de la plataforma (Prisma), no del
 * bucket — así aparece cualquier cliente aunque su carpeta en el bucket se
 * llame distinto (ver `lib/storage/explorador-clientes.ts`).
 *
 * ADMIN, REVISOR y OPERATIVO — mismos roles que /api/archivos.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { StorageConfigError } from "@/lib/storage/config";
import { listarClientesConArchivos } from "@/lib/storage/explorador-clientes";

export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const clientes = await listarClientesConArchivos();
    return jsonResponse({ clientes });
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return NextResponse.json(
        { error: `El almacenamiento no está configurado: ${error.message}` },
        { status: 503 },
      );
    }
    const mensaje = error instanceof Error ? error.message : "Fallo al listar los clientes";
    return NextResponse.json(
      { error: `No fue posible consultar los clientes: ${mensaje}` },
      { status: 502 },
    );
  }
}
