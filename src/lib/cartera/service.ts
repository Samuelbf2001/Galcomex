/**
 * Servicio de cartera — Galcomex
 * WS-D: Gestión de facturas, abonos parciales y devoluciones.
 *
 * Implementa:
 * - calcularSaldoNeto: fórmula del ledger por (factura, destino)
 * - registrarPagoFacturaAbono (NUEVO): crea PagoFactura con advisory lock + recalcula fechaPago
 * - eliminarPagoFactura: revierte PagoFactura + recalcula fechaPago
 * - getCarteraCliente: lista facturas enriquecidas con saldoNeto, abonos, devoluciones
 * - getFacturaConPagos: detalle de factura con lista de PagoFactura
 * - registrarPagoFactura (DEPRECADO): escribe fechaPagoCliente/LM directamente (compat)
 */

import { CanalPago, DestinoPago, EstadoMovimiento, Prisma, Rol, TipoPagoFactura, TipoRecaudo } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** @deprecated Usar registrarPagoFacturaAbono en su lugar */
type RegistrarPagoFacturaLegacyInput = {
  facturaId: string;
  fechaPagoCliente?: Date;
  fechaPagoLM?: Date;
  usuarioId: string;
};

type RegistrarPagoFacturaInput = {
  facturaId: string;
  destino: DestinoPago;
  tipo: TipoPagoFactura;
  monto: bigint;
  fecha: Date;
  /** Exactamente uno de (tipoRecaudo, canalPago) debe estar seteado. */
  tipoRecaudo?: TipoRecaudo;
  canalPago?: CanalPago;
  comprobanteKey?: string | null;
  verificadoBanco?: boolean;
  usuarioId: string;
};

