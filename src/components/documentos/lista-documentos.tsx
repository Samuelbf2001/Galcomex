"use client";

import { AlertTriangle, Download, Eye, ImageIcon, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  CATEGORIAS_DOCUMENTO,
  type DocumentoRow,
  type DocumentosPorCategoria,
  DocumentosApiError,
  eliminarDocumento,
  formatBytes,
  refrescarUrl,
} from "@/components/documentos/documentos-api";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ListaDocumentosProps = {
  tramiteId: string;
  documentos: DocumentosPorCategoria;
  onDocumentoEliminado: (documentoId: string, categoria: string) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFecha(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function labelCategoria(cat: string): string {
  return CATEGORIAS_DOCUMENTO.find((c) => c.value === cat)?.label ?? cat;
}

function esImagen(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function esPdf(mimeType: string): boolean {
  return mimeType === "application/pdf";
}

// ─── Sub-componente: tarjeta de documento ─────────────────────────────────────

type TarjetaDocumentoProps = {
  doc: DocumentoRow;
  tramiteId: string;
  onEliminado: (documentoId: string, categoria: string) => void;
  esGaleria?: boolean;
};

function TarjetaDocumento({ doc, tramiteId, onEliminado, esGaleria }: TarjetaDocumentoProps) {
  const [eliminando, setEliminando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState(false);

  async function abrirDocumento() {
    if (!doc.downloadUrl) {
      // URL vacía (MinIO no disponible), intentar refrescar
      setAbriendo(true);
      try {
        const url = await refrescarUrl(tramiteId, doc.id);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (caught) {
        setError(
          caught instanceof DocumentosApiError ? caught.message : "No fue posible abrir el documento.",
        );
      } finally {
        setAbriendo(false);
      }
      return;
    }
    window.open(doc.downloadUrl, "_blank", "noopener,noreferrer");
  }

  async function handleEliminar() {
    if (!confirm(`¿Eliminar "${doc.nombreArchivo}"? Esta acción no se puede deshacer.`)) return;
    setEliminando(true);
    setError(null);

    try {
      await eliminarDocumento(tramiteId, doc.id);
      onEliminado(doc.id, doc.categoria);
    } catch (caught) {
      setError(
        caught instanceof DocumentosApiError ? caught.message : "Error al eliminar el documento.",
      );
    } finally {
      setEliminando(false);
    }
  }

  if (esGaleria && esImagen(doc.mimeType)) {
    return (
      <div className="relative group overflow-hidden border border-slate-200 bg-slate-50">
        {/* Vista previa de imagen */}
        {doc.downloadUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={doc.downloadUrl}
            alt={`Foto de reconocimiento: ${doc.nombreArchivo}`}
            className="h-32 w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-32 items-center justify-center">
            <ImageIcon className="h-8 w-8 text-slate-300" aria-hidden="true" />
          </div>
        )}
        {/* Overlay en hover */}
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-slate-950/60 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={abrirDocumento}
            disabled={abriendo}
            className="inline-flex h-9 w-9 items-center justify-center bg-white/90 text-slate-900 transition hover:bg-white"
            aria-label={`Ver ${doc.nombreArchivo}`}
            title="Ver"
          >
            {abriendo ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={handleEliminar}
            disabled={eliminando}
            className="inline-flex h-9 w-9 items-center justify-center bg-rose-600 text-white transition hover:bg-rose-700 disabled:opacity-60"
            aria-label={`Eliminar ${doc.nombreArchivo}`}
            title="Eliminar"
          >
            {eliminando ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="border-t border-slate-200 px-2 py-1.5">
          <p className="truncate text-xs font-medium text-slate-700" title={doc.nombreArchivo}>
            {doc.nombreArchivo}
          </p>
          <p className="text-xs text-slate-500">{doc.subidoPor.name}</p>
        </div>
        {error && (
          <p className="px-2 pb-1 text-xs text-rose-600">
            <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />
            {error}
          </p>
        )}
      </div>
    );
  }

  // Vista en lista (para no imágenes o categorías normales)
  return (
    <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50">
      {/* Icono tipo */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-100 text-xs font-bold uppercase text-slate-500">
        {esPdf(doc.mimeType) ? "PDF" : esImagen(doc.mimeType) ? "IMG" : "XLS"}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900" title={doc.nombreArchivo}>
          {doc.nombreArchivo}
        </p>
        <p className="text-xs text-slate-500">
          {formatBytes(doc.tamanoBytes)} · {doc.subidoPor.name} · {formatFecha(doc.createdAt)}
        </p>
      </div>

      {/* Error inline */}
      {error && (
        <p className="text-xs text-rose-600">
          <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />
          {error}
        </p>
      )}

      {/* Acciones */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={abrirDocumento}
          disabled={abriendo}
          className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-800 disabled:opacity-50"
          aria-label={`Ver ${doc.nombreArchivo}`}
          title={esPdf(doc.mimeType) || esImagen(doc.mimeType) ? "Ver en nueva pestaña" : "Descargar"}
        >
          {abriendo ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : esPdf(doc.mimeType) || esImagen(doc.mimeType) ? (
            <Eye className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          onClick={handleEliminar}
          disabled={eliminando}
          className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
          aria-label={`Eliminar ${doc.nombreArchivo}`}
          title="Eliminar"
        >
          {eliminando ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function ListaDocumentos({ tramiteId, documentos, onDocumentoEliminado }: ListaDocumentosProps) {
  const categorias = Object.keys(documentos).filter((cat) => documentos[cat].length > 0);

  if (categorias.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        No hay documentos subidos para este trámite.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {categorias.map((categoria) => {
        const docs = documentos[categoria];
        const esGaleria = categoria === "FOTO_RECONOCIMIENTO";

        return (
          <section key={categoria}>
            <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
              <h3 className="text-sm font-semibold text-slate-800">
                {labelCategoria(categoria)}
              </h3>
              <span className="inline-flex h-5 items-center border border-slate-200 bg-slate-100 px-1.5 text-xs font-medium text-slate-600">
                {docs.length}
              </span>
            </div>

            {esGaleria ? (
              // Vista galería para fotos de reconocimiento
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {docs.map((doc) => (
                  <TarjetaDocumento
                    key={doc.id}
                    doc={doc}
                    tramiteId={tramiteId}
                    onEliminado={onDocumentoEliminado}
                    esGaleria
                  />
                ))}
              </div>
            ) : (
              // Vista lista para el resto
              <div className="mt-2 overflow-hidden border border-slate-200 bg-white">
                {docs.map((doc) => (
                  <TarjetaDocumento
                    key={doc.id}
                    doc={doc}
                    tramiteId={tramiteId}
                    onEliminado={onDocumentoEliminado}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
