/**
 * Enlaces firmados por la app para subir y bajar objetos de MinIO a través de
 * `/api/storage/objeto`, en vez de URLs prefirmadas de MinIO.
 *
 * Por qué: la URL prefirmada de MinIO lleva el host en la firma, así que el
 * navegador tiene que poder alcanzar a MinIO directamente (dominio público,
 * HTTPS, CORS). En producción eso nunca se configuró y la subida de archivos
 * moría con "Error de red". Con el proxy, el navegador y el MCP hablan solo
 * con la app; MinIO sigue en la red interna de Docker.
 *
 * El enlace es la credencial (igual que una URL prefirmada): HMAC-SHA256 sobre
 * método, clave, tipo, tamaño y vencimiento, con el secreto de la app.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type MetodoObjeto = "GET" | "PUT";

export interface AccesoObjeto {
  metodo: MetodoObjeto;
  storageKey: string;
  /** Solo PUT: tipo de contenido exigido. */
  contentType?: string;
  /** Solo PUT: tamaño exacto en bytes que se aceptará. */
  sizeBytes?: number;
  /** Segundos desde epoch en que vence. */
  exp: number;
}

export const RUTA_OBJETO = "/api/storage/objeto";

function secreto(): string {
  const s = process.env.STORAGE_PROXY_SECRET || process.env.BETTER_AUTH_SECRET || process.env.MINIO_SECRET_KEY;
  if (!s) throw new Error("Falta BETTER_AUTH_SECRET (o STORAGE_PROXY_SECRET) para firmar enlaces de archivos");
  return s;
}

function cadenaAFirmar(a: AccesoObjeto): string {
  return [a.metodo, a.storageKey, a.contentType ?? "", a.sizeBytes ?? "", a.exp].join("\n");
}

export function firmar(a: AccesoObjeto, clave: string = secreto()): string {
  return createHmac("sha256", clave).update(cadenaAFirmar(a)).digest("base64url");
}

/** Query string del enlace firmado (sin host). */
export function rutaFirmada(a: AccesoObjeto, clave?: string): string {
  const q = new URLSearchParams({ key: a.storageKey, metodo: a.metodo, exp: String(a.exp) });
  if (a.contentType) q.set("ct", a.contentType);
  if (a.sizeBytes !== undefined) q.set("size", String(a.sizeBytes));
  q.set("sig", firmar(a, clave));
  return `${RUTA_OBJETO}?${q.toString()}`;
}

/** Enlace absoluto: la app conoce su propia URL pública por `NEXT_PUBLIC_APP_URL`. */
export function urlFirmada(a: AccesoObjeto, base: string = process.env.NEXT_PUBLIC_APP_URL ?? ""): string {
  return `${base.replace(/\/$/, "")}${rutaFirmada(a)}`;
}

export type ResultadoVerificacion =
  | { ok: true; acceso: AccesoObjeto }
  | { ok: false; motivo: string };

/** Reconstruye el acceso desde la query y valida firma y vencimiento. */
export function verificarEnlace(
  params: URLSearchParams,
  metodoEsperado: MetodoObjeto,
  ahora: number = Math.floor(Date.now() / 1000),
  clave?: string,
): ResultadoVerificacion {
  const storageKey = params.get("key") ?? "";
  const metodo = params.get("metodo");
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  const ct = params.get("ct") ?? undefined;
  const sizeRaw = params.get("size");
  const sizeBytes = sizeRaw === null ? undefined : Number(sizeRaw);

  if (!storageKey || !metodo || !sig) return { ok: false, motivo: "Enlace incompleto" };
  if (metodo !== metodoEsperado) return { ok: false, motivo: "El enlace no es para esta operación" };
  if (!Number.isFinite(exp)) return { ok: false, motivo: "Enlace sin vencimiento" };
  if (sizeRaw !== null && (!Number.isInteger(sizeBytes) || (sizeBytes as number) < 0)) {
    return { ok: false, motivo: "Tamaño inválido" };
  }

  const acceso: AccesoObjeto = { metodo: metodoEsperado, storageKey, contentType: ct, sizeBytes, exp };
  const esperada = Buffer.from(firmar(acceso, clave));
  const recibida = Buffer.from(sig);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
    return { ok: false, motivo: "Firma inválida" };
  }
  if (exp < ahora) return { ok: false, motivo: "Enlace vencido" };

  return { ok: true, acceso };
}
