"use client";

import {
  AlertTriangle,
  Banknote,
  CheckSquare,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  Lock,
  MessageSquare,
  Receipt,
  RotateCcw,
  User,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EnlaceCliente, EnlaceFacturaVenta } from "@/components/ui/enlace-entidad";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import type { Rol } from "@/lib/auth/auth";
import { useRol } from "@/lib/auth/rol-context";
import { visibilidadCabeceraDo } from "@/lib/tramites/cabecera-do";

import {
  RegistrarAnticipoTramiteModal,
  SeccionAnticiposTramite,
  type AplicacionAnticipoEntry,
} from "@/components/anticipos/seccion-anticipos-tramite";
import type { BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { SeccionDocumentos } from "@/components/documentos/seccion-documentos";
import { EditorLineas } from "@/components/facturacion/editor-lineas";
import {
  fetchBorradoresDeTramite,
  transicionarBorrador,
  type BorradorRow,
} from "@/components/facturacion/facturacion-api";
import {
  ModalFacturaProveedor,
  SeccionFacturasProveedor,
} from "@/components/facturas-proveedor/seccion-facturas-proveedor";
import { ModuleState } from "@/components/layout/module-state";
import { LibroPagos, NuevoPagoModal } from "@/components/pagos/libro-pagos";
import {
  patchChecklistItem,
  type ChecklistItem,
} from "@/components/tramites/checklist-api";
import { InlineTramiteField } from "@/components/tramites/inline-tramite-field";
import { HojaTramite } from "@/components/tramites/hoja-tramite";
import { SeccionEventosTramite } from "@/components/tramites/seccion-eventos-tramite";
import { cambiarEstadoTramite, mensajeAdvertenciasEstado } from "@/components/tramites/tramites-api";
import {
  type FacturaProveedorRow,
  solicitarFacturacion,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

// ─── Pipeline de estados ──────────────────────────────────────────────────────

const PIPELINE: readonly string[] = [
  "SOLICITUD",
  "APERTURA",
  "EN_TRAMITE",
  "EN_PUERTO",
  "DESPACHADO",
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
  "CERRADO",
];

// ─── Tipos ────────────────────────────────────────────────────────────────────

type TabId = "hoja" | "resumen" | "documentos" | "pagos" | "facturas-proveedor" | "facturacion" | "historial";

type EstadoLogEntry = {
  id: string;
  estadoAntes: string;
  estadoDes: string;
  createdAt: string;
};

type AuditLogEntry = {
  id: string;
  accion: string;
  createdAt: string;
  usuario: { name: string } | null;
};

type FacturaEntry = {
  id: string;
  numSiigo: string;
  fecha: string;
  totalFactura: string;
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
  saldoAFavorLM: string;
  saldoACargoLM: string;
  fechaPagoCliente: string | null;
};

type BorradorEntry = {
  id: string;
  estado: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  totalFactura: string;
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
  saldoAFavorLM: string;
  saldoACargoLM: string;
  createdAt: string;
  factura: FacturaEntry | null;
};

type TramiteDetalleData = {
  id: string;
  consecutivo: string;
  ciudad: string;
  estado: string;
  esHistorico?: boolean;
  eta: string | null;
  doAgencia: string | null;
  doCliente: string | null;
  proveedorCliente: string | null;
  comentarios: string | null;
  fechaAceptacionDeclaracion: string | null;
  fechaLevante: string | null;
  fechaEnviadoAFacturar: string | null;
  fechaDocumentosOk: string | null;
  fechaSalidaCarga: string | null;
  cliente: {
    id: string;
    nombre: string;
    nit: string;
    tipo?: string;
  };
  /** Tipo de trámite (M4). Ausente en respuestas viejas = importación. */
  referenciaExterna?: string | null;
  tipoTramite?: {
    codigo: string;
    nombre: string;
    etiquetaReferenciaExterna: string | null;
    facturacionSeparada: boolean;
    lineaServicio: string;
    /** Muestra "ETA" en la cabecera. */
    requiereEta: boolean;
    /** Muestra "DO Agencia" y "DO Cliente" en la cabecera. false en CLASIFICACION. */
    usaCamposDo: boolean;
    /** Campos de la base de cálculo que aplica este tipo (M2/M3). */
    camposBaseCalculo: string[];
    /** Muestra la lista de eventos en "Base de cálculo y eventos". */
    usaEventos: boolean;
  } | null;
  checklistItems: ChecklistItem[];
  estadoLogs?: EstadoLogEntry[];
  auditLogs?: AuditLogEntry[];
  aplicacionesAnticipo?: AplicacionAnticipoEntry[];
  borradores?: BorradorEntry[];
};

type LoadState = "loading" | "ready" | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCOP(bigStr: string | null | undefined): string {
  if (!bigStr) return "$0";
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(BigInt(bigStr)));
  } catch {
    return bigStr;
  }
}

/** Converts a Date ISO string to YYYY-MM-DD for <input type="date"> */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

