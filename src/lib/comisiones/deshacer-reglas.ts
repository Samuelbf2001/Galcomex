/**
 * M3 (revisión INTEG-B, 29-sep-2026) — cuándo se puede deshacer una
 * liquidación de comisiones (B10). Reglas PURAS (sin BD): las usan el servicio
 * que deshace (`deshacer-liquidacion.ts`) y la lectura de la ficha
 * (`comisionesDeEmpresa`, que muestra u oculta el botón "Deshacer").
 *
 * Lo conservador: solo se deshace mientras el «Otros» no tenga plata ni factura
 * detrás. Con una factura aprobada o emitida, un envío a Siigo, un estado de
 * cobro o movimientos de plata en el servicio, se frena y se dice por qué.
 */

import { EstadoBorrador, EstadoTramite, SiigoEnvioEstado } from "@prisma/client";

export interface BorradorParaDeshacer {
  estado: EstadoBorrador;
  siigoEnvioEstado: SiigoEnvioEstado | null;
  siigoDraftId: string | null;
}

export interface EstadoParaDeshacer {
  /** Estado del «Otros». */
  estado: EstadoTramite;
  borradores: BorradorParaDeshacer[];
  /** Pagos + anticipos aplicados + facturas de proveedor + movimientos de cuenta del «Otros». */
  movimientos: number;
}

/** Estados de borrador que SÍ se pueden descartar (todavía nadie aprobó ni emitió nada). */
export const ESTADOS_BORRADOR_DESCARTABLES: readonly EstadoBorrador[] = [
  EstadoBorrador.BORRADOR,
  EstadoBorrador.EN_REVISION,
];

/** Envío a Siigo que ya dejó (o pudo dejar) un borrador de factura del otro lado. */
const ENVIOS_SIIGO_QUE_BLOQUEAN: readonly SiigoEnvioEstado[] = [
  SiigoEnvioEstado.ENVIANDO,
  SiigoEnvioEstado.ENVIADO,
  SiigoEnvioEstado.INCIERTO,
];

/**
 * El primer motivo por el que NO se puede deshacer (texto para quien opera),
 * o `null` si se puede.
 */
export function impedimentoParaDeshacer(entrada: EstadoParaDeshacer): string | null {
  if (entrada.borradores.some((b) => !ESTADOS_BORRADOR_DESCARTABLES.includes(b.estado))) {
    return "Este servicio ya tiene una factura aprobada o emitida, así que no se puede deshacer. Si la factura solo está aprobada, devuélvela a borrador primero.";
  }
  if (
    entrada.borradores.some(
      (b) =>
        (b.siigoEnvioEstado !== null && ENVIOS_SIIGO_QUE_BLOQUEAN.includes(b.siigoEnvioEstado)) ||
        b.siigoDraftId !== null,
    )
  ) {
    return "Este servicio ya se envió a Siigo (allá puede haber un borrador de factura): anúlalo en Siigo antes de deshacer.";
  }
  if (entrada.estado === EstadoTramite.FACTURADO || entrada.estado === EstadoTramite.PAGADO) {
    return "Este servicio ya está marcado como facturado o pagado, así que no se puede deshacer.";
  }
  if (entrada.movimientos > 0) {
    return "Este servicio ya tiene pagos, anticipos o facturas de proveedor registrados, así que no se puede deshacer desde aquí.";
  }
  return null;
}
