"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  ALCANCES,
  DISPARADORES,
  TIPOS_CALCULO,
  UNIDADES,
  actualizarItem,
  agregarItem,
  cambiarEstadoTarifario,
  crearTarifario,
  describirCalculo,
  duplicarTarifario,
  eliminarItem,
  eliminarTarifario,
  etiquetaEstado,
  fetchEventosCatalogo,
  fetchPlantillas,
  fetchTarifarios,
  fetchTarifariosLigero,
  formatCOP,
  formatFecha,
  type DisparadorTarifa,
  type EventoCatalogoRow,
  type PlantillaRow,
  type TarifaItemForm,
  type TarifaItemRow,
  type TarifarioLigero,
  type TarifarioRow,
  type TipoCalculoTarifa,
  type UnidadTarifa,
} from "@/components/clientes/tarifas-api";
import {
  fetchConceptosVenta,
  type ConceptoVentaRow,
} from "@/components/configuracion/catalogos/catalogos-api";
import { ModuleState } from "@/components/layout/module-state";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";
import { ejemploTramo } from "@/lib/tarifas/motor";

type LoadState = "loading" | "ready" | "error";

const INPUT = "h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-cyan-600 disabled:bg-slate-50";
const LABEL = "text-xs font-medium text-slate-600";
const BTN = "inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARIO = `${BTN} border-slate-950 bg-slate-950 text-white hover:bg-slate-800`;
const BTN_SECUNDARIO = `${BTN} border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
const BTN_PELIGRO = `${BTN} border-red-200 bg-white text-red-700 hover:bg-red-50`;

function alcanceLabel(alcance: string): string {
  return ALCANCES.find((a) => a.value === alcance)?.label ?? alcance;
}

function estadoClase(estado: TarifarioRow["estado"]): string {
  switch (estado) {
    case "VIGENTE":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "BORRADOR":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "VENCIDO":
      return "border-red-200 bg-red-50 text-red-700";
    case "REEMPLAZADO":
      return "border-slate-200 bg-slate-100 text-slate-600";
  }
}

function soloDigitos(raw: string): string {
  return raw.replace(/\D/g, "");
}

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function unAnioDespues(desde: string): string {
  const d = new Date(`${desde}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Modal: nuevo tarifario ───────────────────────────────────────────────────

