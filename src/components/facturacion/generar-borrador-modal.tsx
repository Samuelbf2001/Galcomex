"use client";

import { AlertTriangle, ExternalLink, Loader2, Plus, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchCapacidades } from "@/components/clientes/capacidades-api";
import {
  type BorradorRow,
  type TramiteParaFacturacion,
  FacturacionApiError,
  formatCOP,
  generarBorrador,
  parseBigIntInput,
} from "@/components/facturacion/facturacion-api";
import {
  fetchPropuestaTarifa,
  type CausaPendienteRow,
  type PendienteTarifaRow,
  type PropuestaTarifaRow,
} from "@/components/tramites/eventos-api";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { rutaCliente, rutaTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";

/** Comisión que se propone por defecto a las empresas SIN tarifario propio. */
export const COMISION_POR_DEFECTO = "150000";

/**
 * Cómo se va a calcular la comisión según la propuesta del tarifario. Replica
 * la regla de `generarBorrador` (bloque "Tarifario propio (M2)"):
 *
 * - `TARIFARIO`: hay tarifario vigente con líneas o pendientes. El modal manda
 *   `usarTarifario` + el `tarifarioId` que el revisor vio; si el servidor ya no
 *   puede aplicarlo responde 409 (nunca cae a la comisión por defecto).
 * - `SIN_VIGENTE`: la empresa tiene la función pero no hay tarifario vigente
 *   (o no propone líneas): la comisión se escribe a mano, sin valor por defecto.
 * - `SIN_TARIFARIO`: la empresa no factura por tarifario; comportamiento de
 *   siempre (comisión por defecto 150.000).
 */
export type ModoComision = "TARIFARIO" | "SIN_VIGENTE" | "SIN_TARIFARIO";

export function modoComisionDe(propuesta: PropuestaTarifaRow): ModoComision {
  const r = propuesta.resultado;
  if (propuesta.tarifario && r && (r.lineas.length > 0 || r.pendientes.length > 0)) {
    return "TARIFARIO";
  }
  if (propuesta.tarifarioPropio || propuesta.tarifario) return "SIN_VIGENTE";
  return "SIN_TARIFARIO";
}

type EnlacePendiente = { texto: string; href: string };

/**
 * Pendientes del tarifario agrupados por dónde se arreglan (hallazgo 4): la
 * base de cálculo del DO, un pago o factura de proveedor, o el tarifario.
 */
export function gruposDePendientes(
  pendientes: PendienteTarifaRow[],
  tramite: Pick<TramiteParaFacturacion, "id" | "cliente">,
): { causa: CausaPendienteRow; pendientes: PendienteTarifaRow[]; enlaces: EnlacePendiente[] }[] {
  const enlaces: Record<CausaPendienteRow, EnlacePendiente[]> = {
    BASE_DO: [{ texto: "Completar la base de cálculo del DO", href: rutaTramite(tramite.id, "resumen") }],
    COSTO_PROVEEDOR: [
      { texto: "Registrar el pago", href: rutaTramite(tramite.id, "pagos") },
      { texto: "Registrar la factura del proveedor", href: rutaTramite(tramite.id, "facturas-proveedor") },
    ],
    TARIFARIO: [
      { texto: "Corregir el tarifario de la empresa", href: `${rutaCliente(tramite.cliente.id)}?abrir=tarifas` },
    ],
  };
  const orden: CausaPendienteRow[] = ["BASE_DO", "COSTO_PROVEEDOR", "TARIFARIO"];
  return orden
    .map((causa) => ({
      causa,
      pendientes: pendientes.filter((p) => (p.causa ?? "BASE_DO") === causa),
      enlaces: enlaces[causa],
    }))
    .filter((g) => g.pendientes.length > 0);
}

type EstadoPropuesta =
  | { tipo: "cargando" }
  /**
   * Falló la consulta. `tarifarioPropio` sale de las funciones de la empresa
   * (consulta aparte): `false` → se propone 150.000 como siempre (Lucho);
   * `true` o `null` (tampoco se supo) → comisión vacía.
   */
  | { tipo: "error"; mensaje: string; tarifarioPropio: boolean | null }
  | { tipo: "lista"; propuesta: PropuestaTarifaRow; modo: ModoComision };

type ConceptoRow = { id: string; concepto: string; valorRaw: string };

const INPUT =
  "h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600";

const BOTON_SECUNDARIO =
  "inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50";

function formatoPesos(valor: bigint): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 0,
  }).format(Number(valor));
}

