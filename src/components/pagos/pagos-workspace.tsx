"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  CANALES_PAGO,
  type CanalPago,
  type ClienteOption,
  type FacturaElegibleMultiDORow,
  type PagoGlobalRow,
  type PagosGlobalFiltros,
  type TramiteOption,
  crearPagoMultiDO,
  createPago,
  deletePago,
  fetchClienteOptions,
  fetchFacturasElegiblesMultiDO,
  fetchPagosGlobal,
  fetchTramiteOptions,
  formatCOP,
  formatDate,
  subirComprobante,
  updatePago,
} from "@/components/pagos/pagos-global-api";
import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

/**
 * Crear ("Nuevo pago", "Pago multi-DO" → /api/pagos/multi), editar en línea y
 * eliminar exigen ADMIN/OPERATIVO. REVISOR consulta en solo lectura.
 */
const ROLES_EDITAR_PAGOS = ["ADMIN", "OPERATIVO"] as const;

function canalPagoLabel(canal: CanalPago): string {
  return CANALES_PAGO.find((c) => c.value === canal)?.label ?? canal;
}

// ---------------------------------------------------------------------------
// Helpers de formato / parseo
// ---------------------------------------------------------------------------

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").replace(/COP/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  try {
    return BigInt(cleaned).toString();
  } catch {
    return null;
  }
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fila editable
// ---------------------------------------------------------------------------

type FilaPago = PagoGlobalRow & {
  editingConcepto: string;
  editingNumSoporte: string;
  editingValor: string;
  editingCanal: CanalPago;
  editingFechaReal: string;
  dirty: boolean;
  saving: boolean;
  errorFila: string | null;
};

function filaFromRow(row: PagoGlobalRow): FilaPago {
  return {
    ...row,
    editingConcepto: row.concepto,
    editingNumSoporte: row.numSoporte ?? "",
    editingValor: row.valor,
    editingCanal: row.canalPago,
    editingFechaReal: isoToDateInput(row.fechaRealPago),
    dirty: false,
    saving: false,
    errorFila: null,
  };
}

// ---------------------------------------------------------------------------
// Modal: nuevo pago (con selector de DO)
// ---------------------------------------------------------------------------

type NuevoPagoModalProps = {
  tramites: TramiteOption[];
  tramiteIdInicial?: string;
  onClose: () => void;
  onCreated: () => void;
};

