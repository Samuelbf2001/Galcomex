"use client";

import { AlertTriangle, CheckCircle2, Loader2, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import {
  CATEGORIAS_DOCUMENTO,
  type CategoriaDocumento,
  type DocumentoRow,
  DocumentosApiError,
  registrarDocumento,
  solicitarUploadUrl,
  subirArchivoDirecto,
  validarArchivo,
} from "@/components/documentos/documentos-api";

// ─── Tipos internos ───────────────────────────────────────────────────────────

type EstadoSubida = "idle" | "uploading" | "done" | "error";

type ArchivoEnCola = {
  id: string;
  file: File;
  categoria: CategoriaDocumento;
  estado: EstadoSubida;
  progreso: number; // 0-100
  error: string | null;
};

type SubidaDocumentosProps = {
  tramiteId: string;
  onDocumentoSubido: (doc: DocumentoRow) => void;
};

// ─── Componente principal ─────────────────────────────────────────────────────

export function SubidaDocumentos({ tramiteId, onDocumentoSubido }: SubidaDocumentosProps) {
  const [categoria, setCategoria] = useState<CategoriaDocumento>("OTRO");
  const [cola, setCola] = useState<ArchivoEnCola[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ─── Subida de un archivo ──────────────────────────────────────────────────

  const subirArchivo = useCallback(
    async (archivo: ArchivoEnCola) => {
      setCola((prev) =>
        prev.map((a) =>
          a.id === archivo.id ? { ...a, estado: "uploading", progreso: 0 } : a,
        ),
      );

      try {
        // Paso 1: Solicitar URL prefirmada
        const urlResult = await solicitarUploadUrl(tramiteId, {
          categoria: archivo.categoria,
          fileName: archivo.file.name,
          contentType: archivo.file.type,
          sizeBytes: archivo.file.size,
        });

        setCola((prev) =>
          prev.map((a) => (a.id === archivo.id ? { ...a, progreso: 10 } : a)),
        );

        // Paso 2: Subir directo a MinIO con progreso
        await subirArchivoDirecto(urlResult.uploadUrl, archivo.file, (percent) => {
          setCola((prev) =>
            prev.map((a) =>
              a.id === archivo.id
                ? { ...a, progreso: 10 + Math.round(percent * 0.8) }
                : a,
            ),
          );
        });

        // Paso 3: Registrar en BD
        setCola((prev) =>
          prev.map((a) => (a.id === archivo.id ? { ...a, progreso: 95 } : a)),
        );

        const doc = await registrarDocumento(tramiteId, {
          categoria: archivo.categoria,
          nombreArchivo: archivo.file.name,
          storageKey: urlResult.storageKey,
          mimeType: archivo.file.type,
          tamanoBytes: archivo.file.size,
        });

        setCola((prev) =>
          prev.map((a) =>
            a.id === archivo.id
              ? { ...a, estado: "done", progreso: 100, error: null }
              : a,
          ),
        );

        onDocumentoSubido(doc);
      } catch (caught) {
        const msg =
          caught instanceof DocumentosApiError
            ? caught.message
            : "Error inesperado al subir el archivo.";

        setCola((prev) =>
          prev.map((a) =>
            a.id === archivo.id
              ? { ...a, estado: "error", progreso: 0, error: msg }
              : a,
          ),
        );
      }
    },
    [tramiteId, onDocumentoSubido],
  );

  // ─── Agregar archivos a la cola ────────────────────────────────────────────

  const agregarArchivos = useCallback(
    (files: File[]) => {
      const nuevos: ArchivoEnCola[] = files.map((file) => {
        const error = validarArchivo(file);
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          categoria,
          estado: error ? ("error" as EstadoSubida) : ("idle" as EstadoSubida),
          progreso: 0,
          error,
        };
      });

      setCola((prev) => [...prev, ...nuevos]);

      // Iniciar subida automáticamente para los archivos válidos
      for (const archivo of nuevos) {
        if (archivo.estado === "idle") {
          void subirArchivo(archivo);
        }
      }
    },
    [categoria, subirArchivo],
  );

  // ─── Drag & drop ───────────────────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      agregarArchivos(Array.from(e.dataTransfer.files));
    },
    [agregarArchivos],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      agregarArchivos(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  function quitarDeCola(id: string) {
    setCola((prev) => prev.filter((a) => a.id !== id));
  }

  const haySubiendo = cola.some((a) => a.estado === "uploading");

  return (
    <div className="space-y-4">
      {/* Selector de categoría */}
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="categoria-select" className="text-sm font-medium text-slate-700">
          Categoría:
        </label>
        <select
          id="categoria-select"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value as CategoriaDocumento)}
          className="h-9 border border-slate-300 bg-white px-3 text-sm text-slate-700 outline-none focus:border-cyan-600"
        >
          {CATEGORIAS_DOCUMENTO.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {/* Zona de drag & drop */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        aria-label="Zona de subida de archivos. Arrastra archivos aquí o haz clic para seleccionar"
        className={`flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-4 py-6 text-center transition ${
          isDragging
            ? "border-cyan-500 bg-cyan-50"
            : "border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-white"
        }`}
      >
        <Upload
          className={`h-8 w-8 ${isDragging ? "text-cyan-500" : "text-slate-400"}`}
          aria-hidden="true"
        />
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">Arrastra archivos aquí</span> o haz clic
          para seleccionar
        </p>
        <p className="text-xs text-slate-500">
          PDF, JPG, PNG, XLSX — máx 25 MB por archivo
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.xlsx"
          onChange={handleFileInput}
          className="sr-only"
          aria-hidden="true"
        />
      </div>

      {/* Lista de archivos en cola */}
      {cola.length > 0 && (
        <ul className="space-y-2" aria-label="Archivos en cola">
          {cola.map((archivo) => (
            <li
              key={archivo.id}
              className={`flex items-center gap-3 border px-3 py-2 text-sm ${
                archivo.estado === "error"
                  ? "border-rose-200 bg-rose-50"
                  : archivo.estado === "done"
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-slate-200 bg-white"
              }`}
            >
              {/* Icono de estado */}
              {archivo.estado === "uploading" && (
                <Loader2
                  className="h-4 w-4 shrink-0 animate-spin text-cyan-600"
                  aria-hidden="true"
                />
              )}
              {archivo.estado === "done" && (
                <CheckCircle2
                  className="h-4 w-4 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
              )}
              {archivo.estado === "error" && (
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-rose-500"
                  aria-hidden="true"
                />
              )}
              {archivo.estado === "idle" && (
                <div className="h-4 w-4 shrink-0 rounded-full border-2 border-slate-300" />
              )}

              {/* Nombre y progreso */}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900">{archivo.file.name}</p>
                {archivo.estado === "uploading" && (
                  <div className="mt-1 h-1 w-full overflow-hidden bg-slate-200">
                    <div
                      className="h-full bg-cyan-500 transition-all"
                      style={{ width: `${archivo.progreso}%` }}
                      role="progressbar"
                      aria-valuenow={archivo.progreso}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    />
                  </div>
                )}
                {archivo.error && (
                  <p className="mt-0.5 text-xs text-rose-600">{archivo.error}</p>
                )}
                {archivo.estado === "done" && (
                  <p className="mt-0.5 text-xs text-emerald-600">Subido correctamente</p>
                )}
              </div>

              {/* Botón quitar */}
              {archivo.estado !== "uploading" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    quitarDeCola(archivo.id);
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-slate-400 transition hover:text-slate-700"
                  aria-label={`Quitar ${archivo.file.name} de la cola`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {haySubiendo && (
        <p className="text-xs text-slate-500" aria-live="polite">
          Subiendo archivos, espera antes de salir de la página…
        </p>
      )}
    </div>
  );
}
