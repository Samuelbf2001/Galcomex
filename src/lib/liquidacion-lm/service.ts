/**
 * Servicio de Liquidación por lotes de la cuenta con el socio LM (Lucho) — Galcomex.
 *
 * Lista las facturas SOCIO_LM de un período con su saldo de cruce autoritativo
 * (`saldoNetoLM` de la factura: el MISMO que usa Cartera y que cuadra con el
 * Excel) y los netea a un único saldo a saldar con Lucho. Ver [[cartera]] y
 * [[liquidacion-lm]].
 *
 * IMPORTANTE: el saldo se LEE de la factura (`saldoAFavorLM/saldoACargoLM` +
 * abonos/devoluciones destino=LM), no se recalcula desde el borrador. El
 * recálculo (`saldoLMInterno − saldoAFavorCliente`) deriva por redondeo del
 * 4x1000 e introduce un desfase de ~161k contra el Excel/Cartera.
 */

import { DestinoPago, TipoCliente, TipoPagoFactura } from "@prisma/client";

import { agregarLiquidacionLM } from "@/lib/calculations/liquidacion-lm";
import { calcularSaldoNeto } from "@/lib/cartera/service";
import { prisma } from "@/lib/db/prisma";

type GetLiquidacionLMInput = {
  /** Filtro por fecha de emisión de la factura (inclusivo), YYYY-MM-DD. */
  desde?: string;
  hasta?: string;
};

export type LiquidacionTramiteRow = {
  facturaId: string;
  borradorId: string | null;
  tramiteId: string | null;
  consecutivo: string;
  clienteNombre: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  saldoLMInterno: bigint;
  saldoAFavorCliente: bigint;
  saldoLM: bigint;
};

export async function getLiquidacionLM(input: GetLiquidacionLMInput) {
  const { desde, hasta } = input;

  const fechaFilter: { gte?: Date; lte?: Date } = {};
  if (desde) fechaFilter.gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) fechaFilter.lte = new Date(`${hasta}T23:59:59.999Z`);
  const fechaWhere = desde || hasta ? { fecha: fechaFilter } : {};

  const facturas = await prisma.factura.findMany({
    where: {
      cliente: { tipo: TipoCliente.SOCIO_LM },
      ...fechaWhere,
    },
    select: {
      id: true,
      fecha: true,
      numSiigo: true,
      saldoAFavorCliente: true,
      saldoAFavorLM: true,
      saldoACargoLM: true,
      cliente: { select: { nombre: true } },
      borrador: {
        select: {
          id: true,
          tramiteId: true,
          numFacturaSiigo: true,
          saldoLMInterno: true,
          tramite: { select: { consecutivo: true } },
        },
      },
      pagos: { select: { destino: true, tipo: true, monto: true } },
    },
    orderBy: { fecha: "desc" },
  });

  const rows: LiquidacionTramiteRow[] = facturas.map((f) => {
    const pagosLM = f.pagos.filter((p) => p.destino === DestinoPago.LM);
    const abonosLM = pagosLM
      .filter((p) => p.tipo === TipoPagoFactura.ABONO)
      .reduce((sum, p) => sum + p.monto, 0n);
    const devolucionesLM = pagosLM
      .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
      .reduce((sum, p) => sum + p.monto, 0n);
    const saldoLM = calcularSaldoNeto({
      saldoAFavor: f.saldoAFavorLM,
      saldoACargo: f.saldoACargoLM,
      abonos: abonosLM,
      devoluciones: devolucionesLM,
    });

    return {
      facturaId: f.id,
      borradorId: f.borrador?.id ?? null,
      tramiteId: f.borrador?.tramiteId ?? null,
      consecutivo: f.borrador?.tramite.consecutivo ?? "—",
      clienteNombre: f.cliente.nombre,
      numFacturaSiigo: f.borrador?.numFacturaSiigo ?? f.numSiigo,
      fechaFactura: f.fecha ? f.fecha.toISOString() : null,
      saldoLMInterno: f.borrador?.saldoLMInterno ?? 0n,
      saldoAFavorCliente: f.saldoAFavorCliente,
      saldoLM,
    };
  });

  const { resumen } = agregarLiquidacionLM(rows);

  return { tramites: rows, resumen };
}
