/**
 * Helpers de API para el módulo de Anticipos.
 * Patrón idéntico a tramites-api.ts / pagos-api.ts.
 */

export type TipoRecaudo = "BANCOLOMBIA" | "OTROS_BANCOS" | "SUCURSAL" | "CORRESPONSAL" | "CAJERO";

export type TipoRecaudoOption = {
  value: TipoRecaudo;
  label: string;
  grupo: "DIGITAL" | "FISICO";
  costoFijo?: string;
};

export const TIPOS_RECAUDO: TipoRecaudoOption[] = [
  { value: "BANCOLOMBIA",  label: "Bancolombia (digital)",    grupo: "DIGITAL", costoFijo: "1950"  },
  { value: "OTROS_BANCOS", label: "Otros Bancos (digital)",   grupo: "DIGITAL", costoFijo: "2200"  },
  { value: "SUCURSAL",     label: "Sucursal Bancolombia",     grupo: "FISICO",  costoFijo: "11290" },
  { value: "CORRESPONSAL", label: "Corresponsal Bancolombia", grupo: "FISICO",  costoFijo: "6190"  },
  { value: "CAJERO",       label: "Cajero Bancolombia",       grupo: "FISICO",  costoFijo: "5200"  },
];

export type DesgloseDO = {
  aplicacionId: string;
  tramiteId: string;
  consecutivo: string;
  montoAplicado: string; // BigInt serializado
};

export type AnticipoRow = {
  id: string;
  clienteId: string;
  clienteNombre: string; // enriquecido localmente desde cliente
  monto: string; // BigInt serializado
  fecha: string; // ISO
  tipoRecaudo: TipoRecaudo;
  costoRecaudo: string; // BigInt serializado
  soporteKey: string | null;
  verificadoBanco: boolean;
  createdAt: string;
  updatedAt: string;
  aplicado: string; // BigInt serializado
  restante: string; // BigInt serializado
  aplicaciones: DesgloseDO[];
};

export type ClienteOption = {
  id: string;
  nombre: string;
  nit: string;
};

export type TramiteOption = {
  id: string;
  consecutivo: string;
  clienteNombre: string;
};

export type CreateAnticipoInput = {
  clienteId: string;
  monto: string; // BigInt serializado
  fecha: string; // ISO date string
  tipoRecaudo: TipoRecaudo;
  verificadoBanco: boolean;
};

export type AplicarAnticipoInput = {
  tramiteId: string;
  montoAplicado: string; // BigInt serializado
};

export class AnticiposApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnticiposApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  } catch {
    // ignore
  }
  return `Error ${response.status}`;
}

function normalizeDesglose(ap: unknown): DesgloseDO | null {
  if (!isRecord(ap)) return null;
  return {
    aplicacionId: String(ap.aplicacionId ?? ap.id ?? ""),
    tramiteId: String(ap.tramiteId ?? ""),
    consecutivo: String(ap.consecutivo ?? ""),
    montoAplicado: String(ap.montoAplicado ?? "0"),
  };
}

function normalizeAnticipo(raw: unknown, clientes: ClienteOption[]): AnticipoRow | null {
  if (!isRecord(raw)) return null;

  const clienteId = String(raw.clienteId ?? "");
  const clienteNombre =
    clientes.find((c) => c.id === clienteId)?.nombre ??
    (isRecord(raw.cliente) ? String(raw.cliente.nombre ?? "") : "");

  const aplicaciones = Array.isArray(raw.aplicaciones)
    ? raw.aplicaciones.map(normalizeDesglose).filter((d): d is DesgloseDO => d !== null)
    : [];

  return {
    id: String(raw.id ?? ""),
    clienteId,
    clienteNombre,
    monto: String(raw.monto ?? "0"),
    fecha: String(raw.fecha ?? ""),
    tipoRecaudo: (raw.tipoRecaudo as TipoRecaudo) ?? "BANCOLOMBIA",
    costoRecaudo: String(raw.costoRecaudo ?? "0"),
    soporteKey: typeof raw.soporteKey === "string" ? raw.soporteKey : null,
    verificadoBanco: raw.verificadoBanco === true,
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    aplicado: String(raw.aplicado ?? "0"),
    restante: String(raw.restante ?? "0"),
    aplicaciones,
  };
}

