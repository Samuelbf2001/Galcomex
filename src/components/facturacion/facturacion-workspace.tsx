"use client";

import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  type BorradorRow,
  type BorradoresLoteItem,
  type EstadoBorrador,
  type TramiteParaFacturacion,
  ESTADO_BORRADOR_LABEL,
  descargarSiigoImport,
  estadoBorradorColorClass,
  fetchBorradoresDeTramite,
  fetchBorradoresPorLote,
  fetchTramiteParaFacturacion,
  fetchTramitesParaFacturacion,
  formatCOP,
  formatDateTime,
} from "@/components/facturacion/facturacion-api";
import { GenerarBorradorModal } from "@/components/facturacion/generar-borrador-modal";
import { RevisorBorrador } from "@/components/facturacion/revisor-borrador";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useRol } from "@/lib/auth/rol-context";
import { puedeEnviarASiigo } from "@/lib/siigo/estado-envio";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

type TramiteConBorradores = TramiteParaFacturacion & {
  borradores: BorradorRow[];
  cargandoBorradores: boolean;
  /**
   * Mensaje si la carga de borradores de ESTE trámite falló. Mientras exista,
   * la fila no puede asegurar "sin borrador" y no ofrece "Generar borrador"
   * (evita crear un duplicado sobre un falso vacío).
   */
  errorBorradores: string | null;
};

type FiltroEstado = EstadoBorrador | "TODOS";

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

// ─── Alerta: aprobados pendientes de enviar a SIIGO ───────────────────────────

type PendienteEnvioSiigo = {
  tramite: TramiteConBorradores;
  borrador: BorradorRow;
};

/**
 * Borradores APROBADOS que todavía no se enviaron a SIIGO como draft
 * (sin siigoDraftId, y sin envío en curso ni sin confirmar: `puedeEnviarASiigo`).
 * Separa "Aprobar" de "Enviar" en la UI: aprobar solo
 * cambia el estado; el envío a SIIGO es una acción explícita de ADMIN. Esta
 * lista es la alerta para que Camila no olvide enviarlos.
 */
function calcularPendientesEnvioSiigo(
  tramites: TramiteConBorradores[],
): PendienteEnvioSiigo[] {
  const pendientes: PendienteEnvioSiigo[] = [];
  for (const tramite of tramites) {
    const borrador = ultimoBorrador(tramite.borradores);
    if (borrador && borrador.estado === "APROBADO" && puedeEnviarASiigo(borrador)) {
      pendientes.push({ tramite, borrador });
    }
  }
  return pendientes;
}

type AlertaPendientesEnvioProps = {
  pendientes: PendienteEnvioSiigo[];
  onRevisar: (tramite: TramiteConBorradores, borrador: BorradorRow) => void;
};

