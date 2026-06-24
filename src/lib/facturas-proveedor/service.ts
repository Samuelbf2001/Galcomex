/**
 * Servicio de facturas de proveedor — Galcomex
 * WS-A: entidad FacturaProveedor + integración con PagoTramite.
 *
 * Flujo:
 * 1. Lucho registra la factura que el proveedor le emite a Galcomex.
 * 2. Lucho genera el pago correspondiente (vincula PagoTramite ↔ FacturaProveedor).
 * 3. Cuando el DO está listo, solicita facturación → DO pasa a ENVIADO_A_FACTURAR.
 */

import { CanalPago, EstadoFacturaProveedor, EstadoTramite, Prisma } from "@prisma/client";

import { ensureBorrador } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { transitionTramite } from "@/lib/tramites/service";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type CrearFacturaProveedorInput = {
  tramiteId: string;
  proveedorNombre: string;
  proveedorNit?: string | null;
  beneficiarioId?: string | null;
  concepto?: string | null;
  numFactura: string;
  valor: bigint;
  fecha: Date;
  // La obligatoriedad del archivo (p.4) se valida en la capa API (Zod del endpoint).
  // El servicio lo acepta opcional para scripts de importación histórica y generación interna.
  documentoId?: string | null;
  subidaPorId: string;
};

export type ActualizarFacturaProveedorInput = {
  proveedorNombre?: string;
  proveedorNit?: string | null;
  beneficiarioId?: string | null;
  concepto?: string | null;
  numFactura?: string;
  valor?: bigint;
  fecha?: Date;
  documentoId?: string | null;
};

export type GenerarPagoInput = {
  facturaProveedorId: string;
  canalPago: CanalPago;
  viaSocio: boolean;
  fechaRealPago?: Date | null;
  usuarioId: string;
};

// ─── Errores tipados ──────────────────────────────────────────────────────────

