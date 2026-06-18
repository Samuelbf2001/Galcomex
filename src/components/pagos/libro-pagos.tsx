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
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CANALES_PAGO,
  type AplicacionRow,
  type CanalPago,
  type FacturaProveedorOpcion,
  type LibroPagosData,
  type PagoRow,
  type TramiteDetail,
  PagosApiError,
  calcularSaldosCliente,
  createPago,
  deletePago,
  fetchFacturasProveedorTramite,
  fetchLibroPagos,
  fetchTramiteDetail,
  formatCOP,
  updatePago,
} from "@/components/pagos/pagos-api";
import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

/** Fila del libro con saldo corriente calculado localmente */
type FilaLibro = PagoRow & {
  saldoLocal: string; // BigInt serializado
  editingValor: string; // cadena de texto mientras edita
  editingConcepto: string;
  editingBeneficiario: BeneficiarioSeleccion | null; // objeto seleccionado
  editingNumSoporte: string;
  editingCanal: CanalPago;
  editingFechaEsperada: string; // YYYY-MM-DD o ""
  editingFechaReal: string;     // YYYY-MM-DD o ""
  dirty: boolean; // tiene cambios pendientes de PATCH
  saving: boolean;
  errorFila: string | null;
};

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function filaFromRow(row: PagoRow, saldo: string): FilaLibro {
  return {
    ...row,
    saldoLocal: saldo,
    editingValor: row.valor,
    editingConcepto: row.concepto,
    editingBeneficiario: row.beneficiario ?? null,
    editingNumSoporte: row.numSoporte ?? "",
    editingCanal: row.canalPago,
    editingFechaEsperada: isoToDateInput(row.fechaEsperadaPago),
    editingFechaReal: isoToDateInput(row.fechaRealPago),
    dirty: false,
    saving: false,
    errorFila: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers de formato / parseo
// ---------------------------------------------------------------------------

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  try {
    return BigInt(cleaned).toString();
  } catch {
    return null;
  }
}

function formatCOPInput(bigStr: string): string {
  try {
    const n = BigInt(bigStr);
    return new Intl.NumberFormat("es-CO").format(Number(n));
  } catch {
    return bigStr;
  }
}

function saldoColorClass(saldoStr: string): string {
  try {
    const n = BigInt(saldoStr);
    if (n > 0n) return "text-emerald-700 font-semibold";
    if (n < 0n) return "text-rose-600 font-semibold";
    return "text-slate-700 font-semibold";
  } catch {
    return "text-slate-700";
  }
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function statusClassName(status: string) {
  const n = status.toLowerCase();
  if (n.includes("cerr") || n.includes("fact") || n.includes("pagad")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (n.includes("anul") || n.includes("cancel")) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (n.includes("facturar")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (n.includes("tramite") || n.includes("puerto") || n.includes("apertura")) {
    return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

// ---------------------------------------------------------------------------
// Sub-componente: cabecera del DO
// ---------------------------------------------------------------------------

function DoHeader({ tramite }: { tramite: TramiteDetail }) {
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-2 border border-slate-200 bg-white px-5 py-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Consecutivo</p>
        <p className="mt-0.5 text-lg font-bold text-slate-950">{tramite.consecutivo}</p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Cliente</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-800">
          {tramite.cliente.nombre}
          <span className="ml-1.5 font-normal text-slate-500">{tramite.cliente.nit}</span>
        </p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</p>
        <span
          className={`mt-0.5 inline-flex h-7 items-center border px-2 text-xs font-semibold ${statusClassName(tramite.estado)}`}
        >
          {tramite.estado}
        </span>
      </div>
      {tramite.eta ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">ETA</p>
          <p className="mt-0.5 text-sm text-slate-700">{formatDate(tramite.eta)}</p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de anticipos (fiel al Excel — encima de los pagos)
// ---------------------------------------------------------------------------

function canalLabel(canal: string): string {
  const map: Record<string, string> = {
    BANCOLOMBIA_SUCURSAL: "Bancolombia Sucursal",
    BANCOLOMBIA_CAJERO: "Bancolombia Cajero",
    BANCOLOMBIA_CORRESPONSAL: "Bancolombia Corresponsal",
    BANCOLOMBIA_TRANSFERENCIA: "Bancolombia Transferencia",
    OTROS_BANCOS_SUCURSAL: "Otros Bancos Sucursal",
    OTROS_BANCOS_TRANSFERENCIA: "Otros Bancos Transferencia",
    PSE: "PSE",
    OTRO: "Otro",
  };
  return map[canal] ?? canal;
}

function SeccionAnticipos({
  aplicaciones,
  totalAnticipoAplicado,
  costosBancariosAnticipo,
}: {
  aplicaciones: AplicacionRow[];
  totalAnticipoAplicado: string;
  costosBancariosAnticipo: string;
}) {
  return (
    <div className="overflow-hidden border border-emerald-200 bg-white">
      <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50 px-4 py-2.5">
        <p className="text-sm font-semibold text-emerald-900">
          Anticipos aplicados a este DO
        </p>
        {aplicaciones.length === 0 ? (
          <span className="text-xs text-emerald-700">Sin anticipos</span>
        ) : null}
      </div>

      {aplicaciones.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">
          No hay anticipos aplicados. Registre uno desde el módulo de Anticipos.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2">Fecha</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Monto aplicado (COP)</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Monto total anticipo</th>
                  <th className="border-b border-slate-200 px-4 py-2">Tipo de recaudo</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Costo bancario</th>
                  <th className="border-b border-slate-200 px-4 py-2">Verificado</th>
                </tr>
              </thead>
              <tbody>
                {aplicaciones.map((ap) => (
                  <tr key={ap.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5 text-slate-700">{formatDate(ap.anticipo.fecha)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-700">
                      {formatCOP(ap.montoAplicado)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                      {formatCOP(ap.anticipo.monto)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 text-xs">{canalLabel(ap.anticipo.tipoRecaudo)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                      {formatCOP(ap.anticipo.costoBancario)}
                    </td>
                    <td className="px-4 py-2.5">
                      {ap.anticipo.verificadoBanco ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      ) : (
                        <span className="text-xs text-slate-400">Pendiente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Totales del bloque anticipo */}
          <div className="flex flex-wrap gap-6 border-t border-emerald-100 bg-emerald-50 px-4 py-2.5 text-sm">
            <div>
              <span className="text-emerald-700">Total anticipo aplicado: </span>
              <span className="font-bold text-emerald-900">{formatCOP(totalAnticipoAplicado)}</span>
            </div>
            <div>
              <span className="text-emerald-700">Costos bancarios anticipo: </span>
              <span className="font-semibold text-emerald-900">{formatCOP(costosBancariosAnticipo)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: resumen del libro
// ---------------------------------------------------------------------------

function ResumenLibro({ libro }: { libro: LibroPagosData; filas: FilaLibro[] }) {
  return (
    <div className="flex flex-wrap gap-6 border border-slate-200 bg-slate-50 px-5 py-3 text-sm">
      <div>
        <span className="text-slate-500">Anticipo aplicado: </span>
        <span className="font-semibold text-slate-900">
          {formatCOP(libro.totalAnticipoAplicado)}
        </span>
      </div>
      <div>
        <span className="text-slate-500">Total pagos: </span>
        <span className="font-semibold text-slate-900">{formatCOP(libro.totalPagos)}</span>
      </div>
      <div>
        <span className="text-slate-500">Costos bancarios: </span>
        <span className="font-semibold text-slate-900">{formatCOP(libro.costosBancarios)}</span>
      </div>
      <div>
        <span className="text-slate-500">Saldo final: </span>
        <span className={`text-base ${saldoColorClass(libro.saldoFinal)}`}>
          {formatCOP(libro.saldoFinal)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: modal de nuevo pago
// ---------------------------------------------------------------------------

type NuevoPagoModalProps = {
  tramiteId: string;
  onClose: () => void;
  onCreated: (pago: PagoRow) => void;
};

export function NuevoPagoModal({ tramiteId, onClose, onCreated }: NuevoPagoModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState("");
  const [beneficiarioSel, setBeneficiarioSel] = useState<BeneficiarioSeleccion | null>(null);

  // --- Facturas de proveedor disponibles para vincular ---
  const [facturasDisponibles, setFacturasDisponibles] = useState<FacturaProveedorOpcion[]>([]);
  const [facturaSeleccionada, setFacturaSeleccionada] = useState<string>("");
  // No bloqueamos el modal si falla la carga de FPs; simplemente no mostramos opciones.
  const [facturasLoadError, setFacturasLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetchFacturasProveedorTramite(tramiteId, controller.signal)
      .then((todas) => {
        // Solo las REGISTRADA son pagables
        setFacturasDisponibles(todas.filter((fp) => fp.estado === "REGISTRADA"));
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        // Error silencioso: el flujo manual sigue operativo
        setFacturasLoadError(true);
      });

    return () => controller.abort();
  }, [tramiteId]);

  // Cuando el usuario selecciona una factura, autocompletar valor si está vacío
  function handleFacturaChange(fpId: string) {
    setFacturaSeleccionada(fpId);

    if (!fpId) return;

    const fp = facturasDisponibles.find((f) => f.id === fpId);
    if (!fp) return;

    if (!valorRaw.trim()) {
      setValorRaw(fp.valor);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const concepto = String(formData.get("concepto") ?? "").trim();
    const numSoporte = String(formData.get("numSoporte") ?? "").trim() || null;
    const canalPago = String(formData.get("canalPago") ?? "") as CanalPago;
    const fechaEsperadaPago = String(formData.get("fechaEsperadaPago") ?? "").trim() || null;
    const fechaRealPago = String(formData.get("fechaRealPago") ?? "").trim() || null;

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig || BigInt(valorBig) <= 0n) {
      setError("El valor debe ser un número entero mayor a 0.");
      return;
    }

    setIsSubmitting(true);
    try {
      const pago = await createPago(tramiteId, {
        concepto,
        beneficiarioId: beneficiarioSel?.id ?? null,
        numSoporte,
        valor: valorBig,
        canalPago,
        fechaEsperadaPago,
        fechaRealPago,
        facturaProveedorId: facturaSeleccionada || null,
      });
      onCreated(pago);
    } catch (caught) {
      setError(caught instanceof PagosApiError ? caught.message : "Error al crear el pago.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Determinar si el selector de FPs debe mostrarse y su estado
  const hayFacturasDisponibles = facturasDisponibles.length > 0;

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
          {/* Factura de proveedor (opcional) */}
          {!facturasLoadError ? (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Factura de proveedor (opcional)</span>
              <select
                value={facturaSeleccionada}
                onChange={(ev) => handleFacturaChange(ev.target.value)}
                disabled={!hayFacturasDisponibles}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                {hayFacturasDisponibles ? (
                  <>
                    <option value="">Ninguna (pago manual)</option>
                    {facturasDisponibles.map((fp) => (
                      <option key={fp.id} value={fp.id}>
                        {fp.numFactura} — {fp.proveedorNombre} — {formatCOP(fp.valor)}
                      </option>
                    ))}
                  </>
                ) : (
                  <option value="">No hay facturas de proveedor pendientes</option>
                )}
              </select>
            </label>
          ) : null}

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
              <span className="text-sm font-medium text-slate-700">Fecha esperada de pago</span>
              <input
                type="date"
                name="fechaEsperadaPago"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Fecha real de pago</span>
              <input
                type="date"
                name="fechaRealPago"
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
// Componente principal: LibroPagos
// ---------------------------------------------------------------------------

export function LibroPagos({ tramiteId }: { tramiteId: string }) {
  const [tramite, setTramite] = useState<TramiteDetail | null>(null);
  const [libro, setLibro] = useState<LibroPagosData | null>(null);
  const [filas, setFilas] = useState<FilaLibro[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Carga inicial ---
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);

      const [tramiteData, libroData] = await Promise.all([
        fetchTramiteDetail(tramiteId, controller.signal),
        fetchLibroPagos(tramiteId, controller.signal),
      ]);
      setTramite(tramiteData);
      setLibro(libroData);

      // Construir filas con saldos calculados localmente
      const saldos = calcularSaldosCliente(
        libroData.totalAnticipoAplicado,
        libroData.pagos.map((p) => p.valor),
      );
      setFilas(libroData.pagos.map((p, i) => filaFromRow(p, saldos[i] ?? "0")));
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar los datos.");
      setLoadState("error");
    });

    return () => controller.abort();
  }, [tramiteId, reloadKey]);

  // --- Recalcular saldos localmente cuando cambian los valores editados ---
  const recalcularSaldos = useCallback(
    (filasActuales: FilaLibro[], anticipo: string): FilaLibro[] => {
      let saldo = BigInt(anticipo);
      return filasActuales.map((fila) => {
        const val = parseBigIntInput(fila.editingValor);
        const bigVal = val ? BigInt(val) : BigInt(fila.valor);
        saldo -= bigVal;
        return { ...fila, saldoLocal: saldo.toString() };
      });
    },
    [],
  );

  // --- Handlers de edición inline ---

  function handleFieldChange(
    id: string,
    field: keyof Pick<
      FilaLibro,
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaEsperada" | "editingFechaReal"
    >,
    value: string,
  ) {
    setFilas((prev) => {
      const next = prev.map((f) =>
        f.id === id ? { ...f, [field]: value, dirty: true, errorFila: null } : f,
      );
      if (libro && field === "editingValor") {
        return recalcularSaldos(next, libro.totalAnticipoAplicado);
      }
      return next;
    });
  }

  function handleBeneficiarioChange(id: string, beneficiario: BeneficiarioSeleccion | null) {
    setFilas((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, editingBeneficiario: beneficiario, dirty: true, errorFila: null }
          : f,
      ),
    );
    // Auto-save inmediato al cambiar beneficiario (es un cambio discreto, no texto libre)
    setTimeout(() => void commitFila(id), 0);
  }

  function scheduleAutoSave(fila: FilaLibro) {
    // Cancela el timer previo para esta fila
    if (saveTimersRef.current[fila.id]) {
      clearTimeout(saveTimersRef.current[fila.id]);
    }
    saveTimersRef.current[fila.id] = setTimeout(() => {
      void commitFila(fila.id);
    }, 900);
  }

  function handleBlurField(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (fila?.dirty) scheduleAutoSave(fila);
  }

  async function commitFila(id: string) {
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)),
    );

    const fila = filas.find((f) => f.id === id);
    if (!fila) return;

    const valorBig = parseBigIntInput(fila.editingValor);

    // Snapshot para rollback
    const snapshot = { ...fila };

    try {
      const updated = await updatePago(tramiteId, id, {
        concepto: fila.editingConcepto,
        beneficiarioId: fila.editingBeneficiario?.id ?? null,
        numSoporte: fila.editingNumSoporte || null,
        valor: valorBig ?? fila.valor,
        canalPago: fila.editingCanal,
        fechaEsperadaPago: fila.editingFechaEsperada || null,
        fechaRealPago: fila.editingFechaReal || null,
      });

      setFilas((prev) => {
        const next = prev.map((f) => {
          if (f.id !== id) return f;
          return {
            ...f,
            ...updated,
            editingValor: updated.valor,
            editingConcepto: updated.concepto,
            editingBeneficiario: updated.beneficiario ?? null,
            editingNumSoporte: updated.numSoporte ?? "",
            editingCanal: updated.canalPago,
            editingFechaEsperada: isoToDateInput(updated.fechaEsperadaPago),
            editingFechaReal: isoToDateInput(updated.fechaRealPago),
            dirty: false,
            saving: false,
            errorFila: null,
          };
        });
        // Recalcular saldos con el valor confirmado por el backend
        if (libro) return recalcularSaldos(next, libro.totalAnticipoAplicado);
        return next;
      });

      // Actualizar resumen del libro localmente
      setLibro((prev) => {
        if (!prev) return prev;
        const totalPagos = filas.reduce((sum, f) => {
          const v = parseBigIntInput(f.id === id ? updated.valor : f.editingValor) ?? f.valor;
          return sum + BigInt(v);
        }, 0n);
        const saldos = calcularSaldosCliente(
          prev.totalAnticipoAplicado,
          filas.map((f) => (f.id === id ? updated.valor : parseBigIntInput(f.editingValor) ?? f.valor)),
        );
        const saldoFinal = saldos.length > 0 ? saldos[saldos.length - 1] : prev.totalAnticipoAplicado;
        return { ...prev, totalPagos: totalPagos.toString(), saldos, saldoFinal: saldoFinal ?? "0" };
      });
    } catch (caught) {
      const msg = caught instanceof PagosApiError ? caught.message : "Error al guardar.";
      // Rollback optimista
      setFilas((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...snapshot,
                saving: false,
                errorFila: msg,
              }
            : f,
        ),
      );
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("¿Eliminar este pago? Esta acción no se puede deshacer.")) return;
    setDeletingId(id);
    setGlobalError(null);

    try {
      await deletePago(tramiteId, id);
      setFilas((prev) => {
        const next = prev.filter((f) => f.id !== id);
        if (libro) return recalcularSaldos(next, libro.totalAnticipoAplicado);
        return next;
      });
      setLibro((prev) => {
        if (!prev) return prev;
        const remaining = filas.filter((f) => f.id !== id);
        const totalPagos = remaining.reduce(
          (sum, f) => sum + BigInt(parseBigIntInput(f.editingValor) ?? f.valor),
          0n,
        );
        const saldos = calcularSaldosCliente(
          prev.totalAnticipoAplicado,
          remaining.map((f) => parseBigIntInput(f.editingValor) ?? f.valor),
        );
        const saldoFinal = saldos.length > 0 ? saldos[saldos.length - 1] : prev.totalAnticipoAplicado;
        return { ...prev, totalPagos: totalPagos.toString(), saldos, saldoFinal: saldoFinal ?? "0" };
      });
    } catch (caught) {
      setGlobalError(caught instanceof PagosApiError ? caught.message : "Error al eliminar.");
    } finally {
      setDeletingId(null);
    }
  }

  function handlePagoCreado() {
    setModalOpen(false);
    // Reload para asegurar saldo actualizado desde el backend
    setReloadKey((k) => k + 1);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loadState === "loading") {
    return (
      <div className="flex min-h-40 items-center gap-3 border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-600">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" aria-hidden="true" />
        <span className="font-medium text-slate-900">Cargando libro de pagos…</span>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex min-h-40 items-start gap-3 border border-dashed border-rose-300 bg-rose-50 px-4 py-5 text-sm text-rose-700">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">No fue posible cargar el libro de pagos</p>
          {loadError ? <p className="mt-1">{loadError}</p> : null}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 inline-flex h-9 items-center gap-2 border border-rose-300 bg-white px-3 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (!tramite || !libro) return null;

  return (
    <section className="space-y-4">
      <DoHeader tramite={tramite} />

      <SeccionAnticipos
        aplicaciones={libro.aplicaciones}
        totalAnticipoAplicado={libro.totalAnticipoAplicado}
        costosBancariosAnticipo={libro.costosBancariosAnticipo}
      />

      <ResumenLibro libro={libro} filas={filas} />

      {globalError ? (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {globalError}
          <button
            type="button"
            onClick={() => setGlobalError(null)}
            className="ml-auto"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">
            Pagos ({filas.length})
          </p>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nuevo pago
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2 w-8">#</th>
                <th className="border-b border-slate-200 px-3 py-2">Concepto</th>
                <th className="border-b border-slate-200 px-3 py-2">Beneficiario</th>
                <th className="border-b border-slate-200 px-3 py-2">N° soporte</th>
                <th className="border-b border-slate-200 px-3 py-2">Factura / Vía</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor (COP)</th>
                <th className="border-b border-slate-200 px-3 py-2">Canal de pago</th>
                <th className="border-b border-slate-200 px-3 py-2">F. esperada</th>
                <th className="border-b border-slate-200 px-3 py-2">F. real pago</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Saldo corriente</th>
                <th className="border-b border-slate-200 px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-10 text-center text-sm text-slate-500">
                    Sin pagos registrados. Usa &quot;Nuevo pago&quot; para agregar el primero.
                  </td>
                </tr>
              ) : null}
              {filas.map((fila, idx) => (
                <FilaPago
                  key={fila.id}
                  fila={fila}
                  index={idx + 1}
                  isDeleting={deletingId === fila.id}
                  onChange={handleFieldChange}
                  onBeneficiarioChange={handleBeneficiarioChange}
                  onBlur={handleBlurField}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen ? (
        <NuevoPagoModal
          tramiteId={tramiteId}
          onClose={() => setModalOpen(false)}
          onCreated={handlePagoCreado}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: fila editable
// ---------------------------------------------------------------------------

type FilaPagoProps = {
  fila: FilaLibro;
  index: number;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaLibro,
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaEsperada" | "editingFechaReal"
    >,
    value: string,
  ) => void;
  onBeneficiarioChange: (id: string, b: BeneficiarioSeleccion | null) => void;
  onBlur: (id: string) => void;
  onDelete: (id: string) => void;
};

function FilaPago({ fila, index, isDeleting, onChange, onBeneficiarioChange, onBlur, onDelete }: FilaPagoProps) {
  return (
    <>
      <tr className={`border-b border-slate-100 last:border-b-0 ${fila.saving ? "opacity-60" : ""} hover:bg-slate-50`}>
        <td className="px-3 py-2 text-xs text-slate-400">{index}</td>

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
        <td className="px-3 py-2 min-w-[180px]">
          <BeneficiarioCombobox
            value={fila.editingBeneficiario}
            onChange={(b) => onBeneficiarioChange(fila.id, b)}
            placeholder="—"
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

        {/* Factura proveedor / vía Lucho */}
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {fila.numFacturaProveedor ? (
              <span className="inline-flex items-center border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700">
                {fila.numFacturaProveedor}
              </span>
            ) : null}
            {fila.viaSocio ? (
              <span className="inline-flex items-center border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                vía Lucho
              </span>
            ) : null}
          </div>
        </td>

        {/* Valor */}
        <td className="px-3 py-2 text-right">
          <input
            value={fila.editingValor === fila.valor
              ? formatCOPInput(fila.editingValor)
              : fila.editingValor}
            onChange={(e) => onChange(fila.id, "editingValor", e.target.value)}
            onFocus={(e) => {
              // Al enfocar, mostrar el número limpio para editar
              onChange(fila.id, "editingValor", fila.editingValor.replace(/\./g, "").replace(/\$/g, "").replace(/COP/g, "").trim());
              e.target.select();
            }}
            onBlur={() => onBlur(fila.id)}
            inputMode="numeric"
            className="h-8 w-full min-w-[110px] border border-transparent bg-transparent px-1 text-right text-sm font-medium text-slate-900 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Canal de pago */}
        <td className="px-3 py-2">
          <select
            value={fila.editingCanal}
            onChange={(e) => {
              onChange(fila.id, "editingCanal", e.target.value);
              onBlur(fila.id);
            }}
            className="h-8 w-full min-w-[190px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
          >
            {CANALES_PAGO.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </td>

        {/* Fecha esperada de pago */}
        <td className="px-3 py-2">
          <input
            type="date"
            value={fila.editingFechaEsperada}
            onChange={(e) => onChange(fila.id, "editingFechaEsperada", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Fecha real de pago */}
        <td className="px-3 py-2">
          <input
            type="date"
            value={fila.editingFechaReal}
            onChange={(e) => onChange(fila.id, "editingFechaReal", e.target.value)}
            onBlur={() => onBlur(fila.id)}
            className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
          />
        </td>

        {/* Costo bancario — de solo lectura (calculado por backend) */}
        <td className="px-3 py-2 text-right text-sm text-slate-600">
          {formatCOP(fila.costoBancario)}
        </td>

        {/* Saldo corriente — recalculado en vivo en cliente */}
        <td className={`px-3 py-2 text-right text-sm ${saldoColorClass(fila.saldoLocal)}`}>
          {formatCOP(fila.saldoLocal)}
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
              onClick={() => onDelete(fila.id)}
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

      {/* Fila de error de la fila */}
      {fila.errorFila ? (
        <tr className="bg-rose-50">
          <td colSpan={12} className="px-3 py-1.5 text-xs text-rose-700">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
    </>
  );
}
