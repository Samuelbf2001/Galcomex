/**
 * Servicio de pagos del trámite — Galcomex
 * Implementa el libro de pagos por DO con saldo corriente en vivo.
 * A1-T6: Libro de pagos del trámite + saldo en vivo.
 */

import { type Beneficiario, CanalPago, EstadoFacturaProveedor, Prisma, type PagoTramite } from "@prisma/client";

import { calcularSaldosIntermedios } from "@/lib/calculations/motor-factura";
import { prisma } from "@/lib/db/prisma";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
} from "@/lib/facturas-proveedor/service";

type CrearPagoInput = {
  tramiteId: string;
  concepto: string;
  beneficiarioId?: string | null;
  numSoporte?: string | null;
  documentoId?: string | null;
  valor: bigint;
  canalPago: CanalPago;
  fechaEsperadaPago?: Date | null;
  fechaRealPago?: Date | null;
  facturaProveedorId?: string | null;
  usuarioId: string;
};

type AplicacionDetalle = {
  id: string;
  montoAplicado: bigint;
  anticipo: {
    id: string;
    monto: bigint;
    fecha: Date;
    tipoRecaudo: string;
    costoRecaudo: bigint;
    verificadoBanco: boolean;
    costoBancario: bigint;
  };
};

type PagoConRelaciones = PagoTramite & {
  facturaProveedor: { numFactura: string } | null;
  beneficiario: Pick<Beneficiario, "id" | "nombre" | "nit"> | null;
};

type LibroPagosResult = {
  pagos: PagoConRelaciones[];
  aplicaciones: AplicacionDetalle[];
  totalPagos: bigint;
  costosBancarios: bigint;
  costosBancariosAnticipo: bigint;
  totalAnticipoAplicado: bigint;
  saldos: bigint[];
  saldoFinal: bigint;
};

type ListarPagosFiltros = {
  clienteId?: string;
  tramiteId?: string;
  canalPago?: CanalPago;
  /** Solo pagos sin fecha real registrada (pendientes de ejecutar) */
  soloPendientes?: boolean;
};

export type PagoGlobalRow = PagoTramite & {
  tramite: {
    id: string;
    consecutivo: string;
    estado: string;
    cliente: { id: string; nombre: string; nit: string };
  };
};

type ListarPagosResult = {
  pagos: PagoGlobalRow[];
  totalPagos: bigint;
  costosBancarios: bigint;
  totalPendiente: bigint;
};

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

/**
 * Resuelve el costo bancario desde la tabla MatrizPago según el canal.
 * Lanza un error descriptivo si el canal no existe en la matriz.
 */
