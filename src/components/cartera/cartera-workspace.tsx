"use client";

import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  MinusCircle,
  Paperclip,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConciliarLoteModal } from "@/components/cartera/conciliar-lote-modal";
import { ModuleState } from "@/components/layout/module-state";
import {
  OPCIONES_RECAUDO_PAGO,
  type CarteraData,
  type ClienteOption,
  type EstadoMovimiento,
  type FacturaRow,
  type OpcionRecaudoPago,
  type PagoFacturaRow,
  type RegistrarPagoInput,
  type TipoRecaudo,
  type CanalPago,
  CarteraApiError,
  eliminarPago,
  fetchCartera,
  fetchClienteOptions,
  formatCOP,
  formatDate,
  parseBigIntInput,
  registrarAbonoDevolucion,
  solicitarUploadUrlComprobante,
  subirArchivoDirecto,
} from "@/components/cartera/cartera-api";

// ─── Tipos locales ────────────────────────────────────────────────────────────

type LoadState = "idle" | "loading" | "ready" | "error";
type VistaMode = "cliente" | "lm";
type TipoModal = "ABONO" | "DEVOLUCION";

// ─── Helpers visuales ─────────────────────────────────────────────────────────

// Convención del ledger (WS-D): cruce = Σ saldoNeto.
//   cruce > 0 → Galcomex debe (saldo a favor de la parte → devolver)
//   cruce < 0 → la parte debe a Galcomex (pendiente de cobro)
function cruceLabelColor(cruceStr: string): string {
  try {
    const n = BigInt(cruceStr);
    if (n > 0n) return "text-violet-700"; // Galcomex debe (devolver)
    if (n < 0n) return "text-rose-600";   // la parte debe a Galcomex
    return "text-slate-500";
  } catch {
    return "text-slate-500";
  }
}

function cruceLabel(cruceStr: string, quien: "cliente" | "lm"): string {
  try {
    const n = BigInt(cruceStr);
    const absStr = n < 0n ? (-n).toString() : n.toString();
    if (n > 0n) {
      return `Galcomex debe ${formatCOP(absStr)}`;
    }
    if (n < 0n) {
      return `${quien === "cliente" ? "Cliente" : "LM"} debe ${formatCOP(absStr)}`;
    }
    return "A mano";
  } catch {
    return cruceStr;
  }
}

function saldoChip(aFavor: string, aCargo: string): React.ReactNode {
  const favor = BigInt(aFavor);
  const cargo = BigInt(aCargo);
  if (favor > 0n) {
    return (
      <span className="text-emerald-700 font-medium">+{formatCOP(aFavor)}</span>
    );
  }
  if (cargo > 0n) {
    return (
      <span className="text-rose-600 font-medium">-{formatCOP(aCargo)}</span>
    );
  }
  return <span className="text-slate-400">—</span>;
}