export async function fetchAnticipos(
  params: { conSaldo?: boolean; clienteId?: string } = {},
  signal?: AbortSignal,
): Promise<AnticipoRow[]> {
  const url = new URL("/api/anticipos", window.location.origin);
  if (params.conSaldo) url.searchParams.set("con_saldo", "true");
  if (params.clienteId) url.searchParams.set("clienteId", params.clienteId);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AnticiposApiError("No fue posible conectar con /api/anticipos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new AnticiposApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.anticipos)) return [];

  // Enriquecer con nombre del cliente si viene incluido en el payload
  const clientes: ClienteOption[] = [];
  return payload.anticipos
    .map((a) => normalizeAnticipo(a, clientes))
    .filter((a): a is AnticipoRow => a !== null);
}

export async function fetchClienteOptions(signal?: AbortSignal): Promise<ClienteOption[]> {
  let response: Response;
  try {
    response = await fetch("/api/clientes", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AnticiposApiError("No fue posible cargar los clientes.");
  }

  if (!response.ok) {
    throw new AnticiposApiError("Error al cargar clientes.", response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.clientes)) return [];

  return payload.clientes
    .filter(isRecord)
    .map((c) => ({
      id: String(c.id ?? ""),
      nombre: String(c.nombre ?? ""),
      nit: String(c.nit ?? ""),
    }))
    .filter((c) => c.id && c.nombre);
}

export async function fetchTramiteOptions(signal?: AbortSignal): Promise<TramiteOption[]> {
  let response: Response;
  try {
    response = await fetch("/api/tramites", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AnticiposApiError("No fue posible cargar los tramites.");
  }

  if (!response.ok) {
    throw new AnticiposApiError("Error al cargar tramites.", response.status);
  }

  const payload: unknown = await response.json().catch(() => null);

  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (isRecord(payload)) {
    items = Array.isArray(payload.tramites)
      ? payload.tramites
      : Array.isArray(payload.data)
        ? payload.data
        : [];
  }

  return items
    .filter(isRecord)
    .map((t) => ({
      id: String(t.id ?? ""),
      consecutivo: String(t.consecutivo ?? t.doNumber ?? ""),
      clienteNombre: isRecord(t.cliente)
        ? String(t.cliente.nombre ?? "")
        : String(t.clienteNombre ?? t.cliente ?? ""),
    }))
    .filter((t) => t.id && t.consecutivo);
}

export async function createAnticipo(input: CreateAnticipoInput): Promise<AnticipoRow> {
  const response = await fetch("/api/anticipos", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el anticipo (${response.status}).`;
    throw new AnticiposApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.anticipo)) {
    throw new AnticiposApiError("Respuesta de creación no válida.");
  }

  const raw = normalizeAnticipo(payload.anticipo, []);
  if (!raw) throw new AnticiposApiError("No fue posible leer el anticipo creado.");
  return raw;
}

export async function aplicarAnticipo(
  anticipoId: string,
  input: AplicarAnticipoInput,
): Promise<{ aplicacionId: string; tramiteId: string; montoAplicado: string }> {
  const response = await fetch(`/api/anticipos/${anticipoId}/aplicaciones`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible aplicar el anticipo (${response.status}).`;
    throw new AnticiposApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.aplicacion)) {
    throw new AnticiposApiError("Respuesta de aplicación no válida.");
  }

  const ap = payload.aplicacion;
  return {
    aplicacionId: String(ap.id ?? ""),
    tramiteId: String(ap.tramiteId ?? ""),
    montoAplicado: String(ap.montoAplicado ?? "0"),
  };
}

export async function eliminarAplicacion(
  anticipoId: string,
  aplicacionId: string,
): Promise<void> {
  const response = await fetch(
    `/api/anticipos/${anticipoId}/aplicaciones/${aplicacionId}`,
    { method: "DELETE", headers: { accept: "application/json" } },
  );

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new AnticiposApiError(msg, response.status);
  }
}

/** Formatea BigInt serializado como COP: $45.226.000 */
export function formatCOP(value: string): string {
  try {
    const n = BigInt(value);
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return value;
  }
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}
