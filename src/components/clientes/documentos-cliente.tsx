"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Download, Eye, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { formatBytes, refrescarUrl } from "@/components/documentos/documentos-api";
import {
  CATEGORIAS_DOCUMENTO_CLIENTE,
  type CategoriaDocumento,
  type DocumentoClienteRow,
  DocumentosClienteApiError,
  fetchDocumentosCliente,
} from "@/components/clientes/documentos-cliente-api";
import { agruparPor } from "@/lib/documentos/agrupar";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers de formato
// ---------------------------------------------------------------------------

function formatFecha(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function labelCategoria(cat: string): string {
  return CATEGORIAS_DOCUMENTO_CLIENTE.find((c) => c.value === cat)?.label ?? cat;
}

function esVisualizable(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType.startsWith("image/");
}

// ---------------------------------------------------------------------------
// Sub-componente: fila de documento
// ---------------------------------------------------------------------------

function FilaDocumento({ doc }: { doc: DocumentoClienteRow }) {
  const [abriendo, setAbriendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function abrir() {
    if (doc.downloadUrl) {
      window.open(doc.downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }
    // URL vacía (p. ej. MinIO no disponible al momento de la consulta):
    // refrescar usando el mismo endpoint que ya usa la vista del trámite.
    setAbriendo(true);
    setError(null);
    try {
      const url = await refrescarUrl(doc.tramite.id, doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible abrir el documento.");
    } finally {
      setAbriendo(false);
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900" title={doc.nombreArchivo}>
          {doc.nombreArchivo}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          <Link
            href={`/tramites/${doc.tramite.id}`}
            className="font-mono font-semibold text-cyan-700 hover:underline"
            title="Ir al trámite de origen"
          >
            {doc.tramite.consecutivo}
          </Link>
          <span>·</span>
          <span>{formatBytes(doc.tamanoBytes)}</span>
          <span>·</span>
          <span>{doc.subidoPor.name}</span>
          <span>·</span>
          <span>{formatFecha(doc.createdAt)}</span>
        </p>
        {error ? (
          <p className="mt-1 text-xs text-rose-600">
            <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={abrir}
        disabled={abriendo}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-800 disabled:opacity-50"
        aria-label={`Ver ${doc.nombreArchivo}`}
        title={esVisualizable(doc.mimeType) ? "Ver en nueva pestaña" : "Descargar"}
      >
        {abriendo ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : esVisualizable(doc.mimeType) ? (
          <Eye className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal exportado
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

export function DocumentosCliente({ clienteId }: { clienteId: string }) {
  const [categoria, setCategoria] = useState<CategoriaDocumento | "">("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [skip, setSkip] = useState(0);

  const [documentos, setDocumentos] = useState<DocumentoClienteRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      try {
        const result = await fetchDocumentosCliente(
          clienteId,
          {
            categoria: categoria || undefined,
            desde: desde || undefined,
            hasta: hasta || undefined,
            take: PAGE_SIZE,
            skip,
          },
          controller.signal,
        );
        setDocumentos(result.documentos);
        setTotal(result.total);
        setLoadState("ready");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(
          caught instanceof DocumentosClienteApiError
            ? caught.message
            : "No fue posible cargar los documentos.",
        );
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [clienteId, categoria, desde, hasta, skip, reloadKey]);

  function aplicarFiltro(next: { categoria?: CategoriaDocumento | ""; desde?: string; hasta?: string }) {
    if (next.categoria !== undefined) setCategoria(next.categoria);
    if (next.desde !== undefined) setDesde(next.desde);
    if (next.hasta !== undefined) setHasta(next.hasta);
    setSkip(0); // cualquier cambio de filtro vuelve a la primera página
  }

  function limpiarFiltros() {
    setCategoria("");
    setDesde("");
    setHasta("");
    setSkip(0);
  }

  const hayFiltros = categoria !== "" || desde !== "" || hasta !== "";
  const porCategoria = agruparPor(documentos, (doc) => doc.categoria);
  const categorias = Object.keys(porCategoria);

  const desdeItem = total === 0 ? 0 : skip + 1;
  const hastaItem = Math.min(skip + PAGE_SIZE, total);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Documentos ({total})</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Todos los documentos de todos los trámites de este cliente, agrupados por categoría.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          aria-label="Recargar documentos"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Recargar
        </button>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Categoría</span>
          <select
            value={categoria}
            onChange={(e) => aplicarFiltro({ categoria: e.target.value as CategoriaDocumento | "" })}
            className="h-9 w-56 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
          >
            <option value="">Todas</option>
            {CATEGORIAS_DOCUMENTO_CLIENTE.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Desde</span>
          <input
            type="date"
            value={desde}
            onChange={(e) => aplicarFiltro({ desde: e.target.value })}
            className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        <label className="space-y-1">
          <span className="block text-xs font-medium text-slate-600">Hasta</span>
          <input
            type="date"
            value={hasta}
            onChange={(e) => aplicarFiltro({ hasta: e.target.value })}
            className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        {hayFiltros ? (
          <button
            type="button"
            onClick={limpiarFiltros}
            className="h-9 border border-slate-300 bg-white px-3 text-sm text-slate-600 transition hover:bg-slate-100"
          >
            Limpiar filtros
          </button>
        ) : null}
      </div>

      {/* Contenido */}
      <div className="p-4">
        {loadState === "loading" ? (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Cargando documentos…
          </p>
        ) : null}

        {loadState === "error" ? (
          <div className="py-8 text-center">
            <p className="text-sm text-rose-600">
              <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden="true" />
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 inline-flex h-9 items-center gap-2 border border-rose-300 bg-white px-3 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reintentar
            </button>
          </div>
        ) : null}

        {loadState === "ready" && categorias.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            {hayFiltros
              ? "No hay documentos que coincidan con los filtros."
              : "Este cliente aún no tiene documentos guardados."}
          </p>
        ) : null}

        {loadState === "ready" && categorias.length > 0 ? (
          <div className="space-y-4">
            {categorias.map((cat) => {
              const docs = porCategoria[cat];
              return (
                <section key={cat}>
                  <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
                    <h3 className="text-sm font-semibold text-slate-800">{labelCategoria(cat)}</h3>
                    <span className="inline-flex h-5 items-center border border-slate-200 bg-slate-100 px-1.5 text-xs font-medium text-slate-600">
                      {docs.length}
                    </span>
                  </div>
                  <div className="mt-2 overflow-hidden border border-slate-200">
                    {docs.map((doc) => (
                      <FilaDocumento key={doc.id} doc={doc} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Paginación */}
      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
          <p className="text-xs text-slate-500">
            Mostrando {desdeItem}–{hastaItem} de {total}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
              disabled={skip === 0 || loadState === "loading"}
              className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Anterior
            </button>
            <button
              type="button"
              onClick={() => setSkip((s) => s + PAGE_SIZE)}
              disabled={skip + PAGE_SIZE >= total || loadState === "loading"}
              className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Siguiente
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
