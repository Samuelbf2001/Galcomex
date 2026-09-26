import { EstadoBorrador, EstadoTramite } from "@prisma/client";

/**
 * «Facturado» solo con factura emitida — decisión de Ernesto del 25-sep-2026
 * («Tema 2»): un DO entra a Facturado únicamente si tiene un borrador en
 * FACTURADO (la factura ya salió). «Pagado» se sigue marcando a mano, sin
 * revisar el saldo. El ADMIN puede forzar el paso escribiendo el motivo, y
 * queda un AuditLog `FORZAR_FACTURADO`.
 *
 * Lógica pura, sin BD: el guard vive en `transitionTramite`.
 */

/** Estados de cobro: el DO ya tiene factura (Facturado) o se marcó cobrado (Pagado). */
export const ESTADOS_DE_COBRO: readonly EstadoTramite[] = [
  EstadoTramite.FACTURADO,
  EstadoTramite.PAGADO,
];

/**
 * La regla se exige al entrar a Facturado o Pagado desde un estado anterior a
 * la facturación: así el ADMIN tampoco la salta yendo directo a Pagado (su
 * excepción de checklist salta el mapa de estados). No se vuelve a pedir desde
 * Facturado (Pagado se marca libre) ni desde Cerrado (la reapertura tiene su
 * propio camino). Cerrar no la exige: Cerrado también es «descartar» una
 * solicitud o un DO que no se factura.
 */
export function exigeFacturaEmitida(antes: EstadoTramite, despues: EstadoTramite): boolean {
  return (
    ESTADOS_DE_COBRO.includes(despues) &&
    !ESTADOS_DE_COBRO.includes(antes) &&
    antes !== EstadoTramite.CERRADO
  );
}

export { MOTIVO_FORZAR_MIN, motivoValido } from "@/lib/tramites/motivo-forzar";

const NOMBRE_ESTADO_BORRADOR: Record<EstadoBorrador, string> = {
  BORRADOR: "en borrador",
  EN_REVISION: "en revisión",
  APROBADO: "aprobado, sin enviar a Siigo",
  FACTURADO: "facturado",
};

export type FacturaNoEmitidaDetalles = {
  tramiteId: string;
  consecutivo: string;
  estadoDestino: EstadoTramite;
  /** Estados de los borradores del DO (vacío si no tiene ninguno). */
  borradores: EstadoBorrador[];
  /** true solo para el ADMIN: la UI le ofrece forzar con motivo. */
  puedeForzar: boolean;
};

export class FacturaNoEmitidaError extends Error {
  public readonly status = 422;
  public readonly codigo = "FACTURA_NO_EMITIDA" as const;
  public readonly detalles: FacturaNoEmitidaDetalles;

  constructor(detalles: FacturaNoEmitidaDetalles) {
    const estadoBorradores =
      detalles.borradores.length === 0
        ? "todavía no tiene borrador de factura"
        : `su borrador está ${[...new Set(detalles.borradores)].map((e) => NOMBRE_ESTADO_BORRADOR[e]).join(" y ")}`;
    super(
      `El ${detalles.consecutivo} no tiene factura emitida: ${estadoBorradores}. ` +
        "Pasa a Facturado cuando su factura salga (borrador en Facturado).",
    );
    this.name = "FacturaNoEmitidaError";
    this.detalles = detalles;
  }
}
