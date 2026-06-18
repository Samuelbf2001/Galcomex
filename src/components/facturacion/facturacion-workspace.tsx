"use client";

import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  type BorradorRow,
  type EstadoBorrador,
  type TramiteParaFacturacion,
  FacturacionApiError,
  ESTADO_BORRADOR_LABEL,
  descargarSiigoImport,
  estadoBorradorColorClass,
  fetchBorradoresDeTramite,
  fetchTramitesParaFacturacion,
  formatCOP,
  generarBorrador,
  parseBigIntInput,
} from "@/components/facturacion/facturacion-api";
import { RevisorBorrador } from "@/components/facturacion/revisor-borrador";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

type TramiteConBorradores = TramiteParaFacturacion & {
  borradores: BorradorRow[];
  cargandoBorradores: boolean;
};

type FiltroEstado = EstadoBorrador | "TODOS";

// ─── Modal: Generar borrador ──────────────────────────────────────────────────

type GenerarBorradorModalProps = {
  tramite: TramiteParaFacturacion;
  onClose: () => void;
  onGenerado: (borrador: BorradorRow) => void;
};

type ConceptoRow = { id: string; concepto: string; valorRaw: string };

function GenerarBorradorModal({
  tramite,
  onClose,
  onGenerado,
}: GenerarBorradorModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comisionRaw, setComisionRaw] = useState("150000");
  const [montoLMRaw, setMontoLMRaw] = useState("");
  const [retencionesRaw, setRetencionesRaw] = useState("0");
  const [usarConceptos, setUsarConceptos] = useState(false);
  const [conceptos, setConceptos] = useState<ConceptoRow[]>([
    { id: "1", concepto: "", valorRaw: "" },
  ]);

  // Valida que la suma de conceptos = comisión
  function getConceptosError(): string | null {
    if (!usarConceptos) return null;
    const comisionBig = parseBigIntInput(comisionRaw);
    if (!comisionBig) return null;
    let suma = 0n;
    for (const c of conceptos) {
      const v = parseBigIntInput(c.valorRaw);
      if (!v) return "Todos los conceptos deben tener un valor válido.";
      suma += BigInt(v);
    }
    if (suma !== BigInt(comisionBig)) {
      return `La suma de conceptos (${new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(Number(suma))}) debe igualar la comisión (${new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 }).format(Number(BigInt(comisionBig)))}).`;
    }
    return null;
  }

  function addConcepto() {
    setConceptos((prev) => [
      ...prev,
      { id: String(Date.now()), concepto: "", valorRaw: "" },
    ]);
  }

  function removeConcepto(id: string) {
    setConceptos((prev) => prev.filter((c) => c.id !== id));
  }

  function updateConcepto(id: string, field: "concepto" | "valorRaw", value: string) {
    setConceptos((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const comisionBig = parseBigIntInput(comisionRaw);
    if (!comisionBig) {
      setError("La comisión debe ser un número entero mayor o igual a 0.");
      return;
    }

    const conceptosErr = getConceptosError();
    if (conceptosErr) {
      setError(conceptosErr);
      return;
    }

    const montoLMBig = montoLMRaw.trim() ? parseBigIntInput(montoLMRaw) : null;
    const retencionesBig = retencionesRaw.trim() ? parseBigIntInput(retencionesRaw) : null;

    const conceptosPayload =
      usarConceptos && conceptos.length > 0
        ? conceptos
            .filter((c) => c.concepto.trim() && parseBigIntInput(c.valorRaw))
            .map((c) => ({ concepto: c.concepto.trim(), valor: parseBigIntInput(c.valorRaw)! }))
        : undefined;

    setSubmitting(true);
    try {
      const borrador = await generarBorrador(tramite.id, {
        comision: comisionBig,
        montoLM: montoLMBig ?? undefined,
        retenciones: retencionesBig ?? undefined,
        conceptosOperacionales: conceptosPayload,
      });
      onGenerado(borrador);
    } catch (caught) {
      setError(
        caught instanceof FacturacionApiError
          ? caught.message
          : "Error al generar el borrador.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const conceptosErr = getConceptosError();

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-lg border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Generar borrador</h2>
            <p className="mt-0.5 text-xs text-slate-500">{tramite.consecutivo}</p>
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
          <p className="text-sm text-slate-600">
            El sistema calculará automáticamente el 4×1000, IVA, costos bancarios
            y saldos desde los pagos registrados en el trámite.
          </p>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Comisión Galcomex/LM (COP) *
            </span>
            <input
              value={comisionRaw}
              onChange={(e) => setComisionRaw(e.target.value)}
              placeholder="150000"
              inputMode="numeric"
              required
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
            <span className="text-xs text-slate-400">Default: $150.000</span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Monto LM (COP) — opcional
            </span>
            <input
              value={montoLMRaw}
              onChange={(e) => setMontoLMRaw(e.target.value)}
              placeholder="0"
              inputMode="numeric"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
            <span className="text-xs text-slate-400">
              Monto atribuible al socio LM. Dejar vacío si no aplica.
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Retenciones (COP)
            </span>
            <input
              value={retencionesRaw}
              onChange={(e) => setRetencionesRaw(e.target.value)}
              placeholder="0"
              inputMode="numeric"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
            <span className="text-xs text-slate-400">
              RETE IVA + RETE FTE + RETE ICA. Dejar en 0 si no aplica.
            </span>
          </label>

          {/* Desglose de conceptos operacionales */}
          <div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={usarConceptos}
                onChange={(e) => setUsarConceptos(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm font-medium text-slate-700">
                Desglosar conceptos operacionales
              </span>
            </label>
            <p className="mt-0.5 ml-6 text-xs text-slate-400">
              Ej: Revisión documentos + Sistematización + Logística operativa (suma = comisión)
            </p>
          </div>

          {usarConceptos ? (
            <div className="space-y-2 border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-600">Conceptos operacionales</p>
              {conceptos.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <input
                    value={c.concepto}
                    onChange={(e) => updateConcepto(c.id, "concepto", e.target.value)}
                    placeholder="Nombre del concepto"
                    className="h-8 flex-1 border border-slate-300 px-2 text-xs outline-none focus:border-cyan-600"
                  />
                  <input
                    value={c.valorRaw}
                    onChange={(e) => updateConcepto(c.id, "valorRaw", e.target.value)}
                    placeholder="Valor"
                    inputMode="numeric"
                    className="h-8 w-28 border border-slate-300 px-2 text-right text-xs outline-none focus:border-cyan-600"
                  />
                  {conceptos.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeConcepto(c.id)}
                      className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-rose-600"
                      aria-label="Eliminar concepto"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                onClick={addConcepto}
                className="inline-flex h-7 items-center gap-1 border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:bg-slate-100"
              >
                <Plus className="h-3.5 w-3.5" />
                Agregar concepto
              </button>
              {conceptosErr && !error ? (
                <p className="text-xs text-rose-600">
                  <AlertTriangle className="mr-1 inline h-3 w-3" />
                  {conceptosErr}
                </p>
              ) : null}
            </div>
          ) : null}

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
              disabled={submitting || (usarConceptos && Boolean(conceptosErr))}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Generar borrador
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Helpers visuales ─────────────────────────────────────────────────────────

function estadoTramiteColor(estado: string): string {
  const e = estado.toLowerCase();
  if (e.includes("facturado") || e.includes("cerrado") || e.includes("pagado")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (e.includes("facturar")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (e.includes("tramite") || e.includes("puerto") || e.includes("apertura")) {
    return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function ultimoBorrador(borradores: BorradorRow[]): BorradorRow | null {
  if (borradores.length === 0) return null;
  return borradores[0]; // ordenados desc por createdAt
}

// ─── Fila de trámite en la tabla ──────────────────────────────────────────────

type FilaTramiteProps = {
  tramite: TramiteConBorradores;
  onGenerar: () => void;
  onRevisar: (borrador: BorradorRow) => void;
  puedeGenerarBorrador: boolean;
  puedeExportarSiigo: boolean;
};

function FilaTramite({
  tramite,
  onGenerar,
  onRevisar,
  puedeGenerarBorrador,
  puedeExportarSiigo,
}: FilaTramiteProps) {
  const borrador = ultimoBorrador(tramite.borradores);
  // El archivo SIIGO se genera solo desde un borrador ya aprobado/facturado.
  const puedeDescargarSiigo =
    puedeExportarSiigo &&
    borrador != null &&
    (borrador.estado === "APROBADO" || borrador.estado === "FACTURADO");

  return (
    <tr className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors">
      <td className="px-4 py-3">
        <p className="font-mono text-sm font-semibold text-slate-900">
          {tramite.consecutivo}
        </p>
        <p className="text-xs text-slate-500">{tramite.cliente.nombre}</p>
      </td>

      <td className="px-4 py-3">
        <span
          className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${estadoTramiteColor(tramite.estado)}`}
        >
          {tramite.estado.replace(/_/g, " ")}
        </span>
      </td>

      <td className="px-4 py-3">
        {tramite.cargandoBorradores ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
        ) : borrador ? (
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${estadoBorradorColorClass(borrador.estado)}`}
            >
              {ESTADO_BORRADOR_LABEL[borrador.estado]}
            </span>
            {borrador.numFacturaSiigo ? (
              <span className="font-mono text-xs text-slate-600">
                {borrador.numFacturaSiigo}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-slate-400">Sin borrador</span>
        )}
      </td>

      <td className="px-4 py-3 text-right">
        {borrador ? (
          <span className="text-sm font-semibold text-slate-900">
            {formatCOP(borrador.totalFactura)}
          </span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>

      <td className="px-4 py-3 text-right text-sm">
        {borrador ? (
          <div className="flex flex-col items-end gap-0.5">
            {BigInt(borrador.saldoAFavorCliente) > 0n ? (
              <span className="text-emerald-700 font-medium">
                +{formatCOP(borrador.saldoAFavorCliente)} cliente
              </span>
            ) : null}
            {BigInt(borrador.saldoACargoCliente) > 0n ? (
              <span className="text-rose-600 font-medium">
                -{formatCOP(borrador.saldoACargoCliente)} cliente
              </span>
            ) : null}
            {BigInt(borrador.saldoAFavorLM) > 0n ? (
              <span className="text-emerald-600 text-xs">
                +{formatCOP(borrador.saldoAFavorLM)} LM
              </span>
            ) : null}
            {BigInt(borrador.saldoACargoLM) > 0n ? (
              <span className="text-rose-500 text-xs">
                -{formatCOP(borrador.saldoACargoLM)} LM
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>

      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          {borrador ? (
            <button
              type="button"
              onClick={() => onRevisar(borrador)}
              className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
              Revisar
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {puedeDescargarSiigo && borrador ? (
            <button
              type="button"
              onClick={() => descargarSiigoImport(borrador.id)}
              title="Descargar archivo de importación de SIIGO (Excel formato facturas de venta)"
              className="inline-flex h-8 items-center gap-1.5 border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              SIIGO
            </button>
          ) : null}
          {puedeGenerarBorrador ? (
            <button
              type="button"
              onClick={onGenerar}
              className="inline-flex h-8 items-center gap-1.5 bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {borrador ? "Nuevo" : "Generar"} borrador
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

const FILTROS: { value: FiltroEstado; label: string }[] = [
  { value: "TODOS", label: "Todos" },
  { value: "BORRADOR", label: "Borrador" },
  { value: "EN_REVISION", label: "En revisión" },
  { value: "APROBADO", label: "Aprobado" },
  { value: "FACTURADO", label: "Facturado" },
];

export function FacturacionWorkspace() {
  const [tramites, setTramites] = useState<TramiteConBorradores[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filtro, setFiltro] = useState<FiltroEstado>("TODOS");

  // Modal generar borrador
  const [tramiteParaGenerar, setTramiteParaGenerar] =
    useState<TramiteConBorradores | null>(null);

  // Revisión split-screen
  const [revisionState, setRevisionState] = useState<{
    tramite: TramiteConBorradores;
    borrador: BorradorRow;
  } | null>(null);

  // Rol — asumimos que el backend bloquea si no tiene permiso; mostramos el error 403 legible
  // Para el render condicional de botones: leemos el rol desde la sesión
  const [userRol, setUserRol] = useState<string>("OPERATIVO");

  // Cargar rol desde /api/auth/get-session (endpoint real de Better Auth)
  useEffect(() => {
    fetch("/api/auth/get-session", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (
          typeof data === "object" &&
          data !== null &&
          "user" in data &&
          typeof (data as Record<string, unknown>).user === "object" &&
          (data as Record<string, unknown>).user !== null
        ) {
          const user = (data as Record<string, unknown>).user as Record<string, unknown>;
          if (typeof user.rol === "string") {
            setUserRol(user.rol);
          }
        }
      })
      .catch(() => {
        // silencioso — el backend guardará los 403
      });
  }, []);

  const puedeAprobar = userRol === "ADMIN" || userRol === "REVISOR";
  const puedeFacturar = userRol === "ADMIN";
  const puedeGenerarBorrador = userRol === "ADMIN";

  const cargarBorradoresDeTramite = useCallback(
    async (tramiteId: string, signal?: AbortSignal) => {
      try {
        return await fetchBorradoresDeTramite(tramiteId, signal);
      } catch {
        return [];
      }
    },
    [],
  );

  // ── Carga inicial de trámites ──────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      try {
        const rawTramites = await fetchTramitesParaFacturacion(controller.signal);

        // Inicializar con borradores vacíos, marcados como "cargando"
        const iniciales: TramiteConBorradores[] = rawTramites.map((t) => ({
          ...t,
          borradores: [],
          cargandoBorradores: true,
        }));
        setTramites(iniciales);
        setLoadState("ready");

        // Cargar borradores en segundo plano (por lotes para no saturar la API)
        const BATCH = 5;
        for (let i = 0; i < rawTramites.length; i += BATCH) {
          if (controller.signal.aborted) break;
          const batch = rawTramites.slice(i, i + BATCH);
          const results = await Promise.all(
            batch.map((t) => cargarBorradoresDeTramite(t.id, controller.signal)),
          );
          setTramites((prev) =>
            prev.map((t) => {
              const batchIdx = batch.findIndex((b) => b.id === t.id);
              if (batchIdx === -1) return t;
              return {
                ...t,
                borradores: results[batchIdx] ?? [],
                cargandoBorradores: false,
              };
            }),
          );
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(
          caught instanceof Error ? caught.message : "Error al cargar los datos.",
        );
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [reloadKey, cargarBorradoresDeTramite]);

  // ── Filtrado ───────────────────────────────────────────────────────────────

  const tramitesFiltrados = tramites.filter((t) => {
    if (filtro === "TODOS") return true;
    const borrador = ultimoBorrador(t.borradores);
    return borrador?.estado === filtro;
  });

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleBorradorGenerado(tramiteId: string, borrador: BorradorRow) {
    setTramites((prev) =>
      prev.map((t) =>
        t.id === tramiteId
          ? {
              ...t,
              borradores: [borrador, ...t.borradores],
              cargandoBorradores: false,
            }
          : t,
      ),
    );
    setTramiteParaGenerar(null);

    // Abrir inmediatamente el revisor con el nuevo borrador
    const tramite = tramites.find((t) => t.id === tramiteId);
    if (tramite) {
      setRevisionState({ tramite: { ...tramite }, borrador });
    }
  }

  function handleBorradorActualizado(tramiteId: string, borrador: BorradorRow) {
    setTramites((prev) =>
      prev.map((t) => {
        if (t.id !== tramiteId) return t;
        return {
          ...t,
          borradores: t.borradores.map((b) => (b.id === borrador.id ? borrador : b)),
        };
      }),
    );
    // Actualizar en el revisor también
    setRevisionState((prev) =>
      prev && prev.tramite.id === tramiteId ? { ...prev, borrador } : prev,
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <section className="space-y-5">
        {/* Encabezado */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Facturación</h1>
            <p className="mt-1 text-sm text-slate-600">
              Borradores, revisión y número SIIGO.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Refrescar
          </button>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-2">
          {FILTROS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFiltro(f.value)}
              className={`h-8 border px-3 text-xs font-semibold transition ${
                filtro === f.value
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
          {filtro !== "TODOS" ? (
            <span className="self-center text-xs text-slate-500">
              {tramitesFiltrados.length} trámite{tramitesFiltrados.length !== 1 ? "s" : ""}
            </span>
          ) : null}
        </div>

        {/* Estados de carga */}
        {loadState === "loading" ? (
          <ModuleState type="loading" title="Cargando trámites…" />
        ) : loadState === "error" ? (
          <div className="flex items-start gap-3 border border-dashed border-rose-300 bg-rose-50 px-4 py-5 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">No fue posible cargar los trámites</p>
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
        ) : tramitesFiltrados.length === 0 ? (
          <ModuleState
            type="empty"
            title="Sin trámites"
            detail={
              filtro !== "TODOS"
                ? `No hay trámites con borrador en estado "${ESTADO_BORRADOR_LABEL[filtro as EstadoBorrador] ?? filtro}".`
                : "No hay trámites registrados."
            }
          />
        ) : (
          // ── Tabla ────────────────────────────────────────────────────────────
          <div className="overflow-hidden border border-slate-200 bg-white">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-4 py-2">DO / Cliente</th>
                    <th className="border-b border-slate-200 px-4 py-2">Estado DO</th>
                    <th className="border-b border-slate-200 px-4 py-2">Borrador</th>
                    <th className="border-b border-slate-200 px-4 py-2 text-right">
                      Total factura
                    </th>
                    <th className="border-b border-slate-200 px-4 py-2 text-right">
                      Saldos
                    </th>
                    <th className="border-b border-slate-200 px-4 py-2 text-right w-48">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tramitesFiltrados.map((tramite) => (
                    <FilaTramite
                      key={tramite.id}
                      tramite={tramite}
                      puedeGenerarBorrador={puedeGenerarBorrador}
                      puedeExportarSiigo={puedeAprobar}
                      onGenerar={() => setTramiteParaGenerar(tramite)}
                      onRevisar={(borrador) =>
                        setRevisionState({ tramite, borrador })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Modal generar borrador */}
      {tramiteParaGenerar ? (
        <GenerarBorradorModal
          tramite={tramiteParaGenerar}
          onClose={() => setTramiteParaGenerar(null)}
          onGenerado={(borrador) =>
            handleBorradorGenerado(tramiteParaGenerar.id, borrador)
          }
        />
      ) : null}

      {/* Revisión split-screen (ocupa toda la pantalla) */}
      {revisionState ? (
        <RevisorBorrador
          tramite={revisionState.tramite}
          borrador={revisionState.borrador}
          puedeAprobar={puedeAprobar}
          puedeFacturar={puedeFacturar}
          onClose={() => setRevisionState(null)}
          onBorradorActualizado={(borrador) =>
            handleBorradorActualizado(revisionState.tramite.id, borrador)
          }
        />
      ) : null}
    </>
  );
}

