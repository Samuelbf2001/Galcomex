"use client";

import { AlertTriangle, Download, Eye, ImageIcon, Loader2, RefreshCw, Share2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import {
  CATEGORIAS_DOCUMENTO,
  type DocumentoRow,
  type DocumentosPorCategoria,
  eliminarDocumento,
  formatBytes,
  puedeCompartirDocumentoUI,
  puedeEliminarDocumentoUI,
  puedeReemplazarDocumentoUI,
  refrescarUrl,
  reemplazarDocumento,
  solicitarUploadUrl,
  subirArchivoDirecto,
  validarArchivo,
} from "@/components/documentos/documentos-api";
import { EnlaceDocumentoModal } from "@/components/documentos/enlace-documento-modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { describirError, useToast } from "@/components/ui/toast";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ListaDocumentosProps = {
  tramiteId: string;
  documentos: DocumentosPorCategoria;
  currentUserId: string;
  currentUserRol: string;
  onDocumentoEliminado: (documentoId: string, categoria: string) => void;
  onDocumentoReemplazado: (documento: DocumentoRow) => void;
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
  currentUserId: string;
  currentUserRol: string;
  onEliminado: (documentoId: string, categoria: string) => void;
  onReemplazado: (documento: DocumentoRow) => void;
  esGaleria?: boolean;
};

function TarjetaDocumento({
  doc,
  tramiteId,
  currentUserId,
  currentUserRol,
  onEliminado,
  onReemplazado,
  esGaleria,
}: TarjetaDocumentoProps) {
  const [eliminando, setEliminando] = useState(false);
  const [reemplazando, setReemplazando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [mostrarCompartir, setMostrarCompartir] = useState(false);
  const inputReemplazoRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const confirmar = useConfirm();

  const puedeEliminar = puedeEliminarDocumentoUI(currentUserRol);
  const puedeReemplazar = puedeReemplazarDocumentoUI(currentUserRol, doc.subidoPorId, currentUserId);
  const puedeCompartir = puedeCompartirDocumentoUI(currentUserRol);

  async function abrirDocumento() {
    if (!doc.downloadUrl) {
      // URL vacía (MinIO no disponible), intentar refrescar
      if (abriendo) return;
      setAbriendo(true);
      try {
        const url = await refrescarUrl(tramiteId, doc.id);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (caught) {
        setError(describirError(caught, "No fue posible abrir el documento."));
      } finally {
        setAbriendo(false);
      }
      return;
    }
    window.open(doc.downloadUrl, "_blank", "noopener,noreferrer");
  }

  async function handleEliminar() {
    if (eliminando) return;
    const ok = await confirmar({
      title: `¿Eliminar "${doc.nombreArchivo}"?`,
      description: "Esta acción no se puede deshacer.",
      confirmText: "Eliminar documento",
      variant: "danger",
    });
    if (!ok) return;
    setEliminando(true);
    setError(null);

    try {
      await eliminarDocumento(tramiteId, doc.id);
      toast({ title: "Documento eliminado", description: doc.nombreArchivo, variant: "success" });
      onEliminado(doc.id, doc.categoria);
    } catch (caught) {
      const msg = describirError(caught, "Error al eliminar el documento.");
      setError(msg);
      toast({ title: "No se pudo eliminar el documento", description: msg, variant: "error" });
    } finally {
      setEliminando(false);
    }
  }

  function handleReemplazarClick() {
    inputReemplazoRef.current?.click();
  }

  async function handleArchivoReemplazo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || reemplazando) return;

    const errorValidacion = validarArchivo(file);
    if (errorValidacion) {
      setError(errorValidacion);
      return;
    }

    const ok = await confirmar({
      title: `¿Reemplazar "${doc.nombreArchivo}"?`,
      description: `Se sustituirá por "${file.name}". El archivo anterior dejará de estar disponible.`,
      confirmText: "Reemplazar",
      variant: "danger",
    });
    if (!ok) return;

    setReemplazando(true);
    setError(null);

    try {
      const urlResult = await solicitarUploadUrl(tramiteId, {
        categoria: doc.categoria,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      await subirArchivoDirecto(urlResult.uploadUrl, file);

      const actualizado = await reemplazarDocumento(tramiteId, doc.id, {
        storageKey: urlResult.storageKey,
        nombreArchivo: file.name,
        mimeType: file.type,
        tamanoBytes: file.size,
      });

      toast({ title: "Documento reemplazado", description: file.name, variant: "success" });
      onReemplazado(actualizado);
    } catch (caught) {
      const msg = describirError(caught, "Error al reemplazar el documento.");
      setError(msg);
      toast({ title: "No se pudo reemplazar el documento", description: msg, variant: "error" });
    } finally {
      setReemplazando(false);
    }
  }

  const inputReemplazo = puedeReemplazar ? (
    <input
      ref={inputReemplazoRef}
      type="file"
      accept=".pdf,.jpg,.jpeg,.png,.xlsx"
      onChange={(e) => void handleArchivoReemplazo(e)}
      className="sr-only"
      aria-hidden="true"
      tabIndex={-1}
    />
  ) : null;

  const modalCompartir = mostrarCompartir ? (
    <EnlaceDocumentoModal
      tramiteId={tramiteId}
      documentoId={doc.id}
      nombreArchivo={doc.nombreArchivo}
      onClose={() => setMostrarCompartir(false)}
    />
  ) : null;

  if (esGaleria && esImagen(doc.mimeType)) {
    return (
      <div className="relative group overflow-hidden border border-slate-200 bg-slate-50">
        {inputReemplazo}
        {modalCompartir}
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
          {puedeCompartir && (
            <button
              type="button"
              onClick={() => setMostrarCompartir(true)}
              className="inline-flex h-9 w-9 items-center justify-center bg-white/90 text-slate-900 transition hover:bg-white"
              aria-label={`Compartir ${doc.nombreArchivo}`}
              title="Compartir"
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {puedeReemplazar && (
            <button
              type="button"
              onClick={handleReemplazarClick}
              disabled={reemplazando}
              className="inline-flex h-9 w-9 items-center justify-center bg-white/90 text-slate-900 transition hover:bg-white"
              aria-label={`Reemplazar ${doc.nombreArchivo}`}
              title="Reemplazar"
            >
              {reemplazando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
          {puedeEliminar && (
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
          )}
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
      {inputReemplazo}
      {modalCompartir}
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
        {puedeCompartir && (
          <button
            type="button"
            onClick={() => setMostrarCompartir(true)}
            className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-800 disabled:opacity-50"
            aria-label={`Compartir ${doc.nombreArchivo}`}
            title="Compartir"
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {puedeReemplazar && (
          <button
            type="button"
            onClick={handleReemplazarClick}
            disabled={reemplazando}
            className="inline-flex h-8 w-8 items-center justify-center border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:text-slate-800 disabled:opacity-50"
            aria-label={`Reemplazar ${doc.nombreArchivo}`}
            title="Reemplazar"
          >
            {reemplazando ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
        {puedeEliminar && (
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
        )}
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function ListaDocumentos({
  tramiteId,
  documentos,
  currentUserId,
  currentUserRol,
  onDocumentoEliminado,
  onDocumentoReemplazado,
}: ListaDocumentosProps) {
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
                    currentUserId={currentUserId}
                    currentUserRol={currentUserRol}
                    onEliminado={onDocumentoEliminado}
                    onReemplazado={onDocumentoReemplazado}
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
                    currentUserId={currentUserId}
                    currentUserRol={currentUserRol}
                    onEliminado={onDocumentoEliminado}
                    onReemplazado={onDocumentoReemplazado}
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
