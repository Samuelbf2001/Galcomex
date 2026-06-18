"use client";

import {
  AlertTriangle,
  Banknote,
  Calendar,
  CheckSquare,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
  Receipt,
  RotateCcw,
  User,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  RegistrarAnticipoTramiteModal,
  SeccionAnticiposTramite,
  type AplicacionAnticipoEntry,
} from "@/components/anticipos/seccion-anticipos-tramite";
import { SeccionDocumentos } from "@/components/documentos/seccion-documentos";
import {
  ModalFacturaProveedor,
  SeccionFacturasProveedor,
} from "@/components/facturas-proveedor/seccion-facturas-proveedor";
import { ModuleState } from "@/components/layout/module-state";
import { LibroPagos, NuevoPagoModal } from "@/components/pagos/libro-pagos";
import { HojaTramite } from "@/components/tramites/hoja-tramite";
import {
  FacturasProveedorApiError,
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

function nextEstado(current: string): string | null {
  const idx = PIPELINE.indexOf(current);
  if (idx === -1 || idx >= PIPELINE.length - 1) return null;
  return PIPELINE[idx + 1] ?? null;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

type TabId = "hoja" | "resumen" | "documentos" | "pagos" | "facturas-proveedor" | "facturacion" | "historial";

type ChecklistItem = {
  id: string;
  descripcion: string;
  requerido: boolean;
  recibido: boolean;
};

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
    APPROVE: "Borrador aprobado",
    FACTURAR: "Factura generada",
  };
  return map[accion] ?? accion;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchTramiteDetalle(tramiteId: string, signal?: AbortSignal): Promise<TramiteDetalleData> {
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

  return payload.tramite as TramiteDetalleData;
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

async function patchEstado(
  tramiteId: string,
  estado: string,
): Promise<TramiteDetalleData> {
  const res = await fetch(`/api/tramites/${tramiteId}/estado`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ estado }),
  });

  let faltantes: string[] | undefined;
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const payload: unknown = await res.json();
      if (isRecord(payload)) {
        if (typeof payload.error === "string") msg = payload.error;
        if (Array.isArray(payload.faltantes)) faltantes = payload.faltantes as string[];
      }
    } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { faltantes });
  }

  const payload: unknown = await res.json();
  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new Error("Respuesta inesperada al cambiar estado.");
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
  onSaved: (key: DateFieldKey, newIso: string | null, updated: TramiteDetalleData) => void;
};

