"use client";

import { Check, ChevronDown, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  fetchSiigoFormasPago,
  fetchSiigoImpuestos,
  fetchSiigoProductos,
  fetchSiigoTiposComprobante,
  fetchSiigoVendedores,
  setImpuestosProducto,
  triggerSync,
  triggerSyncFormasPago,
  triggerSyncImpuestos,
  triggerSyncTiposComprobante,
  triggerSyncVendedores,
  type SiigoFormasPagoPayload,
  type SiigoImpuestoRow,
  type SiigoImpuestosPayload,
  type SiigoProductoRow,
  type SiigoProductosPayload,
  type SiigoTiposComprobantePayload,
  type SiigoVendedoresPayload,
  type SyncResult,
} from "@/components/configuracion/siigo-productos-api";

type LoadState = "loading" | "ready" | "error";
type SyncState = "idle" | "syncing" | "success" | "error";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function BadgeActivo({ activo }: { activo: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
        activo
          ? "bg-emerald-100 text-emerald-700"
          : "bg-slate-100 text-slate-500"
      }`}
    >
      {activo ? "Activo" : "Inactivo"}
    </span>
  );
}

// ─── Selector multi-impuesto por producto ────────────────────────────────────

type ImpuestosMultiSelectProps = {
  todos: SiigoImpuestoRow[];
  asignados: SiigoImpuestoRow[];
  onSave: (ids: number[]) => Promise<void>;
  disabled?: boolean;
};

function ImpuestosMultiSelect({
  todos,
  asignados,
  onSave,
  disabled,
}: ImpuestosMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [seleccion, setSeleccion] = useState<number[]>(asignados.map((i) => i.id));
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSeleccion(asignados.map((i) => i.id));
  }, [asignados]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function toggle(id: number) {
    setSeleccion((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function guardar() {
    setPending(true);
    try {
      await onSave(seleccion);
      setOpen(false);
    } finally {
      setPending(false);
    }
  }

  const cambiado =
    seleccion.length !== asignados.length ||
    seleccion.some((id) => !asignados.find((a) => a.id === id));

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
      >
        {asignados.length === 0
          ? "Asignar impuestos"
          : `${asignados.length} impuesto${asignados.length === 1 ? "" : "s"}`}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-72 border border-slate-200 bg-white shadow-lg">
          <div className="max-h-72 overflow-y-auto">
            {todos.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-500">
                No hay impuestos sincronizados.
              </p>
            ) : (
              todos.map((imp) => {
                const selected = seleccion.includes(imp.id);
                return (
                  <button
                    key={imp.id}
                    type="button"
                    onClick={() => toggle(imp.id)}
                    className="flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left text-xs hover:bg-slate-50"
                  >
                    <div
                      className={`mt-0.5 flex h-4 w-4 items-center justify-center border ${
                        selected
                          ? "border-cyan-600 bg-cyan-600 text-white"
                          : "border-slate-300 bg-white"
                      }`}
                    >
                      {selected ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-slate-800">{imp.nombre}</div>
                      <div className="text-[10px] text-slate-500">
                        {imp.tipo} · {imp.porcentaje}%
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-600 hover:underline"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!cambiado || pending}
              onClick={() => void guardar()}
              className="border border-cyan-600 bg-cyan-600 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {pending ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Modal de productos ───────────────────────────────────────────────────────

function ProductosModal({
  productos,
  impuestosCatalogo,
  loadState,
  loadError,
  total,
  onSaveImpuestos,
  onClose,
}: {
  productos: SiigoProductoRow[];
  impuestosCatalogo: SiigoImpuestoRow[];
  loadState: LoadState;
  loadError: string | null;
  total: number;
  onSaveImpuestos: (productoId: string, ids: number[]) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtrados = q.trim()
    ? productos.filter(
        (p) =>
          p.codigo.toLowerCase().includes(q.toLowerCase()) ||
          p.nombre.toLowerCase().includes(q.toLowerCase()),
      )
    : productos;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-5xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Productos Siigo</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {total} productos · Asigna impuestos por producto para el envío a Siigo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="border-b border-slate-200 px-5 py-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filtrar por código o nombre…"
            className="w-72 border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        </div>

        <div className="overflow-auto h-[65vh]">
          {loadState === "loading" ? (
            <div className="px-5 py-8">
              <ModuleState type="loading" title="Cargando productos Siigo" />
            </div>
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar los productos"
                detail={loadError ?? undefined}
              />
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">Código</th>
                  <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                  <th className="border-b border-slate-200 px-4 py-3">Grupo contable</th>
                  <th className="border-b border-slate-200 px-4 py-3">IVA</th>
                  <th className="border-b border-slate-200 px-4 py-3">Impuestos</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>
                      {q ? "Sin resultados para el filtro." : "Sin productos sincronizados."}
                    </td>
                  </tr>
                ) : (
                  filtrados.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100 align-top">
                      <td className="px-4 py-3 font-mono text-xs">{p.codigo}</td>
                      <td className="px-4 py-3 font-medium">{p.nombre}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{p.grupoContableNombre}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{p.clasificacionIva}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-2">
                          {p.impuestos.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {p.impuestos.map((i) => (
                                <span
                                  key={i.id}
                                  className="inline-flex items-center rounded bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-700"
                                  title={`${i.tipo} · ${i.porcentaje}%`}
                                >
                                  {i.nombre}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Sin asignar</span>
                          )}
                          <ImpuestosMultiSelect
                            todos={impuestosCatalogo}
                            asignados={p.impuestos}
                            onSave={(ids) => onSaveImpuestos(p.id, ids)}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <BadgeActivo activo={p.activo} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal de impuestos ───────────────────────────────────────────────────────

function ImpuestosModal({
  data,
  loadState,
  loadError,
  onClose,
}: {
  data: SiigoImpuestosPayload | null;
  loadState: LoadState;
  loadError: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const impuestos = data?.impuestos ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-2xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Impuestos Siigo</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {impuestos.length} impuestos en el catálogo local.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-auto h-[70vh]">
          {loadState === "loading" ? (
            <div className="px-5 py-8">
              <ModuleState type="loading" title="Cargando impuestos Siigo" />
            </div>
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar los impuestos"
                detail={loadError ?? undefined}
              />
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">ID</th>
                  <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                  <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
                  <th className="border-b border-slate-200 px-4 py-3 text-right">%</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {impuestos.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                      Sin impuestos sincronizados.
                    </td>
                  </tr>
                ) : (
                  impuestos.map((i) => (
                    <tr key={i.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{i.id}</td>
                      <td className="px-4 py-3 font-medium">{i.nombre}</td>
                      <td className="px-4 py-3 text-slate-600">{i.tipo}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {i.porcentaje}%
                      </td>
                      <td className="px-4 py-3">
                        <BadgeActivo activo={i.activo} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal de formas de pago ──────────────────────────────────────────────────

function FormasPagoModal({
  data,
  loadState,
  loadError,
  onClose,
}: {
  data: SiigoFormasPagoPayload | null;
  loadState: LoadState;
  loadError: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const formas = data?.formasPago ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-2xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Formas de pago Siigo
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {formas.length} formas de pago en el catálogo local. Se seleccionan
              por borrador antes de enviar a Siigo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-auto h-[70vh]">
          {loadState === "loading" ? (
            <div className="px-5 py-8">
              <ModuleState type="loading" title="Cargando formas de pago Siigo" />
            </div>
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar las formas de pago"
                detail={loadError ?? undefined}
              />
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">ID</th>
                  <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                  <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {formas.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={4}>
                      Sin formas de pago sincronizadas.
                    </td>
                  </tr>
                ) : (
                  formas.map((fp) => (
                    <tr key={fp.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {fp.id}
                      </td>
                      <td className="px-4 py-3 font-medium">{fp.nombre}</td>
                      <td className="px-4 py-3 text-slate-600">{fp.tipo ?? "—"}</td>
                      <td className="px-4 py-3">
                        <BadgeActivo activo={fp.activo} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal de tipos de comprobante ────────────────────────────────────────────

function TiposComprobanteModal({
  data,
  loadState,
  loadError,
  onClose,
}: {
  data: SiigoTiposComprobantePayload | null;
  loadState: LoadState;
  loadError: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tipos = data?.tiposComprobante ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-2xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Tipos de comprobante Siigo
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tipos.length} tipos en el catálogo local. Se selecciona uno en la
              configuración de envío.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-auto h-[70vh]">
          {loadState === "loading" ? (
            <div className="px-5 py-8">
              <ModuleState type="loading" title="Cargando tipos de comprobante" />
            </div>
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar los tipos"
                detail={loadError ?? undefined}
              />
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">ID</th>
                  <th className="border-b border-slate-200 px-4 py-3">Code</th>
                  <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                  <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {tipos.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                      Sin tipos de comprobante sincronizados.
                    </td>
                  </tr>
                ) : (
                  tipos.map((t) => (
                    <tr key={t.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{t.id}</td>
                      <td className="px-4 py-3 font-mono text-xs">{t.code}</td>
                      <td className="px-4 py-3 font-medium">{t.nombre}</td>
                      <td className="px-4 py-3 text-slate-600">{t.tipo ?? "—"}</td>
                      <td className="px-4 py-3">
                        <BadgeActivo activo={t.activo} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Modal de vendedores ──────────────────────────────────────────────────────

function VendedoresModal({
  data,
  loadState,
  loadError,
  onClose,
}: {
  data: SiigoVendedoresPayload | null;
  loadState: LoadState;
  loadError: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vendedores = data?.vendedores ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-3xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Vendedores Siigo
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {vendedores.length} usuarios en el catálogo local.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-auto h-[70vh]">
          {loadState === "loading" ? (
            <div className="px-5 py-8">
              <ModuleState type="loading" title="Cargando vendedores" />
            </div>
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar los vendedores"
                detail={loadError ?? undefined}
              />
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">ID</th>
                  <th className="border-b border-slate-200 px-4 py-3">Username</th>
                  <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                  <th className="border-b border-slate-200 px-4 py-3">Email</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                </tr>
              </thead>
              <tbody>
                {vendedores.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                      Sin vendedores sincronizados.
                    </td>
                  </tr>
                ) : (
                  vendedores.map((v) => (
                    <tr key={v.id} className="border-b border-slate-100">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{v.id}</td>
                      <td className="px-4 py-3 font-mono text-xs">{v.username ?? "—"}</td>
                      <td className="px-4 py-3 font-medium">{v.nombre ?? "—"}</td>
                      <td className="px-4 py-3 text-slate-600">{v.email ?? "—"}</td>
                      <td className="px-4 py-3">
                        <BadgeActivo activo={v.activo} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Fila de sincronización ───────────────────────────────────────────────────

function SyncRow({
  titulo,
  ultimaSync,
  total,
  syncState,
  syncMessage,
  onSync,
  onVerCatalogo,
  labelSync,
  labelVer,
}: {
  titulo: string;
  ultimaSync: string | null;
  total: number;
  syncState: SyncState;
  syncMessage: string | null;
  onSync: () => void;
  onVerCatalogo: () => void;
  labelSync: string;
  labelVer: string;
}) {
  return (
    <div className="border border-slate-200 bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium text-slate-900">{titulo}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {total > 0 ? `${total} registros` : "Sin datos"}{" "}
            {ultimaSync ? `· Última sync: ${formatDate(ultimaSync)}` : "· Nunca sincronizado"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 && (
            <button
              type="button"
              onClick={onVerCatalogo}
              className="border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              {labelVer}
            </button>
          )}
          <button
            type="button"
            onClick={onSync}
            disabled={syncState === "syncing"}
            className="inline-flex items-center gap-2 bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${syncState === "syncing" ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {syncState === "syncing" ? "Sincronizando…" : labelSync}
          </button>
        </div>
      </div>
      {syncMessage ? (
        <div
          className={`mt-3 border px-3 py-2 text-xs ${
            syncState === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {syncMessage}
        </div>
      ) : null}
    </div>
  );
}