export class FacturaProveedorNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Factura de proveedor ${id} no encontrada`);
    this.name = "FacturaProveedorNoEncontradaError";
  }
}

export class FacturaProveedorConPagosError extends Error {
  public readonly status = 422;
  constructor(id: string) {
    super(`No se puede eliminar la factura ${id} porque tiene pagos vinculados`);
    this.name = "FacturaProveedorConPagosError";
  }
}

export class FacturaProveedorDuplicadaError extends Error {
  public readonly status = 409;
  constructor(tramiteId: string, numFactura: string) {
    super(`Ya existe una factura ${numFactura} para el trámite ${tramiteId}`);
    this.name = "FacturaProveedorDuplicadaError";
  }
}

export class FacturaProveedorNoModificableError extends Error {
  public readonly status = 422;
  constructor(id: string, estado: EstadoFacturaProveedor) {
    super(`La factura de proveedor ${id} está en estado ${estado} y no admite esta operación (solo se permite sobre facturas en estado REGISTRADA)`);
    this.name = "FacturaProveedorNoModificableError";
  }
}

export class TramiteSinPagosError extends Error {
  public readonly status = 422;
  constructor(tramiteId: string) {
    super(`El trámite ${tramiteId} no tiene pagos registrados`);
    this.name = "TramiteSinPagosError";
  }
}

export class TransicionEstadoInvalidaError extends Error {
  public readonly status = 422;
  public readonly estadosValidos: EstadoTramite[];
  constructor(estadoActual: EstadoTramite, estadoDestino: EstadoTramite, estadosValidos: EstadoTramite[]) {
    super(
      `No se puede transicionar el trámite de ${estadoActual} a ${estadoDestino}. ` +
        `Estados válidos desde ${estadoActual}: ${estadosValidos.join(", ") || "ninguno"}`,
    );
    this.name = "TransicionEstadoInvalidaError";
    this.estadosValidos = estadosValidos;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

/**
 * Resuelve el costo bancario de un pago desde la matriz de pagos.
 * Usa la conexión principal (no la transacción) para evitar problemas de
 * visibilidad en transacciones paralelas — la matriz es datos de solo lectura.
 */
async function resolverCostoBancario(canal: CanalPago): Promise<bigint> {
  const entrada = await prisma.matrizPago.findUnique({
    where: { canalPago: canal },
    select: { costoFijo: true },
  });
  if (!entrada) {
    throw new Error(`Canal de pago '${canal}' no encontrado en la matriz de pagos`);
  }
  return entrada.costoFijo;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea una factura de proveedor para un trámite.
 * Valida unicidad (tramiteId, numFactura).
 */
export async function crearFacturaProveedor(input: CrearFacturaProveedorInput) {
  const { tramiteId, proveedorNombre, proveedorNit, beneficiarioId, concepto, numFactura, valor, fecha, documentoId, subidaPorId } =
    input;

  return prisma.$transaction(async (tx) => {
    // Verificar unicidad
    const existente = await tx.facturaProveedor.findUnique({
      where: { tramiteId_numFactura: { tramiteId, numFactura } },
    });
    if (existente) {
      throw new FacturaProveedorDuplicadaError(tramiteId, numFactura);
    }

    const factura = await tx.facturaProveedor.create({
      data: {
        tramiteId,
        proveedorNombre,
        proveedorNit,
        beneficiarioId: beneficiarioId ?? null,
        concepto: concepto ?? null,
        numFactura,
        valor,
        fecha,
        documentoId,
        subidaPorId,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: factura.id,
        accion: "CREATE",
        usuarioId: subidaPorId,
        tramiteId,
        despues: normalizeSerializable(factura),
      },
    });

    return factura;
  });
}

/**
 * Lista todas las facturas de proveedor de un trámite.
 */
export async function listarPorTramite(tramiteId: string) {
  return prisma.facturaProveedor.findMany({
    where: { tramiteId },
    include: {
      subidoPor: { select: { id: true, name: true, email: true } },
      documento: { select: { id: true, nombreArchivo: true, storageKey: true } },
      beneficiario: { select: { id: true, nombre: true, nit: true } },
      pagos: {
        include: {
          pago: { select: { id: true, valor: true, canalPago: true, fechaRealPago: true } },
        },
      },
    },
    orderBy: { fecha: "asc" },
  });
}

/**
 * Actualiza una factura de proveedor existente.
 * Solo se puede actualizar si está en estado REGISTRADA.
 */
export async function actualizarFacturaProveedor(
  facturaId: string,
  cambios: ActualizarFacturaProveedorInput,
  usuarioId: string,
) {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.facturaProveedor.findUnique({
      where: { id: facturaId },
    });
    if (!actual) {
      throw new FacturaProveedorNoEncontradaError(facturaId);
    }
    if (actual.estado !== EstadoFacturaProveedor.REGISTRADA) {
      throw new FacturaProveedorNoModificableError(facturaId, actual.estado);
    }

    // Si cambia numFactura, verificar unicidad
    if (cambios.numFactura && cambios.numFactura !== actual.numFactura) {
      const existente = await tx.facturaProveedor.findUnique({
        where: {
          tramiteId_numFactura: { tramiteId: actual.tramiteId, numFactura: cambios.numFactura },
        },
      });
      if (existente) {
        throw new FacturaProveedorDuplicadaError(actual.tramiteId, cambios.numFactura);
      }
    }

    const updated = await tx.facturaProveedor.update({
      where: { id: facturaId },
      data: cambios,
    });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaId,
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
 * Elimina una factura de proveedor.
 * Rechaza si tiene pagos vinculados.
 */
export async function eliminarFacturaProveedor(
  facturaId: string,
  usuarioId: string,
): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.facturaProveedor.findUnique({
      where: { id: facturaId },
      include: { pagos: { select: { pagoId: true } } },
    });
    if (!actual) {
      throw new FacturaProveedorNoEncontradaError(facturaId);
    }

    // pagos es ahora PagoTramiteFactura[] (pivot N↔N)
    if (actual.pagos.length > 0) {
      throw new FacturaProveedorConPagosError(facturaId);
    }

    await tx.facturaProveedor.delete({ where: { id: facturaId } });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaId,
        accion: "DELETE",
        usuarioId,
        tramiteId: actual.tramiteId,
        antes: normalizeSerializable(actual),
      },
    });
  });
}

/**
 * Genera un PagoTramite desde una FacturaProveedor:
 * - Crea PagoTramite con valor/beneficiario/numSoporte de la factura.
 * - Vincula facturaProveedorId.
 * - Marca la factura como PAGADA.
 * - Registra auditoría de ambas entidades.
 * Todo en una transacción atómica.
 */
export async function generarPagoDesdeFactura(input: GenerarPagoInput) {
  const { facturaProveedorId, canalPago, viaSocio, fechaRealPago, usuarioId } = input;

  return prisma.$transaction(async (tx) => {
    const factura = await tx.facturaProveedor.findUnique({
      where: { id: facturaProveedorId },
      include: { beneficiario: { select: { nombre: true } } },
    });
    if (!factura) {
      throw new FacturaProveedorNoEncontradaError(facturaProveedorId);
    }
    if (factura.estado !== EstadoFacturaProveedor.REGISTRADA) {
      throw new FacturaProveedorNoModificableError(facturaProveedorId, factura.estado);
    }

    const costoBancario = await resolverCostoBancario(canalPago);

    const ultimoPago = await tx.pagoTramite.findFirst({
      where: { tramiteId: factura.tramiteId },
      orderBy: { orden: "desc" },
      select: { orden: true },
    });
    const orden = (ultimoPago?.orden ?? 0) + 1;

    const nombreProveedor = factura.beneficiario?.nombre ?? factura.proveedorNombre;

    const pago = await tx.pagoTramite.create({
      data: {
        tramiteId: factura.tramiteId,
        concepto: `Pago factura ${factura.numFactura} — ${nombreProveedor}`,
        numSoporte: factura.numFactura,
        valor: factura.valor,
        canalPago,
        costoBancario,
        orden,
        viaSocio,
        fechaRealPago,
      },
    });

    // Crear pivot record (N↔N)
    await tx.pagoTramiteFactura.create({
      data: { pagoId: pago.id, facturaId: facturaProveedorId },
    });

    // Marcar factura como PAGADA
    const facturaActualizada = await tx.facturaProveedor.update({
      where: { id: facturaProveedorId },
      data: { estado: EstadoFacturaProveedor.PAGADA },
    });

    await tx.auditLog.create({
      data: {
        entidad: "PagoTramite",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId,
        tramiteId: factura.tramiteId,
        despues: normalizeSerializable({ ...pago, facturaProveedorIds: [facturaProveedorId] }),
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaProveedorId,
        accion: "UPDATE_ESTADO",
        usuarioId,
        tramiteId: factura.tramiteId,
        antes: normalizeSerializable({ estado: factura.estado }),
        despues: normalizeSerializable({ estado: EstadoFacturaProveedor.PAGADA }),
      },
    });

    return { pago, factura: facturaActualizada };
  });
}

/**
 * Solicita la facturación de un trámite:
 * 1. Valida que el trámite tenga ≥1 pago registrado.
 * 2. Transiciona el estado del DO a ENVIADO_A_FACTURAR.
 * 3. Actualiza fechaEnviadoAFacturar.
 *
 * IMPORTANTE: La transición válida al estado ENVIADO_A_FACTURAR es desde DESPACHADO
 * (ver transitionMap en tramites/service.ts). Si el DO está en otro estado,
 * se retorna un error 422 con los estados válidos.
 */
export async function solicitarFacturacion(
  tramiteId: string,
  usuarioId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  // Verificar que tenga pagos
  const pagosCount = await prisma.pagoTramite.count({
    where: { tramiteId },
  });

  if (pagosCount === 0) {
    throw new TramiteSinPagosError(tramiteId);
  }

  // Intentar transición usando el servicio de trámites existente
  const result = await transitionTramite(tramiteId, EstadoTramite.ENVIADO_A_FACTURAR, usuarioId);

  if (!result.ok) {
    // Incluir estados válidos en el mensaje
    return {
      ok: false,
      status: result.status,
      message: result.message,
    };
  }

  // Actualizar fechaEnviadoAFacturar
  await prisma.tramiteDO.update({
    where: { id: tramiteId },
    data: { fechaEnviadoAFacturar: new Date() },
  });

  // Auto-crear borrador idempotente para PROPIO y SOCIO_LM. Nace con líneas
  // AUTO desde los pagos; el ADMIN (o Lucho, según el tipo de cliente) las
  // edita a mano en el editor de líneas.
  await ensureBorrador(tramiteId, usuarioId);

  return { ok: true };
}
