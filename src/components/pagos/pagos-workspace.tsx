"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { valorFilaParaGuardar } from "@/components/pagos/valor-fila";
import { CampoMoneda, type DetalleCampoMoneda } from "@/components/ui/campo-moneda";
import { centavosDeTexto, textoCanonicoDeCentavos, textoDeCentavos } from "@/lib/dinero";
import {
  CANALES_PAGO,
  PagosApiError,
  type CanalPago,
  type ClienteOption,
  type CostoAsumidoPor,
  type GrupoPagoDOInfo,
  type TramiteOption,
  createPago,
  deletePago,
  fetchClienteOptions,
  fetchTramiteOptions,
  formatCOP,
  formatDate,
  subirComprobante,
  updatePago,
} from "@/components/pagos/pagos-global-api";
import { PagoEnBloqueModal } from "@/components/pagos/pago-multi-do-modal";
import { AnularBloqueDialog } from "@/components/pagos/anular-bloque-dialog";
import { DetalleBloqueDialog } from "@/components/pagos/detalle-bloque-dialog";
import { nuevaClaveIdempotencia } from "@/components/pagos/clave-idempotencia";
import { desgloseResumenCxp } from "@/components/clientes/seccion-cxp-proveedor";
import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceCliente, EnlaceTramite, rutaCliente } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useRol, usePermiso } from "@/lib/auth/rol-context";
import { rutaPermitida } from "@/lib/auth/rutas-roles";
import type { ResumenCxpJson } from "@/lib/cxp/contratos-api";
import { hoyBogotaISO } from "@/lib/tiempo/bogota";

type LoadState = "loading" | "ready" | "error";

/**
 * Crear ("Nuevo pago", "Pagar en bloque" → /api/pagos/multi), editar en línea y
 * eliminar exigen ADMIN/OPERATIVO. REVISOR consulta en solo lectura.
 */
const ROLES_EDITAR_PAGOS = ["ADMIN", "OPERATIVO"] as const;
/** D-6 / R16: los totales del proveedor (facturado, pagado, pendiente) solo para ADMIN y REVISOR. */
const ROLES_TOTALES_PROVEEDOR = ["ADMIN", "REVISOR"] as const;

function canalPagoLabel(canal: CanalPago): string {
  return CANALES_PAGO.find((c) => c.value === canal)?.label ?? canal;
}

// ---------------------------------------------------------------------------
// Helpers de formato / parseo
// ---------------------------------------------------------------------------

/**
 * Lee el texto canónico que entrega `CampoMoneda` (pesos, hasta 2 decimales)
 * y devuelve el mismo texto canónico si es válido y > 0; null si no.
 */
function parseBigIntInput(raw: string): string | null {
  const limpio = raw.trim();
  if (limpio === "" || limpio === "-") return null;
  try {
    const c = centavosDeTexto(limpio);
    return c > 0n ? textoCanonicoDeCentavos(c) : null;
  } catch {
    return null;
  }
}