function NuevoPagoModal({ tramites, tramiteIdInicial, onClose, onCreated }: NuevoPagoModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valorRaw, setValorRaw] = useState("");
  const [beneficiariosSel, setBeneficiariosSel] = useState<BeneficiarioSeleccion[]>([]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    const formData = new FormData(e.currentTarget);
    const tramiteId = String(formData.get("tramiteId") ?? "").trim();
    const concepto = String(formData.get("concepto") ?? "").trim();
    const canalPago = String(formData.get("canalPago") ?? "") as CanalPago;
    const fechaRealPago = String(formData.get("fechaRealPago") ?? "").trim() || null;

    if (!tramiteId) {
      setError("Selecciona el DO al que pertenece el pago.");
      return;
    }

    const valorBig = parseBigIntInput(valorRaw);
    if (!valorBig || BigInt(valorBig) <= 0n) {
      setError("El valor debe ser un número entero mayor a 0.");
      return;
    }

    setIsSubmitting(true);
    try {
      await createPago(tramiteId, {
        concepto,
        beneficiarioIds: beneficiariosSel.map((b) => b.id),
        numSoporte: null,
        valor: valorBig,
        canalPago,
        fechaRealPago,
      });
      const consecutivo = tramites.find((t) => t.id === tramiteId)?.consecutivo ?? "";
      toast({
        title: "Pago guardado",
        description: `${concepto} · ${formatCOP(valorBig)}${consecutivo ? ` en ${consecutivo}` : ""}`,
        variant: "success",
      });
      onCreated();
    } catch (caught) {
      setError(describirError(caught, "Error al crear el pago."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Agregar pago"
      description="Pago a proveedor cargado al DO que elijas."
      size="lg"
      dismissible={!isSubmitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Trámite (DO) *</span>
            <select
              name="tramiteId"
              required
              defaultValue={tramiteIdInicial ?? ""}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <option value="">Seleccionar DO</option>
              {tramites.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.consecutivo} — {t.clienteNombre}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Concepto *</span>
            <input
              name="concepto"
              required
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
              <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
              <input
                type="date"
                name="fechaRealPago"
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
              <input
                value={valorRaw}
                onChange={(ev) => setValorRaw(ev.target.value)}
                placeholder="1.000.000"
                inputMode="numeric"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
              <select
                name="canalPago"
                required
                defaultValue="TRANSF_BANCOLOMBIA"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                {CANALES_PAGO.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
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
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Guardar pago
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Modal: Pago multi-DO (caso Karina/Occidente)
//
// Una sola transferencia del beneficiario cubre facturas de proveedor de
// VARIOS DOs distintos. En vez de que Camila copie/pegue desde una carpeta
// externa, este modal: (1) lista TODAS las facturas REGISTRADA del
// beneficiario en cualquier DO, agrupadas por DO; (2) permite seleccionar
// cuáles se pagaron y con qué monto (default = valor de la factura, editable
// para abonos parciales); (3) al confirmar, crea UN PagoTramite por cada DO
// involucrado, todos con el mismo grupoPagoId/comprobante — ver
// crearPagoMultiDO() en src/lib/pagos/service.ts.
// ---------------------------------------------------------------------------

type PagoMultiDOModalProps = {
  onClose: () => void;
  onCreated: () => void;
};

function PagoMultiDOModal({ onClose, onCreated }: PagoMultiDOModalProps) {
  const { toast } = useToast();
  const [beneficiarioSel, setBeneficiarioSel] = useState<BeneficiarioSeleccion | null>(null);
  const [facturas, setFacturas] = useState<FacturaElegibleMultiDORow[]>([]);
  const [loadingFacturas, setLoadingFacturas] = useState(false);
  const [facturasError, setFacturasError] = useState<string | null>(null);
  const [facturasReloadKey, setFacturasReloadKey] = useState(0);

  // facturaId → monto (string en edición). Presencia en el map = seleccionada.
  const [montos, setMontos] = useState<Record<string, string>>({});

  const [canalPago, setCanalPago] = useState<CanalPago>(CANALES_PAGO[0]?.value ?? "TRANSF_BANCOLOMBIA");
  const [fechaRealPago, setFechaRealPago] = useState(() => new Date().toISOString().slice(0, 10));
  const [concepto, setConcepto] = useState("");
  const [comprobanteBancarioFile, setComprobanteBancarioFile] = useState<File | null>(null);
  const [comprobanteComercioFile, setComprobanteComercioFile] = useState<File | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cargar facturas elegibles al elegir/cambiar el beneficiario (el reseteo
  // al quitar el beneficiario ocurre en el onChange, no en el efecto).
  useEffect(() => {
    if (!beneficiarioSel) return;
    const controller = new AbortController();
    fetchFacturasElegiblesMultiDO(beneficiarioSel.id, controller.signal)
      .then((data) => {
        setFacturas(data);
        setMontos({});
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFacturasError(describirError(caught, "Error al cargar las facturas."));
      })
      .finally(() => setLoadingFacturas(false));
    return () => controller.abort();
  }, [beneficiarioSel, facturasReloadKey]);

  // Agrupar por DO para el render
  const grupos = useMemo(() => {
    const map = new Map<
      string,
      { tramiteId: string; consecutivo: string; clienteNombre: string; tieneAnticipoAplicado: boolean; facturas: FacturaElegibleMultiDORow[] }
    >();
    for (const f of facturas) {
      const g = map.get(f.tramiteId) ?? {
        tramiteId: f.tramiteId,
        consecutivo: f.tramiteConsecutivo,
        clienteNombre: f.clienteNombre,
        tieneAnticipoAplicado: f.tieneAnticipoAplicado,
        facturas: [],
      };
      g.facturas.push(f);
      map.set(f.tramiteId, g);
    }
    return [...map.values()];
  }, [facturas]);

  const facturasSeleccionadasIds = Object.keys(montos);
  const dosSinAnticipoSeleccionados = grupos.filter(
    (g) => !g.tieneAnticipoAplicado && g.facturas.some((f) => montos[f.id] !== undefined),
  );

  const totalSeleccionado = facturasSeleccionadasIds.reduce((sum, id) => {
    try {
      return sum + BigInt(parseBigIntInput(montos[id]) ?? "0");
    } catch {
      return sum;
    }
  }, 0n);

  function toggleFactura(f: FacturaElegibleMultiDORow) {
    setMontos((prev) => {
      const next = { ...prev };
      if (next[f.id] !== undefined) {
        delete next[f.id];
      } else {
        next[f.id] = f.valor;
      }
      return next;
    });
  }

  function setMonto(facturaId: string, raw: string) {
    setMontos((prev) => ({ ...prev, [facturaId]: raw }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    if (!beneficiarioSel) {
      setError("Selecciona el beneficiario.");
      return;
    }
    if (facturasSeleccionadasIds.length === 0) {
      setError("Selecciona al menos una factura de proveedor.");
      return;
    }
    if (dosSinAnticipoSeleccionados.length > 0) {
      setError(
        `El/los DO ${dosSinAnticipoSeleccionados.map((g) => g.consecutivo).join(", ")} no tienen anticipo aplicado — no se pueden incluir (regla "sin anticipo no hay pagos").`,
      );
      return;
    }

    const facturasPayload: { facturaProveedorId: string; monto: string }[] = [];
    for (const id of facturasSeleccionadasIds) {
      const monto = parseBigIntInput(montos[id] ?? "");
      if (!monto || BigInt(monto) <= 0n) {
        setError("Todos los montos seleccionados deben ser un número entero mayor a 0.");
        return;
      }
      facturasPayload.push({ facturaProveedorId: id, monto });
    }

    // El comprobante (si se adjunta) se registra bajo el primer DO
    // seleccionado — el documento queda técnicamente vinculado a ese trámite,
    // pero documentoId/comprobanteComercioId se comparten entre TODOS los
    // pagos del grupo (ver crearPagoMultiDO).
    const primeraFacturaId = facturasSeleccionadasIds[0];
    const tramitePrimario = facturas.find((f) => f.id === primeraFacturaId)?.tramiteId;

    setIsSubmitting(true);
    try {
      let documentoId: string | null = null;
      let comprobanteComercioId: string | null = null;

      if ((comprobanteBancarioFile || comprobanteComercioFile) && tramitePrimario) {
        const [bancario, comercio] = await Promise.all([
          comprobanteBancarioFile
            ? subirComprobante(tramitePrimario, "COMPROBANTE_BANCARIO", comprobanteBancarioFile)
            : Promise.resolve(null),
          comprobanteComercioFile
            ? subirComprobante(tramitePrimario, "COMPROBANTE_COMERCIO", comprobanteComercioFile)
            : Promise.resolve(null),
        ]);
        documentoId = bancario?.id ?? null;
        comprobanteComercioId = comercio?.id ?? null;
      }

      const resultado = await crearPagoMultiDO({
        beneficiarioId: beneficiarioSel.id,
        facturas: facturasPayload,
        canalPago,
        fechaRealPago: fechaRealPago || null,
        concepto: concepto.trim() || undefined,
        documentoId,
        comprobanteComercioId,
      });

      toast({
        title: "Pago multi-DO registrado",
        description: `${resultado.pagos.length} pago(s) · ${formatCOP(totalSeleccionado.toString())} a ${beneficiarioSel.nombre}`,
        variant: "success",
      });
      onCreated();
    } catch (caught) {
      setError(describirError(caught, "Error al crear el pago multi-DO."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Pago multi-DO"
      description="Un solo comprobante cubre facturas de proveedor de varios trámites (caso Karina/Occidente)."
      size="xl"
      dismissible={!isSubmitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Beneficiario / proveedor *</span>
            <BeneficiarioCombobox
              mode="single"
              value={beneficiarioSel}
              onChange={(seleccion) => {
                setBeneficiarioSel(seleccion);
                setFacturas([]);
                setMontos({});
                setFacturasError(null);
                setLoadingFacturas(seleccion !== null);
              }}
              placeholder="Buscar beneficiario…"
            />
          </label>

          {loadingFacturas ? (
            <TableSkeleton rows={3} cols={4} rowHeight={40} />
          ) : facturasError ? (
            <ModuleState
              type="error"
              title="No se pudieron cargar las facturas del beneficiario"
              detail={facturasError}
              action={{ label: "Reintentar", onClick: () => setFacturasReloadKey((k) => k + 1) }}
            />
          ) : beneficiarioSel && grupos.length === 0 ? (
            <p className="border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
              Este beneficiario no tiene facturas de proveedor pendientes (REGISTRADA) en ningún DO.
            </p>
          ) : (
            <div className="space-y-3">
              {grupos.map((g) => (
                <div key={g.tramiteId} className="border border-slate-200">
                  <div
                    className={`flex items-center justify-between px-3 py-2 text-sm ${
                      g.tieneAnticipoAplicado ? "bg-slate-50" : "bg-amber-50"
                    }`}
                  >
                    <div>
                      <span className="font-semibold text-slate-900">{g.consecutivo}</span>
                      <span className="ml-2 text-slate-500">{g.clienteNombre}</span>
                    </div>
                    {!g.tieneAnticipoAplicado ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700"
                        title='Regla "sin anticipo no hay pagos": este DO no puede incluirse hasta que se le aplique un anticipo.'
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Sin anticipo aplicado
                      </span>
                    ) : null}
                  </div>
                  <table className="w-full border-collapse text-left text-sm">
                    <tbody>
                      {g.facturas.map((f) => {
                        const seleccionada = montos[f.id] !== undefined;
                        return (
                          <tr key={f.id} className="border-t border-slate-100">
                            <td className="w-8 px-3 py-2">
                              <input
                                type="checkbox"
                                checked={seleccionada}
                                disabled={!g.tieneAnticipoAplicado}
                                onChange={() => toggleFactura(f)}
                                aria-label={`Incluir factura ${f.numFactura} de ${g.consecutivo}`}
                                className="h-4 w-4"
                              />
                            </td>
                            <td className="px-3 py-2 font-medium text-slate-800">{f.numFactura}</td>
                            <td className="px-3 py-2 text-slate-500">{formatDate(f.fecha)}</td>
                            <td className="px-3 py-2 text-right text-slate-600">{formatCOP(f.valor)}</td>
                            <td className="px-3 py-2 text-right">
                              <input
                                value={seleccionada ? montos[f.id] : ""}
                                disabled={!seleccionada}
                                onChange={(e) => setMonto(f.id, e.target.value)}
                                placeholder="Monto a pagar"
                                inputMode="numeric"
                                aria-label={`Monto a pagar de la factura ${f.numFactura}`}
                                className="h-8 w-32 border border-slate-300 px-2 text-right text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {facturasSeleccionadasIds.length > 0 ? (
                <div className="flex justify-end border-t border-slate-200 pt-2 text-sm">
                  <span className="text-slate-500">Total seleccionado: </span>
                  <span className="ml-1 font-semibold text-slate-900">
                    {formatCOP(totalSeleccionado.toString())}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Concepto <span className="font-normal text-slate-400">(opcional)</span>
            </span>
            <input
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              placeholder="Ej. Pago consolidado facturas Occidente"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Canal de pago *</span>
              <select
                value={canalPago}
                onChange={(e) => setCanalPago(e.target.value as CanalPago)}
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
              <span className="text-sm font-medium text-slate-700">Fecha de pago</span>
              <input
                type="date"
                value={fechaRealPago}
                onChange={(e) => setFechaRealPago(e.target.value)}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Comprobante bancario (Bancolombia)
                <span className="ml-1.5 font-normal text-slate-400">(opcional)</span>
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
                  Sin comprobante bancario los pagos quedan con advertencia visual (no se bloquean).
                </p>
              )}
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Comprobante de comercio
                <span className="ml-1.5 font-normal text-slate-400">(opcional)</span>
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

          <p className="text-[11px] text-slate-400">
            Un solo comprobante y canal cubren todos los DOs seleccionados. El costo bancario del canal
            se cobra una sola vez (en el primer pago del grupo) para no inflar los costos del cliente.
          </p>

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
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || facturasSeleccionadasIds.length === 0}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Registrar pago multi-DO
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Fila de la tabla (edición inline + autosave)
// ---------------------------------------------------------------------------

type FilaPagoProps = {
  fila: FilaPago;
  /** Solo lectura (REVISOR): sin inputs ni acciones. */
  readOnly: boolean;
  isDeleting: boolean;
  onChange: (
    id: string,
    field: keyof Pick<
      FilaPago,
      | "editingConcepto"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
  ) => void;
  onBlur: (id: string) => void;
  onDelete: (fila: FilaPago) => void;
};

function FilaPagoRow({ fila, readOnly, isDeleting, onChange, onBlur, onDelete }: FilaPagoProps) {
  const etiqueta = `pago "${fila.concepto}" del DO ${fila.consecutivo}`;

  return (
    <>
      <tr className={`border-b border-slate-100 last:border-b-0 ${fila.saving ? "opacity-60" : ""} hover:bg-slate-50`}>
        {/* DO */}
        <td className="whitespace-nowrap px-3 py-2">
          <Link
            href={`/tramites/${fila.tramiteId}`}
            className="text-sm font-medium text-cyan-700 hover:underline"
          >
            {fila.consecutivo}
          </Link>
        </td>

        {/* Cliente */}
        <td className="px-3 py-2 text-sm text-slate-700">{fila.clienteNombre}</td>

        {/* Concepto */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="block min-w-[140px] px-1 text-sm text-slate-800">{fila.concepto}</span>
          ) : (
            <input
              value={fila.editingConcepto}
              onChange={(e) => onChange(fila.id, "editingConcepto", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              aria-label={`Concepto del ${etiqueta}`}
              className="h-8 w-full min-w-[140px] border border-transparent bg-transparent px-1 text-sm text-slate-800 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
          {!fila.documentoId || fila.grupoPagoId ? (
            <div className="flex flex-wrap gap-1 px-1 pb-0.5">
              {!fila.documentoId ? (
                <span
                  className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                  title="Pago sin comprobante bancario"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Sin comprobante
                </span>
              ) : null}
              {fila.grupoPagoId ? (
                <span
                  className="inline-flex items-center border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700"
                  title={
                    fila.grupoOtrosDOs.length > 0
                      ? `Pago multi-DO — también cubre: ${fila.grupoOtrosDOs.map((g) => g.consecutivo).join(", ")}`
                      : "Pago multi-DO"
                  }
                >
                  Pago multi-DO
                </span>
              ) : null}
            </div>
          ) : null}
        </td>

        {/* Beneficiarios (solo lectura en vista global) */}
        <td className="px-3 py-2 text-sm text-slate-700">
          {fila.beneficiarios || <span className="text-slate-400">—</span>}
        </td>

        {/* N° soporte */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">{fila.numSoporte ?? "—"}</span>
          ) : (
            <input
              value={fila.editingNumSoporte}
              onChange={(e) => onChange(fila.id, "editingNumSoporte", e.target.value)}
              onBlur={() => onBlur(fila.id)}
              placeholder="—"
              aria-label={`Número de soporte del ${etiqueta}`}
              className="h-8 w-full min-w-[100px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Valor */}
        <td className="px-3 py-2 text-right">
          {readOnly ? (
            <span className="text-sm font-medium text-slate-900">{formatCOP(fila.valor)}</span>
          ) : (
            <input
              value={fila.editingValor}
              onChange={(e) => onChange(fila.id, "editingValor", e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => onBlur(fila.id)}
              inputMode="numeric"
              aria-label={`Valor del ${etiqueta} (COP)`}
              className="h-8 w-full min-w-[110px] border border-transparent bg-transparent px-1 text-right text-sm font-medium text-slate-900 outline-none focus:border-cyan-400 focus:bg-white"
            />
          )}
        </td>

        {/* Canal */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">{canalPagoLabel(fila.canalPago)}</span>
          ) : (
            <select
              value={fila.editingCanal}
              onChange={(e) => {
                onChange(fila.id, "editingCanal", e.target.value);
                onBlur(fila.id);
              }}
              aria-label={`Canal de pago del ${etiqueta}`}
              className="h-8 w-full min-w-[180px] border border-transparent bg-transparent px-1 text-sm text-slate-700 outline-none focus:border-cyan-400 focus:bg-white"
            >
              {CANALES_PAGO.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </td>

        {/* Fecha real */}
        <td className="px-3 py-2">
          {readOnly ? (
            <span className="text-sm text-slate-700">
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

        {/* Costo bancario (solo lectura) */}
        <td className="px-3 py-2 text-right text-sm text-slate-600">
          {formatCOP(fila.costoBancario)}
        </td>

        {/* Acciones */}
        <td className="px-3 py-2">
          {readOnly ? null : (
            <div className="flex items-center gap-1">
              {fila.saving ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" aria-hidden="true" />
              ) : fila.dirty ? (
                <span className="h-2 w-2 rounded-full bg-amber-400" title="Cambios pendientes" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-slate-300" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => onDelete(fila)}
                disabled={isDeleting}
                className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                aria-label={`Eliminar ${etiqueta}`}
                title="Eliminar pago"
              >
                {isDeleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </td>
      </tr>

      {fila.errorFila ? (
        <tr className="bg-rose-50">
          <td colSpan={10} className="px-3 py-1.5 text-xs text-rose-700" role="alert">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {fila.errorFila} — los valores anteriores se restauraron.
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function PagosWorkspace() {
  const puedeEditar = usePermiso(ROLES_EDITAR_PAGOS);
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [filas, setFilas] = useState<FilaPago[]>([]);
  const [totales, setTotales] = useState({ totalPagos: "0", costosBancarios: "0", totalPendiente: "0" });
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [tramites, setTramites] = useState<TramiteOption[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [multiDOOpen, setMultiDOOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Filtros
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroCanal, setFiltroCanal] = useState<CanalPago | "">("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [busqueda, setBusqueda] = useState("");

  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Carga ---
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);

      const filtros: PagosGlobalFiltros = {
        clienteId: filtroCliente || undefined,
        canalPago: filtroCanal || undefined,
        soloPendientes: soloPendientes || undefined,
      };

      const [data, clientesData, tramitesData] = await Promise.all([
        fetchPagosGlobal(filtros, controller.signal),
        fetchClienteOptions(controller.signal),
        fetchTramiteOptions(controller.signal),
      ]);

      setFilas(data.pagos.map(filaFromRow));
      setTotales({
        totalPagos: data.totalPagos,
        costosBancarios: data.costosBancarios,
        totalPendiente: data.totalPendiente,
      });
      setClientes(clientesData);
      setTramites(tramitesData);
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar los pagos.");
      setLoadState("error");
    });

    return () => controller.abort();
  }, [reloadKey, filtroCliente, filtroCanal, soloPendientes]);

  // Búsqueda en cliente (concepto / beneficiario / N° soporte / DO)
  const filasVisibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return filas;
    return filas.filter(
      (f) =>
        f.concepto.toLowerCase().includes(q) ||
        (f.beneficiarios ?? "").toLowerCase().includes(q) ||
        (f.numSoporte ?? "").toLowerCase().includes(q) ||
        f.consecutivo.toLowerCase().includes(q),
    );
  }, [filas, busqueda]);

  // --- Edición inline ---
  function handleFieldChange(
    id: string,
    field: keyof Pick<
      FilaPago,
      | "editingConcepto"
      | "editingNumSoporte"
      | "editingValor"
      | "editingCanal"
      | "editingFechaReal"
    >,
    value: string,
  ) {
    setFilas((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value, dirty: true, errorFila: null } : f)),
    );
  }

  function scheduleAutoSave(id: string) {
    if (saveTimersRef.current[id]) clearTimeout(saveTimersRef.current[id]);
    saveTimersRef.current[id] = setTimeout(() => void commitFila(id), 900);
  }

  function handleBlurField(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (fila?.dirty) scheduleAutoSave(id);
  }

  async function commitFila(id: string) {
    const fila = filas.find((f) => f.id === id);
    if (!fila) return;

    setFilas((prev) => prev.map((f) => (f.id === id ? { ...f, saving: true, errorFila: null } : f)));

    const valorBig = parseBigIntInput(fila.editingValor);
    const snapshot = { ...fila };

    try {
      const updated = await updatePago(fila.tramiteId, id, {
        concepto: fila.editingConcepto,
        numSoporte: fila.editingNumSoporte || null,
        valor: valorBig ?? fila.valor,
        canalPago: fila.editingCanal,
        fechaRealPago: fila.editingFechaReal || null,
      });

      setFilas((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f;
          return {
            ...f,
            concepto: updated.concepto,
            beneficiarios: updated.beneficiarios.map((b) => b.nombre).join(", "),
            numSoporte: updated.numSoporte,
            valor: updated.valor,
            canalPago: updated.canalPago,
            costoBancario: updated.costoBancario,
            fechaRealPago: updated.fechaRealPago,
            editingConcepto: updated.concepto,
            editingNumSoporte: updated.numSoporte ?? "",
            editingValor: updated.valor,
            editingCanal: updated.canalPago,
            editingFechaReal: isoToDateInput(updated.fechaRealPago),
            dirty: false,
            saving: false,
            errorFila: null,
          };
        }),
      );
      // Recalcular totales tras edición confirmada
      setReloadTotales();
      toast({
        title: "Pago actualizado",
        description: `${updated.concepto} · ${fila.consecutivo}`,
        variant: "success",
      });
    } catch (caught) {
      const msg = describirError(caught, "Error al guardar.");
      setFilas((prev) =>
        prev.map((f) => (f.id === id ? { ...snapshot, saving: false, errorFila: msg } : f)),
      );
      toast({ title: "No se pudo guardar el pago", description: msg, variant: "error" });
    }
  }

  // Recalcula los totales de las tarjetas a partir de las filas actuales
  function setReloadTotales() {
    setFilas((prev) => {
      const totalPagos = prev.reduce((s, f) => s + BigInt(parseBigIntInput(f.editingValor) ?? f.valor), 0n);
      const costosBancarios = prev.reduce((s, f) => s + BigInt(f.costoBancario), 0n);
      const totalPendiente = prev.reduce(
        (s, f) => (f.fechaRealPago === null ? s + BigInt(parseBigIntInput(f.editingValor) ?? f.valor) : s),
        0n,
      );
      setTotales({
        totalPagos: totalPagos.toString(),
        costosBancarios: costosBancarios.toString(),
        totalPendiente: totalPendiente.toString(),
      });
      return prev;
    });
  }

  async function handleDelete(fila: FilaPago) {
    if (deletingId) return;
    const ok = await confirmar({
      title: `¿Eliminar el pago "${fila.concepto}"?`,
      description: `DO ${fila.consecutivo} · ${formatCOP(fila.valor)}. Esta acción no se puede deshacer.`,
      confirmText: "Eliminar pago",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(fila.id);

    try {
      await deletePago(fila.tramiteId, fila.id);
      setFilas((prev) => prev.filter((f) => f.id !== fila.id));
      setReloadTotales();
      toast({ title: "Pago eliminado", description: `${fila.concepto} · ${fila.consecutivo}`, variant: "success" });
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

  function handlePagoCreado() {
    setCreateOpen(false);
    setReloadKey((k) => k + 1);
  }

  function handlePagoMultiDOCreado() {
    setMultiDOOpen(false);
    setReloadKey((k) => k + 1);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isInitialLoading = loadState === "loading" && filas.length === 0;

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Pagos</h1>
          <p className="mt-1 text-sm text-slate-600">
            Vista global de todos los pagos de todos los DOs. El libro por trámite sigue intacto.
          </p>
        </div>
        {puedeEditar ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMultiDOOpen(true)}
              className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              title="Un solo comprobante cubre facturas de varios DOs (caso Karina/Occidente)"
            >
              <Users className="h-4 w-4" aria-hidden="true" />
              Pago multi-DO
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo pago
            </button>
          </div>
        ) : null}
      </div>

      {!puedeEditar ? (
        <p className="flex items-center gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Solo lectura para tu perfil: crear, editar o eliminar pagos requiere ADMIN u OPERATIVO.
        </p>
      ) : null}

      {/* Tarjetas de resumen */}
      {isInitialLoading ? (
        <CardsSkeleton count={3} height={84} />
      ) : loadState === "ready" || filas.length > 0 ? (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total pagos", value: totales.totalPagos, color: "text-slate-900" },
            { label: "Costos bancarios", value: totales.costosBancarios, color: "text-slate-700" },
            { label: "Pendiente de pagar", value: totales.totalPendiente, color: "text-amber-700" },
          ].map((s) => (
            <div key={s.label} className="border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</p>
              <p className={`mt-1 text-xl font-bold ${s.color}`}>{formatCOP(s.value)}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 text-sm">
        <select
          value={filtroCliente}
          onChange={(e) => setFiltroCliente(e.target.value)}
          aria-label="Filtrar por cliente"
          className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
        >
          <option value="">Todos los clientes</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>

        <select
          value={filtroCanal}
          onChange={(e) => setFiltroCanal(e.target.value as CanalPago | "")}
          aria-label="Filtrar por canal de pago"
          className="h-9 border border-slate-300 bg-white px-2 text-sm outline-none focus:border-cyan-600"
        >
          <option value="">Todos los canales</option>
          {CANALES_PAGO.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setSoloPendientes((v) => !v)}
          aria-pressed={soloPendientes}
          className={`h-9 border px-3 text-xs font-semibold transition ${
            soloPendientes
              ? "border-amber-600 bg-amber-600 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Solo pendientes
        </button>

        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar concepto, beneficiario, DO…"
          aria-label="Buscar por concepto, beneficiario, soporte o DO"
          className="h-9 min-w-[220px] flex-1 border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
        />

        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {/* Tabla: la carga inicial reserva el alto con un skeleton */}
      {isInitialLoading ? (
        <TableSkeleton rows={6} cols={10} rowHeight={44} />
      ) : (
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-900">Pagos</p>
          <p className="text-slate-500" aria-live="polite">
            {filasVisibles.length} registros
          </p>
        </div>
        {loadState === "error" ? (
          <div className="p-4">
            <ModuleState
              type="error"
              title="No fue posible cargar los pagos"
              detail={loadError ?? undefined}
              action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
            />
          </div>
        ) : loadState === "loading" ? (
          <div className="p-4">
            <ModuleState type="loading" title="Actualizando pagos…" />
          </div>
        ) : filasVisibles.length === 0 ? (
          <div className="p-4">
            <ModuleState
              type="empty"
              title="No hay pagos que coincidan con los filtros"
              detail="Ajusta cliente, canal o búsqueda para ampliar la consulta."
            />
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2">DO</th>
                <th className="border-b border-slate-200 px-3 py-2">Cliente</th>
                <th className="border-b border-slate-200 px-3 py-2">Concepto</th>
                <th className="border-b border-slate-200 px-3 py-2">Beneficiarios</th>
                <th className="border-b border-slate-200 px-3 py-2">N° soporte</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor (COP)</th>
                <th className="border-b border-slate-200 px-3 py-2">Canal</th>
                <th className="border-b border-slate-200 px-3 py-2">Fecha de pago</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo bancario</th>
                <th className="border-b border-slate-200 px-3 py-2 w-12">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filasVisibles.map((fila) => (
                <FilaPagoRow
                  key={fila.id}
                  fila={fila}
                  readOnly={!puedeEditar}
                  isDeleting={deletingId === fila.id}
                  onChange={handleFieldChange}
                  onBlur={handleBlurField}
                  onDelete={(f) => void handleDelete(f)}
                />
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
      )}

      {createOpen && puedeEditar ? (
        <NuevoPagoModal
          tramites={tramites}
          onClose={() => setCreateOpen(false)}
          onCreated={handlePagoCreado}
        />
      ) : null}

      {multiDOOpen && puedeEditar ? (
        <PagoMultiDOModal
          onClose={() => setMultiDOOpen(false)}
          onCreated={handlePagoMultiDOCreado}
        />
      ) : null}
    </section>
  );
}
