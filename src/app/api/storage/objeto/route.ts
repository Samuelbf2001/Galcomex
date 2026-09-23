/**
 * GET|PUT /api/storage/objeto?key=…&metodo=…&exp=…&sig=…
 *
 * Proxy firmado hacia la bodega S3 (ver `lib/storage/proxy.ts`). El enlace es la
 * credencial, igual que una URL prefirmada: no exige sesión, vence en minutos
 * y solo sirve para ese objeto y esa operación. Así el navegador y el MCP
 * nunca hablan con la bodega (MinIO, R2…) y producción no necesita exponerla.
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
import { nombreSeguroParaDescarga } from "@/lib/storage/explorador";
import { verificarEnlace } from "@/lib/storage/proxy";

function rechazo(motivo: string, status = 403) {
  return NextResponse.json({ error: motivo }, { status });
}

/**
 * Tipos que la app sabe previsualizar (visor de documentos, miniaturas):
 * PDF y las dos imágenes que acepta la bodega (JPG/PNG). Cualquier otro tipo
 * se sirve SIEMPRE como descarga (`attachment`) y con
 * `application/octet-stream`, sin importar lo que pida `?descargar=`: un XLS,
 * ZIP o EML no debe poder "abrirse" dentro del navegador (riesgo de XSS/
 * MIME-sniffing si el archivo trae HTML disfrazado de otra extensión).
 */
const TIPOS_PREVISUALIZABLES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/**
 * Los archivos cargados por fuera de la app (rclone, mc) pueden venir sin
 * `Content-Type`; se deduce por extensión para que el navegador los abra.
 */
function tipoPorExtension(nombre: string): string {
  const ext = nombre.toLowerCase().slice(nombre.lastIndexOf(".") + 1);
  const tipos: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    csv: "text/csv",
    txt: "text/plain",
  };
  return tipos[ext] ?? "application/octet-stream";
}

/**
 * `Content-Disposition` con el nombre real (espacios, tildes): un `filename`
 * ASCII de respaldo y el `filename*` UTF-8 (RFC 5987) que los navegadores
 * modernos prefieren. Así "Factura BAQ-18453.pdf" no baja como "Factura%20…".
 */
function contentDisposition(tipo: "inline" | "attachment", nombre: string): string {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
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
    // `nombre` no va firmado: solo decide cómo se llama el archivo al guardarlo
    // (el explorador manda el nombre real registrado en la BD, no el uuid).
    const nombre = nombreSeguroParaDescarga(
      request.nextUrl.searchParams.get("nombre"),
      storageKey.split("/").pop() ?? "archivo",
    );
    const tipoGuardado = stat.metaData?.["content-type"];
    // MinIO/S3 guardan `binary/octet-stream` o `application/octet-stream` cuando
    // el archivo se subió sin tipo (rclone, mc): en ese caso vale más la extensión.
    const tipoDetectado =
      !tipoGuardado || /octet-stream$/i.test(tipoGuardado) ? tipoPorExtension(nombre) : tipoGuardado;
    const previsualizable = TIPOS_PREVISUALIZABLES.has(tipoDetectado);
    const pideInline = request.nextUrl.searchParams.get("descargar") !== "1";
    const disposicion = previsualizable && pideInline ? "inline" : "attachment";
    // Si no es un tipo previsualizable el navegador nunca debe "abrirlo": se
    // fuerza octet-stream aunque la bodega tenga guardado otro Content-Type.
    const tipo = previsualizable ? tipoDetectado : "application/octet-stream";

    return new Response(Readable.toWeb(objeto) as unknown as globalThis.ReadableStream, {
      status: 200,
      headers: {
        "content-type": tipo,
        "content-length": String(stat.size),
        "content-disposition": contentDisposition(disposicion, nombre),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  } catch (error) {
    const codigo = (error as { code?: string })?.code;
    if (codigo === "NotFound" || codigo === "NoSuchKey") return rechazo("El archivo no existe", 404);
    const mensaje = error instanceof Error ? error.message : "Fallo al leer el archivo";
    return NextResponse.json({ error: `No fue posible leer el archivo: ${mensaje}` }, { status: 502 });
  }
}
