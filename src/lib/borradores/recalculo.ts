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
 * Fase centavos: todo en CENTAVOS (columnas `…Centavos`); solo sumas y
 * restas, sin redondeo.
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
      retencionesCentavos: true,
      totalAnticipoCentavos: true,
      saldoAFavorLMCentavos: true,
      lineasRevision: { select: { valorCentavos: true, tipoFija: true, seccion: true } },
    },
  });

  // Σ líneas − retenciones. Comisión + IVA + 4x1000 + costos ya viven como
  // LineaRevision, por eso NO se suman aparte (sería doble cuenta).
  const calc = calcularSaldosPorLineas({
    lineas: borrador.lineasRevision.map((l) => ({ valor: l.valorCentavos })),
    comision: 0n,
    ivaComision: 0n,
    retenciones: borrador.retencionesCentavos,
    totalAnticipo: borrador.totalAnticipoCentavos,
    montoLM: borrador.saldoAFavorLMCentavos,
  });

  // Espejar campos del borrador desde las líneas fijas. Si una línea fija no
  // existe (ej. borradores nuevos sin costos bancarios), el campo queda en 0n.
  const valorDe = (tipo: string): bigint =>
    borrador.lineasRevision.find((l) => l.tipoFija === tipo)?.valorCentavos ?? 0n;

  const comision =
    borrador.formatoFactura === FORMATO_CONCEPTOS_IVA
      ? borrador.lineasRevision
          .filter((l) => l.seccion === SeccionLinea.OPERACIONAL && !l.tipoFija)
          .reduce((suma, l) => suma + l.valorCentavos, 0n)
      : valorDe("COMISION");

  await tx.borradorFactura.update({
    where: { id: borradorId },
    data: {
      totalFacturaLineasCentavos: calc.totalFacturaLineas,
      totalFacturaCentavos: calc.totalFactura,
      saldoAFavorClienteCentavos: calc.saldoAFavorCliente,
      saldoACargoClienteCentavos: calc.saldoACargoCliente,
      saldoAFavorLMCentavos: calc.saldoAFavorLM,
      saldoACargoLMCentavos: calc.saldoACargoLM,
      comisionCentavos: comision,
      ivaComisionCentavos: valorDe("IVA_COMISION"),
      costosBancariosCentavos: valorDe("COSTOS_BANCARIOS"),
      impuesto4x1000Centavos: valorDe("IMPUESTO_4X1000"),
    },
  });
}
