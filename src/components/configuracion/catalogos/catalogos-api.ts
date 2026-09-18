/**
 * Cliente HTTP de Configuración → Catálogos: conceptos de venta y eventos.
 * Mismo estilo defensivo que `siigo-productos-api.ts` (parseo sin `any`,
 * nunca se confía en la forma del JSON) y reutiliza `patchJson`/`postJson`
 * de `respuesta-api.ts` para leer el mensaje real de error de Zod/dominio.
 */

import { patchJson, postJson } from "@/components/configuracion/respuesta-api";
import type { TipoCalculoTarifa, UnidadTarifa } from "@/components/clientes/tarifas-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Conceptos de venta ───────────────────────────────────────────────────────

export type ConceptoSiigoProductoRef = { id: string; codigo: string; nombre: string };

export type ConceptoVentaRow = {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  siigoProducto: ConceptoSiigoProductoRef | null;
  aplicaIva: boolean;
  tipoCalculoSugerido: TipoCalculoTarifa | null;
  unidadSugerida: UnidadTarifa | null;
  orden: number;
  activo: boolean;
  notas: string | null;
  /** Cuántos ítems de tarifario lo usan hoy (avisa antes de desactivarlo). */
  itemsEnlazados: number;
};

/** Campos editables de un concepto (sin `id` ni `codigo`, que no se cambia). */
export type ConceptoVentaFormValues = {
  nombre: string;
  descripcion: string | null;
  siigoProductoId: string | null;
  aplicaIva: boolean;
  tipoCalculoSugerido: TipoCalculoTarifa | null;
  unidadSugerida: UnidadTarifa | null;
  orden: number;
  activo: boolean;
  notas: string | null;
};

function normalizeSiigoProductoRef(value: unknown): ConceptoSiigoProductoRef | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const codigo = typeof value.codigo === "string" ? value.codigo : "";
  if (!id || !codigo) return null;
  return { id, codigo, nombre: typeof value.nombre === "string" ? value.nombre : "" };
}

function normalizeConcepto(row: unknown): ConceptoVentaRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : "";
  const codigo = typeof row.codigo === "string" ? row.codigo : "";
  if (!id || !codigo) return null;
  return {
    id,
    codigo,
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    descripcion: typeof row.descripcion === "string" ? row.descripcion : null,
    siigoProducto: normalizeSiigoProductoRef(row.siigoProducto),
    aplicaIva: row.aplicaIva === true,
    tipoCalculoSugerido:
      typeof row.tipoCalculoSugerido === "string"
        ? (row.tipoCalculoSugerido as TipoCalculoTarifa)
        : null,
    unidadSugerida:
      typeof row.unidadSugerida === "string" ? (row.unidadSugerida as UnidadTarifa) : null,
    orden: typeof row.orden === "number" ? row.orden : 0,
    activo: row.activo === true,
    notas: typeof row.notas === "string" ? row.notas : null,
    itemsEnlazados: typeof row.itemsEnlazados === "number" ? row.itemsEnlazados : 0,
  };
}

export async function fetchConceptosVenta(signal?: AbortSignal): Promise<ConceptoVentaRow[]> {
  const response = await fetch("/api/configuracion/catalogos/conceptos", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("No fue posible cargar los conceptos de venta.");

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.conceptos)) return [];
  return payload.conceptos
    .map(normalizeConcepto)
    .filter((c): c is ConceptoVentaRow => c !== null);
}

export async function crearConceptoVenta(
  codigo: string,
  valores: ConceptoVentaFormValues,
): Promise<ConceptoVentaRow> {
  const payload = await postJson(
    "/api/configuracion/catalogos/conceptos",
    { codigo, ...valores },
    "No fue posible crear el concepto.",
  );
  const concepto = isRecord(payload) ? normalizeConcepto(payload.concepto) : null;
  if (!concepto) throw new Error("Respuesta inesperada del servidor.");
  return concepto;
}

export async function actualizarConceptoVenta(
  id: string,
  valores: ConceptoVentaFormValues,
): Promise<ConceptoVentaRow> {
  const payload = await patchJson(
    "/api/configuracion/catalogos/conceptos",
    { id, ...valores },
    "No fue posible guardar el concepto.",
  );
  const concepto = isRecord(payload) ? normalizeConcepto(payload.concepto) : null;
  if (!concepto) throw new Error("Respuesta inesperada del servidor.");
  return concepto;
}

// ─── Eventos del catálogo ─────────────────────────────────────────────────────

export type EventoCatalogoRow = {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  documentosRequeridos: string[];
  permiteCantidad: boolean;
  orden: number;
  activo: boolean;
  /** Ítems de tarifario que dependen del evento. */
  itemsTarifario: number;
  /** Veces que se ha marcado en un trámite. */
  tramitesMarcados: number;
};

/** Campos editables de un evento (el `codigo` es inmutable). */
export type EventoCatalogoFormValues = {
  nombre: string;
  descripcion: string | null;
  documentosRequeridos: string[];
  permiteCantidad: boolean;
  orden: number;
  activo: boolean;
};

function normalizeEvento(row: unknown): EventoCatalogoRow | null {
  if (!isRecord(row)) return null;
  const codigo = typeof row.codigo === "string" ? row.codigo : "";
  if (!codigo) return null;
  return {
    codigo,
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    descripcion: typeof row.descripcion === "string" ? row.descripcion : null,
    documentosRequeridos: Array.isArray(row.documentosRequeridos)
      ? row.documentosRequeridos.filter((d): d is string => typeof d === "string")
      : [],
    permiteCantidad: row.permiteCantidad === true,
    orden: typeof row.orden === "number" ? row.orden : 0,
    activo: row.activo === true,
    itemsTarifario: typeof row.itemsTarifario === "number" ? row.itemsTarifario : 0,
    tramitesMarcados: typeof row.tramitesMarcados === "number" ? row.tramitesMarcados : 0,
  };
}

export async function fetchEventosCatalogoAdmin(
  signal?: AbortSignal,
): Promise<EventoCatalogoRow[]> {
  const response = await fetch("/api/configuracion/catalogos/eventos", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("No fue posible cargar el catálogo de eventos.");

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.eventos)) return [];
  return payload.eventos.map(normalizeEvento).filter((e): e is EventoCatalogoRow => e !== null);
}

export async function actualizarEventoCatalogo(
  codigo: string,
  valores: EventoCatalogoFormValues,
): Promise<EventoCatalogoRow> {
  const payload = await patchJson(
    "/api/configuracion/catalogos/eventos",
    { codigo, ...valores },
    "No fue posible guardar el evento.",
  );
  const evento = isRecord(payload) ? normalizeEvento(payload.evento) : null;
  if (!evento) throw new Error("Respuesta inesperada del servidor.");
  return evento;
}