function InlineDateField({ label, fieldKey, value, tramiteId, onSaved }: InlineDateFieldProps) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openEdit() {
    setInputValue(isoToDateInput(value));
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const newIso = dateInputToIso(inputValue);
    try {
      const updated = await patchFechasClave(tramiteId, { [fieldKey]: newIso });
      onSaved(fieldKey, newIso, updated);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar.");
      setInputValue(isoToDateInput(value));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditing(false);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {editing ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="h-8 border border-cyan-500 px-2 text-sm text-slate-950 outline-none focus:ring-2 focus:ring-cyan-100"
              disabled={saving}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
                if (e.key === "Escape") handleCancel();
              }}
            />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
              Guardar
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="inline-flex h-8 items-center border border-slate-300 bg-white px-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
          </div>
          {error ? (
            <p className="flex items-center gap-1 text-xs text-rose-600">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={openEdit}
          className="group inline-flex items-center gap-1.5 text-sm text-slate-800 hover:text-cyan-700"
          title={`Editar ${label}`}
        >
          <span className="group-hover:underline">{formatDate(value)}</span>
          <Calendar className="h-3.5 w-3.5 text-slate-400 group-hover:text-cyan-600" aria-hidden="true" />
        </button>
      )}
    </div>
  );
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

  const otrosEstados = PIPELINE.filter((s) => s !== tramite.estado);

  async function handleCambiar() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setFaltantes([]);
    try {
      const updated = await patchEstado(tramite.id, selected);
      setSelected("");
      onChanged(updated);
    } catch (caught) {
      const err = caught instanceof Error ? caught : new Error("Error desconocido");
      const typed = err as Error & { faltantes?: string[] };
      setError(err.message);
      setFaltantes(typed.faltantes ?? []);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <select
          value={selected}
          onChange={(e) => { setSelected(e.target.value); setError(null); setFaltantes([]); }}
          disabled={saving}
          className="h-6 border border-slate-300 bg-white px-1.5 text-xs text-slate-700 outline-none focus:border-cyan-500 disabled:opacity-60"
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
          className="inline-flex h-6 items-center gap-1 border border-cyan-300 bg-cyan-50 px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          OK
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
}: {
  borradores: BorradorEntry[];
  clienteId: string;
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
                <span className="font-mono font-semibold text-slate-900 text-sm">
                  {b.numFacturaSiigo}
                </span>
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

// ─── Pestaña Resumen ──────────────────────────────────────────────────────────

function TabResumen({
  tramite,
  onDateSaved,
  onEstadoChanged,
  puedeEditar,
  onRefresh,
}: {
  tramite: TramiteDetalleData;
  onDateSaved: (key: DateFieldKey, newIso: string | null, updated: TramiteDetalleData) => void;
  onEstadoChanged: (updated: TramiteDetalleData) => void;
  puedeEditar: boolean;
  onRefresh: () => void;
}) {
  const checklistTotal = tramite.checklistItems.length;
  const checklistRecibidos = tramite.checklistItems.filter((i) => i.recibido).length;
  const checklistPendientes = tramite.checklistItems.filter((i) => i.requerido && !i.recibido);

  return (
    <div className="space-y-6">
      {/* Cabecera DO */}
      <div className="grid gap-4 border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Consecutivo Galcomex</p>
          <p className="mt-0.5 text-lg font-bold text-slate-950">{tramite.consecutivo}</p>
        </div>
        {tramite.doAgencia ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">DO Agencia</p>
            <p className="mt-0.5 font-semibold text-slate-800">{tramite.doAgencia}</p>
          </div>
        ) : null}
        {tramite.doCliente ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">DO Cliente</p>
            <p className="mt-0.5 font-semibold text-slate-800">{tramite.doCliente}</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${statusClassName(tramite.estado)}`}
            >
              {tramite.estado.replace(/_/g, " ")}
            </span>
            <CambioEstadoButton tramite={tramite} onChanged={onEstadoChanged} />
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Cliente</p>
          <Link
            href={`/clientes/${tramite.cliente.id}`}
            className="mt-0.5 block font-semibold text-cyan-700 hover:underline"
          >
            {tramite.cliente.nombre}
          </Link>
          <p className="text-xs text-slate-500">{tramite.cliente.nit}</p>
        </div>
        {tramite.proveedorCliente ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Proveedor</p>
            <p className="mt-0.5 text-sm text-slate-700">{tramite.proveedorCliente}</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ciudad</p>
          <p className="mt-0.5 text-sm text-slate-700">{tramite.ciudad}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">ETA</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">{formatDate(tramite.eta)}</p>
        </div>
      </div>

      {/* Fechas clave con edición inline */}
      <div className="border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">Fechas clave</h3>
          <span className="text-xs text-slate-400">(click para editar)</span>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <InlineDateField
            label="Documentos OK"
            fieldKey="fechaDocumentosOk"
            value={tramite.fechaDocumentosOk}
            tramiteId={tramite.id}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Aceptación declaración"
            fieldKey="fechaAceptacionDeclaracion"
            value={tramite.fechaAceptacionDeclaracion}
            tramiteId={tramite.id}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Levante"
            fieldKey="fechaLevante"
            value={tramite.fechaLevante}
            tramiteId={tramite.id}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Salida de carga"
            fieldKey="fechaSalidaCarga"
            value={tramite.fechaSalidaCarga}
            tramiteId={tramite.id}
            onSaved={onDateSaved}
          />
          <InlineDateField
            label="Enviado a facturar"
            fieldKey="fechaEnviadoAFacturar"
            value={tramite.fechaEnviadoAFacturar}
            tramiteId={tramite.id}
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
      />

      {/* Checklist */}
      {tramite.checklistItems.length > 0 ? (
        <div className="border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-900">Checklist documental</h3>
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
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block h-4 w-4 shrink-0 border ${
                    item.recibido
                      ? "border-emerald-400 bg-emerald-100"
                      : item.requerido
                        ? "border-rose-300 bg-rose-50"
                        : "border-slate-300 bg-white"
                  }`}
                  aria-hidden="true"
                />
                <span className={item.recibido ? "text-slate-600 line-through" : "text-slate-800"}>
                  {item.descripcion}
                </span>
                {item.requerido && !item.recibido ? (
                  <span className="text-xs text-rose-500">(requerido)</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Comentarios */}
      {tramite.comentarios ? (
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
        title="Historial no disponible"
        detail="El registro de cambios de estado estara disponible proximamente."
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

// ─── Pestaña Facturación ──────────────────────────────────────────────────────

function TabFacturacion({ tramite }: { tramite: TramiteDetalleData }) {
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
    </div>
  );
}

// ─── Componente principal TramiteDetalle ──────────────────────────────────────

const TABS: { id: TabId; label: string }[] = [
  { id: "hoja", label: "Hoja" },
  { id: "resumen", label: "Resumen" },
  { id: "documentos", label: "Documentos" },
  { id: "pagos", label: "Pagos a proveedores" },
  { id: "facturas-proveedor", label: "F. Proveedor" },
  { id: "facturacion", label: "Facturas de venta" },
  { id: "historial", label: "Historial" },
];

export function TramiteDetalle({ tramiteId }: { tramiteId: string }) {
  const [tramite, setTramite] = useState<TramiteDetalleData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<TabId>("hoja");
  const [userRol, setUserRol] = useState<string>("OPERATIVO");
  const [solicitandoFacturacion, setSolicitandoFacturacion] = useState(false);
  const [errorSolicitud, setErrorSolicitud] = useState<string | null>(null);
  const [topAction, setTopAction] = useState<
    null | "anticipo" | "pago" | "factura"
  >(null);

  // Cargar rol del usuario actual
  useEffect(() => {
    fetch("/api/auth/get-session", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (
          typeof data === "object" &&
          data !== null &&
          "user" in data &&
          typeof (data as Record<string, unknown>).user === "object"
        ) {
          const user = (data as Record<string, unknown>).user as Record<string, unknown>;
          if (typeof user.rol === "string") setUserRol(user.rol);
        }
      })
      .catch(() => {/* silencioso */});
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setTramite(null);
      setLoadError(null);
      setLoadState("loading");

      try {
        const data = await fetchTramiteDetalle(tramiteId, controller.signal);
        setTramite(data);
        setLoadState("ready");
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(caught instanceof Error ? caught.message : "Error al cargar el tramite.");
        setLoadState("error");
      }
    }

    void load();

    return () => controller.abort();
  }, [tramiteId, reloadKey]);

  const handleDateSaved = useCallback(
    (_key: DateFieldKey, _newIso: string | null, updated: TramiteDetalleData) => {
      setTramite(updated);
    },
    [],
  );

  const handleEstadoChanged = useCallback((updated: TramiteDetalleData) => {
    setTramite(updated);
  }, []);

  async function handleSolicitarFacturacion() {
    if (!tramite) return;
    setSolicitandoFacturacion(true);
    setErrorSolicitud(null);
    try {
      await solicitarFacturacion(tramite.id);
      // Recargar para reflejar el nuevo estado
      setReloadKey((k) => k + 1);
    } catch (caught) {
      setErrorSolicitud(
        caught instanceof FacturasProveedorApiError
          ? caught.message
          : "No se pudo solicitar la facturación.",
      );
    } finally {
      setSolicitandoFacturacion(false);
    }
  }

  if (loadState === "loading") {
    return (
      <ModuleState type="loading" title="Cargando detalle del tramite" detail="Consultando API..." />
    );
  }

  if (loadState === "error" || !tramite) {
    return (
      <div className="space-y-3">
        <ModuleState
          type="error"
          title="No se pudo cargar el tramite"
          detail={loadError ?? "Error desconocido."}
        />
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Reintentar
        </button>
      </div>
    );
  }

  // ─── Permisos por acción (alineados con los roles que exige cada endpoint) ──
  const puedeAnticipo = userRol === "ADMIN";
  const puedePago = userRol === "ADMIN" || userRol === "OPERATIVO";
  const puedeEstado =
    userRol === "ADMIN" || userRol === "REVISOR" || userRol === "OPERATIVO";
  const puedeFacturar =
    userRol === "ADMIN" || userRol === "OPERATIVO" || userRol === "SOCIO";
  const puedeFacturaProveedor = userRol !== "REVISOR";
  const yaEnviadoAFacturar =
    tramite.estado === "ENVIADO_A_FACTURAR" ||
    tramite.estado === "FACTURADO" ||
    tramite.estado === "PAGADO" ||
    tramite.estado === "CERRADO";

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <div className="space-y-0">
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
              {puedeEstado ? (
                <CambioEstadoButton tramite={tramite} onChanged={handleEstadoChanged} />
              ) : null}
            </div>
          </div>

          {/* Acciones */}
          <div className="flex flex-wrap items-center gap-2">
            {puedeAnticipo ? (
              <button
                type="button"
                onClick={() => setTopAction("anticipo")}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                <Wallet className="h-4 w-4" aria-hidden="true" />
                Registrar anticipo
              </button>
            ) : null}
            {puedePago ? (
              <button
                type="button"
                onClick={() => setTopAction("pago")}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                <Banknote className="h-4 w-4" aria-hidden="true" />
                Pago a proveedor
              </button>
            ) : null}
            {puedeFacturaProveedor ? (
              <button
                type="button"
                onClick={() => setTopAction("factura")}
                className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                <Receipt className="h-4 w-4" aria-hidden="true" />
                Factura proveedor
              </button>
            ) : null}
            {puedeFacturar ? (
              <button
                type="button"
                onClick={() => void handleSolicitarFacturacion()}
                disabled={solicitandoFacturacion || yaEnviadoAFacturar}
                title={
                  yaEnviadoAFacturar ? "El trámite ya fue enviado a facturar" : undefined
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
          <p className="mt-2 flex items-center gap-1 text-xs text-rose-600">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {errorSolicitud}
          </p>
        ) : null}
      </div>

      {/* Nav de pestañas */}
      <div className="flex overflow-x-auto border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex h-10 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium transition ${
              activeTab === tab.id
                ? "border-slate-950 text-slate-950"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Contenido de pestañas */}
      <div className="mt-5">
        {activeTab === "hoja" ? (
          <HojaTramite tramiteId={tramiteId} />
        ) : null}
        {activeTab === "resumen" ? (
          <TabResumen
            tramite={tramite}
            onDateSaved={handleDateSaved}
            onEstadoChanged={handleEstadoChanged}
            puedeEditar={userRol === "ADMIN"}
            onRefresh={() => setReloadKey((k) => k + 1)}
          />
        ) : null}
        {activeTab === "documentos" ? (
          <SeccionDocumentos tramiteId={tramiteId} />
        ) : null}
        {activeTab === "pagos" ? (
          <LibroPagos tramiteId={tramiteId} />
        ) : null}
        {activeTab === "facturas-proveedor" ? (
          <SeccionFacturasProveedor
            tramiteId={tramiteId}
            puedeEditar={userRol !== "REVISOR"}
          />
        ) : null}
        {activeTab === "facturacion" ? (
          <TabFacturacion tramite={tramite} />
        ) : null}
        {activeTab === "historial" ? (
          <TabHistorial tramite={tramite} />
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
          onClose={() => setTopAction(null)}
          onCreated={() => {
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