async function resolverCostoBancario(
  canal: CanalPago,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<bigint> {
  const db = tx ?? prisma;
  const entrada = await db.matrizPago.findUnique({
    where: { canalPago: canal },
    select: { costoFijo: true },
  });

  if (!entrada) {
    throw new MatrizCanalNoEncontradoError(canal);
  }

  return entrada.costoFijo;
}

export class MatrizCanalNoEncontradoError extends Error {
  public readonly canal: CanalPago;
  public readonly status = 400;

  constructor(canal: CanalPago) {
    super(`Canal de pago '${canal}' no encontrado en la matriz de recaudo`);
    this.name = "MatrizCanalNoEncontradoError";
    this.canal = canal;
  }
}

export class PagoFacturaDeOtroTramiteError extends Error {
  public readonly status = 422;
  constructor(facturaProveedorId: string, tramiteId: string) {
    super(`La factura de proveedor ${facturaProveedorId} no pertenece al trámite ${tramiteId}`);
    this.name = "PagoFacturaDeOtroTramiteError";
  }
}

/**
 * Crea un pago en el libro del trámite.
 * - Resuelve costoBancario automáticamente desde MatrizRecaudoPago según canalPago.
 * - Asigna orden = último orden + 1.
 * - Genera AuditLog.
 */
export async function crearPago(input: CrearPagoInput): Promise<PagoTramite> {
  const {
    tramiteId,
    concepto,
    beneficiarioId,
    numSoporte,
    documentoId,
    valor,
    canalPago,
    fechaEsperadaPago,
    fechaRealPago,
    facturaProveedorId,
    usuarioId,
  } = input;

  return prisma.$transaction(async (tx) => {
    const costoBancario = await resolverCostoBancario(canalPago, tx);

    const ultimoPago = await tx.pagoTramite.findFirst({
      where: { tramiteId },
      orderBy: { orden: "desc" },
      select: { orden: true },
    });

    const orden = (ultimoPago?.orden ?? 0) + 1;

    // Validar y vincular FacturaProveedor si se proporciona
    if (facturaProveedorId != null) {
      const fp = await tx.facturaProveedor.findUnique({
        where: { id: facturaProveedorId },
      });

      if (!fp) {
        throw new FacturaProveedorNoEncontradaError(facturaProveedorId);
      }

      if (fp.tramiteId !== tramiteId) {
        throw new PagoFacturaDeOtroTramiteError(facturaProveedorId, tramiteId);
      }

      if (fp.estado !== EstadoFacturaProveedor.REGISTRADA) {
        throw new FacturaProveedorNoModificableError(facturaProveedorId, fp.estado);
      }
    }

    const pago = await tx.pagoTramite.create({
      data: {
        tramiteId,
        concepto,
        beneficiarioId,
        numSoporte,
        documentoId,
        valor,
        canalPago,
        costoBancario,
        orden,
        fechaEsperadaPago,
        fechaRealPago,
        ...(facturaProveedorId != null ? { facturaProveedorId } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId,
        tramiteId,
        despues: normalizeSerializable(pago),
      },
    });

    // Si se vinculó una FP, marcarla como PAGADA y registrar auditoría.
    // El estado anterior siempre es REGISTRADA (validado arriba en la misma transacción).
    if (facturaProveedorId != null) {
      await tx.facturaProveedor.update({
        where: { id: facturaProveedorId },
        data: { estado: EstadoFacturaProveedor.PAGADA },
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaProveedorId,
          accion: "UPDATE_ESTADO",
          usuarioId,
          tramiteId,
          antes: normalizeSerializable({ estado: EstadoFacturaProveedor.REGISTRADA }),
          despues: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
        },
      });
    }

    return pago;
  });
}

/**
 * Actualiza el canal de pago de un pago existente (y/o valor/concepto/etc).
 * Recalcula costoBancario automáticamente si cambia el canal.
 */
export async function actualizarPago(
  pagoId: string,
  cambios: {
    canalPago?: CanalPago;
    valor?: bigint;
    concepto?: string;
    beneficiarioId?: string | null;
    numSoporte?: string | null;
    fechaEsperadaPago?: Date | null;
    fechaRealPago?: Date | null;
  },
  usuarioId: string,
): Promise<PagoTramite> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
    });

    if (!actual) {
      throw new Error(`Pago ${pagoId} no encontrado`);
    }

    const canalEfectivo = cambios.canalPago ?? actual.canalPago;
    const costoBancario =
      cambios.canalPago !== undefined
        ? await resolverCostoBancario(canalEfectivo, tx)
        : actual.costoBancario;

    const updated = await tx.pagoTramite.update({
      where: { id: pagoId },
      data: {
        ...cambios,
        costoBancario,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pagoId,
        accion: "UPDATE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(actual),
        despues: normalizeSerializable(updated),
      },
    });

    return updated;
  });
}

/**
 * Elimina un pago del libro del trámite.
 * Si el pago tenía una FacturaProveedor vinculada, revierte su estado a REGISTRADA.
 */
export async function eliminarPago(
  pagoId: string,
  usuarioId: string,
): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.pagoTramite.findUnique({
      where: { id: pagoId },
    });

    if (!actual) {
      throw new Error(`Pago ${pagoId} no encontrado`);
    }

    // Revertir estado de FP vinculada antes de borrar el pago
    if (actual.facturaProveedorId != null) {
      await tx.facturaProveedor.update({
        where: { id: actual.facturaProveedorId },
        data: { estado: EstadoFacturaProveedor.REGISTRADA },
      });

      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: actual.facturaProveedorId,
          accion: "UPDATE_ESTADO",
          usuarioId,
          tramiteId: actual.tramiteId,
          antes: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
          despues: normalizeSerializable({ estado: EstadoFacturaProveedor.REGISTRADA }),
        },
      });
    }

    await tx.pagoTramite.delete({ where: { id: pagoId } });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pagoId,
        accion: "DELETE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(actual),
      },
    });
  });
}