function AlertaPendientesEnvio({ pendientes, onRevisar }: AlertaPendientesEnvioProps) {
  if (pendientes.length === 0) return null;

  return (
    <div className="border border-amber-300 bg-amber-50">
      <div className="flex items-center gap-2 border-b border-amber-200 px-4 py-2.5">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <p className="text-sm font-semibold text-amber-900">
          {pendientes.length} borrador{pendientes.length !== 1 ? "es" : ""} aprobado
          {pendientes.length !== 1 ? "s" : ""} pendiente{pendientes.length !== 1 ? "s" : ""} de
          enviar a SIIGO
        </p>
      </div>
      <ul className="divide-y divide-amber-200">
        {pendientes.map(({ tramite, borrador }) => (
          <li key={borrador.id}>
            <button
              type="button"
              onClick={() => onRevisar(tramite, borrador)}
              className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition hover:bg-amber-100"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-mono font-semibold text-slate-900">
                  {tramite.consecutivo}
                </span>
                <span className="truncate text-slate-600">{tramite.cliente.nombre}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-semibold text-slate-900">
                  {formatCOP(borrador.totalFactura)}
                </span>
                <span className="text-xs text-amber-700">
                  Aprobado{" "}
                  {borrador.fechaAprobacion ? formatDateTime(borrador.fechaAprobacion) : ""}
                </span>
                <ChevronRight className="h-4 w-4 text-amber-500" aria-hidden="true" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Fila de trámite en la tabla ──────────────────────────────────────────────

type FilaTramiteProps = {
  tramite: TramiteConBorradores;
  onGenerar: () => void;
  onRevisar: (borrador: BorradorRow) => void;
  onReintentarBorradores: () => void;
  puedeGenerarBorrador: boolean;
  puedeExportarSiigo: boolean;
};

function FilaTramite({
  tramite,
  onGenerar,
  onRevisar,
  onReintentarBorradores,
  puedeGenerarBorrador,
  puedeExportarSiigo,
}: FilaTramiteProps) {
  const borrador = ultimoBorrador(tramite.borradores);
  const conError = tramite.errorBorradores !== null && !tramite.cargandoBorradores;
  // El archivo SIIGO se genera solo desde un borrador ya aprobado/facturado.
  const puedeDescargarSiigo =
    puedeExportarSiigo &&
    borrador != null &&
    (borrador.estado === "APROBADO" || borrador.estado === "FACTURADO");

  return (
    <tr className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors">
      <td className="px-4 py-3">
        <p className="font-mono text-sm font-semibold text-slate-900">
          <EnlaceTramite id={tramite.id}>{tramite.consecutivo}</EnlaceTramite>
        </p>
        <p className="text-xs text-slate-500">
          <EnlaceCliente id={tramite.cliente.id}>{tramite.cliente.nombre}</EnlaceCliente>
        </p>
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
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
            Cargando…
          </span>
        ) : conError ? (
          <span
            className="inline-flex flex-wrap items-center gap-1.5 text-xs text-rose-700"
            title={tramite.errorBorradores ?? undefined}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            No se pudo cargar el borrador
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={onReintentarBorradores}
              className="font-semibold underline underline-offset-2 hover:text-rose-900"
            >
              Reintentar
            </button>
          </span>
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
          {/* Sin lectura confirmada (cargando o con error) no se ofrece
              generar: podría duplicar un borrador que sí existe. Un servicio
              suelto (OTRO) que ya tiene borrador tampoco lo ofrece (B-N1):
              el valor/concepto se edita en ese borrador, no generando otro. */}
          {puedeGenerarBorrador &&
          !tramite.cargandoBorradores &&
          !conError &&
          !(tramite.flujoCorto && borrador) ? (
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

  // Rol real desde el primer render (contexto del layout). Cada permiso refleja
  // el `requireRole` del endpoint que dispara la acción:
  //   PATCH /api/borradores/[id] → APROBADO: ADMIN/REVISOR · FACTURADO: ADMIN ·
  //   EN_REVISION: ADMIN/OPERATIVO · POST /api/tramites/[id]/borrador: ADMIN.
  const rol = useRol();
  const puedeAprobar = rol === "ADMIN" || rol === "REVISOR";
  const puedeFacturar = rol === "ADMIN";
  const puedeGenerarBorrador = rol === "ADMIN";
  const puedeEnviarRevision = rol === "ADMIN" || rol === "OPERATIVO";

  /**
   * Carga los borradores de UN trámite y nunca lanza: devuelve el resultado
   * tipado (ok / error) para que la fila distinga "sin borrador" de "no se
   * pudo leer". Es el método de reserva cuando no existe el endpoint por lote
   * y también el que usa "Reintentar" en una fila.
   */
  const cargarBorradoresDeTramite = useCallback(
    async (tramiteId: string, signal?: AbortSignal): Promise<BorradoresLoteItem> => {
      try {
        const borradores = await fetchBorradoresDeTramite(tramiteId, signal);
        return { ok: true, borradores };
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
        return { ok: false, error: describirError(caught, "No se pudo cargar el borrador.") };
      }
    },
    [],
  );

  const aplicarResultado = useCallback(
    (tramiteId: string, resultado: BorradoresLoteItem) => {
      setTramites((prev) =>
        prev.map((t) => {
          if (t.id !== tramiteId) return t;
          return resultado.ok
            ? { ...t, borradores: resultado.borradores, cargandoBorradores: false, errorBorradores: null }
            : { ...t, borradores: [], cargandoBorradores: false, errorBorradores: resultado.error };
        }),
      );
    },
    [],
  );

  const reintentarBorradores = useCallback(
    async (tramiteId: string) => {
      setTramites((prev) =>
        prev.map((t) =>
          t.id === tramiteId ? { ...t, cargandoBorradores: true, errorBorradores: null } : t,
        ),
      );
      const resultado = await cargarBorradoresDeTramite(tramiteId);
      aplicarResultado(tramiteId, resultado);
    },
    [cargarBorradoresDeTramite, aplicarResultado],
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
          errorBorradores: null,
        }));
        setTramites(iniciales);
        setLoadState("ready");

        if (rawTramites.length === 0) return;

        // 1) Una sola llamada con todos los ids (troceada a 100 por el helper).
        //    Si el endpoint aún no está desplegado (404) devuelve null.
        let lote: Map<string, BorradoresLoteItem> | null = null;
        try {
          lote = await fetchBorradoresPorLote(
            rawTramites.map((t) => t.id),
            controller.signal,
          );
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          // Error del lote completo: cada fila queda con error + Reintentar.
          const mensaje = describirError(caught, "No se pudo cargar el borrador.");
          setTramites((prev) =>
            prev.map((t) => ({ ...t, cargandoBorradores: false, errorBorradores: mensaje })),
          );
          return;
        }

        if (lote !== null) {
          if (controller.signal.aborted) return;
          const resultados = lote;
          setTramites((prev) =>
            prev.map((t) => {
              const r = resultados.get(t.id);
              if (!r) {
                return {
                  ...t,
                  cargandoBorradores: false,
                  errorBorradores: "El servidor no devolvió este trámite.",
                };
              }
              return r.ok
                ? { ...t, borradores: r.borradores, cargandoBorradores: false, errorBorradores: null }
                : { ...t, borradores: [], cargandoBorradores: false, errorBorradores: r.error };
            }),
          );
          return;
        }

        // 2) Fallback (endpoint por lote no desplegado): lotes de 5 por trámite.
        const BATCH = 5;
        for (let i = 0; i < rawTramites.length; i += BATCH) {
          if (controller.signal.aborted) break;
          const batch = rawTramites.slice(i, i + BATCH);
          const results = await Promise.all(
            batch.map((t) => cargarBorradoresDeTramite(t.id, controller.signal)),
          );
          if (controller.signal.aborted) break;
          batch.forEach((t, idx) => {
            const r = results[idx];
            if (r) aplicarResultado(t.id, r);
          });
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar los datos."));
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [reloadKey, cargarBorradoresDeTramite, aplicarResultado]);

  // ── Enlace directo: /facturacion?tramiteId=…&borrador=… ────────────────────
  // Viene de EnlaceFacturaVenta (components/ui/enlace-entidad.tsx) y del botón
  // "Ir a Facturación" del trámite. Carga ESE trámite y sus borradores por su
  // cuenta (puede no estar entre los 100 de la tabla) y abre el revisor.
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const tramiteIdUrl = searchParams.get("tramiteId");
  const borradorIdUrl = searchParams.get("borrador");

  useEffect(() => {
    if (!tramiteIdUrl) return;
    const controller = new AbortController();

    async function abrirDesdeUrl(tramiteId: string) {
      try {
        const [tramite, borradores] = await Promise.all([
          fetchTramiteParaFacturacion(tramiteId, controller.signal),
          fetchBorradoresDeTramite(tramiteId, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        const borrador =
          (borradorIdUrl ? borradores.find((b) => b.id === borradorIdUrl) : null) ??
          ultimoBorrador(borradores);
        if (!borrador) {
          toast({
            variant: "info",
            title: `El trámite ${tramite.consecutivo} aún no tiene borrador de factura.`,
          });
          return;
        }
        setRevisionState({
          tramite: {
            ...tramite,
            borradores,
            cargandoBorradores: false,
            errorBorradores: null,
          },
          borrador,
        });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        toast({
          variant: "error",
          title: describirError(caught, "No se pudo abrir la factura."),
        });
      }
    }

    void abrirDesdeUrl(tramiteIdUrl);
    return () => controller.abort();
  }, [tramiteIdUrl, borradorIdUrl, toast]);

  function cerrarRevision() {
    setRevisionState(null);
    // Limpia el enlace directo para que refrescar no reabra el revisor.
    if (tramiteIdUrl) router.replace("/facturacion", { scroll: false });
  }

  // ── Filtrado ───────────────────────────────────────────────────────────────

  const tramitesFiltrados = tramites.filter((t) => {
    if (filtro === "TODOS") return true;
    const borrador = ultimoBorrador(t.borradores);
    return borrador?.estado === filtro;
  });

  // Alerta "Aprobados pendientes de enviar a SIIGO" — independiente del filtro
  // activo, para que Camila (ADMIN) siempre la vea al entrar al módulo.
  const pendientesEnvioSiigo = calcularPendientesEnvioSiigo(tramites);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleBorradorGenerado(tramiteId: string, borrador: BorradorRow) {
    setTramites((prev) =>
      prev.map((t) =>
        t.id === tramiteId
          ? {
              ...t,
              borradores: [borrador, ...t.borradores],
              cargandoBorradores: false,
              errorBorradores: null,
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

        {/* Alerta: aprobados pendientes de enviar a SIIGO — solo ADMIN, que es
            quien puede ejecutar el envío. */}
        {puedeFacturar ? (
          <AlertaPendientesEnvio
            pendientes={pendientesEnvioSiigo}
            onRevisar={(tramite, borrador) => setRevisionState({ tramite, borrador })}
          />
        ) : null}

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
          <TableSkeleton rows={8} cols={6} rowHeight={64} />
        ) : loadState === "error" ? (
          <ModuleState
            type="error"
            title="No fue posible cargar los trámites"
            detail={loadError ?? undefined}
            action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
          />
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
                      onReintentarBorradores={() => void reintentarBorradores(tramite.id)}
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
          puedeEnviarRevision={puedeEnviarRevision}
          onClose={cerrarRevision}
          onBorradorActualizado={(borrador) =>
            handleBorradorActualizado(revisionState.tramite.id, borrador)
          }
        />
      ) : null}
    </>
  );
}

