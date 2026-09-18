"use client";

import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  catalogoFormasPago,
  catalogoImpuestos,
  catalogoProductos,
  catalogoTiposComprobante,
  catalogoVendedores,
  invalidarCatalogos,
  type CatalogoConfig,
} from "@/components/configuracion/catalogos-cache";
import {
  setImpuestosProducto,
  triggerSync,
  triggerSyncFormasPago,
  triggerSyncImpuestos,
  triggerSyncTiposComprobante,
  triggerSyncVendedores,
  type SiigoFormaPagoRow,
  type SiigoImpuestoRow,
  type SiigoProductoRow,
  type SiigoTipoComprobanteRow,
  type SiigoVendedorRow,
  type SyncResult,
} from "@/components/configuracion/siigo-productos-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";

type LoadState = "idle" | "loading" | "ready" | "error";
type SyncState = "idle" | "syncing" | "success" | "error";

/** Catálogos Siigo que se sincronizan desde esta sección (mismo orden en pantalla). */
type Catalogo = Exclude<CatalogoConfig, "beneficiarios">;

const ORDEN: Catalogo[] = ["productos", "impuestos", "formasPago", "tiposComprobante", "vendedores"];

const DEF: Record<
  Catalogo,
  { titulo: string; plural: string; participio: string; sync: () => Promise<SyncResult> }
> = {
  productos: { titulo: "Productos", plural: "productos", participio: "sincronizados", sync: triggerSync },
  impuestos: { titulo: "Impuestos", plural: "impuestos", participio: "sincronizados", sync: triggerSyncImpuestos },
  formasPago: {
    titulo: "Formas de pago",
    plural: "formas de pago",
    participio: "sincronizadas",
    sync: triggerSyncFormasPago,
  },
  tiposComprobante: {
    titulo: "Tipos de comprobante",
    plural: "tipos de comprobante",
    participio: "sincronizados",
    sync: triggerSyncTiposComprobante,
  },
  vendedores: { titulo: "Vendedores", plural: "vendedores", participio: "sincronizados", sync: triggerSyncVendedores },
};

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

