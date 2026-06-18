"use client";

import { Loader2, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  BeneficiarioApiError,
  createBeneficiario,
  fetchBeneficiarios,
} from "./beneficiario-api";

/** Tipo mínimo necesario para mostrar y seleccionar un beneficiario. */
export type BeneficiarioSeleccion = {
  id: string;
  nombre: string;
  nit: string | null;
};

type Props = {
  value: BeneficiarioSeleccion | null;
  onChange: (b: BeneficiarioSeleccion | null) => void;
  placeholder?: string;
  disabled?: boolean;
};

export function BeneficiarioCombobox({
  value,
  onChange,
  placeholder = "Buscar o crear beneficiario…",
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [todos, setTodos] = useState<BeneficiarioSeleccion[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cargar todos los beneficiarios al abrir
  useEffect(() => {
    if (!open) return;
    if (loadState === "ready") return;

    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      try {
        const data = await fetchBeneficiarios(undefined, controller.signal);
        setTodos(data);
        setLoadState("ready");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLoadState("error");
      }
    }

    void load();

    return () => controller.abort();
  }, [open, loadState]);

  // Cerrar al hacer clic fuera
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Foco al input al abrir
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const filtered = todos.filter((b) =>
    b.nombre.toLowerCase().includes(query.toLowerCase()) ||
    (b.nit ?? "").toLowerCase().includes(query.toLowerCase()),
  );

  const queryTrimmed = query.trim();
  const noExiste =
    queryTrimmed.length > 0 &&
    !todos.some((b) => b.nombre.toLowerCase() === queryTrimmed.toLowerCase());

  async function handleCreate() {
    if (!queryTrimmed) return;
    setCreating(true);
    setCreateError(null);
    try {
      const nuevo = await createBeneficiario({ nombre: queryTrimmed });
      setTodos((prev) => [...prev, nuevo].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      onChange(nuevo);
      setOpen(false);
      setQuery("");
    } catch (e) {
      setCreateError(e instanceof BeneficiarioApiError ? e.message : "Error al crear.");
    } finally {
      setCreating(false);
    }
  }

  function handleSelect(b: BeneficiarioSeleccion) {
    onChange(b);
    setOpen(false);
    setQuery("");
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange(null);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        {value ? (
          <span className="flex items-center gap-2 text-slate-800">
            <span className="font-medium">{value.nombre}</span>
            {value.nit ? <span className="text-slate-400 text-xs">{value.nit}</span> : null}
          </span>
        ) : (
          <span className="text-slate-400">{placeholder}</span>
        )}
        <div className="flex items-center gap-1">
          {value ? (
            <span
              role="button"
              tabIndex={0}
              onClick={handleClear}
              onKeyDown={(e) => e.key === "Enter" && handleClear(e as unknown as React.MouseEvent)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700"
              aria-label="Quitar beneficiario"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <Search className="h-3.5 w-3.5 text-slate-400" />
        </div>
      </button>

      {/* Dropdown */}
      {open ? (
        <div className="absolute z-50 mt-1 w-full border border-slate-200 bg-white shadow-lg">
          {/* Search input */}
          <div className="border-b border-slate-100 px-2 py-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && noExiste && !creating) void handleCreate();
                if (e.key === "Escape") { setOpen(false); setQuery(""); }
              }}
              placeholder="Nombre o NIT…"
              className="h-8 w-full bg-slate-50 px-2 text-sm outline-none placeholder:text-slate-400"
            />
          </div>

          {/* Lista */}
          <div className="max-h-52 overflow-y-auto">
            {loadState === "loading" ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Cargando…
              </div>
            ) : loadState === "error" ? (
              <div className="px-3 py-3 text-sm text-rose-600">
                No se pudo cargar la lista.{" "}
                <button
                  type="button"
                  onClick={() => setLoadState("idle")}
                  className="underline"
                >
                  Reintentar
                </button>
              </div>
            ) : filtered.length === 0 && !noExiste ? (
              <div className="px-3 py-3 text-sm text-slate-400">
                {queryTrimmed ? "Sin resultados." : "No hay beneficiarios registrados."}
              </div>
            ) : (
              filtered.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => handleSelect(b)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
                >
                  <span className="font-medium text-slate-800">{b.nombre}</span>
                  {b.nit ? <span className="text-xs text-slate-400">{b.nit}</span> : null}
                </button>
              ))
            )}

            {/* Opción de crear */}
            {noExiste ? (
              <div className="border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={creating}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-cyan-700 hover:bg-cyan-50 disabled:opacity-60"
                >
                  {creating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Crear <span className="font-semibold">&ldquo;{queryTrimmed}&rdquo;</span>
                </button>
                {createError ? (
                  <p className="px-3 pb-2 text-xs text-rose-600">{createError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
