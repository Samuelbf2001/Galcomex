"use client";

/**
 * Pestaña "Facturas proveedor" del DO (CxP v2, diseño §D.3). Columnas del
 * Excel + Pagado/Saldo/Estado; "Pagar $saldo" solo si hay saldo; ficha de pago
 * obligatoria; alerta de duplicado y de posible duplicado; USD + TRM; ADMIN
 * puede re-expresar USD o quitar un ajuste de migración (LEGADO).
 */

import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceFacturaVenta } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin, usePermiso } from "@/lib/auth/rol-context";
import { centavosDeTexto, centavosDeTextoApi, copDesdeUsd, formatoPesos, formatoTrm, formatoUsd } from "@/lib/dinero";
import { formatFechaCalendario, hoyBogotaISO } from "@/lib/tiempo/bogota";

import {
  type DocumentoRow,
  registrarDocumento,
  solicitarUploadUrl,
  subirArchivoDirecto,
  validarArchivo,
} from "@/components/documentos/documentos-api";
import {
  BeneficiarioCombobox,
  type BeneficiarioSeleccion,
} from "@/components/beneficiarios/beneficiario-combobox";
import {
  type CreateFacturaProveedorInput,
  type EtiquetaCxp,
  type FacturaProveedorRow,
  type Moneda,
  type UpdateFacturaProveedorInput,
  FacturasProveedorApiError,
  createFacturaProveedor,
  deleteFacturaProveedor,
  eliminarAjusteLegado,
  fetchFacturasProveedor,
  formatCOP,
  updateFacturaProveedor,
} from "@/components/facturas-proveedor/facturas-proveedor-api";
import { ReexpresarUsdModal } from "@/components/facturas-proveedor/reexpresar-usd-modal";

// ─── Siigo producto combobox ──────────────────────────────────────────────────

type SiigoProductoOpcion = { id: string; codigo: string; nombre: string };

type SiigoProductoComboboxProps = {
  valor: string;
  onChange: (texto: string, productoId?: string) => void;
  placeholder?: string;
};

