/**
 * Servicio de matrices de costos bancarios — Galcomex
 *
 * Edición (ADMIN) del costoFijo de:
 *   - MatrizRecaudo: 5 tipos de recaudo (BANCOLOMBIA, OTROS_BANCOS, SUCURSAL,
 *     CORRESPONSAL, CAJERO).
 *   - MatrizPago: 3 canales de pago (TRANSF_BANCOLOMBIA, PSE,
 *     TRANSF_OTROS_BANCOS).
 *
 * OJO — snapshots: Anticipo.costoRecaudo y PagoTramite.costoBancario
 * congelan el costoFijo vigente al momento de crear el movimiento (ver
 * src/lib/anticipos/service.ts y src/lib/pagos/service.ts). Cambiar una fila
 * de matriz aquí NO recalcula movimientos ya registrados — solo afecta a los
 * anticipos/pagos que se creen después del cambio.
 */

import { CanalPago, TipoRecaudo, type MatrizPago, type MatrizRecaudo } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export class MatrizRecaudoNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(tipoRecaudo: TipoRecaudo) {
    super(`Tipo de recaudo '${tipoRecaudo}' no encontrado en la matriz`);
    this.name = "MatrizRecaudoNoEncontradaError";
  }
}

export class MatrizPagoNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(canalPago: CanalPago) {
    super(`Canal de pago '${canalPago}' no encontrado en la matriz`);
    this.name = "MatrizPagoNoEncontradaError";
  }
}

export class CostoFijoNegativoError extends Error {
  public readonly status = 400;
  constructor() {
    super("El costo fijo no puede ser negativo");
    this.name = "CostoFijoNegativoError";
  }
}

/**
 * Actualiza el costoFijo de una fila de MatrizRecaudo.
 * Genera AuditLog en la MISMA transacción con el valor anterior y el nuevo.
 */
export async function actualizarCostoRecaudo(
  tipoRecaudo: TipoRecaudo,
  costoFijo: bigint,
  usuarioId: string,
): Promise<MatrizRecaudo> {
  if (costoFijo < 0n) {
    throw new CostoFijoNegativoError();
  }

  return prisma.$transaction(async (tx) => {
    const actual = await tx.matrizRecaudo.findUnique({ where: { tipoRecaudo } });
    if (!actual) {
      throw new MatrizRecaudoNoEncontradaError(tipoRecaudo);
    }

    const actualizado = await tx.matrizRecaudo.update({
      where: { tipoRecaudo },
      data: { costoFijo },
    });

    await tx.auditLog.create({
      data: {
        entidad: "MatrizRecaudo",
        entidadId: actual.id,
        accion: "UPDATE",
        usuarioId,
        antes: { tipoRecaudo, costoFijo: actual.costoFijo.toString() },
        despues: { tipoRecaudo, costoFijo: actualizado.costoFijo.toString() },
      },
    });

    return actualizado;
  });
}

/**
 * Actualiza el costoFijo de una fila de MatrizPago.
 * Misma semántica que actualizarCostoRecaudo.
 */
export async function actualizarCostoPago(
  canalPago: CanalPago,
  costoFijo: bigint,
  usuarioId: string,
): Promise<MatrizPago> {
  if (costoFijo < 0n) {
    throw new CostoFijoNegativoError();
  }

  return prisma.$transaction(async (tx) => {
    const actual = await tx.matrizPago.findUnique({ where: { canalPago } });
    if (!actual) {
      throw new MatrizPagoNoEncontradaError(canalPago);
    }

    const actualizado = await tx.matrizPago.update({
      where: { canalPago },
      data: { costoFijo },
    });

    await tx.auditLog.create({
      data: {
        entidad: "MatrizPago",
        entidadId: actual.id,
        accion: "UPDATE",
        usuarioId,
        antes: { canalPago, costoFijo: actual.costoFijo.toString() },
        despues: { canalPago, costoFijo: actualizado.costoFijo.toString() },
      },
    });

    return actualizado;
  });
}