export async function getPagoConBeneficiario(pagoId: string) {
  return prisma.pagoTramite.findUnique({
    where: { id: pagoId },
    include: {
      beneficiario: { select: { id: true, nombre: true, nit: true } },
      facturaProveedor: { select: { numFactura: true } },
    },
  });
}

/**
 * Retorna el libro de pagos del trámite con saldo corriente línea a línea.
 *
 * totalAnticipoAplicado = Σ montoAplicado de AplicacionAnticipo del trámite.
 * saldos = calcularSaldosIntermedios(totalAnticipoAplicado, pagos).
 * saldoFinal = último saldo (o totalAnticipoAplicado si no hay pagos).
 */
export async function getLibroPagos(tramiteId: string): Promise<LibroPagosResult> {
  const [pagos, rawAplicaciones] = await Promise.all([
    prisma.pagoTramite.findMany({
      where: { tramiteId },
      orderBy: { orden: "asc" },
      include: {
        facturaProveedor: { select: { numFactura: true } },
        beneficiario: { select: { id: true, nombre: true, nit: true } },
      },
    }),
    prisma.aplicacionAnticipo.findMany({
      where: { tramiteId },
      include: {
        anticipo: {
          select: { id: true, monto: true, fecha: true, tipoRecaudo: true, costoRecaudo: true, verificadoBanco: true },
        },
      },
      orderBy: { anticipo: { fecha: "asc" } },
    }),
  ]);

  const aplicaciones: AplicacionDetalle[] = rawAplicaciones.map((a) => ({
    id: a.id,
    montoAplicado: a.montoAplicado,
    anticipo: {
      id: a.anticipo.id,
      monto: a.anticipo.monto,
      fecha: a.anticipo.fecha,
      tipoRecaudo: a.anticipo.tipoRecaudo,
      costoRecaudo: a.anticipo.costoRecaudo,
      verificadoBanco: a.anticipo.verificadoBanco,
      costoBancario: a.anticipo.costoRecaudo,
    },
  }));

  const totalAnticipoAplicado = aplicaciones.reduce(
    (sum, a) => sum + a.montoAplicado,
    0n,
  );
  const costosBancariosAnticipo = aplicaciones.reduce(
    (sum, a) => sum + a.anticipo.costoBancario,
    0n,
  );

  const totalPagos = pagos.reduce((sum, p) => sum + p.valor, 0n);
  const costosBancarios = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);

  const saldos = calcularSaldosIntermedios(totalAnticipoAplicado, pagos);
  const saldoFinal =
    saldos.length > 0 ? saldos[saldos.length - 1] : totalAnticipoAplicado;

  return {
    pagos,
    aplicaciones,
    totalPagos,
    costosBancarios,
    costosBancariosAnticipo,
    totalAnticipoAplicado,
    saldos,
    saldoFinal,
  };
}

/**
 * Lista TODOS los pagos de TODOS los trámites para el módulo global de pagos.
 * Cada pago viene enriquecido con su trámite (consecutivo, estado) y cliente.
 * El libro por-DO no se ve afectado: esto es solo una vista transversal.
 */
export async function listarPagosGlobal(
  filtros: ListarPagosFiltros = {},
): Promise<ListarPagosResult> {
  const { clienteId, tramiteId, canalPago, soloPendientes } = filtros;

  const pagos = await prisma.pagoTramite.findMany({
    where: {
      ...(tramiteId ? { tramiteId } : {}),
      ...(canalPago ? { canalPago } : {}),
      ...(soloPendientes ? { fechaRealPago: null } : {}),
      ...(clienteId ? { tramite: { clienteId } } : {}),
    },
    include: {
      tramite: {
        select: {
          id: true,
          consecutivo: true,
          estado: true,
          cliente: { select: { id: true, nombre: true, nit: true } },
        },
      },
      beneficiario: { select: { id: true, nombre: true, nit: true } },
    },
    orderBy: [
      { tramite: { consecutivo: "asc" } },
      { orden: "asc" },
    ],
  });

  const totalPagos = pagos.reduce((sum, p) => sum + p.valor, 0n);
  const costosBancarios = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);
  const totalPendiente = pagos.reduce(
    (sum, p) => (p.fechaRealPago === null ? sum + p.valor : sum),
    0n,
  );

  return {
    pagos: pagos as PagoGlobalRow[],
    totalPagos,
    costosBancarios,
    totalPendiente,
  };
}
