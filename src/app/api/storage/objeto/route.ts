/**
 * GET|PUT /api/storage/objeto?key=…&metodo=…&exp=…&sig=…
 *
 * Proxy firmado hacia MinIO (ver `lib/storage/proxy.ts`). El enlace es la
 * credencial, igual que una URL prefirmada: no exige sesión, vence en minutos
 * y solo sirve para ese objeto y esa operación. Así el navegador y el MCP
 * nunca hablan con MinIO directamente y producción no necesita exponerlo.
 *
 *   PUT  — sube el cuerpo tal cual (tipo y tamaño exactos a lo firmado).
 *   GET  — devuelve el objeto en streaming con su tipo y nombre.
 */

export const runtime = "nodejs";

import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { NextResponse, type NextRequest } from "next/server";

import { getStorageClient } from "@/lib/storage/client";
import { getStorageConfig } from "@/lib/storage/config";
import { verificarEnlace } from "@/lib/storage/proxy";

function rechazo(motivo: string, status = 403) {
  return NextResponse.json({ error: motivo }, { status });
}

export async function PUT(request: NextRequest) {
  const v = verificarEnlace(request.nextUrl.searchParams, "PUT");
  if (!v.ok) return rechazo(v.motivo);

  const { storageKey, contentType, sizeBytes } = v.acceso;
  if (!contentType || sizeBytes === undefined) return rechazo("El enlace de subida no trae tipo o tamaño");

  const declarado = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declarado) && declarado !== sizeBytes) {
    return rechazo(`El archivo pesa ${declarado} bytes y el enlace fue firmado para ${sizeBytes}`, 400);
  }
  if (!request.body) return rechazo("Sin contenido", 400);

  const { bucket } = getStorageConfig();
  const cuerpo = Readable.fromWeb(request.body as unknown as NodeReadableStream);

  try {
    await getStorageClient().putObject(bucket, storageKey, cuerpo, sizeBytes, {
      "Content-Type": contentType,
    });
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : "Fallo al guardar el archivo";
    return NextResponse.json({ error: `No fue posible guardar el archivo: ${mensaje}` }, { status: 502 });
  }

  return NextResponse.json({ storageKey, sizeBytes }, { status: 200 });
}

export async function GET(request: NextRequest) {
  const v = verificarEnlace(request.nextUrl.searchParams, "GET");
  if (!v.ok) return rechazo(v.motivo);

  const { storageKey } = v.acceso;
  const { bucket } = getStorageConfig();
  const cliente = getStorageClient();

  try {
    const stat = await cliente.statObject(bucket, storageKey);
    const objeto = await cliente.getObject(bucket, storageKey);
    const nombre = storageKey.split("/").pop() ?? "archivo";
    const tipo = stat.metaData?.["content-type"] ?? "application/octet-stream";
    const disposicion = request.nextUrl.searchParams.get("descargar") === "1" ? "attachment" : "inline";

    return new Response(Readable.toWeb(objeto) as unknown as globalThis.ReadableStream, {
      status: 200,
      headers: {
        "content-type": tipo,
        "content-length": String(stat.size),
        "content-disposition": `${disposicion}; filename="${encodeURIComponent(nombre)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const codigo = (error as { code?: string })?.code;
    if (codigo === "NotFound" || codigo === "NoSuchKey") return rechazo("El archivo no existe", 404);
    const mensaje = error instanceof Error ? error.message : "Fallo al leer el archivo";
    return NextResponse.json({ error: `No fue posible leer el archivo: ${mensaje}` }, { status: 502 });
  }
}