/** Centavos de un pesos-texto (API o canónico); 0n si viene vacío o dañado. */
function centavosSeguro(raw: string): bigint {
  try {
    return centavosDeTexto(raw);
  } catch {
    return 0n;
  }
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
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

// ---------------------------------------------------------------------------
// Fila de pago (CxP v2, §D.5) — normalizada AQUÍ y no con `fetchPagosGlobal`
// de `pagos-global-api.ts` (P4): esa función manda el filtro de proveedor con
// el nombre de parámetro equivocado (`proveedorId` en vez de
// `proveedorEmpresaId`/`beneficiarioId`, que es lo único que valida
// `listarPagosQuerySchema`), no lee `costosAsumidosGalcomex` ni `proveedor`
// de la respuesta (llaves reales del backend), y lee `raw.facturas` cuando el
// campo real de cada fila es `aplicaciones` (`CamposCxpPago` en
// `src/lib/pagos/service.ts`). El detalle exacto de los cuatro desajustes
// está en el informe de este paquete (pedido a P4). Mientras tanto, el módulo
// habla directo con `/api/pagos` con los nombres de parámetro reales.
// ---------------------------------------------------------------------------

export type AplicacionFilaPago = {
  facturaId: string;
  numFactura: string;
  numFacturaVisible: string;
  monto: string;
};

type GrupoFilaPago = {
  estado: "ACTIVO" | "ANULADO";
  costoBancario: string;
  costoAsumidoPor: CostoAsumidoPor;
  esHistorico: boolean;
  otrosDOs: GrupoPagoDOInfo[];
};

export type PagoRow = {
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
  faltaComprobante: boolean;
  /** Id del grupo de pago en bloque (null = pago normal de un solo DO). */
  grupoPagoId: string | null;
  /** Otros DOs del mismo grupoPagoId (vacío si no es un pago en bloque). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
  /** Facturas de proveedor que cubre este pago, con su monto (§D.5: "FE 12481 · $464.077"). */
  aplicaciones: AplicacionFilaPago[];
  /** true = el pago tiene facturas aplicadas (pago suelto con `aplicaciones` o "Generar pago"). */
  tieneFacturas: boolean;
  esBloque: boolean;
  /** false = valor y canal de solo lectura (pago con facturas o de un bloque). */
  editableDinero: boolean;
  grupo: GrupoFilaPago | null;
  valor: string; // BigInt serializado
  canalPago: CanalPago;
  costoBancario: string; // BigInt serializado
  orden: number;
  fechaRealPago: string | null; // ISO
  createdAt: string;
  updatedAt: string;
};

export function normalizeGrupoOtrosDOs(raw: unknown): GrupoPagoDOInfo[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter(isRecord)
    .map((g) => ({ tramiteId: String(g.tramiteId ?? ""), consecutivo: String(g.consecutivo ?? "") }));
}

export function normalizeAplicacion(raw: unknown): AplicacionFilaPago | null {
  if (!isRecord(raw)) return null;
  return {
    facturaId: String(raw.facturaId ?? ""),
    numFactura: String(raw.numFactura ?? ""),
    numFacturaVisible: String(raw.numFacturaVisible ?? raw.numFactura ?? ""),
    monto: String(raw.monto ?? "0"),
  };
}

export function normalizeGrupo(raw: unknown): GrupoFilaPago | null {
  if (!isRecord(raw)) return null;
  return {
    estado: raw.estado === "ANULADO" ? "ANULADO" : "ACTIVO",
    costoBancario: String(raw.costoBancario ?? "0"),
    costoAsumidoPor: (raw.costoAsumidoPor as CostoAsumidoPor) ?? "PRIMER_DO",
    esHistorico: raw.esHistorico === true,
    otrosDOs: normalizeGrupoOtrosDOs(raw.otrosDOs),
  };
}

export function normalizePagoRow(raw: unknown): PagoRow | null {
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
        .filter(isRecord)
        .map((link) => {
          const b = isRecord(link.beneficiario) ? link.beneficiario : link;
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
    grupoOtrosDOs: normalizeGrupoOtrosDOs(raw.grupoOtrosDOs),
    aplicaciones: (Array.isArray(raw.aplicaciones) ? raw.aplicaciones : [])
      .map(normalizeAplicacion)
      .filter((a): a is AplicacionFilaPago => a !== null),
    tieneFacturas: raw.tieneFacturas === true,
    esBloque: raw.esBloque === true,
    editableDinero: raw.editableDinero !== false,
    grupo: normalizeGrupo(raw.grupo),
    valor: String(raw.valor ?? "0"),
    canalPago: (raw.canalPago as CanalPago) ?? "OTRO",
    costoBancario: String(raw.costoBancario ?? "0"),
    orden: typeof raw.orden === "number" ? raw.orden : 0,
    fechaRealPago: typeof raw.fechaRealPago === "string" ? raw.fechaRealPago : null,
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

/** §D.4/§D.5: valor y canal de solo lectura en un pago con facturas o de un bloque. */
export function esDineroSoloLectura(fila: Pick<PagoRow, "tieneFacturas" | "esBloque">, readOnly: boolean): boolean {
  return readOnly || fila.tieneFacturas || fila.esBloque;
}

/** "(3 facturas en 3 DOs)" / "(1 factura en 1 DO)" — franja del proveedor (§D.5). */
/**
 * "Costos bancarios" de la tarjeta al recalcular en la pantalla tras editar o
 * borrar: Σ costo de cada pago + lo que asumió Galcomex en los bloques (que no
 * está en ningún pago). Mismo total que da el servidor al cargar.
 */
export function totalCostosBancarios(costosPorPago: readonly string[], costosAsumidosGalcomex: string): bigint {
  return costosPorPago.reduce((s, c) => s + centavosSeguro(c || "0"), 0n) + centavosSeguro(costosAsumidosGalcomex || "0");
}

export function textoFacturasEnDOs(facturasConSaldo: number, dosConSaldo: number): string {
  const facturaLabel = facturasConSaldo === 1 ? "factura" : "facturas";
  const doLabel = dosConSaldo === 1 ? "DO" : "DOs";
  return `${facturasConSaldo} ${facturaLabel} en ${dosConSaldo} ${doLabel}`;
}

/**
 * "de ellos $Y asumidos por Galcomex" bajo la tarjeta "Costos bancarios"
 * (R8/§D.5) — null cuando Galcomex no asumió ningún costo del período.
 */
export function textoCostosBancariosDetalle(costosAsumidosGalcomex: string): string | null {
  const monto = centavosSeguro(costosAsumidosGalcomex || "0");
  if (monto <= 0n) return null;
  return `de ellos ${formatCOP(costosAsumidosGalcomex)} asumidos por Galcomex`;
}

/** Selección del filtro "Proveedor" (§D.5): empresa proveedora o ficha suelta. */
type ProveedorTipo = "EMPRESA" | "FICHA";
type ProveedorSeleccion = { tipo: ProveedorTipo; id: string; nombre: string; nit: string | null };

type ProveedorMeta = { nombre: string; facturasConSaldo: number; dosConSaldo: number };

type PagosGlobalDataLocal = {
  pagos: PagoRow[];
  totalPagos: string;
  costosBancarios: string;
  /** De `costosBancarios`, lo que asumió Galcomex (bloques `costoAsumidoPor=GALCOMEX`). */
  costosAsumidosGalcomex: string;
  totalSinFecha: string;
  resumenProveedor: ResumenCxpJson | null;
  proveedorMeta: ProveedorMeta | null;
};

/** `GET /api/pagos` con los nombres de parámetro reales (`listarPagosQuerySchema`, P1). */
async function fetchPagosGlobalDirecto(
  filtros: {
    clienteId?: string;
    canalPago?: CanalPago | "";
    soloPendientes?: boolean;
    proveedor?: ProveedorSeleccion | null;
  },
  signal?: AbortSignal,
): Promise<PagosGlobalDataLocal> {
  const url = new URL("/api/pagos", window.location.origin);
  if (filtros.clienteId) url.searchParams.set("clienteId", filtros.clienteId);
  if (filtros.canalPago) url.searchParams.set("canalPago", filtros.canalPago);
  if (filtros.soloPendientes) url.searchParams.set("solo_pendientes", "true");
  if (filtros.proveedor) {
    if (filtros.proveedor.tipo === "EMPRESA") {
      url.searchParams.set("proveedorEmpresaId", filtros.proveedor.id);
    } else {
      url.searchParams.set("beneficiarioId", filtros.proveedor.id);
    }
  }

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
  const pagos = rawPagos.map(normalizePagoRow).filter((p): p is PagoRow => p !== null);
  const proveedorRaw = payload.proveedor;

  return {
    pagos,
    totalPagos: String(payload.totalPagos ?? "0"),
    costosBancarios: String(payload.costosBancarios ?? "0"),
    costosAsumidosGalcomex: String(payload.costosAsumidosGalcomex ?? "0"),
    totalSinFecha: String(payload.totalSinFecha ?? payload.totalPendiente ?? "0"),
    resumenProveedor: isRecord(payload.resumenProveedor)
      ? (payload.resumenProveedor as unknown as ResumenCxpJson)
      : null,
    proveedorMeta: isRecord(proveedorRaw)
      ? {
          nombre: String(proveedorRaw.nombre ?? ""),
          facturasConSaldo: typeof proveedorRaw.facturasConSaldo === "number" ? proveedorRaw.facturasConSaldo : 0,
          dosConSaldo: typeof proveedorRaw.dosConSaldo === "number" ? proveedorRaw.dosConSaldo : 0,
        }
      : null,
  };
}

/**
 * Opciones del combo "Proveedor" (§D.5): empresas con `esProveedor=true`
 * (`/api/clientes?rol=proveedor`, F1) + fichas de pago sueltas sin empresa (`/api/beneficiarios`,
 * `empresaId == null` — las que ya están enlazadas a una empresa quedan
 * cubiertas por su grupo "Empresas proveedoras").
 */
async function fetchProveedorOptions(signal?: AbortSignal): Promise<ProveedorSeleccion[]> {
  const [clientesRes, beneficiariosRes] = await Promise.all([
    fetch("/api/clientes?rol=proveedor", { cache: "no-store", headers: { Accept: "application/json" }, signal }),
    fetch("/api/beneficiarios", { cache: "no-store", headers: { Accept: "application/json" }, signal }),
  ]);

  const empresas: ProveedorSeleccion[] = [];
  if (clientesRes.ok) {
    const payload: unknown = await clientesRes.json().catch(() => null);
    const lista = isRecord(payload) && Array.isArray(payload.clientes) ? payload.clientes : [];
    for (const c of lista) {
      if (!isRecord(c) || c.esProveedor !== true) continue;
      empresas.push({
        tipo: "EMPRESA",
        id: String(c.id ?? ""),
        nombre: String(c.nombre ?? ""),
        nit: typeof c.nit === "string" ? c.nit : null,
      });
    }
  }

  const fichas: ProveedorSeleccion[] = [];
  if (beneficiariosRes.ok) {
    const payload: unknown = await beneficiariosRes.json().catch(() => null);
    const lista = isRecord(payload) && Array.isArray(payload.beneficiarios) ? payload.beneficiarios : [];
    for (const b of lista) {
      if (!isRecord(b) || b.empresaId) continue;
      fichas.push({
        tipo: "FICHA",
        id: String(b.id ?? ""),
        nombre: String(b.nombreCorto ?? b.nombre ?? ""),
        nit: typeof b.nit === "string" ? b.nit : null,
      });
    }
  }

  empresas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  fichas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return [...empresas, ...fichas];
}

/**
 * Resuelve el `beneficiarioInicial` que exige `PagoEnBloqueModal` (siempre
 * una FICHA, `BeneficiarioSeleccion`). Con una empresa proveedora, toma su
 * primera ficha de pago (`GET /api/clientes/[id]/cuenta-proveedor`, P1): el
 * dominio une por NIT base (`fichasHermanas`), así que cualquiera de sus
 * fichas trae el mismo total de facturas.
 */
async function resolverBeneficiarioInicial(proveedor: ProveedorSeleccion): Promise<BeneficiarioSeleccion | null> {
  if (proveedor.tipo === "FICHA") {
    return { id: proveedor.id, nombre: proveedor.nombre, nit: proveedor.nit };
  }
  try {
    const response = await fetch(`/api/clientes/${encodeURIComponent(proveedor.id)}/cuenta-proveedor`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json().catch(() => null);
    const fichas = isRecord(payload) && Array.isArray(payload.fichas) ? payload.fichas : [];
    const primera = fichas.find(isRecord);
    if (!primera) return null;
    return {
      id: String(primera.id ?? ""),
      nombre: String(primera.nombreCorto ?? primera.nombre ?? proveedor.nombre),
      nit: typeof primera.nit === "string" ? primera.nit : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fila editable
// ---------------------------------------------------------------------------

type FilaPago = PagoRow & {
  editingConcepto: string;
  editingNumSoporte: string;
  editingValor: string;
  editingCanal: CanalPago;
  editingFechaReal: string;
  dirty: boolean;
  saving: boolean;
  errorFila: string | null;
  /** Mensaje de CampoMoneda si lo escrito en «Valor» no es un monto válido. */
  errorValor: string | null;
  /** El cambio no se mandó porque no pasa la validación (no hubo rollback). */
  errorValidacion: string | null;
};

function filaFromRow(row: PagoRow): FilaPago {
  return {
    ...row,
    editingConcepto: row.concepto,
    editingNumSoporte: row.numSoporte ?? "",
    editingValor: row.valor,
    editingCanal: row.canalPago,
    editingFechaReal: isoToDateInput(row.fechaRealPago),
    dirty: false,
    saving: false,
    errorFila: null,
    errorValor: null,
    errorValidacion: null,
  };
}

// ---------------------------------------------------------------------------
// Modal: nuevo pago (con selector de DO)
// ---------------------------------------------------------------------------

type NuevoPagoModalProps = {
  tramites: TramiteOption[];
  tramiteIdInicial?: string;
  onClose: () => void;
  onCreated: () => void;
};

function NuevoPagoModal({ tramites, tramiteIdInicial, onClose, onCreated }: NuevoPagoModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState("");
  const [beneficiariosSel, setBeneficiariosSel] = useState<BeneficiarioSeleccion[]>([]);
  // Idempotencia (§B.5): una clave por formulario; se renueva tras guardar o con IDEMPOTENCIA_CONFLICTO.
  const [claveIdempotencia, setClaveIdempotencia] = useState(nuevaClaveIdempotencia);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const formData = new FormData(e.currentTarget);
    const tramiteId = String(formData.get("tramiteId") ?? "").trim();
    const concepto = String(formData.get("concepto") ?? "").trim();
    const canalPago = String(formData.get("canalPago") ?? "") as CanalPago;
    const fechaRealPago = String(formData.get("fechaRealPago") ?? "").trim() || null;

    if (!tramiteId) {
      setError("Selecciona el DO al que pertenece el pago.");
      return;
    }

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig) {
      setError("El valor debe ser mayor a 0.");
      return;
    }

    setIsSubmitting(true);
    try {
      const pago = await createPago(tramiteId, {
        concepto,
        beneficiarioIds: beneficiariosSel.map((b) => b.id),
        numSoporte: null,
        valor: valorBig,
        canalPago,
        fechaRealPago,
        claveIdempotencia,
      });
      setClaveIdempotencia(nuevaClaveIdempotencia());
      const consecutivo = tramites.find((t) => t.id === tramiteId)?.consecutivo ?? "";
      toast({
        title: pago.repetido ? "Este pago ya estaba guardado" : "Pago guardado",
        description: `${concepto} · ${formatCOP(pago.valor)}${consecutivo ? ` en ${consecutivo}` : ""}`,
        variant: "success",
      });
      onCreated();
    } catch (caught) {
      if ((caught as { codigo?: string } | null)?.codigo === "IDEMPOTENCIA_CONFLICTO") {
        setClaveIdempotencia(nuevaClaveIdempotencia());
      }
      setError(describirError(caught, "Error al crear el pago."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Agregar pago"
      description="Pago a proveedor cargado al DO que elijas."
      size="lg"
      dismissible={!isSubmitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Trámite (DO) *</span>
            <select
              name="tramiteId"
              required
              defaultValue={tramiteIdInicial ?? ""}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <option value="">Seleccionar DO</option>
              {tramites.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.consecutivo} — {t.clienteNombre}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Concepto *</span>
            <input
              name="concepto"
              required
              placeholder="Ej. Flete terrestre"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Beneficiarios</span>
            <BeneficiarioCombobox
              mode="multi"
              value={beneficiariosSel}
              onChange={setBeneficiariosSel}
              placeholder="Buscar o crear beneficiario…"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
              <input
                type="date"
                name="fechaRealPago"
                defaultValue={hoyBogotaISO()}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
              <CampoMoneda
                value={valorRaw}
                onValueChange={setValorRaw}
                placeholder="1.000.000"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
              <select
                name="canalPago"
                required
                defaultValue="TRANSF_BANCOLOMBIA"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                {CANALES_PAGO.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Guardar pago
            </button>
          </div>
        </form>
    </ModalShell>
  );
}


// ---------------------------------------------------------------------------
// Fila de la tabla (edición inline + autosave)
// ---------------------------------------------------------------------------

type FilaPagoProps = {
  fila: FilaPago;
  /** Solo lectura (REVISOR): sin inputs ni acciones. */
  readOnly: boolean;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaPago,
      | "editingConcepto"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
    detalle?: DetalleCampoMoneda,
  ) => void;
  onBlur: (id: string) => void;
  onDelete: (fila: FilaPago) => void;
  /** Sube y adjunta el comprobante bancario a un pago ya guardado. */
  onAdjuntarComprobante: (fila: FilaPago, file: File) => void;
  /** Pago de un bloque: no se borra suelto (409 PAGO_DE_BLOQUE); se ve el bloque. */
  onVerBloque: (grupoPagoId: string) => void;
  /** "Anular bloque" (solo ADMIN, R16); sin él no se muestra. */
  onAnularBloque?: (fila: FilaPago) => void;
};

function FilaPagoRow({
  fila,
  readOnly,
  isDeleting,
  onChange,
  onBlur,
  onDelete,
  onAdjuntarComprobante,
  onVerBloque,
  onAnularBloque,
}: FilaPagoProps) {
  const etiqueta = `pago "${fila.concepto}" del DO ${fila.consecutivo}`;
  // §D.4/§D.5: valor y canal de solo lectura en un pago con facturas o de un bloque
  // (se anula y se registra de nuevo, no se edita a mano).
  const soloLecturaDinero = esDineroSoloLectura(fila, readOnly);
  const totalDOsBloque = fila.grupoOtrosDOs.length + 1;

  return (
    <>
      <tr className={`border-b border-slate-100 last:border-b-0 ${fila.saving ? "opacity-60" : ""} hover:bg-slate-50`}>
        {/* DO */}
        <td className="whitespace-nowrap px-3 py-2">
          <EnlaceTramite
            id={fila.tramiteId}
            tab="pagos"
            className="text-sm font-medium"
          >
            {fila.consecutivo}
          </EnlaceTramite>
        </td>

        {/* Cliente */}
        <td className="px-3 py-2 text-sm text-slate-700">
          <EnlaceCliente id={fila.clienteId}>{fila.clienteNombre}</EnlaceCliente>
        </td>

        {/* Concepto */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="block min-w-[140px] px-1 text-sm text-slate-800">{fila.concepto}</span>
          ) : (
            <input
              value={fila.editingConcepto}
              onChange={(e) => onChange(fila.id, "editingConcepto", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Concepto del ${etiqueta}`}
              className="h-8 w-full min-w-[140px] border border-transparent bg-transparent px-1 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
          {fila.aplicaciones.length > 0 ? (
            <div className="space-y-0.5 px-1 pb-0.5">
              {fila.aplicaciones.map((a) => (
                <p key={a.facturaId} className="text-[11px] text-slate-500">
                  {a.numFacturaVisible || a.numFactura} · {formatCOP(a.monto)}
                </p>
              ))}
            </div>
          ) : null}
          {fila.faltaComprobante || fila.grupoPagoId ? (
            <div className="flex flex-wrap gap-1 px-1 pb-0.5">
              {fila.faltaComprobante ? (
                <span
                  className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                  title="Pago sin comprobante bancario"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Falta comprobante
                </span>
              ) : null}
              {fila.faltaComprobante && !readOnly ? (
                <label
                  className={`inline-flex w-fit items-center gap-1 border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-50 ${
                    fila.saving ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}
                  title="Adjuntar el comprobante bancario a este pago"
                >
                  <Upload className="h-3 w-3" aria-hidden="true" />
                  Adjuntar comprobante
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    disabled={fila.saving}
                    className="hidden"
                    aria-label={`Adjuntar comprobante bancario del ${etiqueta}`}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onAdjuntarComprobante(fila, file);
                      e.target.value = "";
                    }}
                  />
                </label>
              ) : null}
              {fila.grupoPagoId ? (
                <span
                  className="inline-flex items-center border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700"
                  title={
                    fila.grupoOtrosDOs.length > 0
                      ? `Pago en bloque — también cubre: ${fila.grupoOtrosDOs.map((g) => g.consecutivo).join(", ")}`
                      : "Pago en bloque"
                  }
                >
                  {fila.grupoOtrosDOs.length > 0 ? `Pago en bloque · ${totalDOsBloque} DOs` : "Pago en bloque"}
                </span>
              ) : null}
            </div>
          ) : null}
        </td>

        {/* Beneficiarios (solo lectura en vista global) */}
        <td className="px-3 py-2 text-sm text-slate-700">
          {fila.beneficiarios || <span className="text-slate-400">—</span>}
        </td>

        {/* N° soporte */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">{fila.numSoporte ?? "—"}</span>
          ) : (
            <input
              value={fila.editingNumSoporte}
              onChange={(e) => onChange(fila.id, "editingNumSoporte", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              placeholder="—"
              aria-label={`Número de soporte del ${etiqueta}`}
              className="h-8 w-full min-w-[100px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Valor */}
        <td className="px-3 py-2 text-right">
          {soloLecturaDinero ? (
            <span className="text-sm font-medium text-slate-900" title={fila.tieneFacturas || fila.esBloque ? "Pago con facturas o de un bloque: anula y registra de nuevo para cambiar el valor" : undefined}>
              {formatCOP(fila.valor)}
            </span>
          ) : (
            <CampoMoneda
              value={fila.editingValor}
              onValueChange={(digitos, detalle) => onChange(fila.id, "editingValor", digitos, detalle)}
              onFocus={(e) => e.target.select()}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Valor del ${etiqueta} (COP)`}
              className="h-8 w-full min-w-[110px] border border-transparent bg-transparent px-1 text-right text-sm font-medium text-slate-900 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Canal */}
        <td className="px-3 py-2">
          {soloLecturaDinero ? (
            <span className="text-sm text-slate-700">{canalPagoLabel(fila.canalPago)}</span>
          ) : (
            <select
              value={fila.editingCanal}
              onChange={(e) => {
                onChange(fila.id, "editingCanal", e.target.value);
                onBlur(fila.id);
              }}
              aria-label={`Canal de pago del ${etiqueta}`}
              className="h-8 w-full min-w-[180px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
            >
              {CANALES_PAGO.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </td>

        {/* Fecha real */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">
              {fila.fechaRealPago ? formatDate(fila.fechaRealPago) : "—"}
            </span>
          ) : (
            <input
              type="date"
              value={fila.editingFechaReal}
              onChange={(e) => onChange(fila.id, "editingFechaReal", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Fecha de pago del ${etiqueta}`}
              className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Costo bancario (solo lectura) */}
        <td className="px-3 py-2 text-right text-sm text-slate-600">
          {formatCOP(fila.costoBancario)}
        </td>

        {/* Acciones */}
        <td className="px-3 py-2">
          {readOnly ? null : (
            <div className="flex items-center gap-1">
              {fila.saving ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
              ) : fila.dirty ? (
                <span className="h-2 w-2 rounded-full bg-amber-400" title="Cambios pendientes" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-slate-300" aria-hidden="true" />
              )}
              {fila.esBloque && fila.grupoPagoId ? (
                // Un pago de bloque no se borra suelto: se anula el bloque completo.
                <>
                  <button
                    type="button"
                    onClick={() => onVerBloque(fila.grupoPagoId as string)}
                    className="whitespace-nowrap px-1 text-xs font-semibold text-cyan-700 hover:underline"
                  >
                    Ver bloque
                  </button>
                  {onAnularBloque ? (
                    <button
                      type="button"
                      onClick={() => onAnularBloque(fila)}
                      className="whitespace-nowrap px-1 text-xs font-semibold text-rose-700 hover:underline"
                    >
                      Anular bloque
                    </button>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onDelete(fila)}
                  disabled={isDeleting}
                  className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                  aria-label={`Eliminar ${etiqueta}`}
                  title="Eliminar pago"
                >
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          )}
        </td>
      </tr>

      {fila.errorFila ? (
        <tr className="bg-rose-50">
          <td colSpan={10} className="px-3 py-1.5 text-xs text-rose-700" role="alert">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
      {fila.errorValidacion ? (
        <tr className="bg-rose-50">
          <td colSpan={10} className="px-3 py-1.5 text-xs text-rose-700" role="alert">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorValidacion} — el cambio no se guardó.
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export type PagosWorkspaceProps = {
  /** Deep-link desde otra pantalla (p. ej. la ficha del proveedor) — §G, P6. */
  proveedorInicial?: { tipo: ProveedorTipo; id: string } | null;
};

export function PagosWorkspace({ proveedorInicial = null }: PagosWorkspaceProps) {
  const puedeEditar = usePermiso(ROLES_EDITAR_PAGOS);
  const puedeVerTotalesProveedor = usePermiso(ROLES_TOTALES_PROVEEDOR);
  const esAdmin = usePermiso(["ADMIN"]);
  const rol = useRol();
  const puedeVerFichaProveedor = rutaPermitida("/clientes", rol);
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [filas, setFilas] = useState<FilaPago[]>([]);
  const [totales, setTotales] = useState({ totalPagos: "0", costosBancarios: "0", totalPendiente: "0" });
  const [costosAsumidosGalcomex, setCostosAsumidosGalcomex] = useState("0");
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [tramites, setTramites] = useState<TramiteOption[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [multiDOOpen, setMultiDOOpen] = useState(false);
  const [beneficiarioParaBloque, setBeneficiarioParaBloque] = useState<BeneficiarioSeleccion | null>(null);
  const [resolviendoBloqueProveedor, setResolviendoBloqueProveedor] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bloqueParaDetalle, setBloqueParaDetalle] = useState<string | null>(null);
  const [bloqueParaAnular, setBloqueParaAnular] = useState<{ grupoPagoId: string; resumen: string } | null>(null);

  // Filtros
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroCanal, setFiltroCanal] = useState<CanalPago | "">("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [busqueda, setBusqueda] = useState("");

  // Filtro "Proveedor" (§D.5)
  const [proveedorOptions, setProveedorOptions] = useState<ProveedorSeleccion[]>([]);
  const [proveedorSel, setProveedorSel] = useState<ProveedorSeleccion | null>(null);
  const [resumenProveedor, setResumenProveedor] = useState<ResumenCxpJson | null>(null);
  const [proveedorMeta, setProveedorMeta] = useState<ProveedorMeta | null>(null);

  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Opciones del filtro "Proveedor" (independiente de la carga de pagos) ---
  useEffect(() => {
    const controller = new AbortController();
    fetchProveedorOptions(controller.signal)
      .then((opts) => {
        setProveedorOptions(opts);
        setProveedorSel((actual) => {
          if (actual || !proveedorInicial) return actual;
          const match = opts.find((o) => o.tipo === proveedorInicial.tipo && o.id === proveedorInicial.id);
          return match ?? { tipo: proveedorInicial.tipo, id: proveedorInicial.id, nombre: "", nit: null };
        });
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        // El combo de proveedor es una ayuda adicional: si falla su carga, el
        // resto del módulo sigue funcionando sin ese filtro.
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proveedorInicial?.tipo, proveedorInicial?.id]);

  // --- Carga ---
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);

      const [data, clientesData, tramitesData] = await Promise.all([
        fetchPagosGlobalDirecto(
          {
            clienteId: filtroCliente || undefined,
            canalPago: filtroCanal || undefined,
            soloPendientes: soloPendientes || undefined,
            proveedor: proveedorSel,
          },
          controller.signal,
        ),
        fetchClienteOptions(controller.signal),
        fetchTramiteOptions(controller.signal),
      ]);

      setFilas(data.pagos.map(filaFromRow));
      setTotales({
        totalPagos: data.totalPagos,
        costosBancarios: data.costosBancarios,
        totalPendiente: data.totalSinFecha,
      });
      setCostosAsumidosGalcomex(data.costosAsumidosGalcomex);
      setResumenProveedor(data.resumenProveedor);
      setProveedorMeta(data.proveedorMeta);
      setClientes(clientesData);
      setTramites(tramitesData);
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar los pagos.");
      setLoadState("error");
    });

    return () => controller.abort();
  }, [reloadKey, filtroCliente, filtroCanal, soloPendientes, proveedorSel]);


  // Búsqueda en cliente (concepto / beneficiario / N° soporte / DO)
  const filasVisibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter(
      (f) =>
        f.concepto.toLowerCase().includes(q) ||
        (f.beneficiarios ?? "").toLowerCase().includes(q) ||
        (f.numSoporte ?? "").toLowerCase().includes(q) ||
        f.consecutivo.toLowerCase().includes(q),
    );
  }, [filas, busqueda]);

  // --- Edición inline ---
  function handleFieldChange(
    id: string,
    field: keyof Pick<
      FilaPago,
      | "editingConcepto"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
    detalle?: DetalleCampoMoneda,
  ) {
    setFilas((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              [field]: value,
              dirty: true,
              errorFila: null,
              errorValidacion: null,
              ...(field === "editingValor" ? { errorValor: detalle && !detalle.ok ? detalle.mensaje : null } : {}),
            }
          : f,
      ),
    );
  }

  function scheduleAutoSave(id: string) {
    if (saveTimersRef.current[id]) clearTimeout(saveTimersRef.current[id]);
    saveTimersRef.current[id] = setTimeout(() => void commitFila(id), 900);
  }

  function handleBlurField(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (fila?.dirty) scheduleAutoSave(id);
  }

  async function commitFila(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (!fila) return;

    // Un valor vacío o mal escrito NO se cambia en silencio por el anterior.
    const valorGuardar = valorFilaParaGuardar(fila.editingValor, fila.errorValor);
    if (!valorGuardar.ok) {
      setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, errorValidacion: valorGuardar.mensaje } : f)));
      return;
    }

    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)));

    const snapshot = { ...fila };

    try {
      const updated = await updatePago(fila.tramiteId, id, {
        concepto: fila.editingConcepto,
        numSoporte: fila.editingNumSoporte || null,
        valor: valorGuardar.valor,
        canalPago: fila.editingCanal,
        fechaRealPago: fila.editingFechaReal || null,
      });

      setFilas((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f;
          return {
            ...f,
            concepto: updated.concepto,
            beneficiarios: updated.beneficiarios.map((b) => b.nombre).join(", "),
            numSoporte: updated.numSoporte,
            valor: updated.valor,
            canalPago: updated.canalPago,
            costoBancario: updated.costoBancario,
            fechaRealPago: updated.fechaRealPago,
            editingConcepto: updated.concepto,
            editingNumSoporte: updated.numSoporte ?? "",
            editingValor: updated.valor,
            editingCanal: updated.canalPago,
            editingFechaReal: isoToDateInput(updated.fechaRealPago),
            dirty: false,
            saving: false,
            errorFila: null,
          };
        }),
      );
      // Recalcular totales tras edición confirmada
      setReloadTotales();
      toast({
        title: "Pago actualizado",
        description: `${updated.concepto} · ${fila.consecutivo}`,
        variant: "success",
      });
    } catch (caught) {
      const msg = describirError(caught, "Error al guardar.");
      setFilas((prev) =>
        prev.map((f) => (f.id === id ? { ...snapshot, saving: false, errorFila: msg } : f)),
      );
      toast({ title: "No se pudo guardar el pago", description: msg, variant: "error" });
    }
  }

  /**
   * Adjunta el comprobante bancario a un pago YA guardado (decisión de
   * negocio: se puede registrar el pago sin comprobante y adjuntarlo después).
   * Mismo componente de subida que usa NuevoPagoModal (subirComprobante).
   */
  async function handleAdjuntarComprobante(fila: FilaPago, file: File) {
    setFilas((prev) => prev.map((f) => (f.id === fila.id ? { ...f, saving: true, errorFila: null } : f)));

    try {
      const documento = await subirComprobante(fila.tramiteId, "COMPROBANTE_BANCARIO", file);
      const updated = await updatePago(fila.tramiteId, fila.id, { documentoId: documento.id });

      setFilas((prev) =>
        prev.map((f) =>
          f.id === fila.id
            ? {
                ...f,
                documentoId: updated.documentoId,
                faltaComprobante: updated.faltaComprobante,
                saving: false,
                errorFila: null,
              }
            : f,
        ),
      );
      toast({
        title: "Comprobante adjuntado",
        description: `${updated.concepto} · ${fila.consecutivo}`,
        variant: "success",
      });
    } catch (caught) {
      const msg = describirError(caught, "Error al adjuntar el comprobante.");
      setFilas((prev) => prev.map((f) => (f.id === fila.id ? { ...f, saving: false, errorFila: msg } : f)));
      toast({ title: "No se pudo adjuntar el comprobante", description: msg, variant: "error" });
    }
  }

  // Recalcula los totales de las tarjetas a partir de las filas actuales
  // (costosAsumidosGalcomex y el resumen de proveedor no se recalculan aquí:
  // se refrescan en el próximo `reloadKey`).
  function setReloadTotales() {
    setFilas((prev) => {
      const totalPagos = prev.reduce((s, f) => s + centavosSeguro(parseBigIntInput(f.editingValor) ?? f.valor), 0n);
      // + lo que Galcomex asumió en los bloques (no está en ningún pago): mismo total que el servidor.
      const costosBancarios = totalCostosBancarios(
        prev.map((f) => f.costoBancario),
        costosAsumidosGalcomex,
      );
      const totalPendiente = prev.reduce(
        (s, f) => (f.fechaRealPago === null ? s + centavosSeguro(parseBigIntInput(f.editingValor) ?? f.valor) : s),
        0n,
      );
      setTotales({
        totalPagos: textoDeCentavos(totalPagos),
        costosBancarios: textoDeCentavos(costosBancarios),
        totalPendiente: textoDeCentavos(totalPendiente),
      });
      return prev;
    });
  }

  async function handleDelete(fila: FilaPago) {
    if (deletingId) return;
    const ok = await confirmar({
      title: `¿Eliminar el pago "${fila.concepto}"?`,
      description: `DO ${fila.consecutivo} · ${formatCOP(fila.valor)}. Esta acción no se puede deshacer.`,
      confirmText: "Eliminar pago",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(fila.id);

    try {
      await deletePago(fila.tramiteId, fila.id);
      setFilas((prev) => prev.filter((f) => f.id !== fila.id));
      setReloadTotales();
      toast({ title: "Pago eliminado", description: `${fila.concepto} · ${fila.consecutivo}`, variant: "success" });
    } catch (caught) {
      toast({
        title: "No se pudo eliminar el pago",
        description: describirError(caught, "Error al eliminar."),
        variant: "error",
      });
    } finally {
      setDeletingId(null);
    }
  }

  function handlePagoCreado() {
    setCreateOpen(false);
    setReloadKey((k) => k + 1);
  }

  function abrirBloqueSinProveedor() {
    setBeneficiarioParaBloque(null);
    setMultiDOOpen(true);
  }

  /** "Pagar en bloque" desde la franja del proveedor filtrado (§D.5). */
  async function abrirBloqueParaProveedor() {
    if (!proveedorSel || resolviendoBloqueProveedor) return;
    setResolviendoBloqueProveedor(true);
    try {
      const beneficiario = await resolverBeneficiarioInicial(proveedorSel);
      if (!beneficiario) {
        toast({
          title: "No se pudo abrir el pago en bloque",
          description: "Este proveedor no tiene una ficha de pago activa.",
          variant: "error",
        });
        return;
      }
      setBeneficiarioParaBloque(beneficiario);
      setMultiDOOpen(true);
    } finally {
      setResolviendoBloqueProveedor(false);
    }
  }

  function handlePagoMultiDOCreado() {
    setMultiDOOpen(false);
    setBeneficiarioParaBloque(null);
    setReloadKey((k) => k + 1);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isInitialLoading = loadState === "loading" && filas.length === 0;

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Pagos</h1>
          <p className="mt-1 text-sm text-slate-600">
            Vista global de todos los pagos de todos los DOs. El libro por trámite sigue intacto.
          </p>
        </div>
        {puedeEditar ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={abrirBloqueSinProveedor}
              className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              title="Un solo comprobante cubre facturas de proveedor de varios DOs"
            >
              <Users className="h-4 w-4" aria-hidden="true" />
              Pagar en bloque
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo pago
            </button>
          </div>
        ) : null}
      </div>

      {!puedeEditar ? (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Solo lectura para tu perfil: crear, editar o eliminar pagos requiere ADMIN u OPERATIVO.
        </p>
      ) : null}

      {/* Tarjetas de resumen */}
      {isInitialLoading ? (
        <CardsSkeleton count={3} height={84} />
      ) : loadState === "ready" || filas.length > 0 ? (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total pagado", value: totales.totalPagos, color: "text-slate-900", detalle: null as string | null },
            {
              label: "Costos bancarios",
              value: totales.costosBancarios,
              color: "text-slate-700",
              detalle: textoCostosBancariosDetalle(costosAsumidosGalcomex),
            },
            { label: "Pagos sin fecha de pago", value: totales.totalPendiente, color: "text-amber-700", detalle: null },
          ].map((s) => (
            <div key={s.label} className="border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</p>
              <p className={`mt-1 text-xl font-bold ${s.color}`}>{formatCOP(s.value)}</p>
              {s.detalle ? <p className="mt-0.5 text-[11px] text-slate-500">{s.detalle}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 text-sm">
        <select
          value={filtroCliente}
          onChange={(e) => setFiltroCliente(e.target.value)}
          aria-label="Filtrar por cliente"
          className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
        >
          <option value="">Todos los clientes</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>

        <select
          value={proveedorSel ? `${proveedorSel.tipo}:${proveedorSel.id}` : ""}
          onChange={(e) => {
            const v = e.target.value;
            // Al cambiar de proveedor, la franja no puede seguir mostrando las cifras
            // del anterior mientras llega (o falla) la carga del nuevo.
            setResumenProveedor(null);
            setProveedorMeta(null);
            if (!v) {
              setProveedorSel(null);
              return;
            }
            const [tipo, id] = v.split(":") as [ProveedorTipo, string];
            const encontrado = proveedorOptions.find((o) => o.tipo === tipo && o.id === id);
            setProveedorSel(encontrado ?? { tipo, id, nombre: "", nit: null });
          }}
          aria-label="Filtrar por proveedor"
          className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
        >
          <option value="">Todos los proveedores</option>
          {proveedorOptions.some((o) => o.tipo === "EMPRESA") ? (
            <optgroup label="Empresas proveedoras">
              {proveedorOptions
                .filter((o) => o.tipo === "EMPRESA")
                .map((o) => (
                  <option key={`EMPRESA:${o.id}`} value={`EMPRESA:${o.id}`}>
                    {o.nombre}
                  </option>
                ))}
            </optgroup>
          ) : null}
          {proveedorOptions.some((o) => o.tipo === "FICHA") ? (
            <optgroup label="Otras fichas de pago">
              {proveedorOptions
                .filter((o) => o.tipo === "FICHA")
                .map((o) => (
                  <option key={`FICHA:${o.id}`} value={`FICHA:${o.id}`}>
                    {o.nombre}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>

        <select
          value={filtroCanal}
          onChange={(e) => setFiltroCanal(e.target.value as CanalPago | "")}
          aria-label="Filtrar por canal de pago"
          className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
        >
          <option value="">Todos los canales</option>
          {CANALES_PAGO.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setSoloPendientes((v) => !v)}
          aria-pressed={soloPendientes}
          title="Pagos a los que les falta la fecha real de pago. No es lo que se le debe a proveedores."
          className={`h-9 border px-3 text-xs font-semibold transition ${
            soloPendientes
              ? "border-amber-600 bg-amber-600 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Sin fecha de pago
        </button>

        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar concepto, beneficiario, DO…"
          aria-label="Buscar por concepto, beneficiario, soporte o DO"
          className="h-9 min-w-[220px] flex-1 border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
        />

        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {/* Franja del proveedor filtrado (§D.5) */}
      {proveedorSel ? (
        <div className="flex flex-col gap-3 border border-cyan-200 bg-cyan-50/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-800">
            {resumenProveedor && proveedorMeta && puedeVerTotalesProveedor ? (
              <>
                <span className="font-semibold text-slate-900">{proveedorMeta.nombre || proveedorSel.nombre}</span>
                {" — "}
                Total de sus facturas <strong>{formatCOP(resumenProveedor.facturado)}</strong>
                {" · "}
                Pagado <strong>{formatCOP(resumenProveedor.pagado)}</strong>
                {desgloseResumenCxp(resumenProveedor).map((d) => (
                  <span key={d.etiqueta}>
                    {" · "}
                    {d.etiqueta} <strong>{formatCOP(d.valor)}</strong>
                  </span>
                ))}
                {" · "}
                Pendiente por pagar <strong className="text-amber-700">{formatCOP(resumenProveedor.pendiente)}</strong>
                {" "}
                ({textoFacturasEnDOs(proveedorMeta.facturasConSaldo, proveedorMeta.dosConSaldo)})
              </>
            ) : proveedorMeta ? (
              // OPERATIVO (D-6): sin totales del proveedor, solo cuántas facturas tienen saldo.
              <>
                <span className="font-semibold text-slate-900">{proveedorMeta.nombre || proveedorSel.nombre}</span>
                {" — "}
                Con saldo: {textoFacturasEnDOs(proveedorMeta.facturasConSaldo, proveedorMeta.dosConSaldo)}
              </>
            ) : loadState === "error" ? (
              <span className="text-rose-700">No se pudo cargar el estado de cuenta del proveedor.</span>
            ) : (
              <span className="text-slate-500">Cargando el estado de cuenta del proveedor…</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {puedeEditar ? (
              <button
                type="button"
                onClick={() => void abrirBloqueParaProveedor()}
                disabled={resolviendoBloqueProveedor}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
              >
                {resolviendoBloqueProveedor ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Pagar en bloque
              </button>
            ) : null}
            {proveedorSel.tipo === "EMPRESA" && puedeVerFichaProveedor ? (
              <Link
                href={`${rutaCliente(proveedorSel.id)}#estado-cuenta`}
                className="inline-flex h-9 items-center gap-1 border border-slate-300 bg-white px-3 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-50"
              >
                Ver estado de cuenta
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Tabla: la carga inicial reserva el alto con un skeleton */}
      {isInitialLoading ? (
        <TableSkeleton rows={6} cols={10} rowHeight={44} />
      ) : (
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-900">Pagos</p>
          <p className="text-slate-500" aria-live="polite">
            {filasVisibles.length} registros
          </p>
        </div>
        {loadState === "error" ? (
          <div className="p-4">
            <ModuleState
              type="error"
              title="No fue posible cargar los pagos"
              detail={loadError ?? undefined}
              action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
            />
          </div>
        ) : loadState === "loading" ? (
          <div className="p-4">
            <ModuleState type="loading" title="Actualizando pagos…" />
          </div>
        ) : filasVisibles.length === 0 ? (
          <div className="p-4">
            <ModuleState
              type="empty"
              title="No hay pagos que coincidan con los filtros"
              detail="Ajusta cliente, proveedor, canal o búsqueda para ampliar la consulta."
            />
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">DO</th>
                <th className="border-b border-slate-200 px-3 py-2">Cliente</th>
                <th className="border-b border-slate-200 px-3 py-2">Concepto</th>
                <th className="border-b border-slate-200 px-3 py-2">Beneficiarios</th>
                <th className="border-b border-slate-200 px-3 py-2">N° soporte</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor (COP)</th>
                <th className="border-b border-slate-200 px-3 py-2">Canal</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha de pago</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-3 py-2 w-12">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filasVisibles.map((fila) => (
                <FilaPagoRow
                  key={fila.id}
                  fila={fila}
                  readOnly={!puedeEditar}
                  isDeleting={deletingId === fila.id}
                  onChange={handleFieldChange}
                  onBlur={handleBlurField}
                  onDelete={(f) => void handleDelete(f)}
                  onAdjuntarComprobante={(f, file) => void handleAdjuntarComprobante(f, file)}
                  onVerBloque={setBloqueParaDetalle}
                  onAnularBloque={
                    esAdmin
                      ? (f) =>
                          setBloqueParaAnular({
                            grupoPagoId: f.grupoPagoId as string,
                            resumen: `${f.consecutivo} · ${formatCOP(f.valor)}${
                              f.grupoOtrosDOs.length > 0 ? ` + ${f.grupoOtrosDOs.map((g) => g.consecutivo).join(", ")}` : ""
                            }`,
                          })
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
      )}

      {createOpen && puedeEditar ? (
        <NuevoPagoModal
          tramites={tramites}
          onClose={() => setCreateOpen(false)}
          onCreated={handlePagoCreado}
        />
      ) : null}

      {bloqueParaDetalle ? (
        <DetalleBloqueDialog grupoPagoId={bloqueParaDetalle} onClose={() => setBloqueParaDetalle(null)} />
      ) : null}

      {bloqueParaAnular ? (
        <AnularBloqueDialog
          grupoPagoId={bloqueParaAnular.grupoPagoId}
          resumen={bloqueParaAnular.resumen}
          onClose={() => setBloqueParaAnular(null)}
          onDone={() => {
            setBloqueParaAnular(null);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}

      {multiDOOpen && puedeEditar ? (
        <PagoEnBloqueModal
          beneficiarioInicial={beneficiarioParaBloque}
          onClose={() => {
            setMultiDOOpen(false);
            setBeneficiarioParaBloque(null);
          }}
          onCreated={handlePagoMultiDOCreado}
        />
      ) : null}
    </section>
  );
}
