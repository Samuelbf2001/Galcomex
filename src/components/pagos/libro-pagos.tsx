"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  MessageCircle,
  Lock,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceFacturaVenta } from "@/components/ui/enlace-entidad";
import { humanizarCodigo } from "@/components/ui/estado-tramite";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast, type ToastVariant } from "@/components/ui/toast";
import { useEsAdmin, usePermiso } from "@/lib/auth/rol-context";
import { formatFechaCalendario, hoyBogotaISO } from "@/lib/tiempo/bogota";

import {
  CANALES_PAGO,
  type AplicacionRow,
  type CanalPago,
  type EstadoMovimiento,
  type FacturaProveedorOpcion,
  type LibroPagosData,
  type PagoRow,
  type TramiteDetail,
  calcularSaldosCliente,
  createPago,
  deletePago,
  fetchFacturasProveedorTramite,
  fetchLibroPagos,
  fetchTramiteDetail,
  formatCOP,
  subirComprobante,
  valorParaSaldoCliente,
  updatePago,
  verificarMovimientoPago,
} from "@/components/pagos/pagos-api";
import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { AnularBloqueDialog } from "@/components/pagos/anular-bloque-dialog";
import { DetalleBloqueDialog } from "@/components/pagos/detalle-bloque-dialog";
import { nuevaClaveIdempotencia } from "@/components/pagos/clave-idempotencia";

// ---------------------------------------------------------------------------
// Tipos internos
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

/**
 * Crear/editar/eliminar/verificar pagos y el flujo PSE exigen ADMIN/OPERATIVO
 * (`/api/tramites/[id]/pagos*`, `verificar`, `pse-token`, `pse-codigo`).
 * REVISOR y SOCIO ven el libro en solo lectura.
 */
const ROLES_EDITAR_PAGOS = ["ADMIN", "OPERATIVO"] as const;
/** GET /api/pagos/grupos/[id] admite estos roles (no SOCIO): el detalle del bloque solo se abre para ellos. */
const ROLES_DETALLE_BLOQUE = ["ADMIN", "REVISOR", "OPERATIVO"] as const;

/** Fila del libro con saldo corriente calculado localmente */
type FilaLibro = PagoRow & {
  saldoLocal: string; // BigInt serializado
  editingValor: string; // cadena de texto mientras edita
  editingConcepto: string;
  editingBeneficiarios: BeneficiarioSeleccion[]; // lista seleccionada N↔N
  editingNumSoporte: string;
  editingCanal: CanalPago;
  editingFechaReal: string; // YYYY-MM-DD o ""
  dirty: boolean; // tiene cambios pendientes de PATCH
  saving: boolean;
  errorFila: string | null;
};

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** "Hoy" es el día calendario en Bogotá (R17): después de las 19:00 no propone mañana. */
function todayInput(): string {
  return hoyBogotaISO();
}

