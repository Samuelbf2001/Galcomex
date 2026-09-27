"use client";

import { AlertTriangle, Banknote, ChevronDown, ChevronRight, Download, ExternalLink, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { CxpApiError, enlazarFichaDePago, fetchCuentaProveedor } from "@/components/clientes/cxp-api";
import { exportarEstadoCuentaProveedor } from "@/components/clientes/cxp-export";
import { ModuleState } from "@/components/layout/module-state";
import { AnularBloqueDialog } from "@/components/pagos/anular-bloque-dialog";
import { DetalleBloqueDialog } from "@/components/pagos/detalle-bloque-dialog";
import { PagoEnBloqueModal } from "@/components/pagos/pago-multi-do-modal";
import { formatCOP } from "@/components/pagos/pagos-global-api";
import type {
  EstadoCuentaProveedorJson,
  FilaEstadoCuentaJson,
  PagoRealizadoJson,
} from "@/lib/cxp/contratos-api";
import { EnlaceTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";
import { formatFechaCalendario, formatInstanteBogota } from "@/lib/tiempo/bogota";

// ---------------------------------------------------------------------------
// "Estado de cuenta con {proveedor}" + "Pagos realizados a {proveedor}"
// (CxP v2, diseño §D.1, paquete P3). Reemplaza a `seccion-pagos-proveedor.tsx`
// (que solo listaba pendientes de todos los trámites). Ahora es el estado de
// cuenta ESTILO EXCEL: toda factura de proveedor (no solo REGISTRADA), con
// saldo real, chip Pendiente/Abonada/Pagada y el registro de cada
// transferencia. Una sola fuente de datos: `GET /api/clientes/[id]/cuenta-proveedor`
// (P1) — la misma que usa el filtro por proveedor de `/pagos` (P6).
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";
type Filtro = "PENDIENTES" | "PAGADAS" | "TODAS";

const CANAL_LABEL: Record<string, string> = {
  TRANSF_BANCOLOMBIA: "Transf. Bancolombia",
  PSE: "PSE",
  TRANSF_OTROS_BANCOS: "Transf. Otros Bancos",
};

const COSTO_ASUMIDO_LABEL: Record<string, string> = {
  GALCOMEX: "lo asume Galcomex",
  PRIMER_DO: "lo asume el primer DO que se pudo cobrar",
  PRORRATEADO: "repartido entre los DOs que pudieron absorberlo",
};

const CHIP_CLASE: Record<string, string> = {
  Pendiente: "border-amber-200 bg-amber-50 text-amber-800",
  Abonada: "border-cyan-200 bg-cyan-50 text-cyan-800",
  Pagada: "border-slate-200 bg-slate-50 text-slate-600",
  Cruzada: "border-cyan-200 bg-cyan-50 text-cyan-800",
  "Pagada con ajuste": "border-rose-200 bg-rose-50 text-rose-700",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `GET /api/tramites/[tramiteId]/documentos/[id]` para abrir el comprobante
 * en una pestaña nueva (mismo patrón que P4 en `detalle-bloque-dialog.tsx`;
 * duplicado a propósito para no acoplarme a un archivo de otro paquete).
 */
async function abrirComprobante(tramiteId: string, documentoId: string): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/documentos/${documentoId}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || typeof payload.url !== "string") {
    throw new Error("No fue posible abrir el comprobante.");
  }
  window.open(payload.url, "_blank", "noopener,noreferrer");
}

// ─── Desglose del resumen (puro, testeado) ───────────────────────────────────

/**
 * Lo que baja "Le debemos" además de los pagos del libro: lo cruzado en cuenta
 * corriente y los ajustes que dejó la migración. Sin esto las tarjetas no
 * cuadran (Total ≠ Pagado + Le debemos) y la diferencia no se explica en
 * ningún lado. Solo vienen los conceptos mayores que 0.
 */
export function desgloseResumenCxp(resumen: {
  cruzado: string;
  ajustado: string;
}): { etiqueta: string; valor: string }[] {
  const partes: { etiqueta: string; valor: string }[] = [];
  const mayorQueCero = (v: string) => {
    try {
      return BigInt(v) > 0n;
    } catch {
      return false;
    }
  };
  if (mayorQueCero(resumen.cruzado)) partes.push({ etiqueta: "Cruzado en cuenta corriente", valor: resumen.cruzado });
  if (mayorQueCero(resumen.ajustado)) partes.push({ etiqueta: "Ajustes de migración", valor: resumen.ajustado });
  return partes;
}

// ─── Filtro + búsqueda (puro, testeado) ──────────────────────────────────────

export function filtrarFacturasCxp(
  facturas: FilaEstadoCuentaJson[],
  filtro: Filtro,
  busqueda: string,
): FilaEstadoCuentaJson[] {
  const porEstado = facturas.filter((f) => {
    if (filtro === "PENDIENTES") return f.estado === "REGISTRADA" || f.estado === "PARCIAL";
    if (filtro === "PAGADAS") return f.estado === "PAGADA";
    return true;
  });
  const q = busqueda.trim().toLowerCase();
  if (!q) return porEstado;
  return porEstado.filter(
    (f) =>
      f.numFacturaVisible.toLowerCase().includes(q) ||
      f.numFactura.toLowerCase().includes(q) ||
      f.doCorto.toLowerCase().includes(q) ||
      f.tramiteConsecutivo.toLowerCase().includes(q) ||
      (f.marca ?? "").toLowerCase().includes(q),
  );
}

// ─── Fila de factura (con detalle expandible) ────────────────────────────────

function FilaFactura({
  f,
  expandida,
  onToggle,
}: {
  f: FilaEstadoCuentaJson;
  expandida: boolean;
  onToggle: () => void;
}) {
  const [abriendo, setAbriendo] = useState<string | null>(null);
  const { toast } = useToast();

  async function verComprobante(documentoId: string, tramiteId: string) {
    setAbriendo(documentoId);
    try {
      await abrirComprobante(tramiteId, documentoId);
    } catch (caught) {
      toast({ title: "No se pudo abrir el comprobante", description: describirError(caught), variant: "error" });
    } finally {
      setAbriendo(null);
    }
  }

  const pagoTexto = f.fechaPago
    ? formatFechaCalendario(f.fechaPago)
    : f.etiqueta === "Abonada" && f.abonos.length > 0
      ? `Abono ${formatFechaCalendario(f.abonos[f.abonos.length - 1].fecha)}`
      : null;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
        onClick={onToggle}
        aria-expanded={expandida}
      >
        <td className="px-3 py-2.5">
          <span className="inline-flex items-center gap-1.5 font-mono font-semibold text-slate-900">
            {expandida ? (
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            )}
            {f.numFacturaVisible}
          </span>
        </td>
        <td className="px-3 py-2.5 text-slate-600">{f.marca ?? "—"}</td>
        <td className="px-3 py-2.5">
          <EnlaceTramite id={f.tramiteId} tab="facturas-proveedor" title={f.tramiteConsecutivo}>
            {f.doCorto}
          </EnlaceTramite>
        </td>
        <td className="px-3 py-2.5 text-slate-600">{formatFechaCalendario(f.fecha)}</td>
        <td className="px-3 py-2.5 text-right font-mono text-slate-900">{formatCOP(f.valor)}</td>
        <td className="px-3 py-2.5 text-slate-500">
          {pagoTexto ? (
            f.fechaPago ? (
              pagoTexto
            ) : (
              <span className="text-slate-400">{pagoTexto}</span>
            )
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900">{formatCOP(f.saldo)}</td>
        <td className="px-3 py-2.5">
          <span className={`inline-flex h-6 items-center whitespace-nowrap border px-2 text-xs font-semibold ${CHIP_CLASE[f.etiqueta] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>
            {f.etiqueta}
          </span>
          {f.saldo !== "0" && !f.pagable && f.motivoNoPagable ? (
            <span className="mt-1 block text-[11px] font-normal text-slate-400">{f.motivoNoPagable.mensaje}</span>
          ) : null}
        </td>
      </tr>
      {expandida ? (
        <tr className="border-b border-slate-100 bg-slate-50/70 last:border-b-0">
          <td colSpan={8} className="px-4 py-3">
            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-400">Cliente</dt>
                <dd className="font-medium text-slate-700">{f.clienteNombre}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Pagado</dt>
                <dd className="font-medium text-slate-700">{formatCOP(f.aplicado)}</dd>
              </div>
              {f.compensado !== "0" ? (
                <div>
                  <dt className="text-slate-400">Cruzado en cuenta corriente</dt>
                  <dd className="font-medium text-slate-700">{formatCOP(f.compensado)}</dd>
                </div>
              ) : null}
              {f.montoAjustes !== "0" ? (
                <div>
                  <dt className="text-slate-400">Ajuste de migración</dt>
                  <dd className="font-medium text-slate-700">{formatCOP(f.montoAjustes)}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-slate-400">Cobrada al cliente</dt>
                <dd className="font-medium text-slate-700">
                  {f.facturadaAlCliente
                    ? `${f.facturadaAlCliente.numSiigo ?? "en revisión"} (${f.clienteNombre})`
                    : "No"}
                </dd>
              </div>
            </dl>
            {f.pagos.length > 0 ? (
              <div className="mt-3">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pagos</p>
                <ul className="space-y-1">
                  {f.pagos
                    .filter((p) => p.monto !== "0")
                    .map((p) => (
                      <li key={p.pagoId} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        <span>{p.fechaRealPago ? formatFechaCalendario(p.fechaRealPago) : "sin fecha"}</span>
                        <span className="font-mono font-semibold text-slate-800">{formatCOP(p.monto)}</span>
                        {p.esHistorico ? <span className="text-slate-400">· histórico</span> : null}
                        {p.comprobante ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void verComprobante(p.comprobante!.documentoId, p.comprobante!.tramiteId);
                            }}
                            disabled={abriendo === p.comprobante.documentoId}
                            className="inline-flex items-center gap-1 text-cyan-700 hover:underline disabled:opacity-60"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            comprobante
                          </button>
                        ) : null}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Tarjeta de una fila para celular (< 640 px): Factura, DO, Saldo y chip. */
function TarjetaFactura({
  f,
  expandida,
  onToggle,
}: {
  f: FilaEstadoCuentaJson;
  expandida: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-slate-900">{f.numFacturaVisible}</p>
          <p className="truncate text-xs text-slate-500">{f.doCorto} · {f.marca ?? "—"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="font-mono text-sm font-semibold text-slate-900">{formatCOP(f.saldo)}</p>
            <span className={`inline-flex h-5 items-center whitespace-nowrap border px-1.5 text-[10px] font-semibold ${CHIP_CLASE[f.etiqueta] ?? "border-slate-200 bg-slate-50 text-slate-600"}`}>
              {f.etiqueta}
            </span>
          </div>
          {expandida ? <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />}
        </div>
      </button>
      {expandida ? (
        <dl className="grid grid-cols-2 gap-2 border-t border-slate-100 bg-slate-50/70 px-3 py-3 text-xs">
          <div><dt className="text-slate-400">Fecha</dt><dd className="font-medium text-slate-700">{formatFechaCalendario(f.fecha)}</dd></div>
          <div><dt className="text-slate-400">Total</dt><dd className="font-medium text-slate-700">{formatCOP(f.valor)}</dd></div>
          <div><dt className="text-slate-400">Pagado</dt><dd className="font-medium text-slate-700">{formatCOP(f.aplicado)}</dd></div>
          {f.compensado !== "0" ? (
            <div><dt className="text-slate-400">Cruzado</dt><dd className="font-medium text-slate-700">{formatCOP(f.compensado)}</dd></div>
          ) : null}
          {f.montoAjustes !== "0" ? (
            <div><dt className="text-slate-400">Ajuste de migración</dt><dd className="font-medium text-slate-700">{formatCOP(f.montoAjustes)}</dd></div>
          ) : null}
          <div><dt className="text-slate-400">Cliente</dt><dd className="font-medium text-slate-700">{f.clienteNombre}</dd></div>
          {f.motivoNoPagable ? (
            <div className="col-span-2"><dt className="text-slate-400">Por qué no se puede pagar</dt><dd className="text-slate-600">{f.motivoNoPagable.mensaje}</dd></div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

// ─── Fila de "Pagos realizados" ───────────────────────────────────────────────

function FilaPago({
  p,
  esAdmin,
  onVerDetalle,
  onAnular,
}: {
  p: PagoRealizadoJson;
  esAdmin: boolean;
  onVerDetalle: (grupoPagoId: string) => void;
  onAnular: (info: { grupoPagoId: string; resumen: string }) => void;
}) {
  const [expandido, setExpandido] = useState(false);
  const esBloque = p.tipo === "BLOQUE";
  const { toast } = useToast();

  function alHacerClic() {
    if (esBloque) onVerDetalle(p.id);
    else setExpandido((v) => !v);
  }

  const resumen = `${formatFechaCalendario(p.fecha)} · ${formatCOP(p.valor)} · ${p.dos.length} DO${p.dos.length === 1 ? "" : "s"}`;

  return (
    <>
      <tr className="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50" onClick={alHacerClic}>
        <td className="px-3 py-2.5 text-slate-600">{p.fecha ? formatFechaCalendario(p.fecha) : "—"}</td>
        <td className="px-3 py-2.5 text-slate-800">
          {p.concepto}
          {esBloque ? <span className="ml-1.5 inline-flex h-5 items-center border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-semibold uppercase text-slate-500">Bloque</span> : null}
        </td>
        <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-900">{formatCOP(p.valor)}</td>
        <td className="px-3 py-2.5 text-slate-600">{CANAL_LABEL[p.canalPago] ?? p.canalPago}</td>
        <td className="px-3 py-2.5 text-slate-600">
          {p.costoBancario !== "0" ? (
            <>
              {formatCOP(p.costoBancario)}
              {p.costoAsumidoPor ? <span className="block text-[11px] text-slate-400">{COSTO_ASUMIDO_LABEL[p.costoAsumidoPor] ?? p.costoAsumidoPor}</span> : null}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2.5 text-slate-600">{p.dos.map((d) => d.consecutivo).join(", ")}</td>
        <td className="px-3 py-2.5">
          {p.estado === "ANULADO" && p.anulacion ? (
            <span className="inline-flex h-6 items-center whitespace-nowrap border border-rose-200 bg-rose-50 px-2 text-xs font-semibold text-rose-700">
              Anulado el {formatInstanteBogota(p.anulacion.en)}
            </span>
          ) : p.esHistorico ? (
            <span className="inline-flex h-6 items-center whitespace-nowrap border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-500">
              Histórico
            </span>
          ) : (
            <span className="inline-flex h-6 items-center whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 text-xs font-semibold text-emerald-700">
              Activo
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right">
          {p.esHistorico ? (
            <span className="text-xs text-slate-400">Conciliado con el Excel</span>
          ) : esAdmin && esBloque && p.estado === "ACTIVO" ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAnular({ grupoPagoId: p.id, resumen });
              }}
              className="text-xs font-semibold text-rose-700 hover:underline"
            >
              Anular bloque
            </button>
          ) : null}
        </td>
      </tr>
      {!esBloque && expandido ? (
        <tr className="border-b border-slate-100 bg-slate-50/70 last:border-b-0">
          <td colSpan={8} className="px-4 py-3 text-xs">
            <p className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Facturas cubiertas</p>
            <ul className="space-y-0.5">
              {p.facturas.map((f) => (
                <li key={f.facturaId} className="flex items-center justify-between text-slate-600">
                  <span>{f.numFactura}</span>
                  <span className="font-mono font-semibold text-slate-800">{formatCOP(f.monto)}</span>
                </li>
              ))}
            </ul>
            {p.comprobante ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  abrirComprobante(p.comprobante!.tramiteId, p.comprobante!.documentoId).catch((caught: unknown) => {
                    toast({ title: "No se pudo abrir el comprobante", description: describirError(caught), variant: "error" });
                  });
                }}
                className="mt-2 inline-flex items-center gap-1 text-cyan-700 hover:underline"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                Ver comprobante
              </button>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function SeccionCxpProveedor({
  empresaId,
  nombreEmpresa,
  refreshToken = 0,
  onCambio,
}: {
  empresaId: string;
  nombreEmpresa: string;
  /** Cambia cuando OTRA sección (cuenta corriente) mueve el saldo del proveedor: recarga. */
  refreshToken?: number;
  /** Se llama tras pagar o anular: la ficha lo usa para refrescar cuenta corriente también. */
  onCambio?: () => void;
}) {
  const puedePagar = usePermiso(["ADMIN", "OPERATIVO"]);
  const puedeExportar = usePermiso(["ADMIN", "REVISOR"]);
  const esAdmin = usePermiso(["ADMIN"]);
  const { toast } = useToast();

  const [cuenta, setCuenta] = useState<EstadoCuentaProveedorJson | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [filtro, setFiltro] = useState<Filtro>("PENDIENTES");
  const [busqueda, setBusqueda] = useState("");
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());

  const [eligiendoFicha, setEligiendoFicha] = useState(false);
  const [modalPago, setModalPago] = useState<BeneficiarioSeleccion | null>(null);
  const [detalleBloqueId, setDetalleBloqueId] = useState<string | null>(null);
  const [anulando, setAnulando] = useState<{ grupoPagoId: string; resumen: string } | null>(null);
  const [exportando, setExportando] = useState(false);
  const [enlazando, setEnlazando] = useState(false);
  const raizRef = useRef<HTMLDivElement>(null);

  // "Ver estado de cuenta" desde /pagos llega con #estado-cuenta: la ficha
  // carga en el cliente, así que el navegador no alcanza a bajar solo.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#estado-cuenta") {
      raizRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      try {
        const data = await fetchCuentaProveedor(empresaId, controller.signal);
        setCuenta(data);
        setLoadState("ready");
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(
          caught instanceof CxpApiError
            ? caught.message
            : describirError(caught, "Error al cargar el estado de cuenta."),
        );
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [empresaId, reloadKey, refreshToken]);

  function recargar() {
    setReloadKey((k) => k + 1);
  }

  function toggleFactura(id: string) {
    setExpandidas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibles = useMemo(
    () => (cuenta ? filtrarFacturasCxp(cuenta.facturas, filtro, busqueda) : []),
    [cuenta, filtro, busqueda],
  );

  const conciliacionPendiente = cuenta?.fichas.some((f) => f.conciliacionPendiente) ?? false;
  const nombreCorto = cuenta?.empresa.nombreCorto ?? nombreEmpresa;

  function abrirPagarEnBloque() {
    if (!cuenta || cuenta.fichas.length === 0) return;
    if (cuenta.fichas.length === 1) {
      const f = cuenta.fichas[0];
      setModalPago({ id: f.id, nombre: f.nombreCorto ?? f.nombre, nit: f.nit });
      return;
    }
    setEligiendoFicha(true);
  }

  function alPagarEnBloque(result: { grupoPagoId: string; advertencias: { codigo: string; mensaje: string }[] }) {
    setModalPago(null);
    recargar();
    onCambio?.();
    if (result.advertencias.length > 0) {
      toast({
        title: "Pago en bloque registrado con avisos",
        description: result.advertencias.map((a) => a.mensaje).join(" · "),
        variant: "success",
      });
    }
  }

  // «Enlazar ficha de pago» (rama Coldex, M5): el endpoint es solo ADMIN.
  async function enlazarFicha() {
    if (enlazando) return;
    setEnlazando(true);
    try {
      await enlazarFichaDePago(empresaId);
      toast({ title: "Ficha de pago enlazada", variant: "success" });
      recargar();
      onCambio?.();
    } catch (caught: unknown) {
      toast({ title: "No se pudo enlazar la ficha de pago", description: describirError(caught), variant: "error" });
    } finally {
      setEnlazando(false);
    }
  }

  async function exportar() {
    if (!cuenta || !cuenta.resumen) return;
    setExportando(true);
    try {
      await exportarEstadoCuentaProveedor({
        nombreProveedor: nombreCorto,
        resumen: cuenta.resumen,
        facturas: cuenta.facturas,
        pagos: cuenta.pagos,
      });
    } catch (caught) {
      toast({ title: "No se pudo exportar", description: describirError(caught), variant: "error" });
    } finally {
      setExportando(false);
    }
  }

  return (
    <div id="estado-cuenta" ref={raizRef} className="scroll-mt-4 overflow-hidden border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Estado de cuenta con {nombreCorto}</p>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-500">
            Lo que Galcomex le debe a {nombreCorto}, factura por factura, y lo que ya se le pagó. Son las mismas
            columnas de tu Excel de cartera.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {puedePagar ? (
            <button
              type="button"
              onClick={abrirPagarEnBloque}
              disabled={!cuenta || cuenta.fichas.length === 0}
              className="inline-flex h-9 items-center gap-1.5 border border-slate-950 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
              Pagar en bloque
            </button>
          ) : null}
          {puedeExportar ? (
            <button
              type="button"
              onClick={() => void exportar()}
              disabled={!cuenta?.resumen || exportando}
              className="inline-flex h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {exportando ? "Exportando…" : "Exportar a Excel"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={recargar}
            className="inline-flex h-9 items-center border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
            aria-label="Actualizar estado de cuenta"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {loadState === "loading" ? (
        <div className="p-4">
          <CardsSkeleton count={3} height={72} />
          <TableSkeleton rows={4} cols={7} />
        </div>
      ) : loadState === "error" ? (
        <div className="p-4">
          <ModuleState type="error" title="No se pudo cargar el estado de cuenta" detail={loadError ?? undefined} action={{ label: "Reintentar", onClick: recargar }} />
        </div>
      ) : !cuenta ? null : cuenta.fichas.length === 0 ? (
        <div className="p-4">
          <ModuleState
            type="empty"
            title="Sin ficha de pago enlazada"
            detail={
              esAdmin
                ? `${nombreEmpresa} todavía no tiene ficha de pago. Enlázala para ver aquí su estado de cuenta: se usa la ficha que ya tenga su mismo NIT o se crea una nueva.`
                : "Pídele a un administrador que enlace la ficha de pago de esta empresa."
            }
            action={
              esAdmin
                ? { label: enlazando ? "Enlazando…" : "Enlazar ficha de pago", onClick: () => void enlazarFicha(), icon: false }
                : undefined
            }
          />
        </div>
      ) : (
        <>
          {conciliacionPendiente ? (
            <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Cartera sin conciliar con tu Excel: revisa antes de pagar. Puede haber facturas que ya pagaste por
              fuera.
            </div>
          ) : null}

          {cuenta.resumen ? (
            <div className="grid gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-3">
              <div className="bg-white px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Le debemos</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-amber-800">{formatCOP(cuenta.resumen.pendiente)}</p>
              </div>
              <div className="bg-white px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Pagado</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-slate-900">{formatCOP(cuenta.resumen.pagado)}</p>
              </div>
              <div className="bg-white px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total de sus facturas</p>
                <p className="mt-0.5 font-mono text-lg font-bold text-slate-900">{formatCOP(cuenta.resumen.facturado)}</p>
              </div>
              {desgloseResumenCxp(cuenta.resumen).length > 0 ? (
                <div className="bg-white px-4 py-2.5 text-xs text-slate-600 sm:col-span-3">
                  Además de lo pagado:{" "}
                  {desgloseResumenCxp(cuenta.resumen).map((d, i) => (
                    <span key={d.etiqueta}>
                      {i > 0 ? " · " : ""}
                      {d.etiqueta} <strong className="font-mono text-slate-800">{formatCOP(d.valor)}</strong>
                    </span>
                  ))}
                  <span className="text-slate-400"> (Total = Pagado + esto + Le debemos)</span>
                </div>
              ) : null}
              {cuenta.resumen.pagadoSinFactura !== "0" ? (
                <div className="bg-white px-4 py-3 sm:col-span-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Pagos que no cubren ninguna factura
                  </p>
                  <p className="mt-0.5 font-mono text-sm font-semibold text-amber-800">
                    {formatCOP(cuenta.resumen.pagadoSinFactura)} — revisar: pueden ser pagos de más o anticipos al proveedor
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2.5">
            <div className="inline-flex border border-slate-300">
              {(cuenta.vista === "COMPLETA" ? (["PENDIENTES", "PAGADAS", "TODAS"] as const) : (["PENDIENTES"] as const)).map(
                (opcion) => (
                  <button
                    key={opcion}
                    type="button"
                    onClick={() => setFiltro(opcion)}
                    className={`h-8 px-3 text-xs font-semibold transition ${
                      filtro === opcion ? "bg-slate-950 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {opcion === "PENDIENTES" ? "Pendientes" : opcion === "PAGADAS" ? "Pagadas" : "Todas"}
                  </button>
                ),
              )}
            </div>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Factura, DO (26-0238) o marca"
              className="h-8 min-w-0 flex-1 border border-slate-300 px-2.5 text-xs focus:border-slate-500 focus:outline-none"
            />
          </div>

          {visibles.length === 0 ? (
            <div className="p-4">
              <ModuleState type="empty" title="Sin facturas en este filtro" />
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="border-b border-slate-200 px-3 py-2.5">Factura</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Marca</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">DO</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Fecha</th>
                      <th className="border-b border-slate-200 px-3 py-2.5 text-right">Total</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Pago</th>
                      <th className="border-b border-slate-200 px-3 py-2.5 text-right">Saldo</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((f) => (
                      <FilaFactura key={f.id} f={f} expandida={expandidas.has(f.id)} onToggle={() => toggleFactura(f.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="sm:hidden">
                {visibles.map((f) => (
                  <TarjetaFactura key={f.id} f={f} expandida={expandidas.has(f.id)} onToggle={() => toggleFactura(f.id)} />
                ))}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2.5">
            {cuenta.resumen ? (
              <p className="text-sm font-semibold text-slate-900">
                Total por pagar: {formatCOP(cuenta.resumen.pendiente)}
              </p>
            ) : (
              <span />
            )}
            {cuenta.historialDesde ? (
              <p className="text-xs text-slate-400">
                Historial en el sistema desde {formatFechaCalendario(cuenta.historialDesde)}. Las facturas anteriores
                están en tu Excel de cartera.
              </p>
            ) : null}
          </div>

          {cuenta.vista === "COMPLETA" ? (
            <div className="border-t border-slate-200">
              <div className="border-b border-slate-200 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Pagos realizados a {nombreCorto}</p>
                <p className="mt-0.5 text-xs text-slate-500">Una fila por transferencia. Clic en la fila para ver el detalle.</p>
              </div>
              {cuenta.pagos.length === 0 ? (
                <div className="p-4">
                  <ModuleState type="empty" title="Sin pagos registrados todavía" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] border-collapse text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2.5">Fecha</th>
                        <th className="border-b border-slate-200 px-3 py-2.5">Concepto</th>
                        <th className="border-b border-slate-200 px-3 py-2.5 text-right">Valor</th>
                        <th className="border-b border-slate-200 px-3 py-2.5">Canal</th>
                        <th className="border-b border-slate-200 px-3 py-2.5">Costo transferencia</th>
                        <th className="border-b border-slate-200 px-3 py-2.5">DOs</th>
                        <th className="border-b border-slate-200 px-3 py-2.5">Estado</th>
                        <th className="border-b border-slate-200 px-3 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {cuenta.pagos.map((p) => (
                        <FilaPago
                          key={`${p.tipo}-${p.id}`}
                          p={p}
                          esAdmin={esAdmin}
                          onVerDetalle={setDetalleBloqueId}
                          onAnular={setAnulando}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      {eligiendoFicha && cuenta ? (
        <ModalShell open onClose={() => setEligiendoFicha(false)} title="¿A qué cuenta?" description={`${nombreEmpresa} tiene varias fichas de pago.`} size="sm">
          <div className="divide-y divide-slate-100 border border-slate-200">
            {cuenta.fichas.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setEligiendoFicha(false);
                  setModalPago({ id: f.id, nombre: f.nombreCorto ?? f.nombre, nit: f.nit });
                }}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-slate-50"
              >
                <span className="font-medium text-slate-800">{f.nombreCorto ?? f.nombre}</span>
                <span className="text-xs text-slate-400">{f.nit ?? "sin NIT"}</span>
              </button>
            ))}
          </div>
        </ModalShell>
      ) : null}

      {modalPago ? (
        <PagoEnBloqueModal beneficiarioInicial={modalPago} beneficiarioFijo onClose={() => setModalPago(null)} onCreated={alPagarEnBloque} />
      ) : null}

      {detalleBloqueId ? <DetalleBloqueDialog grupoPagoId={detalleBloqueId} onClose={() => setDetalleBloqueId(null)} /> : null}

      {anulando ? (
        <AnularBloqueDialog
          grupoPagoId={anulando.grupoPagoId}
          resumen={anulando.resumen}
          onClose={() => setAnulando(null)}
          onDone={() => {
            setAnulando(null);
            recargar();
            onCambio?.();
          }}
        />
      ) : null}
    </div>
  );
}
