/**
 * Helpers de API para el módulo de Cartera.
 * Todos los montos llegan como string (BigInt serializado desde Prisma).
 */

import type { CanalPago } from "@/components/pagos/pagos-api";
export type { CanalPago } from "@/components/pagos/pagos-api";
export { CANALES_PAGO } from "@/components/pagos/pagos-api";

// ─── Tipos de recaudo/pago combinados para el selector UI ────────────────────

export type TipoRecaudo =
  | "BANCOLOMBIA"
  | "OTROS_BANCOS"
  | "SUCURSAL"
  | "CORRESPONSAL"
  | "CAJERO";

/**
 * Entrada del selector combinado "Tipo de recaudo / pago".
 * Un item puede representar un TipoRecaudo (entra plata) o un CanalPago (sale plata).
 */
export type OpcionRecaudoPago =
  | { grupo: "RECAUDO"; value: TipoRecaudo; label: string; costo: number }
  | { grupo: "PAGO"; value: CanalPago; label: string; costo: number };

/**
 * Lista combinada de recaudos (entra plata) y canales de pago (sale plata).
 * Costos en pesos COP como referencia estática para el display.
 * Fuente de verdad de costos: tablas matriz_recaudo / matriz_pago en BD.
 */
export const OPCIONES_RECAUDO_PAGO: OpcionRecaudoPago[] = [
  // Grupo: Recaudo (entra plata)
  { grupo: "RECAUDO", value: "BANCOLOMBIA",  label: "Bancolombia (digital)",      costo: 1950  },
  { grupo: "RECAUDO", value: "OTROS_BANCOS", label: "Otros bancos (digital)",      costo: 2200  },
  { grupo: "RECAUDO", value: "SUCURSAL",     label: "Sucursal (físico)",           costo: 11290 },
  { grupo: "RECAUDO", value: "CORRESPONSAL", label: "Corresponsal (físico)",       costo: 6190  },
  { grupo: "RECAUDO", value: "CAJERO",       label: "Cajero (físico)",             costo: 5200  },
  // Grupo: Pago (sale plata)
  { grupo: "PAGO", value: "TRANSF_BANCOLOMBIA",  label: "Transf. Bancolombia",    costo: 3900  },
  { grupo: "PAGO", value: "PSE",                 label: "PSE",                    costo: 0     },
  { grupo: "PAGO", value: "TRANSF_OTROS_BANCOS", label: "Transf. Otros Bancos",   costo: 7300  },
];

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ClienteOption = {
  id: string;
  nombre: string;
  nit: string;
};

export type FacturaBorradorInfo = {
  tramiteId: string;
  tramite: {
    consecutivo: string;
  };
};

export type EstadoMovimiento = "BORRADOR" | "REALIZADO" | "VERIFICADO";

export type PagoFacturaRow = {
  id: string;
  facturaId: string;
  destino: "CLIENTE" | "LM";
  tipo: "ABONO" | "DEVOLUCION";
  monto: string;           // BigInt as string
  fecha: string;           // ISO
  tipoRecaudo: TipoRecaudo | null;
  canalPago: CanalPago | null;
  costoBancario: string;   // BigInt as string
  comprobanteKey: string | null;
  verificadoBanco: boolean;
  estado: EstadoMovimiento;
  createdAt: string;
};

export type FacturaRow = {
  id: string;
  borradorId: string;
  clienteId: string;
  numSiigo: string;
  fecha: string;
  totalFactura: string;            // BigInt as string
  saldoAFavorCliente: string;      // BigInt as string
  saldoACargoCliente: string;      // BigInt as string
  saldoAFavorLM: string;           // BigInt as string
  saldoACargoLM: string;           // BigInt as string
  fechaPagoCliente: string | null;
  fechaPagoLM: string | null;
  createdAt: string;
  updatedAt: string;
  borrador: FacturaBorradorInfo | null;
  // Ledger enriquecido (WS-D)
  saldoNetoCliente: string;           // BigInt as string; >0 Galcomex debe; <0 cliente debe
  pendienteCobroCliente: string;      // |saldoNeto| cuando <0
  pendienteDevolucionCliente: string; // saldoNeto cuando >0
  saldoNetoLM: string;
  pendienteCobroLM: string;
  pendienteDevolucionLM: string;
  // Campos derivados de costos bancarios (aditivos)
  costosBancariosCliente: string;  // Σ costoBancario pagos destino=CLIENTE
  costosBancariosLM: string;       // Σ costoBancario pagos destino=LM
  /** NOTA: Fórmula pendiente de confirmar con Camila. */
  totalRealLM: string;             // saldoNetoLM − costosBancariosCliente − costosBancariosLM
  pagos: PagoFacturaRow[];
};