function filaFromRow(row: PagoRow, saldo: string): FilaLibro {
  return {
    ...row,
    saldoLocal: saldo,
    editingValor: row.valor,
    editingConcepto: row.concepto,
    editingBeneficiarios: row.beneficiarios ?? [],
    editingNumSoporte: row.numSoporte ?? "",
    editingCanal: row.canalPago,
    // Sin fecha real se edita vacía (§D.4): nunca se inventa "hoy", que se
    // grabaría al guardar cualquier otro campo de la fila.
    editingFechaReal: isoToDateInput(row.fechaRealPago),
    dirty: false,
    saving: false,
    errorFila: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers de formato / parseo
// ---------------------------------------------------------------------------

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  try {
    return BigInt(cleaned).toString();
  } catch {
    return null;
  }
}

function saldoColorClass(saldoStr: string): string {
  try {
    const n = BigInt(saldoStr);
    if (n > 0n) return "text-emerald-700 font-semibold";
    if (n < 0n) return "text-rose-600 font-semibold";
    return "text-slate-700 font-semibold";
  } catch {
    return "text-slate-700";
  }
}

/** Fechas-calendario (ETA, fecha del anticipo, fecha real de pago): en UTC, el mismo día en cualquier navegador (R17). */
function formatDate(iso: string): string {
  return formatFechaCalendario(iso);
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de anticipos (fiel al Excel — encima de los pagos)
// ---------------------------------------------------------------------------

function canalLabel(canal: string): string {
  const map: Record<string, string> = {
    BANCOLOMBIA_SUCURSAL: "Bancolombia Sucursal",
    BANCOLOMBIA_CAJERO: "Bancolombia Cajero",
    BANCOLOMBIA_CORRESPONSAL: "Bancolombia Corresponsal",
    BANCOLOMBIA_TRANSFERENCIA: "Bancolombia Transferencia",
    OTROS_BANCOS_SUCURSAL: "Otros Bancos Sucursal",
    OTROS_BANCOS_TRANSFERENCIA: "Otros Bancos Transferencia",
    PSE: "PSE",
    OTRO: "Otro",
  };
  return map[canal] ?? humanizarCodigo(canal);
}

function SeccionAnticipos({
  aplicaciones,
  totalAnticipoAplicado,
  costosBancariosAnticipo,
}: {
  aplicaciones: AplicacionRow[];
  totalAnticipoAplicado: string;
  costosBancariosAnticipo: string;
}) {
  return (
    <div className="overflow-hidden border border-emerald-200 bg-white">
      <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50 px-4 py-2.5">
        <p className="text-sm font-semibold text-emerald-900">
          Anticipos aplicados a este DO
        </p>
        {aplicaciones.length === 0 ? (
          <span className="text-xs text-emerald-700">Sin anticipos</span>
        ) : null}
      </div>

      {aplicaciones.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-500">
          No hay anticipos aplicados. Registre uno desde el módulo de Anticipos.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2">Fecha</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Monto aplicado (COP)</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Monto total anticipo</th>
                  <th className="border-b border-slate-200 px-4 py-2">Tipo de recaudo</th>
                  <th className="border-b border-slate-200 px-4 py-2 text-right">Costo bancario</th>
                  <th className="border-b border-slate-200 px-4 py-2">Verificado</th>
                </tr>
              </thead>
              <tbody>
                {aplicaciones.map((ap) => (
                  <tr key={ap.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5 text-slate-700">{formatDate(ap.anticipo.fecha)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-700">
                      {formatCOP(ap.montoAplicado)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                      {formatCOP(ap.anticipo.monto)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 text-xs">{canalLabel(ap.anticipo.tipoRecaudo)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-600">
                      {formatCOP(ap.anticipo.costoBancario)}
                    </td>
                    <td className="px-4 py-2.5">
                      {ap.anticipo.verificadoBanco ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      ) : (
                        <span className="text-xs text-slate-500">Pendiente</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Totales del bloque anticipo */}
          <div className="flex flex-wrap gap-6 border-t border-emerald-100 bg-emerald-50 px-4 py-2.5 text-sm">
            <div>
              <span className="text-emerald-700">Total anticipo aplicado: </span>
              <span className="font-bold text-emerald-900">{formatCOP(totalAnticipoAplicado)}</span>
            </div>
            <div>
              <span className="text-emerald-700">Costos bancarios anticipo: </span>
              <span className="font-semibold text-emerald-900">{formatCOP(costosBancariosAnticipo)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: resumen del libro
// ---------------------------------------------------------------------------

function ResumenLibro({
  libro,
  tramiteId,
}: {
  libro: LibroPagosData;
  filas: FilaLibro[];
  tramiteId: string;
}) {
  const cruce = libro.cruceFactura;
  // Cruce con cliente: usa SIEMPRE el saldo del borrador (derivado de Σ líneas
  // + comisión + IVA − retenciones). NO se rederiva contra Σ pagos.
  // Ver memoria `project_cruce_factura.md`.
  let cruceSaldoStr: string | null = null;
  let cruceLabel = "";
  if (cruce) {
    try {
      const aFavor = BigInt(cruce.saldoAFavorCliente);
      const aCargo = BigInt(cruce.saldoACargoCliente);
      if (aFavor > 0n) {
        cruceSaldoStr = aFavor.toString();
        cruceLabel = "Saldo a favor del cliente";
      } else if (aCargo > 0n) {
        cruceSaldoStr = (-aCargo).toString();
        cruceLabel = "Saldo a cargo del cliente";
      } else {
        cruceSaldoStr = "0";
        cruceLabel = "Cruce equilibrado";
      }
    } catch {
      cruceSaldoStr = null;
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-slate-200 bg-slate-50 px-5 py-3 text-sm">
      <div className="flex flex-wrap gap-6">
        <div>
          <span className="text-slate-500">Anticipo aplicado: </span>
          <span className="font-semibold text-slate-900">
            {formatCOP(libro.totalAnticipoAplicado)}
          </span>
        </div>
        <div>
          <span className="text-slate-500">Total pagos: </span>
          <span className="font-semibold text-slate-900">{formatCOP(libro.totalPagos)}</span>
          {BigInt(libro.totalNoCobrable) > 0n ? (
            <span className="ml-2 text-[11px] text-slate-500">
              de los que {formatCOP(libro.totalNoCobrable)} son asesoría NO SE COBRA: la asume
              Galcomex y no baja el saldo del cliente
            </span>
          ) : null}
        </div>
        <div>
          <span className="text-slate-500">Costos bancarios: </span>
          <span className="font-semibold text-slate-900">{formatCOP(libro.costosBancarios)}</span>
        </div>
        <div>
          <span className="text-slate-500">
            Saldo operativo (vs. pagos):{" "}
          </span>
          <span className={`text-base ${saldoColorClass(libro.saldoFinal)}`}>
            {formatCOP(libro.saldoFinal)}
          </span>
          <span className="ml-2 text-[11px] text-slate-500">
            no incluye comisión, IVA, 4x1000 ni costos
          </span>
        </div>
      </div>
      {cruce && cruceSaldoStr !== null ? (
        <div className="flex flex-wrap items-baseline gap-3 border-t border-slate-200 pt-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Cruce con factura de venta
          </span>
          <span className="text-slate-700">
            {cruce.numSiigo ? (
              <EnlaceFacturaVenta tramiteId={tramiteId} className="font-mono">
                {cruce.numSiigo}
              </EnlaceFacturaVenta>
            ) : (
              <span className="italic text-slate-500">
                Borrador APROBADO (pendiente de estampar)
              </span>
            )}
          </span>
          <span className="text-slate-500">
            Total factura: <span className="font-semibold text-slate-800">{formatCOP(cruce.totalFactura)}</span>
          </span>
          <span>
            <span className="text-slate-500">{cruceLabel}: </span>
            <span className={`text-base font-semibold ${saldoColorClass(cruceSaldoStr)}`}>
              {formatCOP(cruceSaldoStr)}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

type FacturasProveedorComboboxProps = {
  facturas: FacturaProveedorOpcion[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
};

function FacturasProveedorCombobox({
  facturas,
  selectedIds,
  onChange,
  placeholder = "Seleccionar facturas de proveedor…",
  disabled = false,
}: FacturasProveedorComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  const selectedFacturas = facturas.filter((factura) => selectedIds.includes(factura.id));
  const filteredFacturas = facturas.filter((factura) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    return [
      factura.numFactura,
      factura.proveedorNombre,
    ].some((value) => value.toLowerCase().includes(needle));
  });

  function toggleFactura(id: string) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  function removeFactura(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    onChange(selectedIds.filter((selectedId) => selectedId !== id));
  }

  function clearAll(event: React.MouseEvent) {
    event.stopPropagation();
    onChange([]);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-10 w-full items-center justify-between border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-cyan-600 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        <span className="flex flex-wrap gap-1.5 text-left">
          {selectedFacturas.length === 0 ? (
            <span className="text-slate-500">{placeholder}</span>
          ) : (
            selectedFacturas.map((factura) => (
              <span
                key={factura.id}
                className="inline-flex items-center gap-1 border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-xs text-cyan-800"
              >
                <span className="font-medium">{factura.numFacturaVisible}</span>
                <span className="text-cyan-600">{formatCOP(factura.saldo)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => removeFactura(factura.id, event)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      removeFactura(factura.id, event as unknown as React.MouseEvent);
                    }
                  }}
                  className="-my-1 -mr-1 inline-flex h-6 w-6 items-center justify-center text-cyan-600 hover:text-rose-600"
                  aria-label={`Quitar factura ${factura.numFactura}`}
                >
                  <X className="h-3 w-3" />
                </span>
              </span>
            ))
          )}
        </span>

        <div className="ml-2 flex shrink-0 items-center gap-1">
          {selectedFacturas.length > 0 ? (
            <span
              role="button"
              tabIndex={0}
              onClick={clearAll}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  clearAll(event as unknown as React.MouseEvent);
                }
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:text-slate-700"
              aria-label="Limpiar facturas seleccionadas"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <Search className="h-3.5 w-3.5 text-slate-500" />
        </div>
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-2 py-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder="Número o proveedor…"
              className="h-8 w-full bg-slate-50 px-2 text-sm outline-none placeholder:text-slate-500"
            />
          </div>

          <div className="max-h-52 overflow-y-auto">
            {filteredFacturas.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500">
                {query.trim() ? "Sin resultados." : "No hay facturas disponibles."}
              </div>
            ) : (
              filteredFacturas.map((factura) => {
                const selected = selectedIds.includes(factura.id);
                // Solo facturas con saldo pendiente: una factura pagada no se puede volver a pagar.
                const disponible = (() => {
                  try {
                    return BigInt(factura.saldo) > 0n;
                  } catch {
                    return false;
                  }
                })();
                return (
                  <button
                    key={factura.id}
                    type="button"
                    onClick={() => {
                      if (!disponible) return;
                      toggleFactura(factura.id);
                    }}
                    disabled={!disponible}
                    title={disponible ? undefined : "Pagada: no se puede volver a pagar"}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm ${
                      disponible ? "hover:bg-slate-50" : "cursor-not-allowed opacity-60"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center border ${
                        selected
                          ? "border-cyan-600 bg-cyan-600"
                          : "border-slate-300 bg-white"
                      }`}
                    >
                      {selected ? <Check className="h-3 w-3 text-white" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-slate-800">{factura.numFacturaVisible}</span>
                      <span className="block truncate text-xs text-slate-500">{factura.proveedorNombre}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center border px-1.5 py-0.5 text-[11px] font-semibold ${
                          factura.etiqueta === "Pendiente"
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : factura.etiqueta === "Pagada"
                              ? "border-slate-200 bg-slate-100 text-slate-600"
                              : "border-cyan-200 bg-cyan-50 text-cyan-700"
                        }`}
                      >
                        {factura.etiqueta}
                      </span>
                      <span className="font-mono text-sm text-slate-600">{formatCOP(factura.saldo)}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selectedFacturas.length > 0 ? (
            <div className="border-t border-slate-100 px-3 py-2 text-right">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                }}
                className="text-xs font-semibold text-slate-700 hover:text-slate-900"
              >
                Listo ({selectedFacturas.length})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: modal de nuevo pago
// ---------------------------------------------------------------------------

type PseStep = "form" | "soporte";

// ─── WhatsApp del código PSE (Kapso) ─────────────────────────────────────────
type EstadoEnvioWhatsapp = "PENDIENTE" | "ENVIADO" | "ENTREGADO" | "LEIDO" | "FALLIDO";
type EnvioWhatsapp = { nombre: string; estado: EstadoEnvioWhatsapp; error: string | null; respuesta: string | null };
type EstadoCanalWhatsapp = "ENVIADO" | "PARCIAL" | "FALLIDO" | "NO_CONFIGURADO" | "SIN_APROBADORES";
type EstadoPse = {
  envios: EnvioWhatsapp[];
  noPuede: { por: string | null } | null;
  respondidaPor: string | null;
  canal: string | null;
};

const ETIQUETA_ENVIO: Record<EstadoEnvioWhatsapp, string> = {
  PENDIENTE: "Enviando…",
  ENVIADO: "Enviado",
  ENTREGADO: "Entregado",
  LEIDO: "Leído",
  FALLIDO: "No llegó",
};

function avisoSolicitudPse(
  estado: EstadoCanalWhatsapp,
  envios: EnvioWhatsapp[],
): { title: string; description: string; variant: ToastVariant } {
  const nombres = (lista: EnvioWhatsapp[]) => lista.map((e) => e.nombre).join(", ");
  switch (estado) {
    case "ENVIADO":
      return {
        title: "Solicitud enviada por WhatsApp",
        description: `Le llegó a ${nombres(envios)}. El código aparece aquí apenas respondan.`,
        variant: "info",
      };
    case "PARCIAL":
      return {
        title: "WhatsApp enviado solo a algunos",
        description: `No le llegó a ${nombres(envios.filter((e) => e.estado === "FALLIDO"))}. Si nadie responde, copia el enlace.`,
        variant: "info",
      };
    case "FALLIDO":
      return {
        title: "No salió el WhatsApp",
        description: "Copia el enlace y mándalo a mano mientras se revisa el canal.",
        variant: "error",
      };
    case "SIN_APROBADORES":
      return {
        title: "No hay aprobadores de WhatsApp",
        description: "Configúralos en Configuración → Parámetros (WHATSAPP_APROBADORES_PSE). Mientras tanto copia el enlace.",
        variant: "info",
      };
    case "NO_CONFIGURADO":
      return {
        title: "WhatsApp sin configurar",
        description: "Copia el enlace y mándalo a mano a quien tenga el token.",
        variant: "info",
      };
  }
}

function EstadoEnviosPse({ estado }: { estado: EstadoPse | null }) {
  if (!estado || estado.envios.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Estado del WhatsApp por aprobador">
      {estado.envios.map((envio, i) => (
        <li key={`${envio.nombre}-${i}`} className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-slate-700">
            <MessageCircle className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
            {envio.nombre}
          </span>
          <span
            className={
              envio.estado === "FALLIDO" || envio.respuesta === "NO_PUEDO"
                ? "font-medium text-rose-700"
                : envio.estado === "LEIDO" || envio.estado === "ENTREGADO"
                  ? "font-medium text-emerald-700"
                  : "text-slate-500"
            }
            title={envio.error ?? undefined}
          >
            {envio.respuesta === "NO_PUEDO" ? "No puede ahora" : ETIQUETA_ENVIO[envio.estado]}
          </span>
        </li>
      ))}
    </ul>
  );
}
type PendingSubmit = {
  concepto: string;
  numSoporte: string | null;
  canalPago: CanalPago;
  valor: string;
  /** Comprobante bancario ya subido — opcional, no bloquea el pago. */
  documentoId?: string | null;
  /** Comprobante de comercio (puerto/PSE) ya subido — opcional. */
  comprobanteComercioId?: string | null;
};

type NuevoPagoModalProps = {
  tramiteId: string;
  tramiteConsecutivo: string;
  initialConcepto?: string;
  initialFacturaIds?: string[];
  initialBeneficiarios?: BeneficiarioSeleccion[];
  initialValor?: string;
  onClose: () => void;
  onCreated: (pago: PagoRow) => void;
};

export function NuevoPagoModal({
  tramiteId,
  tramiteConsecutivo,
  initialConcepto,
  initialFacturaIds,
  initialBeneficiarios,
  initialValor,
  onClose,
  onCreated,
}: NuevoPagoModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState(initialValor ?? "");
  const [beneficiariosSel, setBeneficiariosSel] = useState<BeneficiarioSeleccion[]>(
    initialBeneficiarios ?? [],
  );
  const [fechaRealPago, setFechaRealPago] = useState(todayInput());
  // Idempotencia (§B.5, CA-43): una clave por formulario abierto. Si la
  // respuesta se pierde y se vuelve a pulsar Guardar, el servidor devuelve el
  // mismo pago en vez de registrar otro. Se renueva tras un guardado bueno o un
  // 409 IDEMPOTENCIA_CONFLICTO (se cambiaron los datos de un pago ya guardado).
  const [claveIdempotencia, setClaveIdempotencia] = useState(nuevaClaveIdempotencia);
  const [canalPago, setCanalPago] = useState<CanalPago>(CANALES_PAGO[0]?.value ?? "TRANSF_BANCOLOMBIA");
  // Banco (Beneficiario) usado como tercero del 4x1000. Solo se captura cuando
  // el canal NO es Bancolombia — para Bancolombia el backend auto-resuelve
  // desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID.
  const [bancoSel, setBancoSel] = useState<BeneficiarioSeleccion | null>(null);

  // Facturas de proveedor disponibles (multiselect) — CxP v2: monto por factura (§D.4).
  const [facturasDisponibles, setFacturasDisponibles] = useState<FacturaProveedorOpcion[]>([]);
  const [facturasSeleccionadas, setFacturasSeleccionadas] = useState<string[]>(initialFacturaIds ?? []);
  const [montosPorFactura, setMontosPorFactura] = useState<Record<string, string>>(() =>
    initialFacturaIds && initialFacturaIds.length === 1 && initialValor
      ? { [initialFacturaIds[0]]: initialValor }
      : {},
  );
  const [facturasLoadError, setFacturasLoadError] = useState(false);

  // PSE: wizard de 2 pasos (form → soporte)
  const [pseStep, setPseStep] = useState<PseStep>("form");
  const [psePendingPayload, setPsePendingPayload] = useState<PendingSubmit | null>(null);
  const [isRequestingToken, setIsRequestingToken] = useState(false);
  const [pseCodigoRecibido, setPseCodigoRecibido] = useState<string | null>(null);
  const [pseRetryRemaining, setPseRetryRemaining] = useState(0);
  const [pseEstado, setPseEstado] = useState<EstadoPse | null>(null);
  const [pseEnlace, setPseEnlace] = useState<string | null>(null);
  const [soporteFile, setSoporteFile] = useState<File | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);

  // Doble comprobante (flujo NO-PSE): el bancario (Bancolombia) es el que vale
  // ante reclamos; el de comercio (puerto/PSE) es opcional. NINGUNO bloquea el
  // pago — solo se muestra advertencia en el libro si falta el bancario.
  const [comprobanteBancarioFile, setComprobanteBancarioFile] = useState<File | null>(null);
  const [comprobanteComercioFile, setComprobanteComercioFile] = useState<File | null>(null);
  const [isUploadingComprobantes, setIsUploadingComprobantes] = useState(false);

  // Polling: espera el código PSE (llega por WhatsApp o por el enlace) y el
  // estado de cada WhatsApp enviado a los aprobadores.
  useEffect(() => {
    if (pseStep !== "soporte" || pseCodigoRecibido) return;
    const interval = setInterval(() => {
      fetch(`/api/tramites/${tramiteId}/pse-codigo`, { method: "GET" })
        .then(async (r) => {
          if (!r.ok) return;
          const data = (await r.json()) as { ready: boolean; codigo?: string } & Partial<EstadoPse>;
          setPseEstado({
            envios: data.envios ?? [],
            noPuede: data.noPuede ?? null,
            respondidaPor: data.respondidaPor ?? null,
            canal: data.canal ?? null,
          });
          if (data.ready && data.codigo) {
            setPseCodigoRecibido(data.codigo);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(interval);
  }, [pseStep, pseCodigoRecibido, tramiteId]);

  useEffect(() => {
    if (pseRetryRemaining <= 0) return;

    const timeout = setTimeout(() => {
      setPseRetryRemaining((current) => Math.max(current - 1, 0));
    }, 1000);

    return () => clearTimeout(timeout);
  }, [pseRetryRemaining]);

  // Auto-completar beneficiarios a partir de las facturas seleccionadas. Se
  // invoca desde los handlers (no desde un efecto) para evitar setState
  // síncrono dentro de useEffect.
  const agregarBeneficiariosDeFacturas = useCallback(
    (ids: string[], facturas: FacturaProveedorOpcion[]) => {
      if (ids.length === 0) return;
      setBeneficiariosSel((prev) => {
        const nuevos: BeneficiarioSeleccion[] = [];
        for (const id of ids) {
          const fp = facturas.find((f) => f.id === id);
          if (!fp?.beneficiarioId) continue;
          const yaPresente =
            prev.some((b) => b.id === fp.beneficiarioId) ||
            nuevos.some((b) => b.id === fp.beneficiarioId);
          if (!yaPresente) {
            nuevos.push({ id: fp.beneficiarioId, nombre: fp.proveedorNombre, nit: fp.beneficiarioNit });
          }
        }
        return nuevos.length > 0 ? [...prev, ...nuevos] : prev;
      });
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchFacturasProveedorTramite(tramiteId, controller.signal)
      .then((todas) => {
        setFacturasDisponibles(todas);
        // Prefill (initialFacturaIds): completa beneficiarios al llegar las facturas.
        agregarBeneficiariosDeFacturas(initialFacturaIds ?? [], todas);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFacturasLoadError(true);
      });
    return () => controller.abort();
  }, [tramiteId, initialFacturaIds, agregarBeneficiariosDeFacturas]);

  function handleFacturasChange(ids: string[]) {
    setFacturasSeleccionadas(ids);
    agregarBeneficiariosDeFacturas(ids, facturasDisponibles);
    // Monto por defecto = saldo de cada factura recién marcada (tope: el saldo).
    setMontosPorFactura((prev) => {
      const next: Record<string, string> = {};
      for (const id of ids) {
        if (prev[id] !== undefined) {
          next[id] = prev[id];
          continue;
        }
        const fp = facturasDisponibles.find((f) => f.id === id);
        next[id] = fp?.saldo ?? "0";
      }
      return next;
    });
  }

  function handleMontoFacturaChange(facturaId: string, raw: string) {
    const fp = facturasDisponibles.find((f) => f.id === facturaId);
    let digitos = raw.replace(/\D/g, "");
    if (fp && digitos) {
      // Tope: nunca más que el saldo (R2 — se refuerza también en el servidor).
      try {
        if (BigInt(digitos) > BigInt(fp.saldo)) digitos = fp.saldo;
      } catch {
        // ignore
      }
    }
    setMontosPorFactura((prev) => ({ ...prev, [facturaId]: digitos }));
  }

  // Valor del pago = Σ de los montos por factura (solo lectura mientras haya facturas marcadas).
  const sumaFacturas: bigint = facturasSeleccionadas.reduce((sum, id) => {
    try {
      return sum + BigInt(montosPorFactura[id] || "0");
    } catch {
      return sum;
    }
  }, 0n);
  // Con facturas marcadas, el valor visible/enviado es SIEMPRE la suma (derivado,
  // no via efecto): el campo queda de solo lectura.
  const valorEfectivo = facturasSeleccionadas.length > 0 ? sumaFacturas.toString() : valorRaw;

  async function submitPayload(payload: PendingSubmit) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const pago = await createPago(tramiteId, {
        concepto: payload.concepto,
        beneficiarioIds: beneficiariosSel.map((b) => b.id),
        numSoporte: payload.numSoporte,
        documentoId: payload.documentoId ?? null,
        comprobanteComercioId: payload.comprobanteComercioId ?? null,
        valor: payload.valor,
        canalPago: payload.canalPago,
        fechaRealPago: fechaRealPago || null,
        // CxP v2 (§D.4): cuánto de este pago va a cada factura. Σ = valor.
        aplicaciones: facturasSeleccionadas.map((facturaProveedorId) => ({
          facturaProveedorId,
          monto: montosPorFactura[facturaProveedorId] || "0",
        })),
        // Solo mando el banco para canales != Bancolombia; el backend
        // auto-resuelve Bancolombia desde el parámetro de configuración.
        bancoBeneficiarioId:
          payload.canalPago !== "TRANSF_BANCOLOMBIA" && bancoSel
            ? bancoSel.id
            : null,
        claveIdempotencia,
      });
      setClaveIdempotencia(nuevaClaveIdempotencia());
      toast({
        title: pago.repetido ? "Este pago ya estaba guardado" : "Pago guardado",
        description: `${payload.concepto} · ${formatCOP(payload.valor)} en ${tramiteConsecutivo}`,
        variant: "success",
      });
      onCreated(pago);
    } catch (caught) {
      if ((caught as { codigo?: string } | null)?.codigo === "IDEMPOTENCIA_CONFLICTO") {
        setClaveIdempotencia(nuevaClaveIdempotencia());
      }
      setError(describirError(caught, "Error al crear el pago."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function notificarCamilaPse(payload: PendingSubmit) {
    if (isRequestingToken) return;
    setIsRequestingToken(true);
    setError(null);
    try {
      // Contexto del pago para que el aprobador sepa qué está autorizando.
      const beneficiario = beneficiariosSel.map((b) => b.nombre).join(", ").slice(0, 120);
      const resp = await fetch(`/api/tramites/${tramiteId}/pse-token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          valor: payload.valor,
          concepto: payload.concepto.slice(0, 200) || undefined,
          beneficiario: beneficiario || undefined,
        }),
      });
      if (!resp.ok) throw new Error("No fue posible crear la solicitud del código.");
      const data = (await resp.json()) as {
        enlace: string;
        whatsapp: { estado: EstadoCanalWhatsapp; envios: EnvioWhatsapp[] };
      };
      setPseCodigoRecibido(null);
      setPseEnlace(data.enlace);
      setPseEstado({ envios: data.whatsapp.envios, noPuede: null, respondidaPor: null, canal: null });
      setPsePendingPayload(payload);
      setPseStep("soporte");
      setPseRetryRemaining(30);
      toast(avisoSolicitudPse(data.whatsapp.estado, data.whatsapp.envios));
    } catch (caught) {
      setError(describirError(caught, "Error al solicitar el pago PSE."));
    } finally {
      setIsRequestingToken(false);
    }
  }

  async function copiarEnlacePse() {
    if (!pseEnlace) return;
    try {
      await navigator.clipboard.writeText(pseEnlace);
      toast({ title: "Enlace copiado", description: "Pégalo en el chat de quien tenga el token.", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar", description: pseEnlace, variant: "error" });
    }
  }

  async function finalizarPsePago() {
    if (!psePendingPayload || !soporteFile || !pseCodigoRecibido) return;
    setIsUploadingDoc(true);
    setError(null);
    try {
      // La captura de la página de PSE ES el comprobante de comercio (el
      // bancario de Bancolombia es un documento aparte que Camila no tiene
      // en este flujo — el pago queda con advertencia "sin comprobante
      // bancario" en el libro, sin bloquearse).
      const comprobante = await subirComprobante(tramiteId, "COMPROBANTE_COMERCIO", soporteFile);

      await submitPayload({
        ...psePendingPayload,
        numSoporte: pseCodigoRecibido,
        comprobanteComercioId: comprobante.id,
      });
    } catch (caught) {
      setError(describirError(caught, "Error al finalizar el pago PSE."));
    } finally {
      setIsUploadingDoc(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const concepto = String(formData.get("concepto") ?? "").trim();

    const valorBig = parseBigIntInput(valorEfectivo);
    if (!valorBig || BigInt(valorBig) <= 0n) {
      setError("El valor debe ser un número entero mayor a 0.");
      return;
    }

    let payload: PendingSubmit = { concepto, numSoporte: null, canalPago, valor: valorBig };

    // Flujo PSE: pide el código a los aprobadores (WhatsApp) y pasa a adjuntar soporte
    // (esa captura de PSE se registra como comprobante de comercio — ver
    // finalizarPsePago).
    if (canalPago === "PSE") {
      await notificarCamilaPse(payload);
      return;
    }

    // Doble comprobante (opcional, no bloquea el pago): si se adjuntó
    // alguno, se sube ANTES de crear el pago para obtener su documentoId.
    if (comprobanteBancarioFile || comprobanteComercioFile) {
      setIsUploadingComprobantes(true);
      try {
        const [bancario, comercio] = await Promise.all([
          comprobanteBancarioFile
            ? subirComprobante(tramiteId, "COMPROBANTE_BANCARIO", comprobanteBancarioFile)
            : Promise.resolve(null),
          comprobanteComercioFile
            ? subirComprobante(tramiteId, "COMPROBANTE_COMERCIO", comprobanteComercioFile)
            : Promise.resolve(null),
        ]);
        payload = {
          ...payload,
          documentoId: bancario?.id ?? null,
          comprobanteComercioId: comercio?.id ?? null,
        };
      } catch (caught) {
        setError(describirError(caught, "Error al subir el comprobante."));
        return;
      } finally {
        setIsUploadingComprobantes(false);
      }
    }

    // CxP v2 (§D.4): con facturas marcadas, el valor SIEMPRE es la suma de sus
    // montos (el campo queda de solo lectura) — ya no hay diálogo de
    // desviación: el servidor rechaza `PAGO_NO_CUADRA` si algo no cuadra.
    await submitPayload(payload);
  }

  const titleByStep: Record<PseStep, string> = {
    form: "Agregar pago",
    soporte: "Adjuntar soporte",
  };

  const ocupado = isSubmitting || isRequestingToken || isUploadingComprobantes || isUploadingDoc;

  return (
    <ModalShell
      open
      onClose={onClose}
      title={titleByStep[pseStep]}
      description={`Pago a proveedor del DO ${tramiteConsecutivo}`}
      size="lg"
      dismissible={!ocupado}
    >
        <div>

          {/* Indicador de pasos — visible cuando el canal es PSE o ya avanzó */}
          {(canalPago === "PSE" || pseStep !== "form") ? (
            <div className="-mx-5 -mt-4 mb-4 flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs">
              {(["form", "soporte"] as PseStep[]).map((step, i) => {
                const labels = ["1. Datos", "2. Soporte"];
                const active = step === pseStep;
                const done = step === "form" && pseStep === "soporte";
                return (
                  <span key={step} className="flex items-center gap-2">
                    {i > 0 && <span className="text-slate-300">›</span>}
                    <span className={active ? "font-semibold text-cyan-700" : done ? "text-slate-500" : "text-slate-300"}>
                      {labels[i]}
                    </span>
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* Paso 1: formulario de datos del pago */}
          {pseStep === "form" ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Facturas de proveedor — multiselect (opcional) */}
              <div className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Facturas de proveedor a cubrir
                  <span className="ml-1.5 font-normal text-slate-500">(opcional)</span>
                  {facturasSeleccionadas.length > 0 ? (
                    <span className="ml-2 font-normal text-slate-500">
                      — {facturasSeleccionadas.length} seleccionada{facturasSeleccionadas.length === 1 ? "" : "s"} · Total: {formatCOP(sumaFacturas.toString())}
                    </span>
                  ) : null}
                </span>
                {facturasLoadError ? (
                  <p className="text-xs text-rose-600">No se pudieron cargar las facturas.</p>
                ) : facturasDisponibles.length === 0 ? (
                    <p className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-500">
                      Sin facturas de proveedor registradas para este trámite.
                    </p>
                ) : (
                  <div className="space-y-2">
                    <FacturasProveedorCombobox
                      facturas={facturasDisponibles}
                      selectedIds={facturasSeleccionadas}
                      onChange={handleFacturasChange}
                      placeholder="Buscar y seleccionar facturas…"
                    />
                    <p className="text-xs text-slate-500">
                      Solo aparecen facturas con saldo pendiente. Una factura pagada no se puede volver a
                      pagar.
                    </p>
                    {facturasSeleccionadas.length > 0 ? (
                      <div className="divide-y divide-slate-100 border border-slate-200">
                        {facturasSeleccionadas.map((id) => {
                          const fp = facturasDisponibles.find((f) => f.id === id);
                          if (!fp) return null;
                          return (
                            <div key={id} className="flex items-center gap-3 px-3 py-2">
                              <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                                {fp.numFacturaVisible}
                                <span className="ml-1.5 text-xs text-slate-500">
                                  saldo {formatCOP(fp.saldo)}
                                </span>
                              </span>
                              <CampoMoneda
                                value={montosPorFactura[id] ?? ""}
                                onValueChange={(digitos) => handleMontoFacturaChange(id, digitos)}
                                aria-label={`Monto a aplicar a la factura ${fp.numFacturaVisible}`}
                                className="h-8 w-32 border border-slate-300 px-2 text-right text-sm outline-none focus:border-cyan-600"
                              />
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Concepto *</span>
                <input
                  name="concepto"
                  required
                  defaultValue={initialConcepto ?? ""}
                  placeholder="Ej. Flete terrestre"
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>

              <div className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Beneficiarios</span>
                <BeneficiarioCombobox
                  mode="multi"
                  value={beneficiariosSel}
                  onChange={setBeneficiariosSel}
                  placeholder="Buscar o crear beneficiario…"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">
                    Valor (COP) *
                    {facturasSeleccionadas.length > 0 ? (
                      <span className="ml-1.5 font-normal text-slate-500">(= suma de las facturas)</span>
                    ) : null}
                  </span>
                  <CampoMoneda
                    value={valorEfectivo}
                    onValueChange={setValorRaw}
                    placeholder="1.000.000"
                    disabled={facturasSeleccionadas.length > 0}
                    className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
                  <select
                    name="canalPago"
                    required
                    value={canalPago}
                    onChange={(ev) => setCanalPago(ev.target.value as CanalPago)}
                    className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
                  >
                    {CANALES_PAGO.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Banco (4x1000) — solo cuando el canal NO es Bancolombia.
                  Bancolombia se auto-resuelve desde SIIGO_BENEFICIARIO_BANCOLOMBIA_ID. */}
              {canalPago !== "TRANSF_BANCOLOMBIA" ? (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium text-slate-700">
                    Banco (tercero del 4x1000)
                    <span className="ml-1.5 font-normal text-slate-500">(opcional)</span>
                  </span>
                  <BeneficiarioCombobox
                    mode="single"
                    value={bancoSel}
                    onChange={setBancoSel}
                    placeholder="Seleccionar o crear banco…"
                  />
                  <p className="text-[11px] text-slate-500">
                    Se usa como tercero de la línea 4x1000 al enviar la factura a Siigo. Si dejás vacío, Galcomex elegirá un default al enviar.
                  </p>
                </div>
              ) : null}

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
                <input
                  type="date"
                  value={fechaRealPago}
                  onChange={(ev) => setFechaRealPago(ev.target.value)}
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>

              {/* Doble comprobante — solo en canales distintos a PSE (PSE tiene
                  su propio paso 2 de adjuntar comprobante de comercio). Ninguno
                  de los dos es obligatorio: si falta el bancario, el libro de
                  pagos muestra advertencia visual pero NO bloquea el registro. */}
              {canalPago !== "PSE" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium text-slate-700">
                      Comprobante bancario
                      <span className="ml-1.5 font-normal text-slate-500">(opcional)</span>
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      onChange={(e) => setComprobanteBancarioFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-2 file:border file:border-slate-300 file:bg-white file:px-2 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
                    />
                    {comprobanteBancarioFile ? (
                      <p className="text-[11px] text-slate-500">{comprobanteBancarioFile.name}</p>
                    ) : (
                      <p className="text-[11px] text-amber-600">
                        Sin comprobante bancario el pago queda con advertencia visual (no se bloquea).
                      </p>
                    )}
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium text-slate-700">
                      Comprobante de comercio
                      <span className="ml-1.5 font-normal text-slate-500">(opcional)</span>
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      onChange={(e) => setComprobanteComercioFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-2 file:border file:border-slate-300 file:bg-white file:px-2 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
                    />
                    {comprobanteComercioFile ? (
                      <p className="text-[11px] text-slate-500">{comprobanteComercioFile.name}</p>
                    ) : null}
                  </label>
                </div>
              ) : null}

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
                  disabled={ocupado}
                  className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || isRequestingToken || isUploadingComprobantes}
                  className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isSubmitting || isRequestingToken || isUploadingComprobantes ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {canalPago === "PSE" ? "Solicitar pago PSE" : "Guardar pago"}
                </button>
              </div>
            </form>
          ) : null}

          {/* Paso 2: esperar el código PSE (WhatsApp o enlace) + adjuntar soporte */}
          {pseStep === "soporte" ? (
            <div className="space-y-4">

              {/* Estado del código */}
              {!pseCodigoRecibido ? (
                <div className="space-y-3 rounded border border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-amber-800">Esperando el código del token…</p>
                      <p className="text-xs text-amber-600">Pueden responder por WhatsApp o desde el enlace. Esta pantalla se actualiza sola.</p>
                    </div>
                  </div>
                  <EstadoEnviosPse estado={pseEstado} />
                  {pseEstado?.noPuede ? (
                    <p className="flex items-center gap-2 text-xs font-medium text-rose-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {pseEstado.noPuede.por ?? "El aprobador"} no puede en este momento.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    {pseEnlace ? (
                      <button
                        type="button"
                        onClick={() => void copiarEnlacePse()}
                        className="inline-flex h-8 items-center gap-2 border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition hover:bg-amber-100"
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        Copiar enlace
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void (psePendingPayload ? notificarCamilaPse(psePendingPayload) : Promise.resolve())}
                      disabled={isRequestingToken || pseRetryRemaining > 0 || !psePendingPayload}
                      className="inline-flex h-8 items-center gap-2 border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isRequestingToken ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                      {pseRetryRemaining > 0 ? `Reenviar en ${pseRetryRemaining}s` : "Reenviar solicitud"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 rounded border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    <div>
                      <p className="text-xs text-emerald-600">
                        Código PSE recibido
                        {pseEstado?.respondidaPor ? ` de ${pseEstado.respondidaPor}` : ""}
                        {pseEstado?.canal === "WHATSAPP" ? " por WhatsApp" : pseEstado?.canal === "ENLACE" ? " por el enlace" : ""}
                      </p>
                      <p className="text-lg font-bold tracking-widest text-emerald-800">{pseCodigoRecibido}</p>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void (psePendingPayload ? notificarCamilaPse(psePendingPayload) : Promise.resolve())}
                      disabled={isRequestingToken || pseRetryRemaining > 0 || !psePendingPayload}
                      className="inline-flex h-8 items-center gap-2 border border-emerald-300 bg-white px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isRequestingToken ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      {pseRetryRemaining > 0
                        ? `Nuevo código en ${pseRetryRemaining}s`
                        : "Solicitar nuevo código"}
                    </button>
                  </div>
                </div>
              )}

              {/* Soporte — solo habilitado cuando llegó el código. Esta captura
                  de la página de PSE se registra como comprobante de comercio. */}
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Comprobante de comercio (captura de PSE) *</span>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  disabled={!pseCodigoRecibido}
                  onChange={(e) => setSoporteFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-slate-600 file:mr-3 file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50 disabled:opacity-40"
                />
                {soporteFile ? (
                  <p className="text-xs text-slate-500">
                    Seleccionado: <span className="font-medium">{soporteFile.name}</span>
                    {" "}({(soporteFile.size / 1024).toFixed(0)} KB)
                  </p>
                ) : null}
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
                  disabled={ocupado}
                  className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void finalizarPsePago()}
                  disabled={!pseCodigoRecibido || !soporteFile || isUploadingDoc || isSubmitting}
                  className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isUploadingDoc || isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Finalizar pago
                </button>
              </div>
            </div>
          ) : null}

        </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Componente principal: LibroPagos
// ---------------------------------------------------------------------------

type LibroPagosProps = {
  tramiteId: string;
  /** Cambia cuando el detalle del DO se recargó: vuelve a leer el libro. */
  refreshToken?: number;
  /**
   * Avisa al DO que un pago se creó, se borró o se anuló su bloque: las
   * facturas de proveedor cambiaron de estado (Pendiente/Abonada/Pagada) y la
   * pestaña "Facturas proveedor" debe recargarse.
   */
  onCambio?: () => void;
};

export function LibroPagos({ tramiteId, refreshToken = 0, onCambio }: LibroPagosProps) {
  const puedeEditar = usePermiso(ROLES_EDITAR_PAGOS);
  const puedeVerDetalleBloque = usePermiso(ROLES_DETALLE_BLOQUE);
  const esAdmin = useEsAdmin();
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [tramite, setTramite] = useState<TramiteDetail | null>(null);
  const [libro, setLibro] = useState<LibroPagosData | null>(null);
  const [filas, setFilas] = useState<FilaLibro[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [bloqueParaAnular, setBloqueParaAnular] = useState<{ grupoPagoId: string; resumen: string } | null>(null);
  const [bloqueParaDetalle, setBloqueParaDetalle] = useState<string | null>(null);
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Carga inicial ---
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      // Solo la primera carga muestra el skeleton; las recargas conservan el
      // libro visible hasta que llegue la respuesta.
      setLoadState((prev) => (prev === "ready" ? prev : "loading"));
      setLoadError(null);

      const [tramiteData, libroData] = await Promise.all([
        fetchTramiteDetail(tramiteId, controller.signal),
        fetchLibroPagos(tramiteId, controller.signal),
      ]);
      setTramite(tramiteData);
      setLibro(libroData);

      // Construir filas con saldos calculados localmente
      // Saldo del cliente: lo que asume Galcomex (asesoría NO SE COBRA) no lo baja.
      const saldos = calcularSaldosCliente(
        libroData.totalAnticipoAplicado,
        libroData.pagos.map((p) => valorParaSaldoCliente(p.valor, p.noCobrable)),
      );
      setFilas(libroData.pagos.map((p, i) => filaFromRow(p, saldos[i] ?? "0")));
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar los datos.");
      setLoadState("error");
    });

    return () => controller.abort();
  }, [tramiteId, reloadKey, refreshToken]);

  // --- Recalcular saldos localmente cuando cambian los valores editados ---
  const recalcularSaldos = useCallback(
    (filasActuales: FilaLibro[], anticipo: string): FilaLibro[] => {
      let saldo = BigInt(anticipo);
      return filasActuales.map((fila) => {
        const val = parseBigIntInput(fila.editingValor);
        const bigVal = val ? BigInt(val) : BigInt(fila.valor);
        // Lo que asume Galcomex (asesoría) no baja el saldo del cliente.
        saldo -= bigVal - BigInt(fila.noCobrable ?? "0");
        return { ...fila, saldoLocal: saldo.toString() };
      });
    },
    [],
  );

  // --- Handlers de edición inline ---

  function handleFieldChange(
    id: string,
    field: keyof Pick<
      FilaLibro,
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaReal"
    >,
    value: string,
  ) {
    setFilas((prev) => {
      const next = prev.map((f) =>
        f.id === id ? { ...f, [field]: value, dirty: true, errorFila: null } : f,
      );
      if (libro && field === "editingValor") {
        return recalcularSaldos(next, libro.totalAnticipoAplicado);
      }
      return next;
    });
  }

  function handleBeneficiariosChange(id: string, beneficiarios: BeneficiarioSeleccion[]) {
    setFilas((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, editingBeneficiarios: beneficiarios, dirty: true, errorFila: null }
          : f,
      ),
    );
    // Auto-save inmediato al cambiar beneficiarios (cambio discreto, no texto libre)
    setTimeout(() => void commitFila(id), 0);
  }

  function scheduleAutoSave(fila: FilaLibro) {
    // Cancela el timer previo para esta fila
    if (saveTimersRef.current[fila.id]) {
      clearTimeout(saveTimersRef.current[fila.id]);
    }
    saveTimersRef.current[fila.id] = setTimeout(() => {
      void commitFila(fila.id);
    }, 900);
  }

  function handleBlurField(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (fila?.dirty) scheduleAutoSave(fila);
  }

  async function commitFila(id: string) {
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)),
    );

    const fila = filas.find((f) => f.id === id);
    if (!fila) return;

    const valorBig = parseBigIntInput(fila.editingValor);

    // Snapshot para rollback
    const snapshot = { ...fila };

    try {
      const updated = await updatePago(tramiteId, id, {
        concepto: fila.editingConcepto,
        beneficiarioIds: fila.editingBeneficiarios.map((b) => b.id),
        numSoporte: fila.editingNumSoporte || null,
        valor: valorBig ?? fila.valor,
        canalPago: fila.editingCanal,
        // Solo si cambió: editar el concepto no debe tocar la fecha de pago.
        ...(fila.editingFechaReal !== isoToDateInput(fila.fechaRealPago)
          ? { fechaRealPago: fila.editingFechaReal || null }
          : {}),
      });

      setFilas((prev) => {
        const next = prev.map((f) => {
          if (f.id !== id) return f;
          return {
            ...f,
            ...updated,
            editingValor: updated.valor,
            editingConcepto: updated.concepto,
            editingBeneficiarios: updated.beneficiarios ?? [],
            editingNumSoporte: updated.numSoporte ?? "",
            editingCanal: updated.canalPago,
            editingFechaReal: isoToDateInput(updated.fechaRealPago),
            dirty: false,
            saving: false,
            errorFila: null,
          };
        });
        // Recalcular saldos con el valor confirmado por el backend
        if (libro) return recalcularSaldos(next, libro.totalAnticipoAplicado);
        return next;
      });

      // Actualizar resumen del libro localmente
      setLibro((prev) => {
        if (!prev) return prev;
        const totalPagos = filas.reduce((sum, f) => {
          const v = parseBigIntInput(f.id === id ? updated.valor : f.editingValor) ?? f.valor;
          return sum + BigInt(v);
        }, 0n);
        const saldos = calcularSaldosCliente(
          prev.totalAnticipoAplicado,
          filas.map((f) =>
            valorParaSaldoCliente(
              f.id === id ? updated.valor : parseBigIntInput(f.editingValor) ?? f.valor,
              f.noCobrable,
            ),
          ),
        );
        const saldoFinal = saldos.length > 0 ? saldos[saldos.length - 1] : prev.totalAnticipoAplicado;
        return { ...prev, totalPagos: totalPagos.toString(), saldos, saldoFinal: saldoFinal ?? "0" };
      });
      toast({ title: "Pago actualizado", description: updated.concepto, variant: "success" });
    } catch (caught) {
      const msg = describirError(caught, "Error al guardar.");
      // Rollback optimista
      setFilas((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...snapshot,
                saving: false,
                errorFila: msg,
              }
            : f,
        ),
      );
      toast({ title: "No se pudo guardar el pago", description: msg, variant: "error" });
    }
  }

  /**
   * Adjunta el comprobante bancario a un pago YA guardado (decisión de
   * negocio: se puede registrar el pago sin comprobante y adjuntarlo después).
   * Sube el archivo y lo asocia con un PATCH — mismo componente de subida que
   * usa NuevoPagoModal (subirComprobante).
   */
  async function handleAdjuntarComprobante(id: string, file: File) {
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)),
    );

    try {
      const documento = await subirComprobante(tramiteId, "COMPROBANTE_BANCARIO", file);
      const updated = await updatePago(tramiteId, id, { documentoId: documento.id });

      setFilas((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                documentoId: updated.documentoId,
                faltaComprobante: updated.faltaComprobante,
                saving: false,
                errorFila: null,
              }
            : f,
        ),
      );
      toast({
        title: "Comprobante adjuntado",
        description: updated.concepto,
        variant: "success",
      });
    } catch (caught) {
      const msg = describirError(caught, "Error al adjuntar el comprobante.");
      setFilas((prev) =>
        prev.map((f) => (f.id === id ? { ...f, saving: false, errorFila: msg } : f)),
      );
      toast({ title: "No se pudo adjuntar el comprobante", description: msg, variant: "error" });
    }
  }

  async function handleDelete(id: string) {
    const fila = filas.find((f) => f.id === id);
    const ok = await confirmar({
      title: "¿Eliminar este pago?",
      description: fila
        ? `${fila.concepto} · ${formatCOP(fila.valor)}. Esta acción no se puede deshacer.`
        : "Esta acción no se puede deshacer.",
      confirmText: "Eliminar pago",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(id);

    try {
      await deletePago(tramiteId, id);
      setFilas((prev) => {
        const next = prev.filter((f) => f.id !== id);
        if (libro) return recalcularSaldos(next, libro.totalAnticipoAplicado);
        return next;
      });
      setLibro((prev) => {
        if (!prev) return prev;
        const remaining = filas.filter((f) => f.id !== id);
        const totalPagos = remaining.reduce(
          (sum, f) => sum + BigInt(parseBigIntInput(f.editingValor) ?? f.valor),
          0n,
        );
        const saldos = calcularSaldosCliente(
          prev.totalAnticipoAplicado,
          remaining.map((f) => valorParaSaldoCliente(parseBigIntInput(f.editingValor) ?? f.valor, f.noCobrable)),
        );
        const saldoFinal = saldos.length > 0 ? saldos[saldos.length - 1] : prev.totalAnticipoAplicado;
        const totalNoCobrable = remaining.reduce((sum, f) => sum + BigInt(f.noCobrable ?? "0"), 0n);
        return {
          ...prev,
          totalPagos: totalPagos.toString(),
          totalPagosCobrables: (totalPagos - totalNoCobrable).toString(),
          totalNoCobrable: totalNoCobrable.toString(),
          saldos,
          saldoFinal: saldoFinal ?? "0",
        };
      });
      toast({ title: "Pago eliminado", variant: "success" });
      onCambio?.();
    } catch (caught) {
      toast({
        title: "No se pudo eliminar el pago",
        description: describirError(caught, "Error al eliminar."),
        variant: "error",
      });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleVerificar(id: string) {
    if (verifyingId) return;
    setVerifyingId(id);

    try {
      const updated = await verificarMovimientoPago(tramiteId, id, "VERIFICADO");
      setFilas((prev) =>
        prev.map((fila) =>
          fila.id === id
            ? {
                ...fila,
                estado: updated.estado,
                dirty: false,
                saving: false,
                errorFila: null,
              }
            : fila,
        ),
      );
      toast({ title: "Pago verificado", description: updated.concepto, variant: "success" });
    } catch (caught) {
      toast({
        title: "No fue posible verificar el pago",
        description: describirError(caught),
        variant: "error",
      });
    } finally {
      setVerifyingId(null);
    }
  }

  function handlePagoCreado() {
    setModalOpen(false);
    // Reload para asegurar saldo actualizado desde el backend
    setReloadKey((k) => k + 1);
    onCambio?.();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loadState === "loading" && (!tramite || !libro)) {
    return (
      <div className="space-y-4" aria-busy="true">
        <CardsSkeleton count={4} height={72} />
        <TableSkeleton rows={2} cols={6} rowHeight={40} />
        <TableSkeleton rows={5} cols={9} rowHeight={44} />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <ModuleState
        type="error"
        title="No fue posible cargar el libro de pagos"
        detail={loadError ?? undefined}
        action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
      />
    );
  }

  if (!tramite || !libro) return null;

  return (
    <section className="space-y-4">
      {!puedeEditar ? (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Solo lectura para tu perfil: crear, editar, verificar o eliminar pagos requiere
          ADMIN u OPERATIVO.
        </p>
      ) : null}

      <SeccionAnticipos
        aplicaciones={libro.aplicaciones}
        totalAnticipoAplicado={libro.totalAnticipoAplicado}
        costosBancariosAnticipo={libro.costosBancariosAnticipo}
      />

      <ResumenLibro libro={libro} filas={filas} tramiteId={tramiteId} />

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">
            Pagos ({filas.length})
          </p>
          {!puedeEditar ? null : libro.aplicaciones.length === 0 ? (
            <span
              title="Se necesita al menos un anticipo aplicado para registrar pagos"
              className="inline-flex h-9 cursor-not-allowed items-center gap-2 bg-slate-300 px-3 text-sm font-semibold text-slate-500"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo pago
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo pago
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="sticky left-0 z-10 w-8 whitespace-nowrap border-b border-r border-slate-200 bg-slate-50 px-2.5 py-2">#</th>
                <th className="whitespace-nowrap border-b border-slate-200 px-2.5 py-2" title="Concepto, beneficiario y facturas que cubre">Pago</th>
                <th className="whitespace-nowrap border-b border-slate-200 px-2.5 py-2">N° soporte</th>
                <th className="whitespace-nowrap border-b border-slate-200 px-2.5 py-2 text-right">Valor (COP)</th>
                <th className="whitespace-nowrap border-b border-slate-200 px-2.5 py-2">Canal</th>
                <th className="border-b border-slate-200 px-2.5 py-2">Fecha de pago</th>
                <th className="border-b border-slate-200 px-2.5 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-2.5 py-2 text-right">Saldo operativo</th>
                <th className="w-12 whitespace-nowrap border-b border-slate-200 px-2.5 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">
                    Sin pagos registrados.
                    {puedeEditar ? ' Usa "Nuevo pago" para agregar el primero.' : ""}
                  </td>
                </tr>
              ) : null}
              {filas.map((fila, idx) => (
                <FilaPago
                  key={fila.id}
                  fila={fila}
                  index={idx + 1}
                  readOnly={!puedeEditar}
                  esAdmin={esAdmin}
                  isDeleting={deletingId === fila.id}
                  onChange={handleFieldChange}
                  onBeneficiariosChange={handleBeneficiariosChange}
                  onBlur={handleBlurField}
                  onDelete={(id) => void handleDelete(id)}
                  onVerify={(id) => void handleVerificar(id)}
                  onAdjuntarComprobante={(id, file) => void handleAdjuntarComprobante(id, file)}
                  onAnularBloque={(grupoPagoId, resumen) => setBloqueParaAnular({ grupoPagoId, resumen })}
                  onVerDetalleBloque={puedeVerDetalleBloque ? (grupoPagoId) => setBloqueParaDetalle(grupoPagoId) : undefined}
                  isVerifying={verifyingId === fila.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && puedeEditar ? (
        <NuevoPagoModal
          tramiteId={tramiteId}
          tramiteConsecutivo={tramite.consecutivo}
          onClose={() => setModalOpen(false)}
          onCreated={handlePagoCreado}
        />
      ) : null}

      {bloqueParaAnular ? (
        <AnularBloqueDialog
          grupoPagoId={bloqueParaAnular.grupoPagoId}
          resumen={bloqueParaAnular.resumen}
          onClose={() => setBloqueParaAnular(null)}
          onDone={() => {
            setBloqueParaAnular(null);
            setReloadKey((k) => k + 1);
            onCambio?.();
          }}
        />
      ) : null}

      {bloqueParaDetalle ? (
        <DetalleBloqueDialog grupoPagoId={bloqueParaDetalle} onClose={() => setBloqueParaDetalle(null)} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: fila editable
// ---------------------------------------------------------------------------

function estadoMovimientoBadge(estado: EstadoMovimiento) {
  if (estado === "VERIFICADO") {
    return (
      <span className="inline-flex items-center border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
        VERIFICADO
      </span>
    );
  }
  if (estado === "BORRADOR") {
    return (
      <span className="inline-flex items-center border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">
        BORRADOR
      </span>
    );
  }
  return null; // REALIZADO — sin badge extra
}

const COSTO_ASUMIDO_LABEL: Record<string, string> = {
  GALCOMEX: "lo asume Galcomex",
  PRIMER_DO: "en este DO",
  PRORRATEADO: "repartido entre los DOs",
};

type FilaPagoProps = {
  fila: FilaLibro;
  index: number;
  /** Solo lectura (REVISOR/SOCIO): sin inputs ni acciones. */
  readOnly: boolean;
  /** "Anular pago en bloque" solo ADMIN (R16). */
  esAdmin: boolean;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaLibro,
      "editingValor" | "editingConcepto" | "editingNumSoporte" | "editingCanal" | "editingFechaReal"
    >,
    value: string,
  ) => void;
  onBeneficiariosChange: (id: string, b: BeneficiarioSeleccion[]) => void;
  onBlur: (id: string) => void;
  onDelete: (id: string) => void;
  onVerify: (id: string) => void;
  /** Sube y adjunta el comprobante bancario a un pago ya guardado. */
  onAdjuntarComprobante: (id: string, file: File) => void;
  onAnularBloque: (grupoPagoId: string, resumen: string) => void;
  /** Sin él (SOCIO: la ruta del detalle no lo admite) la etiqueta del bloque es solo texto. */
  onVerDetalleBloque?: (grupoPagoId: string) => void;
  isVerifying: boolean;
};

function canalPagoLabel(canal: CanalPago): string {
  return CANALES_PAGO.find((c) => c.value === canal)?.label ?? canal;
}

function FilaPago({
  fila,
  index,
  readOnly,
  esAdmin,
  isDeleting,
  onChange,
  onBeneficiariosChange,
  onBlur,
  onDelete,
  onVerify,
  onAdjuntarComprobante,
  onAnularBloque,
  onVerDetalleBloque,
  isVerifying,
}: FilaPagoProps) {
  const etiqueta = `pago ${index}`;

  return (
    <>
      <tr className={`border-b border-slate-100 last:border-b-0 ${fila.saving ? "opacity-60" : ""} hover:bg-slate-50`}>
        <td className="sticky left-0 z-10 border-r border-slate-100 bg-white px-2.5 py-2 text-xs text-slate-500">{index}</td>

        {/* Concepto: el texto real mide 60–90 caracteres, así que crece en alto en vez de cortarse */}
        <td className="px-2.5 py-2">
          {readOnly ? (
            <span className="block min-w-[16rem] text-sm leading-snug text-slate-800">{fila.concepto}</span>
          ) : (
            <textarea
              rows={1}
              value={fila.editingConcepto}
              onChange={(e) => onChange(fila.id, "editingConcepto", e.target.value.replace(/\r?\n/g, " "))}
              onBlur={() => onBlur(fila.id)}
              onKeyDown={(e) => {
                // Enter confirma (como en el input de antes); no inserta saltos de línea.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              aria-label={`Concepto del ${etiqueta}`}
              className="w-full min-w-[16rem] resize-none [field-sizing:content] border border-transparent bg-transparent px-1 py-1 text-sm leading-snug text-slate-800 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
          {/* A quién se le pagó */}
          <div className="mt-1 max-w-[22rem]">
            {readOnly ? (
              <span className="block text-sm text-slate-600">
                {fila.beneficiarios.length > 0
                  ? fila.beneficiarios.map((b) => b.nombre).join(", ")
                  : "—"}
              </span>
            ) : (
              <BeneficiarioCombobox
                mode="multi"
                value={fila.editingBeneficiarios}
                onChange={(b) => onBeneficiariosChange(fila.id, b)}
                placeholder="Elegir beneficiario…"
              />
            )}
          </div>
          {/* Facturas que cubre, vía Lucho, comprobante y estado: debajo del concepto */}
          <div className="mt-1 flex flex-wrap items-center gap-1 empty:hidden">
            {fila.aplicaciones.map((ap) => (
              <span
                key={ap.facturaId}
                className="inline-flex items-center whitespace-nowrap border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[11px] font-semibold text-cyan-700"
              >
                {ap.numFacturaVisible} · {formatCOP(ap.monto)}
              </span>
            ))}
            {fila.viaSocio ? (
              <span className="inline-flex items-center whitespace-nowrap border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
                vía Lucho
              </span>
            ) : null}
            {fila.faltaComprobante ? (
              readOnly ? (
                <span
                  className="inline-flex items-center gap-1 whitespace-nowrap border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700"
                  title="Pago sin comprobante bancario"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Falta comprobante
                </span>
              ) : (
                // Una sola acción: avisa que falta el comprobante y deja adjuntarlo.
                <label
                  className={`inline-flex w-fit items-center gap-1 whitespace-nowrap border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 ${
                    fila.saving ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}
                  title="Falta el comprobante bancario de este pago: adjúntalo aquí"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Falta comprobante · Adjuntar
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    disabled={fila.saving}
                    className="hidden"
                    aria-label={`Adjuntar comprobante bancario del ${etiqueta}`}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onAdjuntarComprobante(fila.id, file);
                      e.target.value = "";
                    }}
                  />
                </label>
              )
            ) : null}
            {fila.esBloque && fila.grupoPagoId ? (
              onVerDetalleBloque ? (
                <button
                  type="button"
                  onClick={() => onVerDetalleBloque(fila.grupoPagoId as string)}
                  className="inline-flex w-fit items-center border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 text-left text-[11px] font-semibold text-cyan-700 hover:bg-cyan-100"
                >
                  Pago en bloque
                  {fila.grupoOtrosDOs.length > 0
                    ? ` — también cubre: ${fila.grupoOtrosDOs.map((g) => g.consecutivo).join(", ")}`
                    : ""}
                </button>
              ) : (
                <span className="inline-flex w-fit items-center border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 text-[11px] font-semibold text-cyan-700">
                  Pago en bloque
                  {fila.grupoOtrosDOs.length > 0
                    ? ` — también cubre: ${fila.grupoOtrosDOs.map((g) => g.consecutivo).join(", ")}`
                    : ""}
                </span>
              )
            ) : null}
            {fila.grupo && BigInt(fila.grupo.costoBancario || "0") > 0n ? (
              <span className="text-[11px] text-slate-500">
                Costo de la transferencia {formatCOP(fila.grupo.costoBancario)}
                {" · "}
                {COSTO_ASUMIDO_LABEL[fila.grupo.costoAsumidoPor] ?? fila.grupo.costoAsumidoPor}
              </span>
            ) : null}
            {estadoMovimientoBadge(fila.estado)}
          </div>
        </td>

        {/* N° soporte */}
        <td className="px-2.5 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">{fila.numSoporte ?? "—"}</span>
          ) : (
            <input
              value={fila.editingNumSoporte}
              onChange={(e) => onChange(fila.id, "editingNumSoporte", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              placeholder="—"
              aria-label={`Número de soporte del ${etiqueta}`}
              className="h-8 w-full min-w-[6.5rem] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none [field-sizing:content] placeholder:text-slate-500 focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Valor — de solo lectura cuando el pago tiene facturas o es de un bloque (§B.4). */}
        <td className="px-2.5 py-2 text-right">
          {readOnly || !fila.editableDinero ? (
            <span
              className="text-sm font-medium text-slate-900"
              title={!readOnly && !fila.editableDinero ? "Cubre facturas o es de un bloque: anula y registra de nuevo para cambiar el valor." : undefined}
            >
              {formatCOP(fila.valor)}
              {BigInt(fila.noCobrable ?? "0") > 0n ? (
                <span className="block text-[11px] font-normal text-slate-500">
                  {formatCOP(fila.noCobrable ?? "0")} no se cobra (asesoría)
                </span>
              ) : null}
            </span>
          ) : (
            <CampoMoneda
              value={fila.editingValor}
              onValueChange={(digitos) => onChange(fila.id, "editingValor", digitos)}
              onFocus={(e) => e.target.select()}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Valor del ${etiqueta} (COP)`}
              className="h-8 w-full min-w-[110px] border border-transparent bg-transparent px-1 text-right text-sm font-medium text-slate-900 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Canal de pago — de solo lectura en las mismas condiciones que el valor. */}
        <td className="px-2.5 py-2">
          {readOnly || !fila.editableDinero ? (
            <span className="text-sm text-slate-700">{canalPagoLabel(fila.canalPago)}</span>
          ) : (
            <select
              value={fila.editingCanal}
              onChange={(e) => {
                onChange(fila.id, "editingCanal", e.target.value);
                onBlur(fila.id);
              }}
              aria-label={`Canal de pago del ${etiqueta}`}
              className="h-8 w-full min-w-[9rem] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
            >
              {CANALES_PAGO.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </td>

        {/* Fecha de pago */}
        <td className="px-2.5 py-2">
          {readOnly ? (
            <span className="whitespace-nowrap text-sm text-slate-700">
              {fila.fechaRealPago ? formatDate(fila.fechaRealPago) : "—"}
            </span>
          ) : (
            <input
              type="date"
              value={fila.editingFechaReal}
              onChange={(e) => onChange(fila.id, "editingFechaReal", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Fecha de pago del ${etiqueta}`}
              className="h-8 w-full min-w-[120px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Costo bancario — de solo lectura (calculado por backend) */}
        <td className="px-2.5 py-2 text-right text-sm text-slate-600">
          {formatCOP(fila.costoBancario)}
        </td>

        {/* Saldo corriente — recalculado en vivo en cliente */}
        <td className={`px-2.5 py-2 text-right text-sm ${saldoColorClass(fila.saldoLocal)}`}>
          {formatCOP(fila.saldoLocal)}
        </td>

        {/* Acciones */}
        <td className="px-2.5 py-2">
          {readOnly ? null : (
            <div className="flex items-center gap-1">
              {fila.estado === "REALIZADO" ? (
                <button
                  type="button"
                  onClick={() => onVerify(fila.id)}
                  disabled={isVerifying}
                  className="inline-flex h-7 items-center gap-1 border border-cyan-300 bg-cyan-50 px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-60"
                  title="Marcar como verificado"
                  aria-label={`Marcar ${etiqueta} como verificado`}
                >
                  {isVerifying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  Verificar
                </button>
              ) : null}
              {fila.saving ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-500" aria-hidden="true" />
              ) : fila.dirty ? (
                <span className="h-2 w-2 rounded-full bg-amber-400" title="Cambios pendientes" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-slate-300" aria-hidden="true" />
              )}
              {fila.esBloque && fila.grupoPagoId ? (
                // Un pago de bloque no se borra suelto (§B.4 PAGO_DE_BLOQUE): solo ADMIN puede
                // anular el bloque completo desde aquí.
                esAdmin ? (
                  <button
                    type="button"
                    onClick={() =>
                      onAnularBloque(
                        fila.grupoPagoId as string,
                        `${fila.concepto} · ${formatCOP(fila.valor)} · ${fila.fechaRealPago ? formatDate(fila.fechaRealPago) : "sin fecha"}`,
                      )
                    }
                    className="inline-flex h-7 items-center gap-1 border border-rose-200 bg-rose-50 px-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100"
                    title="Anular pago en bloque"
                  >
                    Anular bloque
                  </button>
                ) : null
              ) : (
                <button
                  type="button"
                  onClick={() => onDelete(fila.id)}
                  disabled={isDeleting}
                  className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-rose-600 disabled:opacity-40"
                  aria-label={`Eliminar ${etiqueta}`}
                  title="Eliminar pago"
                >
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          )}
        </td>
      </tr>

      {/* Fila de error de la fila */}
      {fila.errorFila ? (
        <tr className="bg-rose-50">
          <td colSpan={9} className="px-3 py-1.5 text-xs text-rose-700" role="alert">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
    </>
  );
}
