/**
 * GET /api/archivos/clientes/:id
 *
 * Detalle de un cliente en la vista "Por cliente": sus DOs (cada uno con la
 * carpeta del explorador correspondiente) y, si existen, los documentos
 * sueltos del histórico. Ver `lib/storage/explorador-clientes.ts`.
 *
 * ADMIN, REVISOR y OPERATIVO — mismos roles que /api/archivos.
 */
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { StorageConfigError } from "@/lib/storage/config";
import { listarArchivosDeCliente } from "@/lib/storage/explorador-clientes";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  try {
    const cliente = await listarArchivosDeCliente(id);
    if (!cliente) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
    }
    return jsonResponse(cliente);
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return NextResponse.json(
        { error: `El almacenamiento no está configurado: ${error.message}` },
        { status: 503 },
      );
    }
    const mensaje = error instanceof Error ? error.message : "Fallo al consultar el cliente";
    return NextResponse.json(
      { error: `No fue posible consultar el cliente: ${mensaje}` },
      { status: 502 },
    );
  }
}
