"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { ModuleState } from "@/components/layout/module-state";
import {
  CANALES_PAGO,
  type CanalPago,
  type FacturaElegibleMultiDORow,
  crearPagoMultiDO,
  fetchFacturasElegiblesMultiDO,
  formatCOP,
  formatDate,
  subirComprobante,
} from "@/components/pagos/pagos-global-api";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").replace(/COP/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  try {
    return BigInt(cleaned).toString();
  } catch {
    return null;
  }
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

export type PagoMultiDOModalProps = {
  onClose: () => void;
  onCreated: () => void;
  /** Abrir con el beneficiario ya elegido (desde la ficha del proveedor). */
  beneficiarioInicial?: BeneficiarioSeleccion | null;
  /** No permitir cambiar el beneficiario. */
  beneficiarioFijo?: boolean;
};

export function PagoMultiDOModal({ onClose, onCreated, beneficiarioInicial = null, beneficiarioFijo = false }: PagoMultiDOModalProps) {
  const { toast } = useToast();
  const [beneficiarioSel, setBeneficiarioSel] = useState<BeneficiarioSeleccion | null>(beneficiarioInicial);
  const [facturas, setFacturas] = useState<FacturaElegibleMultiDORow[]>([]);
  const [loadingFacturas, setLoadingFacturas] = useState(beneficiarioInicial !== null);
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
              disabled={beneficiarioFijo}
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