export type CarteraData = {
  facturas: FacturaRow[];
  cruceCliente: string;  // BigInt as string; >0 → cliente debe; <0 → Galcomex debe
  cruceLM: string;       // BigInt as string
  totalFacturas: number;
};

export type RegistrarPagoInput = {
  destino: "CLIENTE" | "LM";
  tipo: "ABONO" | "DEVOLUCION";
  monto: string;          // BigInt as string
  fecha: string;          // ISO
  // Exactamente uno de (tipoRecaudo, canalPago) debe estar presente
  tipoRecaudo?: TipoRecaudo;
  canalPago?: CanalPago;
  comprobanteKey?: string | null;
  verificadoBanco?: boolean;
};

// ─── Conciliación batch (lote de facturas) ───────────────────────────────────

export type ConciliarLoteItemInput = {
  facturaId: string;
  destino: "CLIENTE" | "LM";
  tipo: "ABONO" | "DEVOLUCION";
  monto: string;          // BigInt as string
  fecha: string;          // ISO
  tipoRecaudo?: TipoRecaudo;
  canalPago?: CanalPago;
  comprobanteKey?: string | null;
  verificadoBanco?: boolean;
};

export type ConciliarLoteItemResultUi =
  | {
      facturaId: string;
      destino: "CLIENTE" | "LM";
      ok: true;
      pagoId: string;
      saldoNeto: string;
    }
  | {
      facturaId: string;
      destino: "CLIENTE" | "LM";
      ok: false;
      status: number;
      error: string;
    };

export type ConciliarLoteResponse = {
  ok: number;
  failed: number;
  total: number;
  loteAuditId: string;
  results: ConciliarLoteItemResultUi[];
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class CarteraApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CarteraApiError";
    this.status = status;
  }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const payload: unknown = await res.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // ignore
  }
  return `Error ${res.status}`;
}

function mapPagoRow(p: Record<string, unknown>): PagoFacturaRow {
  const estadoRaw = p.estado;
  const estado: EstadoMovimiento =
    estadoRaw === "BORRADOR" || estadoRaw === "REALIZADO" || estadoRaw === "VERIFICADO"
      ? estadoRaw
      : "REALIZADO";

  return {
    id: String(p.id ?? ""),
    facturaId: String(p.facturaId ?? ""),
    destino: (p.destino as "CLIENTE" | "LM") ?? "CLIENTE",
    tipo: (p.tipo as "ABONO" | "DEVOLUCION") ?? "ABONO",
    monto: String(p.monto ?? "0"),
    fecha: String(p.fecha ?? ""),
    tipoRecaudo: typeof p.tipoRecaudo === "string" ? (p.tipoRecaudo as TipoRecaudo) : null,
    canalPago: typeof p.canalPago === "string" ? (p.canalPago as CanalPago) : null,
    costoBancario: String(p.costoBancario ?? "0"),
    comprobanteKey: typeof p.comprobanteKey === "string" ? p.comprobanteKey : null,
    verificadoBanco: p.verificadoBanco === true,
    estado,
    createdAt: String(p.createdAt ?? ""),
  };
}

