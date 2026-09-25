/**
 * Cartera histórica aparte — Galcomex (D0, carga histórica de plata 2026).
 *
 * La carga histórica (lote HIST-PLATA-2026-09-23) creó las facturas de venta
 * de los trámites históricos con los saldos de Siigo, pero SIN sus cobros
 * (esos van en una carga posterior). Mientras tanto, esas facturas no son
 * deuda confirmada: no deben inflar la cartera vencida ni disparar las
 * alertas de cartera del tablero, y se muestran aparte.
 *
 * Regla: una factura es "cartera histórica" si se cumplen las tres:
 *   1. el parámetro CARTERA_HISTORICA_APARTE es distinto de "NO" (fila
 *      ausente = activo);
 *   2. el trámite de su borrador tiene `esHistorico = true`;
 *   3. no tiene ningún `PagoFactura` con destino CLIENTE (cualquier tipo,
 *      estado o cruce).
 * El primer cobro registrado la saca sola; si ese cobro se anula, vuelve.
 * Con el parámetro en "NO" (Configuración → Parámetros, con AuditLog) todas
 * vuelven a la cartera normal sin deploy.
 *
 * Solo cambia el tablero (vencida, alertas y la sección aparte) y una
 * etiqueta en /cartera. `cruceCliente`, el estado de cuenta PDF, el Excel y
 * la cuenta corriente siguen sumando todas las facturas, igual que Siigo.
 */

import { DestinoPago, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export const CLAVE_CARTERA_HISTORICA_APARTE = "CARTERA_HISTORICA_APARTE";

export const TITULO_CARTERA_HISTORICA = "Cartera histórica 2026 (cobros aún no cargados)";

/** Valor del parámetro → ¿separación activa? Solo "NO" (sin importar mayúsculas ni espacios) la apaga. */
export function interpretarCarteraHistoricaAparte(valor: string | null | undefined): boolean {
  return (valor ?? "").trim().toUpperCase() !== "NO";
}

/** Lee el parámetro. Fila ausente → activa (la intención de D0). */
export async function carteraHistoricaAparte(): Promise<boolean> {
  const fila = await prisma.parametro.findUnique({
    where: { clave: CLAVE_CARTERA_HISTORICA_APARTE },
    select: { valor: true },
  });
  return interpretarCarteraHistoricaAparte(fila?.valor);
}

/** Regla en memoria (sin el parámetro): trámite histórico y ningún pago del CLIENTE. */
export function esFacturaHistoricaSinCobros(f: {
  esHistorico: boolean;
  pagos: ReadonlyArray<{ destino: string }>;
}): boolean {
  return f.esHistorico && !f.pagos.some((p) => p.destino === DestinoPago.CLIENTE);
}

/**
 * La misma regla para Prisma. La cartera corriente es `NOT: whereFacturaHistoricaSinCobros`.
 * Va con AND explícito: `NOT: { AND: [A, B] }` es ¬(A ∧ B). Ojo: `NOT: [A, B]` sería ¬A ∧ ¬B.
 */
export const whereFacturaHistoricaSinCobros = {
  AND: [
    { borrador: { is: { tramite: { is: { esHistorico: true } } } } },
    { pagos: { none: { destino: DestinoPago.CLIENTE } } },
  ],
} satisfies Prisma.FacturaWhereInput;

/** La misma regla en SQL, sobre el alias FIJO `fa` de la tabla `factura`. */
export const SQL_FACTURA_HISTORICA_SIN_COBROS = Prisma.sql`(
  EXISTS (
    SELECT 1
    FROM borrador_factura hb
    JOIN tramite_do ht ON ht.id = hb."tramiteId"
    WHERE hb.id = fa."borradorId" AND ht."esHistorico" = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pago_factura hp
    WHERE hp."facturaId" = fa.id AND hp.destino = ${DestinoPago.CLIENTE}::"DestinoPago"
  )
)`;
