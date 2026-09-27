/**
 * Con qué se factura un DO de flujo corto (servicio suelto: OTRO — Plan
 * Vallejo, sellos, coordinación logística; decisión de Ernesto 26-sep-2026).
 *
 * Es la MISMA condición para los tres puntos de entrada a ENVIADO_A_FACTURAR:
 * `generarBorrador`, `solicitarFacturacion` y `transitionTramite` (atajo de
 * estados). Ninguno de los tres factura nunca con el valor o el concepto por
 * defecto (`params.comisionDefault`, "SERVICIO LOGÍSTICO"): sin datos reales
 * no hay factura.
 *
 *   1. La empresa debe facturar en formato CONCEPTOS_IVA (función
 *      `factura_conceptos_iva`). Sin ella (incluidas las empresas SOCIO_LM,
 *      que facturan por comisión) → 422 `FORMATO_CONCEPTOS_REQUERIDO`.
 *   2. Con eso, o bien (a) el DO trae `valorServicio` Y `conceptoServicioCodigo`
 *      escritos a mano, o (b) hay una tarifa vigente de la línea del tipo con
 *      líneas calculadas y SIN pendientes (`propuestaParaTramite` con
 *      `lineas.length > 0` y `pendientes.length === 0`) — con pendientes
 *      (p. ej. un ítem por contenedor y el DO no tiene contenedores) se
 *      corta con `TarifaIncompletaError`, igual que IMPORTACION: nunca se
 *      factura solo lo que sí se pudo calcular, en silencio.
 *   3. Sin ninguno de los dos → 422 `VALOR_SERVICIO_REQUERIDO`.
 */

import { FORMATO_CONCEPTOS_IVA, formatoFacturaDeEmpresa } from "@/lib/borradores/formato-conceptos";
import { propuestaParaTramite, TarifaIncompletaError, type PropuestaTarifa } from "@/lib/tarifas/service";

export class ValorServicioRequeridoError extends Error {
  public readonly status = 422;
  public readonly codigo = "VALOR_SERVICIO_REQUERIDO" as const;
  constructor() {
    super("Escribe el servicio, el concepto y el valor antes de mandarlo a facturar.");
    this.name = "ValorServicioRequeridoError";
  }
}

export class FormatoConceptosRequeridoError extends Error {
  public readonly status = 422;
  public readonly codigo = "FORMATO_CONCEPTOS_REQUERIDO" as const;
  constructor() {
    super(
      "Esta empresa todavía no puede facturar servicios sueltos desde la plataforma: factura con el formato de comisión. Avísale al administrador.",
    );
    this.name = "FormatoConceptosRequeridoError";
  }
}

export type DatosFlujoCorto = {
  clienteId: string;
  valorServicio: bigint | null;
  conceptoServicioCodigo: string | null;
  tipoTramite: { flujoCorto: boolean; lineaServicio: string };
};

export type ResultadoFacturableFlujoCorto =
  | { ok: true; modo: "VALOR" }
  | { ok: true; modo: "TARIFA"; propuesta: PropuestaTarifa }
  | { ok: false; error: FormatoConceptosRequeridoError | ValorServicioRequeridoError | TarifaIncompletaError };

/**
 * Resuelve si (y con qué) se puede facturar un DO de flujo corto. No hace
 * nada (no aplica) si el tipo no es `flujoCorto`: las demás reglas de
 * tarifario/comisión de siempre siguen intactas para IMPORTACION/CLASIFICACION.
 */
export async function resolverFacturableFlujoCorto(
  tramite: DatosFlujoCorto,
  tramiteId: string,
): Promise<ResultadoFacturableFlujoCorto | null> {
  if (!tramite.tipoTramite.flujoCorto) return null;

  const formato = await formatoFacturaDeEmpresa(tramite.clienteId);
  if (formato.formato !== FORMATO_CONCEPTOS_IVA) {
    return { ok: false, error: new FormatoConceptosRequeridoError() };
  }

  if (tramite.valorServicio !== null && tramite.conceptoServicioCodigo) {
    return { ok: true, modo: "VALOR" };
  }

  const propuesta = await propuestaParaTramite(tramiteId);
  if (propuesta.tarifario && propuesta.resultado) {
    if (propuesta.resultado.pendientes.length > 0) {
      return { ok: false, error: new TarifaIncompletaError(propuesta.resultado.pendientes) };
    }
    if (propuesta.resultado.lineas.length > 0) {
      return { ok: true, modo: "TARIFA", propuesta };
    }
  }

  return { ok: false, error: new ValorServicioRequeridoError() };
}