// ─── Componente principal ────────────────────────────────────────────────────

export function SiigoProductos() {
  const [data, setData] = useState<SiigoProductosPayload | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [impuestosData, setImpuestosData] = useState<SiigoImpuestosPayload | null>(null);
  const [impuestosLoadState, setImpuestosLoadState] = useState<LoadState>("loading");
  const [impuestosLoadError, setImpuestosLoadError] = useState<string | null>(null);

  const [formasPagoData, setFormasPagoData] = useState<SiigoFormasPagoPayload | null>(null);
  const [formasPagoLoadState, setFormasPagoLoadState] = useState<LoadState>("loading");
  const [formasPagoLoadError, setFormasPagoLoadError] = useState<string | null>(null);

  const [tiposComprobanteData, setTiposComprobanteData] = useState<SiigoTiposComprobantePayload | null>(null);
  const [tiposComprobanteLoadState, setTiposComprobanteLoadState] = useState<LoadState>("loading");
  const [tiposComprobanteLoadError, setTiposComprobanteLoadError] = useState<string | null>(null);

  const [vendedoresData, setVendedoresData] = useState<SiigoVendedoresPayload | null>(null);
  const [vendedoresLoadState, setVendedoresLoadState] = useState<LoadState>("loading");
  const [vendedoresLoadError, setVendedoresLoadError] = useState<string | null>(null);

  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncImpuestosState, setSyncImpuestosState] = useState<SyncState>("idle");
  const [syncImpuestosMessage, setSyncImpuestosMessage] = useState<string | null>(null);
  const [syncFormasPagoState, setSyncFormasPagoState] = useState<SyncState>("idle");
  const [syncFormasPagoMessage, setSyncFormasPagoMessage] = useState<string | null>(null);
  const [syncTiposComprobanteState, setSyncTiposComprobanteState] = useState<SyncState>("idle");
  const [syncTiposComprobanteMessage, setSyncTiposComprobanteMessage] = useState<string | null>(null);
  const [syncVendedoresState, setSyncVendedoresState] = useState<SyncState>("idle");
  const [syncVendedoresMessage, setSyncVendedoresMessage] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [reloadImpuestosKey, setReloadImpuestosKey] = useState(0);
  const [reloadFormasPagoKey, setReloadFormasPagoKey] = useState(0);
  const [reloadTiposComprobanteKey, setReloadTiposComprobanteKey] = useState(0);
  const [reloadVendedoresKey, setReloadVendedoresKey] = useState(0);

  const [modalProductos, setModalProductos] = useState(false);
  const [modalImpuestos, setModalImpuestos] = useState(false);
  const [modalFormasPago, setModalFormasPago] = useState(false);
  const [modalTiposComprobante, setModalTiposComprobante] = useState(false);
  const [modalVendedores, setModalVendedores] = useState(false);

  const cargarProductos = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const result = await fetchSiigoProductos(signal);
      setData(result);
      setLoadState("ready");
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar productos.");
      setLoadState("error");
    }
  }, []);

  const cargarImpuestos = useCallback(async (signal?: AbortSignal) => {
    setImpuestosLoadState("loading");
    setImpuestosLoadError(null);
    try {
      const result = await fetchSiigoImpuestos(signal);
      setImpuestosData(result);
      setImpuestosLoadState("ready");
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError") return;
      setImpuestosLoadError(caught instanceof Error ? caught.message : "Error al cargar impuestos.");
      setImpuestosLoadState("error");
    }
  }, []);

  const cargarFormasPago = useCallback(async (signal?: AbortSignal) => {
    setFormasPagoLoadState("loading");
    setFormasPagoLoadError(null);
    try {
      const result = await fetchSiigoFormasPago(signal);
      setFormasPagoData(result);
      setFormasPagoLoadState("ready");
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError") return;
      setFormasPagoLoadError(
        caught instanceof Error ? caught.message : "Error al cargar formas de pago.",
      );
      setFormasPagoLoadState("error");
    }
  }, []);

  const cargarTiposComprobante = useCallback(async (signal?: AbortSignal) => {
    setTiposComprobanteLoadState("loading");
    setTiposComprobanteLoadError(null);
    try {
      const result = await fetchSiigoTiposComprobante(signal);
      setTiposComprobanteData(result);
      setTiposComprobanteLoadState("ready");
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError") return;
      setTiposComprobanteLoadError(
        caught instanceof Error ? caught.message : "Error al cargar tipos de comprobante.",
      );
      setTiposComprobanteLoadState("error");
    }
  }, []);

  const cargarVendedores = useCallback(async (signal?: AbortSignal) => {
    setVendedoresLoadState("loading");
    setVendedoresLoadError(null);
    try {
      const result = await fetchSiigoVendedores(signal);
      setVendedoresData(result);
      setVendedoresLoadState("ready");
    } catch (caught) {
      if ((caught as { name?: string }).name === "AbortError") return;
      setVendedoresLoadError(
        caught instanceof Error ? caught.message : "Error al cargar vendedores.",
      );
      setVendedoresLoadState("error");
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargarProductos(ctrl.signal);
    return () => ctrl.abort();
  }, [reloadKey, cargarProductos]);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargarImpuestos(ctrl.signal);
    return () => ctrl.abort();
  }, [reloadImpuestosKey, cargarImpuestos]);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargarFormasPago(ctrl.signal);
    return () => ctrl.abort();
  }, [reloadFormasPagoKey, cargarFormasPago]);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargarTiposComprobante(ctrl.signal);
    return () => ctrl.abort();
  }, [reloadTiposComprobanteKey, cargarTiposComprobante]);

  useEffect(() => {
    const ctrl = new AbortController();
    void cargarVendedores(ctrl.signal);
    return () => ctrl.abort();
  }, [reloadVendedoresKey, cargarVendedores]);

  async function handleSync() {
    setSyncState("syncing");
    setSyncMessage(null);
    const result: SyncResult = await triggerSync();
    if (result.ok) {
      setSyncState("success");
      setSyncMessage(`${result.total} productos sincronizados.`);
      setReloadKey((k) => k + 1);
    } else {
      setSyncState("error");
      const prefijo =
        result.tipo === "config"
          ? "Credenciales Siigo no configuradas."
          : result.tipo === "api"
            ? "Error al conectar con Siigo."
            : "Error interno al guardar.";
      setSyncMessage(`${prefijo} ${result.error}`);
    }
  }

  async function handleSyncImpuestos() {
    setSyncImpuestosState("syncing");
    setSyncImpuestosMessage(null);
    const result: SyncResult = await triggerSyncImpuestos();
    if (result.ok) {
      setSyncImpuestosState("success");
      setSyncImpuestosMessage(`${result.total} impuestos sincronizados.`);
      setReloadImpuestosKey((k) => k + 1);
    } else {
      setSyncImpuestosState("error");
      const prefijo =
        result.tipo === "config"
          ? "Credenciales Siigo no configuradas."
          : result.tipo === "api"
            ? "Error al conectar con Siigo."
            : "Error interno al guardar.";
      setSyncImpuestosMessage(`${prefijo} ${result.error}`);
    }
  }

  async function handleSyncFormasPago() {
    setSyncFormasPagoState("syncing");
    setSyncFormasPagoMessage(null);
    const result: SyncResult = await triggerSyncFormasPago();
    if (result.ok) {
      setSyncFormasPagoState("success");
      setSyncFormasPagoMessage(`${result.total} formas de pago sincronizadas.`);
      setReloadFormasPagoKey((k) => k + 1);
    } else {
      setSyncFormasPagoState("error");
      const prefijo =
        result.tipo === "config"
          ? "Credenciales Siigo no configuradas."
          : result.tipo === "api"
            ? "Error al conectar con Siigo."
            : "Error interno al guardar.";
      setSyncFormasPagoMessage(`${prefijo} ${result.error}`);
    }
  }

  async function handleSyncTiposComprobante() {
    setSyncTiposComprobanteState("syncing");
    setSyncTiposComprobanteMessage(null);
    const result: SyncResult = await triggerSyncTiposComprobante();
    if (result.ok) {
      setSyncTiposComprobanteState("success");
      setSyncTiposComprobanteMessage(`${result.total} tipos de comprobante sincronizados.`);
      setReloadTiposComprobanteKey((k) => k + 1);
    } else {
      setSyncTiposComprobanteState("error");
      const prefijo =
        result.tipo === "config"
          ? "Credenciales Siigo no configuradas."
          : result.tipo === "api"
            ? "Error al conectar con Siigo."
            : "Error interno al guardar.";
      setSyncTiposComprobanteMessage(`${prefijo} ${result.error}`);
    }
  }

  async function handleSyncVendedores() {
    setSyncVendedoresState("syncing");
    setSyncVendedoresMessage(null);
    const result: SyncResult = await triggerSyncVendedores();
    if (result.ok) {
      setSyncVendedoresState("success");
      setSyncVendedoresMessage(`${result.total} vendedores sincronizados.`);
      setReloadVendedoresKey((k) => k + 1);
    } else {
      setSyncVendedoresState("error");
      const prefijo =
        result.tipo === "config"
          ? "Credenciales Siigo no configuradas."
          : result.tipo === "api"
            ? "Error al conectar con Siigo."
            : "Error interno al guardar.";
      setSyncVendedoresMessage(`${prefijo} ${result.error}`);
    }
  }

  async function handleSaveImpuestos(productoId: string, impuestoIds: number[]) {
    const result = await setImpuestosProducto(productoId, impuestoIds);
    if (!result.ok) {
      setSyncMessage(result.error ?? "Error al guardar impuestos.");
      setSyncState("error");
    } else {
      setReloadKey((k) => k + 1);
    }
  }

  const productos = data?.productos ?? [];
  const impuestosCatalogo = impuestosData?.impuestos ?? [];

  return (
    <>
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Catálogos Siigo</h2>
        <SyncRow
          titulo="Productos"
          ultimaSync={data?.ultimaSync ?? null}
          total={data?.total ?? 0}
          syncState={syncState}
          syncMessage={syncMessage}
          onSync={() => void handleSync()}
          onVerCatalogo={() => setModalProductos(true)}
          labelSync="Sincronizar"
          labelVer={`Ver catálogo (${data?.total ?? 0})`}
        />
        <SyncRow
          titulo="Impuestos"
          ultimaSync={impuestosData?.ultimaSync ?? null}
          total={impuestosData?.total ?? 0}
          syncState={syncImpuestosState}
          syncMessage={syncImpuestosMessage}
          onSync={() => void handleSyncImpuestos()}
          onVerCatalogo={() => setModalImpuestos(true)}
          labelSync="Sincronizar"
          labelVer={`Ver catálogo (${impuestosData?.total ?? 0})`}
        />
        <SyncRow
          titulo="Formas de pago"
          ultimaSync={formasPagoData?.ultimaSync ?? null}
          total={formasPagoData?.total ?? 0}
          syncState={syncFormasPagoState}
          syncMessage={syncFormasPagoMessage}
          onSync={() => void handleSyncFormasPago()}
          onVerCatalogo={() => setModalFormasPago(true)}
          labelSync="Sincronizar"
          labelVer={`Ver catálogo (${formasPagoData?.total ?? 0})`}
        />
        <SyncRow
          titulo="Tipos de comprobante"
          ultimaSync={tiposComprobanteData?.ultimaSync ?? null}
          total={tiposComprobanteData?.total ?? 0}
          syncState={syncTiposComprobanteState}
          syncMessage={syncTiposComprobanteMessage}
          onSync={() => void handleSyncTiposComprobante()}
          onVerCatalogo={() => setModalTiposComprobante(true)}
          labelSync="Sincronizar"
          labelVer={`Ver catálogo (${tiposComprobanteData?.total ?? 0})`}
        />
        <SyncRow
          titulo="Vendedores"
          ultimaSync={vendedoresData?.ultimaSync ?? null}
          total={vendedoresData?.total ?? 0}
          syncState={syncVendedoresState}
          syncMessage={syncVendedoresMessage}
          onSync={() => void handleSyncVendedores()}
          onVerCatalogo={() => setModalVendedores(true)}
          labelSync="Sincronizar"
          labelVer={`Ver catálogo (${vendedoresData?.total ?? 0})`}
        />
      </div>

      {modalProductos && (
        <ProductosModal
          productos={productos}
          impuestosCatalogo={impuestosCatalogo}
          loadState={loadState}
          loadError={loadError}
          total={data?.total ?? 0}
          onSaveImpuestos={handleSaveImpuestos}
          onClose={() => setModalProductos(false)}
        />
      )}

      {modalImpuestos && (
        <ImpuestosModal
          data={impuestosData}
          loadState={impuestosLoadState}
          loadError={impuestosLoadError}
          onClose={() => setModalImpuestos(false)}
        />
      )}

      {modalFormasPago && (
        <FormasPagoModal
          data={formasPagoData}
          loadState={formasPagoLoadState}
          loadError={formasPagoLoadError}
          onClose={() => setModalFormasPago(false)}
        />
      )}

      {modalTiposComprobante && (
        <TiposComprobanteModal
          data={tiposComprobanteData}
          loadState={tiposComprobanteLoadState}
          loadError={tiposComprobanteLoadError}
          onClose={() => setModalTiposComprobante(false)}
        />
      )}

      {modalVendedores && (
        <VendedoresModal
          data={vendedoresData}
          loadState={vendedoresLoadState}
          loadError={vendedoresLoadError}
          onClose={() => setModalVendedores(false)}
        />
      )}
    </>
  );
}
