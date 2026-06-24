"use client";

/**
 * Editor de líneas manuales de la factura de venta (flujo del socio Lucho).
 * Permite escribir ítems a mano y vincularlos N↔N a facturas de proveedor.
 * El total por líneas se muestra en vivo (BigInt) frente al total del motor (referencia).
 */

import { Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchFacturasProveedor,
  type FacturaProveedorRow,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

import {
  fetchSiigoProductos,
  type SiigoProductoRow,
} from "@/components/configuracion/siigo-productos-api";

import {
  actualizarComentariosCabecera as apiActualizarComentarios,
  actualizarLinea as apiActualizarLinea,
  crearLineaManual as apiCrearLinea,
  eliminarLinea as apiEliminarLinea,
  formatCOP,
  parseBigIntInput,
  type BorradorRow,
  type LineaRevisionRow,
  type SeccionLinea,
} from "./facturacion-api";

const ETIQUETA_SECCION: Record<SeccionLinea, string> = {
  TERCEROS: "Ingresos recibidos para terceros",
  OPERACIONAL: "Ingresos operacionales",
};

// ─── Multi-select desplegable de facturas de proveedor ─────────────────────────

type FacturasMultiSelectProps = {
  facturas: FacturaProveedorRow[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

function FacturasMultiSelect({
  facturas,
  selectedIds,
  onToggle,
  disabled = false,
  placeholder = "Vincular facturas…",
}: FacturasMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const seleccionadas = facturas.filter((f) => selectedIds.includes(f.id));
  const nombres = seleccionadas.map((f) => f.proveedorNombre);

  if (facturas.length === 0) {
    return (
      <span className="text-sm text-slate-400">Sin facturas en el trámite</span>
    );
  }

  return (
    <div ref={containerRef} className="relative inline-block w-full max-w-md">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`flex min-h-11 w-full items-center justify-between gap-2 border border-slate-300 bg-white px-3 py-2 text-left text-base transition ${
          disabled ? "cursor-default opacity-70" : "hover:border-slate-400"
        }`}
      >
        <span
          className={`truncate ${nombres.length === 0 ? "text-slate-400" : "text-slate-700"}`}
        >
          {nombres.length === 0 ? placeholder : nombres.join(", ")}
        </span>
        {!disabled ? (
          <ChevronDown
            className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open && !disabled ? (
        <div className="absolute z-20 mt-1 max-h-96 w-96 overflow-auto border border-slate-200 bg-white shadow-lg">
          {facturas.map((f) => {
            const activa = selectedIds.includes(f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onToggle(f.id)}
                className={`flex w-full items-start gap-3 border-b border-slate-100 px-3 py-3 text-left text-base last:border-b-0 transition ${
                  activa ? "bg-cyan-50" : "hover:bg-slate-50"
                }`}
              >
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border border-slate-300 bg-white">
                  {activa ? (
                    <Check
                      className="h-4 w-4 text-cyan-700"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-800">
                    {f.proveedorNombre}
                  </span>
                  <span className="block truncate text-sm text-slate-500">
                    {f.numFactura} · {formatCOP(f.valor)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ─── Comentarios de cabecera (formato Lucho) ──────────────────────────────────

type ComentariosCabeceraProps = {
  borrador: BorradorRow;
  puedeEditar: boolean;
  guardando: boolean;
  ejecutar: (accion: () => Promise<BorradorRow>) => Promise<void>;
};

function ComentariosCabecera({
  borrador,
  puedeEditar,
  guardando,
  ejecutar,
}: ComentariosCabeceraProps) {
  const [borradorLocal, setBorradorLocal] = useState<string[]>(
    borrador.comentariosCabecera,
  );

  // Resincronizar cuando llega un borrador nuevo desde el server
  useEffect(() => {
    setBorradorLocal(borrador.comentariosCabecera);
  }, [borrador.comentariosCabecera]);

  async function commit(siguiente: string[]) {
    await ejecutar(() => apiActualizarComentarios(borrador.id, siguiente));
  }

  function actualizar(idx: number, valor: string) {
    setBorradorLocal((prev) => {
      const next = [...prev];
      next[idx] = valor;
      return next;
    });
  }

  function commitFila(idx: number) {
    const original = borrador.comentariosCabecera[idx] ?? "";
    const actual = borradorLocal[idx] ?? "";
    if (actual.trim() === original.trim()) return;
    void commit(borradorLocal);
  }

  function agregar() {
    const siguiente = [...borradorLocal, ""];
    setBorradorLocal(siguiente);
  }

  function eliminar(idx: number) {
    const siguiente = borradorLocal.filter((_, i) => i !== idx);
    setBorradorLocal(siguiente);
    void commit(siguiente);
  }

  // Modo solo lectura
  if (!puedeEditar) {
    if (borradorLocal.length === 0) return null;
    return (
      <div className="border border-slate-300 bg-white">
        <div className="border-b border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
          Concepto
        </div>
        {borradorLocal.map((texto, idx) => (
          <div
            key={idx}
            className="border-b border-slate-200 px-3 py-2 text-sm text-slate-800 last:border-b-0"
          >
            {texto}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="border border-slate-300 bg-white">
      <div className="flex items-center justify-between border-b border-slate-300 bg-slate-100 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">
          Comentarios de cabecera (formato factura)
        </span>
        <button
          type="button"
          onClick={agregar}
          disabled={guardando || borradorLocal.length >= 20}
          className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Agregar fila
        </button>
      </div>
      {borradorLocal.length === 0 ? (
        <div className="px-3 py-3 text-sm text-slate-400">
          Sin comentarios. Agrega una fila para describir la factura.
        </div>
      ) : (
        borradorLocal.map((texto, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 border-b border-slate-200 px-2 py-1 last:border-b-0"
          >
            <input
              value={texto}
              onChange={(e) => actualizar(idx, e.target.value)}
              onBlur={() => commitFila(idx)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setBorradorLocal(borrador.comentariosCabecera);
                  e.currentTarget.blur();
                }
              }}
              disabled={guardando}
              placeholder={
                idx === 0
                  ? "Ej. FACTURA COMERCIAL No. … (proveedor/cliente)"
                  : idx === 1
                    ? "Ej. DO CTG26-0118. 1X40. Contenedor … BL.No. …"
                    : idx === 2
                      ? "Ej. Mercancía. Puerto de entrada."
                      : "Otro comentario…"
              }
              className="flex-1 border border-transparent bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-200 focus:border-slate-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => eliminar(idx)}
              disabled={guardando}
              aria-label={`Eliminar fila ${idx + 1}`}
              className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

type EditorLineasProps = {
  borrador: BorradorRow;
  tramiteId: string;
  puedeEditar: boolean;
  onBorradorActualizado: (borrador: BorradorRow) => void;
};

function sumaLineas(lineas: LineaRevisionRow[]): bigint {
  return lineas.reduce((acc, l) => {
    try {
      return acc + BigInt(l.valor);
    } catch {
      return acc;
    }
  }, 0n);
}

// ─── Subsección (tabla + formulario "Nueva línea") ───────────────────────────

type SubseccionProps = {
  titulo: string;
  seccion: SeccionLinea;
  lineas: LineaRevisionRow[];
  subtotal: bigint;
  facturas: FacturaProveedorRow[];
  productos: SiigoProductoRow[];
  puedeEditar: boolean;
  guardando: boolean;
  borradorId: string;
  ejecutar: (accion: () => Promise<BorradorRow>) => Promise<void>;
  setError: (msg: string) => void;
};

function SubseccionLineas({
  titulo,
  seccion,
  lineas,
  subtotal,
  facturas,
  productos,
  puedeEditar,
  guardando,
  borradorId,
  ejecutar,
  setError,
}: SubseccionProps) {
  // OPERACIONAL muestra solo Concepto + Valor (sin soporte ni vinculación).
  const compacto = seccion === "OPERACIONAL";

  const [nuevoConcepto, setNuevoConcepto] = useState("");
  const [nuevoValor, setNuevoValor] = useState("");
  const [nuevasFacturas, setNuevasFacturas] = useState<string[]>([]);
  const [nuevoSiigoProductoId, setNuevoSiigoProductoId] = useState("");

  const productoSeleccionado = productos.find((p) => p.id === nuevoSiigoProductoId) ?? null;

  async function handleCrear() {
    const valor = parseBigIntInput(nuevoValor);
    if (!nuevoConcepto.trim() || !valor) {
      setError("Concepto y valor (positivo) son obligatorios.");
      return;
    }
    // En TERCEROS el N° de soporte se deriva de la factura vinculada (server-side),
    // por eso no se envía numSoporte desde el formulario.
    await ejecutar(() =>
      apiCrearLinea(borradorId, {
        concepto: nuevoConcepto.trim(),
        valor,
        seccion,
        facturaIds: compacto ? [] : nuevasFacturas,
        siigoProductoId: nuevoSiigoProductoId || undefined,
      }),
    );
    setNuevoConcepto("");
    setNuevoValor("");
    setNuevasFacturas([]);
    setNuevoSiigoProductoId("");
  }

  function toggleNuevaFactura(id: string) {
    setNuevasFacturas((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function toggleFacturaLinea(
    linea: LineaRevisionRow,
    facturaId: string,
  ) {
    const next = linea.facturasVinculadas.includes(facturaId)
      ? linea.facturasVinculadas.filter((x) => x !== facturaId)
      : [...linea.facturasVinculadas, facturaId];
    await ejecutar(() =>
      apiActualizarLinea(borradorId, linea.id, { facturaIds: next }),
    );
  }

  // Columnas visibles: #, Concepto, [N°], Valor, [Facturas], [acciones]
  const colsAntes = compacto ? 2 : 3; // #, Concepto, [N°]
  const colsDespues = (compacto ? 0 : 1) + (puedeEditar ? 1 : 0); // [Facturas], [acciones]

  return (
    <section className="border border-slate-200">
      <header className="border-b border-slate-200 bg-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
        {titulo}
      </header>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-2 py-2">#</th>
            <th className="px-2 py-2">Concepto</th>
            {!compacto ? <th className="px-2 py-2">N° soporte</th> : null}
            <th className="px-2 py-2 text-right">Valor</th>
            {!compacto ? (
              <th className="px-2 py-2">Facturas de proveedor</th>
            ) : null}
            {puedeEditar ? <th className="px-2 py-2" /> : null}
          </tr>
        </thead>
        <tbody>
          {lineas.map((linea) => (
            <tr key={linea.id} className="border-b border-slate-100 align-top">
              <td className="px-2 py-2 text-slate-400">{linea.orden}</td>
              <td className="px-2 py-2">
                <span className="font-medium text-slate-800">{linea.concepto}</span>
                {linea.siigoProductoId ? (
                  <span className="ml-1 text-[10px] text-slate-400">
                    {linea.siigoProductoCodigo}
                    {" · "}
                    {linea.siigoClasificacionIva === "Taxed" ? "IVA 19%" : "Excluido"}
                  </span>
                ) : null}
              </td>
              {!compacto ? (
                <td className="px-2 py-2 font-mono text-slate-600">
                  {linea.numSoporte ?? "—"}
                </td>
              ) : null}
              <td className="px-2 py-2 text-right font-semibold text-slate-900">
                {formatCOP(linea.valor)}
              </td>
              {!compacto ? (
                <td className="px-2 py-2">
                  {puedeEditar ? (
                    <FacturasMultiSelect
                      facturas={facturas}
                      selectedIds={linea.facturasVinculadas}
                      onToggle={(id) => toggleFacturaLinea(linea, id)}
                      disabled={guardando}
                    />
                  ) : linea.facturasVinculadas.length === 0 ? (
                    <span className="text-xs text-slate-400">—</span>
                  ) : (
                    <span className="text-xs text-slate-700">
                      {facturas
                        .filter((f) => linea.facturasVinculadas.includes(f.id))
                        .map((f) => f.proveedorNombre)
                        .join(", ")}
                    </span>
                  )}
                </td>
              ) : null}
              {puedeEditar ? (
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() =>
                      ejecutar(() => apiEliminarLinea(borradorId, linea.id))
                    }
                    className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                  >
                    Eliminar
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
          {lineas.length === 0 ? (
            <tr>
              <td
                colSpan={colsAntes + 1 + colsDespues}
                className="px-2 py-3 text-center text-xs text-slate-400"
              >
                Sin líneas en esta sección.
              </td>
            </tr>
          ) : null}
          <tr className="border-t border-slate-300 bg-slate-50">
            <td
              colSpan={colsAntes}
              className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Subtotal {titulo}
            </td>
            <td className="px-2 py-2 text-right font-semibold text-slate-900">
              {formatCOP(subtotal.toString())}
            </td>
            {colsDespues > 0 ? <td colSpan={colsDespues} /> : null}
          </tr>
          {compacto ? (
            <>
              <tr className="bg-slate-50">
                <td
                  colSpan={colsAntes}
                  className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  IVA (19%)
                </td>
                <td className="px-2 py-2 text-right text-slate-700">
                  {formatCOP((subtotal * 19n / 100n).toString())}
                </td>
                {colsDespues > 0 ? <td colSpan={colsDespues} /> : null}
              </tr>
              <tr className="border-t border-slate-200 bg-slate-50">
                <td
                  colSpan={colsAntes}
                  className="px-2 py-2 text-right text-xs font-semibold uppercase tracking-wide text-slate-700"
                >
                  Total con IVA
                </td>
                <td className="px-2 py-2 text-right font-bold text-slate-900">
                  {formatCOP((subtotal + subtotal * 19n / 100n).toString())}
                </td>
                {colsDespues > 0 ? <td colSpan={colsDespues} /> : null}
              </tr>
            </>
          ) : null}
        </tbody>
      </table>

      {puedeEditar ? (
        <div className="border-t border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Nueva línea en {titulo.toLowerCase()}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-slate-600">
              Producto Siigo
              <select
                value={nuevoSiigoProductoId}
                onChange={(e) => {
                  const id = e.target.value;
                  setNuevoSiigoProductoId(id);
                  const prod = productos.find((p) => p.id === id);
                  if (prod) setNuevoConcepto(prod.nombre);
                }}
                className="mt-1 w-64 border border-slate-300 bg-white px-2 py-1 text-sm"
              >
                <option value="">— Seleccionar —</option>
                {productos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.codigo} — {p.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-slate-600">
              Concepto en factura
              <input
                value={nuevoConcepto}
                onChange={(e) => setNuevoConcepto(e.target.value)}
                className="mt-1 w-56 border border-slate-300 px-2 py-1 text-sm"
                placeholder={
                  seccion === "TERCEROS"
                    ? "Ej. Impuestos aduanas importación"
                    : "Ej. Logística Comercio Exterior Galcomex"
                }
              />
            </label>
            {productoSeleccionado ? (
              <span
                className={`mb-1 self-end rounded px-2 py-0.5 text-xs font-medium ${
                  productoSeleccionado.clasificacionIva === "Taxed"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {productoSeleccionado.clasificacionIva === "Taxed" ? "IVA 19%" : "Excluido IVA"}
              </span>
            ) : null}
            <label className="flex flex-col text-xs text-slate-600">
              Valor (COP)
              <input
                value={nuevoValor}
                onChange={(e) => setNuevoValor(e.target.value)}
                className="mt-1 w-36 border border-slate-300 px-2 py-1 text-right text-sm"
                placeholder="0"
                inputMode="numeric"
              />
            </label>
            <button
              type="button"
              disabled={guardando}
              onClick={handleCrear}
              className="border border-cyan-600 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-cyan-700 disabled:opacity-50"
            >
              Agregar
            </button>
          </div>
          {!compacto && facturas.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Vincular facturas:</span>
                <FacturasMultiSelect
                  facturas={facturas}
                  selectedIds={nuevasFacturas}
                  onToggle={toggleNuevaFactura}
                />
              </div>
              <span className="text-[11px] text-slate-400">
                El N° de soporte se toma del número de la factura vinculada.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function EditorLineas({
  borrador,
  tramiteId,
  puedeEditar,
  onBorradorActualizado,
}: EditorLineasProps) {
  const [facturas, setFacturas] = useState<FacturaProveedorRow[]>([]);
  const [productos, setProductos] = useState<SiigoProductoRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchFacturasProveedor(tramiteId, controller.signal)
      .then(setFacturas)
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Sin facturas no se bloquea la edición de líneas.
      });
    return () => controller.abort();
  }, [tramiteId]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSiigoProductos(controller.signal)
      .then((payload) => setProductos(payload.productos))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Sin productos el selector queda vacío — no bloquea la edición.
      });
    return () => controller.abort();
  }, []);

  const lineasTerceros = useMemo(
    () => borrador.lineasRevision.filter((l) => l.seccion === "TERCEROS"),
    [borrador.lineasRevision],
  );
  const lineasOperacional = useMemo(
    () => borrador.lineasRevision.filter((l) => l.seccion === "OPERACIONAL"),
    [borrador.lineasRevision],
  );

  const subtotalTerceros = useMemo(
    () => sumaLineas(lineasTerceros),
    [lineasTerceros],
  );
  const subtotalOperacional = useMemo(
    () => sumaLineas(lineasOperacional),
    [lineasOperacional],
  );

  const totalLineasVivo = useMemo(() => {
    try {
      return (
        subtotalTerceros +
        subtotalOperacional +
        BigInt(borrador.comision) +
        BigInt(borrador.ivaComision) -
        BigInt(borrador.retenciones)
      );
    } catch {
      return 0n;
    }
  }, [
    subtotalTerceros,
    subtotalOperacional,
    borrador.comision,
    borrador.ivaComision,
    borrador.retenciones,
  ]);

  const totalMotor = (() => {
    try {
      return BigInt(borrador.totalFactura);
    } catch {
      return 0n;
    }
  })();

  const desviacion = totalLineasVivo - totalMotor;

  async function ejecutar(accion: () => Promise<BorradorRow>) {
    setGuardando(true);
    setError(null);
    try {
      const actualizado = await accion();
      onBorradorActualizado(actualizado);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar la línea.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <ComentariosCabecera
        borrador={borrador}
        puedeEditar={puedeEditar}
        guardando={guardando}
        ejecutar={ejecutar}
      />

      <SubseccionLineas
        titulo={ETIQUETA_SECCION.TERCEROS}
        seccion="TERCEROS"
        lineas={lineasTerceros}
        subtotal={subtotalTerceros}
        facturas={facturas}
        productos={productos}
        puedeEditar={puedeEditar}
        guardando={guardando}
        borradorId={borrador.id}
        ejecutar={ejecutar}
        setError={setError}
      />

      <SubseccionLineas
        titulo={ETIQUETA_SECCION.OPERACIONAL}
        seccion="OPERACIONAL"
        lineas={lineasOperacional}
        subtotal={subtotalOperacional}
        facturas={facturas}
        productos={productos}
        puedeEditar={puedeEditar}
        guardando={guardando}
        borradorId={borrador.id}
        ejecutar={ejecutar}
        setError={setError}
      />

      <div className="flex flex-col items-end gap-1 border-t border-slate-200 pt-3 text-sm">
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-600">Σ Ingresos para terceros</span>
          <span className="text-slate-800">
            {formatCOP(subtotalTerceros.toString())}
          </span>
        </div>
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-600">Σ Ingresos operacionales</span>
          <span className="text-slate-800">
            {formatCOP(subtotalOperacional.toString())}
          </span>
        </div>
        <div className="flex w-full max-w-md justify-between border-b border-slate-200 pb-1">
          <span className="text-slate-500">+ IVA operacional (19%)</span>
          <span className="text-slate-800">
            {formatCOP((subtotalOperacional * 19n / 100n).toString())}
          </span>
        </div>
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-500">+ Comisión</span>
          <span className="text-slate-800">{formatCOP(borrador.comision)}</span>
        </div>
        <div className="flex w-full max-w-md justify-between">
          <span className="text-slate-500">+ IVA comisión</span>
          <span className="text-slate-800">
            {formatCOP(borrador.ivaComision)}
          </span>
        </div>
        {(() => {
          try {
            return BigInt(borrador.retenciones) > 0n;
          } catch {
            return false;
          }
        })() ? (
          <div className="flex w-full max-w-md justify-between">
            <span className="text-slate-500">− Retenciones</span>
            <span className="text-slate-800">
              {formatCOP(borrador.retenciones)}
            </span>
          </div>
        ) : null}
        <div className="flex w-full max-w-md justify-between border-t-2 border-slate-300 pt-1">
          <span className="font-semibold text-slate-900">= Total factura</span>
          <span className="font-bold text-slate-900">
            {formatCOP(totalLineasVivo.toString())}
          </span>
        </div>
        <div className="mt-1 flex w-full max-w-md justify-between text-xs">
          <span className="text-slate-400">Total motor (referencia)</span>
          <span className="text-slate-500">
            {formatCOP(totalMotor.toString())}
          </span>
        </div>
        {desviacion !== 0n ? (
          <div className="flex w-full max-w-md justify-between border border-amber-200 bg-amber-50 px-2 py-1">
            <span className="font-medium text-amber-700">
              Desviación vs. motor
            </span>
            <span className="font-bold text-amber-700">
              {formatCOP(desviacion.toString())}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
