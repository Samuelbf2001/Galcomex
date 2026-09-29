"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BeneficiarioCombobox, type BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { ModuleState } from "@/components/layout/module-state";
import {
  advertenciasSeleccion,
  desmarcarTodas,
  facturasDelBloque,
  faltanteAbono,
  marcarTodas,
  opcionesCosto,
  seleccionInicial,
  textoConfirmacion,
  totalesSeleccion,
  validarMonto,
  yaPagado,
  type SeleccionBloque,
} from "@/components/pagos/pago-bloque-calculo";
import {
  CANALES_PAGO,
  crearPagoMultiDO,
  fetchFacturasElegiblesMultiDO,
  formatCOP,
  formatDate,
  subirComprobante,
  type CanalPago,
  type CostoAsumidoPor,
  type FacturaElegibleJson,
} from "@/components/pagos/pagos-global-api";
import { CampoMoneda, type DetalleCampoMoneda } from "@/components/ui/campo-moneda";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { advertenciaValorTransferido } from "@/lib/cxp/pagabilidad";
import { centavosDeTexto, centavosDeTextoApi, formatoEdicion, formatoPesos, textoCanonicoDeCentavos } from "@/lib/dinero";
import { hoyBogotaISO } from "@/lib/tiempo/bogota";
import { nuevaClaveIdempotencia } from "@/components/pagos/clave-idempotencia";

// ---------------------------------------------------------------------------
// Modal "Pagar en bloque a {proveedor}" (CxP v2, diseño §D.2, paquete P4).
//
// Una sola transferencia/comprobante cubre facturas de proveedor de VARIOS
// DOs. Al abrir, las facturas PAGABLES vienen preseleccionadas con su saldo
// (arregla el paso 4 del "paso a paso": antes abría sin nada marcado); las no
// pagables aparecen deshabilitadas con el motivo (DO cerrado, sin anticipo,
// sin proveedor…). Cada fila admite abonos (monto < saldo). El costo bancario
// de la transferencia se registra UNA sola vez (cabecera `PagoGrupo`, §A.4) y
// quien paga escoge quién lo asume (D-1): el primer DO que aún se puede
// cobrar, repartido entre los que pueden, o Galcomex.
//
// El cálculo (selección, totales, avisos, opciones de costo y el texto de
// confirmación) es PURO y vive en `pago-bloque-calculo.ts`, con sus propias
// pruebas — este componente solo conecta ese cálculo con la pantalla y con
// `crearPagoMultiDO()` (`src/lib/pagos/service.ts`, P1).
// ---------------------------------------------------------------------------

export type PagoEnBloqueModalProps = {
  onClose: () => void;
  /** `grupoPagoId` del bloque creado + avisos que no bloquearon (p. ej. `COSTO_NO_COBRABLE`). */
  onCreated: (result: { grupoPagoId: string; advertencias: { codigo: string; mensaje: string }[] }) => void;
  /** Abrir con el beneficiario/proveedor ya elegido (desde la ficha del proveedor o /pagos). */
  beneficiarioInicial?: BeneficiarioSeleccion | null;
  /** No permitir cambiar el beneficiario. */
  beneficiarioFijo?: boolean;
};

