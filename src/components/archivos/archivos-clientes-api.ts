/**
 * Cliente de la vista "Por cliente" del explorador. Consume
 * GET /api/archivos/clientes y GET /api/archivos/clientes/:id.
 */

import { ArchivosApiError } from "@/components/archivos/archivos-api";

export type ClienteConArchivos = {
  id: string;
  nombre: string;
  nit: string;
  dos: number;
  documentos: number;
  sueltosPrefix?: string;
};

export type TramiteDeCliente = {
  id: string;
  consecutivo: string;
  estado: string;
  documentos: number;
  prefix: string;
};

export type ClienteConDetalle = {
  id: string;
  nombre: string;
  nit: string;
  tramites: TramiteDeCliente[];
  sueltosPrefix?: string;
};

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

function mapCliente(raw: unknown): ClienteConArchivos | null {
  if (!isRecord(raw)) return null;
  return {
    id: String(raw.id ?? ""),
    nombre: String(raw.nombre ?? ""),
    nit: String(raw.nit ?? ""),
    dos: Number(raw.dos ?? 0),
    documentos: Number(raw.documentos ?? 0),
    sueltosPrefix: typeof raw.sueltosPrefix === "string" ? raw.sueltosPrefix : undefined,
  };
}

export async function fetchClientesConArchivos(signal?: AbortSignal): Promise<ClienteConArchivos[]> {
  const res = await fetch("/api/archivos/clientes", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new ArchivosApiError(await parseErrorMessage(res), res.status);
  const payload: unknown = await res.json();
  const lista = isRecord(payload) && Array.isArray(payload.clientes) ? payload.clientes : [];
  return lista.map(mapCliente).filter((c): c is ClienteConArchivos => c !== null);
}

export async function fetchClienteConArchivos(id: string, signal?: AbortSignal): Promise<ClienteConDetalle> {
  const res = await fetch(`/api/archivos/clientes/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new ArchivosApiError(await parseErrorMessage(res), res.status);
  const payload: unknown = await res.json();
  if (!isRecord(payload)) throw new ArchivosApiError("Respuesta inválida del servidor");

  const tramites = Array.isArray(payload.tramites)
    ? payload.tramites
        .filter(isRecord)
        .map((t) => ({
          id: String(t.id ?? ""),
          consecutivo: String(t.consecutivo ?? ""),
          estado: String(t.estado ?? ""),
          documentos: Number(t.documentos ?? 0),
          prefix: String(t.prefix ?? ""),
        }))
    : [];

  return {
    id: String(payload.id ?? ""),
    nombre: String(payload.nombre ?? ""),
    nit: String(payload.nit ?? ""),
    sueltosPrefix: typeof payload.sueltosPrefix === "string" ? payload.sueltosPrefix : undefined,
    tramites,
  };
}