function mapFacturaRow(f: Record<string, unknown>): FacturaRow {
  const borrador = isRecord(f.borrador) ? f.borrador : null;
  const borradorTramite =
    borrador && isRecord(borrador.tramite) ? borrador.tramite : null;

  const rawPagos = Array.isArray(f.pagos) ? f.pagos : [];

  return {
    id: String(f.id ?? ""),
    borradorId: String(f.borradorId ?? ""),
    clienteId: String(f.clienteId ?? ""),
    numSiigo: String(f.numSiigo ?? ""),
    fecha: String(f.fecha ?? ""),
    totalFactura: String(f.totalFactura ?? "0"),
    saldoAFavorCliente: String(f.saldoAFavorCliente ?? "0"),
    saldoACargoCliente: String(f.saldoACargoCliente ?? "0"),
    saldoAFavorLM: String(f.saldoAFavorLM ?? "0"),
    saldoACargoLM: String(f.saldoACargoLM ?? "0"),
    fechaPagoCliente:
      typeof f.fechaPagoCliente === "string" ? f.fechaPagoCliente : null,
    fechaPagoLM: typeof f.fechaPagoLM === "string" ? f.fechaPagoLM : null,
    createdAt: String(f.createdAt ?? ""),
    updatedAt: String(f.updatedAt ?? ""),
    borrador:
      borrador && borradorTramite
        ? {
            tramiteId: String(borrador.tramiteId ?? ""),
            tramite: { consecutivo: String(borradorTramite.consecutivo ?? "") },
          }
        : null,
    // Ledger (puede venir del backend; si no, derivar de los saldos base)
    saldoNetoCliente: String(f.saldoNetoCliente ?? "0"),
    pendienteCobroCliente: String(f.pendienteCobroCliente ?? "0"),
    pendienteDevolucionCliente: String(f.pendienteDevolucionCliente ?? "0"),
    saldoNetoLM: String(f.saldoNetoLM ?? "0"),
    pendienteCobroLM: String(f.pendienteCobroLM ?? "0"),
    pendienteDevolucionLM: String(f.pendienteDevolucionLM ?? "0"),
    // Costos bancarios y totalRealLM (aditivos)
    costosBancariosCliente: String(f.costosBancariosCliente ?? "0"),
    costosBancariosLM: String(f.costosBancariosLM ?? "0"),
    totalRealLM: String(f.totalRealLM ?? "0"),
    pagos: rawPagos.filter(isRecord).map(mapPagoRow),
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/** Carga clientes para el selector. */
export async function fetchClienteOptions(
  signal?: AbortSignal,
): Promise<ClienteOption[]> {
  let res: Response;
  try {
    res = await fetch("/api/clientes", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new CarteraApiError("No fue posible conectar con /api/clientes.");
  }

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new CarteraApiError(msg, res.status);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.clientes)) {
    throw new CarteraApiError("Respuesta de clientes no válida.");
  }

  return payload.clientes.filter(isRecord).map(
    (c): ClienteOption => ({
      id: String(c.id ?? ""),
      nombre: String(c.nombre ?? ""),
      nit: String(c.nit ?? ""),
    }),
  );
}

/** Carga la cartera de un cliente. */
export async function fetchCartera(
  clienteId: string,
  soloPendientes: boolean,
  desde?: string,
  hasta?: string,
  signal?: AbortSignal,
): Promise<CarteraData> {
  let url = `/api/cartera?clienteId=${encodeURIComponent(clienteId)}&pendientes=${soloPendientes ? "true" : "false"}`;
  if (desde) url += `&desde=${encodeURIComponent(desde)}`;
  if (hasta) url += `&hasta=${encodeURIComponent(hasta)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new CarteraApiError("No fue posible conectar con /api/cartera.");
  }

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new CarteraApiError(msg, res.status);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.cartera)) {
    throw new CarteraApiError("Respuesta de cartera no válida.");
  }

  const cartera = payload.cartera;
  const rawFacturas = Array.isArray(cartera.facturas) ? cartera.facturas : [];

  return {
    facturas: rawFacturas.filter(isRecord).map(mapFacturaRow),
    cruceCliente: String(cartera.cruceCliente ?? "0"),
    cruceLM: String(cartera.cruceLM ?? "0"),
    totalFacturas:
      typeof cartera.totalFacturas === "number" ? cartera.totalFacturas : 0,
  };
}

/** Registra un abono o devolución sobre una factura. */
export async function registrarAbonoDevolucion(
  facturaId: string,
  input: RegistrarPagoInput,
): Promise<{ pagoId: string; saldoNeto: string }> {
  const res = await fetch(`/api/facturas/${facturaId}/pagos`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      destino: input.destino,
      tipo: input.tipo,
      monto: input.monto,
      fecha: input.fecha,
      tipoRecaudo: input.tipoRecaudo ?? undefined,
      canalPago: input.canalPago ?? undefined,
      comprobanteKey: input.comprobanteKey ?? null,
      verificadoBanco: input.verificadoBanco ?? false,
    }),
  });

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible registrar el pago (${res.status}).`;
    throw new CarteraApiError(message, res.status);
  }

  if (!isRecord(payload) || !isRecord(payload.pago)) {
    throw new CarteraApiError("Respuesta de registro de pago no válida.");
  }

  return {
    pagoId: String(payload.pago.id ?? ""),
    saldoNeto: String(payload.saldoNeto ?? "0"),
  };
}

