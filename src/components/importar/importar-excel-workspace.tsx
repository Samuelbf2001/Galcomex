"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchClientes, type ClienteRow } from "@/components/clientes/clientes-api";
import {
  type EstadoHoja,
  ImportarApiError,
  importarGrupoEPapis,
  type ResultadoHoja,
  type ResultadoImport,
  validarArchivoImport,
} from "@/components/importar/importar-api";

// ─── Helpers de presentación ────────────────────────────────────────────────

const ESTILO_ESTADO: Record<EstadoHoja, { label: string; clase: string }> = {
  IMPORTADO: {
    label: "Importado",
    clase: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  OMITIDO: { label: "Omitido", clase: "bg-slate-100 text-slate-600 ring-slate-200" },
  YA_EXISTIA: {
    label: "Ya existía",
    clase: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  ERROR: { label: "Error", clase: "bg-rose-50 text-rose-700 ring-rose-200" },
};

function EstadoBadge({ estado }: { estado: EstadoHoja }) {
  const cfg = ESTILO_ESTADO[estado];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cfg.clase}`}
    >
      {cfg.label}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Componente principal ─────────────────────────────────────────────────────

type EstadoEjecucion = "idle" | "preview" | "import";

export function ImportarExcelWorkspace() {
  const [clientes, setClientes] = useState<ClienteRow[]>([]);
  const [cargandoClientes, setCargandoClientes] = useState(true);
  const [clientesError, setClientesError] = useState<string | null>(null);

  const [clienteId, setClienteId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const [ejecutando, setEjecutando] = useState<EstadoEjecucion>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reporte, setReporte] = useState<ResultadoImport | null>(null);
  const [esPreview, setEsPreview] = useState(false);
  const [previewOk, setPreviewOk] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // ─── Carga de clientes ───────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    fetchClientes(controller.signal)
      .then((rows) => {
        setClientes(rows.filter((c) => c.activo !== false));
        setClientesError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setClientesError("No fue posible cargar los clientes.");
      })
      .finally(() => setCargandoClientes(false));
    return () => controller.abort();
  }, []);

  // ─── Selección de archivo ──────────────────────────────────────────────────
  const seleccionarArchivo = useCallback((seleccionado: File | null) => {
    if (!seleccionado) {
      setFile(null);
      setFileError(null);
      return;
    }
    const validacion = validarArchivoImport(seleccionado);
    setFileError(validacion);
    setFile(validacion ? null : seleccionado);
    // Cualquier cambio de insumo invalida una previsualización anterior.
    setPreviewOk(false);
    setConfirmando(false);
    setReporte(null);
  }, []);

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    seleccionarArchivo(e.target.files?.[0] ?? null);
    e.target.value = "";
  }

  function quitarArchivo() {
    seleccionarArchivo(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleClienteChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setClienteId(e.target.value);
    setPreviewOk(false);
    setConfirmando(false);
    setReporte(null);
  }

  // ─── Ejecución ─────────────────────────────────────────────────────────────
  const ejecutar = useCallback(
    async (dryRun: boolean) => {
      if (!file || !clienteId) return;
      setEjecutando(dryRun ? "preview" : "import");
      setError(null);
      try {
        const resultado = await importarGrupoEPapis({ file, clienteId, dryRun });
        setReporte(resultado);
        setEsPreview(dryRun);
        if (dryRun) {
          setPreviewOk(true);
        } else {
          // Tras importar de verdad, vuelve a requerir una nueva previsualización.
          setPreviewOk(false);
        }
      } catch (caught) {
        const msg =
          caught instanceof ImportarApiError
            ? caught.message
            : "Error inesperado durante la importación.";
        setError(msg);
        setReporte(null);
        if (dryRun) setPreviewOk(false);
      } finally {
        setEjecutando("idle");
        setConfirmando(false);
      }
    },
    [file, clienteId],
  );

  const ocupado = ejecutando !== "idle";
  const puedeEjecutar = Boolean(file) && Boolean(clienteId) && !ocupado;

  return (
    <div className="space-y-6">
      {/* ── Formulario de carga ── */}
      <div className="space-y-5 border border-slate-200 bg-white p-5">
        <div className="space-y-2">
          <label
            htmlFor="cliente-import"
            className="block text-sm font-medium text-slate-700"
          >
            Cliente destino
          </label>
          {clientesError ? (
            <p className="text-sm text-rose-600">{clientesError}</p>
          ) : (
            <select
              id="cliente-import"
              value={clienteId}
              onChange={handleClienteChange}
              disabled={cargandoClientes || ocupado}
              className="h-9 w-full max-w-md border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-cyan-600 disabled:bg-slate-100"
            >
              <option value="">
                {cargandoClientes ? "Cargando clientes…" : "Selecciona un cliente"}
              </option>
              {clientes.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.nombre} — {cliente.nit}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-slate-500">
            Los DOs importados se asociarán a este cliente existente.
          </p>
        </div>

        {/* Selector de archivo */}
        <div className="space-y-2">
          <span className="block text-sm font-medium text-slate-700">
            Archivo Excel
          </span>
          {file ? (
            <div className="flex items-center gap-3 border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <FileSpreadsheet
                className="h-5 w-5 shrink-0 text-emerald-600"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900">{file.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
              </div>
              <button
                type="button"
                onClick={quitarArchivo}
                disabled={ocupado}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-slate-400 transition hover:text-slate-700 disabled:opacity-50"
                aria-label="Quitar archivo seleccionado"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={ocupado}
              className="flex w-full max-w-md cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center transition hover:border-slate-400 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UploadCloud className="h-7 w-7 text-slate-400" aria-hidden="true" />
              <span className="text-sm text-slate-600">
                <span className="font-semibold text-slate-900">
                  Selecciona el archivo
                </span>{" "}
                GRUPO E PAPIS 2026
              </span>
              <span className="text-xs text-slate-500">.xlsm o .xls — máx 25 MB</span>
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".xlsm,.xls"
            onChange={handleFileInput}
            className="sr-only"
            aria-hidden="true"
          />
          {fileError && <p className="text-xs text-rose-600">{fileError}</p>}
        </div>

        {/* Acciones */}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => void ejecutar(true)}
            disabled={!puedeEjecutar}
            className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ejecutando === "preview" && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Previsualizar
          </button>

          {confirmando ? (
            <div className="inline-flex items-center gap-2">
              <span className="text-sm text-slate-600">
                ¿Confirmas? Esto escribirá en la base de datos.
              </span>
              <button
                type="button"
                onClick={() => void ejecutar(false)}
                disabled={ocupado}
                className="inline-flex h-9 items-center gap-2 bg-rose-600 px-4 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ejecutando === "import" && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Sí, importar
              </button>
              <button
                type="button"
                onClick={() => setConfirmando(false)}
                disabled={ocupado}
                className="inline-flex h-9 items-center px-3 text-sm font-medium text-slate-500 transition hover:text-slate-700 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmando(true)}
              disabled={!puedeEjecutar || !previewOk}
              title={
                previewOk
                  ? undefined
                  : "Previsualiza primero para habilitar la importación."
              }
              className="inline-flex h-9 items-center gap-2 bg-cyan-600 px-4 text-sm font-medium text-white transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirmar importación
            </button>
          )}

          {ocupado && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-2 text-sm font-medium text-cyan-700"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {ejecutando === "preview"
                ? "Procesando previsualización… leyendo las hojas del Excel"
                : "Importando datos… escribiendo en la base de datos"}
            </span>
          )}
        </div>
      </div>

      {/* ── Banner de progreso (no bloqueante) ── */}
      {ocupado && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-800"
        >
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <div className="space-y-0.5">
            <p className="font-medium">
              {ejecutando === "preview"
                ? "Procesando previsualización…"
                : "Importando datos…"}
            </p>
            <p className="text-xs text-cyan-700">
              Leyendo y validando las hojas del Excel. Esto puede tardar unos
              segundos; puedes seguir trabajando mientras tanto.
            </p>
          </div>
        </div>
      )}

      {/* ── Banner de error ── */}
      {error && (
        <div className="flex items-start gap-3 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{error}</p>
        </div>
      )}

      {/* ── Reporte ── */}
      {reporte && <ReporteImport reporte={reporte} esPreview={esPreview} />}
    </div>
  );
}

// ─── Reporte ──────────────────────────────────────────────────────────────────

function ReporteImport({
  reporte,
  esPreview,
}: {
  reporte: ResultadoImport;
  esPreview: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">
          {esPreview ? "Previsualización" : "Resultado de la importación"}
        </h2>
        {esPreview && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Sin escribir en BD
          </span>
        )}
      </div>

      {/* Tarjeta resumen */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ResumenCard label="Hojas" valor={reporte.totalHojas} clase="text-slate-900" />
        <ResumenCard
          label={esPreview ? "A importar" : "Importadas"}
          valor={reporte.importadas}
          clase="text-emerald-700"
        />
        <ResumenCard label="Omitidas" valor={reporte.omitidas} clase="text-slate-600" />
        <ResumenCard label="Errores" valor={reporte.errores} clase="text-rose-700" />
      </div>

      {/* Tabla por hoja */}
      <div className="overflow-hidden border border-slate-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3 w-8" />
              <th className="border-b border-slate-200 px-4 py-3">Hoja</th>
              <th className="border-b border-slate-200 px-4 py-3">Consecutivo</th>
              <th className="border-b border-slate-200 px-4 py-3">Factura Siigo</th>
              <th className="border-b border-slate-200 px-4 py-3">Estado</th>
              <th className="border-b border-slate-200 px-4 py-3">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {reporte.hojas.map((hoja) => (
              <FilaHoja key={hoja.sheetName || hoja.consecutivo} hoja={hoja} />
            ))}
            {reporte.hojas.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  No se encontraron hojas en el archivo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResumenCard({
  label,
  valor,
  clase,
}: {
  label: string;
  valor: number;
  clase: string;
}) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${clase}`}>{valor}</p>
    </div>
  );
}

