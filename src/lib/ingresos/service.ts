/**
 * Servicio de Ingresos / Libro de bancos — Galcomex (WS-D)
 *
 * Vista unificada de:
 *   - Anticipo          → entrada (positivo)
 *   - PagoFactura ABONO → entrada (positivo)
 *   - PagoFactura DEVOLUCION → salida (negativo)
 *
 * Ordenada por fecha ASC, con saldo de caja corrido por cliente.
 * Rol ADMIN/REVISOR.
 */

import { TipoPagoFactura } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type FilaIngreso = {
  id: string;
  tipo: "ANTICIPO" | "ABONO" | "DEVOLUCION";
  /** DO consecutivo o numSiigo de la factura */
  referencia: string;
  /** Monto con signo: positivo = entrada, negativo = salida */
  montoConSigno: bigint;
  monto: bigint;
  /** Identificador del canal/recaudo usado; null si aún no migrado. */
  canalPago: string | null;
  verificadoBanco: boolean;
  fecha: Date;
  clienteId: string;
  clienteNombre: string;
  /** Saldo corrido de caja para el cliente (acumulado hasta esta fila, cronológicamente) */
  saldoCorrido: bigint;
};

type GetIngresosInput = {
  clienteId?: string;
  desde?: Date;
  hasta?: Date;
};

export async function getIngresos(input: GetIngresosInput = {}): Promise<FilaIngreso[]> {
  const { clienteId, desde, hasta } = input;

  // Filtro base de fechas para ambas tablas
  const fechaFilter = {
    ...(desde ? { gte: desde } : {}),
    ...(hasta ? { lte: hasta } : {}),
  };

  // ── Anticipos ─────────────────────────────────────────────────────────────
  const anticipos = await prisma.anticipo.findMany({
    where: {
      ...(clienteId ? { clienteId } : {}),
      ...(Object.keys(fechaFilter).length > 0 ? { fecha: fechaFilter } : {}),
    },
    include: {
      cliente: { select: { id: true, nombre: true } },
      aplicaciones: {
        include: {
          tramite: { select: { consecutivo: true } },
        },
        take: 1,
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { fecha: "asc" },
  });

  // ── PagoFactura ───────────────────────────────────────────────────────────
  const pagosFactura = await prisma.pagoFactura.findMany({
    where: {
      factura: clienteId ? { clienteId } : undefined,
      ...(Object.keys(fechaFilter).length > 0 ? { fecha: fechaFilter } : {}),
    },
    include: {
      factura: {
        select: {
          numSiigo: true,
          clienteId: true,
          cliente: { select: { id: true, nombre: true } },
        },
      },
    },
    orderBy: { fecha: "asc" },
  });

  // ── Unificar filas (sin saldo corrido aún) ────────────────────────────────
  type FilaSinSaldo = Omit<FilaIngreso, "saldoCorrido">;

  const filas: FilaSinSaldo[] = [];

  for (const a of anticipos) {
    const referencia = a.aplicaciones[0]?.tramite.consecutivo ?? `anticipo:${a.id}`;
    filas.push({
      id: a.id,
      tipo: "ANTICIPO",
      referencia,
      montoConSigno: a.monto,
      monto: a.monto,
      canalPago: a.tipoRecaudo,
      verificadoBanco: a.verificadoBanco,
      fecha: a.fecha,
      clienteId: a.cliente.id,
      clienteNombre: a.cliente.nombre,
    });
  }

  for (const p of pagosFactura) {
    const esEntrada = p.tipo === TipoPagoFactura.ABONO;
    filas.push({
      id: p.id,
      tipo: p.tipo === TipoPagoFactura.ABONO ? "ABONO" : "DEVOLUCION",
      referencia: p.factura.numSiigo,
      montoConSigno: esEntrada ? p.monto : -p.monto,
      monto: p.monto,
      // canalPago ahora es nullable; tipoRecaudo es la alternativa para recaudos
      canalPago: p.canalPago ?? p.tipoRecaudo ?? null,
      verificadoBanco: p.verificadoBanco,
      fecha: p.fecha,
      clienteId: p.factura.cliente.id,
      clienteNombre: p.factura.cliente.nombre,
    });
  }

  // Ordenar por fecha ASC (luego por id como desempate estable)
  filas.sort((a, b) => {
    const diff = a.fecha.getTime() - b.fecha.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  // ── Calcular saldo corrido por cliente ────────────────────────────────────
  const saldosPorCliente = new Map<string, bigint>();

  const resultado: FilaIngreso[] = filas.map((f) => {
    const actual = saldosPorCliente.get(f.clienteId) ?? 0n;
    const nuevo = actual + f.montoConSigno;
    saldosPorCliente.set(f.clienteId, nuevo);
    return { ...f, saldoCorrido: nuevo };
  });

  return resultado;
}
