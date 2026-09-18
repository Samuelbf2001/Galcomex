"use client";

import { ChevronDown, Pencil, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { TIPOS_CALCULO, UNIDADES } from "@/components/clientes/tarifas-api";
import {
  actualizarConceptoVenta,
  crearConceptoVenta,
  fetchConceptosVenta,
  type ConceptoVentaFormValues,
  type ConceptoVentaRow,
} from "@/components/configuracion/catalogos/catalogos-api";
import {
  BadgeActivo,
  BadgeCodigo,
  BTN_PRIMARIO,
  BTN_SECUNDARIO,
  INPUT,
  Interruptor,
  LABEL,
  TEXTAREA,
} from "@/components/configuracion/catalogos/catalogos-ui";
import { catalogoProductos } from "@/components/configuracion/catalogos-cache";
import type { SiigoProductoRow } from "@/components/configuracion/siigo-productos-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

// ─── Selector buscable de producto Siigo (mismo patrón de editor-lineas.tsx) ──

function SiigoProductoSelect({
  productos,
  value,
  onSelect,
  disabled = false,
}: {
  productos: SiigoProductoRow[];
  value: string;
  onSelect: (producto: SiigoProductoRow | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function cerrar() {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) cerrar();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cerrar();
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const seleccionado = productos.find((p) => p.id === value) ?? null;

  const filtrados = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return productos;
    return productos.filter(
      (p) => p.codigo.toLowerCase().includes(q) || p.nombre.toLowerCase().includes(q),
    );
  }, [productos, query]);

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-10 w-full items-center justify-between gap-2 border border-slate-300 bg-white px-3 text-left text-sm transition ${
          disabled ? "cursor-default opacity-70" : "hover:border-slate-400"
        }`}
      >
        <span className={`truncate ${seleccionado ? "text-slate-900" : "text-slate-400"}`}>
          {seleccionado ? `${seleccionado.codigo} — ${seleccionado.nombre}` : "Sin producto por defecto"}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && !disabled ? (
        <div className="absolute z-30 mt-1 max-h-80 w-full overflow-hidden border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-200 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por código o nombre…"
              className="w-full border border-slate-300 px-2 py-1 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-auto">
            {value !== "" ? (
              <button
                type="button"
                onClick={() => {
                  onSelect(null);
                  cerrar();
                }}
                className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm italic text-slate-500 hover:bg-slate-50"
              >
                Quitar producto por defecto
              </button>
            ) : null}
            {filtrados.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">
                {productos.length === 0
                  ? "No hay productos sincronizados desde Siigo."
                  : "No hay productos con ese código o nombre."}
              </p>
            ) : (
              filtrados.map((p) => {
                const activo = p.id === value;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onSelect(p);
                      cerrar();
                    }}
                    className={`block w-full border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 transition ${
                      activo ? "bg-cyan-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="block font-medium text-slate-800">
                      {p.codigo} — {p.nombre}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Modal de alta / edición ──────────────────────────────────────────────────

type ConceptoFormState = ConceptoVentaFormValues & { codigo: string };

function estadoInicial(concepto: ConceptoVentaRow | null): ConceptoFormState {
  if (!concepto) {
    return {
      codigo: "",
      nombre: "",
      descripcion: null,
      siigoProductoId: null,
      aplicaIva: true,
      tipoCalculoSugerido: null,
      unidadSugerida: null,
      orden: 0,
      activo: true,
      notas: null,
    };
  }
  return {
    codigo: concepto.codigo,
    nombre: concepto.nombre,
    descripcion: concepto.descripcion,
    siigoProductoId: concepto.siigoProducto?.id ?? null,
    aplicaIva: concepto.aplicaIva,
    tipoCalculoSugerido: concepto.tipoCalculoSugerido,
    unidadSugerida: concepto.unidadSugerida,
    orden: concepto.orden,
    activo: concepto.activo,
    notas: concepto.notas,
  };
}

function ConceptoModal({
  concepto,
  productos,
  productosLoadState,
  onClose,
  onSaved,
}: {
  /** `null` = alta de un concepto nuevo. */
  concepto: ConceptoVentaRow | null;
  productos: SiigoProductoRow[];
  productosLoadState: LoadState;
  onClose: () => void;
  onSaved: (concepto: ConceptoVentaRow, esNuevo: boolean) => void;
}) {
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [s, setS] = useState<ConceptoFormState>(() => estadoInicial(concepto));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ConceptoFormState>(campo: K, valor: ConceptoFormState[K]) {
    setS((prev) => ({ ...prev, [campo]: valor }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    setError(null);

    // Desactivar un concepto que ya usan ítems de tarifario cambia lo que ve
    // el cliente en las facturas nuevas: se avisa antes de guardar.
    if (concepto && concepto.activo && !s.activo && concepto.itemsEnlazados > 0) {
      const ok = await confirmar({
        title: "¿Desactivar este concepto?",
        description: `${concepto.itemsEnlazados} ítem${concepto.itemsEnlazados === 1 ? "" : "s"} de tarifario lo usa${concepto.itemsEnlazados === 1 ? "" : "n"} hoy. Dejará de aparecer para tarifarios nuevos, pero los ítems ya enlazados no se tocan.`,
        confirmText: "Desactivar",
        variant: "danger",
      });
      if (!ok) return;
    }

    const valores: ConceptoVentaFormValues = {
      nombre: s.nombre.trim(),
      descripcion: s.descripcion?.trim() || null,
      siigoProductoId: s.siigoProductoId,
      aplicaIva: s.aplicaIva,
      tipoCalculoSugerido: s.tipoCalculoSugerido,
      unidadSugerida: s.unidadSugerida,
      orden: s.orden,
      activo: s.activo,
      notas: s.notas?.trim() || null,
    };

    setEnviando(true);
    try {
      const guardado = concepto
        ? await actualizarConceptoVenta(concepto.id, valores)
        : await crearConceptoVenta(s.codigo.trim(), valores);
      toast({
        title: concepto ? "Concepto actualizado" : "Concepto creado",
        description: guardado.nombre,
        variant: "success",
      });
      onSaved(guardado, !concepto);
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible guardar el concepto.");
      setError(mensaje);
      toast({ title: "No se pudo guardar el concepto", description: mensaje, variant: "error" });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title={concepto ? `Editar ${concepto.nombre}` : "Nuevo concepto de venta"}
      size="lg"
      dismissible={!enviando}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Código *</span>
            {concepto ? (
              <div className="pt-1.5">
                <BadgeCodigo codigo={concepto.codigo} />
              </div>
            ) : (
              <input
                value={s.codigo}
                onChange={(e) => set("codigo", e.target.value.toUpperCase())}
                required
                pattern="[A-Z0-9_]+"
                placeholder="GASTOS_TRAMITE"
                className={INPUT}
              />
            )}
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Nombre para el cliente *</span>
            <input
              value={s.nombre}
              onChange={(e) => set("nombre", e.target.value)}
              required
              maxLength={160}
              placeholder="Gastos de trámite"
              className={INPUT}
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className={LABEL}>Producto Siigo por defecto</span>
          {productosLoadState === "error" ? (
            <p className="text-xs text-rose-600">
              No se pudo cargar el catálogo de productos Siigo. Cierra y vuelve a abrir este
              formulario para reintentar.
            </p>
          ) : (
            <SiigoProductoSelect
              productos={productos}
              value={s.siigoProductoId ?? ""}
              onSelect={(p) => set("siigoProductoId", p?.id ?? null)}
              disabled={productosLoadState === "loading"}
            />
          )}
          <p className="text-xs text-slate-500">
            Si hay producto, su nombre manda en la factura; si no, se usa el nombre para el
            cliente de arriba.
          </p>
        </label>

        <label className="block space-y-1">
          <span className={LABEL}>Descripción</span>
          <textarea
            value={s.descripcion ?? ""}
            onChange={(e) => set("descripcion", e.target.value)}
            rows={2}
            maxLength={500}
            className={TEXTAREA}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Tipo de cobro sugerido</span>
            <select
              value={s.tipoCalculoSugerido ?? ""}
              onChange={(e) =>
                set("tipoCalculoSugerido", e.target.value ? (e.target.value as ConceptoFormState["tipoCalculoSugerido"]) : null)
              }
              className={INPUT}
            >
              <option value="">— Sin sugerir —</option>
              {TIPOS_CALCULO.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              Es solo una pista para quien arma el tarifario: no calcula nada.
            </p>
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Unidad sugerida</span>
            <select
              value={s.unidadSugerida ?? ""}
              onChange={(e) =>
                set("unidadSugerida", e.target.value ? (e.target.value as ConceptoFormState["unidadSugerida"]) : null)
              }
              className={INPUT}
            >
              <option value="">— Sin sugerir —</option>
              {UNIDADES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Orden</span>
            <input
              type="number"
              min={0}
              max={9999}
              value={s.orden}
              onChange={(e) => set("orden", Number(e.target.value) || 0)}
              className={INPUT}
            />
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Notas internas</span>
            <input
              value={s.notas ?? ""}
              onChange={(e) => set("notas", e.target.value)}
              maxLength={500}
              className={INPUT}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-6">
          <div className="flex items-center gap-3">
            <Interruptor activo={s.aplicaIva} onToggle={() => set("aplicaIva", !s.aplicaIva)} etiqueta="Aplica IVA" />
            <span className="text-sm text-slate-700">Aplica IVA por defecto</span>
          </div>
          <div className="flex items-center gap-3">
            <Interruptor activo={s.activo} onToggle={() => set("activo", !s.activo)} etiqueta="Concepto activo" />
            <span className="text-sm text-slate-700">Activo</span>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" onClick={onClose} disabled={enviando} className={BTN_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando} className={BTN_PRIMARIO}>
            {enviando ? "Guardando…" : concepto ? "Guardar cambios" : "Crear concepto"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Pestaña ───────────────────────────────────────────────────────────────────

export function ConceptosTab() {
  const puedeEditar = usePermiso(["ADMIN"]);

  const [conceptos, setConceptos] = useState<ConceptoVentaRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [productos, setProductos] = useState<SiigoProductoRow[]>([]);
  const [productosLoadState, setProductosLoadState] = useState<LoadState>("loading");

  const [modal, setModal] = useState<"crear" | ConceptoVentaRow | null>(null);

  useEffect(() => {
    let cancelado = false;
    const controller = new AbortController();
    fetchConceptosVenta(controller.signal)
      .then((rows) => {
        if (cancelado) return;
        setConceptos(rows);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelado) return;
        setLoadError(describirError(caught, "No fue posible cargar los conceptos de venta."));
        setLoadState("error");
      });
    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [reloadKey]);

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  function abrirModal(valor: "crear" | ConceptoVentaRow) {
    if (!puedeEditar) return;
    // El catálogo de productos solo se pide la primera vez que se abre el modal.
    if (productos.length === 0 && productosLoadState !== "error") {
      setProductosLoadState("loading");
      catalogoProductos()
        .then((payload) => {
          setProductos(payload.productos);
          setProductosLoadState("ready");
        })
        .catch(() => setProductosLoadState("error"));
    }
    setModal(valor);
  }

  function handleSaved(concepto: ConceptoVentaRow, esNuevo: boolean) {
    setConceptos((prev) =>
      esNuevo
        ? [...prev, concepto].sort((a, b) => a.orden - b.orden || a.codigo.localeCompare(b.codigo))
        : prev.map((c) => (c.id === concepto.id ? concepto : c)),
    );
    setModal(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Conceptos de venta</h2>
          <p className="text-xs text-slate-500">
            Lo que Galcomex vende: cada concepto define el producto Siigo, el IVA y el nombre
            que ve el cliente en la factura.
          </p>
        </div>
        {puedeEditar ? (
          <button type="button" onClick={() => abrirModal("crear")} className={BTN_PRIMARIO}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Nuevo concepto
          </button>
        ) : null}
      </div>

      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={8} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No se pudieron cargar los conceptos"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : conceptos.length === 0 ? (
        <ModuleState
          type="empty"
          title="No hay conceptos de venta"
          detail="Los conceptos aparecerán aquí cuando se creen desde este panel o desde el seed inicial."
          action={puedeEditar ? { label: "Nuevo concepto", onClick: () => abrirModal("crear"), icon: false } : undefined}
        />
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Código</th>
                <th className="border-b border-slate-200 px-4 py-3">Nombre para el cliente</th>
                <th className="border-b border-slate-200 px-4 py-3">Producto Siigo</th>
                <th className="border-b border-slate-200 px-4 py-3">IVA</th>
                <th className="border-b border-slate-200 px-4 py-3">Tipo de cobro</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">Orden</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">Ítems enlazados</th>
                <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                {puedeEditar ? <th className="border-b border-slate-200 px-4 py-3 text-right">Acción</th> : null}
              </tr>
            </thead>
            <tbody>
              {conceptos.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-3">
                    <BadgeCodigo codigo={c.codigo} />
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">{c.nombre}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {c.siigoProducto ? `${c.siigoProducto.codigo} — ${c.siigoProducto.nombre}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{c.aplicaIva ? "Sí" : "No"}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {TIPOS_CALCULO.find((t) => t.value === c.tipoCalculoSugerido)?.label ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-slate-600">{c.orden}</td>
                  <td className="px-4 py-3 text-right text-xs text-slate-600">{c.itemsEnlazados}</td>
                  <td className="px-4 py-3">
                    <BadgeActivo activo={c.activo} />
                  </td>
                  {puedeEditar ? (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => abrirModal(c)}
                        aria-label={`Editar ${c.nombre}`}
                        className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        Editar
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal !== null ? (
        <ConceptoModal
          concepto={modal === "crear" ? null : modal}
          productos={productos}
          productosLoadState={productosLoadState}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}
