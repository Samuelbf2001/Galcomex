/**
 * Recálculo del total del borrador a partir de las líneas.
 *
 * Las líneas (AUTO de pagos + fijas 4x1000 y costos bancarios + manuales)
 * son la fuente de verdad para `totalFactura`. Aplica a todos los borradores
 * — PROPIO y SOCIO_LM — porque con montoLM=0 y retenciones=0 el resultado
 * coincide al peso con el motor (`calcularBorrador`), y al permitir editar
 * líneas a mano queremos que la edición propague al total y a los saldos.
 *
 * Debe ejecutarse dentro de una transacción; si compite con otra edición
 * sobre el mismo borrador, el caller debe tomar el advisory lock antes.
 */

import { Prisma } from "@prisma/client";

import { calcularSaldosPorLineas } from "@/lib/calculations/total-lineas";

type Tx = Prisma.TransactionClient;

export async function recalcularTotalBorrador(tx: Tx, borradorId: string): Promise<void> {
  // findUniqueOrThrow: el caller siempre acaba de cargar/crear el borrador en la
  // misma transacción, así que la ausencia es un invariante incumplido (no un
  // error de usuario).
  const borrador = await tx.borradorFactura.findUniqueOrThrow({
    where: { id: borradorId },
    select: {
      comision: true,
      ivaComision: true,
      retenciones: true,
      totalAnticipo: true,
      saldoAFavorLM: true,
      lineasRevision: { select: { valor: true } },
    },
  });

  const calc = calcularSaldosPorLineas({
    lineas: borrador.lineasRevision,
    comision: borrador.comision,
    ivaComision: borrador.ivaComision,
    retenciones: borrador.retenciones,
    totalAnticipo: borrador.totalAnticipo,
    montoLM: borrador.saldoAFavorLM,
  });

  await tx.borradorFactura.update({
    where: { id: borradorId },
    data: {
      totalFacturaLineas: calc.totalFacturaLineas,
      totalFactura: calc.totalFactura,
      saldoAFavorCliente: calc.saldoAFavorCliente,
      saldoACargoCliente: calc.saldoACargoCliente,
      saldoAFavorLM: calc.saldoAFavorLM,
      saldoACargoLM: calc.saldoACargoLM,
    },
  });
}