/** Chip de estado del ledger para un destino */
function LedgerChip({
  saldoNeto,
  pendienteCobro,
  pendienteDevolucion,
}: {
  saldoNeto: string;
  pendienteCobro: string;
  pendienteDevolucion: string;
}) {
  const sn = BigInt(saldoNeto);
  if (sn === 0n) {
    return (
      <span className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
        Saldada
      </span>
    );
  }
  if (sn < 0n) {
    return (
      <span className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
        Cobrar {formatCOP(pendienteCobro)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700">
      Devolver {formatCOP(pendienteDevolucion)}
    </span>
  );
}

// ─── Modal registrar abono / devolución ──────────────────────────────────────

type RegistrarPagoModalProps = {
  factura: FacturaRow;
  destino: "CLIENTE" | "LM";
  tipo: TipoModal;
  onClose: () => void;
  onRegistrado: () => void;
};

function RegistrarPagoModal({
  factura,
  destino,
  tipo,
  onClose,
  onRegistrado,
}: RegistrarPagoModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [montoRaw, setMontoRaw] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  // Selector combinado: "RECAUDO:BANCOLOMBIA" | "PAGO:TRANSF_BANCOLOMBIA", etc.
  const [opcionSeleccionada, setOpcionSeleccionada] = useState<string>("RECAUDO:BANCOLOMBIA");
  const [verificadoBanco, setVerificadoBanco] = useState(false);

  // Derivar tipoRecaudo / canalPago y costo del selector combinado
  const opcionActual = OPCIONES_RECAUDO_PAGO.find(
    (o) => `${o.grupo}:${o.value}` === opcionSeleccionada,
  ) ?? OPCIONES_RECAUDO_PAGO[0] as OpcionRecaudoPago;

  // Comprobante upload state
  const [archivoComprobante, setArchivoComprobante] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pendienteCobro =
    destino === "CLIENTE"
      ? factura.pendienteCobroCliente
      : factura.pendienteCobroLM;
  const pendienteDevolucion =
    destino === "CLIENTE"
      ? factura.pendienteDevolucionCliente
      : factura.pendienteDevolucionLM;

  const montoValido = parseBigIntInput(montoRaw);
  const montoN = montoValido ? BigInt(montoValido) : 0n;
  const pendienteCobroN = BigInt(pendienteCobro);
  const pendienteDevolucionN = BigInt(pendienteDevolucion);

  // Aviso de sobrepago (abono > pendiente de cobro → generará devolución)
  const esSobrepago =
    tipo === "ABONO" && montoN > 0n && pendienteCobroN > 0n && montoN > pendienteCobroN;
  // Error si devolución excede disponible
  const excedeDev =
    tipo === "DEVOLUCION" && montoN > 0n && montoN > pendienteDevolucionN;

  const consecutivoRef =
    factura.borrador?.tramite.consecutivo ?? factura.numSiigo;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setArchivoComprobante(file);
    setUploadState("idle");
    setUploadError(null);
    setUploadProgress(0);
  }

  async function uploadComprobante(file: File): Promise<string | null> {
    setUploadState("uploading");
    setUploadProgress(0);
    try {
      const { storageKey, uploadUrl } = await solicitarUploadUrlComprobante({
        consecutivo: consecutivoRef,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        fileName: file.name,
      });
      await subirArchivoDirecto(uploadUrl, file, (p) => setUploadProgress(p));
      setUploadState("done");
      setUploadProgress(100);
      return storageKey;
    } catch (err) {
      setUploadState("error");
      const msg = err instanceof CarteraApiError ? err.message : "Error al subir el archivo.";
      setUploadError(msg);
      return null;
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!montoValido) {
      setError("El monto debe ser un número entero mayor a 0.");
      return;
    }

    if (excedeDev) {
      setError(
        `La devolución (${formatCOP(montoValido)}) excede el saldo a favor disponible (${formatCOP(pendienteDevolucion)}).`,
      );
      return;
    }

    // Subir comprobante si hay archivo
    let comprobanteKey: string | null = null;
    if (archivoComprobante) {
      comprobanteKey = await uploadComprobante(archivoComprobante);
      if (comprobanteKey === null) {
        // El error ya está en uploadError
        return;
      }
    }

    // Construir input con tipoRecaudo o canalPago según el grupo seleccionado
    const input: RegistrarPagoInput = {
      destino,
      tipo,
      monto: montoValido,
      fecha: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
      ...(opcionActual.grupo === "RECAUDO"
        ? { tipoRecaudo: opcionActual.value as TipoRecaudo }
        : { canalPago: opcionActual.value as CanalPago }),
      comprobanteKey,
      verificadoBanco,
    };

    setSubmitting(true);
    try {
      await registrarAbonoDevolucion(factura.id, input);
      onRegistrado();
    } catch (caught) {
      setError(
        caught instanceof CarteraApiError
          ? caught.message
          : "Error al registrar el pago.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const titulo = tipo === "ABONO" ? "Registrar abono" : "Registrar devolución";
  const botonLabel = tipo === "ABONO" ? "Registrar abono" : "Registrar devolución";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-lg border border-slate-300 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{titulo}</h2>
            <p className="mt-0.5 text-xs text-slate-500 font-mono">
              {factura.numSiigo}
              {factura.borrador?.tramite.consecutivo
                ? ` · ${factura.borrador.tramite.consecutivo}`
                : ""}
              {" · "}
              {destino === "CLIENTE" ? "Cliente" : "LM"}
            </p>
          </div>
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
          {/* Resumen del pendiente */}
          <div className="grid grid-cols-2 gap-3 border border-slate-100 bg-slate-50 px-3 py-3 text-xs">
            <div>
              <p className="text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                Pendiente de cobro
              </p>
              <p className="font-semibold text-sm text-rose-600">
                {BigInt(pendienteCobro) > 0n ? formatCOP(pendienteCobro) : "—"}
              </p>
            </div>
            <div>
              <p className="text-slate-500 uppercase tracking-wide font-medium mb-0.5">
                Pendiente de devolución
              </p>
              <p className="font-semibold text-sm text-violet-700">
                {BigInt(pendienteDevolucion) > 0n ? formatCOP(pendienteDevolucion) : "—"}
              </p>
            </div>
          </div>

          {/* Monto */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Monto (COP) *
            </span>
            <input
              value={montoRaw}
              onChange={(e) => setMontoRaw(e.target.value)}
              placeholder="1.500.000"
              inputMode="numeric"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
            {montoValido && (
              <p className="text-xs text-slate-500">{formatCOP(montoValido)}</p>
            )}
          </label>

          {/* Aviso sobrepago */}
          {esSobrepago && (
            <div className="flex items-start gap-2 border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              El monto supera el pendiente de cobro ({formatCOP(pendienteCobro)}). Si
              continúas, se generará un saldo a favor de{" "}
              {formatCOP((montoN - pendienteCobroN).toString())} que quedará pendiente
              de devolución.
            </div>
          )}

          {/* Fecha */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Fecha *</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          {/* Tipo de recaudo / pago */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Tipo de recaudo / pago *</span>
            <select
              value={opcionSeleccionada}
              onChange={(e) => setOpcionSeleccionada(e.target.value)}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <optgroup label="Recaudo (entra plata)">
                {OPCIONES_RECAUDO_PAGO.filter((o) => o.grupo === "RECAUDO").map((o) => (
                  <option key={`${o.grupo}:${o.value}`} value={`${o.grupo}:${o.value}`}>
                    {o.label} — ${o.costo.toLocaleString("es-CO")}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Pago (sale plata)">
                {OPCIONES_RECAUDO_PAGO.filter((o) => o.grupo === "PAGO").map((o) => (
                  <option key={`${o.grupo}:${o.value}`} value={`${o.grupo}:${o.value}`}>
                    {o.label} — ${o.costo.toLocaleString("es-CO")}
                  </option>
                ))}
              </optgroup>
            </select>
            {opcionActual && (
              <p className="text-xs text-slate-500">
                Costo bancario:{" "}
                <span className="font-medium text-slate-700">
                  {formatCOP(String(opcionActual.costo))}
                </span>
                {" · "}
                <span className={opcionActual.grupo === "RECAUDO" ? "text-emerald-700" : "text-violet-700"}>
                  {opcionActual.grupo === "RECAUDO" ? "Recaudo (entra plata)" : "Pago (sale plata)"}
                </span>
              </p>
            )}
          </label>

          {/* Comprobante */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700 block">
              Comprobante (opcional)
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                Adjuntar
              </button>
              {archivoComprobante && (
                <span className="text-xs text-slate-600 truncate max-w-[200px]">
                  {archivoComprobante.name}
                </span>
              )}
              {uploadState === "uploading" && (
                <span className="text-xs text-slate-500">{uploadProgress}%</span>
              )}
              {uploadState === "done" && (
                <BadgeCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={handleFileChange}
            />
            {uploadError && (
              <p className="text-xs text-rose-600">{uploadError}</p>
            )}
          </div>

          {/* Verificado banco */}
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={verificadoBanco}
              onChange={(e) => setVerificadoBanco(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-cyan-600"
            />
            Verificado en banco
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
              disabled={submitting || uploadState === "uploading" || excedeDev}
              className={`inline-flex h-10 items-center gap-2 px-4 text-sm font-semibold text-white transition disabled:opacity-60 ${
                tipo === "DEVOLUCION"
                  ? "bg-violet-700 hover:bg-violet-800"
                  : "bg-slate-950 hover:bg-slate-800"
              }`}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {botonLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Lista de pagos expandible ────────────────────────────────────────────────

type PagosListProps = {
  pagos: PagoFacturaRow[];
  destino: "CLIENTE" | "LM";
  facturaId: string;
  onAnulado: () => void;
  onVerificar: (facturaId: string, pagoId: string) => Promise<void>;
};

function PagosList({ pagos, destino, facturaId, onAnulado, onVerificar }: PagosListProps) {
  const [anulando, setAnulando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pagosFiltrados = pagos.filter((p) => p.destino === destino);

  if (pagosFiltrados.length === 0) {
    return (
      <p className="px-4 py-2 text-xs text-slate-400">Sin pagos registrados.</p>
    );
  }

  async function handleAnular(pagoId: string) {
    setError(null);
    setAnulando(pagoId);
    try {
      await eliminarPago(facturaId, pagoId);
      onAnulado();
    } catch (err) {
      setError(err instanceof CarteraApiError ? err.message : "Error al anular el pago.");
    } finally {
      setAnulando(null);
    }
  }

  return (
    <div className="border-t border-slate-100 bg-slate-50/70">
      {error && (
        <div className="flex items-start gap-2 border-b border-rose-100 bg-rose-50 px-4 py-2 text-xs text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-slate-500 uppercase tracking-wide">
            <th className="px-4 py-1.5 font-medium">Fecha</th>
            <th className="px-4 py-1.5 font-medium">Tipo</th>
            <th className="px-4 py-1.5 font-medium text-right">Monto</th>
            <th className="px-4 py-1.5 font-medium">Recaudo / Canal</th>
            <th className="px-4 py-1.5 font-medium text-right">Costo banc.</th>
            <th className="px-4 py-1.5 font-medium">Verificado</th>
            <th className="px-4 py-1.5 font-medium">Comprobante</th>
            <th className="px-4 py-1.5 font-medium">Estado</th>
            <th className="px-4 py-1.5 font-medium text-right">Anular</th>
          </tr>
        </thead>
        <tbody>
          {pagosFiltrados.map((p) => (
            <tr key={p.id} className="border-t border-slate-100">
              <td className="px-4 py-1.5 text-slate-700 whitespace-nowrap">
                {formatDate(p.fecha)}
              </td>
              <td className="px-4 py-1.5 whitespace-nowrap">
                {p.tipo === "ABONO" ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <ArrowDownCircle className="h-3 w-3" aria-hidden="true" />
                    Abono
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-violet-700 font-medium">
                    <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                    Devolución
                  </span>
                )}
              </td>
              <td className="px-4 py-1.5 text-right font-semibold whitespace-nowrap">
                {p.tipo === "ABONO" ? (
                  <span className="text-emerald-700">+{formatCOP(p.monto)}</span>
                ) : (
                  <span className="text-violet-700">-{formatCOP(p.monto)}</span>
                )}
              </td>
              <td className="px-4 py-1.5 text-slate-600 whitespace-nowrap">
                {p.tipoRecaudo ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    {OPCIONES_RECAUDO_PAGO.find((o) => o.grupo === "RECAUDO" && o.value === p.tipoRecaudo)?.label ?? p.tipoRecaudo}
                  </span>
                ) : p.canalPago ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500" aria-hidden="true" />
                    {OPCIONES_RECAUDO_PAGO.find((o) => o.grupo === "PAGO" && o.value === p.canalPago)?.label ?? p.canalPago}
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-1.5 text-right text-slate-600 whitespace-nowrap">
                {BigInt(p.costoBancario) > 0n ? (
                  <span className="text-amber-700 font-medium">{formatCOP(p.costoBancario)}</span>
                ) : (
                  <span className="text-slate-300">$0</span>
                )}
              </td>
              <td className="px-4 py-1.5">
                {p.verificadoBanco ? (
                  <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-1.5">
                {p.comprobanteKey ? (
                  <span className="inline-flex items-center gap-1 text-cyan-700">
                    <Paperclip className="h-3 w-3" aria-hidden="true" />
                    Adjunto
                  </span>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </td>
              <td className="px-4 py-1.5 whitespace-nowrap">
                {p.estado === "VERIFICADO" && (
                  <span className="inline-flex items-center border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                    VERIFICADO
                  </span>
                )}
                {p.estado === "BORRADOR" && (
                  <span className="inline-flex items-center border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                    BORRADOR
                  </span>
                )}
                {p.estado === "REALIZADO" && (
                  <button
                    type="button"
                    onClick={() => void onVerificar(facturaId, p.id)}
                    className="inline-flex h-7 items-center gap-1 border border-cyan-300 bg-cyan-50 px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100"
                    title="Marcar como verificado"
                  >
                    Verificar
                  </button>
                )}
              </td>
              <td className="px-4 py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => void handleAnular(p.id)}
                  disabled={anulando === p.id}
                  className="inline-flex h-6 items-center gap-1 border border-rose-200 bg-white px-2 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                  title="Anular pago"
                >
                  {anulando === p.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  )}
                  Anular
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Fila de factura ──────────────────────────────────────────────────────────

type FilaFacturaProps = {
  factura: FacturaRow;
  vista: VistaMode;
  selected: boolean;
  selectable: boolean;
  onToggleSelect: () => void;
  onRegistrarAbono: (factura: FacturaRow, destino: "CLIENTE" | "LM") => void;
  onRegistrarDevolucion: (factura: FacturaRow, destino: "CLIENTE" | "LM") => void;
  onAnulado: () => void;
  onVerificarPago: (facturaId: string, pagoId: string) => Promise<void>;
};

function FilaFactura({
  factura,
  vista,
  selected,
  selectable,
  onToggleSelect,
  onRegistrarAbono,
  onRegistrarDevolucion,
  onAnulado,
  onVerificarPago,
}: FilaFacturaProps) {
  const [expandido, setExpandido] = useState(false);

  const destino: "CLIENTE" | "LM" = vista === "cliente" ? "CLIENTE" : "LM";

  const saldoNeto = vista === "cliente" ? factura.saldoNetoCliente : factura.saldoNetoLM;
  const pendienteDevolucion =
    vista === "cliente" ? factura.pendienteDevolucionCliente : factura.pendienteDevolucionLM;

  const tieneDev = BigInt(pendienteDevolucion) > 0n;
  const pagosDestino = factura.pagos.filter((p) => p.destino === destino);

  return (
    <>
      <tr
        className={`border-b border-slate-100 last:border-b-0 transition-colors ${
          BigInt(saldoNeto) === 0n
            ? "bg-slate-50/50 text-slate-500"
            : "hover:bg-slate-50"
        }`}
      >
        {/* Checkbox selección batch */}
        <td className="px-3 py-3 whitespace-nowrap">
          <input
            type="checkbox"
            checked={selected}
            disabled={!selectable}
            onChange={onToggleSelect}
            aria-label="Seleccionar trámite"
            className="h-4 w-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-30"
          />
        </td>

        {/* DO */}
        <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
          {factura.borrador?.tramite.consecutivo ?? "—"}
        </td>

        {/* Factura SIIGO */}
        <td className="px-4 py-3 font-mono text-xs text-slate-700 whitespace-nowrap">
          {factura.numSiigo}
        </td>

        {/* Fecha */}
        <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
          {formatDate(factura.fecha)}
        </td>

        {/* Total */}
        <td className="px-4 py-3 text-right text-sm font-semibold text-slate-900 whitespace-nowrap">
          {formatCOP(factura.totalFactura)}
        </td>

        {vista === "cliente" ? (
          <>
            {/* Saldo original cliente */}
            <td className="px-4 py-3 text-right text-sm whitespace-nowrap">
              {saldoChip(factura.saldoAFavorCliente, factura.saldoACargoCliente)}
            </td>
            {/* Estado ledger cliente */}
            <td className="px-4 py-3 whitespace-nowrap">
              <LedgerChip
                saldoNeto={factura.saldoNetoCliente}
                pendienteCobro={factura.pendienteCobroCliente}
                pendienteDevolucion={factura.pendienteDevolucionCliente}
              />
            </td>
          </>
        ) : (
          <>
            {/* Saldo original LM */}
            <td className="px-4 py-3 text-right text-sm whitespace-nowrap">
              {saldoChip(factura.saldoAFavorLM, factura.saldoACargoLM)}
            </td>
            {/* Estado ledger LM */}
            <td className="px-4 py-3 whitespace-nowrap">
              <LedgerChip
                saldoNeto={factura.saldoNetoLM}
                pendienteCobro={factura.pendienteCobroLM}
                pendienteDevolucion={factura.pendienteDevolucionLM}
              />
            </td>
          </>
        )}

        {/* Acciones */}
        <td className="px-4 py-3 text-right whitespace-nowrap">
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onRegistrarAbono(factura, destino)}
              className="inline-flex h-7 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <ArrowDownCircle className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              Abono
            </button>
            {tieneDev && (
              <button
                type="button"
                onClick={() => onRegistrarDevolucion(factura, destino)}
                className="inline-flex h-7 items-center gap-1 border border-violet-300 bg-violet-50 px-2 text-xs font-medium text-violet-700 transition hover:bg-violet-100"
              >
                <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Devolución
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpandido((v) => !v)}
              className={`inline-flex h-7 w-7 items-center justify-center border text-slate-600 transition ${
                expandido ? "border-cyan-600 bg-cyan-50" : "border-slate-300 bg-white hover:bg-slate-50"
              }`}
              title={expandido ? "Ocultar pagos" : "Ver pagos"}
            >
              {pagosDestino.length > 0 ? (
                expandido ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )
              ) : (
                <MinusCircle className="h-3.5 w-3.5 text-slate-300" aria-hidden="true" />
              )}
            </button>
          </div>
        </td>
      </tr>

      {/* Fila expandible de pagos */}
      {expandido && (
        <tr>
          <td colSpan={9} className="p-0">
            <PagosList
              pagos={factura.pagos}
              destino={destino}
              facturaId={factura.id}
              onAnulado={onAnulado}
              onVerificar={onVerificarPago}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Tarjetas de cruce ────────────────────────────────────────────────────────

type CruceTarjetasProps = {
  cruceCliente: string;
  cruceLM: string;
  totalFacturas: number;
};

function CruceTarjetas({
  cruceCliente,
  cruceLM,
  totalFacturas,
}: CruceTarjetasProps) {
  const clienteN = BigInt(cruceCliente);
  const lmN = BigInt(cruceLM);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {/* Cruce cliente */}
      <div className="border border-slate-200 bg-white px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Cruce cliente
        </p>
        <p
          className={`mt-1 text-xl font-bold ${cruceLabelColor(cruceCliente)}`}
        >
          {clienteN === 0n
            ? "A mano"
            : formatCOP(clienteN < 0n ? (-clienteN).toString() : cruceCliente)}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {clienteN > 0n
            ? "Galcomex le debe al cliente"
            : clienteN < 0n
              ? "Cliente le debe a Galcomex"
              : "Sin saldo pendiente"}
        </p>
      </div>

      {/* Cruce LM */}
      <div className="border border-slate-200 bg-white px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Cruce LM
        </p>
        <p className={`mt-1 text-xl font-bold ${cruceLabelColor(cruceLM)}`}>
          {lmN === 0n
            ? "A mano"
            : formatCOP(lmN < 0n ? (-lmN).toString() : cruceLM)}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {lmN > 0n
            ? "Galcomex le debe a LM"
            : lmN < 0n
              ? "LM le debe a Galcomex"
              : "Sin saldo pendiente"}
        </p>
      </div>

      {/* Total facturas */}
      <div className="border border-slate-200 bg-white px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Facturas
        </p>
        <p className="mt-1 text-xl font-bold text-slate-900">{totalFacturas}</p>
        <p className="mt-0.5 text-xs text-slate-500">en el período</p>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function CarteraWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialClienteId = searchParams.get("clienteId") ?? "";
  const initialPendientes = searchParams.get("pendientes") === "true";

  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [clientesLoading, setClientesLoading] = useState(true);
  const [clientesError, setClientesError] = useState<string | null>(null);

  const [clienteId, setClienteId] = useState<string>(initialClienteId);
  const [soloPendientes, setSoloPendientes] = useState(initialPendientes);
  const [desde, setDesde] = useState<string>(searchParams.get("desde") ?? "");
  const [hasta, setHasta] = useState<string>(searchParams.get("hasta") ?? "");
  const [vista, setVista] = useState<VistaMode>("cliente");

  const [cartera, setCartera] = useState<CarteraData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [globalError, setGlobalError] = useState<string | null>(null);

  // Modal state
  type ModalTarget = { factura: FacturaRow; destino: "CLIENTE" | "LM"; tipo: TipoModal };
  const [modalTarget, setModalTarget] = useState<ModalTarget | null>(null);

  // ── Selección batch ──────────────────────────────────────────────────────
  const [selectedFacturas, setSelectedFacturas] = useState<Set<string>>(new Set());
  const [loteModalOpen, setLoteModalOpen] = useState(false);

  const destinoActivo: "CLIENTE" | "LM" = vista === "cliente" ? "CLIENTE" : "LM";

  // Toggle vista: limpia selección porque el destino cambia
  const handleVistaChange = useCallback((next: VistaMode) => {
    setVista((prev) => {
      if (prev !== next) {
        setSelectedFacturas(new Set());
      }
      return next;
    });
  }, []);

  const toggleFactura = useCallback((id: string) => {
    setSelectedFacturas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // ── Cargar clientes ──────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setClientesLoading(true);
      setClientesError(null);
      try {
        const data = await fetchClienteOptions(controller.signal);
        setClientes(data);
        setClientesLoading(false);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setClientesError(
          err instanceof Error ? err.message : "Error al cargar clientes.",
        );
        setClientesLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, []);

  // ── Actualizar URL ───────────────────────────────────────────────────────

  const syncUrl = useCallback(
    (cid: string, pendientes: boolean, d: string, h: string) => {
      const params = new URLSearchParams();
      if (cid) params.set("clienteId", cid);
      params.set("pendientes", String(pendientes));
      if (d) params.set("desde", d);
      if (h) params.set("hasta", h);
      const next =
        params.toString() ? `?${params.toString()}` : window.location.pathname;
      router.replace(next, { scroll: false });
    },
    [router],
  );

  // ── Cargar cartera ───────────────────────────────────────────────────────

  // Trigger manual reload without changing deps
  const [reloadKey, setReloadKey] = useState(0);

  const recargar = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      if (!clienteId) {
        setCartera(null);
        setLoadState("idle");
        return;
      }
      setLoadState("loading");
      setLoadError(null);
      const data = await fetchCartera(
        clienteId,
        soloPendientes,
        desde || undefined,
        hasta || undefined,
        controller.signal,
      );
      setCartera(data);
      setLoadState("ready");
    }

    load().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setLoadError(
        err instanceof CarteraApiError
          ? err.message
          : "Error al cargar la cartera.",
      );
      setLoadState("error");
    });

    return () => controller.abort();
  }, [clienteId, soloPendientes, desde, hasta, reloadKey]);

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleClienteChange(id: string) {
    setClienteId(id);
    syncUrl(id, soloPendientes, desde, hasta);
  }

  function handlePendientesChange(val: boolean) {
    setSoloPendientes(val);
    syncUrl(clienteId, val, desde, hasta);
  }

  function handleDesdeChange(val: string) {
    setDesde(val);
    syncUrl(clienteId, soloPendientes, val, hasta);
  }

  function handleHastaChange(val: string) {
    setHasta(val);
    syncUrl(clienteId, soloPendientes, desde, val);
  }

  function handleLimpiarFechas() {
    setDesde("");
    setHasta("");
    syncUrl(clienteId, soloPendientes, "", "");
  }

  function handlePagoRegistrado() {
    setModalTarget(null);
    setGlobalError(null);
    recargar();
  }

  async function handleVerificarPago(facturaId: string, pagoId: string) {
    setGlobalError(null);
    try {
      const response = await fetch(`/api/facturas/${facturaId}/pagos/${pagoId}/verificar`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ estado: "VERIFICADO" as EstadoMovimiento }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const msg =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as Record<string, unknown>).error === "string"
            ? (payload as Record<string, unknown>).error as string
            : `Error al verificar (${response.status}).`;
        setGlobalError(msg);
        return;
      }
      setCartera((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          facturas: prev.facturas.map((f) => {
            if (f.id !== facturaId) return f;
            return {
              ...f,
              pagos: f.pagos.map((p) =>
                p.id === pagoId ? { ...p, estado: "VERIFICADO" as EstadoMovimiento } : p,
              ),
            };
          }),
        };
      });
    } catch {
      setGlobalError("Error de red al verificar.");
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const facturas = useMemo<FacturaRow[]>(
    () => cartera?.facturas ?? [],
    [cartera],
  );

  // ── Selección batch: helpers derivados ──────────────────────────────────
  const isElegible = useCallback(
    (f: FacturaRow) => {
      const saldo = vista === "cliente" ? f.saldoNetoCliente : f.saldoNetoLM;
      try {
        return BigInt(saldo) !== 0n;
      } catch {
        return false;
      }
    },
    [vista],
  );

  const facturasElegibles = useMemo(
    () => facturas.filter(isElegible),
    [facturas, isElegible],
  );

  const allElegiblesSelected = useMemo(
    () =>
      facturasElegibles.length > 0 &&
      facturasElegibles.every((f) => selectedFacturas.has(f.id)),
    [facturasElegibles, selectedFacturas],
  );

  const pendienteTotalSeleccionado = useMemo(() => {
    let total = 0n;
    for (const f of facturas) {
      if (!selectedFacturas.has(f.id)) continue;
      const saldoStr = vista === "cliente" ? f.saldoNetoCliente : f.saldoNetoLM;
      try {
        const v = BigInt(saldoStr);
        total += v < 0n ? -v : v;
      } catch {
        // ignore
      }
    }
    return total;
  }, [facturas, selectedFacturas, vista]);

  const toggleAll = useCallback(() => {
    setSelectedFacturas((prev) => {
      if (
        facturasElegibles.length > 0 &&
        facturasElegibles.every((f) => prev.has(f.id))
      ) {
        return new Set();
      }
      return new Set(facturasElegibles.map((f) => f.id));
    });
  }, [facturasElegibles]);

  // Poda automática tras recarga: quita de la selección facturas que ya no están en la lista
  useEffect(() => {
    setSelectedFacturas((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(facturas.map((f) => f.id));
      const filtered = new Set(Array.from(prev).filter((id) => ids.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
  }, [facturas]);
  const nombreCliente = clientes.find((c) => c.id === clienteId)?.nombre ?? "";

  return (
    <>
      <section className="space-y-5">
        {/* Encabezado */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Cartera</h1>
            <p className="mt-1 text-sm text-slate-600">
              Relación de facturas, abonos, devoluciones y estados de cuenta por cliente.
            </p>
          </div>

          {/* Estado de cuenta PDF — placeholder A3-T2 */}
          <div className="relative group">
            <button
              type="button"
              disabled
              className="inline-flex h-10 items-center gap-2 border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-400 cursor-not-allowed"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              Estado de cuenta PDF
            </button>
            <div className="absolute right-0 top-full mt-1.5 hidden group-hover:block z-10 w-64 border border-slate-200 bg-slate-950 px-3 py-2 text-xs text-white shadow-lg">
              Disponible en A3-T2 (generación de PDFs)
            </div>
          </div>
        </div>

        {/* Selector de cliente + filtros */}
        <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-4 py-3">
          {/* Selector cliente */}
          <label className="flex flex-col gap-1 min-w-64">
            <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
              Cliente
            </span>
            {clientesError ? (
              <p className="text-xs text-rose-600">{clientesError}</p>
            ) : (
              <select
                value={clienteId}
                onChange={(e) => handleClienteChange(e.target.value)}
                disabled={clientesLoading}
                className="h-10 border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:opacity-60"
              >
                <option value="">
                  {clientesLoading ? "Cargando…" : "Seleccionar cliente"}
                </option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre} — {c.nit}
                  </option>
                ))}
              </select>
            )}
          </label>

          {/* Filtro pendientes */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
              Facturas
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => handlePendientesChange(false)}
                className={`h-10 border px-3 text-xs font-semibold transition ${
                  !soloPendientes
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Todas
              </button>
              <button
                type="button"
                onClick={() => handlePendientesChange(true)}
                className={`h-10 border px-3 text-xs font-semibold transition ${
                  soloPendientes
                    ? "border-amber-600 bg-amber-600 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Solo pendientes
              </button>
            </div>
          </div>

          {/* Filtro por periodo de fechas (fecha de emisión de la factura) */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
              Desde
            </span>
            <input
              type="date"
              value={desde}
              max={hasta || undefined}
              onChange={(e) => handleDesdeChange(e.target.value)}
              className="h-10 border border-slate-300 bg-white px-2 text-xs text-slate-700"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
              Hasta
            </span>
            <input
              type="date"
              value={hasta}
              min={desde || undefined}
              onChange={(e) => handleHastaChange(e.target.value)}
              className="h-10 border border-slate-300 bg-white px-2 text-xs text-slate-700"
            />
          </div>
          {(desde || hasta) && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-transparent uppercase tracking-wide select-none">
                Limpiar
              </span>
              <button
                type="button"
                onClick={handleLimpiarFechas}
                className="h-10 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Limpiar fechas
              </button>
            </div>
          )}

          {/* Vista cliente / LM */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
              Vista
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => handleVistaChange("cliente")}
                className={`h-10 border px-3 text-xs font-semibold transition ${
                  vista === "cliente"
                    ? "border-cyan-700 bg-cyan-700 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                Cliente
              </button>
              <button
                type="button"
                onClick={() => handleVistaChange("lm")}
                className={`h-10 border px-3 text-xs font-semibold transition ${
                  vista === "lm"
                    ? "border-violet-700 bg-violet-700 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                LM
              </button>
            </div>
          </div>

          {/* Refrescar */}
          {clienteId && (
            <button
              type="button"
              onClick={() => recargar()}
              className="ml-auto inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Actualizar
            </button>
          )}
        </div>

        {/* Error global */}
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

        {/* Estado: sin cliente */}
        {loadState === "idle" && !clienteId ? (
          <ModuleState
            type="empty"
            title="Selecciona un cliente"
            detail="Elige un cliente del selector para ver su cartera."
          />
        ) : loadState === "loading" ? (
          <ModuleState type="loading" title="Cargando cartera…" />
        ) : loadState === "error" ? (
          <div className="flex items-start gap-3 border border-dashed border-rose-300 bg-rose-50 px-4 py-5 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">No fue posible cargar la cartera</p>
              {loadError ? <p className="mt-1">{loadError}</p> : null}
            </div>
          </div>
        ) : cartera ? (
          <>
            {/* Tarjetas de cruce */}
            <CruceTarjetas
              cruceCliente={cartera.cruceCliente}
              cruceLM={cartera.cruceLM}
              totalFacturas={cartera.totalFacturas}
            />

            {/* Tabla */}
            {facturas.length === 0 ? (
              <ModuleState
                type="empty"
                title="Sin facturas"
                detail={
                  soloPendientes
                    ? `${nombreCliente || "Este cliente"} no tiene facturas pendientes de pago.`
                    : `${nombreCliente || "Este cliente"} no tiene facturas registradas.`
                }
              />
            ) : (
              <div className="overflow-hidden border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 text-xs">
                  <p className="font-semibold text-slate-900">
                    {nombreCliente ? `${nombreCliente} — ` : ""}
                    {vista === "cliente" ? "Cartera cliente" : "Cartera LM"}
                    {soloPendientes ? " (pendientes)" : ""}
                  </p>
                  <p className="text-slate-500">
                    {facturas.length} factura{facturas.length !== 1 ? "s" : ""}
                  </p>
                </div>

                {/* Bulk actions bar (selección batch) */}
                {selectedFacturas.size > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2.5">
                    <div className="text-xs text-indigo-900">
                      <span className="font-semibold">
                        {selectedFacturas.size}
                      </span>{" "}
                      trámite{selectedFacturas.size !== 1 ? "s" : ""} seleccionado
                      {selectedFacturas.size !== 1 ? "s" : ""} ·{" "}
                      <span className="text-indigo-700">
                        Pendiente total{" "}
                        ({vista === "cliente" ? "cliente" : "LM"}):
                      </span>{" "}
                      <span className="font-semibold">
                        {formatCOP(pendienteTotalSeleccionado.toString())}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedFacturas(new Set())}
                        className="h-8 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        Limpiar selección
                      </button>
                      <button
                        type="button"
                        onClick={() => setLoteModalOpen(true)}
                        className="h-8 border border-indigo-700 bg-indigo-700 px-3 text-xs font-semibold text-white transition hover:bg-indigo-800"
                      >
                        Conciliar {selectedFacturas.size} trámite
                        {selectedFacturas.size !== 1 ? "s" : ""}
                      </button>
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={allElegiblesSelected}
                            disabled={facturasElegibles.length === 0}
                            onChange={toggleAll}
                            aria-label="Seleccionar todos los elegibles"
                            className="h-4 w-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-30"
                          />
                        </th>
                        <th className="border-b border-slate-200 px-4 py-2.5">DO</th>
                        <th className="border-b border-slate-200 px-4 py-2.5">Factura</th>
                        <th className="border-b border-slate-200 px-4 py-2.5">Fecha</th>
                        <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total</th>
                        <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                          {vista === "cliente" ? "Saldo cliente" : "Saldo LM"}
                        </th>
                        <th className="border-b border-slate-200 px-4 py-2.5">Estado</th>
                        <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                          Acciones
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {facturas.map((f) => (
                        <FilaFactura
                          key={f.id}
                          factura={f}
                          vista={vista}
                          selected={selectedFacturas.has(f.id)}
                          selectable={isElegible(f)}
                          onToggleSelect={() => toggleFactura(f.id)}
                          onRegistrarAbono={(factura, destino) =>
                            setModalTarget({ factura, destino, tipo: "ABONO" })
                          }
                          onRegistrarDevolucion={(factura, destino) =>
                            setModalTarget({ factura, destino, tipo: "DEVOLUCION" })
                          }
                          onAnulado={() => recargar()}
                          onVerificarPago={handleVerificarPago}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totales del cruce al pie */}
                <div className="flex flex-wrap gap-6 border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs">
                  <span className="text-slate-500 font-medium">
                    Cruce{" "}
                    <span className="font-semibold text-slate-800">
                      {vista === "cliente" ? "cliente" : "LM"}:
                    </span>{" "}
                    <span
                      className={`font-bold ${cruceLabelColor(
                        vista === "cliente" ? cartera.cruceCliente : cartera.cruceLM,
                      )}`}
                    >
                      {cruceLabel(
                        vista === "cliente" ? cartera.cruceCliente : cartera.cruceLM,
                        vista,
                      )}
                    </span>
                  </span>
                  {/* Total real a LM: saldoNetoLM − costos bancarios (solo en vista LM) */}
                  {vista === "lm" && (() => {
                    const totalRealLM = facturas.reduce(
                      (acc, f) => acc + BigInt(f.totalRealLM),
                      0n,
                    );
                    return (
                      <span className="text-slate-500 font-medium border-l border-slate-300 pl-6">
                        Total real a LM (neto costos bancarios):{" "}
                        <span className={`font-bold ${totalRealLM < 0n ? "text-rose-600" : totalRealLM > 0n ? "text-violet-700" : "text-slate-500"}`}>
                          {totalRealLM === 0n
                            ? "A mano"
                            : formatCOP(totalRealLM < 0n ? (-totalRealLM).toString() : totalRealLM.toString())}
                        </span>
                        {" "}
                        <span className="text-slate-400 font-normal italic">(pendiente confirmar fórmula con Camila)</span>
                      </span>
                    );
                  })()}
                </div>
              </div>
            )}
          </>
        ) : null}
      </section>

      {/* Modal registrar abono / devolución */}
      {modalTarget ? (
        <RegistrarPagoModal
          factura={modalTarget.factura}
          destino={modalTarget.destino}
          tipo={modalTarget.tipo}
          onClose={() => setModalTarget(null)}
          onRegistrado={handlePagoRegistrado}
        />
      ) : null}

      {/* Modal conciliación batch */}
      {loteModalOpen && selectedFacturas.size > 0 ? (
        <ConciliarLoteModal
          facturas={facturas.filter((f) => selectedFacturas.has(f.id))}
          destino={destinoActivo}
          onClose={() => setLoteModalOpen(false)}
          onCompletado={(result) => {
            const okIds = new Set(
              result.results.filter((r) => r.ok).map((r) => r.facturaId),
            );
            setSelectedFacturas((prev) => {
              const next = new Set(
                Array.from(prev).filter((id) => !okIds.has(id)),
              );
              return next;
            });
            setLoteModalOpen(false);
            recargar();
          }}
        />
      ) : null}
    </>
  );
}
