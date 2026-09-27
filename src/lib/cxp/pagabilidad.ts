/**
 * Pagabilidad de una factura de proveedor — PURO (diseño §B.6, RF-06).
 *
 * UNA sola función decide si una factura se puede pagar: la usan la lista de
 * "Pagar en bloque" (`listarFacturasElegiblesMultiDO`), la ficha del
 * proveedor y `aplicarSaldo` al registrar. Así lo que la pantalla ofrece y lo
 * que el servidor acepta nunca se contradicen.
 *
 * El dato `exigeAnticipo` lo calcula `exigeAnticipoDelDo` (P1,
 * `pagabilidad-bd.ts`): capacidades `anticipos_cliente && pago_exige_anticipo`
 * del cliente del DO.
 */

import type { EstadoTramite } from "@prisma/client";

import { doCorto, formatoPesos } from "@/lib/cxp/saldos";

export type MotivoNoPagable =
  | { codigo: "SIN_SALDO"; mensaje: string }
  | { codigo: "DO_CERRADO"; mensaje: string }
  | { codigo: "SIN_ANTICIPO"; mensaje: string }
  | { codigo: "SIN_PROVEEDOR"; mensaje: string };

export type AdvertenciaPago =
  | { codigo: "ANTICIPO_INSUFICIENTE"; tramiteId: string; consecutivo: string; faltante: bigint; mensaje: string }
  | { codigo: "ANTICIPO_SIN_VERIFICAR"; tramiteId: string; consecutivo: string; mensaje: string }
  | { codigo: "VALOR_TRANSFERIDO_DISTINTO"; diferencia: bigint; mensaje: string }
  | { codigo: "COSTO_NO_COBRABLE"; tramiteId: string; consecutivo: string; mensaje: string };

export interface EntradaPagabilidad {
  saldo: bigint;
  tramiteEstado: EstadoTramite;
  /** Consecutivo del DO ("DO.BAQ26-0238"). */
  consecutivo: string;
  clienteNombre: string;
  /** `exigeAnticipoDelDo`: anticipos_cliente && pago_exige_anticipo. */
  exigeAnticipo: boolean;
  tieneAnticipoAplicado: boolean;
  /** false = costo propio que no se le cobra al cliente: no exige anticipo. */
  repercutible: boolean;
  tieneProveedor: boolean;
  /** Registro histórico de conciliación (P7): no exige anticipo. */
  esHistorico?: boolean;
}

/**
 * Orden de los motivos (el primero que aplica): sin saldo → DO cerrado →
 * sin proveedor → sin anticipo. Los mensajes son los textos grises de la
 * lista de pendientes (§D.1).
 */
export function evaluarPagabilidad(i: EntradaPagabilidad): { pagable: boolean; motivo: MotivoNoPagable | null } {
  if (i.saldo <= 0n) {
    return { pagable: false, motivo: { codigo: "SIN_SALDO", mensaje: "Pagada" } };
  }
  if (i.tramiteEstado === "CERRADO") {
    return { pagable: false, motivo: { codigo: "DO_CERRADO", mensaje: "DO cerrado" } };
  }
  if (!i.tieneProveedor) {
    return { pagable: false, motivo: { codigo: "SIN_PROVEEDOR", mensaje: "Falta el proveedor" } };
  }
  if (i.exigeAnticipo && !i.tieneAnticipoAplicado && i.repercutible && !i.esHistorico) {
    return {
      pagable: false,
      motivo: {
        codigo: "SIN_ANTICIPO",
        mensaje: `Sin anticipo aplicado (función encendida para ${i.clienteNombre})`,
      },
    };
  }
  return { pagable: true, motivo: null };
}

// ─── Advertencias (no bloquean) ──────────────────────────────────────────────

/** "El DO 26-0238 queda en −$161.377: Galcomex pone la diferencia." (`saldoDespues` < 0). */
export function advertenciaAnticipoInsuficiente(i: {
  tramiteId: string;
  consecutivo: string;
  anio: number;
  numero: number;
  saldoDespues: bigint;
}): AdvertenciaPago | null {
  if (i.saldoDespues >= 0n) return null;
  return {
    codigo: "ANTICIPO_INSUFICIENTE",
    tramiteId: i.tramiteId,
    consecutivo: i.consecutivo,
    faltante: -i.saldoDespues,
    mensaje: `El DO ${doCorto(i.anio, i.numero)} queda en ${formatoPesos(i.saldoDespues)}: Galcomex pone la diferencia.`,
  };
}

/** "El anticipo del DO 26-0255 aún no está verificado por el banco." */
export function advertenciaAnticipoSinVerificar(i: {
  tramiteId: string;
  consecutivo: string;
  anio: number;
  numero: number;
}): AdvertenciaPago {
  return {
    codigo: "ANTICIPO_SIN_VERIFICAR",
    tramiteId: i.tramiteId,
    consecutivo: i.consecutivo,
    mensaje: `El anticipo del DO ${doCorto(i.anio, i.numero)} aún no está verificado por el banco.`,
  };
}

/** "No coincide con lo que salió del banco ($X): revisa antes de guardar." (D-2, R18). null si cuadra o no se informó. */
export function advertenciaValorTransferido(
  valorTransferido: bigint | null | undefined,
  totalAplicado: bigint,
): AdvertenciaPago | null {
  if (valorTransferido === null || valorTransferido === undefined || valorTransferido === totalAplicado) {
    return null;
  }
  return {
    codigo: "VALOR_TRANSFERIDO_DISTINTO",
    diferencia: valorTransferido - totalAplicado,
    mensaje: `No coincide con lo que salió del banco (${formatoPesos(valorTransferido)}): revisa antes de guardar.`,
  };
}

/**
 * "El DO {26-0238} ya tiene la factura de venta {aprobada/facturada}: este costo
 * ya no se le puede cobrar" (D-1). Solo cuando el costo del bloque le toca a un
 * DO cuyo borrador ya está APROBADO/FACTURADO.
 */
export function advertenciaCostoNoCobrable(i: {
  tramiteId: string;
  consecutivo: string;
  anio: number;
  numero: number;
  estadoBorrador: "APROBADO" | "FACTURADO";
}): AdvertenciaPago {
  return {
    codigo: "COSTO_NO_COBRABLE",
    tramiteId: i.tramiteId,
    consecutivo: i.consecutivo,
    mensaje: `El DO ${doCorto(i.anio, i.numero)} ya tiene la factura de venta ${i.estadoBorrador === "APROBADO" ? "aprobada" : "facturada"}: este costo ya no se le puede cobrar.`,
  };
}
