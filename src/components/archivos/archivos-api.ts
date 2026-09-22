/**
 * Cliente del explorador de archivos. Consume GET /api/archivos?prefix=…
 */

import { CATEGORIAS_DOCUMENTO, formatBytes } from "@/components/documentos/documentos-api";

export type Miga = { nombre: string; prefix: string };

export type CarpetaRow = {
  nombre: string;
  prefix: string;
  tramite?: { id: string; consecutivo: string; clienteId: string; cliente: string; estado: string };
};

export type ArchivoRow = {
  key: string;
  nombre: string;
  nombreRegistrado?: string;
  categoria?: string;
  tramite?: { id: string; consecutivo: string };
  subidoPor?: string;
  eliminado?: boolean;
  size: number;
  lastModified?: string;
  urlVer: string;
  urlDescargar: string;
};

export type CarpetaData = {
  prefix: string;
  migas: Miga[];
  carpetas: CarpetaRow[];
  archivos: ArchivoRow[];
  resumen: { carpetas: number; archivos: number; bytes: number };
  proveedor: { proveedor: string; nombreProveedor: string; bucket: string; endpoint: string; region?: string };
};

export class ArchivosApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ArchivosApiError";
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const payload: unknown = await res.json();
    if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  } catch {
    // ignore
  }
  return `Error ${res.status}`;
}

function mapTramiteCarpeta(raw: unknown): CarpetaRow["tramite"] | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    id: String(raw.id ?? ""),
    consecutivo: String(raw.consecutivo ?? ""),
    clienteId: String(raw.clienteId ?? ""),
    cliente: String(raw.cliente ?? ""),
    estado: String(raw.estado ?? ""),
  };
}

function mapCarpeta(raw: unknown): CarpetaRow | null {
  if (!isRecord(raw)) return null;
  const tramite = mapTramiteCarpeta(raw.tramite);
  return {
    nombre: String(raw.nombre ?? ""),
    prefix: String(raw.prefix ?? ""),
    ...(tramite ? { tramite } : {}),
  };
}

function mapArchivo(raw: unknown): ArchivoRow | null {
  if (!isRecord(raw)) return null;
  const tramite = isRecord(raw.tramite)
    ? { id: String(raw.tramite.id ?? ""), consecutivo: String(raw.tramite.consecutivo ?? "") }
    : undefined;
  return {
    key: String(raw.key ?? ""),
    nombre: String(raw.nombre ?? ""),
    nombreRegistrado: typeof raw.nombreRegistrado === "string" ? raw.nombreRegistrado : undefined,
    categoria: typeof raw.categoria === "string" ? raw.categoria : undefined,
    tramite,
    subidoPor: typeof raw.subidoPor === "string" ? raw.subidoPor : undefined,
    eliminado: raw.eliminado === true,
    size: typeof raw.size === "number" ? raw.size : Number(raw.size ?? 0),
    lastModified: typeof raw.lastModified === "string" ? raw.lastModified : undefined,
    urlVer: String(raw.urlVer ?? ""),
    urlDescargar: String(raw.urlDescargar ?? ""),
  };
}

export async function fetchCarpeta(prefix: string, signal?: AbortSignal): Promise<CarpetaData> {
  const q = new URLSearchParams();
  if (prefix) q.set("prefix", prefix);
  const res = await fetch(`/api/archivos${q.size ? `?${q.toString()}` : ""}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new ArchivosApiError(await parseErrorMessage(res), res.status);

  const payload: unknown = await res.json();
  if (!isRecord(payload)) throw new ArchivosApiError("Respuesta inválida del servidor");

  const migas = Array.isArray(payload.migas)
    ? payload.migas
        .filter(isRecord)
        .map((m) => ({ nombre: String(m.nombre ?? ""), prefix: String(m.prefix ?? "") }))
    : [];
  const resumen = isRecord(payload.resumen) ? payload.resumen : {};
  const proveedor = isRecord(payload.proveedor) ? payload.proveedor : {};

  return {
    prefix: String(payload.prefix ?? ""),
    migas,
    carpetas: Array.isArray(payload.carpetas)
      ? payload.carpetas.map(mapCarpeta).filter((c): c is CarpetaRow => c !== null)
      : [],
    archivos: Array.isArray(payload.archivos)
      ? payload.archivos.map(mapArchivo).filter((a): a is ArchivoRow => a !== null)
      : [],
    resumen: {
      carpetas: Number(resumen.carpetas ?? 0),
      archivos: Number(resumen.archivos ?? 0),
      bytes: Number(resumen.bytes ?? 0),
    },
    proveedor: {
      proveedor: String(proveedor.proveedor ?? "otro"),
      nombreProveedor: String(proveedor.nombreProveedor ?? "Almacenamiento"),
      bucket: String(proveedor.bucket ?? ""),
      endpoint: String(proveedor.endpoint ?? ""),
      region: typeof proveedor.region === "string" ? proveedor.region : undefined,
    },
  };
}

// ─── Helpers de presentación ────────────────────────────────────────────────

export { formatBytes };

export function etiquetaCategoria(categoria?: string): string | undefined {
  if (!categoria) return undefined;
  return CATEGORIAS_DOCUMENTO.find((c) => c.value === categoria)?.label ?? categoria;
}

export function formatFechaHora(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });
}

/** Sube un nivel: `tramites/DO-1/BL/` → `tramites/DO-1/`; `tramites/` → ``. */
export function prefijoPadre(prefix: string): string {
  const partes = prefix.split("/").filter(Boolean);
  partes.pop();
  return partes.length ? `${partes.join("/")}/` : "";
}

/** `DO.BUN26-0026` → `tramites/DO-BUN26-0026/` (misma regla que la app usa al subir). */
export function prefijoDeConsecutivo(consecutivo: string): string {
  const carpeta = consecutivo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return carpeta ? `tramites/${carpeta}/` : "tramites/";
}
