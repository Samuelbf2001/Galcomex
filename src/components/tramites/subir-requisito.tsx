"use client";

import { CheckCircle2, Loader2, Paperclip, Upload } from "lucide-react";
import { useRef, useState } from "react";

import {
  registrarDocumento,
  solicitarUploadUrl,
  subirArchivoDirecto,
  validarArchivo,
} from "@/components/documentos/documentos-api";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";
import { categoriaParaRequisito, textoArchivos } from "@/lib/documentos/requisitos";
import { ACCEPTED_FILE_EXTENSIONS_ATTR } from "@/lib/storage/config";

/** Roles que admite `POST /api/tramites/[id]/documentos`. */
const ROLES_SUBEN = ["ADMIN", "OPERATIVO", "SOCIO"] as const;

export type RequisitoSubible = {
  id: string;
  descripcion: string;
  recibido: boolean;
  /** Archivos ya subidos desde el requisito; ausente = no se sabe. */
  archivos?: number;
};

/**
 * Subir los archivos que exige un requisito del checklist, ahí mismo
 * (revisión de Ernesto 24-sep-2026, reunión del 31-ago min 40–50): las fotos
 * de la revisión del contenedor, el registro VUCE y su pago. Acepta varios
 * archivos a la vez (una "carpeta" de fotos), los guarda en la carpeta del DO
 * que les toca y el requisito queda recibido solo.
 */
export function SubirRequisito({
  tramiteId,
  requisito,
  onSubido,
  compacto = false,
}: {
  tramiteId: string;
  requisito: RequisitoSubible;
  onSubido: () => void;
  /** Solo el botón (para la fila del checklist). */
  compacto?: boolean;
}) {
  const puedeSubir = usePermiso(ROLES_SUBEN);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progreso, setProgreso] = useState<{ actual: number; total: number } | null>(null);

  async function subir(files: File[]) {
    if (files.length === 0 || progreso) return;
    const categoria = categoriaParaRequisito(requisito.descripcion);
    const fallidos: string[] = [];
    let subidos = 0;

    try {
      for (const [i, file] of files.entries()) {
        setProgreso({ actual: i + 1, total: files.length });
        const invalido = validarArchivo(file);
        if (invalido) {
          fallidos.push(`${file.name}: ${invalido}`);
          continue;
        }
        try {
          const url = await solicitarUploadUrl(tramiteId, {
            categoria,
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          });
          await subirArchivoDirecto(url.uploadUrl, file);
          await registrarDocumento(tramiteId, {
            categoria,
            nombreArchivo: file.name,
            storageKey: url.storageKey,
            mimeType: file.type,
            tamanoBytes: file.size,
            checklistItemId: requisito.id,
          });
          subidos += 1;
        } catch (caught) {
          fallidos.push(`${file.name}: ${describirError(caught)}`);
        }
      }
    } finally {
      setProgreso(null);
      if (inputRef.current) inputRef.current.value = "";
    }

    if (subidos > 0) {
      toast({
        title: `${textoArchivos(subidos)} de «${requisito.descripcion}»`,
        description: "Quedó marcado como recibido.",
        variant: "success",
      });
      onSubido();
    }
    if (fallidos.length > 0) {
      toast({
        title: fallidos.length === 1 ? "Un archivo no se pudo subir" : `${fallidos.length} archivos no se pudieron subir`,
        description: fallidos.join(" · "),
        variant: "error",
      });
    }
  }

  const archivos = requisito.archivos ?? 0;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!compacto && archivos > 0 ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {textoArchivos(archivos)}
        </span>
      ) : null}
      {compacto && archivos > 0 ? (
        <span className="inline-flex items-center gap-1 text-xs text-slate-500" title="Archivos subidos para este documento">
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          {archivos}
        </span>
      ) : null}
      {puedeSubir ? (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_EXTENSIONS_ATTR}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void subir(Array.from(e.target.files ?? []))}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={progreso !== null}
            aria-label={`Subir archivos de ${requisito.descripcion}`}
            className={
              requisito.recibido
                ? "inline-flex h-7 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                : "inline-flex h-7 items-center gap-1 border border-cyan-700 bg-cyan-700 px-2 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-60"
            }
          >
            {progreso ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Subiendo {progreso.actual} de {progreso.total}…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                {requisito.recibido ? "Subir más" : "Subir"}
              </>
            )}
          </button>
        </>
      ) : null}
    </span>
  );
}