/** Elimina (anula) un PagoFactura. */
export async function eliminarPago(
  facturaId: string,
  pagoId: string,
): Promise<void> {
  const res = await fetch(`/api/facturas/${facturaId}/pagos/${pagoId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    const msg = await parseErrorMessage(res);
    throw new CarteraApiError(msg, res.status);
  }
}

/** Solicita URL prefirmada de subida para un comprobante de pago. */
export async function solicitarUploadUrlComprobante(input: {
  consecutivo: string;
  contentType: string;
  sizeBytes: number;
  fileName?: string;
}): Promise<{ storageKey: string; uploadUrl: string }> {
  const res = await fetch("/api/storage", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      action: "uploadUrl",
      consecutivo: input.consecutivo,
      categoria: "COMPROBANTE_BANCARIO",
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    }),
  });

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al solicitar URL de subida (${res.status}).`;
    throw new CarteraApiError(message, res.status);
  }

  if (!isRecord(payload) || !isRecord(payload.uploadUrl)) {
    throw new CarteraApiError("Respuesta de URL de subida no válida.");
  }

  const u = payload.uploadUrl;
  return {
    storageKey: String(u.storageKey ?? ""),
    uploadUrl: String(u.uploadUrl ?? ""),
  };
}

/** Sube un archivo directamente a MinIO con la URL prefirmada. */
export function subirArchivoDirecto(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);

    if (onProgress) {
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) {
          onProgress(Math.round((ev.loaded / ev.total) * 100));
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new CarteraApiError(`Fallo al subir el archivo (${xhr.status}).`));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new CarteraApiError("Error de red al subir el archivo."));
    });

    xhr.send(file);
  });
}

// ─── Utilidades de formato ────────────────────────────────────────────────────

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

/** Formatea una fecha ISO como dd/mm/aaaa */
export function formatDate(isoString: string | null): string {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("es-CO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "America/Bogota",
    });
  } catch {
    return isoString;
  }
}

/**
 * Conciliación batch de múltiples facturas (lote).
 *
 * POST /api/cartera/conciliar-lote. Devuelve resultados por ítem y un loteAuditId.
 * Acepta status 207 (parcial) además de 2xx como respuesta válida.
 */
export async function conciliarLote(
  items: ConciliarLoteItemInput[],
): Promise<ConciliarLoteResponse> {
  let res: Response;
  try {
    res = await fetch("/api/cartera/conciliar-lote", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ items }),
    });
  } catch {
    throw new CarteraApiError(
      "No fue posible conectar con /api/cartera/conciliar-lote.",
    );
  }

  const payload: unknown = await res.json().catch(() => null);

  // 207 = parcial-success: el body sigue siendo válido y debe procesarse.
  const okStatus = res.ok || res.status === 207;
  if (!okStatus) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible conciliar el lote (${res.status}).`;
    throw new CarteraApiError(message, res.status);
  }

  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new CarteraApiError("Respuesta de lote no válida.");
  }

  return {
    ok: typeof payload.ok === "number" ? payload.ok : 0,
    failed: typeof payload.failed === "number" ? payload.failed : 0,
    total: typeof payload.total === "number" ? payload.total : 0,
    loteAuditId: String(payload.loteAuditId ?? ""),
    results: payload.results
      .filter(isRecord)
      .map((r): ConciliarLoteItemResultUi => {
        const facturaId = String(r.facturaId ?? "");
        const destino = r.destino === "LM" ? "LM" : "CLIENTE";
        if (r.ok === true) {
          return {
            facturaId,
            destino,
            ok: true,
            pagoId: String(r.pagoId ?? ""),
            saldoNeto: String(r.saldoNeto ?? "0"),
          };
        }
        return {
          facturaId,
          destino,
          ok: false,
          status: typeof r.status === "number" ? r.status : 500,
          error: typeof r.error === "string" ? r.error : "Error desconocido",
        };
      }),
  };
}

/** Parsea un input de monto COP sin formato → BigInt string. */
export function parseBigIntInput(raw: string): string | null {
  const cleaned = raw
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\$/g, "")
    .replace(/COP/g, "")
    .trim();
  if (!cleaned || cleaned === "-") return null;
  try {
    const v = BigInt(cleaned);
    if (v <= 0n) return null;
    return v.toString();
  } catch {
    return null;
  }
}