function SiigoProductoCombobox({ valor, onChange, placeholder = "Opcional" }: SiigoProductoComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [productos, setProductos] = useState<SiigoProductoOpcion[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    function isRec(v: unknown): v is Record<string, unknown> {
      return typeof v === "object" && v !== null && !Array.isArray(v);
    }

    async function load() {
      setLoadState("loading");
      const url = query.length >= 1 ? `/api/siigo-productos?q=${encodeURIComponent(query)}` : "/api/siigo-productos";
      try {
        const r = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
        const payload: unknown = await r.json();
        const list: SiigoProductoOpcion[] = isRec(payload) && Array.isArray(payload.productos)
          ? (payload.productos as unknown[]).filter(isRec).map((p) => ({
              id: String(p.id ?? ""),
              codigo: String(p.codigo ?? ""),
              nombre: String(p.nombre ?? ""),
            })).filter((p) => p.id)
          : [];
        setProductos(list);
        setLoadState("ready");
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v, undefined);
    setQuery(v);
    if (!open) setOpen(true);
  }

  function handleSelect(producto: SiigoProductoOpcion) {
    onChange(producto.nombre, producto.id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          ref={inputRef}
          value={valor}
          onChange={handleInputChange}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="h-10 w-full border border-slate-300 pl-8 pr-3 text-sm outline-none focus:border-cyan-600"
        />
      </div>
      {open ? (
        <div className="absolute z-40 mt-1 w-full border border-slate-200 bg-white shadow-lg">
          {loadState === "loading" ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Buscando…
            </div>
          ) : loadState === "error" ? (
            <p className="px-3 py-3 text-xs text-rose-600">No se pudieron cargar los productos.</p>
          ) : productos.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500">
              {query ? "Sin resultados. Puedes escribir el concepto libremente." : "Sin productos activos."}
            </p>
          ) : (
            <ul className="max-h-52 overflow-y-auto divide-y divide-slate-100">
              {productos.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(p); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="font-medium text-slate-900">{p.nombre}</span>
                    <span className="ml-1.5 text-xs text-slate-400">{p.codigo}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

/** POST /api/tramites/[id]/facturas-proveedor admite SOCIO (solo en sus DOs, valida el servidor). */
const ROLES_CREAR_FACTURA = ["ADMIN", "OPERATIVO", "SOCIO"] as const;
/**
 * "Pagar $saldo" abre el formulario de pago del DO (POST /api/tramites/[id]/pagos),
 * que solo admite ADMIN y OPERATIVO: a SOCIO no se le muestra (antes recibía 403).
 */
const ROLES_PAGAR_FACTURA = ["ADMIN", "OPERATIVO"] as const;
/** PATCH/DELETE /api/facturas-proveedor/[id] son solo ADMIN/OPERATIVO. */
const ROLES_MODIFICAR_FACTURA = ["ADMIN", "OPERATIVO"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coincidenciasDeDetalles(detalles: unknown): string[] {
  if (!isRecord(detalles) || !Array.isArray(detalles.coincidencias)) return [];
  return detalles.coincidencias.filter(isRecord).map((c) => {
    const num = typeof c.numFactura === "string" ? c.numFactura : "";
    const doCorto = typeof c.doCorto === "string" ? c.doCorto : "";
    const valor = typeof c.valor === "string" ? formatCOP(c.valor) : "";
    return [num, doCorto, valor].filter(Boolean).join(" · ");
  });
}

// Chip Pendiente / Abonada / Pagada / Cruzada / Pagada con ajuste (etiqueta calculada por el servidor).
function EstadoBadge({ etiqueta, fila }: { etiqueta: EtiquetaCxp; fila: FacturaProveedorRow }) {
  const map: Record<EtiquetaCxp, string> = {
    Pendiente: "border-amber-200 bg-amber-50 text-amber-700",
    Abonada: "border-cyan-200 bg-cyan-50 text-cyan-700",
    Pagada: "border-slate-300 bg-slate-100 text-slate-700",
    Cruzada: "border-violet-200 bg-violet-50 text-violet-700",
    "Pagada con ajuste": "border-rose-200 bg-rose-50 text-rose-700",
  };
  const fechaPago = fila.pagos
    .map((p) => p.fechaRealPago)
    .filter((f): f is string => Boolean(f))
    .sort()
    .at(-1);

  let title: string | undefined;
  if (etiqueta === "Abonada") {
    title = `Pagado ${formatCOP(fila.aplicado)} de ${formatCOP(fila.valor)} · faltan ${formatCOP(fila.saldo)}`;
  } else if (etiqueta === "Pagada" && fechaPago) {
    title = `Pagada ${formatFechaCalendario(fechaPago, "corta")}`;
  } else if (etiqueta === "Pagada con ajuste") {
    title = "Cerrada con diferencia: revisar";
  }

  return (
    <span
      className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${map[etiqueta]}`}
      title={title}
    >
      {etiqueta}
    </span>
  );
}

// ─── Subida de PDF adjunto (en el modal de alta/edición) ──────────────────────

type SubidaInlineProps = {
  tramiteId: string;
  onDocumentoSubido: (docId: string, nombre: string) => void;
};

function SubidaInlinePDF({ tramiteId, onDocumentoSubido }: SubidaInlineProps) {
  const [estado, setEstado] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [progreso, setProgreso] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function subirArchivo(file: File) {
    const validError = validarArchivo(file);
    if (validError) {
      setError(validError);
      return;
    }

    setEstado("uploading");
    setProgreso(0);
    setError(null);
    setNombreArchivo(file.name);

    try {
      const urlResult = await solicitarUploadUrl(tramiteId, {
        categoria: "FACTURA_PROVEEDOR",
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });

      setProgreso(10);

      await subirArchivoDirecto(urlResult.uploadUrl, file, (pct) => {
        setProgreso(10 + Math.round(pct * 0.8));
      });

      setProgreso(95);

      const doc = await registrarDocumento(tramiteId, {
        categoria: "FACTURA_PROVEEDOR",
        nombreArchivo: file.name,
        storageKey: urlResult.storageKey,
        mimeType: file.type,
        tamanoBytes: file.size,
      });

      setProgreso(100);
      setEstado("done");
      onDocumentoSubido(doc.id, doc.nombreArchivo);
    } catch (caught) {
      setError(describirError(caught, "Error al subir el archivo."));
      setEstado("error");
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void subirArchivo(file);
    e.target.value = "";
  }

  function limpiar() {
    setEstado("idle");
    setProgreso(0);
    setError(null);
    setNombreArchivo(null);
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        onChange={handleFileInput}
        className="sr-only"
        aria-hidden="true"
      />
      {estado === "idle" && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-9 items-center gap-2 border border-dashed border-slate-300 bg-slate-50 px-3 text-xs font-medium text-slate-600 transition hover:border-slate-400 hover:bg-white"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          Adjuntar PDF
        </button>
      )}
      {estado === "uploading" && (
        <div className="flex items-center gap-2 border border-slate-200 px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-cyan-600 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-xs text-slate-700 truncate">{nombreArchivo}</p>
            <div className="mt-1 h-1 w-full bg-slate-200">
              <div
                className="h-full bg-cyan-500 transition-all"
                style={{ width: `${progreso}%` }}
              />
            </div>
          </div>
        </div>
      )}
      {estado === "done" && (
        <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-hidden="true" />
          <p className="flex-1 truncate text-xs text-emerald-700">{nombreArchivo}</p>
          <button
            type="button"
            onClick={limpiar}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Quitar archivo"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {estado === "error" && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-rose-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-xs text-rose-700">{error}</p>
          </div>
          <button
            type="button"
            onClick={limpiar}
            className="text-rose-400 hover:text-rose-700"
            aria-label="Cerrar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Modal: Alta / Edición de factura de proveedor ────────────────────────────

type ModalFacturaProps = {
  tramiteId: string;
  facturaExistente?: FacturaProveedorRow | null;
  onClose: () => void;
  onGuardada: (factura: FacturaProveedorRow) => void;
};

export function ModalFacturaProveedor({
  tramiteId,
  facturaExistente,
  onClose,
  onGuardada,
}: ModalFacturaProps) {
  const isEdit = Boolean(facturaExistente);
  const confirmar = useConfirm();
  const { toast } = useToast();

  const initialBeneficiario: BeneficiarioSeleccion | null =
    facturaExistente?.beneficiarioId
      ? {
          id: facturaExistente.beneficiarioId,
          nombre: facturaExistente.proveedorNombre,
          nit: facturaExistente.proveedorNit,
        }
      : null;

  const [beneficiario, setBeneficiario] = useState<BeneficiarioSeleccion | null>(initialBeneficiario);
  const [concepto, setConcepto] = useState(facturaExistente?.concepto ?? "");
  const [siigoProductoId, setSiigoProductoId] = useState<string | undefined>(undefined);
  const [numFactura, setNumFactura] = useState(facturaExistente?.numFactura ?? "");
  const [fecha, setFecha] = useState(facturaExistente?.fecha ?? "");
  const [valorRaw, setValorRaw] = useState(facturaExistente?.valor ?? "");
  const [documentoId, setDocumentoId] = useState<string | null>(facturaExistente?.documentoId ?? null);
  const [repercutible, setRepercutible] = useState<boolean>(facturaExistente?.repercutible !== false);
  const [documentoNombre, setDocumentoNombre] = useState<string | null>(null);

  const [moneda, setMoneda] = useState<Moneda>(facturaExistente?.moneda ?? "COP");
  const [valorUsdRaw, setValorUsdRaw] = useState(facturaExistente?.valorOrigen ?? "");
  const [trmRaw, setTrmRaw] = useState(facturaExistente?.trm ?? "");
  const [fechaTrm, setFechaTrm] = useState(facturaExistente?.fechaTrm ?? hoyBogotaISO());

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R11: si hay bloqueo de edición, los campos que mueven plata quedan de solo lectura
  // (concepto, producto, fecha y archivo siguen editables).
  const bloqueo = facturaExistente?.bloqueoEdicion ?? null;
  const camposDineroBloqueados = bloqueo !== null;

  function handleDocumentoSubido(docId: string, nombre: string) {
    setDocumentoId(docId);
    setDocumentoNombre(nombre);
  }

  /** Lee lo que dejó CampoMoneda (texto canónico); null si vacío, inválido o ≤ 0. */
  function centavosPositivos(raw: string): bigint | null {
    if (!raw) return null;
    try {
      const c = centavosDeTexto(raw);
      return c > 0n ? c : null;
    } catch {
      return null;
    }
  }

  async function enviar(
    confirmarPosibleDuplicado: boolean,
    confirmarValorUsd: boolean,
  ): Promise<void> {
    if (centavosPositivos(valorRaw) === null) {
      setError("El valor debe ser mayor a 0.");
      return;
    }
    if (!beneficiario) {
      setError("El proveedor es obligatorio.");
      return;
    }
    if (!numFactura.trim()) {
      setError("El número de factura es obligatorio.");
      return;
    }
    if (!fecha) {
      setError("La fecha es obligatoria.");
      return;
    }
    if (!isEdit && !documentoId && repercutible) {
      setError(
        'El archivo de la factura es obligatorio. Si es un costo propio que no se le cobra al cliente, desmarca "Se le cobra al cliente".',
      );
      return;
    }

    let valorOrigen: string | null = null;
    let trm: string | null = null;
    if (moneda === "USD") {
      if (centavosPositivos(valorUsdRaw) === null || centavosPositivos(trmRaw) === null) {
        setError("Una factura en dólares necesita el valor en dólares y la TRM (ambos mayores que cero).");
        return;
      }
      valorOrigen = valorUsdRaw;
      trm = trmRaw;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (isEdit && facturaExistente) {
        const input: UpdateFacturaProveedorInput = {
          beneficiarioId: beneficiario.id,
          concepto: concepto.trim() || null,
          siigoProductoId: siigoProductoId ?? null,
          numFactura: numFactura.trim(),
          valor: valorRaw,
          fecha,
          documentoId,
          repercutible,
          moneda,
          valorOrigen: moneda === "USD" ? valorOrigen : null,
          trm: moneda === "USD" ? trm : null,
          fechaTrm: moneda === "USD" ? fechaTrm : null,
          confirmarPosibleDuplicado,
          confirmarValorUsd,
        };
        const actualizada = await updateFacturaProveedor(facturaExistente.id, input);
        toast({ title: "Factura actualizada", description: numFactura.trim(), variant: "success" });
        onGuardada(actualizada);
      } else {
        const input: CreateFacturaProveedorInput = {
          beneficiarioId: beneficiario.id,
          concepto: concepto.trim() || null,
          siigoProductoId: siigoProductoId ?? null,
          numFactura: numFactura.trim(),
          valor: valorRaw,
          fecha,
          documentoId,
          repercutible,
          moneda,
          valorOrigen,
          trm,
          fechaTrm: moneda === "USD" ? fechaTrm : null,
          confirmarPosibleDuplicado,
          confirmarValorUsd,
        };
        const factura = await createFacturaProveedor(tramiteId, input);
        toast({
          title: "Factura de proveedor registrada",
          description: `${factura.numFactura} · ${formatCOP(factura.valor)}`,
          variant: "success",
        });
        onGuardada(factura);
      }
    } catch (caught) {
      if (caught instanceof FacturasProveedorApiError && caught.codigo === "POSIBLE_DUPLICADO") {
        const lista = coincidenciasDeDetalles(caught.detalles);
        const ok = await confirmar({
          title: "¿Es la misma factura?",
          description: `${caught.message}${lista.length > 0 ? ` (${lista.join(" · ")})` : ""}`,
          confirmText: "Es otra factura, guardar",
          cancelText: "Revisar",
        });
        if (ok) {
          setSubmitting(false);
          await enviar(true, confirmarValorUsd);
          return;
        }
      } else if (caught instanceof FacturasProveedorApiError && caught.codigo === "USD_VALOR_LEJOS_DE_TRM") {
        const ok = await confirmar({
          title: "¿Está bien el valor?",
          description: caught.message,
          confirmText: "Sí, guardar",
          cancelText: "Corregir",
        });
        if (ok) {
          setSubmitting(false);
          await enviar(confirmarPosibleDuplicado, true);
          return;
        }
      } else {
        setError(describirError(caught, "Error al guardar la factura."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    await enviar(false, false);
  }

  const usdCentavos = moneda === "USD" ? centavosPositivos(valorUsdRaw) : null;
  const trmSugeridoCentavos = moneda === "USD" ? centavosPositivos(trmRaw) : null;
  const sugeridoUsd =
    usdCentavos !== null && trmSugeridoCentavos !== null
      ? copDesdeUsd(usdCentavos, trmSugeridoCentavos)
      : null;

  return (
    <ModalShell
      open
      onClose={onClose}
      title={isEdit ? "Editar factura de proveedor" : "Nueva factura de proveedor"}
      size="md"
      dismissible={!submitting}
    >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {bloqueo ? (
            <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {bloqueo.mensaje} Puedes seguir editando el concepto, el producto, la fecha y el archivo.
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="block space-y-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">Proveedor *</span>
              <BeneficiarioCombobox
                value={beneficiario}
                onChange={setBeneficiario}
                placeholder="Buscar o crear proveedor…"
                disabled={camposDineroBloqueados}
              />
            </div>

            <div className="block space-y-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">Concepto</span>
              <SiigoProductoCombobox
                valor={concepto}
                onChange={(texto, productoId) => {
                  setConcepto(texto);
                  setSiigoProductoId(productoId);
                }}
              />
            </div>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">N° factura *</span>
              <input
                value={numFactura}
                onChange={(e) => setNumFactura(e.target.value)}
                placeholder="Ej. FL-2026-001"
                required
                disabled={camposDineroBloqueados}
                title={bloqueo?.mensaje}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Fecha *</span>
              <input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                required
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Moneda</span>
              <select
                value={moneda}
                onChange={(e) => setMoneda(e.target.value as Moneda)}
                disabled={camposDineroBloqueados}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
              >
                <option value="COP">COP (pesos)</option>
                <option value="USD">USD (dólares)</option>
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                {moneda === "USD" ? "Valor en pesos (este es el que se paga) *" : "Valor (COP) *"}
              </span>
              <CampoMoneda
                value={valorRaw}
                onValueChange={setValorRaw}
                placeholder="1.000.000"
                required
                disabled={camposDineroBloqueados}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
              />
            </label>

            {moneda === "USD" ? (
              <>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">Valor en dólares *</span>
                  <CampoMoneda
                    value={valorUsdRaw}
                    onValueChange={setValorUsdRaw}
                    placeholder="131,00"
                    disabled={camposDineroBloqueados}
                    className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">TRM *</span>
                  <CampoMoneda
                    value={trmRaw}
                    onValueChange={setTrmRaw}
                    placeholder="3.710,50"
                    disabled={camposDineroBloqueados}
                    className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">Fecha de la TRM</span>
                  <input
                    type="date"
                    value={fechaTrm}
                    onChange={(e) => setFechaTrm(e.target.value)}
                    disabled={camposDineroBloqueados}
                    className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </label>
                {sugeridoUsd !== null && usdCentavos !== null && trmSugeridoCentavos !== null ? (
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    {formatoUsd(usdCentavos)} · TRM {formatoTrm(trmSugeridoCentavos)} ={" "}
                    <span className="font-semibold text-slate-700">{formatoPesos(sugeridoUsd)}</span>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Repercusión al cliente (M6) */}
          <label className="flex items-start gap-2.5 border border-slate-200 bg-slate-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={repercutible}
              onChange={(e) => setRepercutible(e.target.checked)}
              disabled={camposDineroBloqueados}
              className="mt-0.5 h-4 w-4"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Se le cobra al cliente</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Desmárcalo cuando la factura va a nombre de Galcomex y el cliente no debe
                verla (por ejemplo una asesoría). Se registra y se paga igual, pero no pasa a
                la factura de venta ni cuenta como desfase en la revisión. En ese caso el
                archivo es opcional (la clasificadora no manda factura) y se paga aunque el
                trámite no tenga anticipo.
              </span>
            </span>
          </label>

          {/* Adjuntar PDF */}
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">
              Archivo de la factura {repercutible ? "(obligatorio)" : "(opcional)"}
            </p>
            {documentoId && !documentoNombre ? (
              <p className="text-xs text-slate-500">
                Ya tiene un documento adjunto (ID: {documentoId.slice(0, 8)}…).
              </p>
            ) : null}
            {!isEdit || !facturaExistente?.documentoId ? (
              <SubidaInlinePDF
                tramiteId={tramiteId}
                onDocumentoSubido={handleDocumentoSubido}
              />
            ) : (
              <p className="text-xs text-slate-500">
                Documento adjunto existente. Para reemplazarlo, edita desde la sección de documentos.
              </p>
            )}
          </div>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {isEdit ? "Guardar cambios" : "Registrar factura"}
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ─── Diálogo: quitar ajuste de migración (LEGADO) ─────────────────────────────

type QuitarAjusteLegadoDialogProps = {
  factura: FacturaProveedorRow;
  ajusteId: string;
  onClose: () => void;
  onQuitado: () => void;
};

const MOTIVO_MIN = 10;

function QuitarAjusteLegadoDialog({ factura, ajusteId, onClose, onQuitado }: QuitarAjusteLegadoDialogProps) {
  // Solo ADMIN (§B.4). El padre ya condiciona el botón por rol; esto es
  // defensa en profundidad, igual que `AnularBloqueDialog` (P4).
  const esAdmin = useEsAdmin();
  const { toast } = useToast();
  const [motivo, setMotivo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!esAdmin) return null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (motivo.trim().length < MOTIVO_MIN) {
      setError(`Escribe el motivo (al menos ${MOTIVO_MIN} caracteres).`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await eliminarAjusteLegado(factura.id, ajusteId, motivo.trim());
      toast({ title: "Ajuste de migración quitado", description: factura.numFacturaVisible, variant: "success" });
      onQuitado();
    } catch (caught) {
      setError(describirError(caught, "No fue posible quitar el ajuste."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Quitar ajuste de migración"
      description={`${factura.numFacturaVisible} vuelve a quedar Pendiente o Abonada, según lo que falte.`}
      size="sm"
      dismissible={!submitting}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-700">Motivo *</span>
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            className="w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-cyan-600"
          />
        </label>
        {error ? (
          <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Quitar ajuste
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

type SeccionFacturasProveedorProps = {
  tramiteId: string;
  onPagarFactura: (factura: FacturaProveedorRow) => void;
  /** true = el DO está CERRADO: "Pagar" queda deshabilitado con el motivo. */
  tramiteCerrado?: boolean;
  /** Cambia cuando el detalle del DO se recargó: vuelve a leer las facturas. */
  refreshToken?: number;
};

export function SeccionFacturasProveedor({
  tramiteId,
  onPagarFactura,
  tramiteCerrado = false,
  refreshToken = 0,
}: SeccionFacturasProveedorProps) {
  const puedeCrear = usePermiso(ROLES_CREAR_FACTURA);
  const puedePagar = usePermiso(ROLES_PAGAR_FACTURA);
  const puedeModificar = usePermiso(ROLES_MODIFICAR_FACTURA);
  const esAdmin = useEsAdmin();
  const hayAcciones = puedePagar || puedeModificar;
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [facturas, setFacturas] = useState<FacturaProveedorRow[]>([]);
  const [documentos, setDocumentos] = useState<Record<string, DocumentoRow>>({});
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Modales
  const [modalAltaOpen, setModalAltaOpen] = useState(false);
  const [facturaParaEditar, setFacturaParaEditar] = useState<FacturaProveedorRow | null>(null);
  const [facturaParaReexpresar, setFacturaParaReexpresar] = useState<FacturaProveedorRow | null>(null);
  const [ajusteParaQuitar, setAjusteParaQuitar] = useState<{ factura: FacturaProveedorRow; ajusteId: string } | null>(
    null,
  );

  const cargarDocumentos = useCallback(
    async (tId: string, ids: string[]) => {
      try {
        const response = await fetch(`/api/tramites/${tId}/documentos`, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.documentos)) return;

        const mapa: Record<string, DocumentoRow> = {};
        for (const cat of Object.values(payload.documentos)) {
          if (Array.isArray(cat)) {
            for (const doc of cat) {
              if (isRecord(doc) && typeof doc.id === "string" && ids.includes(doc.id)) {
                mapa[doc.id] = {
                  id: String(doc.id),
                  tramiteId: String(doc.tramiteId ?? ""),
                  categoria: String(doc.categoria ?? "OTRO") as DocumentoRow["categoria"],
                  nombreArchivo: String(doc.nombreArchivo ?? ""),
                  storageKey: String(doc.storageKey ?? ""),
                  mimeType: String(doc.mimeType ?? ""),
                  tamanoBytes: typeof doc.tamanoBytes === "number" ? doc.tamanoBytes : 0,
                  eliminado: doc.eliminado === true,
                  subidoPorId: String(doc.subidoPorId ?? ""),
                  subidoPor: { id: "", name: "" },
                  createdAt: String(doc.createdAt ?? ""),
                  downloadUrl: String(doc.downloadUrl ?? ""),
                };
              }
            }
          }
        }
        setDocumentos(mapa);
      } catch {
        // silencioso — no critical
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState((prev) => (prev === "ready" ? prev : "loading"));
      setLoadError(null);

      try {
        const data = await fetchFacturasProveedor(tramiteId, controller.signal);
        setFacturas(data);
        setLoadState("ready");

        const idsConDoc = data.flatMap((f) => (f.documentoId ? [f.documentoId] : []));
        if (idsConDoc.length > 0) {
          void cargarDocumentos(tramiteId, idsConDoc);
        }
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar facturas de proveedor."));
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [tramiteId, reloadKey, refreshToken, cargarDocumentos]);

  const handleFacturaGuardada = useCallback((factura: FacturaProveedorRow) => {
    setFacturas((prev) => {
      const idx = prev.findIndex((f) => f.id === factura.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = factura;
        return next;
      }
      return [factura, ...prev];
    });
    setModalAltaOpen(false);
    setFacturaParaEditar(null);
  }, []);

  async function handleDelete(factura: FacturaProveedorRow) {
    const ok = await confirmar({
      title: `¿Eliminar la factura "${factura.numFacturaVisible}"?`,
      description: "Esta acción no se puede deshacer.",
      confirmText: "Eliminar factura",
      variant: "danger",
    });
    if (!ok) return;

    setDeletingId(factura.id);

    try {
      await deleteFacturaProveedor(factura.id);
      setFacturas((prev) => prev.filter((f) => f.id !== factura.id));
      toast({ title: "Factura eliminada", description: factura.numFacturaVisible, variant: "success" });
    } catch (caught) {
      toast({
        title: "No se pudo eliminar la factura",
        description: describirError(caught, "Error al eliminar la factura."),
        variant: "error",
      });
    } finally {
      setDeletingId(null);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const NUM_COLS = hayAcciones ? 9 : 8;

  if (loadState === "loading") {
    return <TableSkeleton rows={4} cols={NUM_COLS} rowHeight={44} />;
  }

  if (loadState === "error") {
    return (
      <ModuleState
        type="error"
        title="No fue posible cargar las facturas de proveedor"
        detail={loadError ?? undefined}
        action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
      />
    );
  }

  /** Lee un monto de la API (pesos, 2 decimales); 0 si viene vacío o dañado (no debería). */
  const centavosDeApi = (v: string | undefined) => {
    if (!v) return 0n;
    try {
      return centavosDeTextoApi(v);
    } catch {
      return 0n;
    }
  };
  const totalValor = facturas.reduce((sum, f) => sum + centavosDeApi(f.valor), 0n);
  // "Pagado" = pagos del libro (misma definición que la ficha del proveedor y
  // sus tarjetas); lo cruzado y los ajustes de migración se muestran aparte.
  const sumar = (campo: "aplicado" | "compensado" | "ajustado") =>
    facturas.reduce((sum, f) => sum + centavosDeApi(f[campo]), 0n);
  const totalPagado = sumar("aplicado");
  const totalCruzado = sumar("compensado");
  const totalAjustado = sumar("ajustado");
  const totalSaldo = facturas.reduce((sum, f) => sum + centavosDeApi(f.saldo), 0n);

  return (
    <section className="space-y-4">
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Facturas de proveedor ({facturas.length})
            </p>
            {facturas.length > 0 ? (
              <p className="mt-0.5 text-xs text-slate-500">
                Total: <span className="font-semibold text-slate-700">{formatoPesos(totalValor)}</span>
                {" · "}Pagado: <span className="font-semibold text-slate-700">{formatoPesos(totalPagado)}</span>
                {totalCruzado > 0n ? (
                  <>
                    {" · "}Cruzado: <span className="font-semibold text-slate-700">{formatoPesos(totalCruzado)}</span>
                  </>
                ) : null}
                {totalAjustado > 0n ? (
                  <>
                    {" · "}Ajustes de migración:{" "}
                    <span className="font-semibold text-slate-700">{formatoPesos(totalAjustado)}</span>
                  </>
                ) : null}
                {" · "}Saldo: <span className="font-semibold text-amber-700">{formatoPesos(totalSaldo)}</span>
              </p>
            ) : null}
          </div>
          {puedeCrear ? (
            <button
              type="button"
              onClick={() => setModalAltaOpen(true)}
              className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nueva factura
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">Proveedor</th>
                <th className="border-b border-slate-200 px-3 py-2">N° factura</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Pagado</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Saldo</th>
                <th className="border-b border-slate-200 px-3 py-2 text-center">Estado</th>
                <th className="border-b border-slate-200 px-3 py-2">Cobrada al cliente</th>
                <th className="border-b border-slate-200 px-3 py-2 text-center">Archivo</th>
                {hayAcciones ? (
                  <th className="border-b border-slate-200 px-3 py-2 text-right w-40">Acciones</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {facturas.length === 0 ? (
                <tr>
                  <td colSpan={NUM_COLS} className="px-4 py-10 text-center text-sm text-slate-500">
                    Sin facturas de proveedor registradas.{" "}
                    {puedeCrear ? 'Usa "Nueva factura" para agregar la primera.' : ""}
                  </td>
                </tr>
              ) : null}
              {facturas.map((f) => {
                const doc = f.documentoId ? documentos[f.documentoId] : null;
                const ajusteLegado = f.ajustes.find((a) => a.tipo === "LEGADO");
                const saldo = centavosDeApi(f.saldo);
                const pagado = centavosDeApi(f.aplicado);
                const cruzado = centavosDeApi(f.compensado);
                const ajustado = centavosDeApi(f.ajustado);
                const puedePagarEstaFila = puedePagar && saldo > 0n && !tramiteCerrado;
                const motivoNoPagar = tramiteCerrado
                  ? "El DO está cerrado."
                  : saldo <= 0n
                    ? "Sin saldo pendiente."
                    : undefined;

                return (
                  <tr key={f.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-medium text-slate-900">
                      {f.beneficiario?.nombreCorto || f.proveedorNombre}
                      {f.proveedorNit ? <span className="block text-[11px] font-normal text-slate-400">{f.proveedorNit}</span> : null}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-800">
                      {f.numFacturaVisible}
                      {!f.repercutible ? (
                        <span
                          className="ml-1.5 border border-slate-300 bg-slate-100 px-1 py-0.5 font-sans text-[10px] font-semibold text-slate-600"
                          title="No se traslada al cliente: no pasa a la factura de venta"
                        >
                          NO SE COBRA
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{formatFechaCalendario(f.fecha, "corta")}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900">
                      {formatCOP(f.valor)}
                      {f.moneda === "USD" && f.valorOrigen && f.trm ? (
                        <span className="block font-sans text-[11px] font-normal text-slate-400">
                          {formatoUsd(centavosDeTextoApi(f.valorOrigen))} · TRM {formatoTrm(centavosDeTextoApi(f.trm))}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                      {formatoPesos(pagado)}
                      {cruzado > 0n ? (
                        <span className="block font-sans text-[11px] font-normal text-slate-400">
                          + cruzado {formatoPesos(cruzado)}
                        </span>
                      ) : null}
                      {ajustado > 0n ? (
                        <span className="block font-sans text-[11px] font-normal text-slate-400">
                          + ajuste {formatoPesos(ajustado)}
                        </span>
                      ) : null}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono font-semibold ${saldo > 0n ? "text-amber-700" : "text-slate-400"}`}>
                      {formatoPesos(saldo)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <EstadoBadge etiqueta={f.etiqueta} fila={f} />
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {f.facturadaAlCliente ? (
                        <EnlaceFacturaVenta tramiteId={f.tramiteId} className="font-semibold text-cyan-700 hover:underline">
                          {f.facturadaAlCliente.numSiigo ?? "En borrador"}
                        </EnlaceFacturaVenta>
                      ) : (
                        <span className="text-slate-400">No</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {doc?.downloadUrl ? (
                        <a
                          href={doc.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-7 items-center gap-1 border border-slate-200 bg-white px-2 text-xs text-slate-600 transition hover:border-cyan-400 hover:text-cyan-700"
                          title={doc.nombreArchivo}
                        >
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      ) : f.documentoId ? (
                        <span className="text-xs text-slate-400">Cargando…</span>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    {hayAcciones ? (
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {puedePagar && saldo > 0n ? (
                            <button
                              type="button"
                              onClick={() => onPagarFactura(f)}
                              disabled={!puedePagarEstaFila}
                              title={motivoNoPagar}
                              className="inline-flex h-7 items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={`Pagar ${formatCOP(f.saldo)} de la factura ${f.numFacturaVisible}`}
                            >
                              <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                              Pagar {formatCOP(f.saldo)}
                            </button>
                          ) : null}

                          {esAdmin && f.moneda === "USD" ? (
                            <button
                              type="button"
                              onClick={() => setFacturaParaReexpresar(f)}
                              className="inline-flex h-7 items-center gap-1 border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                              title="Re-expresar en pesos (nueva TRM)"
                            >
                              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : null}

                          {esAdmin && ajusteLegado ? (
                            <button
                              type="button"
                              onClick={() => setAjusteParaQuitar({ factura: f, ajusteId: ajusteLegado.id })}
                              className="inline-flex h-7 items-center gap-1 border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                              title="Quitar ajuste de migración (la reabre)"
                            >
                              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : null}

                          {puedeModificar ? (
                            <button
                              type="button"
                              onClick={() => setFacturaParaEditar(f)}
                              className="inline-flex h-7 w-7 items-center justify-center border border-slate-200 text-slate-400 transition hover:text-slate-700"
                              aria-label={`Editar factura ${f.numFacturaVisible}`}
                              title="Editar"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : null}

                          {puedeModificar && f.puedeEliminar ? (
                            <button
                              type="button"
                              onClick={() => void handleDelete(f)}
                              disabled={deletingId === f.id}
                              className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                              aria-label={`Eliminar factura ${f.numFacturaVisible}`}
                              title="Eliminar"
                            >
                              {deletingId === f.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modalAltaOpen && puedeCrear ? (
        <ModalFacturaProveedor
          tramiteId={tramiteId}
          onClose={() => setModalAltaOpen(false)}
          onGuardada={handleFacturaGuardada}
        />
      ) : null}

      {facturaParaEditar && puedeModificar ? (
        <ModalFacturaProveedor
          tramiteId={tramiteId}
          facturaExistente={facturaParaEditar}
          onClose={() => setFacturaParaEditar(null)}
          onGuardada={handleFacturaGuardada}
        />
      ) : null}

      {facturaParaReexpresar ? (
        <ReexpresarUsdModal
          factura={facturaParaReexpresar}
          onClose={() => setFacturaParaReexpresar(null)}
          onReexpresada={(actualizada) => {
            handleFacturaGuardada(actualizada);
            setFacturaParaReexpresar(null);
          }}
        />
      ) : null}

      {ajusteParaQuitar ? (
        <QuitarAjusteLegadoDialog
          factura={ajusteParaQuitar.factura}
          ajusteId={ajusteParaQuitar.ajusteId}
          onClose={() => setAjusteParaQuitar(null)}
          onQuitado={() => {
            setAjusteParaQuitar(null);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </section>
  );
}
