/**
 * M3 (revisión INTEG-B, 29-sep-2026) — deshacer una liquidación de comisiones
 * (B10, "Facturar comisiones" de LTRANS).
 *
 * Caso: el «Otros» que salió de "Facturar comisiones" se creó mal (faltó un DO,
 * sobró otro, cambió el valor por contenedor). Antes no había cómo volver atrás:
 * las comisiones quedaban ligadas a un servicio inservible y no se podían
 * volver a facturar.
 *
 * Qué hace, todo en UNA transacción y bajo candado:
 *   1. Desliga las comisiones (`liquidacionTramiteId` / `liquidadaEn` a null):
 *      vuelven a "por facturar" con las mismas unidades.
 *   2. Deja el «Otros» inservible y a la vista, sin borrarlo (queda su historia):
 *      `valorServicio` en null (no hay con qué cobrar), estado CERRADO (cierre
 *      total: nadie lo modifica, reabrirlo es solo ADMIN), "ANULADO: motivo" en
 *      sus comentarios y en la referencia. Sus borradores todavía sin aprobar
 *      (BORRADOR / EN_REVISION) se eliminan; su contenido queda en el AuditLog.
 *   3. AuditLog `DESHACER_LIQUIDACION` con el motivo y el antes/después.
 *
 * Solo si el «Otros» no tiene factura aprobada o emitida, envío a Siigo,
 * estado de cobro ni movimientos de plata (`deshacer-reglas.ts`). Volver a
 * liquidar las mismas comisiones da el mismo total: el «Otros» nuevo es otro DO.
 */

import { EstadoTramite } from "@prisma/client";

import {
  ESTADOS_BORRADOR_DESCARTABLES,
  impedimentoParaDeshacer,
} from "@/lib/comisiones/deshacer-reglas";
import { ComisionInvalidaError } from "@/lib/comisiones/service";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { MOTIVO_FORZAR_MIN, motivoValido } from "@/lib/tramites/motivo-forzar";

/** El «Otros» no existe, no es de esa empresa o ya no tiene comisiones facturadas (¿ya se deshizo?). */
export class LiquidacionNoEncontradaError extends Error {
  public readonly status = 404;
  constructor() {
    super("No hay comisiones facturadas en ese servicio para esta empresa (¿ya se deshizo?). Recarga la ficha.");
    this.name = "LiquidacionNoEncontradaError";
  }
}

/** El «Otros» ya tiene factura, envío a Siigo, cobro o plata detrás: no se deshace. */
export class DeshacerLiquidacionImposibleError extends Error {
  public readonly status = 409;
  public readonly codigo = "DESHACER_LIQUIDACION_IMPOSIBLE" as const;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "DeshacerLiquidacionImposibleError";
  }
}

export interface DeshacerLiquidacionInput {
  /** Empresa que paga la comisión (LTRANS): el «Otros» tiene que ser suyo. */
  empresaId: string;
  /** El «Otros» que salió de "Facturar comisiones". */
  tramiteId: string;
  /** Por qué se deshace (≥ 10 caracteres). Queda en el AuditLog y en el «Otros». */
  motivo: string;
  usuarioId: string;
}

export interface DeshacerLiquidacionResultado {
  tramiteId: string;
  consecutivo: string;
  /** Comisiones que vuelven a "por facturar". */
  comisiones: number;
  unidades: number;
  /** Lo que se había facturado en el «Otros» (sin IVA), ahora anulado. */
  valorAnulado: bigint | null;
  borradoresEliminados: number;
}

