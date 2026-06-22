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
  type EstadoMovimiento,
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
  editingBeneficiarios: BeneficiarioSeleccion[]; // lista seleccionada N↔N
  editingNumSoporte: string;
  editingCanal: CanalPago;
  editingFechaReal: string; // YYYY-MM-DD o ""
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

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function filaFromRow(row: PagoRow, saldo: string): FilaLibro {
  return {
    ...row,
    saldoLocal: saldo,
    editingValor: row.valor,
    editingConcepto: row.concepto,
    editingBeneficiarios: row.beneficiarios ?? [],
    editingNumSoporte: row.numSoporte ?? "",
    editingCanal: row.canalPago,
    editingFechaReal: isoToDateInput(row.fechaRealPago) || todayInput(),
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

type PseStep = "form" | "soporte";
type PendingSubmit = { concepto: string; numSoporte: string | null; canalPago: CanalPago; valor: string };

type NuevoPagoModalProps = {
  tramiteId: string;
  tramiteConsecutivo: string;
  onClose: () => void;
  onCreated: (pago: PagoRow) => void;
};

export function NuevoPagoModal({ tramiteId, tramiteConsecutivo, onClose, onCreated }: NuevoPagoModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState("");
  const [beneficiariosSel, setBeneficiariosSel] = useState<BeneficiarioSeleccion[]>([]);
  const [fechaRealPago, setFechaRealPago] = useState(todayInput());
  const [canalPago, setCanalPago] = useState<CanalPago>(CANALES_PAGO[0]?.value ?? "TRANSF_BANCOLOMBIA");

  // Facturas de proveedor disponibles (multiselect)
  const [facturasDisponibles, setFacturasDisponibles] = useState<FacturaProveedorOpcion[]>([]);
  const [facturasSeleccionadas, setFacturasSeleccionadas] = useState<Set<string>>(new Set());
  const [facturasLoadError, setFacturasLoadError] = useState(false);

  // Diálogo de confirmación cuando el valor desvía ±10% del total de facturas seleccionadas
  const [confirmPending, setConfirmPending] = useState<PendingSubmit | null>(null);
  const [confirmPct, setConfirmPct] = useState(0);

  // PSE: wizard de 2 pasos (form → soporte)
  const [pseStep, setPseStep] = useState<PseStep>("form");
  const [psePendingPayload, setPsePendingPayload] = useState<PendingSubmit | null>(null);
  const [isRequestingToken, setIsRequestingToken] = useState(false);
  const [pseCodigoRecibido, setPseCodigoRecibido] = useState<string | null>(null);
  const [soporteFile, setSoporteFile] = useState<File | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);

  // Polling: espera el código PSE que María Camila ingresa en su landing
  useEffect(() => {
    if (pseStep !== "soporte" || pseCodigoRecibido) return;
    const interval = setInterval(() => {
      fetch(`/api/tramites/${tramiteId}/pse-codigo`, { method: "GET" })
        .then(async (r) => {
          if (!r.ok) return;
          const data = (await r.json()) as { ready: boolean; codigo?: string };
          if (data.ready && data.codigo) {
            setPseCodigoRecibido(data.codigo);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(interval);
  }, [pseStep, pseCodigoRecibido, tramiteId]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFacturasProveedorTramite(tramiteId, controller.signal)
      .then((todas) => setFacturasDisponibles(todas.filter((fp) => fp.estado === "REGISTRADA")))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFacturasLoadError(true);
      });
    return () => controller.abort();
  }, [tramiteId]);

  function toggleFactura(id: string) {
    setFacturasSeleccionadas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const sumaFacturas: bigint = facturasDisponibles
    .filter((fp) => facturasSeleccionadas.has(fp.id))
    .reduce((sum, fp) => {
      try { return sum + BigInt(fp.valor); } catch { return sum; }
    }, 0n);

  async function submitPayload(payload: PendingSubmit) {
    setIsSubmitting(true);
    setConfirmPending(null);
    try {
      const pago = await createPago(tramiteId, {
        concepto: payload.concepto,
        beneficiarioIds: beneficiariosSel.map((b) => b.id),
        numSoporte: payload.numSoporte,
        valor: payload.valor,
        canalPago: payload.canalPago,
        fechaRealPago: fechaRealPago || null,
        facturaProveedorIds: Array.from(facturasSeleccionadas),
      });
      onCreated(pago);
    } catch (caught) {
      setError(caught instanceof PagosApiError ? caught.message : "Error al crear el pago.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function notificarCamilaPse(payload: PendingSubmit) {
    setIsRequestingToken(true);
    setError(null);
    try {
      const resp = await fetch(`/api/tramites/${tramiteId}/pse-token`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!resp.ok) throw new Error("No fue posible notificar a María Camila.");
      setPsePendingPayload(payload);
      setPseStep("soporte");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Error al solicitar el pago PSE.");
    } finally {
      setIsRequestingToken(false);
    }
  }

  async function finalizarPsePago() {
    if (!psePendingPayload || !soporteFile || !pseCodigoRecibido) return;
    setIsUploadingDoc(true);
    setError(null);
    try {
      const uploadResp = await fetch("/api/storage", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          action: "uploadUrl",
          consecutivo: tramiteConsecutivo,
          categoria: "soporte-pse",
          fileName: soporteFile.name,
          contentType: soporteFile.type,
          sizeBytes: soporteFile.size,
        }),
      });
      if (!uploadResp.ok) {
        const err = await uploadResp.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof err.error === "string" ? err.error : "Error al obtener URL de subida.");
      }
      const { uploadUrl } = await uploadResp.json() as { uploadUrl: { url: string; storageKey: string } };

      const putResp = await fetch(uploadUrl.url, {
        method: "PUT",
        body: soporteFile,
        headers: { "content-type": soporteFile.type },
      });
      if (!putResp.ok) throw new Error("Error al subir el documento.");

      await submitPayload({ ...psePendingPayload, numSoporte: pseCodigoRecibido });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Error al finalizar el pago PSE.");
    } finally {
      setIsUploadingDoc(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const concepto = String(formData.get("concepto") ?? "").trim();
    const numSoporte = String(formData.get("numSoporte") ?? "").trim() || null;

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig || BigInt(valorBig) <= 0n) {
      setError("El valor debe ser un número entero mayor a 0.");
      return;
    }

    const payload: PendingSubmit = { concepto, numSoporte, canalPago, valor: valorBig };

    // Flujo PSE: notifica a María Camila y pasa directo a adjuntar soporte
    if (canalPago === "PSE") {
      await notificarCamilaPse(payload);
      return;
    }

    // Verificar desviación ±10% solo si hay facturas seleccionadas
    if (facturasSeleccionadas.size > 0 && sumaFacturas > 0n) {
      const diff = BigInt(valorBig) - sumaFacturas;
      const pct = Number((diff * 1000n) / sumaFacturas) / 10;
      if (Math.abs(pct) > 10) {
        setConfirmPending(payload);
        setConfirmPct(pct);
        return;
      }
    }

    await submitPayload(payload);
  }

  const titleByStep: Record<PseStep, string> = {
    form: "Agregar pago",
    soporte: "Adjuntar soporte",
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
        <div className="w-full max-w-xl border border-slate-300 bg-white shadow-xl">

          {/* Cabecera */}
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-semibold text-slate-950">{titleByStep[pseStep]}</h2>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* Indicador de pasos — visible cuando el canal es PSE o ya avanzó */}
          {(canalPago === "PSE" || pseStep !== "form") ? (
            <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs">
              {(["form", "soporte"] as PseStep[]).map((step, i) => {
                const labels = ["1. Datos", "2. Soporte"];
                const active = step === pseStep;
                const done = step === "form" && pseStep === "soporte";
                return (
                  <span key={step} className="flex items-center gap-2">
                    {i > 0 && <span className="text-slate-300">›</span>}
                    <span className={active ? "font-semibold text-cyan-700" : done ? "text-slate-500" : "text-slate-300"}>
                      {labels[i]}
                    </span>
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* Paso 1: formulario de datos del pago */}
          {pseStep === "form" ? (
            <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
              {/* Facturas de proveedor — multiselect (opcional) */}
              <div className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Facturas de proveedor a cubrir
                  <span className="ml-1.5 font-normal text-slate-400">(opcional)</span>
                  {facturasSeleccionadas.size > 0 ? (
                    <span className="ml-2 font-normal text-slate-500">
                      — Total: {formatCOP(sumaFacturas.toString())}
                    </span>
                  ) : null}
                </span>
                {facturasLoadError ? (
                  <p className="text-xs text-rose-600">No se pudieron cargar las facturas.</p>
                ) : facturasDisponibles.length === 0 ? (
                  <p className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-400">
                    Sin facturas de proveedor registradas para este trámite.
                  </p>
                ) : (
                  <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 border border-slate-200">
                    {facturasDisponibles.map((fp) => (
                      <label
                        key={fp.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={facturasSeleccionadas.has(fp.id)}
                          onChange={() => toggleFactura(fp.id)}
                          className="h-4 w-4 accent-cyan-600"
                        />
                        <span className="flex-1 text-sm text-slate-700">
                          <span className="font-medium">{fp.numFactura}</span>
                          <span className="mx-1 text-slate-400">—</span>
                          {fp.proveedorNombre}
                        </span>
                        <span className="font-mono text-sm text-slate-600">{formatCOP(fp.valor)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

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
                  <span className="text-sm font-medium text-slate-700">Beneficiarios</span>
                  <BeneficiarioCombobox
                    mode="multi"
                    value={beneficiariosSel}
                    onChange={setBeneficiariosSel}
                    placeholder="Buscar o crear beneficiario…"
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
                    value={canalPago}
                    onChange={(ev) => setCanalPago(ev.target.value as CanalPago)}
                    className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
                  >
                    {CANALES_PAGO.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
                <input
                  type="date"
                  value={fechaRealPago}
                  onChange={(ev) => setFechaRealPago(ev.target.value)}
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>

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
                  disabled={isSubmitting || isRequestingToken}
                  className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isSubmitting || isRequestingToken ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {canalPago === "PSE" ? "Solicitar pago PSE" : "Guardar pago"}
                </button>
              </div>
            </form>
          ) : null}

          {/* Paso 2: esperar código PSE de María Camila + adjuntar soporte */}
          {pseStep === "soporte" ? (
            <div className="space-y-4 px-5 py-5">

              {/* Estado del código */}
              {!pseCodigoRecibido ? (
                <div className="flex items-center gap-3 rounded border border-amber-200 bg-amber-50 px-4 py-3">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">Esperando a María Camila…</p>
                    <p className="text-xs text-amber-600">Se le envió el link para que ingrese el código PSE. Esta pantalla se actualiza automáticamente.</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <div>
                    <p className="text-xs text-emerald-600">Código PSE recibido</p>
                    <p className="text-lg font-bold tracking-widest text-emerald-800">{pseCodigoRecibido}</p>
                  </div>
                </div>
              )}

              {/* Soporte — solo habilitado cuando llegó el código */}
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Documento de soporte *</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  disabled={!pseCodigoRecibido}
                  onChange={(e) => setSoporteFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50 disabled:opacity-40"
                />
                {soporteFile ? (
                  <p className="text-xs text-slate-500">
                    Seleccionado: <span className="font-medium">{soporteFile.name}</span>
                    {" "}({(soporteFile.size / 1024).toFixed(0)} KB)
                  </p>
                ) : null}
              </label>

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
                  type="button"
                  onClick={() => void finalizarPsePago()}
                  disabled={!pseCodigoRecibido || !soporteFile || isUploadingDoc || isSubmitting}
                  className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isUploadingDoc || isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Finalizar pago
                </button>
              </div>
            </div>
          ) : null}

        </div>
      </div>

      {/* Diálogo de confirmación por desviación ±10% (solo flujo no-PSE) */}
      {confirmPending ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 px-4">
          <div className="w-full max-w-sm border border-amber-300 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
              <div>
                <p className="font-semibold text-slate-900">Desviación significativa</p>
                <p className="mt-1 text-sm text-slate-600">
                  El valor ingresado ({formatCOP(confirmPending.valor)}) difiere{" "}
                  <span className="font-semibold text-amber-700">
                    {confirmPct > 0 ? "+" : ""}{confirmPct.toFixed(1)}%
                  </span>{" "}
                  del total de facturas seleccionadas ({formatCOP(sumaFacturas.toString())}).
                  ¿Deseas continuar de todos modos?
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPending(null)}
                className="h-9 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Revisar
              </button>
              <button
                type="button"
                onClick={() => void submitPayload(confirmPending)}
                disabled={isSubmitting}
                className="inline-flex h-9 items-center gap-2 bg-amber-600 px-3 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Confirmar pago
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
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
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaReal"
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

  function handleBeneficiariosChange(id: string, beneficiarios: BeneficiarioSeleccion[]) {
    setFilas((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, editingBeneficiarios: beneficiarios, dirty: true, errorFila: null }
          : f,
      ),
    );
    // Auto-save inmediato al cambiar beneficiarios (cambio discreto, no texto libre)
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
        beneficiarioIds: fila.editingBeneficiarios.map((b) => b.id),
        numSoporte: fila.editingNumSoporte || null,
        valor: valorBig ?? fila.valor,
        canalPago: fila.editingCanal,
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
            editingBeneficiarios: updated.beneficiarios ?? [],
            editingNumSoporte: updated.numSoporte ?? "",
            editingCanal: updated.canalPago,
            editingFechaReal: isoToDateInput(updated.fechaRealPago) || todayInput(),
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
                <th className="border-b border-slate-200 px-3 py-2">Beneficiarios</th>
                <th className="border-b border-slate-200 px-3 py-2">N° soporte</th>
                <th className="border-b border-slate-200 px-3 py-2">Facturas / Vía</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor (COP)</th>
                <th className="border-b border-slate-200 px-3 py-2">Canal de pago</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha de pago</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Saldo corriente</th>
                <th className="border-b border-slate-200 px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-500">
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
                  onBeneficiariosChange={handleBeneficiariosChange}
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
          tramiteConsecutivo={tramite.consecutivo}
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

function estadoMovimientoBadge(estado: EstadoMovimiento) {
  if (estado === "VERIFICADO") {
    return (
      <span className="inline-flex items-center border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
        VERIFICADO
      </span>
    );
  }
  if (estado === "BORRADOR") {
    return (
      <span className="inline-flex items-center border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
        BORRADOR
      </span>
    );
  }
  return null; // REALIZADO — sin badge extra
}

type FilaPagoProps = {
  fila: FilaLibro;
  index: number;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaLibro,
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaReal"
    >,
    value: string,
  ) => void;
  onBeneficiariosChange: (id: string, b: BeneficiarioSeleccion[]) => void;
  onBlur: (id: string) => void;
  onDelete: (id: string) => void;
};

function FilaPago({ fila, index, isDeleting, onChange, onBeneficiariosChange, onBlur, onDelete }: FilaPagoProps) {
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

        {/* Beneficiarios (multi) */}
        <td className="px-3 py-2 min-w-[200px]">
          <BeneficiarioCombobox
            mode="multi"
            value={fila.editingBeneficiarios}
            onChange={(b) => onBeneficiariosChange(fila.id, b)}
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

        {/* Facturas proveedor vinculadas / vía Lucho / estado */}
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {fila.facturasProveedor.map((fp) => (
              <span
                key={fp.facturaId}
                className="inline-flex items-center border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700"
                title={fp.proveedorNombre}
              >
                {fp.numFactura}
              </span>
            ))}
            {fila.viaSocio ? (
              <span className="inline-flex items-center border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                vía Lucho
              </span>
            ) : null}
            {estadoMovimientoBadge(fila.estado)}
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

        {/* Fecha de pago */}
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
          <td colSpan={11} className="px-3 py-1.5 text-xs text-rose-700">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
    </>
  );
}
