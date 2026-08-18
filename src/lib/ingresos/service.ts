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

export type FilaIngreso = {
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

// ─── Saldo de caja GLOBAL multi-cliente (D2-c) ───────────────────────────────
//
// `getIngresos` ya calcula `saldoCorrido` como un acumulado POR CLIENTE
// (`saldosPorCliente` arriba) — es correcto y necesario para poder ver, fila
// a fila, cómo evoluciona el saldo de UN cliente. El bug que reportaba
// PENDIENTES.md D2-c no estaba en ese cálculo: estaba en cómo el frontend
// resumía la lista completa cuando NO se filtra por cliente — tomaba el
// `saldoCorrido` de la ÚLTIMA fila del arreglo unificado como si fuera un
// total, pero esa fila solo pertenece a UN cliente (el que tuvo el
// movimiento cronológicamente más reciente), no a todos.
//
// Verificado: la semántica de `saldoCorrido` por fila está bien — el defecto
// era real y estaba en la agregación, no en el ledger. Este helper lo cierra.

/**
 * Saldo de caja GLOBAL (todos los clientes combinados) a partir de las filas
 * ya calculadas por `getIngresos`. Pura — no toca BD.
 *
 * Como `filas` viene ordenada ASC por fecha, el saldo final de CADA cliente
 * es el `saldoCorrido` de su ÚLTIMA aparición en el arreglo. Sumar ese valor
 * una vez por cliente distinto da el saldo de caja combinado real — nunca se
 * sume `saldoCorrido` de todas las filas (eso contaría cada movimiento
 * intermedio del cliente una vez por cada fila suya, no solo el final).
 *
 * Con un solo cliente en `filas` (vista ya filtrada por clienteId) el
 * resultado es idéntico al saldo de ese cliente — el caso que ya funcionaba
 * bien — así que esta función puede usarse sin distinción en ambos casos.
 */
export function calcularSaldoGlobal(
  filas: Pick<FilaIngreso, "clienteId" | "saldoCorrido">[],
): bigint {
  const ultimoPorCliente = new Map<string, bigint>();
  for (const f of filas) {
    ultimoPorCliente.set(f.clienteId, f.saldoCorrido);
  }
  let total = 0n;
  for (const saldo of ultimoPorCliente.values()) {
    total += saldo;
  }
  return total;
}