export async function deshacerLiquidacion(
  input: DeshacerLiquidacionInput,
): Promise<DeshacerLiquidacionResultado> {
  const motivo = motivoValido(input.motivo);
  if (!motivo) {
    throw new ComisionInvalidaError(
      `Escribe el motivo de deshacer la liquidación (mínimo ${MOTIVO_FORZAR_MIN} caracteres).`,
    );
  }

  return prisma.$transaction(async (tx) => {
    // Dos personas deshaciendo el mismo «Otros» a la vez: una espera a la otra y
    // la segunda ya no encuentra comisiones ligadas (404).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comision_liquidacion:${input.tramiteId}`}))`;

    // Los borradores del «Otros» se bloquean con el mismo candado que usan
    // aprobar / editar líneas: si alguien lo está aprobando ahora mismo, se
    // espera y se lee el estado ya definitivo.
    const idsBorradores = await tx.borradorFactura.findMany({
      where: { tramiteId: input.tramiteId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    for (const { id } of idsBorradores) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`borrador_lineas:${id}`}))`;
    }

    const otros = await tx.tramiteDO.findUnique({
      where: { id: input.tramiteId },
      select: {
        id: true,
        consecutivo: true,
        clienteId: true,
        estado: true,
        valorServicio: true,
        conceptoServicioCodigo: true,
        referenciaExterna: true,
        comentarios: true,
        comisionesLiquidadas: {
          select: {
            id: true,
            empresaId: true,
            unidades: true,
            tramite: { select: { consecutivo: true } },
          },
          orderBy: { tramite: { consecutivo: "asc" } },
        },
        borradores: {
          select: {
            id: true,
            estado: true,
            siigoEnvioEstado: true,
            siigoDraftId: true,
            formatoFactura: true,
            totalFacturaLineas: true,
            lineasRevision: { select: { concepto: true, valor: true, aplicaIva: true }, orderBy: { orden: "asc" } },
          },
        },
        _count: {
          select: { pagos: true, aplicacionesAnticipo: true, facturasProveedor: true, movimientosCuenta: true },
        },
      },
    });
    if (
      !otros ||
      otros.clienteId !== input.empresaId ||
      otros.comisionesLiquidadas.length === 0 ||
      otros.comisionesLiquidadas.some((c) => c.empresaId !== input.empresaId)
    ) {
      throw new LiquidacionNoEncontradaError();
    }

    const impedimento = impedimentoParaDeshacer({
      estado: otros.estado,
      borradores: otros.borradores,
      movimientos:
        otros._count.pagos +
        otros._count.aplicacionesAnticipo +
        otros._count.facturasProveedor +
        otros._count.movimientosCuenta,
    });
    if (impedimento) throw new DeshacerLiquidacionImposibleError(impedimento);

    const comisiones = otros.comisionesLiquidadas;
    const unidades = comisiones.reduce((suma, c) => suma + c.unidades, 0);

    // 1. Los borradores sin aprobar (ya validado: todos BORRADOR / EN_REVISION) se eliminan.
    //    El WHERE repite el estado: si algo cambió, count no cuadra y se deshace todo.
    const eliminados = await tx.borradorFactura.deleteMany({
      where: { id: { in: otros.borradores.map((b) => b.id) }, estado: { in: [...ESTADOS_BORRADOR_DESCARTABLES] } },
    });
    if (eliminados.count !== otros.borradores.length) {
      throw new DeshacerLiquidacionImposibleError(
        "La factura de este servicio cambió mientras se deshacía. Recarga la ficha y vuelve a intentar.",
      );
    }

    // 2. Las comisiones vuelven a "por facturar".
    const desligadas = await tx.comisionTramite.updateMany({
      where: { liquidacionTramiteId: otros.id, empresaId: input.empresaId },
      data: { liquidacionTramiteId: null, liquidadaEn: null },
    });
    if (desligadas.count !== comisiones.length) throw new LiquidacionNoEncontradaError();

    // 3. El «Otros» queda inservible y visible: sin valor (nada que cobrar), cerrado
    //    (bloqueo total; reabrir es solo ADMIN) y marcado como anulado.
    const nota = `ANULADO: ${motivo}`;
    await tx.tramiteDO.update({
      where: { id: otros.id },
      data: {
        valorServicio: null,
        estado: EstadoTramite.CERRADO,
        comentarios: otros.comentarios ? `${nota}\n${otros.comentarios}` : nota,
        referenciaExterna: otros.referenciaExterna?.startsWith("(ANULADO)")
          ? otros.referenciaExterna
          : `(ANULADO) ${otros.referenciaExterna ?? ""}`.trim(),
      },
    });
    if (otros.estado !== EstadoTramite.CERRADO) {
      await tx.estadoLog.create({
        data: {
          tramiteId: otros.id,
          estadoAntes: otros.estado,
          estadoDes: EstadoTramite.CERRADO,
          usuarioId: input.usuarioId,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        entidad: "Cliente",
        entidadId: input.empresaId,
        accion: "DESHACER_LIQUIDACION",
        usuarioId: input.usuarioId,
        tramiteId: otros.id,
        antes: normalizeSerializable({
          tramite: { id: otros.id, consecutivo: otros.consecutivo, estado: otros.estado },
          valorServicio: otros.valorServicio,
          conceptoServicioCodigo: otros.conceptoServicioCodigo,
          comisiones: comisiones.map((c) => ({
            comisionId: c.id,
            tramite: c.tramite.consecutivo,
            unidades: c.unidades,
          })),
          borradoresEliminados: otros.borradores.map((b) => ({
            id: b.id,
            estado: b.estado,
            formatoFactura: b.formatoFactura,
            totalFacturaLineas: b.totalFacturaLineas,
            lineas: b.lineasRevision,
          })),
        }),
        despues: normalizeSerializable({
          motivo,
          tramite: { id: otros.id, consecutivo: otros.consecutivo, estado: EstadoTramite.CERRADO },
          valorServicio: null,
          comisionesPorFacturar: comisiones.length,
          unidades,
        }),
      },
    });

    return {
      tramiteId: otros.id,
      consecutivo: otros.consecutivo,
      comisiones: comisiones.length,
      unidades,
      valorAnulado: otros.valorServicio,
      borradoresEliminados: eliminados.count,
    };
  });
}
