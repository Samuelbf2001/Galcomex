"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  type BorradorRow,
  type EstadoBorrador,
  type LineaRevisionRow,
  type TramiteParaFacturacion,
  FacturacionApiError,
  ESTADO_BORRADOR_LABEL,
  descargarSiigoImport,
  estadoBorradorColorClass,
  formatCOP,
  formatDate,
  transicionarBorrador,
} from "@/components/facturacion/facturacion-api";
import {
  type FacturaProveedorRow,
  fetchFacturasProveedor,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

// ─── Tipos locales ────────────────────────────────────────────────────────────

type LineaEstado = "pendiente" | "aprobada" | "observada";

type LineaLocal = LineaRevisionRow & {
  estadoLocal: LineaEstado;
};

// ─── Modal: Marcar facturado ──────────────────────────────────────────────────

type FacturarModalProps = {
  borradorId: string;
  onClose: () => void;
  onFacturado: (borrador: BorradorRow) => void;
};

function FacturarModal({ borradorId, onClose, onFacturado }: FacturarModalProps) {
  const [numSiigo, setNumSiigo] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const numTrim = numSiigo.trim();
    if (!numTrim) {
      setError("El número de factura SIIGO es obligatorio.");
      return;
    }
    if (!fecha) {
      setError("La fecha es obligatoria.");
      return;
    }

    setSubmitting(true);
    try {
      const updated = await transicionarBorrador(borradorId, {
        nuevoEstado: "FACTURADO",
        numFacturaSiigo: numTrim,
        fechaFactura: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
      });
      onFacturado(updated);
    } catch (caught) {
      setError(
        caught instanceof FacturacionApiError
          ? caught.message
          : "Error al marcar como facturado.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-md border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Marcar como facturado</h2>
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
            <span className="text-sm font-medium text-slate-700">
              Número de factura SIIGO *
            </span>
            <input
              value={numSiigo}
              onChange={(e) => setNumSiigo(e.target.value)}
              placeholder="Ej. BAQ-18288"
              required
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Fecha de factura *</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
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
              disabled={submitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Confirmar factura
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Panel izquierdo: visor de soporte ────────────────────────────────────────

type VisorSoporteProps = {
  linea: LineaLocal | null;
  /** Map numFactura → FacturaProveedorRow (para cruzar soporte con documentoId) */
  facturasByNumFactura: Map<string, FacturaProveedorRow>;
  /** Map id → FacturaProveedorRow (para resolver el pivot facturasVinculadas) */
  facturasById: Map<string, FacturaProveedorRow>;
  /** URL de descarga precargada por documentoId */
  downloadUrlByDocId: Map<string, string>;
};

function VisorSoporte({ linea, facturasByNumFactura, facturasById, downloadUrlByDocId }: VisorSoporteProps) {
  if (!linea) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 bg-slate-50 text-slate-400">
        <FileText className="h-10 w-10" aria-hidden="true" />
        <p className="text-sm">Selecciona una línea para ver su soporte</p>
      </div>
    );
  }

  // Intentar cruzar numSoporte con numFactura de proveedor para encontrar documentoId
  const facturaVinculada =
    // Preferir el vínculo real del pivot (facturasVinculadas); si no hay, caer al
    // cruce histórico por string numSoporte == numFactura (líneas AUTO legacy).
    linea.facturasVinculadas.length > 0
      ? facturasById.get(linea.facturasVinculadas[0])
      : linea.numSoporte
        ? facturasByNumFactura.get(linea.numSoporte)
        : undefined;
  const docUrl =
    facturaVinculada?.documentoId
      ? downloadUrlByDocId.get(facturaVinculada.documentoId)
      : undefined;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <div className="border border-slate-200 bg-white p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Concepto</p>
        <p className="mt-1 text-sm font-semibold text-slate-900">{linea.concepto}</p>
      </div>

      {linea.numSoporte ? (
        <div className="border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            N° soporte
          </p>
          <p className="mt-1 text-base font-bold font-mono text-slate-900">
            {linea.numSoporte}
          </p>
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Valor</p>
        <p className="mt-1 text-lg font-bold text-slate-900">{formatCOP(linea.valor)}</p>
      </div>

      {/* Visor/enlace de documento adjunto de factura de proveedor */}
      {facturaVinculada ? (
        <div className="border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Factura de proveedor — {facturaVinculada.proveedorNombre}
          </p>
          {docUrl ? (
            <a
              href={docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-2 border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-medium text-cyan-700 transition hover:bg-cyan-100"
            >
              <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
              Ver documento adjunto
            </a>
          ) : (
            <p className="mt-1 text-xs text-slate-400">
              Factura vinculada, sin documento adjunto.
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 border border-dashed border-slate-300 bg-slate-50 text-slate-400">
          <FileText className="h-8 w-8" aria-hidden="true" />
          <p className="text-xs text-center leading-relaxed px-4">
            {linea.numSoporte
              ? "Sin factura de proveedor vinculada a este soporte"
              : "Sin soporte registrado"}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Componente principal: RevisorBorrador ────────────────────────────────────

type RevisorBorradorProps = {
  tramite: TramiteParaFacturacion;
  borrador: BorradorRow;
  onClose: () => void;
  onBorradorActualizado: (borrador: BorradorRow) => void;
  /** Rol del usuario: ADMIN o REVISOR pueden aprobar; OPERATIVO no */
  puedeAprobar: boolean;
  /** Solo ADMIN puede marcar como facturado */
  puedeFacturar: boolean;
};

export function RevisorBorrador({
  tramite,
  borrador,
  onClose,
  onBorradorActualizado,
  puedeAprobar,
  puedeFacturar,
}: RevisorBorradorProps) {
  const [borradorActual, setBorradorActual] = useState<BorradorRow>(borrador);
  const [lineas, setLineas] = useState<LineaLocal[]>(
    borrador.lineasRevision.map((l) => ({ ...l, estadoLocal: "pendiente" })),
  );
  const [lineaSeleccionada, setLineaSeleccionada] = useState<LineaLocal | null>(
    borrador.lineasRevision.length > 0
      ? { ...borrador.lineasRevision[0], estadoLocal: "pendiente" }
      : null,
  );
  const [transicionando, setTransicionando] = useState(false);
  const [errorTransicion, setErrorTransicion] = useState<string | null>(null);
  const [modalFacturar, setModalFacturar] = useState(false);

  // Facturas de proveedor: indexadas por numFactura para cruzar con numSoporte
  const [facturasByNumFactura, setFacturasByNumFactura] = useState<
    Map<string, FacturaProveedorRow>
  >(new Map());
  // Indexadas por id para resolver el vínculo real del pivot (facturasVinculadas)
  const [facturasById, setFacturasById] = useState<Map<string, FacturaProveedorRow>>(
    new Map(),
  );
  // URL de descarga pre-cargada por documentoId
  const [downloadUrlByDocId, setDownloadUrlByDocId] = useState<Map<string, string>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    async function loadFacturasYDocs() {
      try {
        const facturas = await fetchFacturasProveedor(tramite.id);
        if (cancelled) return;

        const byNum = new Map<string, FacturaProveedorRow>();
        const byId = new Map<string, FacturaProveedorRow>();
        for (const f of facturas) {
          byNum.set(f.numFactura, f);
          byId.set(f.id, f);
        }
        setFacturasByNumFactura(byNum);
        setFacturasById(byId);

        // Precargar URLs de download para facturas con documentoId
        const docIds = facturas
          .filter((f) => f.documentoId !== null)
          .map((f) => f.documentoId as string);

        if (docIds.length > 0) {
          try {
            const resp = await fetch(
              `/api/tramites/${tramite.id}/documentos`,
              { cache: "no-store", headers: { Accept: "application/json" } },
            );
            if (!resp.ok || cancelled) return;
            const payload: unknown = await resp.json();
            if (
              cancelled ||
              typeof payload !== "object" ||
              payload === null ||
              !Array.isArray((payload as Record<string, unknown>).documentos)
            )
              return;

            const docs = (payload as { documentos: unknown[] }).documentos;
            const urlMap = new Map<string, string>();
            for (const doc of docs) {
              if (
                typeof doc === "object" &&
                doc !== null &&
                "id" in doc &&
                "downloadUrl" in doc &&
                typeof (doc as Record<string, unknown>).downloadUrl === "string" &&
                docIds.includes(String((doc as Record<string, unknown>).id))
              ) {
                urlMap.set(
                  String((doc as Record<string, unknown>).id),
                  String((doc as Record<string, unknown>).downloadUrl),
                );
              }
            }
            if (!cancelled) setDownloadUrlByDocId(urlMap);
          } catch {
            // Non-critical; document viewer degrades gracefully
          }
        }
      } catch {
        // Non-critical; visor degrades gracefully
      }
    }
    void loadFacturasYDocs();
    return () => {
      cancelled = true;
    };
  }, [tramite.id]);

  const estado = borradorActual.estado;

  // Cuando se selecciona una línea, sincronizar con el estado local actual de esa linea
  function seleccionarLinea(linea: LineaLocal) {
    setLineaSeleccionada(linea);
  }

  function toggleLineaEstado(id: string, nuevoEstado: LineaEstado) {
    setLineas((prev) => {
      const updated = prev.map((l) =>
        l.id === id ? { ...l, estadoLocal: nuevoEstado } : l,
      );
      // Actualizar la seleccionada también
      setLineaSeleccionada((sel) =>
        sel && sel.id === id ? { ...sel, estadoLocal: nuevoEstado } : sel,
      );
      return updated;
    });
  }

  async function handleTransicion(nuevoEstado: EstadoBorrador) {
    setTransicionando(true);
    setErrorTransicion(null);
    try {
      const updated = await transicionarBorrador(borradorActual.id, {
        nuevoEstado,
      } as Parameters<typeof transicionarBorrador>[1]);
      setBorradorActual(updated);
      setLineas(updated.lineasRevision.map((l) => ({ ...l, estadoLocal: "pendiente" })));
      onBorradorActualizado(updated);
    } catch (caught) {
      setErrorTransicion(
        caught instanceof FacturacionApiError
          ? caught.message
          : "Error al cambiar el estado.",
      );
    } finally {
      setTransicionando(false);
    }
  }

  function handleFacturado(updated: BorradorRow) {
    setModalFacturar(false);
    setBorradorActual(updated);
    setLineas(updated.lineasRevision.map((l) => ({ ...l, estadoLocal: "pendiente" })));
    onBorradorActualizado(updated);
  }

  const estadoLabel = ESTADO_BORRADOR_LABEL[estado];
  const estadoColor = estadoBorradorColorClass(estado);

  const todasAprobadas = lineas.length > 0 && lineas.every((l) => l.estadoLocal === "aprobada");
  const hayObservadas = lineas.some((l) => l.estadoLocal === "observada");

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white">
      {/* Barra superior */}
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50 shrink-0"
            aria-label="Cerrar revisión"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-slate-950 truncate">
                Revisión: {tramite.consecutivo}
              </h2>
              <span
                className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${estadoColor}`}
              >
                {estadoLabel}
              </span>
              {borradorActual.numFacturaSiigo ? (
                <span className="text-xs font-mono text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5">
                  {borradorActual.numFacturaSiigo}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {tramite.cliente.nombre}
              <span className="ml-1.5 text-slate-400">{tramite.cliente.nit}</span>
            </p>
          </div>
        </div>

        {/* Acciones de transición */}
        <div className="flex items-center gap-2 shrink-0">
          {errorTransicion ? (
            <span className="max-w-xs text-xs text-rose-700 border border-rose-200 bg-rose-50 px-2 py-1">
              {errorTransicion}
            </span>
          ) : null}

          {/* BORRADOR → EN_REVISION */}
          {estado === "BORRADOR" && puedeAprobar ? (
            <button
              type="button"
              onClick={() => handleTransicion("EN_REVISION")}
              disabled={transicionando}
              className="inline-flex h-9 items-center gap-2 border border-amber-400 bg-amber-50 px-3 text-sm font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-60"
            >
              {transicionando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Enviar a revisión
            </button>
          ) : null}

          {/* EN_REVISION → APROBADO */}
          {estado === "EN_REVISION" && puedeAprobar ? (
            <button
              type="button"
              onClick={() => handleTransicion("APROBADO")}
              disabled={transicionando || hayObservadas}
              title={hayObservadas ? "Hay líneas con observaciones pendientes" : undefined}
              className="inline-flex h-9 items-center gap-2 bg-emerald-600 px-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {transicionando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              Aprobar borrador
            </button>
          ) : null}

          {/* APROBADO → FACTURADO */}
          {estado === "APROBADO" && puedeFacturar ? (
            <button
              type="button"
              onClick={() => setModalFacturar(true)}
              disabled={transicionando}
              className="inline-flex h-9 items-center gap-2 bg-cyan-700 px-3 text-sm font-semibold text-white transition hover:bg-cyan-800 disabled:opacity-60"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
              Marcar facturado
            </button>
          ) : null}

          {estado === "FACTURADO" && borradorActual.fechaFactura ? (
            <span className="text-xs text-slate-500 border border-slate-200 bg-slate-50 px-2 py-1">
              Facturado {formatDate(borradorActual.fechaFactura)}
            </span>
          ) : null}

          {/* Descargar archivo de importación SIIGO — solo con borrador aprobado/facturado */}
          {(estado === "APROBADO" || estado === "FACTURADO") && puedeAprobar ? (
            <button
              type="button"
              onClick={() => descargarSiigoImport(borradorActual.id)}
              title="Descargar archivo de importación de SIIGO (Excel formato facturas de venta, columnas A–AE)"
              className="inline-flex h-9 items-center gap-2 border border-emerald-300 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Excel SIIGO
            </button>
          ) : null}
        </div>
      </header>

      {/* Cuerpo split-screen */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* IZQUIERDA — visor de soporte */}
        <div className="flex w-2/5 flex-col border-r border-slate-200 min-h-0">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Soporte del concepto seleccionado
            </p>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <VisorSoporte
              linea={lineaSeleccionada}
              facturasByNumFactura={facturasByNumFactura}
              facturasById={facturasById}
              downloadUrlByDocId={downloadUrlByDocId}
            />
          </div>
        </div>

        {/* DERECHA — líneas + desglose */}
        <div className="flex w-3/5 flex-col min-h-0 overflow-y-auto">
          {/* Líneas de revisión */}
          <div className="border-b border-slate-200">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Líneas del borrador ({lineas.length})
                {todasAprobadas && lineas.length > 0 ? (
                  <span className="ml-2 text-emerald-600">— todas aprobadas</span>
                ) : null}
                {hayObservadas ? (
                  <span className="ml-2 text-amber-600">— hay observaciones</span>
                ) : null}
              </p>
            </div>

            {lineas.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                Este borrador no tiene líneas registradas.
              </p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2 w-6">#</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left">Concepto</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left">N° soporte</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-right">Valor</th>
                    <th className="border-b border-slate-200 px-3 py-2 w-28 text-center">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {lineas.map((linea) => {
                    const isSelected = lineaSeleccionada?.id === linea.id;
                    const rowBg = isSelected
                      ? "bg-cyan-50"
                      : linea.estadoLocal === "aprobada"
                        ? "bg-emerald-50/40"
                        : linea.estadoLocal === "observada"
                          ? "bg-amber-50/40"
                          : "hover:bg-slate-50";

                    return (
                      <tr
                        key={linea.id}
                        onClick={() => seleccionarLinea(linea)}
                        className={`border-b border-slate-100 last:border-b-0 cursor-pointer ${rowBg} transition-colors`}
                      >
                        <td className="px-3 py-2 text-xs text-slate-400">{linea.orden}</td>
                        <td className="px-3 py-2">
                          <span className="font-medium text-slate-900">{linea.concepto}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">
                          {linea.numSoporte ?? <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-900">
                          {formatCOP(linea.valor)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {/* Botones de aprobación/observación por línea — solo roles con permisos */}
                          {(estado === "EN_REVISION" || estado === "BORRADOR") && puedeAprobar ? (
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleLineaEstado(
                                    linea.id,
                                    linea.estadoLocal === "aprobada" ? "pendiente" : "aprobada",
                                  );
                                }}
                                title="Aprobar línea"
                                className={`inline-flex h-7 w-7 items-center justify-center border transition ${
                                  linea.estadoLocal === "aprobada"
                                    ? "border-emerald-400 bg-emerald-100 text-emerald-700"
                                    : "border-slate-300 text-slate-400 hover:border-emerald-400 hover:text-emerald-600"
                                }`}
                              >
                                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleLineaEstado(
                                    linea.id,
                                    linea.estadoLocal === "observada" ? "pendiente" : "observada",
                                  );
                                }}
                                title="Observar línea"
                                className={`inline-flex h-7 w-7 items-center justify-center border transition ${
                                  linea.estadoLocal === "observada"
                                    ? "border-amber-400 bg-amber-100 text-amber-700"
                                    : "border-slate-300 text-slate-400 hover:border-amber-400 hover:text-amber-600"
                                }`}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          ) : (
                            <span
                              className={`inline-block text-xs font-medium px-2 py-0.5 border ${
                                linea.estadoLocal === "aprobada"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : linea.estadoLocal === "observada"
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : "border-slate-200 bg-slate-50 text-slate-500"
                              }`}
                            >
                              {linea.estadoLocal === "aprobada"
                                ? "OK"
                                : linea.estadoLocal === "observada"
                                  ? "Obs."
                                  : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Desglose de cálculos */}
          <div className="px-4 py-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
              Desglose de factura
            </p>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Total pagos</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.totalPagos)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Anticipo aplicado</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.totalAnticipo)}
                </dd>
              </div>

              <div className="my-2 border-t border-slate-200" />

              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Comisión Galcomex/LM</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.comision)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">IVA comisión (19%)</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.ivaComision)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Impuesto 4×1000</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.impuesto4x1000)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-600">Costos bancarios</dt>
                <dd className="font-semibold text-slate-900">
                  {formatCOP(borradorActual.costosBancarios)}
                </dd>
              </div>
              {BigInt(borradorActual.retenciones) > 0n ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-600">Retenciones (RETE IVA/FTE/ICA)</dt>
                  <dd className="font-semibold text-slate-900">
                    {formatCOP(borradorActual.retenciones)}
                  </dd>
                </div>
              ) : null}

              <div className="my-2 border-t border-slate-200" />

              <div className="flex justify-between gap-4 text-base">
                <dt className="font-bold text-slate-900">Total factura</dt>
                <dd className="font-bold text-slate-950">
                  {formatCOP(borradorActual.totalFactura)}
                </dd>
              </div>

              <div className="my-2 border-t border-slate-200" />

              {BigInt(borradorActual.saldoAFavorCliente) > 0n ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-600">Saldo a favor cliente</dt>
                  <dd className="font-semibold text-emerald-700">
                    {formatCOP(borradorActual.saldoAFavorCliente)}
                  </dd>
                </div>
              ) : null}
              {BigInt(borradorActual.saldoACargoCliente) > 0n ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-600">Saldo a cargo cliente</dt>
                  <dd className="font-semibold text-rose-600">
                    {formatCOP(borradorActual.saldoACargoCliente)}
                  </dd>
                </div>
              ) : null}
              {BigInt(borradorActual.saldoAFavorLM) > 0n ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-600">Saldo a favor LM</dt>
                  <dd className="font-semibold text-emerald-700">
                    {formatCOP(borradorActual.saldoAFavorLM)}
                  </dd>
                </div>
              ) : null}
              {BigInt(borradorActual.saldoACargoLM) > 0n ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-600">Saldo a cargo LM</dt>
                  <dd className="font-semibold text-rose-600">
                    {formatCOP(borradorActual.saldoACargoLM)}
                  </dd>
                </div>
              ) : null}
            </dl>

            {borradorActual.fechaAprobacion ? (
              <p className="mt-4 text-xs text-slate-500">
                Aprobado el {formatDate(borradorActual.fechaAprobacion)}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {modalFacturar ? (
        <FacturarModal
          borradorId={borradorActual.id}
          onClose={() => setModalFacturar(false)}
          onFacturado={handleFacturado}
        />
      ) : null}
    </div>
  );
}

// Helper pequeño reutilizable para que el compilador no se queje del BigInt literal
// en contextos donde el valor puede ser "0" como string
function BigInt(v: string): bigint {
  return globalThis.BigInt(v);
}

