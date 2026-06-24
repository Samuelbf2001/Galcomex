/**
 * Recálculo del total del borrador a partir de las líneas.
 *
 * Las `LineaRevision` (manuales + fijas COMISION/IVA_COMISION/COSTOS_BANCARIOS/
 * IMPUESTO_4X1000) son la fuente de verdad para `totalFactura` y los saldos.
 *
 *   totalFacturaLineas = Σ lineasRevision.valor − retenciones
 *
 * Los campos sueltos `borrador.comision`, `ivaComision`, `costosBancarios` e
 * `impuesto4x1000` se espejan desde las líneas fijas para no romper consumidores
 * (snapshots de cartera, AuditLog, observaciones del PDF), pero NO entran en la
 * suma — sumarlos sería doble cuenta.
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
      retenciones: true,
      totalAnticipo: true,
      saldoAFavorLM: true,
      lineasRevision: { select: { valor: true, tipoFija: true } },
    },
  });

  // Σ líneas − retenciones. Comisión + IVA + 4x1000 + costos ya viven como
  // LineaRevision, por eso NO se suman aparte (sería doble cuenta).
  const calc = calcularSaldosPorLineas({
    lineas: borrador.lineasRevision,
    comision: 0n,
    ivaComision: 0n,
    retenciones: borrador.retenciones,
    totalAnticipo: borrador.totalAnticipo,
    montoLM: borrador.saldoAFavorLM,
  });

  // Espejar campos del borrador desde las líneas fijas. Si una línea fija no
  // existe (ej. borradores nuevos sin costos bancarios), el campo queda en 0n.
  const valorDe = (tipo: string): bigint =>
    borrador.lineasRevision.find((l) => l.tipoFija === tipo)?.valor ?? 0n;

  await tx.borradorFactura.update({
    where: { id: borradorId },
    data: {
      totalFacturaLineas: calc.totalFacturaLineas,
      totalFactura: calc.totalFactura,
      saldoAFavorCliente: calc.saldoAFavorCliente,
      saldoACargoCliente: calc.saldoACargoCliente,
      saldoAFavorLM: calc.saldoAFavorLM,
      saldoACargoLM: calc.saldoACargoLM,
      comision: valorDe("COMISION"),
      ivaComision: valorDe("IVA_COMISION"),
      costosBancarios: valorDe("COSTOS_BANCARIOS"),
      impuesto4x1000: valorDe("IMPUESTO_4X1000"),
    },
  });
}