export function PagoEnBloqueModal({
  onClose,
  onCreated,
  beneficiarioInicial = null,
  beneficiarioFijo = false,
}: PagoEnBloqueModalProps) {
  const { toast } = useToast();
  const confirmar = useConfirm();

  const [beneficiarioSel, setBeneficiarioSel] = useState<BeneficiarioSeleccion | null>(beneficiarioInicial);
  const [facturas, setFacturas] = useState<FacturaElegibleJson[]>([]);
  const [loadingFacturas, setLoadingFacturas] = useState(beneficiarioInicial !== null);
  const [facturasError, setFacturasError] = useState<string | null>(null);
  const [facturasReloadKey, setFacturasReloadKey] = useState(0);
  const [costosPorCanal, setCostosPorCanal] = useState<Partial<Record<CanalPago, string>>>({});

  const [sel, setSel] = useState<SeleccionBloque>({});
  const [montoErrores, setMontoErrores] = useState<Record<string, string>>({});
  const [errorValorTransferido, setErrorValorTransferido] = useState<string | null>(null);

  const [canalPago, setCanalPago] = useState<CanalPago>(CANALES_PAGO[0]?.value ?? "TRANSF_BANCOLOMBIA");
  const [fechaRealPago, setFechaRealPago] = useState(() => hoyBogotaISO());
  const [concepto, setConcepto] = useState("");
  const [comprobanteBancarioFile, setComprobanteBancarioFile] = useState<File | null>(null);
  const [comprobanteComercioFile, setComprobanteComercioFile] = useState<File | null>(null);
  const [valorTransferidoRaw, setValorTransferidoRaw] = useState("");

  const [costoAsumidoPorManual, setCostoAsumidoPorManual] = useState<CostoAsumidoPor | null>(null);
  const [claveIdempotencia, setClaveIdempotencia] = useState(nuevaClaveIdempotencia);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La ficha del proveedor manda una vez elegido el beneficiario (§D.1: aviso
  // ámbar "Cartera sin conciliar"). Todas las filas de un mismo beneficiario
  // comparten el valor.
  const conciliacionPendiente = facturas.some((f) => f.conciliacionPendiente);

  // Cargar facturas elegibles al elegir/cambiar el beneficiario. RF-23: si el
  // proveedor tiene conciliación pendiente, el modal abre SIN nada marcado.
  useEffect(() => {
    if (!beneficiarioSel) return;
    const controller = new AbortController();
    fetchFacturasElegiblesMultiDO(beneficiarioSel.id, controller.signal)
      .then(({ facturas: data, costosPorCanal: costos }) => {
        setFacturas(data);
        setCostosPorCanal(costos);
        setSel(seleccionInicial(data, data.some((f) => f.conciliacionPendiente)));
        setMontoErrores({});
        setFacturasError(null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFacturasError(describirError(caught, "Error al cargar las facturas."));
      })
      .finally(() => {
        // Una carga cancelada (cambio de beneficiario o Reintentar) no apaga el
        // "cargando" de la carga nueva que sigue en curso.
        if (!controller.signal.aborted) setLoadingFacturas(false);
      });
    return () => controller.abort();
  }, [beneficiarioSel, facturasReloadKey]);

  // Agrupar por DO para el render (orden de llegada del API, ya por consecutivo).
  const grupos = useMemo(() => {
    const map = new Map<
      string,
      { tramiteId: string; consecutivo: string; clienteId: string; clienteNombre: string; facturas: FacturaElegibleJson[] }
    >();
    for (const f of facturas) {
      const g = map.get(f.tramiteId) ?? {
        tramiteId: f.tramiteId,
        consecutivo: f.tramiteConsecutivo,
        clienteId: f.clienteId,
        clienteNombre: f.clienteNombre,
        facturas: [],
      };
      g.facturas.push(f);
      map.set(f.tramiteId, g);
    }
    return [...map.values()];
  }, [facturas]);

  const totales = useMemo(() => totalesSeleccion(facturas, sel), [facturas, sel]);
  const advertencias = useMemo(() => advertenciasSeleccion(facturas, sel), [facturas, sel]);
  const opciones = useMemo(() => opcionesCosto(facturas, sel), [facturas, sel]);
  const costoAsumidoPor: CostoAsumidoPor =
    costoAsumidoPorManual && opciones.opciones.some((o) => o.value === costoAsumidoPorManual)
      ? costoAsumidoPorManual
      : opciones.defecto;

  // Costo de la transferencia según el canal (matriz de pago; el servidor lo vuelve a resolver).
  const costoCanalTexto = costosPorCanal[canalPago];
  const costoCanal: bigint | null =
    costoCanalTexto !== undefined ? centavosDeTextoApi(costoCanalTexto) : null;

  const valorTransferido =
    valorTransferidoRaw.trim() === "" ? null : centavosDeTexto(valorTransferidoRaw);
  const avisoValorTransferido = advertenciaValorTransferido(valorTransferido, totales.totalSeleccionado);

  function toggleFactura(f: FacturaElegibleJson) {
    if (!f.pagable) return;
    setSel((prev) => {
      const next = { ...prev };
      if (next[f.id] !== undefined) {
        delete next[f.id];
      } else {
        next[f.id] = f.saldo;
      }
      return next;
    });
    setMontoErrores((prev) => {
      if (!(f.id in prev)) return prev;
      const next = { ...prev };
      delete next[f.id];
      return next;
    });
  }

  function setMonto(f: FacturaElegibleJson, raw: string, detalle?: DetalleCampoMoneda) {
    setSel((prev) => ({ ...prev, [f.id]: raw }));
    // Lo escrito inválido llega como "": el mensaje es el del campo, no «Escribe el monto».
    const v: { ok: true } | { ok: false; mensaje: string } =
      detalle && !detalle.ok ? { ok: false, mensaje: detalle.mensaje } : validarMonto(raw, centavosDeTextoApi(f.saldo));
    setMontoErrores((prev) => {
      const next = { ...prev };
      if (v.ok) delete next[f.id];
      else next[f.id] = v.mensaje;
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;
    setError(null);

    if (!beneficiarioSel) {
      setError("Selecciona el beneficiario.");
      return;
    }

    // Toda factura marcada entra; una con monto vacío o mal escrito frena el
    // envío con su número (antes se sacaba del pago sin avisar).
    const delBloque = facturasDelBloque(facturas, sel, montoErrores);
    if (!delBloque.ok) {
      setError(delBloque.mensaje);
      return;
    }
    if (errorValorTransferido) {
      setError(`Valor que salió del banco: ${errorValorTransferido}`);
      return;
    }
    const porId = new Map(facturas.map((f) => [f.id, f] as const));
    const facturasPayload = delBloque.facturas.map((x) => ({
      facturaProveedorId: x.facturaProveedorId,
      monto: textoCanonicoDeCentavos(x.monto),
    }));

    if (!comprobanteBancarioFile) {
      setError("Adjunta el comprobante del banco.");
      return;
    }

    const texto = textoConfirmacion({
      nombreProveedor: beneficiarioSel.nombre,
      totales,
      // Costo del canal según la matriz de pago (el servidor lo vuelve a resolver al registrar).
      costoBancario: costoCanal ?? 0n,
      costoAsumidoPor,
      primerDoCorto: opciones.primerDoCorto,
      conciliacionPendiente,
    });
    const ok = await confirmar({ title: "Pagar en bloque", description: texto, confirmText: "Registrar pago" });
    if (!ok) return;

    // El comprobante se registra bajo el primer DO seleccionado; documentoId /
    // comprobanteComercioId se comparten entre TODOS los pagos del bloque
    // (ver crearPagoMultiDO en src/lib/pagos/service.ts).
    const primeraFacturaId = facturasPayload[0]?.facturaProveedorId;
    const tramitePrimario = primeraFacturaId ? porId.get(primeraFacturaId)?.tramiteId : undefined;
    if (!tramitePrimario) {
      setError("No fue posible determinar el DO del comprobante.");
      return;
    }

    setIsSubmitting(true);
    try {
      const [bancario, comercio] = await Promise.all([
        subirComprobante(tramitePrimario, "COMPROBANTE_BANCARIO", comprobanteBancarioFile),
        comprobanteComercioFile
          ? subirComprobante(tramitePrimario, "COMPROBANTE_COMERCIO", comprobanteComercioFile)
          : Promise.resolve(null),
      ]);

      const resultado = await crearPagoMultiDO({
        beneficiarioId: beneficiarioSel.id,
        facturas: facturasPayload,
        canalPago,
        fechaRealPago,
        concepto: concepto.trim() || undefined,
        documentoId: bancario.id,
        comprobanteComercioId: comercio?.id ?? null,
        valorTransferido: valorTransferido !== null ? textoCanonicoDeCentavos(valorTransferido) : null,
        costoAsumidoPor,
        claveIdempotencia,
      });

      toast({
        title: resultado.repetido ? "Pago en bloque ya registrado" : "Pago en bloque registrado",
        description: `${resultado.pagos.length} DO(s) · ${formatoPesos(totales.totalSeleccionado)} a ${beneficiarioSel.nombre}`,
        variant: "success",
      });
      setClaveIdempotencia(nuevaClaveIdempotencia());
      onCreated({ grupoPagoId: resultado.grupoPagoId, advertencias: resultado.advertencias });
    } catch (caught) {
      const codigo = (caught as { codigo?: string } | null)?.codigo;
      if (codigo === "IDEMPOTENCIA_CONFLICTO") {
        setClaveIdempotencia(nuevaClaveIdempotencia());
      }
      setError(describirError(caught, "Error al crear el pago en bloque."));
    } finally {
      setIsSubmitting(false);
    }
  }

  const titulo = beneficiarioSel ? `Pagar en bloque a ${beneficiarioSel.nombre}` : "Pagar en bloque";

  return (
    <ModalShell
      open
      onClose={onClose}
      title={titulo}
      description="Una sola transferencia y un solo comprobante para varias facturas de varios DOs."
      size="xl"
      dismissible={!isSubmitting}
    >
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Beneficiario / proveedor *</span>
            <BeneficiarioCombobox
              mode="single"
              value={beneficiarioSel}
              onChange={(seleccion) => {
                setBeneficiarioSel(seleccion);
                setFacturas([]);
                setSel({});
                setMontoErrores({});
                setFacturasError(null);
                setLoadingFacturas(seleccion !== null);
              }}
              placeholder="Buscar beneficiario…"
              disabled={beneficiarioFijo}
            />
          </label>

          {conciliacionPendiente ? (
            <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Cartera sin conciliar con tu Excel: revisa antes de pagar. Puede haber facturas que ya pagaste por fuera.
            </div>
          ) : null}

          {loadingFacturas ? (
            <TableSkeleton rows={3} cols={5} rowHeight={40} />
          ) : facturasError ? (
            <ModuleState
              type="error"
              title="No se pudieron cargar las facturas del beneficiario"
              detail={facturasError}
              action={{
                label: "Reintentar",
                onClick: () => {
                  setFacturasError(null);
                  setLoadingFacturas(true);
                  setFacturasReloadKey((k) => k + 1);
                },
              }}
            />
          ) : beneficiarioSel && grupos.length === 0 ? (
            <p className="border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
              Este beneficiario no tiene facturas de proveedor con saldo en ningún DO.
            </p>
          ) : beneficiarioSel ? (
            <div className="space-y-3">
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSel(marcarTodas(facturas))}
                  className="text-xs font-semibold text-cyan-700 underline-offset-2 hover:underline"
                >
                  Marcar todas
                </button>
                <span className="text-xs text-slate-300">·</span>
                <button
                  type="button"
                  onClick={() => setSel(desmarcarTodas())}
                  className="text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
                >
                  Desmarcar todas
                </button>
              </div>

              {grupos.map((g) => (
                <div key={g.tramiteId} className="border border-slate-200">
                  <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-sm">
                    <div>
                      <EnlaceTramite id={g.tramiteId} tab="facturas-proveedor" className="font-semibold">
                        {g.consecutivo}
                      </EnlaceTramite>
                      <span className="ml-2 text-slate-500">
                        <EnlaceCliente id={g.clienteId}>{g.clienteNombre}</EnlaceCliente>
                      </span>
                    </div>
                  </div>
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-t border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
                        <th scope="col" className="w-8 px-3 py-1.5">
                          <span className="sr-only">Incluir</span>
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">Factura</th>
                        <th scope="col" className="px-3 py-1.5 font-medium">Fecha</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">Total</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">Ya pagado</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">Saldo</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">Monto a pagar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.facturas.map((f) => {
                        const seleccionada = sel[f.id] !== undefined;
                        const montoError = montoErrores[f.id];
                        const quedaDebiendo = seleccionada ? faltanteAbono(sel[f.id] ?? "", f.saldo) : null;
                        return (
                          <tr key={f.id} className="border-t border-slate-100 align-top">
                            <td className="w-8 px-3 py-2">
                              <input
                                type="checkbox"
                                checked={seleccionada}
                                disabled={!f.pagable}
                                onChange={() => toggleFactura(f)}
                                aria-label={`Incluir factura ${f.numFacturaVisible} de ${g.consecutivo}`}
                                className="h-4 w-4"
                              />
                            </td>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              {f.numFacturaVisible}
                              {f.marca ? <div className="text-xs font-normal text-slate-400">{f.marca}</div> : null}
                            </td>
                            <td className="px-3 py-2 text-slate-500">{formatDate(f.fecha)}</td>
                            <td className="px-3 py-2 text-right text-slate-600">{formatCOP(f.valor)}</td>
                            <td className="px-3 py-2 text-right text-slate-600">{formatoPesos(yaPagado(f))}</td>
                            <td className="px-3 py-2 text-right font-medium text-slate-800">{formatCOP(f.saldo)}</td>
                            <td className="px-3 py-2 text-right">
                              {f.pagable ? (
                                <>
                                  <CampoMoneda
                                    value={seleccionada ? sel[f.id] : ""}
                                    disabled={!seleccionada}
                                    onValueChange={(digitos, detalle) => setMonto(f, digitos, detalle)}
                                    placeholder="Monto a pagar"
                                    aria-label={`Monto a pagar de la factura ${f.numFacturaVisible}`}
                                    className="h-8 w-32 border border-slate-300 px-2 text-right text-sm outline-none focus:border-cyan-600 disabled:bg-slate-50"
                                  />
                                  {montoError ? (
                                    <p className="mt-1 text-[11px] text-rose-600">{montoError}</p>
                                  ) : quedaDebiendo !== null ? (
                                    <p className="mt-1 text-[11px] text-amber-700">
                                      Abono: quedará debiendo {formatoPesos(quedaDebiendo)}
                                    </p>
                                  ) : null}
                                </>
                              ) : (
                                <span className="text-xs text-slate-400">{f.motivoNoPagable?.mensaje ?? "No pagable"}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {advertencias.length > 0 ? (
                <div className="space-y-1">
                  {advertencias.map((a, i) => (
                    <div key={`${a.codigo}-${i}`} className="flex items-start gap-2 text-xs text-amber-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {a.mensaje}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Concepto <span className="font-normal text-slate-400">(opcional)</span>
            </span>
            <input
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              placeholder={beneficiarioSel ? `Pago ${beneficiarioSel.nombre} ${formatDate(fechaRealPago)}` : "Concepto"}
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
                Comprobante del banco <span className="font-normal text-rose-500">(obligatorio)</span>
              </span>
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={(e) => setComprobanteBancarioFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-600 file:mr-2 file:border file:border-slate-300 file:bg-white file:px-2 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-50"
              />
              {comprobanteBancarioFile ? (
                <p className="text-[11px] text-slate-500">{comprobanteBancarioFile.name}</p>
              ) : null}
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

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Valor que salió del banco <span className="font-normal text-slate-400">(opcional)</span>
            </span>
            <CampoMoneda
              value={valorTransferidoRaw}
              onValueChange={(t, d) => {
                setValorTransferidoRaw(t);
                setErrorValorTransferido(d.ok ? null : d.mensaje);
              }}
              placeholder={formatoEdicion(totales.totalSeleccionado)}
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
            {avisoValorTransferido ? (
              <p className="text-[11px] text-amber-600">{avisoValorTransferido.mensaje}</p>
            ) : null}
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              ¿Quién asume el costo de la transferencia
              {costoCanal !== null ? ` (${formatoPesos(costoCanal)})` : ""}?
            </span>
            <select
              value={costoAsumidoPor}
              onChange={(e) => setCostoAsumidoPorManual(e.target.value as CostoAsumidoPor)}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              {opciones.opciones.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {opciones.notaSoloGalcomex ? (
              <p className="text-[11px] text-slate-400">{opciones.notaSoloGalcomex}</p>
            ) : (
              <p className="text-[11px] text-slate-400">
                El costo se registra una sola vez para todo el bloque; el sistema lo calcula según el canal escogido.
              </p>
            )}
          </label>

          {totales.nFacturas > 0 ? (
            <div className="border-t border-slate-200 pt-3 text-right text-sm">
              <span className="font-semibold text-slate-900">
                Total a pagar: {formatoPesos(totales.totalSeleccionado)} · {totales.nFacturas}{" "}
                {totales.nFacturas === 1 ? "factura" : "facturas"} · {totales.nDOs} {totales.nDOs === 1 ? "DO" : "DOs"}
              </span>
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
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || totales.nFacturas === 0}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Registrar pago en bloque
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

/**
 * Alias temporal (nombre de e5cd35b): `seccion-pagos-proveedor.tsx` (P3) y
 * `pagos-workspace.tsx` (P6) lo importan así hasta que migren a
 * `PagoEnBloqueModal`. Mismo componente, mismo comportamiento.
 */
export const PagoMultiDOModal = PagoEnBloqueModal;
export type PagoMultiDOModalProps = PagoEnBloqueModalProps;
