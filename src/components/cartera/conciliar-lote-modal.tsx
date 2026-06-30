"use client";

import { Loader2, Paperclip, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  CarteraApiError,
  conciliarLote,
  formatCOP,
  OPCIONES_RECAUDO_PAGO,
  solicitarUploadUrlComprobante,
  subirArchivoDirecto,
  type CanalPago,
  type ConciliarLoteItemInput,
  type ConciliarLoteItemResultUi,
  type ConciliarLoteResponse,
  type FacturaRow,
  type TipoRecaudo,
} from "./cartera-api";

export type ConciliarLoteModalProps = {
  facturas: FacturaRow[];
  destino: "CLIENTE" | "LM";
  onClose: () => void;
  onCompletado: (result: ConciliarLoteResponse) => void;
};

// ─── Derivaciones por trámite ────────────────────────────────────────────────

type FilaDerivada = {
  facturaId: string;
  consecutivo: string;
  numSiigo: string;
  saldoNeto: bigint;         // signed
  monto: bigint;             // |saldoNeto|
  tipo: "ABONO" | "DEVOLUCION" | null; // null si saldoNeto = 0
  resultado: ConciliarLoteItemResultUi | null;
};

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function filaDesdeFactura(
  f: FacturaRow,
  destino: "CLIENTE" | "LM",
): FilaDerivada {
  const saldoNeto = safeBigInt(
    destino === "CLIENTE" ? f.saldoNetoCliente : f.saldoNetoLM,
  );
  const monto = saldoNeto < 0n ? -saldoNeto : saldoNeto;
  const tipo: "ABONO" | "DEVOLUCION" | null =
    saldoNeto === 0n ? null : saldoNeto < 0n ? "ABONO" : "DEVOLUCION";

  return {
    facturaId: f.id,
    consecutivo: f.borrador?.tramite.consecutivo ?? "—",
    numSiigo: f.numSiigo,
    saldoNeto,
    monto,
    tipo,
    resultado: null,
  };
}

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type UploadState = "idle" | "uploading" | "done" | "error";

// ─── Componente ──────────────────────────────────────────────────────────────

