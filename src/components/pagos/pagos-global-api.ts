/**
 * Helpers de API para el módulo GLOBAL de pagos (vista transversal de todos los DOs)
 * y para "Pagar en bloque" / bloques de pago (CxP v2, diseño §D.2, §D.5, paquete P4).
 * La creación/edición/borrado de pagos sueltos reutiliza los endpoints por-DO de
 * pagos-api.ts. BigInt serializado como string desde el backend — parsear con BigInt().
 */

import type {
  CodigoMotivoNoPagable,
  EstadoBorradorJson,
  EstadoCuentaProveedorJson,
  FacturaElegibleJson,
  PagoRealizadoJson,
} from "@/lib/cxp/contratos-api";
import type { CostoAsumidoPor } from "@/lib/cxp/tipos";
import type { CanalPago, GrupoPagoDOInfo } from "@/components/pagos/pagos-api";
import { formatFechaCalendario } from "@/lib/tiempo/bogota";

export type {
  CanalPago,
  CreatePagoInput,
  GrupoPagoDOInfo,
  PagoComprobanteCategoria,
  UpdatePagoInput,
} from "@/components/pagos/pagos-api";
export {
  CANALES_PAGO,
  PagosApiError,
  createPago,
  updatePago,
  deletePago,
  formatCOP,
  subirComprobante,
} from "@/components/pagos/pagos-api";

// Contrato de CxP v2 (P0): se puede importar desde componentes cliente.
export type { EstadoCuentaProveedorJson, FacturaElegibleJson, PagoRealizadoJson } from "@/lib/cxp/contratos-api";
export type { CostoAsumidoPor } from "@/lib/cxp/tipos";

import { PagosApiError } from "@/components/pagos/pagos-api";

/** Fila de pago en la vista global: pago + datos del DO y cliente. */
export type PagoGlobalRow = {
  id: string;
  tramiteId: string;
  consecutivo: string;
  estadoTramite: string;
  clienteId: string;
  clienteNombre: string;
  clienteNit: string;
  concepto: string;
  /** Nombres de beneficiarios vinculados (display). */
  beneficiarios: string;
  numSoporte: string | null;
  /** Comprobante bancario. null = sin comprobante (badge de advertencia, no bloquea). */
  documentoId: string | null;
  /** true cuando falta el comprobante bancario — dispara el distintivo "Falta comprobante". Derivado por el backend. */
  faltaComprobante: boolean;
  /** Id del grupo de pago en bloque (null = pago normal de un solo DO). */
  grupoPagoId: string | null;
  /** Otros DOs del mismo grupoPagoId (vacío si no es un pago en bloque). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
  /** Facturas de proveedor que cubre este pago, con su monto (CxP v2, §D.5: "FE 12481 · $464.077"). */
  facturas: { facturaId: string; numFactura: string; monto: string }[];
  valor: string; // BigInt serializado
  canalPago: CanalPago;
  costoBancario: string; // BigInt serializado
  orden: number;
  fechaRealPago: string | null; // ISO
  createdAt: string;
  updatedAt: string;
};

export type PagosGlobalData = {
  pagos: PagoGlobalRow[];
  totalPagos: string;
  costosBancarios: string;
  /** R8: de `costosBancarios`, lo que asumió Galcomex (bloques con `costoAsumidoPor=GALCOMEX`). */
  costosBancariosGalcomex: string;
  totalPendiente: string;
  /** Solo cuando se filtra por proveedor (§D.5): mismo cálculo que la ficha. */
  resumenProveedor: EstadoCuentaProveedorJson["resumen"] | null;
};

export type ClienteOption = { id: string; nombre: string; nit: string };
export type TramiteOption = { id: string; consecutivo: string; clienteNombre: string };

export type PagosGlobalFiltros = {
  clienteId?: string;
  tramiteId?: string;
  canalPago?: CanalPago | "";
  soloPendientes?: boolean;
  /** Ficha de proveedor (beneficiario/empresa) — §D.5, filtro por unión (beneficiario del pago o de sus facturas). */
  proveedorId?: string;
};

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

function normalizeFacturaLink(raw: unknown): { facturaId: string; numFactura: string; monto: string } | null {
  if (!isRecord(raw)) return null;
  return {
    facturaId: String(raw.facturaId ?? raw.id ?? ""),
    numFactura: String(raw.numFactura ?? ""),
    monto: String(raw.monto ?? "0"),
  };
}

