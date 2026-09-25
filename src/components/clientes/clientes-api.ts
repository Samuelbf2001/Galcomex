import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";

export type TarifaCliente = {
  anio: number;
  tipo: string;
  valor: string;
};

export type ClienteRow = {
  id: string;
  nombre: string;
  nit: string;
  tipo: string;
  contactoNombre: string | null;
  contactoEmail: string | null;
  contactoTel: string | null;
  /** Ciudad de la empresa; sale en la cotización (PDF del tarifario). */
  ciudad: string | null;
  manejaAnticipo: boolean;
  activo: boolean;
  esCliente: boolean;
  esProveedor: boolean;
  grupoEmpresaId: string | null;
  tarifas: TarifaCliente[];
};

export type TramiteResumen = {
  id: string;
  consecutivo: string;
  estado: string;
  ciudad: string;
};

export type AnticipoResumen = {
  id: string;
  monto: string;
  fecha: string;
  canalPago: string;
  verificadoBanco: boolean;
  montoAplicado: string;
};

export type FacturaResumen = {
  id: string;
  numSiigo: string;
  fecha: string;
  totalFactura: string;
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
  fechaPagoCliente: string | null;
  borradorId: string | null;
  tramiteId: string | null;
};

export type ClienteDetalle = ClienteRow & {
  tramites: TramiteResumen[];
  anticipos: AnticipoResumen[];
  facturas: FacturaResumen[];
};

export type CreateClienteInput = {
  nombre: string;
  nit: string;
  tipo: string;
  contactoNombre?: string | null;
  contactoEmail?: string | null;
  contactoTel?: string | null;
  ciudad?: string | null;
  manejaAnticipo: boolean;
  esCliente?: boolean;
  esProveedor?: boolean;
  grupoEmpresaId?: string | null;
  tarifas: TarifaCliente[];
};

export type UpdateClienteInput = Partial<
  CreateClienteInput & { activo: boolean }
>;

export type DetalleValidacion = { campo: string; mensaje: string };

export class ClientesApiError extends Error {
  status?: number;
  details?: DetalleValidacion[];