/** Origen de una asignación producto↔impuesto: quién la dejó ahí. */
function BadgeOrigenImpuesto({ origen }: { origen: "SIIGO" | "MANUAL" }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
        origen === "SIIGO"
          ? "bg-slate-100 text-slate-600"
          : "bg-amber-100 text-amber-700"
      }`}
      title={
        origen === "SIIGO"
          ? "Lo trajo el sincronizador de Siigo."
          : "Se guardó a mano: el sincronizador ya no lo toca."
      }
    >
      {origen === "SIIGO" ? "Siigo" : "Manual"}
    </span>
  );
}

// ─── Carga perezosa de un catálogo (desde el caché compartido) ───────────────

type Carga<T> = {
  data: T | null;
  loadState: LoadState;
  loadError: string | null;
  /** Pide (o vuelve a pedir) el catálogo. Idempotente mientras carga. */
  recargar: () => void;
};

function useCatalogo<T>(cargar: () => Promise<T>, fallback: string): Carga<T> {
  const [data, setData] = useState<T | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (version === 0) return;
    let cancelado = false;
    cargar()
      .then((result) => {
        if (cancelado) return;
        setData(result);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelado) return;
        setLoadError(describirError(caught, fallback));
        setLoadState("error");
      });
    return () => {
      cancelado = true;
    };
  }, [version, cargar, fallback]);

  const recargar = useCallback(() => {
    setLoadState("loading");
    setLoadError(null);
    setVersion((v) => v + 1);
  }, []);

  return { data, loadState, loadError, recargar };
}

// ─── Selector multi-impuesto por producto ────────────────────────────────────

type ImpuestosMultiSelectProps = {
  todos: SiigoImpuestoRow[];
  asignados: SiigoImpuestoRow[];
  /** Debe lanzar si falla, para que el desplegable siga abierto. */
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
  // El padre remonta este componente (key) cuando cambian los asignados.
  const [seleccion, setSeleccion] = useState<number[]>(() => asignados.map((i) => i.id));
  const ref = useRef<HTMLDivElement | null>(null);

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
    } catch {
      /* el padre ya avisó con toast; el desplegable sigue abierto */
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
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
      >
        {asignados.length === 0
          ? "Asignar impuestos"
          : `${asignados.length} impuesto${asignados.length === 1 ? "" : "s"}`}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-72 border border-slate-200 bg-white shadow-lg">
          <div className="max-h-72 overflow-y-auto" role="listbox" aria-multiselectable="true">
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
                    role="option"
                    aria-selected={selected}
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
              disabled={pending}
              className="text-xs text-slate-600 hover:underline disabled:opacity-50"
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
  onRetry,
  onSaveImpuestos,
  onClose,
}: {
  productos: SiigoProductoRow[];
  impuestosCatalogo: SiigoImpuestoRow[];
  loadState: LoadState;
  loadError: string | null;
  total: number;
  onRetry: () => void;
  onSaveImpuestos: (productoId: string, ids: number[]) => Promise<void>;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");

  const filtrados = q.trim()
    ? productos.filter(
        (p) =>
          p.codigo.toLowerCase().includes(q.toLowerCase()) ||
          p.nombre.toLowerCase().includes(q.toLowerCase()),
      )
    : productos;

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Productos Siigo"
      description={`${total} productos · Asigna impuestos por producto para el envío a Siigo.`}
      size="xl"
    >
      <div className="-mx-5 -mt-4">
        <div className="border-b border-slate-200 px-5 py-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filtrar por código o nombre…"
            aria-label="Filtrar productos por código o nombre"
            className="w-72 border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        </div>

        <div className="min-h-[50vh]">
          {loadState === "ready" ? (
            <p className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
              Guardar impuestos a mano congela ese producto frente a la sincronización: el
              siguiente sync de Siigo ya no le toca los impuestos.
            </p>
          ) : null}
          {loadState === "loading" || loadState === "idle" ? (
            <TableSkeleton rows={8} cols={6} />
          ) : loadState === "error" ? (
            <div className="px-5 py-8">
              <ModuleState
                type="error"
                title="No se pudieron cargar los productos"
                detail={loadError ?? undefined}
                action={{ label: "Reintentar", onClick: onRetry }}
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
                                  className="inline-flex items-center gap-1 rounded bg-cyan-50 px-2 py-0.5 text-[10px] font-medium text-cyan-700"
                                  title={`${i.tipo} · ${i.porcentaje}%`}
                                >
                                  {i.nombre}
                                  <BadgeOrigenImpuesto origen={i.origen} />
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">Sin asignar</span>
                          )}
                          <ImpuestosMultiSelect
                            // Remonta (y resetea la selección) cuando cambian los asignados.
                            key={p.impuestos.map((i) => i.id).join(",")}
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
    </ModalShell>
  );
}

// ─── Modal genérico de tabla de catálogo ─────────────────────────────────────

type Columna<T> = {
  titulo: string;
  render: (row: T) => ReactNode;
  className?: string;
};

function TablaCatalogoModal<T extends { id: number }>({
  title,
  description,
  rows,
  columnas,
  vacio,
  loadState,
  loadError,
  errorTitulo,
  onRetry,
  onClose,
  size = "lg",
}: {
  title: string;
  description: string;
  rows: T[];
  columnas: Columna<T>[];
  vacio: string;
  loadState: LoadState;
  loadError: string | null;
  errorTitulo: string;
  onRetry: () => void;
  onClose: () => void;
  size?: "lg" | "xl";
}) {
  return (
    <ModalShell open onClose={onClose} title={title} description={description} size={size}>
      <div className="-mx-5 -my-4 min-h-[50vh]">
        {loadState === "loading" || loadState === "idle" ? (
          <TableSkeleton rows={8} cols={columnas.length} />
        ) : loadState === "error" ? (
          <div className="px-5 py-8">
            <ModuleState
              type="error"
              title={errorTitulo}
              detail={loadError ?? undefined}
              action={{ label: "Reintentar", onClick: onRetry }}
            />
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
              <tr>
                {columnas.map((c) => (
                  <th key={c.titulo} className={`border-b border-slate-200 px-4 py-3 ${c.className ?? ""}`}>
                    {c.titulo}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={columnas.length}>
                    {vacio}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100">
                    {columnas.map((c) => (
                      <td key={c.titulo} className={`px-4 py-3 ${c.className ?? ""}`}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </ModalShell>
  );
}

const COLUMNAS_IMPUESTOS: Columna<SiigoImpuestoRow>[] = [
  { titulo: "ID", render: (i) => <span className="font-mono text-xs text-slate-500">{i.id}</span> },
  { titulo: "Nombre", render: (i) => <span className="font-medium">{i.nombre}</span> },
  { titulo: "Tipo", render: (i) => <span className="text-slate-600">{i.tipo}</span> },
  {
    titulo: "%",
    className: "text-right",
    render: (i) => <span className="font-mono text-slate-700">{i.porcentaje}%</span>,
  },
  { titulo: "Estado", render: (i) => <BadgeActivo activo={i.activo} /> },
];

const COLUMNAS_FORMAS_PAGO: Columna<SiigoFormaPagoRow>[] = [
  { titulo: "ID", render: (fp) => <span className="font-mono text-xs text-slate-500">{fp.id}</span> },
  { titulo: "Nombre", render: (fp) => <span className="font-medium">{fp.nombre}</span> },
  { titulo: "Tipo", render: (fp) => <span className="text-slate-600">{fp.tipo ?? "—"}</span> },
  { titulo: "Estado", render: (fp) => <BadgeActivo activo={fp.activo} /> },
];

const COLUMNAS_TIPOS: Columna<SiigoTipoComprobanteRow>[] = [
  { titulo: "ID", render: (t) => <span className="font-mono text-xs text-slate-500">{t.id}</span> },
  { titulo: "Code", render: (t) => <span className="font-mono text-xs">{t.code}</span> },
  { titulo: "Nombre", render: (t) => <span className="font-medium">{t.nombre}</span> },
  { titulo: "Tipo", render: (t) => <span className="text-slate-600">{t.tipo ?? "—"}</span> },
  { titulo: "Estado", render: (t) => <BadgeActivo activo={t.activo} /> },
];

const COLUMNAS_VENDEDORES: Columna<SiigoVendedorRow>[] = [
  { titulo: "ID", render: (v) => <span className="font-mono text-xs text-slate-500">{v.id}</span> },
  { titulo: "Username", render: (v) => <span className="font-mono text-xs">{v.username ?? "—"}</span> },
  { titulo: "Nombre", render: (v) => <span className="font-medium">{v.nombre ?? "—"}</span> },
  { titulo: "Email", render: (v) => <span className="text-slate-600">{v.email ?? "—"}</span> },
  { titulo: "Estado", render: (v) => <BadgeActivo activo={v.activo} /> },
];

// ─── Fila de sincronización ───────────────────────────────────────────────────

function SyncRow({
  titulo,
  ultimaSync,
  total,
  loadState,
  loadError,
  syncState,
  syncMessage,
  onSync,
  onVerCatalogo,
  onRetry,
}: {
  titulo: string;
  ultimaSync: string | null;
  total: number;
  loadState: LoadState;
  loadError: string | null;
  syncState: SyncState;
  syncMessage: string | null;
  onSync: () => void;
  onVerCatalogo: () => void;
  onRetry: () => void;
}) {
  const cargando = loadState === "loading" || loadState === "idle";

  return (
    <div className="border border-slate-200 bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">{titulo}</p>
          {cargando ? (
            <Skeleton className="mt-1.5 h-3 w-56" />
          ) : loadState === "error" ? (
            <p className="mt-0.5 text-xs text-rose-700">
              {loadError ?? "No se pudo cargar el catálogo."}{" "}
              <button type="button" onClick={onRetry} className="font-semibold underline">
                Reintentar
              </button>
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500">
              {total > 0 ? `${total} registros` : "Sin datos"}{" "}
              {ultimaSync ? `· Última sync: ${formatDate(ultimaSync)}` : "· Nunca sincronizado"}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {total > 0 && (
            <button
              type="button"
              onClick={onVerCatalogo}
              className="border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Ver catálogo ({total})
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
            {syncState === "syncing" ? "Sincronizando…" : "Sincronizar"}
          </button>
        </div>
      </div>
      {syncMessage ? (
        <div
          role={syncState === "error" ? "alert" : "status"}
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

type EstadoSync = Record<Catalogo, { state: SyncState; message: string | null }>;

function syncInicial(): EstadoSync {
  return Object.fromEntries(
    ORDEN.map((c) => [c, { state: "idle", message: null }]),
  ) as EstadoSync;
}

const FALLBACK: Record<Catalogo, string> = {
  productos: "Error al cargar productos.",
  impuestos: "Error al cargar impuestos.",
  formasPago: "Error al cargar formas de pago.",
  tiposComprobante: "Error al cargar tipos de comprobante.",
  vendedores: "Error al cargar vendedores.",
};

/**
 * Sección plegable "Catálogos Siigo". Los 5 catálogos se piden SOLO al
 * expandirla (antes se disparaban al montar la página) y salen del caché
 * compartido con "Configuración de envío Siigo".
 */
export function SiigoProductos() {
  const { toast } = useToast();
  const confirmar = useConfirm();
  const panelId = useId();

  const [expandido, setExpandido] = useState(false);
  const [cargado, setCargado] = useState(false);

  const productos = useCatalogo(catalogoProductos, FALLBACK.productos);
  const impuestos = useCatalogo(catalogoImpuestos, FALLBACK.impuestos);
  const formasPago = useCatalogo(catalogoFormasPago, FALLBACK.formasPago);
  const tiposComprobante = useCatalogo(catalogoTiposComprobante, FALLBACK.tiposComprobante);
  const vendedores = useCatalogo(catalogoVendedores, FALLBACK.vendedores);

  const cargas: Record<Catalogo, { loadState: LoadState; loadError: string | null; recargar: () => void }> = {
    productos,
    impuestos,
    formasPago,
    tiposComprobante,
    vendedores,
  };

  const [sync, setSync] = useState<EstadoSync>(syncInicial);
  const [modal, setModal] = useState<Catalogo | null>(null);

  function alternar() {
    const abrir = !expandido;
    setExpandido(abrir);
    if (abrir && !cargado) {
      setCargado(true);
      for (const c of ORDEN) cargas[c].recargar();
    }
  }

  function refrescar(catalogo: Catalogo) {
    invalidarCatalogos(catalogo);
    cargas[catalogo].recargar();
  }

  async function sincronizar(catalogo: Catalogo) {
    const def = DEF[catalogo];
    // Sobrescribe el catálogo local con lo que haya en Siigo: se confirma.
    const ok = await confirmar({
      title: `¿Sincronizar ${def.plural} desde Siigo?`,
      description: `El catálogo local de ${def.plural} se reemplaza con los datos actuales de Siigo.`,
      confirmText: "Sincronizar",
    });
    if (!ok) return;

    setSync((prev) => ({ ...prev, [catalogo]: { state: "syncing", message: null } }));
    let resultado: { state: SyncState; message: string } = {
      state: "error",
      message: `No fue posible sincronizar los ${def.plural}.`,
    };
    try {
      const result = await def.sync();
      if (result.ok) {
        resultado = { state: "success", message: `${result.total} ${def.plural} ${def.participio}.` };
        toast({ title: `${def.titulo} sincronizados`, description: resultado.message, variant: "success" });
        refrescar(catalogo);
      } else {
        const prefijo =
          result.tipo === "config"
            ? "Credenciales Siigo no configuradas."
            : result.tipo === "api"
              ? "Error al conectar con Siigo."
              : "Error interno al guardar.";
        resultado = { state: "error", message: `${prefijo} ${result.error}` };
        toast({ title: `No se pudo sincronizar ${def.plural}`, description: resultado.message, variant: "error" });
      }
    } catch (caught) {
      resultado = { state: "error", message: describirError(caught, resultado.message) };
      toast({ title: `No se pudo sincronizar ${def.plural}`, description: resultado.message, variant: "error" });
    } finally {
      // Pase lo que pase, el botón sale de "Sincronizando…".
      setSync((prev) => ({ ...prev, [catalogo]: resultado }));
    }
  }

  async function handleSaveImpuestos(productoId: string, impuestoIds: number[]) {
    let result: { ok: boolean; error?: string };
    try {
      result = await setImpuestosProducto(productoId, impuestoIds);
    } catch (caught) {
      result = { ok: false, error: describirError(caught, "Error al guardar impuestos.") };
    }
    if (!result.ok) {
      const mensaje = result.error ?? "Error al guardar impuestos.";
      toast({ title: "No se pudieron guardar los impuestos", description: mensaje, variant: "error" });
      throw new Error(mensaje);
    }
    toast({ title: "Impuestos del producto guardados", variant: "success" });
    refrescar("productos");
  }

  const datos: Record<Catalogo, { total: number; ultimaSync: string | null }> = {
    productos: { total: productos.data?.total ?? 0, ultimaSync: productos.data?.ultimaSync ?? null },
    impuestos: { total: impuestos.data?.total ?? 0, ultimaSync: impuestos.data?.ultimaSync ?? null },
    formasPago: { total: formasPago.data?.total ?? 0, ultimaSync: formasPago.data?.ultimaSync ?? null },
    tiposComprobante: {
      total: tiposComprobante.data?.total ?? 0,
      ultimaSync: tiposComprobante.data?.ultimaSync ?? null,
    },
    vendedores: { total: vendedores.data?.total ?? 0, ultimaSync: vendedores.data?.ultimaSync ?? null },
  };

  return (
    <>
      <div className="space-y-2">
        <button
          type="button"
          onClick={alternar}
          aria-expanded={expandido}
          aria-controls={panelId}
          className="flex w-full items-center justify-between gap-4 border border-slate-200 bg-white px-5 py-3 text-left transition hover:bg-slate-50"
        >
          <div>
            <h2 className="text-base font-semibold">Catálogos Siigo</h2>
            <p className="text-xs text-slate-500">
              Productos, impuestos, formas de pago, tipos de comprobante y vendedores
              sincronizados desde Siigo.
            </p>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-slate-500 transition ${expandido ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>

        {expandido ? (
          <div id={panelId} className="space-y-2">
            {ORDEN.map((catalogo) => (
              <SyncRow
                key={catalogo}
                titulo={DEF[catalogo].titulo}
                ultimaSync={datos[catalogo].ultimaSync}
                total={datos[catalogo].total}
                loadState={cargas[catalogo].loadState}
                loadError={cargas[catalogo].loadError}
                syncState={sync[catalogo].state}
                syncMessage={sync[catalogo].message}
                onSync={() => void sincronizar(catalogo)}
                onVerCatalogo={() => setModal(catalogo)}
                onRetry={() => refrescar(catalogo)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {modal === "productos" ? (
        <ProductosModal
          productos={productos.data?.productos ?? []}
          impuestosCatalogo={impuestos.data?.impuestos ?? []}
          loadState={productos.loadState}
          loadError={productos.loadError}
          total={datos.productos.total}
          onRetry={() => refrescar("productos")}
          onSaveImpuestos={handleSaveImpuestos}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === "impuestos" ? (
        <TablaCatalogoModal
          title="Impuestos Siigo"
          description={`${datos.impuestos.total} impuestos en el catálogo local.`}
          rows={impuestos.data?.impuestos ?? []}
          columnas={COLUMNAS_IMPUESTOS}
          vacio="Sin impuestos sincronizados."
          loadState={impuestos.loadState}
          loadError={impuestos.loadError}
          errorTitulo="No se pudieron cargar los impuestos"
          onRetry={() => refrescar("impuestos")}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === "formasPago" ? (
        <TablaCatalogoModal
          title="Formas de pago Siigo"
          description={`${datos.formasPago.total} formas de pago en el catálogo local. Se seleccionan por borrador antes de enviar a Siigo.`}
          rows={formasPago.data?.formasPago ?? []}
          columnas={COLUMNAS_FORMAS_PAGO}
          vacio="Sin formas de pago sincronizadas."
          loadState={formasPago.loadState}
          loadError={formasPago.loadError}
          errorTitulo="No se pudieron cargar las formas de pago"
          onRetry={() => refrescar("formasPago")}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === "tiposComprobante" ? (
        <TablaCatalogoModal
          title="Tipos de comprobante Siigo"
          description={`${datos.tiposComprobante.total} tipos en el catálogo local. Se selecciona uno en la configuración de envío.`}
          rows={tiposComprobante.data?.tiposComprobante ?? []}
          columnas={COLUMNAS_TIPOS}
          vacio="Sin tipos de comprobante sincronizados."
          loadState={tiposComprobante.loadState}
          loadError={tiposComprobante.loadError}
          errorTitulo="No se pudieron cargar los tipos"
          onRetry={() => refrescar("tiposComprobante")}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === "vendedores" ? (
        <TablaCatalogoModal
          title="Vendedores Siigo"
          description={`${datos.vendedores.total} usuarios en el catálogo local.`}
          rows={vendedores.data?.vendedores ?? []}
          columnas={COLUMNAS_VENDEDORES}
          vacio="Sin vendedores sincronizados."
          loadState={vendedores.loadState}
          loadError={vendedores.loadError}
          errorTitulo="No se pudieron cargar los vendedores"
          onRetry={() => refrescar("vendedores")}
          onClose={() => setModal(null)}
          size="xl"
        />
      ) : null}
    </>
  );
}