function normalizePago(raw: unknown): PagoGlobalRow | null {
  if (!isRecord(raw)) return null;
  const tramite = isRecord(raw.tramite) ? raw.tramite : {};
  const cliente = isRecord(tramite.cliente) ? tramite.cliente : {};

  return {
    id: String(raw.id ?? ""),
    tramiteId: String(raw.tramiteId ?? tramite.id ?? ""),
    consecutivo: String(tramite.consecutivo ?? ""),
    estadoTramite: String(tramite.estado ?? ""),
    clienteId: String(cliente.id ?? ""),
    clienteNombre: String(cliente.nombre ?? ""),
    clienteNit: String(cliente.nit ?? ""),
    concepto: String(raw.concepto ?? ""),
    beneficiarios: (() => {
      const arr = Array.isArray(raw.beneficiarios) ? raw.beneficiarios : [];
      return arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((link) => {
          const b = typeof link.beneficiario === "object" && link.beneficiario !== null
            ? (link.beneficiario as Record<string, unknown>)
            : link;
          return typeof b.nombre === "string" ? b.nombre : "";
        })
        .filter(Boolean)
        .join(", ");
    })(),
    numSoporte: typeof raw.numSoporte === "string" ? raw.numSoporte : null,
    documentoId: typeof raw.documentoId === "string" ? raw.documentoId : null,
    faltaComprobante:
      typeof raw.faltaComprobante === "boolean"
        ? raw.faltaComprobante
        : !(typeof raw.documentoId === "string"),
    grupoPagoId: typeof raw.grupoPagoId === "string" ? raw.grupoPagoId : null,
    grupoOtrosDOs: (() => {
      const arr = Array.isArray(raw.grupoOtrosDOs) ? raw.grupoOtrosDOs : [];
      return arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map((g) => ({
          tramiteId: String(g.tramiteId ?? ""),
          consecutivo: String(g.consecutivo ?? ""),
        }));
    })(),
    facturas: (() => {
      const arr = Array.isArray(raw.facturas) ? raw.facturas : [];
      return arr.map(normalizeFacturaLink).filter((f): f is { facturaId: string; numFactura: string; monto: string } => f !== null);
    })(),
    valor: String(raw.valor ?? "0"),
    canalPago: (raw.canalPago as CanalPago) ?? "OTRO",
    costoBancario: String(raw.costoBancario ?? "0"),
    orden: typeof raw.orden === "number" ? raw.orden : 0,
    fechaRealPago: typeof raw.fechaRealPago === "string" ? raw.fechaRealPago : null,
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

export async function fetchPagosGlobal(
  filtros: PagosGlobalFiltros = {},
  signal?: AbortSignal,
): Promise<PagosGlobalData> {
  const url = new URL("/api/pagos", window.location.origin);
  if (filtros.clienteId) url.searchParams.set("clienteId", filtros.clienteId);
  if (filtros.tramiteId) url.searchParams.set("tramiteId", filtros.tramiteId);
  if (filtros.canalPago) url.searchParams.set("canalPago", filtros.canalPago);
  if (filtros.soloPendientes) url.searchParams.set("solo_pendientes", "true");
  if (filtros.proveedorId) url.searchParams.set("proveedorId", filtros.proveedorId);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/pagos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new PagosApiError("Respuesta de pagos no válida.");

  const rawPagos = Array.isArray(payload.pagos) ? payload.pagos : [];
  const pagos = rawPagos
    .map(normalizePago)
    .filter((p): p is PagoGlobalRow => p !== null);

  return {
    pagos,
    totalPagos: String(payload.totalPagos ?? "0"),
    costosBancarios: String(payload.costosBancarios ?? "0"),
    costosBancariosGalcomex: String(payload.costosBancariosGalcomex ?? "0"),
    totalPendiente: String(payload.totalPendiente ?? "0"),
    resumenProveedor: isRecord(payload.resumenProveedor)
      ? (payload.resumenProveedor as unknown as EstadoCuentaProveedorJson["resumen"])
      : null,
  };
}

export async function fetchClienteOptions(signal?: AbortSignal): Promise<ClienteOption[]> {
  // F1: este selector filtra el DO (empresa CLIENTE dueña del trámite), no el
  // proveedor a quien se le paga — ese es el beneficiario, no una empresa.
  const response = await fetch("/api/clientes?rol=cliente", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new PagosApiError("Error al cargar clientes.", response.status);

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

/** Máximo que admite `GET /api/tramites?take=` para los selectores de DO. */
const TRAMITE_OPTIONS_TAKE = 200;

/**
 * Opciones de DO para los selectores (nuevo pago, pago en bloque). Pide `take=200`
 * porque sin `take` el API recorta a 50 en silencio; si el servidor aún no
 * admite ese máximo (400 de validación) reintenta con 100.
 */
export async function fetchTramiteOptions(signal?: AbortSignal): Promise<TramiteOption[]> {
  let response = await fetch(`/api/tramites?take=${TRAMITE_OPTIONS_TAKE}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (response.status === 400) {
    response = await fetch("/api/tramites?take=100", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  }
  if (!response.ok) throw new PagosApiError("Error al cargar trámites.", response.status);

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
        : String(t.clienteNombre ?? ""),
    }))
    .filter((t) => t.id && t.consecutivo);
}

/**
 * Fecha-calendario (fecha de factura, fecha real de pago, fecha de un bloque):
 * se guarda a 00:00 UTC y se muestra en UTC (R17), así sale el mismo día en
 * cualquier navegador. Antes se formateaba en la hora de Colombia y salía un
 * día antes. Para un instante real (p. ej. `anulacion.en`) usar
 * `formatInstanteBogota`.
 */
export function formatDate(iso: string | null): string {
  return formatFechaCalendario(iso);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagar en bloque (CxP v2, diseño §D.2) — GET/POST /api/pagos/multi
// ─────────────────────────────────────────────────────────────────────────────

/** Compatibilidad con el nombre de e5cd35b (P3 lo sigue usando hasta que migre a seccion-cxp-proveedor.tsx). */
export type FacturaElegibleMultiDORow = FacturaElegibleJson;

function normalizeAdvertencia(raw: unknown): { codigo: string; mensaje: string } | null {
  if (!isRecord(raw)) return null;
  return { codigo: String(raw.codigo ?? ""), mensaje: String(raw.mensaje ?? "") };
}

function normalizeFacturaElegible(raw: unknown): FacturaElegibleJson | null {
  if (!isRecord(raw)) return null;
  const motivoRaw = raw.motivoNoPagable;
  const facturadaRaw = raw.facturadaAlCliente;
  return {
    id: String(raw.id ?? ""),
    numFactura: String(raw.numFactura ?? ""),
    numFacturaVisible: String(raw.numFacturaVisible ?? raw.numFactura ?? ""),
    valor: String(raw.valor ?? "0"),
    aplicado: String(raw.aplicado ?? "0"),
    ajustes: String(raw.ajustes ?? "0"),
    compensado: String(raw.compensado ?? "0"),
    saldo: String(raw.saldo ?? raw.valor ?? "0"),
    estado: raw.estado === "PARCIAL" ? "PARCIAL" : "REGISTRADA",
    fecha: String(raw.fecha ?? ""),
    moneda: raw.moneda === "USD" ? "USD" : "COP",
    valorOrigen: typeof raw.valorOrigen === "string" ? raw.valorOrigen : null,
    trm: typeof raw.trm === "string" ? raw.trm : null,
    tramiteId: String(raw.tramiteId ?? ""),
    tramiteConsecutivo: String(raw.tramiteConsecutivo ?? ""),
    doCorto: String(raw.doCorto ?? ""),
    tramiteEstado: (raw.tramiteEstado as FacturaElegibleJson["tramiteEstado"]) ?? "EN_TRAMITE",
    marca: typeof raw.marca === "string" ? raw.marca : null,
    clienteId: String(raw.clienteId ?? ""),
    clienteNombre: String(raw.clienteNombre ?? ""),
    beneficiarioId: typeof raw.beneficiarioId === "string" ? raw.beneficiarioId : null,
    beneficiarioNombre: typeof raw.beneficiarioNombre === "string" ? raw.beneficiarioNombre : null,
    repercutible: raw.repercutible !== false,
    saldoTramite: String(raw.saldoTramite ?? "0"),
    pagable: raw.pagable === true,
    motivoNoPagable: isRecord(motivoRaw)
      ? { codigo: motivoRaw.codigo as CodigoMotivoNoPagable, mensaje: String(motivoRaw.mensaje ?? "") }
      : null,
    advertencias: Array.isArray(raw.advertencias)
      ? (raw.advertencias
          .map(normalizeAdvertencia)
          .filter((a): a is { codigo: string; mensaje: string } => a !== null) as FacturaElegibleJson["advertencias"])
      : [],
    puedeAbsorberCosto: raw.puedeAbsorberCosto === true,
    conciliacionPendiente: raw.conciliacionPendiente === true,
    tieneAnticipoAplicado: raw.tieneAnticipoAplicado === true,
    facturadaAlCliente: isRecord(facturadaRaw)
      ? {
          numSiigo: typeof facturadaRaw.numSiigo === "string" ? facturadaRaw.numSiigo : null,
          estado: (facturadaRaw.estado as EstadoBorradorJson | undefined) ?? "APROBADO",
        }
      : null,
  };
}

/**
 * Lista TODAS las facturas de proveedor de un beneficiario, de todos los DOs
 * (pagables y no pagables, con su motivo y advertencias) — el contrato
 * `FacturaElegibleJson` (§B.1, P0) que llena el modal "Pagar en bloque" y la
 * ficha del proveedor.
 */
/** Facturas del selector "Pagar en bloque" + costo de la transferencia por canal (pesos, string). */
export type ElegiblesBloqueJson = {
  facturas: FacturaElegibleJson[];
  costosPorCanal: Partial<Record<CanalPago, string>>;
};

export async function fetchFacturasElegiblesMultiDO(
  beneficiarioId: string,
  signal?: AbortSignal,
): Promise<ElegiblesBloqueJson> {
  let response: Response;
  try {
    response = await fetch(
      `/api/pagos/multi?beneficiarioId=${encodeURIComponent(beneficiarioId)}`,
      { cache: "no-store", headers: { Accept: "application/json" }, signal },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/pagos/multi.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  const rawFacturas = isRecord(payload) && Array.isArray(payload.facturas) ? payload.facturas : [];
  const costosPorCanal: Partial<Record<CanalPago, string>> = {};
  if (isRecord(payload) && isRecord(payload.costosPorCanal)) {
    for (const [canal, costo] of Object.entries(payload.costosPorCanal)) {
      if (typeof costo === "string" || typeof costo === "number") {
        costosPorCanal[canal as CanalPago] = String(costo);
      }
    }
  }

  return {
    facturas: rawFacturas
      .map(normalizeFacturaElegible)
      .filter((f): f is FacturaElegibleJson => f !== null),
    costosPorCanal,
  };
}

export type CrearPagoMultiDOInput = {
  beneficiarioId: string;
  facturas: { facturaProveedorId: string; monto: string }[];
  canalPago: CanalPago;
  /** Fecha-calendario "YYYY-MM-DD" (defecto: `hoyBogotaISO()`). */
  fechaRealPago: string;
  concepto?: string;
  /** Obligatorio salvo registro histórico de conciliación (D-5) — el modal siempre lo exige. */
  documentoId: string | null;
  comprobanteComercioId?: string | null;
  /** D-2/R18: "valor que salió del banco". */
  valorTransferido?: string | null;
  /** D-1/R8: quién asume el costo bancario del bloque. */
  costoAsumidoPor: CostoAsumidoPor;
  /** B.5: generada por la pantalla al abrir el modal (`crypto.randomUUID()`), se regenera tras éxito o 409 IDEMPOTENCIA_CONFLICTO. */
  claveIdempotencia: string;
};

export type PagoMultiDOCreado = {
  id: string;
  tramiteId: string;
  valor: string;
  costoBancario: string;
};

export type CrearPagoMultiDOResult = {
  grupoPagoId: string;
  pagos: PagoMultiDOCreado[];
  /** Avisos que no bloquean (p. ej. `COSTO_NO_COBRABLE`, `ANTICIPO_INSUFICIENTE`). */
  advertencias: { codigo: string; mensaje: string }[];
  /** true = la clave de idempotencia ya existía con el mismo contenido (200, no crea un pago nuevo). */
  repetido: boolean;
};

/** Crea el pago en bloque — ver `crearPagoMultiDO()` en `src/lib/pagos/service.ts` (P1). */
export async function crearPagoMultiDO(
  input: CrearPagoMultiDOInput,
): Promise<CrearPagoMultiDOResult> {
  const response = await fetch("/api/pagos/multi", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el pago en bloque (${response.status}).`;
    const codigo = isRecord(payload) && typeof payload.codigo === "string" ? payload.codigo : undefined;
    const error = new PagosApiError(message, response.status);
    if (codigo) (error as PagosApiError & { codigo?: string }).codigo = codigo;
    throw error;
  }

  if (!isRecord(payload) || typeof payload.grupoPagoId !== "string" || !Array.isArray(payload.pagos)) {
    throw new PagosApiError("Respuesta de pago en bloque no válida.");
  }

  return {
    grupoPagoId: payload.grupoPagoId,
    pagos: payload.pagos.filter(isRecord).map((p) => ({
      id: String(p.id ?? ""),
      tramiteId: String(p.tramiteId ?? ""),
      valor: String(p.valor ?? "0"),
      costoBancario: String(p.costoBancario ?? "0"),
    })),
    advertencias: Array.isArray(payload.advertencias)
      ? (payload.advertencias.map(normalizeAdvertencia).filter((a): a is { codigo: string; mensaje: string } => a !== null))
      : [],
    repetido: payload.repetido === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloque de pago: ver / actualizar / anular — /api/pagos/grupos/[id] (P1)
// ─────────────────────────────────────────────────────────────────────────────

function normalizePagoRealizado(raw: unknown): PagoRealizadoJson | null {
  if (!isRecord(raw)) return null;
  const anulacionRaw = raw.anulacion;
  const comprobanteRaw = raw.comprobante;
  return {
    tipo: raw.tipo === "SUELTO" ? "SUELTO" : "BLOQUE",
    id: String(raw.id ?? ""),
    fecha: typeof raw.fecha === "string" ? raw.fecha : null,
    concepto: String(raw.concepto ?? ""),
    valor: String(raw.valor ?? "0"),
    aplicadoAFacturas: String(raw.aplicadoAFacturas ?? "0"),
    sinFactura: String(raw.sinFactura ?? "0"),
    canalPago: (raw.canalPago as PagoRealizadoJson["canalPago"]) ?? "TRANSF_BANCOLOMBIA",
    costoBancario: String(raw.costoBancario ?? "0"),
    costoAsumidoPor: (raw.costoAsumidoPor as CostoAsumidoPor | null) ?? null,
    estado: raw.estado === "ANULADO" ? "ANULADO" : "ACTIVO",
    esHistorico: raw.esHistorico === true,
    comprobante: isRecord(comprobanteRaw)
      ? { documentoId: String(comprobanteRaw.documentoId ?? ""), tramiteId: String(comprobanteRaw.tramiteId ?? "") }
      : null,
    dos: Array.isArray(raw.dos)
      ? raw.dos.filter(isRecord).map((d) => ({
          tramiteId: String(d.tramiteId ?? ""),
          consecutivo: String(d.consecutivo ?? ""),
          valor: String(d.valor ?? "0"),
        }))
      : [],
    facturas: Array.isArray(raw.facturas)
      ? raw.facturas.filter(isRecord).map((f) => ({
          facturaId: String(f.facturaId ?? ""),
          numFactura: String(f.numFactura ?? ""),
          monto: String(f.monto ?? "0"),
        }))
      : [],
    anulacion: isRecord(anulacionRaw)
      ? {
          motivo: String(anulacionRaw.motivo ?? ""),
          por: typeof anulacionRaw.por === "string" ? anulacionRaw.por : null,
          en: String(anulacionRaw.en ?? ""),
        }
      : null,
  };
}

/** `GET /api/pagos/grupos/[id]` — detalle de un bloque (por DO y por factura), para `DetalleBloqueDialog`. */
export async function fetchPagoGrupo(grupoPagoId: string, signal?: AbortSignal): Promise<PagoRealizadoJson> {
  let response: Response;
  try {
    response = await fetch(`/api/pagos/grupos/${encodeURIComponent(grupoPagoId)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/pagos/grupos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  const grupo = isRecord(payload) ? normalizePagoRealizado(payload.pagoGrupo ?? payload) : null;
  if (!grupo) throw new PagosApiError("Respuesta de bloque de pago no válida.");
  return grupo;
}

export type ActualizarPagoGrupoInput = {
  concepto?: string;
  fechaRealPago?: string | null;
  documentoId?: string | null;
  comprobanteComercioId?: string | null;
  valorTransferido?: string | null;
};

/** `PATCH /api/pagos/grupos/[id]` — concepto/fecha/comprobantes se propagan a todo el bloque (§B.4). */
export async function actualizarPagoGrupo(
  grupoPagoId: string,
  input: ActualizarPagoGrupoInput,
): Promise<PagoRealizadoJson> {
  const response = await fetch(`/api/pagos/grupos/${encodeURIComponent(grupoPagoId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible actualizar el bloque de pago (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }
  const grupo = isRecord(payload) ? normalizePagoRealizado(payload.pagoGrupo ?? payload) : null;
  if (!grupo) throw new PagosApiError("Respuesta de bloque de pago no válida.");
  return grupo;
}

/**
 * `POST /api/pagos/grupos/[id]/anular` — solo ADMIN, motivo ≥ 10 caracteres
 * (`motivoSchema`, P0). Devuelve el bloque con `estado: "ANULADO"`.
 */
export async function anularPagoGrupo(grupoPagoId: string, motivo: string): Promise<PagoRealizadoJson> {
  const response = await fetch(`/api/pagos/grupos/${encodeURIComponent(grupoPagoId)}/anular`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ motivo }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible anular el bloque de pago (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }
  const grupo = isRecord(payload) ? normalizePagoRealizado(payload.pagoGrupo ?? payload) : null;
  if (!grupo) throw new PagosApiError("Respuesta de bloque de pago no válida.");
  return grupo;
}