type GetCarteraClienteInput = {
  clienteId: string;
  soloPendientes?: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

/**
 * Ledger unificado por (factura, destino).
 *
 * Convención: positivo = Galcomex debe a esa parte.
 *
 * saldoNeto = (saldoAFavor − saldoACargo) + Σ(ABONO) − Σ(DEVOLUCION)
 *   > 0 → Galcomex debe → pendiente de devolución
 *   < 0 → la parte debe → pendiente de cobro = |saldoNeto|
 *   = 0 → saldada
 */
export function calcularSaldoNeto({
  saldoAFavor,
  saldoACargo,
  abonos,
  devoluciones,
}: {
  saldoAFavor: bigint;
  saldoACargo: bigint;
  abonos: bigint;
  devoluciones: bigint;
}): bigint {
  return saldoAFavor - saldoACargo + abonos - devoluciones;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Registra un abono o devolución sobre una factura (WS-D).
 *
 * Reglas:
 * - monto siempre > 0 (validado en Zod antes de llegar aquí, pero se re-verifica).
 * - Exactamente uno de (tipoRecaudo, canalPago) debe estar seteado; si no → 400.
 * - costoBancario se toma como snapshot desde matriz_recaudo o matriz_pago.
 * - ABONO: siempre permitido; si sobrepasa el cargo genera pendiente de devolución.
 * - DEVOLUCION: solo si hay saldo a favor disponible (saldoNeto > 0); si excede → 422.
 * - Cuando saldoNeto llega a 0, setea fechaPago{Cliente|LM}; si se aleja de 0, la limpia.
 * - Advisory lock por (facturaId + destino) para evitar condición de carrera.
 * - AuditLog por cada operación.
 */
export async function registrarPagoFacturaAbono(input: RegistrarPagoFacturaInput) {
  const {
    facturaId,
    destino,
    tipo,
    monto,
    fecha,
    tipoRecaudo,
    canalPago,
    comprobanteKey,
    verificadoBanco,
    usuarioId,
  } = input;

  if (monto <= 0n) {
    return { ok: false as const, status: 400, message: "El monto debe ser mayor a 0" };
  }

  // Validar que exactamente uno de (tipoRecaudo, canalPago) esté seteado
  const hasRecaudo = tipoRecaudo !== undefined;
  const hasCanal = canalPago !== undefined;
  if (hasRecaudo === hasCanal) {
    return {
      ok: false as const,
      status: 400,
      message:
        "Debe especificarse exactamente uno de tipoRecaudo o canalPago (no ambos, no ninguno).",
    };
  }

  // Resolver costoBancario snapshot desde la matriz correspondiente
  let costoBancario = 0n;
  if (hasRecaudo && tipoRecaudo) {
    const matrizRec = await prisma.matrizRecaudo.findUnique({
      where: { tipoRecaudo },
    });
    costoBancario = matrizRec?.costoFijo ?? 0n;
  } else if (hasCanal && canalPago) {
    const matrizPago = await prisma.matrizPago.findUnique({
      where: { canalPago },
    });
    costoBancario = matrizPago?.costoFijo ?? 0n;
  }

  const lockKey = `pago_factura:${facturaId}:${destino}`;

  return prisma.$transaction(async (tx) => {
    // Advisory lock para evitar carreras bajo concurrencia
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const factura = await tx.factura.findUnique({
      where: { id: facturaId },
      include: {
        pagos: {
          where: { destino },
          select: { tipo: true, monto: true },
        },
      },
    });

    if (!factura) {
      return { ok: false as const, status: 404, message: `Factura ${facturaId} no encontrada` };
    }

    const saldoAFavor = destino === DestinoPago.CLIENTE
      ? factura.saldoAFavorCliente
      : factura.saldoAFavorLM;
    const saldoACargo = destino === DestinoPago.CLIENTE
      ? factura.saldoACargoCliente
      : factura.saldoACargoLM;

    const pagosDestino = factura.pagos;
    const abonosActuales = pagosDestino
      .filter((p) => p.tipo === TipoPagoFactura.ABONO)
      .reduce((sum, p) => sum + p.monto, 0n);
    const devolucionesActuales = pagosDestino
      .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
      .reduce((sum, p) => sum + p.monto, 0n);

    const saldoNetoActual = calcularSaldoNeto({
      saldoAFavor,
      saldoACargo,
      abonos: abonosActuales,
      devoluciones: devolucionesActuales,
    });

    // Validar DEVOLUCION: no puede exceder el saldo a favor disponible
    if (tipo === TipoPagoFactura.DEVOLUCION) {
      if (saldoNetoActual <= 0n) {
        return {
          ok: false as const,
          status: 422,
          message: `No hay saldo a favor disponible para devolver en el destino ${destino}. Saldo neto actual: ${saldoNetoActual}`,
        };
      }
      if (monto > saldoNetoActual) {
        return {
          ok: false as const,
          status: 422,
          message: `La devolución (${monto}) excede el saldo a favor disponible (${saldoNetoActual}) para el destino ${destino}`,
        };
      }
    }

    // Crear el PagoFactura con tipoRecaudo/canalPago y costoBancario
    const pago = await tx.pagoFactura.create({
      data: {
        facturaId,
        destino,
        tipo,
        monto,
        fecha,
        tipoRecaudo: tipoRecaudo ?? null,
        canalPago: canalPago ?? null,
        costoBancario,
        comprobanteKey: comprobanteKey ?? null,
        verificadoBanco: verificadoBanco ?? false,
        registradoPorId: usuarioId,
      },
    });

    // Recalcular saldoNeto nuevo
    const nuevosAbonos = tipo === TipoPagoFactura.ABONO
      ? abonosActuales + monto
      : abonosActuales;
    const nuevasDevoluciones = tipo === TipoPagoFactura.DEVOLUCION
      ? devolucionesActuales + monto
      : devolucionesActuales;

    const saldoNetoNuevo = calcularSaldoNeto({
      saldoAFavor,
      saldoACargo,
      abonos: nuevosAbonos,
      devoluciones: nuevasDevoluciones,
    });

    // Determinar si se debe setear o limpiar la fechaPago del destino
    const facturaUpdateData: Prisma.FacturaUpdateInput = {};
    if (destino === DestinoPago.CLIENTE) {
      facturaUpdateData.fechaPagoCliente = saldoNetoNuevo === 0n ? fecha : null;
    } else {
      facturaUpdateData.fechaPagoLM = saldoNetoNuevo === 0n ? fecha : null;
    }

    const facturaActualizada = await tx.factura.update({
      where: { id: facturaId },
      data: facturaUpdateData,
    });

    // Audit log — incluye tipoRecaudo/canalPago/costoBancario en el snapshot
    await tx.auditLog.create({
      data: {
        entidad: "PagoFactura",
        entidadId: pago.id,
        accion: "CREATE",
        usuarioId,
        antes: Prisma.JsonNull,
        despues: normalizeSerializable({
          pagoId: pago.id,
          facturaId,
          destino,
          tipo,
          monto: monto.toString(),
          fecha,
          tipoRecaudo: tipoRecaudo ?? null,
          canalPago: canalPago ?? null,
          costoBancario: costoBancario.toString(),
          saldoNetoAntes: saldoNetoActual.toString(),
          saldoNetoNuevo: saldoNetoNuevo.toString(),
        }),
      },
    });

    return {
      ok: true as const,
      pago,
      factura: facturaActualizada,
      saldoNeto: saldoNetoNuevo,
    };
  });
}

/**
 * Elimina un PagoFactura y recalcula saldoNeto + fechaPago del destino.
 */
export async function eliminarPagoFactura(pagoId: string, usuarioId: string) {
  return prisma.$transaction(async (tx) => {
    const pago = await tx.pagoFactura.findUnique({
      where: { id: pagoId },
      include: { factura: true },
    });

    if (!pago) {
      return { ok: false as const, status: 404, message: `PagoFactura ${pagoId} no encontrado` };
    }

    const lockKey = `pago_factura:${pago.facturaId}:${pago.destino}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Snapshot antes de borrar
    const snapshotAntes = normalizeSerializable({
      pagoId: pago.id,
      facturaId: pago.facturaId,
      destino: pago.destino,
      tipo: pago.tipo,
      monto: pago.monto.toString(),
      fecha: pago.fecha,
      tipoRecaudo: pago.tipoRecaudo ?? null,
      canalPago: pago.canalPago ?? null,
      costoBancario: pago.costoBancario.toString(),
    });

    await tx.pagoFactura.delete({ where: { id: pagoId } });

    // Recalcular saldoNeto desde cero con los pagos restantes
    const pagosRestantes = await tx.pagoFactura.findMany({
      where: { facturaId: pago.facturaId, destino: pago.destino },
      select: { tipo: true, monto: true },
    });

    const factura = pago.factura;
    const saldoAFavor = pago.destino === DestinoPago.CLIENTE
      ? factura.saldoAFavorCliente
      : factura.saldoAFavorLM;
    const saldoACargo = pago.destino === DestinoPago.CLIENTE
      ? factura.saldoACargoCliente
      : factura.saldoACargoLM;

    const abonos = pagosRestantes
      .filter((p) => p.tipo === TipoPagoFactura.ABONO)
      .reduce((sum, p) => sum + p.monto, 0n);
    const devoluciones = pagosRestantes
      .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
      .reduce((sum, p) => sum + p.monto, 0n);

    const saldoNetoNuevo = calcularSaldoNeto({ saldoAFavor, saldoACargo, abonos, devoluciones });

    // Limpiar la fechaPago si el saldo ya no es 0
    const facturaUpdateData: Prisma.FacturaUpdateInput = {};
    if (pago.destino === DestinoPago.CLIENTE) {
      facturaUpdateData.fechaPagoCliente = saldoNetoNuevo === 0n ? factura.fechaPagoCliente : null;
    } else {
      facturaUpdateData.fechaPagoLM = saldoNetoNuevo === 0n ? factura.fechaPagoLM : null;
    }

    const facturaActualizada = await tx.factura.update({
      where: { id: pago.facturaId },
      data: facturaUpdateData,
    });

    await tx.auditLog.create({
      data: {
        entidad: "PagoFactura",
        entidadId: pagoId,
        accion: "DELETE",
        usuarioId,
        antes: snapshotAntes,
        despues: normalizeSerializable({ saldoNetoNuevo: saldoNetoNuevo.toString() }),
      },
    });

    return {
      ok: true as const,
      factura: facturaActualizada,
      saldoNeto: saldoNetoNuevo,
    };
  });
}

/**
 * Retorna las facturas del cliente enriquecidas con saldoNeto por destino,
 * abonos/devoluciones y lista de pagos.
 *
 * soloPendientes=true incluye solo facturas donde saldoNetoCliente != 0 OR saldoNetoLM != 0.
 * (reemplaza el antiguo filtro por fechaPagoCliente === null)
 *
 * cruceCliente = Σ saldoNetoCliente de todas las facturas (saldo global de cartera CLIENTE)
 * cruceLM      = Σ saldoNetoLM
 *
 * Campos derivados adicionales por factura (aditivos):
 *   costosBancariosCliente = Σ costoBancario de pagos destino=CLIENTE
 *   costosBancariosLM      = Σ costoBancario de pagos destino=LM
 *   totalRealLM            = saldoNetoLM − costosBancariosCliente − costosBancariosLM
 *   NOTA: La fórmula exacta de totalRealLM está pendiente de confirmar con Camila.
 *         Interpretación actual: saldo LM neto descontando todos los costos bancarios
 *         generados por pagos del cliente y pagos a LM.
 */
export async function getCarteraCliente(input: GetCarteraClienteInput) {
  const { clienteId, soloPendientes = false } = input;

  const facturas = await prisma.factura.findMany({
    where: { clienteId },
    include: {
      borrador: {
        select: {
          tramiteId: true,
          tramite: {
            select: { consecutivo: true },
          },
        },
      },
      pagos: {
        orderBy: { fecha: "asc" },
      },
    },
    orderBy: { fecha: "desc" },
  });

  // Enriquecer cada factura con el ledger
  const facturasEnriquecidas = facturas.map((f) => {
    const pagosCliente = f.pagos.filter((p) => p.destino === DestinoPago.CLIENTE);
    const pagosLM = f.pagos.filter((p) => p.destino === DestinoPago.LM);

    const abonosCliente = pagosCliente
      .filter((p) => p.tipo === TipoPagoFactura.ABONO)
      .reduce((sum, p) => sum + p.monto, 0n);
    const devolucionesCliente = pagosCliente
      .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
      .reduce((sum, p) => sum + p.monto, 0n);
    const saldoNetoCliente = calcularSaldoNeto({
      saldoAFavor: f.saldoAFavorCliente,
      saldoACargo: f.saldoACargoCliente,
      abonos: abonosCliente,
      devoluciones: devolucionesCliente,
    });

    const abonosLM = pagosLM
      .filter((p) => p.tipo === TipoPagoFactura.ABONO)
      .reduce((sum, p) => sum + p.monto, 0n);
    const devolucionesLM = pagosLM
      .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
      .reduce((sum, p) => sum + p.monto, 0n);
    const saldoNetoLM = calcularSaldoNeto({
      saldoAFavor: f.saldoAFavorLM,
      saldoACargo: f.saldoACargoLM,
      abonos: abonosLM,
      devoluciones: devolucionesLM,
    });

    // Campos derivados aditivos — costos bancarios por destino
    const costosBancariosCliente = pagosCliente.reduce(
      (sum, p) => sum + p.costoBancario,
      0n,
    );
    const costosBancariosLM = pagosLM.reduce(
      (sum, p) => sum + p.costoBancario,
      0n,
    );
    // NOTA: Fórmula pendiente de confirmar con Camila.
    // Interpretación actual: LM recibe saldoNetoLM menos todos los costos bancarios
    // incurridos tanto en el cobro al cliente como en el pago a él.
    const totalRealLM = saldoNetoLM - costosBancariosCliente - costosBancariosLM;

    return {
      ...f,
      // Ledger CLIENTE
      abonosCliente,
      devolucionesCliente,
      saldoNetoCliente,
      pendienteCobroCliente: saldoNetoCliente < 0n ? -saldoNetoCliente : 0n,
      pendienteDevolucionCliente: saldoNetoCliente > 0n ? saldoNetoCliente : 0n,
      // Ledger LM
      abonosLM,
      devolucionesLM,
      saldoNetoLM,
      pendienteCobroLM: saldoNetoLM < 0n ? -saldoNetoLM : 0n,
      pendienteDevolucionLM: saldoNetoLM > 0n ? saldoNetoLM : 0n,
      // Campos derivados de costos bancarios (aditivos)
      costosBancariosCliente,
      costosBancariosLM,
      totalRealLM,
    };
  });

  // Filtro de pendientes: saldo neto distinto de 0 en cualquier destino
  const facturasFiltradas = soloPendientes
    ? facturasEnriquecidas.filter(
        (f) => f.saldoNetoCliente !== 0n || f.saldoNetoLM !== 0n,
      )
    : facturasEnriquecidas;

  // Cruces totales (suma de saldoNeto de todas las facturas del cliente)
  const cruceCliente = facturasEnriquecidas.reduce(
    (acc, f) => acc + f.saldoNetoCliente,
    0n,
  );
  const cruceLM = facturasEnriquecidas.reduce(
    (acc, f) => acc + f.saldoNetoLM,
    0n,
  );

  return {
    facturas: facturasFiltradas,
    cruceCliente,
    cruceLM,
    totalFacturas: facturasFiltradas.length,
  };
}

/**
 * Retorna el detalle de una factura con su lista completa de PagoFactura.
 *
 * Campos derivados adicionales (aditivos):
 *   costosBancariosCliente = Σ costoBancario de pagos destino=CLIENTE
 *   costosBancariosLM      = Σ costoBancario de pagos destino=LM
 *   totalRealLM            = saldoNetoLM − costosBancariosCliente − costosBancariosLM
 *   NOTA: La fórmula exacta de totalRealLM está pendiente de confirmar con Camila.
 */
export async function getFacturaConPagos(facturaId: string) {
  const factura = await prisma.factura.findUnique({
    where: { id: facturaId },
    include: {
      borrador: {
        select: {
          tramiteId: true,
          tramite: { select: { consecutivo: true } },
        },
      },
      pagos: {
        include: {
          registradoPor: { select: { id: true, name: true, email: true } },
        },
        orderBy: { fecha: "asc" },
      },
    },
  });

  if (!factura) return null;

  const pagosCliente = factura.pagos.filter((p) => p.destino === DestinoPago.CLIENTE);
  const pagosLM = factura.pagos.filter((p) => p.destino === DestinoPago.LM);

  const abonosCliente = pagosCliente.filter((p) => p.tipo === TipoPagoFactura.ABONO).reduce((s, p) => s + p.monto, 0n);
  const devolucionesCliente = pagosCliente.filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION).reduce((s, p) => s + p.monto, 0n);
  const saldoNetoCliente = calcularSaldoNeto({
    saldoAFavor: factura.saldoAFavorCliente,
    saldoACargo: factura.saldoACargoCliente,
    abonos: abonosCliente,
    devoluciones: devolucionesCliente,
  });

  const abonosLM = pagosLM.filter((p) => p.tipo === TipoPagoFactura.ABONO).reduce((s, p) => s + p.monto, 0n);
  const devolucionesLM = pagosLM.filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION).reduce((s, p) => s + p.monto, 0n);
  const saldoNetoLM = calcularSaldoNeto({
    saldoAFavor: factura.saldoAFavorLM,
    saldoACargo: factura.saldoACargoLM,
    abonos: abonosLM,
    devoluciones: devolucionesLM,
  });

  // Campos derivados aditivos — costos bancarios por destino
  const costosBancariosCliente = pagosCliente.reduce((s, p) => s + p.costoBancario, 0n);
  const costosBancariosLM = pagosLM.reduce((s, p) => s + p.costoBancario, 0n);
  // NOTA: Fórmula pendiente de confirmar con Camila.
  const totalRealLM = saldoNetoLM - costosBancariosCliente - costosBancariosLM;

  return {
    ...factura,
    saldoNetoCliente,
    pendienteCobroCliente: saldoNetoCliente < 0n ? -saldoNetoCliente : 0n,
    pendienteDevolucionCliente: saldoNetoCliente > 0n ? saldoNetoCliente : 0n,
    saldoNetoLM,
    pendienteCobroLM: saldoNetoLM < 0n ? -saldoNetoLM : 0n,
    pendienteDevolucionLM: saldoNetoLM > 0n ? saldoNetoLM : 0n,
    // Campos derivados aditivos
    costosBancariosCliente,
    costosBancariosLM,
    totalRealLM,
  };
}

// ─── Verificación de PagoFactura ─────────────────────────────────────────────

export class VerificarPagoFacturaPermisoError extends Error {
  public readonly status = 403;
  constructor() {
    super("No tienes permiso para verificar este pago de factura");
    this.name = "VerificarPagoFacturaPermisoError";
  }
}

/**
 * Cambia el estado de un PagoFactura (BORRADOR → REALIZADO → VERIFICADO).
 * Regla de permiso:
 *   - Factura de cliente SOCIO_LM: solo ADMIN puede verificar.
 *   - Factura de cliente PROPIO: ADMIN o OPERATIVO pueden verificar.
 */
export async function verificarPagoFactura(
  pagoId: string,
  nuevoEstado: EstadoMovimiento,
  usuarioRol: Rol,
) {
  const pago = await prisma.pagoFactura.findUnique({
    where: { id: pagoId },
    include: {
      factura: { include: { cliente: { select: { tipo: true } } } },
    },
  });

  if (!pago) {
    return { ok: false as const, status: 404, message: `PagoFactura ${pagoId} no encontrado` };
  }

  const esClienteSocioLM = pago.factura.cliente.tipo === "SOCIO_LM";
  const puedeVerificar = usuarioRol === Rol.ADMIN ||
    (!esClienteSocioLM && usuarioRol === Rol.OPERATIVO);

  if (!puedeVerificar) {
    throw new VerificarPagoFacturaPermisoError();
  }

  const updated = await prisma.pagoFactura.update({
    where: { id: pagoId },
    data: { estado: nuevoEstado },
  });

  return { ok: true as const, pago: updated };
}

// ─── Compatibilidad — DEPRECATED ─────────────────────────────────────────────

/**
 * @deprecated POST /api/facturas/[id]/pago (fecha).
 * La UI migrará a /api/facturas/[id]/pagos en WS-E.
 * Conservado para no romper la integración existente.
 *
 * Escribe fechaPagoCliente/LM directamente sin crear PagoFactura.
 */
export async function registrarPagoFactura(input: RegistrarPagoFacturaLegacyInput) {
  const { facturaId, fechaPagoCliente, fechaPagoLM, usuarioId } = input;

  return prisma.$transaction(async (tx) => {
    const factura = await tx.factura.findUnique({
      where: { id: facturaId },
    });

    if (!factura) {
      return { ok: false as const, status: 404, message: `Factura ${facturaId} no encontrada` };
    }

    const data: Prisma.FacturaUpdateInput = {};
    if (fechaPagoCliente !== undefined) {
      data.fechaPagoCliente = fechaPagoCliente;
    }
    if (fechaPagoLM !== undefined) {
      data.fechaPagoLM = fechaPagoLM;
    }

    const updated = await tx.factura.update({
      where: { id: facturaId },
      data,
    });

    await tx.auditLog.create({
      data: {
        entidad: "Factura",
        entidadId: facturaId,
        accion: "UPDATE",
        usuarioId,
        antes: normalizeSerializable({
          fechaPagoCliente: factura.fechaPagoCliente,
          fechaPagoLM: factura.fechaPagoLM,
        }),
        despues: normalizeSerializable({
          fechaPagoCliente: updated.fechaPagoCliente,
          fechaPagoLM: updated.fechaPagoLM,
        }),
      },
    });

    return { ok: true as const, factura: updated };
  });
}
