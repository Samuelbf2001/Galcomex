"use client";

import { Check, Loader2, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  BeneficiarioApiError,
  createBeneficiario,
  fetchBeneficiarios,
} from "./beneficiario-api";

export type BeneficiarioSeleccion = {
  id: string;
  nombre: string;
  nit: string | null;
};

type PropsBase = {
  placeholder?: string;
  disabled?: boolean;
};

type PropsSingle = PropsBase & {
  mode?: "single";
  value: BeneficiarioSeleccion | null;
  onChange: (b: BeneficiarioSeleccion | null) => void;
};

type PropsMulti = PropsBase & {
  mode: "multi";
  value: BeneficiarioSeleccion[];
  onChange: (b: BeneficiarioSeleccion[]) => void;
};

type Props = PropsSingle | PropsMulti;

function isMulti(props: Props): props is PropsMulti {
  return props.mode === "multi";
}

export function BeneficiarioCombobox(props: Props) {
  const { placeholder = "Buscar o crear beneficiario…", disabled = false } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [todos, setTodos] = useState<BeneficiarioSeleccion[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // Estado del mini-formulario de creación inline
  const [creatingForm, setCreatingForm] = useState(false);
  const [createNombre, setCreateNombre] = useState("");
  const [createNit, setCreateNit] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const createNombreRef = useRef<HTMLInputElement>(null);
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
        setCreatingForm(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Foco al input al abrir
  useEffect(() => {
    if (open && !creatingForm) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, creatingForm]);

  // Foco al nombre al abrir formulario de creación
  useEffect(() => {
    if (creatingForm) setTimeout(() => createNombreRef.current?.focus(), 0);
  }, [creatingForm]);

  const filtered = todos.filter(
    (b) =>
      b.nombre.toLowerCase().includes(query.toLowerCase()) ||
      (b.nit ?? "").toLowerCase().includes(query.toLowerCase()),
  );

  const queryTrimmed = query.trim();
  const noExiste =
    queryTrimmed.length > 0 &&
    !todos.some((b) => b.nombre.toLowerCase() === queryTrimmed.toLowerCase());

  // --- Helpers de selección ---

  function isSelected(b: BeneficiarioSeleccion): boolean {
    if (isMulti(props)) return props.value.some((v) => v.id === b.id);
    return props.value?.id === b.id;
  }

  function handleSelect(b: BeneficiarioSeleccion) {
    if (isMulti(props)) {
      const already = props.value.some((v) => v.id === b.id);
      props.onChange(
        already ? props.value.filter((v) => v.id !== b.id) : [...props.value, b],
      );
      // En multi, no cerrar el dropdown al seleccionar
    } else {
      props.onChange(b);
      setOpen(false);
      setQuery("");
    }
  }

  function handleClearOne(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (isMulti(props)) {
      props.onChange(props.value.filter((v) => v.id !== id));
    } else {
      props.onChange(null);
    }
  }

  function handleClearAll(e: React.MouseEvent) {
    e.stopPropagation();
    if (isMulti(props)) props.onChange([]);
    else props.onChange(null);
  }

  // --- Creación inline ---

  function handleInitCreate() {
    setCreateNombre(queryTrimmed);
    setCreateNit("");
    setCreateError(null);
    setCreatingForm(true);
  }

  async function handleConfirmCreate() {
    if (!createNombre.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const nuevo = await createBeneficiario({
        nombre: createNombre.trim(),
        nit: createNit.trim() || null,
      });
      setTodos((prev) =>
        [...prev, nuevo].sort((a, b) => a.nombre.localeCompare(b.nombre)),
      );
      if (isMulti(props)) {
        props.onChange([...props.value, nuevo]);
      } else {
        props.onChange(nuevo);
        setOpen(false);
        setQuery("");
      }
      setCreatingForm(false);
      setQuery("");
    } catch (e) {
      setCreateError(e instanceof BeneficiarioApiError ? e.message : "Error al crear.");
    } finally {
      setCreating(false);
    }
  }

  // --- Render del trigger ---

  const multi = isMulti(props);
  const hasValue = multi ? props.value.length > 0 : props.value !== null;

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 w-full items-center justify-between border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        <span className="flex flex-wrap gap-1.5">
          {!hasValue ? (
            <span className="text-slate-400">{placeholder}</span>
          ) : multi ? (
            props.value.map((b) => (
              <span
                key={b.id}
                className="inline-flex items-center gap-1 border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-xs text-cyan-800"
              >
                <span className="font-medium">{b.nombre}</span>
                {b.nit ? <span className="text-cyan-600">{b.nit}</span> : null}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleClearOne(b.id, e)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && handleClearOne(b.id, e as unknown as React.MouseEvent)
                  }
                  className="ml-0.5 text-cyan-500 hover:text-rose-600"
                  aria-label={`Quitar ${b.nombre}`}
                >
                  <X className="h-3 w-3" />
                </span>
              </span>
            ))
          ) : (
            <span className="flex items-center gap-2 text-slate-800">
              <span className="font-medium">{props.value!.nombre}</span>
              {props.value!.nit ? (
                <span className="text-slate-400 text-xs">{props.value!.nit}</span>
              ) : null}
            </span>
          )}
        </span>

        <div className="ml-2 flex shrink-0 items-center gap-1">
          {hasValue ? (
            <span
              role="button"
              tabIndex={0}
              onClick={handleClearAll}
              onKeyDown={(e) =>
                e.key === "Enter" && handleClearAll(e as unknown as React.MouseEvent)
              }
              className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700"
              aria-label="Limpiar selección"
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
          {/* Formulario de creación inline */}
          {creatingForm ? (
            <div className="border-b border-slate-100 px-3 py-3 space-y-2">
              <p className="text-xs font-medium text-slate-600">Nuevo beneficiario</p>
              <input
                ref={createNombreRef}
                value={createNombre}
                onChange={(e) => setCreateNombre(e.target.value)}
                placeholder="Nombre *"
                className="h-8 w-full border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
              />
              <input
                value={createNit}
                onChange={(e) => setCreateNit(e.target.value)}
                placeholder="NIT (opcional)"
                className="h-8 w-full border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
              />
              {createError ? (
                <p className="text-xs text-rose-600">{createError}</p>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCreatingForm(false)}
                  className="flex-1 h-8 border border-slate-300 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmCreate()}
                  disabled={creating || !createNombre.trim()}
                  className="flex-1 h-8 bg-slate-950 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-60 inline-flex items-center justify-center gap-1"
                >
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Crear
                </button>
              </div>
            </div>
          ) : (
            /* Búsqueda normal */
            <div className="border-b border-slate-100 px-2 py-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && noExiste) handleInitCreate();
                  if (e.key === "Escape") {
                    setOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Nombre o NIT…"
                className="h-8 w-full bg-slate-50 px-2 text-sm outline-none placeholder:text-slate-400"
              />
            </div>
          )}

          {/* Lista de beneficiarios */}
          {!creatingForm ? (
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
                    {multi ? (
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                          isSelected(b)
                            ? "border-cyan-600 bg-cyan-600"
                            : "border-slate-300 bg-white"
                        }`}
                      >
                        {isSelected(b) ? (
                          <Check className="h-3 w-3 text-white" />
                        ) : null}
                      </span>
                    ) : isSelected(b) ? (
                      <Check className="h-4 w-4 shrink-0 text-cyan-600" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                    <span className="font-medium text-slate-800">{b.nombre}</span>
                    {b.nit ? (
                      <span className="text-xs text-slate-400">{b.nit}</span>
                    ) : null}
                  </button>
                ))
              )}

              {/* Opción de crear */}
              {noExiste ? (
                <div className="border-t border-slate-100">
                  <button
                    type="button"
                    onClick={handleInitCreate}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-cyan-700 hover:bg-cyan-50"
                  >
                    <Plus className="h-4 w-4" />
                    Crear{" "}
                    <span className="font-semibold">&ldquo;{queryTrimmed}&rdquo;</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Pie del dropdown en modo multi */}
          {multi && !creatingForm && props.value.length > 0 ? (
            <div className="border-t border-slate-100 px-3 py-2 text-right">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                }}
                className="text-xs font-semibold text-slate-700 hover:text-slate-900"
              >
                Listo ({props.value.length})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