/** Converts a YYYY-MM-DD input value to ISO string for the API */
function dateInputToIso(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

function statusClassName(status: string) {
  const n = status.toLowerCase();
  if (n.includes("cerr") || n.includes("factur") || n.includes("pagad")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (n.includes("despach") || n.includes("enviado")) {
    return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }
  if (n.includes("puerto") || n.includes("tramite")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function accionLabel(accion: string): string {
  const map: Record<string, string> = {
    CREATE: "Trámite creado",
    UPDATE: "Datos actualizados",
    UPDATE_ESTADO: "Cambio de estado",
    OMITIR_REQUISITOS: "Avanzó con requisitos pendientes (excepción de ADMIN)",
    APPROVE: "Borrador aprobado",
    FACTURAR: "Factura generada",
  };
  return map[accion] ?? accion;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

type DetalleCargado = {
  tramite: TramiteDetalleData;
  /** Umbral de alerta de saldo que acompaña al GET (lo consume la Hoja). */
  umbralAlertaSaldo: string;
};

async function fetchTramiteDetalle(tramiteId: string, signal?: AbortSignal): Promise<DetalleCargado> {
  const res = await fetch(`/api/tramites/${tramiteId}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const payload: unknown = await res.json();
      if (isRecord(payload) && typeof payload.error === "string") msg = payload.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const payload: unknown = await res.json();
  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new Error("Respuesta inesperada del servidor.");
  }

  const umbral = payload.umbralAlertaSaldo;
  return {
    tramite: payload.tramite as TramiteDetalleData,
    umbralAlertaSaldo:
      typeof umbral === "string" || typeof umbral === "number" ? String(umbral) : "500000",
  };
}

async function patchFechasClave(
  tramiteId: string,
  patch: Partial<Record<
    "fechaAceptacionDeclaracion" | "fechaLevante" | "fechaEnviadoAFacturar" | "fechaDocumentosOk" | "fechaSalidaCarga",
    string | null
  >>,
): Promise<TramiteDetalleData> {
  const res = await fetch(`/api/tramites/${tramiteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const payload: unknown = await res.json();
      if (isRecord(payload) && typeof payload.error === "string") msg = payload.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const payload: unknown = await res.json();
  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new Error("Respuesta inesperada al guardar.");
  }

  return payload.tramite as TramiteDetalleData;
}


// ─── Sub-componentes ──────────────────────────────────────────────────────────

type DateFieldKey =
  | "fechaAceptacionDeclaracion"
  | "fechaLevante"
  | "fechaEnviadoAFacturar"
  | "fechaDocumentosOk"
  | "fechaSalidaCarga";

type InlineDateFieldProps = {
  label: string;
  fieldKey: DateFieldKey;
  value: string | null;
  tramiteId: string;
  /** PUT /api/tramites/[id] exige ADMIN/REVISOR/OPERATIVO; en false es solo lectura. */
  editable: boolean;
  onSaved: (key: DateFieldKey, newIso: string | null, updated: TramiteDetalleData) => void;
};

function InlineDateField({ label, fieldKey, value, tramiteId, editable, onSaved }: InlineDateFieldProps) {
  if (!editable) return <div><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-1 text-sm">{formatDate(value)}</p></div>;
  return <InlineTramiteField label={label} type="date" value={isoToDateInput(value)} onSave={async (next) => {
    const iso = dateInputToIso(next);
    const updated = await patchFechasClave(tramiteId, { [fieldKey]: iso });
    onSaved(fieldKey, iso, updated);
  }} />;
}

type InlineTextFieldProps = {
  label: string;
  fieldKey: "doAgencia" | "doCliente" | "comentarios" | "referenciaExterna";
  value: string | null;
  tramiteId: string;
  onSaved: (updated: TramiteDetalleData) => void;
};

function InlineTextField({ label, fieldKey, value, tramiteId, onSaved }: InlineTextFieldProps) {
  return <InlineTramiteField label={label} type={fieldKey === "comentarios" ? "textarea" : "text"} value={value ?? ""} onSave={async (next) => {
    const res = await fetch(`/api/tramites/${tramiteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ [fieldKey]: next.trim() || null }),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : `No se pudo guardar (${res.status}).`);
    if (!isRecord(payload) || !isRecord(payload.tramite)) throw new Error("No se pudo confirmar el guardado. Reintenta.");
    onSaved(payload.tramite as TramiteDetalleData);
  }} />;
}

// ─── Botón cambio de estado ───────────────────────────────────────────────────

function CambioEstadoButton({
  tramite,
  onChanged,
}: {
  tramite: TramiteDetalleData;
  onChanged: (updated: TramiteDetalleData) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [faltantes, setFaltantes] = useState<string[]>([]);
  const { toast } = useToast();

  const otrosEstados = PIPELINE.filter((s) => s !== tramite.estado);

  async function handleCambiar() {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    setFaltantes([]);
    try {
      const { tramite: updated, advertencias } = await cambiarEstadoTramite<TramiteDetalleData>(
        tramite.id,
        selected,
      );
      toast({
        title: "Estado actualizado",
        description: `${tramite.consecutivo} → ${selected.replace(/_/g, " ")}`,
        variant: "success",
      });
      // F6: el ADMIN pudo haber saltado requisitos (checklist, BL, factura
      // comercial) con su excepción — se avisa aparte para que no pase inadvertido.
      const advertencia = mensajeAdvertenciasEstado(advertencias);
      if (advertencia) {
        toast({ ...advertencia, variant: "warning" });
      }
      setSelected("");
      onChanged(updated);
    } catch (caught) {
      const typed = caught as { faltantes?: string[] };
      setError(describirError(caught, "Error desconocido"));
      setFaltantes(Array.isArray(typed?.faltantes) ? typed.faltantes : []);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={selected}
          onChange={(e) => { setSelected(e.target.value); setError(null); setFaltantes([]); }}
          disabled={saving}
          aria-label={`Mover ${tramite.consecutivo} a otro estado`}
          className="h-11 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-cyan-500 disabled:opacity-60"
        >
          <option value="">Mover a...</option>
          {otrosEstados.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleCambiar()}
          disabled={saving || !selected}
          aria-label="Confirmar cambio de estado"
          className="inline-flex h-11 items-center gap-1 rounded-lg border border-cyan-300 bg-cyan-50 px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          {saving ? "Actualizando…" : "Cambiar estado"}
        </button>
      </div>
      {error ? (
        <p className="flex flex-wrap items-start gap-1 text-xs text-rose-600">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {error}
            {faltantes.length > 0 ? `: ${faltantes.join(", ")}` : ""}
          </span>
        </p>
      ) : null}
    </div>
  );
}

// ─── Sección Borradores / Facturas ────────────────────────────────────────────

function estadoBorradorClass(estado: string): string {
  const n = estado.toLowerCase();
  if (n === "facturado") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (n === "aprobado") return "border-violet-200 bg-violet-50 text-violet-700";
  if (n === "en_revision") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function SeccionBorradores({
  borradores,
  clienteId,
  tramiteId,
}: {
  borradores: BorradorEntry[];
  clienteId: string;
  tramiteId: string;
}) {
  if (borradores.length === 0) {
    return (
      <div className="border border-slate-200 bg-white p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
          Borradores / Facturas
        </p>
        <p className="text-sm text-slate-500">Sin borradores de factura para este DO.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-slate-900">
        Borradores / Facturas ({borradores.length})
      </p>
      {borradores.map((b) => (
        <div key={b.id} className="border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${estadoBorradorClass(b.estado)}`}
              >
                {b.estado}
              </span>
              {b.numFacturaSiigo ? (
                <EnlaceFacturaVenta
                  tramiteId={tramiteId}
                  borradorId={b.id}
                  className="font-mono font-semibold text-slate-900 text-sm"
                >
                  {b.numFacturaSiigo}
                </EnlaceFacturaVenta>
              ) : null}
              {b.fechaFactura ? (
                <span className="text-xs text-slate-500">{formatDate(b.fechaFactura)}</span>
              ) : null}
            </div>
            {b.factura ? (
              <Link
                href={`/cartera?clienteId=${clienteId}`}
                className="text-xs text-cyan-700 underline hover:text-cyan-900"
              >
                Ver en cartera
              </Link>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total factura</p>
              <p className="mt-0.5 font-mono font-semibold text-slate-900 text-sm">
                {formatCOP(b.factura?.totalFactura ?? b.totalFactura)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Saldo cliente</p>
              <p className="mt-0.5 font-mono text-sm">
                {(() => {
                  const fav = b.factura?.saldoAFavorCliente ?? b.saldoAFavorCliente;
                  const car = b.factura?.saldoACargoCliente ?? b.saldoACargoCliente;
                  try {
                    if (BigInt(fav) > 0n) return <span className="text-emerald-700 font-semibold">+{formatCOP(fav)}</span>;
                    if (BigInt(car) > 0n) return <span className="text-rose-600 font-semibold">-{formatCOP(car)}</span>;
                  } catch { /* noop */ }
                  return <span className="text-slate-500">$0</span>;
                })()}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Saldo LM</p>
              <p className="mt-0.5 font-mono text-sm">
                {(() => {
                  const fav = b.factura?.saldoAFavorLM ?? b.saldoAFavorLM;
                  const car = b.factura?.saldoACargoLM ?? b.saldoACargoLM;
                  try {
                    if (BigInt(fav) > 0n) return <span className="text-emerald-700 font-semibold">+{formatCOP(fav)}</span>;
                    if (BigInt(car) > 0n) return <span className="text-rose-600 font-semibold">-{formatCOP(car)}</span>;
                  } catch { /* noop */ }
                  return <span className="text-slate-500">$0</span>;
                })()}
              </p>
            </div>
            {b.factura?.fechaPagoCliente ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Fecha pago</p>
                <p className="mt-0.5 text-sm text-slate-700">{formatDate(b.factura.fechaPagoCliente)}</p>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Ítem de checklist (marcable) ─────────────────────────────────────────────

function checklistBoxClass(item: ChecklistItem): string {
  if (item.recibido) return "border-emerald-400 bg-emerald-100";
  if (item.requerido) return "border-rose-300 bg-rose-50";
  return "border-slate-300 bg-white";
}

function ChecklistItemRow({
  item,
  tramiteId,
  editable,
  onChanged,
}: {
  item: ChecklistItem;
  tramiteId: string;
  editable: boolean;
  onChanged: (updated: ChecklistItem) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function handleToggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    // Actualización optimista: refleja el cambio de inmediato en el estado del trámite.
    onChanged({ ...item, recibido: next });
    try {
      const updated = await patchChecklistItem(tramiteId, item.id, next);
      onChanged(updated);
      toast({
        title: next ? "Documento marcado como recibido" : "Documento desmarcado",
        description: item.descripcion,
        variant: "success",
      });
    } catch (caught) {
      // Revertir al valor previo si el PATCH falla.
      onChanged({ ...item, recibido: item.recibido });
      setError(describirError(caught, "No se pudo actualizar el ítem."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-sm">
        {editable ? (
          <input
            type="checkbox"
            checked={item.recibido}
            disabled={saving}
            onChange={(e) => void handleToggle(e.target.checked)}
            aria-label={`Marcar "${item.descripcion}" como recibido`}
            title={item.recibido ? "Desmarcar como recibido" : "Marcar como recibido"}
            className={`h-4 w-4 shrink-0 cursor-pointer appearance-none border ${checklistBoxClass(item)} outline-none focus:ring-2 focus:ring-cyan-200 disabled:cursor-not-allowed disabled:opacity-60`}
          />
        ) : (
          <span
            className={`inline-block h-4 w-4 shrink-0 border ${checklistBoxClass(item)}`}
            aria-hidden="true"
          />
        )}
        <span className={item.recibido ? "text-slate-600 line-through" : "text-slate-800"}>
          {item.descripcion}
        </span>
        {item.requerido && !item.recibido ? (
          <span className="text-xs text-rose-500">(requerido)</span>
        ) : null}
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin text-slate-400" aria-hidden="true" />
        ) : null}
      </div>
      {error ? (
        <p className="flex items-center gap-1 pl-6 text-xs text-rose-600">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ─── Pestaña Resumen ──────────────────────────────────────────────────────────

function TabResumen({
  tramite,
  onDateSaved,
  onFieldSaved,
  onChecklistItemChanged,
  puedeEditar,
  onRefresh,
}: {
  tramite: TramiteDetalleData;
  onDateSaved: (key: DateFieldKey, newIso: string | null, updated: TramiteDetalleData) => void;
  onFieldSaved: (updated: TramiteDetalleData) => void;
  onChecklistItemChanged: (updated: ChecklistItem) => void;
  puedeEditar: boolean;
  onRefresh: () => void;
}) {
  const checklistTotal = tramite.checklistItems.length;
  const checklistRecibidos = tramite.checklistItems.filter((i) => i.recibido).length;
  const checklistPendientes = tramite.checklistItems.filter((i) => i.requerido && !i.recibido);

  // El checklist solo es marcable por roles con permiso (puedeEditar = ADMIN/REVISOR/OPERATIVO)
  // y mientras el DO no haya avanzado más allá de APERTURA (bloquea APERTURA→EN_TRAMITE).
  const estadoIdx = PIPELINE.indexOf(tramite.estado);
  const checklistEditable =
    puedeEditar && estadoIdx !== -1 && estadoIdx <= PIPELINE.indexOf("APERTURA");
  const { etiquetaReferenciaExterna, muestraCamposDo, muestraEta } = visibilidadCabeceraDo(
    tramite.tipoTramite,
  );

  return (
    <div className="space-y-6">
      {/* Cabecera DO */}
      <div className="grid gap-4 border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Consecutivo Galcomex</p>
          <p className="mt-0.5 text-lg font-bold text-slate-950">{tramite.consecutivo}</p>
          {tramite.esHistorico ? (
            <span
              className="mt-1 mr-1 inline-flex h-5 items-center border border-amber-300 bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800"
              title="Cargado desde el archivo histórico (Drive 2026): tiene carpeta y documentos, sin detalle financiero"
            >
              Histórico
            </span>
          ) : null}
          {/* El tipo solo se anuncia cuando NO es el trámite de importación:
              para el flujo de siempre sería ruido. */}
          {tramite.tipoTramite && tramite.tipoTramite.codigo !== "IMPORTACION" ? (
            <span className="mt-1 inline-flex h-5 items-center border border-cyan-200 bg-cyan-50 px-1.5 text-[11px] font-semibold text-cyan-700">
              {tramite.tipoTramite.nombre}
              {tramite.tipoTramite.facturacionSeparada ? " · factura aparte" : ""}
            </span>
          ) : null}
        </div>
        {etiquetaReferenciaExterna ? (
          <div>
            {puedeEditar ? (
              <InlineTextField
                label={etiquetaReferenciaExterna}
                fieldKey="referenciaExterna"
                value={tramite.referenciaExterna ?? null}
                tramiteId={tramite.id}
                onSaved={onFieldSaved}
              />
            ) : (
              <>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {etiquetaReferenciaExterna}
                </p>
                <p className="mt-0.5 font-mono font-semibold text-slate-800">
                  {tramite.referenciaExterna ?? "—"}
                </p>
              </>
            )}
          </div>
        ) : null}
        {muestraCamposDo ? (
          <div>
            {puedeEditar ? (
              <InlineTextField
                label="DO Agencia"
                fieldKey="doAgencia"
                value={tramite.doAgencia}
                tramiteId={tramite.id}
                onSaved={onFieldSaved}
              />
            ) : tramite.doAgencia ? (
              <>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">DO Agencia</p>
                <p className="mt-0.5 font-semibold text-slate-800">{tramite.doAgencia}</p>
              </>
            ) : null}
          </div>
        ) : null}
        {muestraCamposDo ? (
          puedeEditar ? (
            <InlineTextField label="DO Cliente" fieldKey="doCliente" value={tramite.doCliente} tramiteId={tramite.id} onSaved={onFieldSaved} />
          ) : tramite.doCliente ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">DO Cliente</p>
              <p className="mt-0.5 font-semibold text-slate-800">{tramite.doCliente}</p>
            </div>
          ) : null
        ) : null}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${statusClassName(tramite.estado)}`}
            >
              {tramite.estado.replace(/_/g, " ")}
            </span>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Cliente</p>
          <EnlaceCliente id={tramite.cliente.id} className="mt-0.5 block font-semibold">
            {tramite.cliente.nombre}
          </EnlaceCliente>
          <p className="text-xs text-slate-500">{tramite.cliente.nit}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ciudad</p>
          <p className="mt-0.5 text-sm text-slate-700">{tramite.ciudad}</p>
        </div>
        {muestraEta ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">ETA</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">{formatDate(tramite.eta)}</p>
          </div>
        ) : null}
      </div>

      {/* Fechas clave con edición inline */}
      <div className="border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">Fechas clave</h3>
          {puedeEditar ? (
            <span className="text-xs text-slate-500">Escribe y guarda solo lo que cambies</span>
          ) : null}
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <InlineDateField
            label="Documentos OK"
            fieldKey="fechaDocumentosOk"
            value={tramite.fechaDocumentosOk}
            tramiteId={tramite.id}
            editable={puedeEditar}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Aceptación declaración"
            fieldKey="fechaAceptacionDeclaracion"
            value={tramite.fechaAceptacionDeclaracion}
            tramiteId={tramite.id}
            editable={puedeEditar}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Levante"
            fieldKey="fechaLevante"
            value={tramite.fechaLevante}
            tramiteId={tramite.id}
            editable={puedeEditar}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Salida de carga"
            fieldKey="fechaSalidaCarga"
            value={tramite.fechaSalidaCarga}
            tramiteId={tramite.id}
            editable={puedeEditar}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Enviado a facturar"
            fieldKey="fechaEnviadoAFacturar"
            value={tramite.fechaEnviadoAFacturar}
            tramiteId={tramite.id}
            editable={puedeEditar}
            onSaved={onDateSaved}
          />
        </div>
      </div>

      {/* Anticipos del cliente (registrar/aplicar desde el DO) */}
      <SeccionAnticiposTramite
        tramiteId={tramite.id}
        cliente={tramite.cliente}
        aplicaciones={tramite.aplicacionesAnticipo ?? []}
        puedeEditar={puedeEditar}
        onRefresh={onRefresh}
      />

      {/* Borradores / Facturas */}
      <SeccionBorradores
        borradores={tramite.borradores ?? []}
        clienteId={tramite.cliente.id}
        tramiteId={tramite.id}
      />

      {/* Checklist */}
      {tramite.checklistItems.length > 0 ? (
        <div className="border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-900">Checklist documental</h3>
              {checklistEditable ? (
                <span className="text-xs text-slate-400">(marca los recibidos)</span>
              ) : null}
            </div>
            <span className="text-xs text-slate-500">
              {checklistRecibidos} / {checklistTotal} recibidos
            </span>
          </div>
          {checklistPendientes.length > 0 ? (
            <div className="mb-3 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <strong>Pendientes requeridos:</strong>{" "}
              {checklistPendientes.map((i) => i.descripcion).join(", ")}
            </div>
          ) : null}
          <ul className="space-y-1">
            {tramite.checklistItems.map((item) => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                tramiteId={tramite.id}
                editable={checklistEditable}
                onChanged={onChecklistItemChanged}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {/* Base de cálculo del tarifario y eventos (M2 + M3). Qué campos y si
          hay eventos lo decide el tipo de trámite (M4): CLASIFICACION solo
          usa Ítems clasificados y no usa eventos. */}
      <SeccionEventosTramite
        tramiteId={tramite.id}
        clienteId={tramite.cliente.id}
        puedeEditar={puedeEditar}
        onRefresh={onRefresh}
        camposBaseCalculo={tramite.tipoTramite?.camposBaseCalculo ?? null}
        usaEventos={tramite.tipoTramite?.usaEventos ?? true}
      />

      {/* Comentarios */}
      {puedeEditar ? <div className="rounded-xl border border-slate-200 bg-white p-5"><InlineTextField label="Comentarios" fieldKey="comentarios" value={tramite.comentarios} tramiteId={tramite.id} onSaved={onFieldSaved} /></div> : tramite.comentarios ? (
        <div className="border border-slate-200 bg-white p-5">
          <div className="mb-2 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-900">Comentarios</h3>
          </div>
          <p className="text-sm text-slate-700 whitespace-pre-line">{tramite.comentarios}</p>
        </div>
      ) : null}
    </div>
  );
}

// ─── Pestaña Historial ────────────────────────────────────────────────────────

type TimelineItem =
  | { kind: "audit"; id: string; label: string; usuario: string | null; date: string }
  | { kind: "estado"; id: string; antes: string; des: string; date: string };

function TabHistorial({ tramite }: { tramite: TramiteDetalleData }) {
  const auditLogs = tramite.auditLogs ?? [];
  const estadoLogs = tramite.estadoLogs ?? [];

  if (auditLogs.length === 0 && estadoLogs.length === 0) {
    return (
      <ModuleState
        type="empty"
        title="Sin movimientos"
        detail="Aún no hay movimientos registrados en este DO."
      />
    );
  }

  // Merge and sort descending by date
  const items: TimelineItem[] = [
    ...auditLogs.map((a): TimelineItem => ({
      kind: "audit",
      id: a.id,
      label: accionLabel(a.accion),
      usuario: a.usuario?.name ?? null,
      date: a.createdAt,
    })),
    ...estadoLogs.map((e): TimelineItem => ({
      kind: "estado",
      id: e.id,
      antes: e.estadoAntes,
      des: e.estadoDes,
      date: e.createdAt,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="border border-slate-200 bg-white p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-900">
        Historial del trámite ({items.length} eventos)
      </h3>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3 text-sm">
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              {item.kind === "audit" ? (
                <span className="font-medium text-slate-900">{item.label}</span>
              ) : (
                <>
                  <span className="font-medium text-slate-900">{item.antes}</span>
                  <span className="mx-1 text-slate-400">→</span>
                  <span className="font-medium text-slate-900">{item.des}</span>
                </>
              )}
              {item.kind === "audit" && item.usuario ? (
                <span className="ml-2 inline-flex items-center gap-1 text-slate-500">
                  <User className="h-3 w-3" aria-hidden="true" />
                  {item.usuario}
                </span>
              ) : null}
              <span className="ml-2 text-xs text-slate-400">{formatDateTime(item.date)}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Editor de líneas manuales (PROPIO + SOCIO_LM) ────────────────────────────

const ESTADOS_BORRADOR_EDITABLE = ["BORRADOR", "EN_REVISION"];
/** Roles que pueden transicionar un borrador a EN_REVISION (PATCH /api/borradores/[id]). */
const ROLES_PUEDE_ENVIAR_REVISION: readonly Rol[] = ["ADMIN", "OPERATIVO"];

function SeccionEditorFacturaVenta({
  tramiteId,
  userRol,
  refreshToken = 0,
}: {
  tramiteId: string;
  userRol: Rol;
  refreshToken?: number;
}) {
  const [borradores, setBorradores] = useState<BorradorRow[]>([]);
  const [estado, setEstado] = useState<"loading" | "ready" | "error">("loading");
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [enviandoRevision, setEnviandoRevision] = useState(false);
  const [errorRevision, setErrorRevision] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    fetchBorradoresDeTramite(tramiteId, controller.signal)
      .then((bs) => {
        setBorradores(bs);
        setErrorCarga(null);
        setEstado("ready");
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setErrorCarga(describirError(e, "No se pudieron cargar los borradores."));
        setEstado("error");
      });
    return () => controller.abort();
  }, [tramiteId, reloadKey, refreshToken]);

  if (estado === "loading") {
    return (
      <div className="mt-4">
        <TableSkeleton rows={3} cols={4} rowHeight={40} />
      </div>
    );
  }
  if (estado === "error") {
    return (
      <div className="mt-4">
        <ModuleState
          type="error"
          title="No se pudieron cargar las líneas de la factura"
          detail={errorCarga ?? undefined}
          action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
        />
      </div>
    );
  }
  if (borradores.length === 0) {
    return (
      <p className="mt-4 text-sm text-slate-500">
        Genera un borrador en Facturación para escribir las líneas a mano.
      </p>
    );
  }

  // El borrador editable más reciente (BORRADOR/EN_REVISION).
  const editable = borradores.find((b) => ESTADOS_BORRADOR_EDITABLE.includes(b.estado));
  const borrador = editable ?? borradores[0];
  const puedeEditar =
    ESTADOS_BORRADOR_EDITABLE.includes(borrador.estado) &&
    (userRol === "ADMIN" || userRol === "SOCIO");

  // El botón "Enviar a revisión" aparece cuando el borrador está en BORRADOR
  // y el rol puede hacer la transición. No se muestra para SOCIO (solo lectura).
  const puedeEnviarRevision =
    borrador.estado === "BORRADOR" &&
    ROLES_PUEDE_ENVIAR_REVISION.includes(userRol);

  async function handleEnviarRevision() {
    if (!puedeEnviarRevision || enviandoRevision) return;
    setEnviandoRevision(true);
    setErrorRevision(null);
    try {
      const actualizado = await transicionarBorrador(borrador.id, {
        nuevoEstado: "EN_REVISION",
      });
      setBorradores((prev) =>
        prev.map((b) => (b.id === actualizado.id ? actualizado : b)),
      );
      toast({ title: "Borrador enviado a revisión", variant: "success" });
    } catch (err) {
      setErrorRevision(describirError(err, "Error al enviar a revisión."));
    } finally {
      setEnviandoRevision(false);
    }
  }

  return (
    <div className="mt-5 border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="mb-1 text-sm font-semibold text-slate-900">
            Líneas de la factura de venta
          </h3>
          <p className="text-xs text-slate-500">
            Escribe los ítems a mano y vincúlalos a las facturas de proveedor. La suma define el total.
          </p>
        </div>
        {puedeEnviarRevision && (
          <button
            type="button"
            onClick={() => { void handleEnviarRevision(); }}
            disabled={enviandoRevision}
            className="inline-flex h-9 items-center gap-2 border border-amber-300 bg-amber-50 px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enviandoRevision ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            )}
            Enviar a revisión
          </button>
        )}
      </div>
      {errorRevision && (
        <p className="mb-3 text-sm text-red-600">{errorRevision}</p>
      )}
      <EditorLineas
        borrador={borrador}
        tramiteId={tramiteId}
        puedeEditar={puedeEditar}
        onBorradorActualizado={(actualizado) =>
          setBorradores((prev) =>
            prev.map((b) => (b.id === actualizado.id ? actualizado : b)),
          )
        }
      />
    </div>
  );
}

// ─── Pestaña Facturación ──────────────────────────────────────────────────────

function TabFacturacion({
  tramite,
  userRol,
  refreshToken,
}: {
  tramite: TramiteDetalleData;
  userRol: Rol;
  refreshToken: number;
}) {
  const esFacturable =
    tramite.estado === "ENVIADO_A_FACTURAR" ||
    tramite.estado === "FACTURADO" ||
    tramite.estado === "PAGADO" ||
    tramite.estado === "CERRADO";

  return (
    <div className="border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center gap-2">
        <FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-slate-900">Facturación</h3>
      </div>
      {!esFacturable ? (
        <div className="mb-4 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          El DO debe estar en estado <strong>ENVIADO_A_FACTURAR</strong> o posterior para crear una
          factura. Estado actual: <strong>{tramite.estado}</strong>.
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Link
          href={`/facturacion?tramiteId=${tramite.id}`}
          className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <FileText className="h-4 w-4" aria-hidden="true" />
          Ir a Facturación
        </Link>
        <Link
          href="/facturacion"
          className="text-sm text-slate-500 underline hover:text-slate-700"
        >
          Ver todas las facturas
        </Link>
      </div>
      {tramite.fechaEnviadoAFacturar ? (
        <p className="mt-4 text-xs text-slate-500">
          Enviado a facturar: {formatDate(tramite.fechaEnviadoAFacturar)}
        </p>
      ) : null}
      {esFacturable ? (
        <SeccionEditorFacturaVenta
          tramiteId={tramite.id}
          userRol={userRol}
          refreshToken={refreshToken}
        />
      ) : null}
    </div>
  );
}

// ─── Componente principal TramiteDetalle ──────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: "hoja", label: "Hoja de trabajo" },
  { id: "resumen", label: "Datos del trámite" },
  { id: "documentos", label: "Documentos" },
  { id: "pagos", label: "Pagos a proveedores" },
  { id: "facturas-proveedor", label: "Facturas proveedor" },
  { id: "facturacion", label: "Facturas de venta" },
  { id: "historial", label: "Historial" },
];

/** Skeleton de cabecera + tabla mientras llega GET /api/tramites/[id]. */
function DetalleSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" role="status" aria-label="Cargando detalle del trámite">
      <CardsSkeleton count={4} height={76} />
      <div className="flex gap-6 border-b border-slate-200 pb-3">
        {TABS.map((tab) => (
          <div key={tab.id} className="h-3 w-20 animate-pulse bg-slate-200/80" aria-hidden="true" />
        ))}
      </div>
      <TableSkeleton rows={6} cols={6} rowHeight={44} />
    </div>
  );
}

export function TramiteDetalle({ tramiteId }: { tramiteId: string }) {
  const userRol = useRol();
  const { toast } = useToast();
  const [tramite, setTramite] = useState<TramiteDetalleData | null>(null);
  const [umbralAlertaSaldo, setUmbralAlertaSaldo] = useState("500000");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // `?tab=` (enlaces desde otros módulos, ver components/ui/enlace-entidad.tsx)
  // abre el trámite directamente en esa pestaña.
  const tabDeUrl = useSearchParams().get("tab");
  const tabPedida = TABS.find((t) => t.id === tabDeUrl)?.id ?? null;
  const [activeTab, setActiveTab] = useState<TabId>(tabPedida ?? "hoja");
  // Pestañas ya visitadas: se mantienen montadas (ocultas con `hidden`) para
  // no volver a cargar todo al regresar a ellas.
  const [visitedTabs, setVisitedTabs] = useState<TabId[]>(tabPedida ? [tabPedida] : ["hoja"]);
  // Solo la primera carga de un histórico salta a Documentos (ref: no re-renderiza ni entra al efecto).
  // Si la URL ya pidió una pestaña, se respeta.
  const tabInicialAplicada = useRef(tabPedida !== null);
  const [solicitandoFacturacion, setSolicitandoFacturacion] = useState(false);
  const [errorSolicitud, setErrorSolicitud] = useState<string | null>(null);
  const [topAction, setTopAction] = useState<
    null | "anticipo" | "pago" | "factura"
  >(null);
  const [pagoPrefill, setPagoPrefill] = useState<{
    concepto?: string;
    facturaIds?: string[];
    beneficiarios?: BeneficiarioSeleccion[];
    valor?: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      // En recargas (reloadKey > 0) se conserva el trámite visible para no
      // desmontar las pestañas; solo la primera carga muestra el skeleton.
      setLoadError(null);
      setLoadState("loading");

      try {
        const data = await fetchTramiteDetalle(tramiteId, controller.signal);
        setTramite(data.tramite);
        setUmbralAlertaSaldo(data.umbralAlertaSaldo);
        // Un trámite histórico existe por sus documentos: se abre en esa
        // pestaña (solo la primera vez; las recargas no mueven al usuario).
        if (data.tramite.esHistorico && !tabInicialAplicada.current) {
          tabInicialAplicada.current = true;
          setActiveTab("documentos");
          setVisitedTabs((prev) => (prev.includes("documentos") ? prev : [...prev, "documentos"]));
        }
        setLoadState("ready");
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(caught instanceof Error ? caught.message : "Error al cargar el trámite.");
        setLoadState("error");
      }
    }

    void load();

    return () => controller.abort();
  }, [tramiteId, reloadKey]);

  const selectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
  }, []);

  const handleDateSaved = useCallback(
    (_key: DateFieldKey, _newIso: string | null, updated: TramiteDetalleData) => {
      setTramite(updated);
    },
    [],
  );

  const handleEstadoChanged = useCallback((updated: TramiteDetalleData) => {
    setTramite(updated);
  }, []);

  const handleFieldSaved = useCallback((updated: TramiteDetalleData) => {
    setTramite(updated);
  }, []);

  const handleChecklistItemChanged = useCallback((updatedItem: ChecklistItem) => {
    setTramite((prev) =>
      prev
        ? {
            ...prev,
            checklistItems: prev.checklistItems.map((it) =>
              it.id === updatedItem.id ? updatedItem : it,
            ),
          }
        : prev,
    );
  }, []);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  async function handleSolicitarFacturacion() {
    if (!tramite || solicitandoFacturacion) return;
    setSolicitandoFacturacion(true);
    setErrorSolicitud(null);
    try {
      await solicitarFacturacion(tramite.id);
      toast({
        title: "Facturación solicitada",
        description: `${tramite.consecutivo} pasó a ENVIADO A FACTURAR.`,
        variant: "success",
      });
      // Recargar para reflejar el nuevo estado
      reload();
    } catch (caught) {
      setErrorSolicitud(describirError(caught, "No se pudo solicitar la facturación."));
    } finally {
      setSolicitandoFacturacion(false);
    }
  }

  const handlePagarFacturaProveedor = useCallback((factura: FacturaProveedorRow) => {
    const beneficiarios: BeneficiarioSeleccion[] =
      factura.beneficiarioId
        ? [{
            id: factura.beneficiarioId,
            nombre: factura.proveedorNombre,
            nit: factura.proveedorNit,
          }]
        : [];

    setPagoPrefill({
      concepto: factura.concepto?.trim() || `Pago factura ${factura.numFactura}`,
      facturaIds: [factura.id],
      beneficiarios,
      valor: factura.valor,
    });
    selectTab("pagos");
    setTopAction("pago");
  }, [selectTab]);

  if (loadState === "loading" && !tramite) {
    return <DetalleSkeleton />;
  }

  if (!tramite) {
    return (
      <ModuleState
        type="error"
        title="No se pudo cargar el trámite"
        detail={loadError ?? "Error desconocido."}
        action={{ label: "Reintentar", onClick: reload }}
      />
    );
  }

  // ─── Permisos por acción (alineados con los roles que exige cada endpoint) ──
  // POST /api/anticipos → ADMIN/OPERATIVO (Karina puede registrar anticipos —
  // decisión del dueño 2026-09-22)
  const puedeAnticipo = userRol === "ADMIN" || userRol === "OPERATIVO";
  // POST /api/tramites/[id]/pagos → ADMIN/OPERATIVO
  const puedePago = userRol === "ADMIN" || userRol === "OPERATIVO";
  // POST /api/tramites/[id]/estado y PUT /api/tramites/[id] → ADMIN/REVISOR/OPERATIVO
  const puedeEstado =
    userRol === "ADMIN" || userRol === "REVISOR" || userRol === "OPERATIVO";
  const puedeEditarTramite = puedeEstado && tramite.estado !== "CERRADO";
  // POST /api/tramites/[id]/solicitar-facturacion → ADMIN/OPERATIVO/SOCIO
  const puedeFacturar =
    userRol === "ADMIN" || userRol === "OPERATIVO" || userRol === "SOCIO";
  // POST /api/tramites/[id]/facturas-proveedor → ADMIN/OPERATIVO/SOCIO
  const puedeFacturaProveedor = puedeFacturar;
  const yaEnviadoAFacturar =
    tramite.estado === "ENVIADO_A_FACTURAR" ||
    tramite.estado === "FACTURADO" ||
    tramite.estado === "PAGADO" ||
    tramite.estado === "CERRADO";
  // Bloqueo total al cerrar el trámite (reunión 1-jul): nadie puede modificar
  // nada una vez CERRADO. El backend rechaza cada mutación con 409
  // (TramiteCerradoError) — aquí solo deshabilitamos los botones de acción
  // principales que este archivo controla directamente, como refuerzo visual.
  // Excepción: la reapertura de emergencia (solo ADMIN) sigue disponible vía
  // el selector de cambio de estado, que el backend ya restringe por rol.
  const esCerrado = tramite.estado === "CERRADO";
  const isRefreshing = loadState === "loading";

  return (
    <div className="space-y-0">
      {loadError ? <div className="mb-4"><ModuleState type="error" title="No se pudo actualizar el trámite" detail="Conservamos la información anterior y tus cambios sin guardar. Reintenta para ver los datos más recientes." action={{ label: "Reintentar", onClick: reload }} /></div> : null}
      {esCerrado ? (
        <Alert variant="warning" className="mb-4">
          <Lock aria-hidden="true" />
          <AlertTitle>Trámite cerrado — solo lectura</AlertTitle>
          <AlertDescription>
            Este trámite está CERRADO y no admite modificaciones (pagos, anticipos, documentos,
            facturas o borradores). Solo un ADMIN puede reabrirlo desde el selector de estado.
          </AlertDescription>
        </Alert>
      ) : null}

      {tramite.esHistorico ? (
        <div
          className="mb-4 flex flex-wrap items-start gap-3 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="note"
        >
          <span className="inline-flex h-5 shrink-0 items-center border border-amber-300 bg-white px-1.5 text-[11px] font-semibold text-amber-800">
            Histórico
          </span>
          <p className="min-w-0">
            Trámite cargado desde el archivo histórico (Drive 2026): tiene su carpeta y sus documentos, pero no
            anticipos, pagos ni factura en la plataforma. Los archivos que quedaron en <span className="font-semibold">Otro</span> se
            pueden reordenar desde la pestaña Documentos o desde Archivos.
          </p>
        </div>
      ) : null}

      {/* Barra de acciones rápidas — visible en cualquier pestaña */}
      <div className="mb-4 border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Estado actual + avanzar */}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Estado
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${statusClassName(tramite.estado)}`}
              >
                {tramite.estado.replace(/_/g, " ")}
              </span>
              {puedeEstado && (!esCerrado || userRol === "ADMIN") ? (
                <CambioEstadoButton tramite={tramite} onChanged={handleEstadoChanged} />
              ) : null}
              {isRefreshing ? (
                <span className="inline-flex items-center gap-1 text-xs text-slate-500" role="status">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Actualizando…
                </span>
              ) : null}
            </div>
          </div>

          {/* Acciones */}
          <div className="flex flex-wrap items-center gap-2">
            {puedeAnticipo && activeTab !== "resumen" ? (
              <button
                type="button"
                onClick={() => setTopAction("anticipo")}
                disabled={esCerrado}
                title={esCerrado ? "El trámite está cerrado y no admite modificaciones" : undefined}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wallet className="h-4 w-4" aria-hidden="true" />
                Registrar anticipo
              </button>
            ) : null}
            {puedePago && activeTab !== "pagos" ? (
              <button
                type="button"
                onClick={() => {
                  setPagoPrefill(null);
                  setTopAction("pago");
                }}
                disabled={esCerrado}
                title={esCerrado ? "El trámite está cerrado y no admite modificaciones" : undefined}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Banknote className="h-4 w-4" aria-hidden="true" />
                Pago a proveedor
              </button>
            ) : null}
            {puedeFacturaProveedor && activeTab !== "facturas-proveedor" ? (
              <button
                type="button"
                onClick={() => setTopAction("factura")}
                disabled={esCerrado}
                title={esCerrado ? "El trámite está cerrado y no admite modificaciones" : undefined}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Receipt className="h-4 w-4" aria-hidden="true" />
                Factura proveedor
              </button>
            ) : null}
            {puedeFacturar && !yaEnviadoAFacturar ? (
              <button
                type="button"
                onClick={() => void handleSolicitarFacturacion()}
                disabled={solicitandoFacturacion || yaEnviadoAFacturar || esCerrado}
                title={
                  esCerrado
                    ? "El trámite está cerrado y no admite modificaciones"
                    : yaEnviadoAFacturar
                      ? "El trámite ya fue enviado a facturar"
                      : undefined
                }
                className="inline-flex h-9 items-center gap-2 bg-cyan-700 px-3 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-60"
              >
                {solicitandoFacturacion ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FileText className="h-4 w-4" aria-hidden="true" />
                )}
                Solicitar facturación
              </button>
            ) : null}
          </div>
        </div>
        {errorSolicitud ? (
          <p className="mt-2 flex items-center gap-1 text-xs text-rose-600" role="alert">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {errorSolicitud}
          </p>
        ) : null}
      </div>

      {/* Nav de pestañas */}
      <div className="flex overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Secciones del trámite">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.id === tab.id);
              const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              selectTab(TABS[next].id);
              document.getElementById(`tab-${TABS[next].id}`)?.focus();
            }}
            className={`inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-slate-950 text-slate-950"
                : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Contenido de pestañas: las ya visitadas quedan montadas y ocultas. */}
      <div className="mt-5">
        {visitedTabs.includes("hoja") ? (
          <div id="panel-hoja" role="tabpanel" aria-labelledby="tab-hoja" hidden={activeTab !== "hoja"}>
            <HojaTramite
              tramiteId={tramiteId}
              tramite={tramite}
              umbralAlertaSaldo={umbralAlertaSaldo}
              onRefresh={reload}
              refreshToken={reloadKey}
            />
          </div>
        ) : null}
        {visitedTabs.includes("resumen") ? (
          <div id="panel-resumen" role="tabpanel" aria-labelledby="tab-resumen" hidden={activeTab !== "resumen"}>
            <TabResumen
              tramite={tramite}
              onDateSaved={handleDateSaved}
              onFieldSaved={handleFieldSaved}
              onChecklistItemChanged={handleChecklistItemChanged}
              puedeEditar={puedeEditarTramite}
              onRefresh={reload}
            />
          </div>
        ) : null}
        {visitedTabs.includes("documentos") ? (
          <div id="panel-documentos" role="tabpanel" aria-labelledby="tab-documentos" hidden={activeTab !== "documentos"}>
            <SeccionDocumentos tramiteId={tramiteId} refreshToken={reloadKey} />
          </div>
        ) : null}
        {visitedTabs.includes("pagos") ? (
          <div id="panel-pagos" role="tabpanel" aria-labelledby="tab-pagos" hidden={activeTab !== "pagos"}>
            <LibroPagos tramiteId={tramiteId} refreshToken={reloadKey} />
          </div>
        ) : null}
        {visitedTabs.includes("facturas-proveedor") ? (
          <div
            id="panel-facturas-proveedor"
            role="tabpanel"
            aria-labelledby="tab-facturas-proveedor"
            hidden={activeTab !== "facturas-proveedor"}
          >
            <SeccionFacturasProveedor
              tramiteId={tramiteId}
              onPagarFactura={handlePagarFacturaProveedor}
              refreshToken={reloadKey}
            />
          </div>
        ) : null}
        {visitedTabs.includes("facturacion") ? (
          <div id="panel-facturacion" role="tabpanel" aria-labelledby="tab-facturacion" hidden={activeTab !== "facturacion"}>
            <TabFacturacion tramite={tramite} userRol={userRol} refreshToken={reloadKey} />
          </div>
        ) : null}
        {visitedTabs.includes("historial") ? (
          <div id="panel-historial" role="tabpanel" aria-labelledby="tab-historial" hidden={activeTab !== "historial"}>
            <TabHistorial tramite={tramite} />
          </div>
        ) : null}
      </div>

      {/* Modales de la barra de acciones */}
      {topAction === "anticipo" ? (
        <RegistrarAnticipoTramiteModal
          tramiteId={tramite.id}
          cliente={tramite.cliente}
          onClose={() => setTopAction(null)}
          onDone={() => {
            setTopAction(null);
            reload();
          }}
        />
      ) : null}
      {topAction === "pago" ? (
        <NuevoPagoModal
          tramiteId={tramite.id}
          tramiteConsecutivo={tramite.consecutivo}
          initialConcepto={pagoPrefill?.concepto}
          initialFacturaIds={pagoPrefill?.facturaIds}
          initialBeneficiarios={pagoPrefill?.beneficiarios}
          initialValor={pagoPrefill?.valor}
          onClose={() => {
            setPagoPrefill(null);
            setTopAction(null);
          }}
          onCreated={() => {
            setPagoPrefill(null);
            setTopAction(null);
            reload();
          }}
        />
      ) : null}
      {topAction === "factura" ? (
        <ModalFacturaProveedor
          tramiteId={tramite.id}
          onClose={() => setTopAction(null)}
          onGuardada={() => {
            setTopAction(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
