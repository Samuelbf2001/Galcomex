"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DocumentoRow,
  type DocumentosPorCategoria,
  DocumentosApiError,
  fetchDocumentos,
} from "@/components/documentos/documentos-api";
import { ListaDocumentos } from "@/components/documentos/lista-documentos";
import { SubidaDocumentos } from "@/components/documentos/subida-documentos";
import { ModuleState } from "@/components/layout/module-state";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

type SeccionDocumentosProps = {
  tramiteId: string;
};

// ─── Componente principal ─────────────────────────────────────────────────────

export function SeccionDocumentos({ tramiteId }: SeccionDocumentosProps) {
  const [documentos, setDocumentos] = useState<DocumentosPorCategoria>({});
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // ─── Carga inicial y recarga ───────────────────────────────────────────────

  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Reset state en async para evitar el warning de react-hooks/set-state-in-effect
    Promise.resolve()
      .then(() => {
        setLoadState("loading");
        setLoadError(null);
        return fetchDocumentos(tramiteId, controller.signal);
      })
      .then((data) => {
        setDocumentos(data);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        const msg =
          caught instanceof DocumentosApiError
            ? caught.message
            : "No fue posible cargar los documentos.";
        setLoadError(msg);
        setLoadState("error");
      });

    return () => controller.abort();
  }, [tramiteId, reloadKey]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleDocumentoSubido = useCallback((doc: DocumentoRow) => {
    setDocumentos((prev) => {
      const categoria = doc.categoria as string;
      const lista = prev[categoria] ?? [];
      return { ...prev, [categoria]: [...lista, doc] };
    });
  }, []);

  const handleDocumentoEliminado = useCallback(
    (documentoId: string, categoria: string) => {
      setDocumentos((prev) => {
        const lista = (prev[categoria] ?? []).filter((d) => d.id !== documentoId);
        return { ...prev, [categoria]: lista };
      });
    },
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="space-y-5" aria-label="Sección de documentos">
      {/* Encabezado */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <h2 className="text-base font-semibold text-slate-900">Documentos</h2>
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

      {/* Subida */}
      <div className="border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-800">Subir documentos</h3>
        <SubidaDocumentos tramiteId={tramiteId} onDocumentoSubido={handleDocumentoSubido} />
      </div>

      {/* Lista */}
      <div className="border border-slate-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-semibold text-slate-800">Documentos subidos</h3>

        {loadState === "loading" && (
          <ModuleState type="loading" title="Cargando documentos…" />
        )}

        {loadState === "error" && (
          <div>
            <ModuleState
              type="error"
              title="No fue posible cargar los documentos"
              detail={loadError ?? undefined}
            />
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 inline-flex h-9 items-center gap-2 border border-rose-300 bg-white px-3 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reintentar
            </button>
          </div>
        )}

        {loadState === "ready" && (
          <ListaDocumentos
            tramiteId={tramiteId}
            documentos={documentos}
            onDocumentoEliminado={handleDocumentoEliminado}
          />
        )}
      </div>
    </section>
  );
}
