"use client";

import { Lock, RotateCcw } from "lucide-react";
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
import { TableSkeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { usePermiso, useRol } from "@/lib/auth/rol-context";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

type SeccionDocumentosProps = {
  tramiteId: string;
  /** Cambia cuando el detalle del DO se recargó: vuelve a listar. */
  refreshToken?: number;
};

/** POST /api/tramites/[id]/documentos (subida) exige ADMIN/OPERATIVO/SOCIO. */
const ROLES_SUBIR_DOCUMENTO = ["ADMIN", "OPERATIVO", "SOCIO"] as const;

/**
 * Id del usuario autenticado. El rol llega por contexto (`useRol`), pero la
 * regla "OPERATIVO solo reemplaza lo que él mismo subió" necesita comparar
 * `Documento.subidoPorId` con el id de sesión, que el contexto no expone.
 * Se usa el cliente oficial de Better Auth (cacheado) en vez de un fetch
 * artesanal a /api/auth/get-session.
 */
function useUsuarioActualId(): string {
  const { data } = authClient.useSession();
  return data?.user.id ?? "";
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function SeccionDocumentos({ tramiteId, refreshToken = 0 }: SeccionDocumentosProps) {
  const rol = useRol();
  const puedeSubir = usePermiso(ROLES_SUBIR_DOCUMENTO);
  const usuarioId = useUsuarioActualId();
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
        // Solo la primera carga muestra el skeleton; las recargas conservan la lista.
        setLoadState((prev) => (prev === "ready" ? prev : "loading"));
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
  }, [tramiteId, reloadKey, refreshToken]);

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

  const handleDocumentoReemplazado = useCallback((documentoActualizado: DocumentoRow) => {
    setDocumentos((prev) => {
      const categoria = documentoActualizado.categoria as string;
      const lista = (prev[categoria] ?? []).map((d) =>
        d.id === documentoActualizado.id ? documentoActualizado : d,
      );
      return { ...prev, [categoria]: lista };
    });
  }, []);

  const recargar = useCallback(() => setReloadKey((k) => k + 1), []);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="space-y-5" aria-label="Sección de documentos">
      {/* Encabezado */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <h2 className="text-base font-semibold text-slate-900">Documentos</h2>
        <button
          type="button"
          onClick={recargar}
          className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          aria-label="Recargar documentos"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Recargar
        </button>
      </div>

      {/* Subida: oculta a REVISOR (el registro fallaría con 403 tras subir el archivo). */}
      {puedeSubir ? (
        <div className="border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-800">Subir documentos</h3>
          <SubidaDocumentos tramiteId={tramiteId} onDocumentoSubido={handleDocumentoSubido} />
        </div>
      ) : (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Tu perfil no sube documentos (solo ADMIN, OPERATIVO y SOCIO). Puedes verlos,
          compartirlos, reemplazarlos o eliminarlos según tu rol.
        </p>
      )}

      {/* Lista */}
      <div className="border border-slate-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-semibold text-slate-800">Documentos subidos</h3>

        {loadState === "loading" && (
          <TableSkeleton rows={4} cols={3} rowHeight={56} />
        )}

        {loadState === "error" && (
          <ModuleState
            type="error"
            title="No fue posible cargar los documentos"
            detail={loadError ?? undefined}
            action={{ label: "Reintentar", onClick: recargar }}
          />
        )}

        {loadState === "ready" && (
          <ListaDocumentos
            tramiteId={tramiteId}
            documentos={documentos}
            currentUserId={usuarioId}
            currentUserRol={rol}
            onDocumentoEliminado={handleDocumentoEliminado}
            onDocumentoReemplazado={handleDocumentoReemplazado}
          />
        )}
      </div>
    </section>
  );
}