export function ConciliarLoteModal({
  facturas,
  destino,
  onClose,
  onCompletado,
}: ConciliarLoteModalProps) {
  const [filas, setFilas] = useState<FilaDerivada[]>(() =>
    facturas.map((f) => filaDesdeFactura(f, destino)),
  );

  // Formulario único del lote
  const [fecha, setFecha] = useState<string>(todayISO);
  const [opcionRecaudoPago, setOpcionRecaudoPago] = useState<string>(
    "RECAUDO:BANCOLOMBIA",
  );
  const [verificadoBanco, setVerificadoBanco] = useState<boolean>(false);

  // Comprobante único del lote
  const [archivo, setArchivo] = useState<File | null>(null);
  const [comprobanteKey, setComprobanteKey] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [resumen, setResumen] = useState<ConciliarLoteResponse | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Derivados
  const filasActivas = useMemo(
    () => filas.filter((f) => f.tipo !== null),
    [filas],
  );

  // Suma algebraica (signed) del grupo. Esto es el monto neto que
  // efectivamente cambia de manos en el pago único: si Galcomex debe 5M
  // y el cliente debe 4M, neto = 1M a favor del cliente.
  const saldoNetoGrupo = useMemo(
    () => filas.reduce((acc, f) => acc + f.saldoNeto, 0n),
    [filas],
  );

  const direccionNeto: "DEVOLUCION" | "ABONO" | null = useMemo(() => {
    if (saldoNetoGrupo > 0n) return "DEVOLUCION";
    if (saldoNetoGrupo < 0n) return "ABONO";
    return null;
  }, [saldoNetoGrupo]);

  // Monto absoluto que efectivamente cambia de manos.
  const totalNetoConsolidado = useMemo(
    () => (saldoNetoGrupo < 0n ? -saldoNetoGrupo : saldoNetoGrupo),
    [saldoNetoGrupo],
  );

  const validationError = useMemo<string | null>(() => {
    if (filasActivas.length === 0) {
      return "Todos los trámites seleccionados ya están conciliados (saldo neto = 0).";
    }
    if (!fecha) return "Fecha requerida.";
    if (!opcionRecaudoPago) return "Selecciona canal o recaudo.";
    if (uploadState === "uploading") return "Esperando que termine la subida del comprobante.";
    if (uploadState === "error") return "Error al subir el comprobante.";
    return null;
  }, [filasActivas, fecha, opcionRecaudoPago, uploadState]);

  const submitDisabled = submitting || validationError !== null;

  // ── Upload del comprobante único ────────────────────────────────────────

  const handleArchivoChange = useCallback(
    async (file: File | null) => {
      if (!file) {
        setArchivo(null);
        setComprobanteKey(null);
        setUploadState("idle");
        setUploadProgress(0);
        setUploadError(null);
        return;
      }

      setArchivo(file);
      setComprobanteKey(null);
      setUploadState("uploading");
      setUploadProgress(0);
      setUploadError(null);

      // Para el comprobante de lote usamos el primer consecutivo como
      // namespace; aplica a todas las facturas del lote.
      const consecutivoRef = filas[0]?.consecutivo ?? "LOTE";

      try {
        const { storageKey, uploadUrl } = await solicitarUploadUrlComprobante({
          consecutivo: consecutivoRef,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          fileName: file.name,
        });

        await subirArchivoDirecto(uploadUrl, file, (p) => {
          setUploadProgress(p);
        });

        setComprobanteKey(storageKey);
        setUploadState("done");
        setUploadProgress(100);
      } catch (err) {
        const msg =
          err instanceof CarteraApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Error subiendo archivo";
        setUploadError(msg);
        setUploadState("error");
      }
    },
    [filas],
  );

  // ── Submit ───────────────────────────────────────────────────────────────

  async function handleSubmit() {
    setGlobalError(null);
    setSubmitting(true);

    try {
      const [grupo, value] = opcionRecaudoPago.split(":");
      const isRecaudo = grupo === "RECAUDO";

      const payload: ConciliarLoteItemInput[] = filasActivas.map((fila) => ({
        facturaId: fila.facturaId,
        destino,
        tipo: fila.tipo as "ABONO" | "DEVOLUCION",
        monto: fila.monto.toString(),
        fecha,
        tipoRecaudo: isRecaudo ? (value as TipoRecaudo) : undefined,
        canalPago: !isRecaudo ? (value as CanalPago) : undefined,
        comprobanteKey,
        verificadoBanco,
      }));

      const result = await conciliarLote(payload);

      setFilas((prev) =>
        prev.map((fila) => ({
          ...fila,
          resultado:
            result.results.find(
              (r) => r.facturaId === fila.facturaId && r.destino === destino,
            ) ?? null,
        })),
      );
      setResumen(result);
    } catch (err) {
      const msg =
        err instanceof CarteraApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Error inesperado";
      setGlobalError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  const tituloCorto = `${facturas.length} trámite${facturas.length !== 1 ? "s" : ""} · Destino: ${destino === "CLIENTE" ? "Cliente" : "LM"}`;

  // Banner del saldo consolidado — el monto destacado es el NETO algebraico
  // del grupo (lo que efectivamente cambia de manos).
  const saldoMontoStr = formatCOP(totalNetoConsolidado.toString());

  const partyDestinoLabel = destino === "CLIENTE" ? "cliente" : "socio LM";
  const partyDestinoLabelCap = destino === "CLIENTE" ? "Cliente" : "Socio LM";

  let direccionLabel: string;
  let direccionDetalle: string;
  let bannerBgClass: string;
  let bannerBorderClass: string;
  let bannerAccentClass: string;
  let bannerMontoClass: string;

  if (direccionNeto === "DEVOLUCION") {
    direccionLabel = "Galcomex paga";
    direccionDetalle = `al ${partyDestinoLabel} (neto a favor)`;
    bannerBgClass = "bg-violet-50";
    bannerBorderClass = "border-violet-200";
    bannerAccentClass = "text-violet-700";
    bannerMontoClass = "text-violet-900";
  } else if (direccionNeto === "ABONO") {
    direccionLabel = `${partyDestinoLabelCap} paga`;
    direccionDetalle = "a Galcomex (neto a cargo)";
    bannerBgClass = "bg-rose-50";
    bannerBorderClass = "border-rose-200";
    bannerAccentClass = "text-rose-700";
    bannerMontoClass = "text-rose-900";
  } else {
    direccionLabel = "A mano";
    direccionDetalle = "(saldos opuestos se cancelan)";
    bannerBgClass = "bg-slate-50";
    bannerBorderClass = "border-slate-200";
    bannerAccentClass = "text-slate-600";
    bannerMontoClass = "text-slate-700";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden bg-white shadow-xl">
        {/* Mini-header con título y cerrar */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Conciliar lote
            </h2>
            <span className="text-[11px] text-slate-500">· {tituloCorto}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-7 w-7 items-center justify-center text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Banner protagonista del saldo consolidado */}
        {resumen ? (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Resultado del lote
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums text-emerald-700">
                ✓ {resumen.ok}
              </span>
              <span className="text-sm text-slate-500">exitosos</span>
              {resumen.failed > 0 ? (
                <>
                  <span className="text-2xl font-bold tabular-nums text-rose-700">
                    ✗ {resumen.failed}
                  </span>
                  <span className="text-sm text-slate-500">fallidos</span>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            className={`border-b ${bannerBorderClass} ${bannerBgClass} px-6 py-5`}
          >
            <div
              className={`text-[11px] font-semibold uppercase tracking-wide ${bannerAccentClass}`}
            >
              {direccionLabel}{" "}
              <span className="text-slate-500">{direccionDetalle}</span>
            </div>
            <div
              className={`mt-1 font-bold tabular-nums leading-none ${bannerMontoClass} text-4xl sm:text-5xl`}
            >
              {saldoMontoStr}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              Neto consolidado de {filasActivas.length} trámite
              {filasActivas.length !== 1 ? "s" : ""} · saldos opuestos se
              compensan
            </div>
          </div>
        )}

        {globalError ? (
          <div className="border-b border-rose-200 bg-rose-50 px-5 py-2 text-xs text-rose-800">
            {globalError}
          </div>
        ) : null}

        {/* Formulario único del lote */}
        <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[10px] font-semibold uppercase text-slate-500">
                Fecha del pago
              </span>
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                disabled={!!resumen}
                className="h-8 border border-slate-300 px-2 text-xs focus:border-cyan-600 focus:outline-none disabled:bg-slate-100"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[10px] font-semibold uppercase text-slate-500">
                Canal / recaudo
              </span>
              <select
                value={opcionRecaudoPago}
                onChange={(e) => setOpcionRecaudoPago(e.target.value)}
                disabled={!!resumen}
                className="h-8 border border-slate-300 px-1 text-xs focus:border-cyan-600 focus:outline-none disabled:bg-slate-100"
              >
                <optgroup label="Recaudo (entra plata)">
                  {OPCIONES_RECAUDO_PAGO.filter(
                    (o) => o.grupo === "RECAUDO",
                  ).map((o) => (
                    <option
                      key={`R:${o.value}`}
                      value={`RECAUDO:${o.value}`}
                    >
                      {o.label} · {o.costo > 0 ? `$${o.costo}` : "$0"}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Pago (sale plata)">
                  {OPCIONES_RECAUDO_PAGO.filter((o) => o.grupo === "PAGO").map(
                    (o) => (
                      <option key={`P:${o.value}`} value={`PAGO:${o.value}`}>
                        {o.label} · {o.costo > 0 ? `$${o.costo}` : "$0"}
                      </option>
                    ),
                  )}
                </optgroup>
              </select>
            </label>

            <div className="flex flex-col gap-1 text-xs">
              <span className="text-[10px] font-semibold uppercase text-slate-500">
                Comprobante (opcional)
              </span>
              <label className="inline-flex h-8 cursor-pointer items-center gap-1 border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50">
                <Paperclip className="h-3 w-3" aria-hidden="true" />
                <span>{archivo ? "Reemplazar" : "Adjuntar"}</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  disabled={!!resumen || uploadState === "uploading"}
                  onChange={(e) =>
                    handleArchivoChange(e.target.files?.[0] ?? null)
                  }
                  className="sr-only"
                />
              </label>
              {archivo ? (
                <div className="text-[10px]">
                  {uploadState === "uploading" ? (
                    <span className="inline-flex items-center gap-1 text-slate-600">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {uploadProgress}%
                    </span>
                  ) : uploadState === "done" ? (
                    <span className="text-emerald-700">
                      ✓ {archivo.name}
                    </span>
                  ) : uploadState === "error" ? (
                    <span className="text-rose-700">
                      ✗ {uploadError ?? "error"}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <label className="flex items-end gap-2 text-xs">
              <input
                type="checkbox"
                checked={verificadoBanco}
                onChange={(e) => setVerificadoBanco(e.target.checked)}
                disabled={!!resumen}
                className="h-4 w-4 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <span className="text-slate-700">Verificado en banco</span>
            </label>
          </div>
        </div>

        {/* Tabla de trámites (read-only) */}
        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">Trámite</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">
                  Saldo neto
                </th>
                <th className="border-b border-slate-200 px-3 py-2">Tipo</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">
                  Monto a aplicar
                </th>
                {resumen ? (
                  <th className="border-b border-slate-200 px-3 py-2">
                    Resultado
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {filas.map((fila) => {
                const tipoChipClass =
                  fila.tipo === "ABONO"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : fila.tipo === "DEVOLUCION"
                      ? "bg-violet-50 text-violet-700 border-violet-200"
                      : "bg-slate-50 text-slate-500 border-slate-200";

                const saldoColor =
                  fila.saldoNeto > 0n
                    ? "text-violet-700"
                    : fila.saldoNeto < 0n
                      ? "text-rose-700"
                      : "text-slate-400";

                return (
                  <tr
                    key={fila.facturaId}
                    className="border-b border-slate-100 align-top last:border-b-0"
                  >
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs font-semibold text-slate-800">
                        {fila.consecutivo}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">
                        SIIGO {fila.numSiigo}
                      </div>
                    </td>

                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={`font-semibold ${saldoColor}`}>
                        {formatCOP(fila.monto.toString())}
                      </span>
                    </td>

                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex h-5 items-center border px-1.5 text-[10px] font-semibold ${tipoChipClass}`}
                      >
                        {fila.tipo ?? "SIN SALDO"}
                      </span>
                    </td>

                    <td className="px-3 py-2 text-right whitespace-nowrap font-mono text-xs">
                      {fila.tipo ? formatCOP(fila.monto.toString()) : "—"}
                    </td>

                    {resumen ? (
                      <td className="px-3 py-2">
                        {fila.resultado ? (
                          fila.resultado.ok ? (
                            <span className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              OK · saldo {formatCOP(fila.resultado.saldoNeto)}
                            </span>
                          ) : (
                            <span
                              title={fila.resultado.error}
                              className="inline-flex items-center gap-1 border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700"
                            >
                              {fila.resultado.status}:{" "}
                              {fila.resultado.error.slice(0, 60)}
                              {fila.resultado.error.length > 60 ? "…" : ""}
                            </span>
                          )
                        ) : fila.tipo === null ? (
                          <span className="text-[10px] text-slate-400">
                            omitido
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-400">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
            {filasActivas.length > 0 ? (
              <tfoot>
                <tr className="bg-slate-50 text-[11px] font-semibold text-slate-700">
                  <td className="px-3 py-2" colSpan={3}>
                    Neto a transferir
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono ${
                      direccionNeto === "DEVOLUCION"
                        ? "text-violet-700"
                        : direccionNeto === "ABONO"
                          ? "text-rose-700"
                          : "text-slate-600"
                    }`}
                  >
                    {formatCOP(totalNetoConsolidado.toString())}
                  </td>
                  {resumen ? <td /> : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>

        {/* Validation banner */}
        {!resumen && validationError ? (
          <div className="border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            {validationError}
          </div>
        ) : null}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-xs text-slate-600">
            {resumen ? (
              <>
                <span className="font-semibold">{resumen.total}</span> ítems
                procesados ·{" "}
                <span className="text-emerald-700">{resumen.ok} ok</span> ·{" "}
                <span className={resumen.failed > 0 ? "text-rose-700" : ""}>
                  {resumen.failed} con error
                </span>
              </>
            ) : (
              <>
                {filasActivas.length} trámite
                {filasActivas.length !== 1 ? "s" : ""} se compensan en un solo
                pago
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {resumen ? (
              <button
                type="button"
                onClick={() => onCompletado(resumen)}
                className="h-9 border border-indigo-700 bg-indigo-700 px-4 text-xs font-semibold text-white transition hover:bg-indigo-800"
              >
                Cerrar y recargar
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="h-9 border border-slate-300 bg-white px-4 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitDisabled}
                  className="inline-flex h-9 items-center gap-2 border border-indigo-700 bg-indigo-700 px-4 text-xs font-semibold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Registrando…
                    </>
                  ) : (
                    `Registrar pago (${filasActivas.length})`
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