  constructor(message: string, status?: number, details?: DetalleValidacion[]) {
    super(message);
    this.name = "ClientesApiError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Convierte los `details` de Zod (`{ campo: "tarifas.0.valor", mensaje }`) en
 * un mapa por campo raíz (`tarifas`) para pintarlos junto al input.
 * Si el mismo campo trae varios mensajes se conserva el primero.
 */
export function erroresPorCampo(details?: DetalleValidacion[]): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const d of details ?? []) {
    const raiz = d.campo.split(".")[0] || d.campo;
    if (!(raiz in mapa)) mapa[raiz] = d.mensaje;
  }
  return mapa;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leerDetalles(payload: Record<string, unknown>): DetalleValidacion[] | undefined {
  if (!Array.isArray(payload.details)) return undefined;
  return payload.details
    .filter(isRecord)
    .map((d) => ({
      campo: typeof d.campo === "string" ? d.campo : "",
      mensaje: typeof d.mensaje === "string" ? d.mensaje : "Valor inválido",
    }));
}

function normalizeCliente(row: unknown): ClienteRow | null {
  if (!isRecord(row)) {
    return null;
  }

  const id = typeof row.id === "string" ? row.id : "";
  const nombre = typeof row.nombre === "string" ? row.nombre : "";

  if (!id || !nombre) {
    return null;
  }

  const tarifas = Array.isArray(row.tarifas)
    ? row.tarifas.filter(isRecord).map((t) => ({
        anio: typeof t.anio === "number" ? t.anio : Number(t.anio ?? 0),
        tipo: typeof t.tipo === "string" ? t.tipo : "",
        valor: t.valor === undefined || t.valor === null ? "0" : String(t.valor),
      }))
    : [];

  return {
    id,
    nombre,
    nit: typeof row.nit === "string" ? row.nit : "",
    tipo: typeof row.tipo === "string" ? row.tipo : "PROPIO",
    contactoNombre: typeof row.contactoNombre === "string" ? row.contactoNombre : null,
    contactoEmail: typeof row.contactoEmail === "string" ? row.contactoEmail : null,
    contactoTel: typeof row.contactoTel === "string" ? row.contactoTel : null,
    ciudad: typeof row.ciudad === "string" ? row.ciudad : null,
    manejaAnticipo: row.manejaAnticipo !== false,
    activo: row.activo !== false,
    esCliente: row.esCliente !== false,
    esProveedor: row.esProveedor === true,
    grupoEmpresaId:
      typeof row.grupoEmpresaId === "string" ? row.grupoEmpresaId : null,
    tarifas,
  };
}

/**
 * `rol` (F1): sin parámetro lista TODAS las empresas (pantalla Empresas, que
 * ya filtra cliente/proveedor en el propio cliente); `"cliente"` filtra
 * `esCliente: true` en el servidor — lo usan selectores que solo deben
 * ofrecer empresas CLIENTE (p. ej. importar Excel de un cliente).
 */
export async function fetchClientes(
  signal?: AbortSignal,
  rol?: "cliente" | "proveedor",
): Promise<ClienteRow[]> {
  const query = rol ? `?rol=${rol}` : "";
  const response = await fetch(`/api/clientes${query}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No fue posible cargar los clientes.";
    throw new ClientesApiError(message, response.status);
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload) || !Array.isArray(payload.clientes)) {
    return [];
  }

  return payload.clientes
    .map(normalizeCliente)
    .filter((cliente): cliente is ClienteRow => cliente !== null);
}

function normalizeAnticipo(row: unknown): AnticipoResumen | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) return null;

  // Calcular montoAplicado sumando aplicaciones
  let montoAplicado = 0n;
  if (Array.isArray(row.aplicaciones)) {
    for (const ap of row.aplicaciones) {
      if (isRecord(ap) && (ap.montoAplicado !== undefined)) {
        try {
          montoAplicado += BigInt(String(ap.montoAplicado));
        } catch { /* noop */ }
      }
    }
  }

  return {
    id,
    monto: row.monto === undefined || row.monto === null ? "0" : String(row.monto),
    fecha: typeof row.fecha === "string" ? row.fecha : "",
    canalPago: typeof row.canalPago === "string" ? row.canalPago : "",
    verificadoBanco: row.verificadoBanco === true,
    montoAplicado: montoAplicado.toString(),
  };
}

function normalizeFactura(row: unknown): FacturaResumen | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : "";
  const numSiigo = typeof row.numSiigo === "string" ? row.numSiigo : "";
  if (!id || !numSiigo) return null;

  return {
    id,
    numSiigo,
    fecha: typeof row.fecha === "string" ? row.fecha : "",
    totalFactura: row.totalFactura === undefined || row.totalFactura === null ? "0" : String(row.totalFactura),
    saldoAFavorCliente: row.saldoAFavorCliente === undefined || row.saldoAFavorCliente === null ? "0" : String(row.saldoAFavorCliente),
    saldoACargoCliente: row.saldoACargoCliente === undefined || row.saldoACargoCliente === null ? "0" : String(row.saldoACargoCliente),
    fechaPagoCliente: typeof row.fechaPagoCliente === "string" ? row.fechaPagoCliente : null,
    borradorId: typeof row.borradorId === "string" ? row.borradorId : null,
    tramiteId:
      isRecord(row.borrador) && typeof row.borrador.tramiteId === "string"
        ? row.borrador.tramiteId
        : null,
  };
}

function normalizeTramite(row: unknown): TramiteResumen | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : "";
  const consecutivo = typeof row.consecutivo === "string" ? row.consecutivo : "";
  if (!id || !consecutivo) return null;

  return {
    id,
    consecutivo,
    estado: typeof row.estado === "string" ? row.estado : "",
    ciudad: typeof row.ciudad === "string" ? row.ciudad : "",
  };
}

function normalizeClienteDetalle(row: unknown): ClienteDetalle | null {
  const base = normalizeCliente(row);
  if (!base || !isRecord(row)) return null;

  const tramites = Array.isArray(row.tramites)
    ? row.tramites.map(normalizeTramite).filter((t): t is TramiteResumen => t !== null)
    : [];

  const anticipos = Array.isArray(row.anticipos)
    ? row.anticipos.map(normalizeAnticipo).filter((a): a is AnticipoResumen => a !== null)
    : [];

  const facturas = Array.isArray(row.facturas)
    ? row.facturas.map(normalizeFactura).filter((f): f is FacturaResumen => f !== null)
    : [];

  return { ...base, tramites, anticipos, facturas };
}

export async function fetchClienteDetalle(
  id: string,
  signal?: AbortSignal,
): Promise<ClienteDetalle> {
  const response = await fetch(`/api/clientes/${id}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No fue posible cargar el cliente.";
    throw new ClientesApiError(message, response.status);
  }

  const payload: unknown = await response.json();
  const cliente = isRecord(payload) ? normalizeClienteDetalle(payload.cliente) : null;

  if (!cliente) {
    throw new ClientesApiError("La respuesta del servidor no es válida.");
  }

  return cliente;
}

export async function updateCliente(
  id: string,
  input: UpdateClienteInput,
): Promise<ClienteRow> {
  const response = await fetch(`/api/clientes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isRecord(payload)) {
      const message =
        typeof payload.error === "string" ? payload.error : "No fue posible actualizar el cliente.";
      throw new ClientesApiError(message, response.status, leerDetalles(payload));
    }
    throw new ClientesApiError("No fue posible actualizar el cliente.", response.status);
  }

  const cliente = isRecord(payload) ? normalizeCliente(payload.cliente) : null;

  if (!cliente) {
    throw new ClientesApiError("La respuesta de actualización no es válida.");
  }

  return cliente;
}

export async function upsertTarifa(
  clienteId: string,
  tarifa: TarifaCliente,
): Promise<ClienteRow> {
  // Fetches the current tarifas and sends them back with the new/updated one merged
  const current = await fetchClienteDetalle(clienteId);
  const existingIdx = current.tarifas.findIndex(
    (t) => t.anio === tarifa.anio && t.tipo === tarifa.tipo,
  );

  let nextTarifas: TarifaCliente[];
  if (existingIdx >= 0) {
    nextTarifas = current.tarifas.map((t, i) => (i === existingIdx ? tarifa : t));
  } else {
    nextTarifas = [...current.tarifas, tarifa];
  }

  return updateCliente(clienteId, { tarifas: nextTarifas });
}

// ---------------------------------------------------------------------------
// Pop-up de la ficha (`?abrir=` deep link) — helpers puros de la cabecera
// ---------------------------------------------------------------------------

export type PopupFicha = "funciones" | "contacto" | "tarifas";

const POPUPS_FICHA: readonly PopupFicha[] = ["funciones", "contacto", "tarifas"];

/**
 * Valida el parámetro `?abrir=` de la ficha del cliente (deep link desde otro
 * módulo, p. ej. un DO sin tarifa vigente manda a `/clientes/{id}?abrir=tarifas`).
 * Cualquier otro valor —o una lista, si Next repite el parámetro en la URL—
 * se ignora y no abre nada.
 */
export function parsearAbrirPopup(
  valor: string | string[] | null | undefined,
): PopupFicha | null {
  const candidato = Array.isArray(valor) ? valor[0] : valor;
  return (POPUPS_FICHA as readonly string[]).includes(candidato ?? "")
    ? (candidato as PopupFicha)
    : null;
}

/** Forma mínima que necesita `tieneTarifarioVigenteHoy` (subconjunto de `TarifarioRow`). */
export type TarifarioVigenciaRow = {
  estado: string;
  vigenteDesde: string;
  vigenteHasta: string;
};

/**
 * `true` si alguno de los tarifarios está `VIGENTE` y su vigencia (fechas
 * ISO, comparadas por día calendario) cubre `hoy`. Alimenta el punto ámbar
 * del botón "Tarifas" en la cabecera de la ficha.
 */
export function tieneTarifarioVigenteHoy(
  tarifarios: TarifarioVigenciaRow[],
  // F5: "hoy" es el día calendario en Bogotá, no el instante UTC — si no, el
  // punto ámbar se apaga 5 horas antes de medianoche en Bogotá el último día
  // de vigencia. Ver `lib/tiempo/bogota.ts`.
  hoy: Date = fechaCalendarioBogota(),
): boolean {
  const hoyIso = hoy.toISOString().slice(0, 10);
  return tarifarios.some(
    (t) =>
      t.estado === "VIGENTE" &&
      t.vigenteDesde.slice(0, 10) <= hoyIso &&
      hoyIso <= t.vigenteHasta.slice(0, 10),
  );
}

export async function createCliente(input: CreateClienteInput): Promise<ClienteRow> {
  const response = await fetch("/api/clientes", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (isRecord(payload)) {
      const message =
        typeof payload.error === "string" ? payload.error : "No fue posible crear el cliente.";
      throw new ClientesApiError(message, response.status, leerDetalles(payload));
    }

    throw new ClientesApiError("No fue posible crear el cliente.", response.status);
  }

  const cliente = isRecord(payload) ? normalizeCliente(payload.cliente) : null;

  if (!cliente) {
    throw new ClientesApiError("La respuesta de creación no es válida.");
  }

  return cliente;
}