/** ¿La empresa tiene encendida la función `tarifario_propio`? `null` si no se pudo saber. */
async function consultarTarifarioPropio(clienteId: string, signal: AbortSignal): Promise<boolean | null> {
  try {
    const capacidades = await fetchCapacidades(clienteId, signal);
    const capacidad = capacidades.find((c) => c.codigo === "tarifario_propio");
    return capacidad ? capacidad.habilitado : null;
  } catch {
    return null;
  }
}

export type GenerarBorradorModalProps = {
  tramite: TramiteParaFacturacion;
  onClose: () => void;
  onGenerado: (borrador: BorradorRow) => void;
};

export function GenerarBorradorModal({ tramite, onClose, onGenerado }: GenerarBorradorModalProps) {
  const { toast } = useToast();
  const [estadoPropuesta, setEstadoPropuesta] = useState<EstadoPropuesta>({ tipo: "cargando" });
  const [recargar, setRecargar] = useState(0);
  /** El usuario eligió escribir la comisión a mano en vez de usar el tarifario. */
  const [manual, setManual] = useState(false);
  /** Confirmación explícita de facturar sin los valores del tarifario (hallazgo 3). */
  const [confirmaSinTarifario, setConfirmaSinTarifario] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** El servidor respondió que el tarifario ya no aplica (409): ofrecer reconsultar. */
  const [tarifarioCambio, setTarifarioCambio] = useState(false);
  const [comisionRaw, setComisionRaw] = useState("");
  const [montoLMRaw, setMontoLMRaw] = useState("");
  const [retencionesRaw, setRetencionesRaw] = useState("0");
  const [usarConceptos, setUsarConceptos] = useState(false);
  const [conceptos, setConceptos] = useState<ConceptoRow[]>([
    { id: "1", concepto: "", valorRaw: "" },
  ]);

  useEffect(() => {
    const controller = new AbortController();
    fetchPropuestaTarifa(tramite.id, controller.signal)
      .then((propuesta) => {
        if (controller.signal.aborted) return;
        const modo = modoComisionDe(propuesta);
        setEstadoPropuesta({ tipo: "lista", propuesta, modo });
        // Solo quien NO factura por tarifario arranca con la comisión fija de
        // siempre; a una empresa con tarifario nunca se le propone 150.000.
        setComisionRaw(modo === "SIN_TARIFARIO" ? COMISION_POR_DEFECTO : "");
      })
      .catch(async (caught: unknown) => {
        if (controller.signal.aborted) return;
        const mensaje = describirError(caught, "No se pudo consultar el tarifario de la empresa.");
        const tarifarioPropio = await consultarTarifarioPropio(tramite.cliente.id, controller.signal);
        if (controller.signal.aborted) return;
        setEstadoPropuesta({ tipo: "error", mensaje, tarifarioPropio });
      });
    return () => controller.abort();
  }, [tramite.id, tramite.cliente.id, recargar]);

  const reintentar = useCallback(() => {
    setManual(false);
    setConfirmaSinTarifario(false);
    setError(null);
    setTarifarioCambio(false);
    setEstadoPropuesta({ tipo: "cargando" });
    setRecargar((n) => n + 1);
  }, []);

  const propuesta = estadoPropuesta.tipo === "lista" ? estadoPropuesta.propuesta : null;
  const modo = estadoPropuesta.tipo === "lista" ? estadoPropuesta.modo : null;
  /** Falló la consulta y la empresa NO factura por tarifario: 150.000 como siempre. */
  const errorSinTarifarioPropio =
    estadoPropuesta.tipo === "error" && estadoPropuesta.tarifarioPropio === false;
  /** Se genera con el tarifario: el POST va con `usarTarifario` y sin comisión. */
  const conTarifario = modo === "TARIFARIO" && !manual;
  /** Se muestra el formulario de comisión a mano (el de siempre). */
  const conComisionManual = modo === "SIN_TARIFARIO" || modo === "SIN_VIGENTE" || manual;
  /**
   * Comisión a mano en lugar de una propuesta del tarifario, o sin haber podido
   * consultarlo en una empresa que factura (o podría facturar) por tarifario:
   * exige confirmación. Solo la empresa que seguro NO tiene tarifario propio
   * escribe a mano sin confirmar.
   */
  const manualSobreTarifario =
    manual &&
    (modo === "TARIFARIO" || (estadoPropuesta.tipo === "error" && estadoPropuesta.tarifarioPropio !== false));
  /** Con la comisión por defecto de siempre (empresas sin tarifario propio). */
  const conComisionPorDefecto = modo === "SIN_TARIFARIO" || (manual && errorSinTarifarioPropio);
  const pendientesTarifa = modo === "TARIFARIO" ? (propuesta?.resultado?.pendientes ?? []) : [];
  /** Los pendientes solo bloquean cuando se genera con el tarifario. */
  const pendientesBloquean = conTarifario && pendientesTarifa.length > 0;
  const manuales = propuesta?.resultado?.manuales ?? [];
  const soloManuales =
    modo === "SIN_VIGENTE" &&
    Boolean(propuesta?.tarifario) &&
    (propuesta?.resultado?.lineas.length ?? 0) === 0 &&
    manuales.length > 0;

  function usarComisionManual() {
    setManual(true);
    setConfirmaSinTarifario(false);
    setComisionRaw(errorSinTarifarioPropio ? COMISION_POR_DEFECTO : "");
    setError(null);
    setTarifarioCambio(false);
  }

  function volverAlTarifario() {
    setManual(false);
    setConfirmaSinTarifario(false);
    setUsarConceptos(false);
    setError(null);
  }

  // Valida que la suma de conceptos = comisión
  function getConceptosError(): string | null {
    if (!conComisionManual || !usarConceptos) return null;
    const comisionBig = parseBigIntInput(comisionRaw);
    if (!comisionBig) return null;
    let suma = 0n;
    for (const c of conceptos) {
      const v = parseBigIntInput(c.valorRaw);
      if (!v) return "Todos los conceptos deben tener un valor válido.";
      suma += BigInt(v);
    }
    if (suma !== BigInt(comisionBig)) {
      return `La suma de conceptos (${formatoPesos(suma)}) debe igualar la comisión (${formatoPesos(BigInt(comisionBig))}).`;
    }
    return null;
  }

  function addConcepto() {
    setConceptos((prev) => [...prev, { id: String(Date.now()), concepto: "", valorRaw: "" }]);
  }

  function removeConcepto(id: string) {
    setConceptos((prev) => prev.filter((c) => c.id !== id));
  }

  function updateConcepto(id: string, field: "concepto" | "valorRaw", value: string) {
    setConceptos((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setTarifarioCambio(false);
    if (!conTarifario && !conComisionManual) return;
    if (pendientesBloquean) {
      setError("Completa lo que falta del tarifario antes de generar el borrador.");
      return;
    }
    let comisionBig: string | undefined;
    let conceptosPayload: { concepto: string; valor: string }[] | undefined;
    if (conComisionManual) {
      const parsed = parseBigIntInput(comisionRaw);
      if (!parsed || BigInt(parsed) <= 0n) {
        setError("Escribe la comisión: un número entero mayor que 0.");
        return;
      }
      comisionBig = parsed;
      const conceptosErr = getConceptosError();
      if (conceptosErr) {
        setError(conceptosErr);
        return;
      }
      conceptosPayload =
        usarConceptos && conceptos.length > 0
          ? conceptos
              .filter((c) => c.concepto.trim() && parseBigIntInput(c.valorRaw))
              .map((c) => ({ concepto: c.concepto.trim(), valor: parseBigIntInput(c.valorRaw)! }))
          : undefined;
    }

    // Al final: primero que la comisión esté bien escrita, luego la confirmación.
    if (manualSobreTarifario && !confirmaSinTarifario) {
      setError("Confirma que vas a facturar sin los valores del tarifario.");
      return;
    }

    const montoLMBig = montoLMRaw.trim() ? parseBigIntInput(montoLMRaw) : null;
    const retencionesBig = retencionesRaw.trim() ? parseBigIntInput(retencionesRaw) : null;

    setSubmitting(true);
    try {
      // Con tarifario NO se manda comisión ni conceptos: se pide el tarifario
      // que el revisor vio. Si el servidor ya no puede aplicarlo, 409.
      const borrador = await generarBorrador(tramite.id, {
        comision: comisionBig,
        montoLM: montoLMBig ?? undefined,
        retenciones: retencionesBig ?? undefined,
        conceptosOperacionales: conceptosPayload,
        ...(conTarifario && propuesta?.tarifario
          ? {
              usarTarifario: true,
              tarifarioId: propuesta.tarifario.id,
              // El total que vio el revisor: si al generar da otro, 409.
              ...(propuesta.resultado ? { totalTarifario: propuesta.resultado.total } : {}),
            }
          : {}),
      });
      toast({
        title: "Borrador generado",
        description: `${tramite.consecutivo} · ${formatCOP(borrador.totalFactura)}`,
        variant: "success",
      });
      onGenerado(borrador);
    } catch (caught) {
      setError(
        caught instanceof FacturacionApiError
          ? caught.message
          : describirError(caught, "Error al generar el borrador."),
      );
      setTarifarioCambio(conTarifario && caught instanceof FacturacionApiError && caught.status === 409);
    } finally {
      setSubmitting(false);
    }
  }

  const conceptosErr = getConceptosError();
  const puedeEnviar =
    !submitting &&
    (conTarifario ? !pendientesBloquean : conComisionManual) &&
    !(manualSobreTarifario && !confirmaSinTarifario) &&
    !(usarConceptos && Boolean(conceptosErr));

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Generar borrador"
      description={tramite.consecutivo}
      size="md"
      dismissible={!submitting}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          El sistema calculará automáticamente el 4×1000, IVA, costos bancarios
          y saldos desde los pagos registrados en el trámite.
        </p>

        {estadoPropuesta.tipo === "cargando" ? (
          <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Consultando el tarifario de la empresa…
          </p>
        ) : null}

        {estadoPropuesta.tipo === "error" && !manual ? (
          <div className="space-y-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                No se pudo consultar el tarifario de la empresa: {estadoPropuesta.mensaje} Sin
                esa consulta no se sabe si este trámite se factura con tarifario.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={reintentar}
                className="inline-flex h-8 items-center gap-1 border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-700 hover:bg-rose-100"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Reintentar
              </button>
              <button type="button" onClick={usarComisionManual} className={BOTON_SECUNDARIO}>
                Escribir la comisión a mano
              </button>
            </div>
          </div>
        ) : null}

        {/* Comisión a mano tras fallar la consulta: se puede volver a intentar (hallazgo 6) */}
        {estadoPropuesta.tipo === "error" && manual ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <span>
              {errorSinTarifarioPropio
                ? "La empresa no factura por tarifario: se propone la comisión de siempre."
                : "Vas a escribir la comisión a mano sin haber visto el tarifario de la empresa."}
            </span>
            <button type="button" onClick={reintentar} className={BOTON_SECUNDARIO}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Volver a intentar con el tarifario
            </button>
          </div>
        ) : null}

        {/* ── Propuesta del tarifario (visible también en modo manual) ────── */}
        {modo === "TARIFARIO" && propuesta?.tarifario && propuesta.resultado ? (
          <section
            className={`space-y-2 border p-3 ${manual ? "border-slate-200 bg-slate-50" : "border-cyan-200 bg-cyan-50/40"}`}
            aria-label="Propuesta del tarifario"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                Tarifario {propuesta.tarifario.nombre} v{propuesta.tarifario.version}
                {manual ? <span className="font-normal text-slate-500"> — no se usará</span> : null}
              </p>
              <span className="text-xs text-slate-500">Valores sin IVA</span>
            </div>
            {propuesta.resultado.lineas.length > 0 ? (
              <table className="w-full text-sm">
                <tbody>
                  {propuesta.resultado.lineas.map((l, i) => (
                    <tr key={`${l.concepto}-${i}`} className="border-t border-cyan-100 align-top">
                      <td className="py-1.5 pr-2">
                        <span className="text-slate-800">{l.nombrePublico}</span>
                        {l.detalle ? (
                          <span className="block text-xs text-slate-500">{l.detalle}</span>
                        ) : null}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-900">{formatCOP(l.valor)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-cyan-300 font-semibold">
                    <td className="py-1.5 pr-2 text-slate-900">Total del tarifario</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-900" data-testid="total-tarifario">
                      {formatCOP(propuesta.resultado.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            {pendientesTarifa.length > 0 ? (
              <div
                className="space-y-1.5 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                role="alert"
                data-testid="pendientes-tarifario"
              >
                <p className="flex items-start gap-2 font-semibold">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Faltan datos para calcular {pendientesTarifa.length === 1 ? "un concepto" : `${pendientesTarifa.length} conceptos`} del tarifario
                </p>
                {gruposDePendientes(pendientesTarifa, tramite).map((grupo) => (
                  <div key={grupo.causa} className="space-y-0.5" data-causa={grupo.causa}>
                    <ul className="ml-6 list-disc space-y-0.5">
                      {grupo.pendientes.map((p, i) => (
                        <li key={`${p.concepto}-${i}`}>
                          <strong>{p.nombrePublico}:</strong> {p.motivo}
                        </li>
                      ))}
                    </ul>
                    <p className="ml-6 flex flex-wrap gap-x-3">
                      {grupo.enlaces.map((enlace) => (
                        <Link
                          key={enlace.href}
                          href={enlace.href}
                          className="inline-flex items-center gap-1 font-semibold text-cyan-800 underline"
                        >
                          {enlace.texto}
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </Link>
                      ))}
                    </p>
                  </div>
                ))}
                <p>
                  {manual
                    ? "Si facturas a mano, estos conceptos no quedan en la factura."
                    : "No se genera el borrador con el tarifario para no facturar de menos."}
                </p>
              </div>
            ) : null}

            {manuales.length > 0 ? (
              <p className="text-xs text-slate-500" data-testid="manuales-tarifario">
                A mano, si aplica: {manuales.map((m) => m.nombrePublico).join(", ")}. Se agregan en
                el borrador después de generarlo.
              </p>
            ) : null}

            {!manual ? (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <p className="text-xs text-slate-500">
                  El borrador sale con estas líneas y sus productos Siigo.
                </p>
                <button
                  type="button"
                  onClick={usarComisionManual}
                  className="h-8 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Usar otra comisión
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Empresa con tarifario propio pero sin tarifario aplicable */}
        {modo === "SIN_VIGENTE" && !manual ? (
          <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {soloManuales && propuesta?.tarifario
                  ? `El tarifario ${propuesta.tarifario.nombre} v${propuesta.tarifario.version} solo tiene conceptos que se cobran a mano (${manuales.map((m) => m.nombrePublico).join(", ")}).`
                  : propuesta?.tarifario
                    ? `El tarifario ${propuesta.tarifario.nombre} v${propuesta.tarifario.version} no propone líneas para este trámite.`
                    : (propuesta?.motivo ?? "La empresa no tiene un tarifario vigente.")}{" "}
                Escribe la comisión a mano o{" "}
                <Link
                  href={`${rutaCliente(tramite.cliente.id)}?abrir=tarifas`}
                  className="font-semibold text-cyan-800 underline"
                >
                  revisa el tarifario de la empresa
                </Link>
                .
              </span>
            </p>
          </div>
        ) : null}

        {manualSobreTarifario ? (
          <div className="space-y-2 border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Vas a facturar con una comisión escrita a mano, sin los valores del tarifario.</span>
              {modo === "TARIFARIO" ? (
                <button
                  type="button"
                  onClick={volverAlTarifario}
                  className="h-8 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Volver al tarifario
                </button>
              ) : null}
            </div>
            <label className="flex cursor-pointer items-center gap-2 font-medium text-slate-900">
              <input
                type="checkbox"
                checked={confirmaSinTarifario}
                onChange={(e) => setConfirmaSinTarifario(e.target.checked)}
                className="h-4 w-4"
                data-testid="confirma-sin-tarifario"
              />
              Voy a facturar sin los valores del tarifario
            </label>
          </div>
        ) : null}

        {/* ── Comisión a mano (flujo de siempre) ──────────────────────────── */}
        {conComisionManual ? (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Comisión Galcomex/LM (COP) *</span>
            <CampoMoneda
              value={comisionRaw}
              onValueChange={setComisionRaw}
              placeholder={conComisionPorDefecto ? "150000" : "Valor de la comisión"}
              required
              aria-label="Comisión Galcomex/LM (COP)"
              className={INPUT}
            />
            {conComisionPorDefecto ? (
              <span className="text-xs text-slate-500">Default: $150.000</span>
            ) : null}
          </label>
        ) : null}

        {estadoPropuesta.tipo === "lista" || manual ? (
          <>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Monto LM (COP) — opcional</span>
              <CampoMoneda
                value={montoLMRaw}
                onValueChange={setMontoLMRaw}
                placeholder="0"
                className={INPUT}
              />
              <span className="text-xs text-slate-500">
                Monto atribuible al socio LM. Dejar vacío si no aplica.
              </span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Retenciones (COP)</span>
              <CampoMoneda
                value={retencionesRaw}
                onValueChange={setRetencionesRaw}
                placeholder="0"
                className={INPUT}
              />
              <span className="text-xs text-slate-500">
                RETE IVA + RETE FTE + RETE ICA. Dejar en 0 si no aplica.
              </span>
            </label>
          </>
        ) : null}

        {/* Desglose de conceptos operacionales (solo con comisión a mano) */}
        {conComisionManual ? (
          <div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={usarConceptos}
                onChange={(e) => setUsarConceptos(e.target.checked)}
                className="h-4 w-4"
                data-testid="usar-conceptos"
              />
              <span className="text-sm font-medium text-slate-700">
                Desglosar conceptos operacionales
              </span>
            </label>
            <p className="mt-0.5 ml-6 text-xs text-slate-500">
              Ej: Revisión documentos + Sistematización + Logística operativa (suma = comisión)
            </p>
          </div>
        ) : null}

        {conComisionManual && usarConceptos ? (
          <div className="space-y-2 border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-600">Conceptos operacionales</p>
            {conceptos.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <input
                  value={c.concepto}
                  onChange={(e) => updateConcepto(c.id, "concepto", e.target.value)}
                  placeholder="Nombre del concepto"
                  className="h-8 flex-1 border border-slate-300 px-2 text-xs outline-none focus:border-cyan-600"
                />
                <CampoMoneda
                  value={c.valorRaw}
                  onValueChange={(digitos) => updateConcepto(c.id, "valorRaw", digitos)}
                  placeholder="Valor"
                  wrapperClassName="w-28"
                  className="h-8 w-full border border-slate-300 px-2 text-right text-xs outline-none focus:border-cyan-600"
                />
                {conceptos.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeConcepto(c.id)}
                    className="inline-flex h-8 w-8 items-center justify-center text-slate-500 hover:text-rose-600"
                    aria-label="Eliminar concepto"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={addConcepto}
              className="inline-flex h-7 items-center gap-1 border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:bg-slate-100"
            >
              <Plus className="h-3.5 w-3.5" />
              Agregar concepto
            </button>
            {conceptosErr && !error ? (
              <p className="text-xs text-rose-600">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {conceptosErr}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="space-y-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
            {tarifarioCambio ? (
              <button type="button" onClick={reintentar} className={BOTON_SECUNDARIO}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Volver a consultar el tarifario
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!puedeEnviar}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {conTarifario ? "Generar con el tarifario" : "Generar borrador"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
