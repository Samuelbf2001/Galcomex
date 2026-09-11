"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

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
  CANALES_PAGO,
  type CanalPago,
} from "@/components/pagos/pagos-api";
import {
  type CreateFacturaProveedorInput,
  type EstadoFacturaProveedor,
  type FacturaProveedorRow,
  type GenerarPagoInput,
  type UpdateFacturaProveedorInput,
  FacturasProveedorApiError,
  createFacturaProveedor,
  deleteFacturaProveedor,
  fetchFacturasProveedor,
  formatCOP,
  generarPagoDesdeFactura,
  parseBigIntInput,
} from "@/components/facturas-proveedor/facturas-proveedor-api";

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

/** POST /api/tramites/[id]/facturas-proveedor y generar-pago admiten SOCIO. */
const ROLES_CREAR_PAGAR_FACTURA = ["ADMIN", "OPERATIVO", "SOCIO"] as const;
/** PATCH/DELETE /api/facturas-proveedor/[id] son solo ADMIN/OPERATIVO. */
const ROLES_MODIFICAR_FACTURA = ["ADMIN", "OPERATIVO"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function dateInputToIso(value: string): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

// Badge de estado de la factura de proveedor
function EstadoBadge({ estado }: { estado: EstadoFacturaProveedor }) {
  const map: Record<EstadoFacturaProveedor, { label: string; cls: string }> = {
    REGISTRADA: {
      label: "Registrada",
      cls: "border-slate-200 bg-slate-50 text-slate-700",
    },
    PAGADA: {
      label: "Pagada",
      cls: "border-emerald-200 bg-emerald-50 text-emerald-700",
    },
    FACTURADA_CLIENTE: {
      label: "Facturada",
      cls: "border-cyan-200 bg-cyan-50 text-cyan-700",
    },
  };
  const { label, cls } = map[estado] ?? map.REGISTRADA;
  return (
    <span className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${cls}`}>
      {label}
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

  const initialBeneficiario: BeneficiarioSeleccion | null =
    facturaExistente?.beneficiarioId
      ? {
          id: facturaExistente.beneficiarioId,
          nombre: facturaExistente.proveedorNombre,
          nit: facturaExistente.proveedorNit,
        }
      : null;

  const [beneficiario, setBeneficiario] = useState<BeneficiarioSeleccion | null>(
    initialBeneficiario,
  );
  const [concepto, setConcepto] = useState(facturaExistente?.concepto ?? "");
  const [siigoProductoId, setSiigoProductoId] = useState<string | undefined>(undefined);
  const [numFactura, setNumFactura] = useState(
    facturaExistente?.numFactura ?? "",
  );
  const [fecha, setFecha] = useState(
    facturaExistente ? isoToDateInput(facturaExistente.fecha) : "",
  );
  const [valorRaw, setValorRaw] = useState(
    facturaExistente?.valor ?? "",
  );
  const [documentoId, setDocumentoId] = useState<string | null>(
    facturaExistente?.documentoId ?? null,
  );
  const [repercutible, setRepercutible] = useState<boolean>(
    facturaExistente?.repercutible !== false,
  );
  const [documentoNombre, setDocumentoNombre] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  function handleDocumentoSubido(docId: string, nombre: string) {
    setDocumentoId(docId);
    setDocumentoNombre(nombre);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig) {
      setError("El valor debe ser un número entero mayor a 0.");
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
    if (!isEdit && !documentoId) {
      setError("El archivo de la factura es obligatorio.");
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && facturaExistente) {
        // PATCH — update parcial usando la misma API helper de create pero con el endpoint PATCH
        const input: UpdateFacturaProveedorInput = {
          beneficiarioId: beneficiario.id,
          concepto: concepto.trim() || null,
          siigoProductoId: siigoProductoId ?? null,
          // backward compatibility: send legacy fields only when they were already set
          ...(facturaExistente.proveedorNombre
            ? { proveedorNombre: beneficiario.nombre }
            : {}),
          ...(facturaExistente.proveedorNit !== null
            ? { proveedorNit: beneficiario.nit }
            : {}),
          numFactura: numFactura.trim(),
          valor: valorBig,
          fecha: dateInputToIso(fecha) ?? undefined,
          documentoId,
          repercutible,
        };

        const response = await fetch(`/api/facturas-proveedor/${facturaExistente.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(input),
        });

        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const msg =
            isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : `Error al actualizar (${response.status}).`;
          throw new FacturasProveedorApiError(msg, response.status);
        }
        if (!isRecord(payload) || !isRecord(payload.factura)) {
          throw new FacturasProveedorApiError("Respuesta de actualización no válida.");
        }

        const updated = payload.factura;
        toast({ title: "Factura actualizada", description: numFactura.trim(), variant: "success" });
        onGuardada({
          id: String(updated.id ?? ""),
          tramiteId: String(updated.tramiteId ?? ""),
          proveedorNombre: String(updated.proveedorNombre ?? ""),
          proveedorNit: typeof updated.proveedorNit === "string" ? updated.proveedorNit : null,
          beneficiarioId: typeof updated.beneficiarioId === "string" ? updated.beneficiarioId : null,
          concepto: typeof updated.concepto === "string" ? updated.concepto : null,
          numFactura: String(updated.numFactura ?? ""),
          valor: String(updated.valor ?? "0"),
          fecha: typeof updated.fecha === "string" ? updated.fecha : "",
          estado: (updated.estado as EstadoFacturaProveedor) ?? "REGISTRADA",
          documentoId: typeof updated.documentoId === "string" ? updated.documentoId : null,
          repercutible: updated.repercutible !== false,
          subidaPorId: String(updated.subidaPorId ?? ""),
          createdAt: String(updated.createdAt ?? ""),
          updatedAt: String(updated.updatedAt ?? ""),
        });
      } else {
        const input: CreateFacturaProveedorInput = {
          beneficiarioId: beneficiario.id,
          concepto: concepto.trim() || null,
          siigoProductoId: siigoProductoId ?? null,
          proveedorNombre: beneficiario.nombre,
          proveedorNit: beneficiario.nit,
          numFactura: numFactura.trim(),
          valor: valorBig,
          fecha: dateInputToIso(fecha) ?? "",
          documentoId,
          repercutible,
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
      setError(describirError(caught, "Error al guardar la factura."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title={isEdit ? "Editar factura de proveedor" : "Nueva factura de proveedor"}
      size="md"
      dismissible={!submitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="block space-y-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">Proveedor *</span>
              <BeneficiarioCombobox
                value={beneficiario}
                onChange={setBeneficiario}
                placeholder="Buscar o crear proveedor…"
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
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
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
              <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
              <input
                value={valorRaw}
                onChange={(e) => setValorRaw(e.target.value)}
                placeholder="1.000.000"
                inputMode="numeric"
                required
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          {/* Repercusión al cliente (M6) */}
          <label className="flex items-start gap-2.5 border border-slate-200 bg-slate-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={repercutible}
              onChange={(e) => setRepercutible(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Se le cobra al cliente</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Desmárcalo cuando la factura va a nombre de Galcomex y el cliente no debe
                verla (por ejemplo una asesoría). Se registra y se paga igual, pero no pasa a
                la factura de venta ni cuenta como desfase en la revisión.
              </span>
            </span>
          </label>

          {/* Adjuntar PDF */}
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">
              Archivo PDF (opcional)
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

// ─── Modal: Generar pago ──────────────────────────────────────────────────────

type ModalGenerarPagoProps = {
  factura: FacturaProveedorRow;
  onClose: () => void;
  onPagoGenerado: (factura: FacturaProveedorRow) => void;
};

function ModalGenerarPago({
  factura,
  onClose,
  onPagoGenerado,
}: ModalGenerarPagoProps) {
  const [canal, setCanal] = useState<CanalPago>("TRANSF_BANCOLOMBIA");
  const [viaSocio, setViaSocio] = useState(false);
  const [fechaRealPago, setFechaRealPago] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    const input: GenerarPagoInput = {
      canalPago: canal,
      viaSocio,
      fechaRealPago: fechaRealPago ? new Date(`${fechaRealPago}T00:00:00.000Z`).toISOString() : null,
    };

    try {
      const result = await generarPagoDesdeFactura(factura.id, input);
      toast({
        title: "Pago generado",
        description: `${factura.numFactura} · ${formatCOP(result.pago.valor)}`,
        variant: "success",
      });
      onPagoGenerado(result.factura);
    } catch (caught) {
      setError(describirError(caught, "Error al generar el pago."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Generar pago"
      description={`${factura.proveedorNombre} · ${factura.numFactura} · ${formatCOP(factura.valor)}`}
      size="sm"
      dismissible={!submitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
            <select
              value={canal}
              onChange={(e) => setCanal(e.target.value as CanalPago)}
              required
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              {CANALES_PAGO.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Fecha real de pago</span>
            <input
              type="date"
              value={fechaRealPago}
              onChange={(e) => setFechaRealPago(e.target.value)}
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={viaSocio}
              onChange={(e) => setViaSocio(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer border-slate-300 text-slate-900"
            />
            <div>
              <span className="text-sm font-medium text-slate-700">
                Pagado en efectivo vía Lucho (socio LM)
              </span>
              <p className="text-xs text-slate-500">
                Marca si la transferencia fue recibida por el socio y pagada en efectivo.
              </p>
            </div>
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
              className="inline-flex h-10 items-center gap-2 bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              Generar pago
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

type SeccionFacturasProveedorProps = {
  tramiteId: string;
  onPagarFactura?: (factura: FacturaProveedorRow) => void;
  /** Cambia cuando el detalle del DO se recargó: vuelve a leer las facturas. */
  refreshToken?: number;
};

export function SeccionFacturasProveedor({
  tramiteId,
  onPagarFactura,
  refreshToken = 0,
}: SeccionFacturasProveedorProps) {
  // Permisos alineados con cada endpoint (ver constantes arriba). Antes
  // `puedeEditar = rol !== "REVISOR"` dejaba editar/eliminar a SOCIO.
  const puedeCrear = usePermiso(ROLES_CREAR_PAGAR_FACTURA);
  const puedePagar = puedeCrear;
  const puedeModificar = usePermiso(ROLES_MODIFICAR_FACTURA);
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
  const [facturaParaEditar, setFacturaParaEditar] =
    useState<FacturaProveedorRow | null>(null);
  const [facturaParaPago, setFacturaParaPago] =
    useState<FacturaProveedorRow | null>(null);

  // Carga URLs de descarga para documentos adjuntos de facturas (no-critical)
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

  // Carga de facturas
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      // Solo la primera carga muestra el skeleton; las recargas conservan la tabla.
      setLoadState((prev) => (prev === "ready" ? prev : "loading"));
      setLoadError(null);

      try {
        const data = await fetchFacturasProveedor(tramiteId, controller.signal);
        setFacturas(data);
        setLoadState("ready");

        // Cargar URLs de descarga de los documentos adjuntos en background
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

  const handleFacturaGuardada = useCallback(
    (factura: FacturaProveedorRow) => {
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
    },
    [],
  );

  const handlePagoGenerado = useCallback(
    (facturaActualizada: FacturaProveedorRow) => {
      setFacturas((prev) =>
        prev.map((f) => (f.id === facturaActualizada.id ? facturaActualizada : f)),
      );
      setFacturaParaPago(null);
    },
    [],
  );

  async function handleDelete(facturaId: string, numFact: string) {
    const ok = await confirmar({
      title: `¿Eliminar la factura "${numFact}"?`,
      description: "Esta acción no se puede deshacer.",
      confirmText: "Eliminar factura",
      variant: "danger",
    });
    if (!ok) return;

    setDeletingId(facturaId);

    try {
      await deleteFacturaProveedor(facturaId);
      setFacturas((prev) => prev.filter((f) => f.id !== facturaId));
      toast({ title: "Factura eliminada", description: numFact, variant: "success" });
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

  if (loadState === "loading") {
    return <TableSkeleton rows={4} cols={hayAcciones ? 8 : 7} rowHeight={44} />;
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

  const totalValor = facturas.reduce((sum, f) => {
    try {
      return sum + BigInt(f.valor);
    } catch {
      return sum;
    }
  }, 0n);

  return (
    <section className="space-y-4">
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Facturas de proveedor ({facturas.length})
            </p>
            {facturas.length > 0 ? (
              <p className="text-xs text-slate-500 mt-0.5">
                Total: <span className="font-semibold text-slate-700">{formatCOP(totalValor.toString())}</span>
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
          <table className="w-full min-w-[800px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">Proveedor</th>
                <th className="border-b border-slate-200 px-3 py-2">NIT</th>
                <th className="border-b border-slate-200 px-3 py-2">N° factura</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor</th>
                <th className="border-b border-slate-200 px-3 py-2 text-center">Estado</th>
                <th className="border-b border-slate-200 px-3 py-2 text-center">Archivo</th>
                {hayAcciones ? (
                  <th className="border-b border-slate-200 px-3 py-2 text-right w-28">Acciones</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {facturas.length === 0 ? (
                <tr>
                  <td
                    colSpan={hayAcciones ? 8 : 7}
                    className="px-4 py-10 text-center text-sm text-slate-500"
                  >
                    Sin facturas de proveedor registradas.{" "}
                    {puedeCrear ? 'Usa "Nueva factura" para agregar la primera.' : ""}
                  </td>
                </tr>
              ) : null}
              {facturas.map((f) => {
                const doc = f.documentoId ? documentos[f.documentoId] : null;
                const beneficiarioDisplay = f.proveedorNombre;
                return (
                  <tr
                    key={f.id}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2.5 font-medium text-slate-900">
                      {beneficiarioDisplay}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600">
                      {f.proveedorNit ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-800">
                      {f.numFactura}
                      {!f.repercutible ? (
                        <span
                          className="ml-1.5 border border-slate-300 bg-slate-100 px-1 py-0.5 font-sans text-[10px] font-semibold text-slate-600"
                          title="No se traslada al cliente: no pasa a la factura de venta"
                        >
                          NO SE COBRA
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{formatDate(f.fecha)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900">
                      {formatCOP(f.valor)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <EstadoBadge estado={f.estado} />
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
                        <div className="flex items-center justify-end gap-1">
                          {/* Generar pago: disponible mientras no esté facturada al cliente */}
                          {puedePagar && f.estado !== "FACTURADA_CLIENTE" ? (
                            <button
                              type="button"
                              onClick={() => {
                                if (onPagarFactura) {
                                  onPagarFactura(f);
                                  return;
                                }

                                setFacturaParaPago(f);
                              }}
                              className="inline-flex h-7 items-center gap-1 border border-emerald-300 bg-emerald-50 px-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
                              title="Generar pago"
                              aria-label={`Generar pago de la factura ${f.numFactura}`}
                            >
                              <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                              Pagar
                            </button>
                          ) : null}

                          {/* Editar: ADMIN/OPERATIVO */}
                          {puedeModificar ? (
                            <button
                              type="button"
                              onClick={() => setFacturaParaEditar(f)}
                              className="inline-flex h-7 w-7 items-center justify-center border border-slate-200 text-slate-400 transition hover:text-slate-700"
                              aria-label={`Editar factura ${f.numFactura}`}
                              title="Editar"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          ) : null}

                          {/* Eliminar: ADMIN/OPERATIVO y solo si REGISTRADA (sin pagos) */}
                          {puedeModificar && f.estado === "REGISTRADA" ? (
                            <button
                              type="button"
                              onClick={() => void handleDelete(f.id, f.numFactura)}
                              disabled={deletingId === f.id}
                              className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                              aria-label={`Eliminar factura ${f.numFactura}`}
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

      {/* Modal alta */}
      {modalAltaOpen && puedeCrear ? (
        <ModalFacturaProveedor
          tramiteId={tramiteId}
          onClose={() => setModalAltaOpen(false)}
          onGuardada={handleFacturaGuardada}
        />
      ) : null}

      {/* Modal edición */}
      {facturaParaEditar && puedeModificar ? (
        <ModalFacturaProveedor
          tramiteId={tramiteId}
          facturaExistente={facturaParaEditar}
          onClose={() => setFacturaParaEditar(null)}
          onGuardada={handleFacturaGuardada}
        />
      ) : null}

      {/* Modal generar pago */}
      {facturaParaPago ? (
        <ModalGenerarPago
          factura={facturaParaPago}
          onClose={() => setFacturaParaPago(null)}
          onPagoGenerado={handlePagoGenerado}
        />
      ) : null}
    </section>
  );
}