function NuevoTarifarioModal({
  clienteId,
  onClose,
  onCreated,
}: {
  clienteId: string;
  onClose: () => void;
  onCreated: (t: TarifarioRow) => void;
}) {
  const [plantillas, setPlantillas] = useState<PlantillaRow[]>([]);
  const [otrasEmpresas, setOtrasEmpresas] = useState<TarifarioLigero[]>([]);
  const [plantilla, setPlantilla] = useState("");
  const [origenId, setOrigenId] = useState("");
  const [nombre, setNombre] = useState("");
  const [alcance, setAlcance] = useState("TRAMITE");
  const [desde, setDesde] = useState(hoyIso());
  const [hasta, setHasta] = useState(unAnioDespues(hoyIso()));
  const [notas, setNotas] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchPlantillas(controller.signal)
      .then(setPlantillas)
      .catch(() => setPlantillas([]));
    fetchTarifariosLigero(clienteId, controller.signal)
      .then(setOtrasEmpresas)
      .catch(() => setOtrasEmpresas([]));
    return () => controller.abort();
  }, [clienteId]);

  /** Valor combinado del <select>: "plantilla:<codigo>" u "origen:<id>". */
  function elegirFuente(valorCombinado: string) {
    if (valorCombinado === "") {
      setPlantilla("");
      setOrigenId("");
      return;
    }
    const separador = valorCombinado.indexOf(":");
    const tipo = valorCombinado.slice(0, separador);
    const valor = valorCombinado.slice(separador + 1);

    if (tipo === "plantilla") {
      setPlantilla(valor);
      setOrigenId("");
      const p = plantillas.find((x) => x.codigo === valor);
      if (p) {
        setNombre(p.nombre);
        setAlcance(p.alcance);
      }
    } else if (tipo === "origen") {
      setOrigenId(valor);
      setPlantilla("");
      const t = otrasEmpresas.find((x) => x.id === valor);
      if (t) {
        setNombre(t.nombre);
        setAlcance(t.alcance);
      }
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    setError(null);
    setEnviando(true);
    try {
      const creado = await crearTarifario(clienteId, {
        plantilla: plantilla || undefined,
        origenTarifarioId: origenId || undefined,
        nombre: nombre.trim() || undefined,
        alcance,
        vigenteDesde: desde,
        vigenteHasta: hasta,
        notas: notas.trim() || undefined,
      });
      onCreated(creado);
    } catch (caught) {
      setError(describirError(caught, "No fue posible crear el tarifario."));
    } finally {
      setEnviando(false);
    }
  }

  const plantillaSel = plantillas.find((p) => p.codigo === plantilla);
  const origenSel = otrasEmpresas.find((t) => t.id === origenId);
  const valorFuente = plantilla ? `plantilla:${plantilla}` : origenId ? `origen:${origenId}` : "";

  return (
    <ModalShell open onClose={onClose} title="Nuevo tarifario" description="Nace como borrador: se revisan los ítems y se publica." size="lg" dismissible={!enviando}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <label className="block space-y-1">
          <span className={LABEL}>Arrancar desde</span>
          <select value={valorFuente} onChange={(e) => elegirFuente(e.target.value)} className={INPUT}>
            <option value="">En blanco (agregar ítems a mano)</option>
            <optgroup label="Propuestas (plantillas)">
              {plantillas.map((p) => (
                <option key={`plantilla:${p.codigo}`} value={`plantilla:${p.codigo}`}>
                  {p.cliente} · {p.nombre} · {alcanceLabel(p.alcance)} · {p.items} ítems
                </option>
              ))}
            </optgroup>
            {otrasEmpresas.length > 0 ? (
              <optgroup label="Copiar la tarifa de otra empresa">
                {otrasEmpresas.map((t) => (
                  <option key={`origen:${t.id}`} value={`origen:${t.id}`}>
                    {t.empresaNombre} · {t.nombre} · v{t.version} · {etiquetaEstado(t.estado)} · {t.items} ítems
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {plantillaSel ? <p className="text-xs text-slate-500">{plantillaSel.descripcion}</p> : null}
          {origenSel ? (
            <p className="text-xs text-slate-500">
              Copia los {origenSel.items} ítems de &quot;{origenSel.nombre}&quot; v{origenSel.version} de {origenSel.empresaNombre}, tal cual (sin incremento).
            </p>
          ) : null}
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Nombre *</span>
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} required className={INPUT} placeholder="Tarifas 2026 importaciones" />
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Alcance</span>
            <select value={alcance} onChange={(e) => setAlcance(e.target.value)} className={INPUT}>
              {ALCANCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Vigente desde *</span>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} required className={INPUT} />
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Vigente hasta *</span>
            <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} required className={INPUT} />
          </label>
        </div>

        <label className="block space-y-1">
          <span className={LABEL}>Nota interna (no sale en el PDF)</span>
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600" />
        </label>

        {error ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={enviando} className={BTN_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando} className={BTN_PRIMARIO}>
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            Crear borrador
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Modal: duplicar ──────────────────────────────────────────────────────────

function DuplicarModal({ tarifario, onClose, onCreated }: { tarifario: TarifarioRow; onClose: () => void; onCreated: (t: TarifarioRow) => void }) {
  const siguienteDesde = (() => {
    const d = new Date(tarifario.vigenteHasta);
    if (Number.isNaN(d.getTime())) return hoyIso();
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const [nombre, setNombre] = useState(tarifario.nombre);
  const [desde, setDesde] = useState(siguienteDesde);
  const [hasta, setHasta] = useState(unAnioDespues(siguienteDesde));
  const [incremento, setIncremento] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    setError(null);
    const pct = incremento.trim() ? Number(incremento.replace(",", ".")) : undefined;
    if (pct !== undefined && Number.isNaN(pct)) {
      setError("El incremento debe ser un número (p. ej. 5,29).");
      return;
    }
    setEnviando(true);
    try {
      onCreated(await duplicarTarifario(tarifario.id, { nombre: nombre.trim() || undefined, vigenteDesde: desde, vigenteHasta: hasta, incrementoPct: pct }));
    } catch (caught) {
      setError(describirError(caught, "No fue posible duplicar el tarifario."));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ModalShell open onClose={onClose} title={`Duplicar versión ${tarifario.version}`} description="Crea la versión siguiente como borrador, con la vigencia nueva y el incremento que quieras (IPC)." size="md" dismissible={!enviando}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <label className="block space-y-1">
          <span className={LABEL}>Nombre</span>
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={INPUT} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Vigente desde *</span>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} required className={INPUT} />
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Vigente hasta *</span>
            <input type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} required className={INPUT} />
          </label>
        </div>
        <label className="block space-y-1">
          <span className={LABEL}>Incremento % (opcional, redondea a miles)</span>
          <input value={incremento} onChange={(e) => setIncremento(e.target.value)} inputMode="decimal" placeholder="5,29" className={INPUT} />
        </label>
        {error ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={enviando} className={BTN_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando} className={BTN_PRIMARIO}>
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            Duplicar
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Modal: ítem ──────────────────────────────────────────────────────────────

type ItemFormState = {
  concepto: string;
  nombrePublico: string;
  siigoCodigo: string;
  tipoCalculo: TipoCalculoTarifa;
  disparador: DisparadorTarifa;
  eventoCodigo: string;
  unidad: UnidadTarifa;
  valor: string;
  valorAdicional: string;
  porcentaje: string; // en % con decimales (0,37)
  minSuelta: string;
  min20: string;
  min40: string;
  conceptoCosto: string;
  /** POR_TRAMO: filas "hasta N unidades → valor". `hasta` vacío = en adelante. */
  tramos: { hasta: string; valor: string }[];
  aplicaIva: boolean;
  orden: string;
  notas: string;
};

const TRAMOS_VACIOS = [
  { hasta: "1", valor: "" },
  { hasta: "", valor: "" },
];

function estadoDesdeItem(item: TarifaItemRow | null, orden: number): ItemFormState {
  return {
    concepto: item?.concepto ?? "",
    nombrePublico: item?.nombrePublico ?? "",
    siigoCodigo: item?.siigoCodigo ?? "",
    tipoCalculo: item?.tipoCalculo ?? "FIJO",
    disparador: item?.disparador ?? "SIEMPRE",
    eventoCodigo: item?.eventoCodigo ?? "",
    unidad: item?.unidad ?? "TRAMITE",
    valor: item?.valor && item.valor !== "0" ? item.valor : "",
    valorAdicional: item?.valorAdicional ?? "",
    porcentaje: item?.porcentajeBps ? (item.porcentajeBps / 100).toString().replace(".", ",") : "",
    minSuelta: item?.minimos?.SUELTA ?? "",
    min20: item?.minimos?.CONTENEDOR_20 ?? "",
    min40: item?.minimos?.CONTENEDOR_40 ?? "",
    conceptoCosto: item?.conceptoCosto ?? "",
    tramos: item?.tramos?.length
      ? item.tramos.map((t) => ({ hasta: t.hasta === null ? "" : String(t.hasta), valor: t.valor }))
      : TRAMOS_VACIOS.map((t) => ({ ...t })),
    aplicaIva: item?.aplicaIva ?? true,
    orden: String(item?.orden ?? orden),
    notas: item?.notas ?? "",
  };
}

function formDesdeEstado(s: ItemFormState): TarifaItemForm {
  const pct = s.porcentaje.trim() ? Number(s.porcentaje.replace(",", ".")) : NaN;
  const minimos = s.tipoCalculo === "PORCENTAJE_MIN"
    ? {
        ...(s.minSuelta ? { SUELTA: s.minSuelta } : {}),
        ...(s.min20 ? { CONTENEDOR_20: s.min20 } : {}),
        ...(s.min40 ? { CONTENEDOR_40: s.min40 } : {}),
      }
    : null;
  return {
    concepto: s.concepto.trim().toUpperCase().replace(/\s+/g, "_"),
    nombrePublico: s.nombrePublico.trim(),
    siigoCodigo: s.siigoCodigo.trim() || null,
    tipoCalculo: s.tipoCalculo,
    disparador: s.disparador,
    eventoCodigo: s.disparador === "EVENTO" ? s.eventoCodigo || null : null,
    unidad: s.unidad,
    valor: s.valor || "0",
    valorAdicional: s.tipoCalculo === "PRIMERO_MAS_ADICIONAL" ? s.valorAdicional || null : null,
    porcentajeBps: s.tipoCalculo === "PORCENTAJE_MIN" && !Number.isNaN(pct) ? Math.round(pct * 100) : null,
    minimos: minimos && Object.keys(minimos).length ? minimos : null,
    conceptoCosto: s.tipoCalculo === "ESPEJO_DE_COSTO" ? s.conceptoCosto.trim() || null : null,
    tramos:
      s.tipoCalculo === "POR_TRAMO"
        ? s.tramos
            .filter((t) => t.valor.trim() !== "")
            .map((t) => ({ hasta: t.hasta.trim() === "" ? null : Number(t.hasta), valor: t.valor.trim() }))
        : null,
    aplicaIva: s.aplicaIva,
    notas: s.notas.trim() || null,
    orden: Number(s.orden) || 0,
  };
}

// ─── Selector buscable de concepto de venta (mismo patrón de SiigoProductoSelect, conceptos-tab.tsx) ──

function etiquetaConcepto(c: ConceptoVentaRow): string {
  return c.siigoProducto ? `${c.nombre} — Siigo ${c.siigoProducto.codigo} ${c.siigoProducto.nombre}` : c.nombre;
}

function ConceptoVentaSelect({
  conceptos,
  value,
  onSelect,
}: {
  conceptos: ConceptoVentaRow[];
  value: string;
  onSelect: (concepto: ConceptoVentaRow) => void;
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

  const seleccionado = conceptos.find((c) => c.codigo === value) ?? null;

  const filtrados = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return conceptos;
    return conceptos.filter(
      (c) =>
        c.nombre.toLowerCase().includes(q) ||
        c.codigo.toLowerCase().includes(q) ||
        (c.siigoProducto?.codigo.toLowerCase().includes(q) ?? false) ||
        (c.siigoProducto?.nombre.toLowerCase().includes(q) ?? false),
    );
  }, [conceptos, query]);

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-10 w-full items-center justify-between gap-2 border bg-white px-3 text-left text-sm transition hover:border-slate-400 ${
          value && !seleccionado ? "border-red-300" : "border-slate-300"
        }`}
      >
        <span className={`truncate ${seleccionado ? "text-slate-900" : value ? "text-red-600" : "text-slate-400"}`}>
          {seleccionado
            ? etiquetaConcepto(seleccionado)
            : value
              ? "Este concepto no está en el catálogo; elige uno"
              : "Selecciona un concepto…"}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="absolute z-30 mt-1 max-h-80 w-full overflow-hidden border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-200 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre o código Siigo…"
              className="w-full border border-slate-300 px-2 py-1 text-sm focus:border-slate-400 focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-auto">
            {filtrados.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-slate-400">
                {conceptos.length === 0
                  ? "No hay conceptos activos en el catálogo."
                  : "No hay conceptos con ese nombre o código."}
              </p>
            ) : (
              filtrados.map((c) => {
                const activo = c.codigo === value;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onSelect(c);
                      cerrar();
                    }}
                    className={`block w-full border-b border-slate-100 px-3 py-2 text-left text-sm last:border-b-0 transition ${
                      activo ? "bg-cyan-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="block font-medium text-slate-800">{etiquetaConcepto(c)}</span>
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

/** Validación del editor de escalas (B6): ascendente, solo la última puede quedar abierta. */
function validarEscalas(tramos: { hasta: string; valor: string }[]): string | null {
  if (tramos.length === 0) return "Agrega al menos una escala.";
  let anterior = 0;
  for (let i = 0; i < tramos.length; i++) {
    const t = tramos[i]!;
    const esUltimo = i === tramos.length - 1;
    if (!t.valor.trim()) return `Escala ${i + 1}: falta el precio por unidad.`;
    if (t.hasta.trim() === "") {
      if (!esUltimo) return `Solo la última escala puede quedar sin "Hasta" (en adelante).`;
    } else {
      const n = Number(t.hasta);
      if (!Number.isInteger(n) || n <= anterior) {
        return `Escala ${i + 1}: "Hasta" debe ser un número mayor que ${anterior}, en orden ascendente.`;
      }
      anterior = n;
    }
  }
  return null;
}

/** "Desde" de la fila i: 1 en la primera, "Hasta" de la anterior + 1 en las demás. */
function desdeDeEscala(tramos: { hasta: string; valor: string }[], i: number): number | null {
  if (i === 0) return 1;
  const anterior = Number(tramos[i - 1]?.hasta);
  return Number.isInteger(anterior) && anterior > 0 ? anterior + 1 : null;
}

function ItemModal({
  tarifario,
  item,
  eventos,
  conceptos,
  onClose,
  onSaved,
}: {
  tarifario: TarifarioRow;
  item: TarifaItemRow | null;
  eventos: EventoCatalogoRow[];
  conceptos: ConceptoVentaRow[];
  onClose: () => void;
  onSaved: (t: TarifarioRow) => void;
}) {
  const esAdmin = useEsAdmin();
  const [s, setS] = useState<ItemFormState>(() => estadoDesdeItem(item, (tarifario.items.length + 1) * 10));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probarCantidad, setProbarCantidad] = useState("12");
  // Recuerda el último nombre público que se puso SOLO porque se eligió un
  // concepto: si el usuario no lo tocó desde entonces, el siguiente concepto
  // lo puede volver a rellenar; si lo editó a mano, se respeta (B1).
  const nombrePublicoAutoRef = useRef(item?.nombrePublico ?? "");
  const set = <K extends keyof ItemFormState>(k: K, v: ItemFormState[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const conceptoSel = conceptos.find((c) => c.codigo === s.concepto) ?? null;

  function seleccionarConcepto(concepto: ConceptoVentaRow) {
    setS((prev) => {
      const eraAuto = prev.nombrePublico.trim() === "" || prev.nombrePublico === nombrePublicoAutoRef.current;
      return {
        ...prev,
        concepto: concepto.codigo,
        siigoCodigo: concepto.siigoProducto?.codigo ?? "",
        aplicaIva: concepto.aplicaIva,
        nombrePublico: eraAuto ? concepto.nombre : prev.nombrePublico,
        tipoCalculo: !item && concepto.tipoCalculoSugerido ? concepto.tipoCalculoSugerido : prev.tipoCalculo,
        unidad: !item && concepto.unidadSugerida ? concepto.unidadSugerida : prev.unidad,
      };
    });
    nombrePublicoAutoRef.current = concepto.nombre;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    setError(null);

    if (!conceptoSel) {
      setError("Elige un concepto del catálogo antes de guardar.");
      return;
    }
    if (s.tipoCalculo === "POR_TRAMO") {
      const mensaje = validarEscalas(s.tramos);
      if (mensaje) {
        setError(mensaje);
        return;
      }
    }

    setEnviando(true);
    try {
      const form = formDesdeEstado(s);
      const actualizado = item ? await actualizarItem(tarifario.id, item.id, form) : await agregarItem(tarifario.id, form);
      onSaved(actualizado);
    } catch (caught) {
      setError(describirError(caught, "No fue posible guardar el ítem."));
    } finally {
      setEnviando(false);
    }
  }

  const tipo = TIPOS_CALCULO.find((t) => t.value === s.tipoCalculo);
  const usaUnidad = s.tipoCalculo === "POR_UNIDAD" || s.tipoCalculo === "PRIMERO_MAS_ADICIONAL" || s.tipoCalculo === "POR_TRAMO";

  function setTramo(i: number, campo: "hasta" | "valor", v: string) {
    setS((prev) => ({ ...prev, tramos: prev.tramos.map((t, j) => (j === i ? { ...t, [campo]: v } : t)) }));
  }
  function quitarTramo(i: number) {
    setS((prev) => ({ ...prev, tramos: prev.tramos.filter((_, j) => j !== i) }));
  }
  function agregarTramo() {
    setS((prev) => ({ ...prev, tramos: [...prev.tramos, { hasta: "", valor: "" }] }));
  }

  const tramosParaEjemplo = s.tramos
    .filter((t) => t.valor.trim() !== "")
    .map((t) => ({ hasta: t.hasta.trim() === "" ? null : Number(t.hasta), valor: t.valor.trim() }));
  const ejemplo = ejemploTramo(tramosParaEjemplo, Number(probarCantidad) || 0);
  const unidadEjemplo = UNIDADES.find((u) => u.value === s.unidad)?.label.toLowerCase() ?? "unidades";

  return (
    <ModalShell open onClose={onClose} title={item ? `Editar ${item.nombrePublico}` : "Agregar ítem al tarifario"} size="lg" dismissible={!enviando}>
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Nombre en la propuesta *</span>
            <input value={s.nombrePublico} onChange={(e) => set("nombrePublico", e.target.value)} required className={INPUT} placeholder="Gastos de trámite por embarque" />
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Concepto de venta *</span>
            <ConceptoVentaSelect conceptos={conceptos} value={s.concepto} onSelect={seleccionarConcepto} />
            {conceptoSel ? (
              <p className="text-xs text-slate-500">
                Siigo {conceptoSel.siigoProducto?.codigo ?? "—"} · {conceptoSel.aplicaIva ? "Lleva IVA" : "No lleva IVA"}
              </p>
            ) : s.concepto ? (
              <p className="text-xs text-red-600">Este concepto no está en el catálogo; elige uno.</p>
            ) : null}
            {esAdmin ? (
              <a
                href="/configuracion/catalogos"
                target="_blank"
                rel="noreferrer"
                className="inline-block text-xs text-cyan-700 underline hover:text-cyan-900"
              >
                ¿No está? Créalo en Configuración → Catálogos
              </a>
            ) : null}
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Cómo se calcula</span>
            <select value={s.tipoCalculo} onChange={(e) => set("tipoCalculo", e.target.value as TipoCalculoTarifa)} className={INPUT}>
              {TIPOS_CALCULO.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {tipo ? <p className="text-xs text-slate-500">{tipo.ayuda}</p> : null}
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Cuándo entra a la factura</span>
            <select value={s.disparador} onChange={(e) => set("disparador", e.target.value as DisparadorTarifa)} className={INPUT}>
              {DISPARADORES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          {s.disparador === "EVENTO" ? (
            <label className="block space-y-1 sm:col-span-2">
              <span className={LABEL}>Evento que lo dispara *</span>
              <select value={s.eventoCodigo} onChange={(e) => set("eventoCodigo", e.target.value)} required className={INPUT}>
                <option value="">Elige el evento…</option>
                {eventos.map((ev) => (
                  <option key={ev.codigo} value={ev.codigo}>
                    {ev.nombre}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {s.tipoCalculo !== "PORCENTAJE_MIN" && s.tipoCalculo !== "ESPEJO_DE_COSTO" && s.tipoCalculo !== "POR_TRAMO" ? (
            <label className="block space-y-1">
              <span className={LABEL}>{s.tipoCalculo === "PRIMERO_MAS_ADICIONAL" ? "Valor del primero (COP) *" : "Valor (COP) *"}</span>
              <CampoMoneda value={s.valor} onValueChange={(v) => set("valor", v)} required className={INPUT} placeholder="100.000" />
            </label>
          ) : null}
          {s.tipoCalculo === "PRIMERO_MAS_ADICIONAL" ? (
            <label className="block space-y-1">
              <span className={LABEL}>Cada adicional (COP) *</span>
              <CampoMoneda value={s.valorAdicional} onValueChange={(v) => set("valorAdicional", v)} required className={INPUT} placeholder="180.000" />
            </label>
          ) : null}
          {usaUnidad ? (
            <label className="block space-y-1">
              <span className={LABEL}>Unidad</span>
              <select value={s.unidad} onChange={(e) => set("unidad", e.target.value as UnidadTarifa)} className={INPUT}>
                {UNIDADES.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {s.tipoCalculo === "PORCENTAJE_MIN" ? (
            <>
              <label className="block space-y-1">
                <span className={LABEL}>Porcentaje sobre el CIF *</span>
                <input value={s.porcentaje} onChange={(e) => set("porcentaje", e.target.value)} inputMode="decimal" required className={INPUT} placeholder="0,37" />
              </label>
              <div className="sm:col-span-2 grid gap-3 sm:grid-cols-3">
                <label className="block space-y-1">
                  <span className={LABEL}>Mínimo carga suelta</span>
                  <CampoMoneda value={s.minSuelta} onValueChange={(v) => set("minSuelta", v)} className={INPUT} placeholder="370.000" />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Mínimo contenedor 20′</span>
                  <CampoMoneda value={s.min20} onValueChange={(v) => set("min20", v)} className={INPUT} placeholder="498.000" />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Mínimo contenedor 40′ / HQ</span>
                  <CampoMoneda value={s.min40} onValueChange={(v) => set("min40", v)} className={INPUT} placeholder="554.000" />
                </label>
              </div>
            </>
          ) : null}

          {s.tipoCalculo === "POR_TRAMO" ? (
            <div className="space-y-2 sm:col-span-2">
              <span className={LABEL}>Escalas de volumen (el precio de la escala aplica a todas las unidades) *</span>
              <div className="overflow-x-auto border border-slate-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5">Desde</th>
                      <th className="px-2 py-1.5">Hasta</th>
                      <th className="px-2 py-1.5">Precio por unidad</th>
                      <th className="px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {s.tramos.map((t, i) => {
                      const esUltimo = i === s.tramos.length - 1;
                      const desde = desdeDeEscala(s.tramos, i);
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-2 py-1.5 text-slate-500">{desde ?? "—"}</td>
                          <td className="px-2 py-1.5">
                            <input
                              value={t.hasta}
                              onChange={(e) => setTramo(i, "hasta", soloDigitos(e.target.value))}
                              inputMode="numeric"
                              className={`${INPUT} w-24`}
                              placeholder={esUltimo ? "En adelante" : "20"}
                              aria-label={`Escala ${i + 1}: hasta cuántas unidades${esUltimo ? " (vacío = en adelante)" : ""}`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <CampoMoneda
                              value={t.valor}
                              onValueChange={(v) => setTramo(i, "valor", v)}
                              className={INPUT}
                              placeholder="250.000"
                              aria-label={`Escala ${i + 1}: precio por unidad en COP`}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <button
                              type="button"
                              onClick={() => quitarTramo(i)}
                              disabled={s.tramos.length <= 1}
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                              aria-label={`Quitar escala ${i + 1}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={agregarTramo} className="inline-flex h-8 items-center gap-1 border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Agregar escala
              </button>
              <p className="text-xs text-slate-500">
                El precio de la escala se cobra por cada unidad del trámite. Deja &quot;Hasta&quot; vacío solo en la última escala, para &quot;en adelante&quot;.
              </p>

              <div className="border border-slate-200 bg-slate-50 p-2.5">
                <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  Probar con
                  <input
                    type="number"
                    min={1}
                    value={probarCantidad}
                    onChange={(e) => setProbarCantidad(e.target.value.replace(/\D/g, ""))}
                    className="h-8 w-20 border border-slate-300 px-2 text-sm"
                  />
                  {unidadEjemplo}
                </label>
                <p className="mt-1.5 text-sm font-medium text-slate-800">
                  {ejemplo
                    ? `Escala ${ejemplo.rango} → ${ejemplo.cantidad} × ${formatCOP(ejemplo.valorUnitario.toString())} = ${formatCOP(ejemplo.total.toString())}`
                    : "Completa las escalas y una cantidad para ver el ejemplo."}
                </p>
              </div>
            </div>
          ) : null}

          {s.tipoCalculo === "ESPEJO_DE_COSTO" ? (
            <label className="block space-y-1 sm:col-span-2">
              <span className={LABEL}>Texto del pago o factura de proveedor que se espeja *</span>
              <input value={s.conceptoCosto} onChange={(e) => set("conceptoCosto", e.target.value)} required className={INPUT} placeholder="registro" />
            </label>
          ) : null}

          <label className="block space-y-1">
            <span className={LABEL}>Orden</span>
            <input value={s.orden} onChange={(e) => set("orden", soloDigitos(e.target.value))} inputMode="numeric" className={INPUT} />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={s.aplicaIva} onChange={(e) => set("aplicaIva", e.target.checked)} className="h-4 w-4" />
            Lleva IVA
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className={LABEL}>Nota para el cliente (sale en el PDF)</span>
            <input value={s.notas} onChange={(e) => set("notas", e.target.value)} className={INPUT} />
          </label>
        </div>

        {error ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={enviando} className={BTN_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando} className={BTN_PRIMARIO}>
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {item ? "Guardar" : "Agregar"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Tarjeta de tarifario ─────────────────────────────────────────────────────

function TarjetaTarifario({
  tarifario,
  eventos,
  editable,
  expandido,
  ocupado,
  onToggle,
  onPublicar,
  onVencer,
  onDuplicar,
  onEliminar,
  onAgregarItem,
  onEditarItem,
  onEliminarItem,
}: {
  tarifario: TarifarioRow;
  eventos: EventoCatalogoRow[];
  editable: boolean;
  expandido: boolean;
  ocupado: boolean;
  onToggle: () => void;
  onPublicar: () => void;
  onVencer: () => void;
  onDuplicar: () => void;
  onEliminar: () => void;
  onAgregarItem: () => void;
  onEditarItem: (item: TarifaItemRow) => void;
  onEliminarItem: (item: TarifaItemRow) => void;
}) {
  const esBorrador = tarifario.estado === "BORRADOR";
  const nombreEvento = (codigo: string | null) => eventos.find((e) => e.codigo === codigo)?.nombre ?? codigo ?? "";

  return (
    <div className="border border-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900">{tarifario.nombre}</p>
            <span className="text-xs text-slate-500">v{tarifario.version}</span>
            <span className={`border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${estadoClase(tarifario.estado)}`}>
              {etiquetaEstado(tarifario.estado)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {alcanceLabel(tarifario.alcance)} · {formatFecha(tarifario.vigenteDesde)} → {formatFecha(tarifario.vigenteHasta)} · {tarifario.items.length} ítems
            {tarifario.creadoPor ? ` · ${tarifario.creadoPor}` : ""}
          </p>
          {tarifario.notas ? (
            <p className="mt-1 flex items-start gap-1 text-xs text-slate-500">
              <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              Nota interna: {tarifario.notas}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <a href={`/api/tarifarios/${tarifario.id}/pdf`} target="_blank" rel="noreferrer" className={BTN_SECUNDARIO}>
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            PDF
          </a>
          {editable ? (
            <>
              {esBorrador ? (
                <button type="button" onClick={onPublicar} disabled={ocupado || tarifario.items.length === 0} className={`${BTN} border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700`} title={tarifario.items.length === 0 ? "Agrega ítems antes de publicar" : undefined}>
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Publicar
                </button>
              ) : null}
              {tarifario.estado === "VIGENTE" ? (
                <button type="button" onClick={onVencer} disabled={ocupado} className={BTN_SECUNDARIO}>
                  Marcar vencido
                </button>
              ) : null}
              <button type="button" onClick={onDuplicar} disabled={ocupado} className={BTN_SECUNDARIO}>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Duplicar
              </button>
              {esBorrador ? (
                <button type="button" onClick={onEliminar} disabled={ocupado} className={BTN_PELIGRO}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </>
          ) : null}
          <button type="button" onClick={onToggle} className={BTN_SECUNDARIO} aria-expanded={expandido}>
            {expandido ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            Ítems
          </button>
        </div>
      </div>

      {expandido ? (
        <div className="border-t border-slate-200">
          {tarifario.items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500">Sin ítems todavía.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Concepto</th>
                    <th className="px-4 py-2">Cálculo</th>
                    <th className="px-4 py-2">Cuándo</th>
                    <th className="px-4 py-2">Siigo</th>
                    <th className="px-4 py-2">IVA</th>
                    {editable && esBorrador ? <th className="px-4 py-2" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {tarifario.items.map((it) => (
                    <tr key={it.id} className="border-t border-slate-100 align-top">
                      <td className="px-4 py-2">
                        <p className="font-medium text-slate-900">{it.nombrePublico}</p>
                        <p className="text-xs text-slate-500">{it.concepto}</p>
                        {it.notas ? <p className="mt-0.5 text-xs text-slate-500">Nota en PDF: {it.notas}</p> : null}
                      </td>
                      <td className="px-4 py-2 text-slate-700">{describirCalculo(it)}</td>
                      <td className="px-4 py-2 text-slate-700">
                        {it.disparador === "SIEMPRE" ? "Siempre" : it.disparador === "MANUAL" ? "A mano" : `Si ${nombreEvento(it.eventoCodigo).toLowerCase()}`}
                      </td>
                      <td className="px-4 py-2 text-slate-700">{it.siigoCodigo ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-2 text-slate-700">{it.aplicaIva ? "Sí" : "No"}</td>
                      {editable && esBorrador ? (
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-1">
                            <button type="button" onClick={() => onEditarItem(it)} disabled={ocupado} className={BTN_SECUNDARIO} aria-label={`Editar ${it.nombrePublico}`}>
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            <button type="button" onClick={() => onEliminarItem(it)} disabled={ocupado} className={BTN_PELIGRO} aria-label={`Eliminar ${it.nombrePublico}`}>
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {editable && esBorrador ? (
            <div className="border-t border-slate-100 px-4 py-2">
              <button type="button" onClick={onAgregarItem} disabled={ocupado} className={BTN_SECUNDARIO}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Agregar ítem
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Sección ──────────────────────────────────────────────────────────────────

type Modal =
  | { tipo: "nuevo" }
  | { tipo: "duplicar"; tarifario: TarifarioRow }
  | { tipo: "item"; tarifario: TarifarioRow; item: TarifaItemRow | null }
  | null;

/**
 * Tarifario de la empresa (M2 del PLAN-CONFIGURABILIDAD): la propuesta
 * comercial como datos, versionada y con vigencia real.
 */
export function SeccionTarifario({ clienteId }: { clienteId: string }) {
  const editable = useEsAdmin();
  const { toast } = useToast();
  const confirmar = useConfirm();

  const [tarifarios, setTarifarios] = useState<TarifarioRow[]>([]);
  const [eventos, setEventos] = useState<EventoCatalogoRow[]>([]);
  const [conceptos, setConceptos] = useState<ConceptoVentaRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchTarifarios(clienteId, controller.signal),
      fetchEventosCatalogo(controller.signal).catch(() => []),
      fetchConceptosVenta(controller.signal).catch(() => []),
    ])
      .then(([lista, cat, conceptosCat]) => {
        setTarifarios(lista);
        setEventos(cat);
        // Alta/edición MANUAL de ítems solo puede usar conceptos ACTIVOS (B1).
        setConceptos(conceptosCat.filter((c) => c.activo));
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar el tarifario."));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [clienteId, reloadKey]);

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  const reemplazar = useCallback((t: TarifarioRow) => {
    setTarifarios((prev) => prev.map((x) => (x.id === t.id ? t : x)));
  }, []);

  async function accion(id: string, fn: () => Promise<void>, fallback: string) {
    setOcupado(id);
    try {
      await fn();
    } catch (caught) {
      toast({ title: fallback, description: describirError(caught), variant: "error" });
    } finally {
      setOcupado(null);
    }
  }

  async function publicar(t: TarifarioRow) {
    const ok = await confirmar({
      title: `Publicar "${t.nombre}" v${t.version}`,
      description: "Queda vigente y reemplaza al tarifario vigente anterior del mismo alcance. Los borradores de factura nuevos de esta empresa lo usarán.",
      confirmText: "Publicar",
    });
    if (!ok) return;
    await accion(t.id, async () => {
      await cambiarEstadoTarifario(t.id, "VIGENTE");
      toast({ title: "Tarifario publicado", variant: "success" });
      recargar();
    }, "No se pudo publicar");
  }

  async function vencer(t: TarifarioRow) {
    const ok = await confirmar({ title: "Marcar vencido", description: "La empresa quedará sin tarifario vigente para este alcance hasta publicar otro.", confirmText: "Marcar vencido", variant: "danger" });
    if (!ok) return;
    await accion(t.id, async () => {
      reemplazar(await cambiarEstadoTarifario(t.id, "VENCIDO"));
      toast({ title: "Tarifario vencido", variant: "success" });
    }, "No se pudo marcar vencido");
  }

  async function eliminar(t: TarifarioRow) {
    const ok = await confirmar({ title: `Eliminar borrador v${t.version}`, description: "Se borran sus ítems. No se puede deshacer.", confirmText: "Eliminar", variant: "danger" });
    if (!ok) return;
    await accion(t.id, async () => {
      await eliminarTarifario(t.id);
      setTarifarios((prev) => prev.filter((x) => x.id !== t.id));
      toast({ title: "Borrador eliminado", variant: "success" });
    }, "No se pudo eliminar");
  }

  async function quitarItem(t: TarifarioRow, item: TarifaItemRow) {
    const ok = await confirmar({ title: `Quitar "${item.nombrePublico}"`, confirmText: "Quitar", variant: "danger" });
    if (!ok) return;
    await accion(t.id, async () => {
      reemplazar(await eliminarItem(t.id, item.id));
      toast({ title: "Ítem quitado", variant: "success" });
    }, "No se pudo quitar el ítem");
  }

  const vigentes = tarifarios.filter((t) => t.estado === "VIGENTE").length;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Tarifario</p>
          <p className="text-xs text-slate-500">
            {loadState === "ready" ? `${vigentes} vigente${vigentes === 1 ? "" : "s"} · ${tarifarios.length} versión${tarifarios.length === 1 ? "" : "es"}` : "La propuesta comercial como datos: vigencia, ítems y forma de cálculo."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editable ? (
            <button type="button" onClick={() => setModal({ tipo: "nuevo" })} className={BTN_PRIMARIO}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Nuevo tarifario
            </button>
          ) : (
            <span className="text-xs text-slate-500">Solo ADMIN edita el tarifario</span>
          )}
          <button type="button" onClick={recargar} className={BTN_SECUNDARIO} aria-label="Refrescar tarifario">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {loadState === "loading" ? (
          <TableSkeleton rows={2} cols={4} rowHeight={56} />
        ) : loadState === "error" ? (
          <ModuleState type="error" title="No fue posible cargar el tarifario" detail={loadError ?? undefined} action={{ label: "Reintentar", onClick: recargar }} />
        ) : tarifarios.length === 0 ? (
          <ModuleState
            type="empty"
            title="Esta empresa no tiene tarifario"
            detail="Sin tarifario, la comisión de la factura se pone a mano como hasta ahora. Para usarlo la empresa necesita la función “Tarifario propio” encendida."
            action={editable ? { label: "Crear el primero", onClick: () => setModal({ tipo: "nuevo" }) } : undefined}
          />
        ) : (
          tarifarios.map((t) => (
            <TarjetaTarifario
              key={t.id}
              tarifario={t}
              eventos={eventos}
              editable={editable}
              expandido={expandido === t.id}
              ocupado={ocupado === t.id}
              onToggle={() => setExpandido((prev) => (prev === t.id ? null : t.id))}
              onPublicar={() => void publicar(t)}
              onVencer={() => void vencer(t)}
              onDuplicar={() => setModal({ tipo: "duplicar", tarifario: t })}
              onEliminar={() => void eliminar(t)}
              onAgregarItem={() => setModal({ tipo: "item", tarifario: t, item: null })}
              onEditarItem={(item) => setModal({ tipo: "item", tarifario: t, item })}
              onEliminarItem={(item) => void quitarItem(t, item)}
            />
          ))
        )}
      </div>

      {modal?.tipo === "nuevo" ? (
        <NuevoTarifarioModal
          clienteId={clienteId}
          onClose={() => setModal(null)}
          onCreated={(t) => {
            setTarifarios((prev) => [t, ...prev]);
            setExpandido(t.id);
            setModal(null);
            toast({ title: "Borrador creado", description: `${t.items.length} ítems. Revísalo y publícalo.`, variant: "success" });
          }}
        />
      ) : null}
      {modal?.tipo === "duplicar" ? (
        <DuplicarModal
          tarifario={modal.tarifario}
          onClose={() => setModal(null)}
          onCreated={(t) => {
            setTarifarios((prev) => [t, ...prev]);
            setExpandido(t.id);
            setModal(null);
            toast({ title: `Versión ${t.version} creada como borrador`, variant: "success" });
          }}
        />
      ) : null}
      {modal?.tipo === "item" ? (
        <ItemModal
          tarifario={modal.tarifario}
          item={modal.item}
          eventos={eventos}
          conceptos={conceptos}
          onClose={() => setModal(null)}
          onSaved={(t) => {
            reemplazar(t);
            setModal(null);
            toast({ title: modal.item ? "Ítem guardado" : "Ítem agregado", variant: "success" });
          }}
        />
      ) : null}
    </div>
  );
}


