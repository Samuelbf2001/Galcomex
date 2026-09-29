/**
 * B8 (Diseño A, 27-sep-2026) — anticipo disponible por DO: el mismo anticipo
 * no se descuenta dos veces entre facturas del mismo trámite.
 *
 * Único archivo que lee `aplicacionAnticipo.montoAplicado` /
 * `borradorFactura.totalAnticipo` para este propósito (fase centavos cambia
 * solo los nombres de columna, ver `PORTAR-DISENO-A.md`).
 *
 * Regla (mismo criterio que ya usan los terceros, `formato-conceptos.ts`):
 *   anticipo asignable a una factura nueva = aplicado al DO −
 *     Σ `totalAnticipo` de los borradores del DO en APROBADO o FACTURADO
 *     (cualquier formato — los viejos en COMISION también reservan) −
 *     Σ `totalAnticipo` de los borradores del DO asignados a mano
 *     (`anticipoManual = true`) que siguen abiertos (BORRADOR/EN_REVISION),
 *     excluyendo el propio borrador (para re-verificar al aprobar).
 *
 * C1 (revisión de código, 28-sep-2026): una asignación manual aparta su
 * anticipo apenas se guarda, no solo cuando se aprueba — si no, una segunda
 * factura automática generada/re-verificada mientras la manual sigue abierta
 * no la ve y reserva de más (el error que B8 venía a corregir).
 */

import { EstadoBorrador, type Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface AnticipoDelTramite {
  /** Σ `aplicacionAnticipo.montoAplicado` del DO (todo lo que el cliente ha puesto). */
  aplicadoDo: bigint;
  /**
   * Σ `totalAnticipo` de los borradores del DO ya APROBADO/FACTURADO, más los
   * asignados a mano (`anticipoManual = true`) que siguen BORRADOR/EN_REVISION
   * (excluyendo el propio, si se pasa).
   */
  reservadoPorOtras: bigint;
  /** Lo que le queda disponible a esta factura: nunca negativo. */
  asignable: bigint;
}

/** `máx(0, aplicadoDo − reservadoPorOtras)`. Pura. */
export function anticipoAsignable(a: { aplicadoDo: bigint; reservadoPorOtras: bigint }): bigint {
  const diferencia = a.aplicadoDo - a.reservadoPorOtras;
  return diferencia > 0n ? diferencia : 0n;
}

/**
 * Anticipo disponible del DO en este momento, dentro de la transacción `tx`
 * (para poder tomar el candado del DO antes de leer, ver `transicionarBorrador`).
 */
export async function anticipoDelTramite(
  tx: Tx,
  tramiteId: string,
  opciones: { excluirBorradorId?: string } = {},
): Promise<AnticipoDelTramite> {
  const aplicaciones = await tx.aplicacionAnticipo.aggregate({
    where: { tramiteId },
    _sum: { montoAplicado: true },
  });
  const aplicadoDo = aplicaciones._sum.montoAplicado ?? 0n;

  const reservas = await tx.borradorFactura.aggregate({
    where: {
      tramiteId,
      OR: [
        { estado: { in: [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] } },
        {
          anticipoManual: true,
          estado: { in: [EstadoBorrador.BORRADOR, EstadoBorrador.EN_REVISION] },
        },
      ],
      ...(opciones.excluirBorradorId ? { id: { not: opciones.excluirBorradorId } } : {}),
    },
    _sum: { totalAnticipo: true },
  });
  const reservadoPorOtras = reservas._sum.totalAnticipo ?? 0n;

  return { aplicadoDo, reservadoPorOtras, asignable: anticipoAsignable({ aplicadoDo, reservadoPorOtras }) };
}