function FilaHoja({ hoja }: { hoja: ResultadoHoja }) {
  const [abierta, setAbierta] = useState(false);
  const tieneReconciliacion = hoja.reconciliacion.length > 0;
  const Chevron = abierta ? ChevronDown : ChevronRight;

  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="px-4 py-3 align-top">
          {tieneReconciliacion && (
            <button
              type="button"
              onClick={() => setAbierta((v) => !v)}
              className="inline-flex h-6 w-6 items-center justify-center text-slate-400 transition hover:text-slate-700"
              aria-label={abierta ? "Ocultar reconciliación" : "Ver reconciliación"}
              aria-expanded={abierta}
            >
              <Chevron className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </td>
        <td className="px-4 py-3 align-top font-mono text-xs text-slate-700">
          {hoja.sheetName || "—"}
        </td>
        <td className="px-4 py-3 align-top font-medium text-slate-900">
          {hoja.consecutivo || "—"}
        </td>
        <td className="px-4 py-3 align-top text-slate-700">
          {hoja.numFacturaSiigo ?? "—"}
        </td>
        <td className="px-4 py-3 align-top">
          <div className="flex flex-wrap items-center gap-2">
            <EstadoBadge estado={hoja.estado} />
            {hoja.requirioOverride && (
              <span
                title="El total venía digitado a mano en el Excel y el motor no lo reproduce; se importó el valor del Excel."
                className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200"
              >
                Ajustado al Excel
              </span>
            )}
            {hoja.estado === "IMPORTADO" &&
              !hoja.requirioOverride &&
              (hoja.cuadra ? (
                <CheckCircle2
                  className="h-4 w-4 text-emerald-600"
                  aria-label="Cuadra con el Excel"
                />
              ) : (
                <AlertTriangle
                  className="h-4 w-4 text-rose-500"
                  aria-label="No cuadra con el Excel"
                />
              ))}
          </div>
        </td>
        <td className="px-4 py-3 align-top text-slate-600">
          {hoja.motivo ??
            (tieneReconciliacion ? (
              <button
                type="button"
                onClick={() => setAbierta((v) => !v)}
                aria-expanded={abierta}
                className="font-medium text-cyan-700 underline-offset-2 transition hover:underline"
              >
                {abierta ? "Ocultar reconciliación" : "Ver reconciliación"}
              </button>
            ) : (
              "—"
            ))}
        </td>
      </tr>
      {abierta && tieneReconciliacion && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td />
          <td colSpan={5} className="px-4 py-3">
            <div className="overflow-hidden border border-slate-200 bg-white">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-slate-50 uppercase text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2">Concepto</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">
                      Sistema (motor)
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">
                      Excel
                    </th>
                    <th className="border-b border-slate-200 px-3 py-2 text-center">
                      OK
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hoja.reconciliacion.map((fila, idx) => (
                    <tr key={`${fila.concepto}-${idx}`} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-slate-700">{fila.concepto}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {fila.sistema}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {fila.excel}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {fila.ok ? (
                          <CheckCircle2
                            className="inline h-4 w-4 text-emerald-600"
                            aria-label="Coincide"
                          />
                        ) : (
                          <X
                            className="inline h-4 w-4 text-rose-500"
                            aria-label="No coincide"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
