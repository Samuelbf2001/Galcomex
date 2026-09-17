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
 * En el formato CONCEPTOS_IVA primero se recalculan las líneas derivadas (IVA
 * por ítem, 4x1000 sobre terceros) y la ReteIVA; `comision` espeja la suma de
 * los conceptos propios.
 *
 * Debe ejecutarse dentro de una transacción; si compite con otra edición
 * sobre el mismo borrador, el caller debe tomar el advisory lock antes.
 */

import { Prisma, SeccionLinea } from "@prisma/client";

import { calcularSaldosPorLineas } from "@/lib/calculations/total-lineas";

import { FORMATO_CONCEPTOS_IVA, sincronizarLineasDerivadas } from "./formato-conceptos";

type Tx = Prisma.TransactionClient;

export async function recalcularTotalBorrador(tx: Tx, borradorId: string): Promise<void> {
  await sincronizarLineasDerivadas(tx, borradorId);

  // findUniqueOrThrow: el caller siempre acaba de cargar/crear el borrador en la
  // misma transacción, así que la ausencia es un invariante incumplido (no un
  // error de usuario).
  const borrador = await tx.borradorFactura.findUniqueOrThrow({
    where: { id: borradorId },
    select: {
      formatoFactura: true,
      retenciones: true,
      totalAnticipo: true,
      saldoAFavorLM: true,
      lineasRevision: { select: { valor: true, tipoFija: true, seccion: true } },
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

  const comision =
    borrador.formatoFactura === FORMATO_CONCEPTOS_IVA
      ? borrador.lineasRevision
          .filter((l) => l.seccion === SeccionLinea.OPERACIONAL && !l.tipoFija)
          .reduce((suma, l) => suma + l.valor, 0n)
      : valorDe("COMISION");

  await tx.borradorFactura.update({
    where: { id: borradorId },
    data: {
      totalFacturaLineas: calc.totalFacturaLineas,
      totalFactura: calc.totalFactura,
      saldoAFavorCliente: calc.saldoAFavorCliente,
      saldoACargoCliente: calc.saldoACargoCliente,
      saldoAFavorLM: calc.saldoAFavorLM,
      saldoACargoLM: calc.saldoACargoLM,
      comision,
      ivaComision: valorDe("IVA_COMISION"),
      costosBancarios: valorDe("COSTOS_BANCARIOS"),
      impuesto4x1000: valorDe("IMPUESTO_4X1000"),
    },
  });
}
