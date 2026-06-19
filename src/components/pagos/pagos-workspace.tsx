"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CANALES_PAGO,
  type CanalPago,
  type ClienteOption,
  type PagoGlobalRow,
  type PagosGlobalFiltros,
  type TramiteOption,
  PagosApiError,
  createPago,
  deletePago,
  fetchClienteOptions,
  fetchPagosGlobal,
  fetchTramiteOptions,
  formatCOP,
  updatePago,
} from "@/components/pagos/pagos-global-api";
import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";

type LoadState = "loading" | "ready" | "error";

// ---------------------------------------------------------------------------
// Helpers de formato / parseo
// ---------------------------------------------------------------------------

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").replace(/COP/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  try {
    return BigInt(cleaned).toString();
  } catch {
    return null;
  }
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fila editable
// ---------------------------------------------------------------------------

type FilaPago = PagoGlobalRow & {
  editingConcepto: string;
  editingBeneficiario: string;
  editingNumSoporte: string;
  editingValor: string;
  editingCanal: CanalPago;
  editingFechaReal: string;
  dirty: boolean;
  saving: boolean;
  errorFila: string | null;
};

function filaFromRow(row: PagoGlobalRow): FilaPago {
  return {
    ...row,
    editingConcepto: row.concepto,
    editingBeneficiario: row.beneficiario ?? "",
    editingNumSoporte: row.numSoporte ?? "",
    editingValor: row.valor,
    editingCanal: row.canalPago,
    editingFechaReal: isoToDateInput(row.fechaRealPago),
    dirty: false,
    saving: false,
    errorFila: null,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState("");
  const [beneficiarioSel, setBeneficiarioSel] = useState<BeneficiarioSeleccion | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const tramiteId = String(formData.get("tramiteId") ?? "").trim();
    const concepto = String(formData.get("concepto") ?? "").trim();
    const numSoporte = String(formData.get("numSoporte") ?? "").trim() || null;
    const canalPago = String(formData.get("canalPago") ?? "") as CanalPago;
    const fechaRealPago = String(formData.get("fechaRealPago") ?? "").trim() || null;

    if (!tramiteId) {
      setError("Selecciona el DO al que pertenece el pago.");
      return;
    }

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig || BigInt(valorBig) <= 0n) {
      setError("El valor debe ser un número entero mayor a 0.");
      return;
    }

    setIsSubmitting(true);
    try {
      await createPago(tramiteId, {
        concepto,
        beneficiarioId: beneficiarioSel?.id ?? null,
        numSoporte,
        valor: valorBig,
        canalPago,
        fechaRealPago,
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof PagosApiError ? caught.message : "Error al crear el pago.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Agregar pago</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Beneficiario</span>
              <BeneficiarioCombobox
                value={beneficiarioSel}
                onChange={setBeneficiarioSel}
              />
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">N° soporte</span>
              <input
                name="numSoporte"
                placeholder="Ref. comprobante"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
              <input
                type="date"
                name="fechaRealPago"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
              <input
                value={valorRaw}
                onChange={(ev) => setValorRaw(ev.target.value)}
                placeholder="1.000.000"
                inputMode="numeric"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
              <select
                name="canalPago"
                required
                defaultValue="BANCOLOMBIA_TRANSFERENCIA"
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
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fila de la tabla (edición inline + autosave)
// ---------------------------------------------------------------------------

type FilaPagoProps = {
  fila: FilaPago;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaPago,
      | "editingConcepto"
      | "editingBeneficiario"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
  ) => void;
  onBlur: (id: string) => void;
  onDelete: (fila: FilaPago) => void;
};

function FilaPagoRow({ fila, isDeleting, onChange, onBlur, onDelete }: FilaPagoProps) {
  return (
    <>
      <tr className={`border-b border-slate-100 last:border-b-0 ${fila.saving ? "opacity-60" : ""} hover:bg-slate-50`}>
        {/* DO */}
        <td className="whitespace-nowrap px-3 py-2">
          <Link
            href={`/tramites/${fila.tramiteId}`}
            className="text-sm font-medium text-cyan-700 hover:underline"
          >
            {fila.consecutivo}
          </Link>
        </td>

        {/* Cliente */}
        <td className="px-3 py-2 text-sm text-slate-700">{fila.clienteNombre}</td>

        {/* Concepto */}
        <td className="px-3 py-2">
          <input
            value={fila.editingConcepto}
            onChange={(e) => onChange(fila.id, "editingConcepto", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            className="h-8 w-full min-w-[140px] border border-transparent bg-transparent px-1 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Beneficiario */}
        <td className="px-3 py-2">
          <input
            value={fila.editingBeneficiario}
            onChange={(e) => onChange(fila.id, "editingBeneficiario", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            placeholder="—"
            className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-300 focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* N° soporte */}
        <td className="px-3 py-2">
          <input
            value={fila.editingNumSoporte}
            onChange={(e) => onChange(fila.id, "editingNumSoporte", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            placeholder="—"
            className="h-8 w-full min-w-[100px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-300 focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Valor */}
        <td className="px-3 py-2 text-right">
          <input
            value={fila.editingValor}
            onChange={(e) => onChange(fila.id, "editingValor", e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => onBlur(fila.id)}
            inputMode="numeric"
            className="h-8 w-full min-w-[110px] border border-transparent bg-transparent px-1 text-right text-sm font-medium text-slate-900 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Canal */}
        <td className="px-3 py-2">
          <select
            value={fila.editingCanal}
            onChange={(e) => {
              onChange(fila.id, "editingCanal", e.target.value);
              onBlur(fila.id);
            }}
            className="h-8 w-full min-w-[180px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
          >
            {CANALES_PAGO.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </td>

        {/* Fecha real */}
        <td className="px-3 py-2">
          <input
            type="date"
            value={fila.editingFechaReal}
            onChange={(e) => onChange(fila.id, "editingFechaReal", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Costo bancario (solo lectura) */}
        <td className="px-3 py-2 text-right text-sm text-slate-600">
          {formatCOP(fila.costoBancario)}
        </td>

        {/* Acciones */}
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            {fila.saving ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
            ) : fila.dirty ? (
              <span className="h-2 w-2 rounded-full bg-amber-400" title="Cambios pendientes" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-slate-300" aria-hidden="true" />
            )}
            <button
              type="button"
              onClick={() => onDelete(fila)}
              disabled={isDeleting}
              className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
              aria-label="Eliminar pago"
              title="Eliminar pago"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </td>
      </tr>

      {fila.errorFila ? (
        <tr className="bg-rose-50">
          <td colSpan={10} className="px-3 py-1.5 text-xs text-rose-700">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function PagosWorkspace() {
  const [filas, setFilas] = useState<FilaPago[]>([]);
  const [totales, setTotales] = useState({ totalPagos: "0", costosBancarios: "0", totalPendiente: "0" });
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [tramites, setTramites] = useState<TramiteOption[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Filtros
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroCanal, setFiltroCanal] = useState<CanalPago | "">("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [busqueda, setBusqueda] = useState("");

  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Carga ---
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);

      const filtros: PagosGlobalFiltros = {
        clienteId: filtroCliente || undefined,
        canalPago: filtroCanal || undefined,
        soloPendientes: soloPendientes || undefined,
      };

      const [data, clientesData, tramitesData] = await Promise.all([
        fetchPagosGlobal(filtros, controller.signal),
        fetchClienteOptions(controller.signal),
        fetchTramiteOptions(controller.signal),
      ]);

      setFilas(data.pagos.map(filaFromRow));
      setTotales({
        totalPagos: data.totalPagos,
        costosBancarios: data.costosBancarios,
        totalPendiente: data.totalPendiente,
      });
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
  }, [reloadKey, filtroCliente, filtroCanal, soloPendientes]);

  // Búsqueda en cliente (concepto / beneficiario / N° soporte / DO)
  const filasVisibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter(
      (f) =>
        f.concepto.toLowerCase().includes(q) ||
        (f.beneficiario ?? "").toLowerCase().includes(q) ||
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
      | "editingBeneficiario"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
  ) {
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value, dirty: true, errorFila: null } : f)),
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

    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)));

    const valorBig = parseBigIntInput(fila.editingValor);
    const snapshot = { ...fila };

    try {
      const updated = await updatePago(fila.tramiteId, id, {
        concepto: fila.editingConcepto,
        numSoporte: fila.editingNumSoporte || null,
        valor: valorBig ?? fila.valor,
        canalPago: fila.editingCanal,
        fechaRealPago: fila.editingFechaReal || null,
      });

      setFilas((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f;
          return {
            ...f,
            concepto: updated.concepto,
            beneficiario: updated.beneficiario?.nombre ?? null,
            numSoporte: updated.numSoporte,
            valor: updated.valor,
            canalPago: updated.canalPago,
            costoBancario: updated.costoBancario,
            fechaRealPago: updated.fechaRealPago,
            editingConcepto: updated.concepto,
            editingBeneficiario: updated.beneficiario?.nombre ?? "",
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
    } catch (caught) {
      const msg = caught instanceof PagosApiError ? caught.message : "Error al guardar.";
      setFilas((prev) =>
        prev.map((f) => (f.id === id ? { ...snapshot, saving: false, errorFila: msg } : f)),
      );
    }
  }

  // Recalcula los totales de las tarjetas a partir de las filas actuales
  function setReloadTotales() {
    setFilas((prev) => {
      const totalPagos = prev.reduce((s, f) => s + BigInt(parseBigIntInput(f.editingValor) ?? f.valor), 0n);
      const costosBancarios = prev.reduce((s, f) => s + BigInt(f.costoBancario), 0n);
      const totalPendiente = prev.reduce(
        (s, f) => (f.fechaRealPago === null ? s + BigInt(parseBigIntInput(f.editingValor) ?? f.valor) : s),
        0n,
      );
      setTotales({
        totalPagos: totalPagos.toString(),
        costosBancarios: costosBancarios.toString(),
        totalPendiente: totalPendiente.toString(),
      });
      return prev;
    });
  }

  async function handleDelete(fila: FilaPago) {
    if (!confirm(`¿Eliminar el pago "${fila.concepto}" del DO ${fila.consecutivo}? Esta acción no se puede deshacer.`)) {
      return;
    }
    setDeletingId(fila.id);
    setGlobalError(null);

    try {
      await deletePago(fila.tramiteId, fila.id);
      setFilas((prev) => prev.filter((f) => f.id !== fila.id));
      setReloadTotales();
    } catch (caught) {
      setGlobalError(caught instanceof PagosApiError ? caught.message : "Error al eliminar.");
    } finally {
      setDeletingId(null);
    }
  }

  function handlePagoCreado() {
    setCreateOpen(false);
    setReloadKey((k) => k + 1);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Pagos</h1>
          <p className="mt-1 text-sm text-slate-600">
            Vista global de todos los pagos de todos los DOs. El libro por trámite sigue intacto.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-10 shrink-0 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Nuevo pago
        </button>
      </div>

      {/* Tarjetas de resumen */}
      {loadState === "ready" && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total pagos", value: totales.totalPagos, color: "text-slate-900" },
            { label: "Costos bancarios", value: totales.costosBancarios, color: "text-slate-700" },
            { label: "Pendiente de pagar", value: totales.totalPendiente, color: "text-amber-700" },
          ].map((s) => (
            <div key={s.label} className="border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</p>
              <p className={`mt-1 text-xl font-bold ${s.color}`}>{formatCOP(s.value)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 text-sm">
        <select
          value={filtroCliente}
          onChange={(e) => setFiltroCliente(e.target.value)}
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
          value={filtroCanal}
          onChange={(e) => setFiltroCanal(e.target.value as CanalPago | "")}
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
          className={`h-9 border px-3 text-xs font-semibold transition ${
            soloPendientes
              ? "border-amber-600 bg-amber-600 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Solo pendientes
        </button>

        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar concepto, beneficiario, DO…"
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

      {/* Error global */}
      {globalError ? (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {globalError}
          <button type="button" onClick={() => setGlobalError(null)} className="ml-auto" aria-label="Cerrar">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {/* Tabla */}
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-900">Pagos</p>
          <p className="text-slate-500">{filasVisibles.length} registros</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">DO</th>
                <th className="border-b border-slate-200 px-3 py-2">Cliente</th>
                <th className="border-b border-slate-200 px-3 py-2">Concepto</th>
                <th className="border-b border-slate-200 px-3 py-2">Beneficiario</th>
                <th className="border-b border-slate-200 px-3 py-2">N° soporte</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor (COP)</th>
                <th className="border-b border-slate-200 px-3 py-2">Canal</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha de pago</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {loadState === "loading" ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center text-sm text-slate-600">
                      <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
                      <p className="mt-3 font-medium text-slate-950">Cargando pagos…</p>
                    </div>
                  </td>
                </tr>
              ) : loadState === "error" ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center text-sm text-slate-600">
                      <AlertTriangle className="h-6 w-6 text-slate-400" aria-hidden="true" />
                      <p className="mt-3 font-medium text-slate-950">No fue posible cargar los pagos</p>
                      {loadError ? <p className="mt-1">{loadError}</p> : null}
                      <button
                        type="button"
                        onClick={() => setReloadKey((k) => k + 1)}
                        className="mt-4 inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        Reintentar
                      </button>
                    </div>
                  </td>
                </tr>
              ) : filasVisibles.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-500">
                    No hay pagos que coincidan con los filtros.
                  </td>
                </tr>
              ) : (
                filasVisibles.map((fila) => (
                  <FilaPagoRow
                    key={fila.id}
                    fila={fila}
                    isDeleting={deletingId === fila.id}
                    onChange={handleFieldChange}
                    onBlur={handleBlurField}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {createOpen ? (
        <NuevoPagoModal
          tramites={tramites}
          onClose={() => setCreateOpen(false)}
          onCreated={handlePagoCreado}
        />
      ) : null}
    </section>
  );
}
