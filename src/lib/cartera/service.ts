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
import { CLAVES_UMBRAL, DEFAULTS_UMBRAL, getParametroBigInt } from "@/lib/parametros/service";

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

// ─── Conciliación batch (lote de facturas) ───────────────────────────────────

export type ConciliarLoteItem = {
  facturaId: string;
  destino: DestinoPago;
  tipo: TipoPagoFactura;
  monto: bigint;
  fecha: Date;
  tipoRecaudo?: TipoRecaudo;
  canalPago?: CanalPago;
  comprobanteKey?: string | null;
  verificadoBanco?: boolean;
};

export type ConciliarLoteItemResult =
  | { facturaId: string; destino: DestinoPago; ok: true; pagoId: string; saldoNeto: string }
  | { facturaId: string; destino: DestinoPago; ok: false; status: number; error: string };

export type ConciliarLoteResult = {
  ok: number;
  failed: number;
  total: number;
  loteAuditId: string;
  results: ConciliarLoteItemResult[];
};

type GetCarteraClienteInput = {
  clienteId: string;
  soloPendientes?: boolean;
  /** Filtro por fecha de emisión de la factura (inclusivo), formato YYYY-MM-DD. */
  desde?: string;
  hasta?: string;
  /**
   * Paginación server-side de las FILAS devueltas (D2-b, deuda Sprint 7:
   * "trae todas las facturas y agrega en memoria... con cinco años de
   * historia eso se degrada").
   *
   * OPCIONALES A PROPÓSITO: si se omiten (undefined), se devuelven TODAS las
   * facturas que cumplen el filtro — el comportamiento histórico. Eso es
   * necesario porque `getCarteraCliente` tiene otros dos callers que NO
   * pueden quedar truncados a una página: el export a Excel
   * (`/api/cartera/export`) y el PDF de estado de cuenta (`/api/cartera/pdf`)
   * necesitan el histórico COMPLETO del cliente. Solo el listado interactivo
   * (`GET /api/cartera` ← `cartera-workspace.tsx`) pasa `take`/`skip`
   * explícitos.
   */
  take?: number;
  skip?: number;
};

// ─── Agregados de cartera con paginación (D2-b) ──────────────────────────────
//
// Separación explícita "filas de la página" vs "agregados del total" (pedido
// en PENDIENTES.md D2-b): cruceCliente/cruceLM SIEMPRE se calculan sobre el
// conjunto COMPLETO de facturas que cumple los filtros de cliente/fecha —
// nunca sobre la página visible — porque son el saldo real de la cuenta, no
// una vista parcial. Si se calcularan solo sobre la página, el saldo
// mostrado mentiría en cuanto hubiera más de una página. Ver también la nota
// de `soloPendientes` en `getCarteraCliente`: ese filtro SÍ decide qué filas
// se muestran, pero NO afecta a cruceCliente/cruceLM (idéntico al
// comportamiento previo a D2-b).

/** Campos base de saldo de una factura, suficientes para derivar su saldoNeto. */
export type FacturaBaseLedger = {
  id: string;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
};

/** Σ abonos/devoluciones de una factura por destino, ya agregados en BD (groupBy). */
export type SumaPagosFactura = {
  abonosCliente: bigint;
  devolucionesCliente: bigint;
  abonosLM: bigint;
  devolucionesLM: bigint;
};

const SUMA_PAGOS_VACIA: SumaPagosFactura = {
  abonosCliente: 0n,
  devolucionesCliente: 0n,
  abonosLM: 0n,
  devolucionesLM: 0n,
};

export type AgregadoCarteraResult = {
  /** IDs de TODAS las facturas que cumplen el filtro (orden preservado), sin paginar. */
  idsFiltrados: string[];
  /** IDs de la página solicitada (take/skip aplicados sobre idsFiltrados). */
  idsPagina: string[];
  /** Total de facturas que cumplen el filtro — sobre el conjunto COMPLETO, no la página. */
  totalFacturas: number;
  /** Σ saldoNeto de TODAS las facturas del filtro (ignora soloPendientes y la paginación). */
  cruceCliente: bigint;
  cruceLM: bigint;
};

/**
 * Núcleo PURO del cálculo de agregados + paginación de cartera (D2-b).
 * Sin BD: recibe los campos base de saldo por factura y las sumas de
 * abonos/devoluciones ya agregadas (típicamente vía `pagoFactura.groupBy`),
 * y decide qué facturas quedan (según `soloPendientes`), cuántas hay en
 * total, y cuáles caen en la página pedida — todo en una sola pasada O(n).
 *
 * `take` opcional: si se omite, `idsPagina` es TODO `idsFiltrados` desde
 * `skip` (sin límite) — ver nota de "OPCIONALES A PROPÓSITO" en
 * `GetCarteraClienteInput`.
 */
export function calcularAgregadoCartera(
  facturasBase: FacturaBaseLedger[],
  sumasPorFactura: Map<string, SumaPagosFactura>,
  opciones: { soloPendientes: boolean; take?: number; skip?: number },
): AgregadoCarteraResult {
  let cruceCliente = 0n;
  let cruceLM = 0n;
  const idsFiltrados: string[] = [];

  for (const f of facturasBase) {
    const sumas = sumasPorFactura.get(f.id) ?? SUMA_PAGOS_VACIA;

    const saldoNetoCliente = calcularSaldoNeto({
      saldoAFavor: f.saldoAFavorCliente,
      saldoACargo: f.saldoACargoCliente,
      abonos: sumas.abonosCliente,
      devoluciones: sumas.devolucionesCliente,
    });
    const saldoNetoLM = calcularSaldoNeto({
      saldoAFavor: f.saldoAFavorLM,
      saldoACargo: f.saldoACargoLM,
      abonos: sumas.abonosLM,
      devoluciones: sumas.devolucionesLM,
    });

    // SIEMPRE se suma al cruce, sin importar soloPendientes ni la página.
    cruceCliente += saldoNetoCliente;
    cruceLM += saldoNetoLM;

    if (!opciones.soloPendientes || saldoNetoCliente !== 0n || saldoNetoLM !== 0n) {
      idsFiltrados.push(f.id);
    }
  }

  const skip = opciones.skip ?? 0;
  const idsPagina =
    opciones.take === undefined
      ? idsFiltrados.slice(skip)
      : idsFiltrados.slice(skip, skip + opciones.take);

  return {
    idsFiltrados,
    idsPagina,
    totalFacturas: idsFiltrados.length,
    cruceCliente,
    cruceLM,
  };
}

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

/**
 * Evalúa si la deuda acumulada de un cliente hacia Galcomex supera el umbral
 * de alerta de cartera (C2, reunión 1-jul-2026, 01:13:59–01:15:20):
 * "Vamos a alertar cuando ya el cliente esté bajo menos 20 millones. Ya eso
 * es una alerta importante. Vamos a mandarla al señor Guillermo." No es un
 * bloqueo — es una señal de riesgo de crédito para decidir si se sigue
 * dándole anticipos al cliente.
 *
 * Convención de signo — IDÉNTICA a `calcularSaldoNeto` de este mismo archivo
 * y a `cruceLabel`/`CruceTarjetas` en `cartera-workspace.tsx`:
 *   saldoNetoAcumulado > 0 → Galcomex le debe a la parte (saldo a favor)
 *   saldoNetoAcumulado < 0 → la parte le debe a Galcomex (pendiente de cobro)
 *
 * "El cliente está bajo menos 20 millones" (00:32:41: "tiene de 22 millones
 * a Galcomex... ya no puedo darle más plata") se traduce entonces como
 * saldoNetoAcumulado < -umbral, NO como |saldoNetoAcumulado| > umbral: un
 * cliente con saldo A FAVOR (Galcomex le debe) jamás dispara esta alerta sin
 * importar cuán grande sea ese saldo — la alerta es de cartera por cobrar
 * (riesgo de que el cliente no pague), no de magnitud de saldo en general.
 *
 * Se aplica igual a la vista CLIENTE y a la vista LM (mismo ledger, mismo
 * signo, dos acumulados independientes) — ver `getClientesEnAlertaCartera`.
 *
 * @param saldoNetoAcumulado  Σ saldoNeto (CLIENTE o LM) de todas las facturas del cliente.
 * @param umbral              Umbral de alerta en COP (política de negocio, editable).
 * @returns deuda = max(0, -saldoNetoAcumulado); alerta = saldoNetoAcumulado < -umbral.
 */
export function evaluarAlertaCarteraCliente(
  saldoNetoAcumulado: bigint,
  umbral: bigint,
): { deuda: bigint; alerta: boolean } {
  const deuda = saldoNetoAcumulado < 0n ? -saldoNetoAcumulado : 0n;
  return { deuda, alerta: saldoNetoAcumulado < -umbral };
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
  const { clienteId, soloPendientes = false, desde, hasta, take, skip } = input;

  // Filtro por periodo sobre la fecha de emisión de la factura (inclusivo en ambos extremos).
  const fechaFilter: Prisma.DateTimeFilter = {};
  if (desde) fechaFilter.gte = new Date(`${desde}T00:00:00.000Z`);
  if (hasta) fechaFilter.lte = new Date(`${hasta}T23:59:59.999Z`);
  const fechaWhere = desde || hasta ? { fecha: fechaFilter } : {};
  const where: Prisma.FacturaWhereInput = { clienteId, ...fechaWhere };

  // ── PASO 1: agregados sobre el conjunto COMPLETO (nunca paginado) ─────────
  // Dos consultas LIVIANAS en vez de la findMany con include completo (pagos
  // con todos sus campos + borrador + tramite) que traía TODO el histórico
  // del cliente de una sola vez — exactamente el problema de escala de D2-b.
  //
  // 1a) Solo los campos base de saldo por factura (sin relaciones).
  const facturasBase: FacturaBaseLedger[] = await prisma.factura.findMany({
    where,
    select: {
      id: true,
      saldoAFavorCliente: true,
      saldoACargoCliente: true,
      saldoAFavorLM: true,
      saldoACargoLM: true,
    },
    orderBy: { fecha: "desc" },
  });

  // 1b) Σ abonos/devoluciones por (factura, destino, tipo), agregado en BD
  // (groupBy) — nunca se traen las filas de PagoFactura una por una para
  // esto, solo las sumas ya reducidas por Postgres.
  const sumasRaw = await prisma.pagoFactura.groupBy({
    by: ["facturaId", "destino", "tipo"],
    where: { factura: where },
    _sum: { monto: true },
  });

  const sumasPorFactura = new Map<string, SumaPagosFactura>();
  for (const s of sumasRaw) {
    const acc = sumasPorFactura.get(s.facturaId) ?? { ...SUMA_PAGOS_VACIA };
    const monto = s._sum.monto ?? 0n;
    if (s.destino === DestinoPago.CLIENTE) {
      if (s.tipo === TipoPagoFactura.ABONO) acc.abonosCliente += monto;
      else acc.devolucionesCliente += monto;
    } else {
      if (s.tipo === TipoPagoFactura.ABONO) acc.abonosLM += monto;
      else acc.devolucionesLM += monto;
    }
    sumasPorFactura.set(s.facturaId, acc);
  }

  // Núcleo puro: decide qué facturas quedan (soloPendientes), cuántas hay en
  // total, y cuáles caen en la página — y calcula cruceCliente/cruceLM SIEMPRE
  // sobre el conjunto completo (ver calcularAgregadoCartera más arriba).
  const agregado = calcularAgregadoCartera(facturasBase, sumasPorFactura, {
    soloPendientes,
    take,
    skip,
  });

  // ── PASO 2: detalle completo — SOLO para las facturas de la página ────────
  const facturasDetalle =
    agregado.idsPagina.length > 0
      ? await prisma.factura.findMany({
          where: { id: { in: agregado.idsPagina } },
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
        })
      : [];

  // findMany con id:{in} no garantiza el orden de la lista — reordenar según
  // idsPagina (que ya viene en orden fecha desc, igual que antes de D2-b).
  const detallePorId = new Map(facturasDetalle.map((f) => [f.id, f]));
  const facturasOrdenadas = agregado.idsPagina
    .map((id) => detallePorId.get(id))
    .filter((f): f is (typeof facturasDetalle)[number] => f !== undefined);

  // Enriquecer cada factura de la PÁGINA con el ledger (idéntico cálculo
  // por-factura de siempre; ya no se hace para el histórico completo).
  const facturasEnriquecidas = facturasOrdenadas.map((f) => {
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

  // Costos bancarios agregados por destino (para "Total real a LM" del pie de
  // tabla en la UI) — SIEMPRE sobre el conjunto COMPLETO, igual que
  // cruceCliente/cruceLM (no la página, y sin filtrar por soloPendientes, por
  // consistencia con esos otros dos agregados). Antes de D2-b este total se
  // calculaba en el cliente sumando sobre `facturas` (que era el histórico
  // completo, así que coincidía); con la página ya no alcanza — se agrega
  // aquí con el mismo groupBy liviano que las sumas de abonos/devoluciones.
  // Fórmula pendiente de confirmar con Camila (ver nota en el enriquecimiento
  // por factura más arriba).
  const costosBancariosPorDestino = await prisma.pagoFactura.groupBy({
    by: ["destino"],
    where: { factura: where },
    _sum: { costoBancario: true },
  });
  let costosBancariosClienteTotal = 0n;
  let costosBancariosLMTotal = 0n;
  for (const c of costosBancariosPorDestino) {
    const suma = c._sum.costoBancario ?? 0n;
    if (c.destino === DestinoPago.CLIENTE) costosBancariosClienteTotal = suma;
    else costosBancariosLMTotal = suma;
  }
  const totalRealLM =
    agregado.cruceLM - costosBancariosClienteTotal - costosBancariosLMTotal;

  return {
    // Solo la página pedida (o todo, si take se omitió — ver GetCarteraClienteInput).
    facturas: facturasEnriquecidas,
    // Agregados SIEMPRE sobre el conjunto completo — NUNCA sobre `facturas` de arriba.
    cruceCliente: agregado.cruceCliente,
    cruceLM: agregado.cruceLM,
    totalFacturas: agregado.totalFacturas,
    totalRealLM,
  };
}

/** Cliente cuya deuda acumulada con Galcomex supera el umbral en la vista CLIENTE y/o la vista LM (C2). */
export type ClienteEnAlertaCarteraRow = {
  clienteId: string;
  clienteNombre: string;
  saldoNetoCliente: string; // BigInt as string — Σ saldoNeto CLIENTE; negativo = cliente debe a Galcomex
  saldoNetoLM: string;      // BigInt as string — Σ saldoNeto LM; negativo = LM (Lucho) debe a Galcomex
  alertaCliente: boolean;
  alertaLM: boolean;
};

/**
 * Agrega el ledger (WS-D) por CLIENTE en lugar de por factura suelta y aplica
 * `evaluarAlertaCarteraCliente` a los dos acumulados (CLIENTE y LM) de cada
 * cliente. Devuelve solo los clientes con al menos una de las dos vistas en
 * alerta (C2, reunión 1-jul-2026, 01:13:59–01:15:20).
 *
 * A diferencia de `getCarteraCliente` (que exige un `clienteId` y trae el
 * detalle de pagos), esta función recorre TODAS las facturas una sola vez
 * para poder comparar el acumulado de cada cliente contra el umbral —
 * necesario porque hoy `carteraVencida` en el dashboard evalúa factura por
 * factura, sin agregación por cliente ni umbral de política.
 */
export async function getClientesEnAlertaCartera(): Promise<ClienteEnAlertaCarteraRow[]> {
  const umbral = await getParametroBigInt(
    CLAVES_UMBRAL.carteraCliente,
    DEFAULTS_UMBRAL.carteraCliente,
  );

  const facturas = await prisma.factura.findMany({
    select: {
      clienteId: true,
      cliente: { select: { nombre: true } },
      saldoAFavorCliente: true,
      saldoACargoCliente: true,
      saldoAFavorLM: true,
      saldoACargoLM: true,
      pagos: { select: { destino: true, tipo: true, monto: true } },
    },
  });

  const acumuladoPorCliente = new Map<
    string,
    { nombre: string; saldoNetoCliente: bigint; saldoNetoLM: bigint }
  >();

  for (const f of facturas) {
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

    const acumulado = acumuladoPorCliente.get(f.clienteId) ?? {
      nombre: f.cliente.nombre,
      saldoNetoCliente: 0n,
      saldoNetoLM: 0n,
    };
    acumulado.saldoNetoCliente += saldoNetoCliente;
    acumulado.saldoNetoLM += saldoNetoLM;
    acumuladoPorCliente.set(f.clienteId, acumulado);
  }

  const rows: ClienteEnAlertaCarteraRow[] = [];
  for (const [clienteId, acumulado] of acumuladoPorCliente) {
    const evalCliente = evaluarAlertaCarteraCliente(acumulado.saldoNetoCliente, umbral);
    const evalLM = evaluarAlertaCarteraCliente(acumulado.saldoNetoLM, umbral);

    if (!evalCliente.alerta && !evalLM.alerta) continue;

    rows.push({
      clienteId,
      clienteNombre: acumulado.nombre,
      saldoNetoCliente: acumulado.saldoNetoCliente.toString(),
      saldoNetoLM: acumulado.saldoNetoLM.toString(),
      alertaCliente: evalCliente.alerta,
      alertaLM: evalLM.alerta,
    });
  }

  // Los más urgentes (mayor deuda combinada) primero.
  rows.sort((a, b) => {
    const deudaA = (BigInt(a.saldoNetoCliente) < 0n ? -BigInt(a.saldoNetoCliente) : 0n) +
      (BigInt(a.saldoNetoLM) < 0n ? -BigInt(a.saldoNetoLM) : 0n);
    const deudaB = (BigInt(b.saldoNetoCliente) < 0n ? -BigInt(b.saldoNetoCliente) : 0n) +
      (BigInt(b.saldoNetoLM) < 0n ? -BigInt(b.saldoNetoLM) : 0n);
    return deudaA < deudaB ? 1 : deudaA > deudaB ? -1 : 0;
  });

  return rows;
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

/**
 * Conciliación batch de múltiples facturas (lote).
 *
 * Cada ítem se procesa en su PROPIA transacción (ejecución parcial). Los advisory
 * locks de `registrarPagoFacturaAbono` solo se sostienen durante su tx individual.
 * Devuelve un array de resultados por ítem y registra un AuditLog "paraguas" con
 * trazabilidad del lote.
 */
export async function conciliarLoteFacturas(input: {
  items: ConciliarLoteItem[];
  usuarioId: string;
}): Promise<ConciliarLoteResult> {
  const { items, usuarioId } = input;

  // 1) Crear AuditLog paraguas (entidad="ConciliacionBatchCartera") en estado EN_PROCESO.
  //    entidadId se rellena con el propio id después de la creación.
  const loteAudit = await prisma.auditLog.create({
    data: {
      entidad: "ConciliacionBatchCartera",
      entidadId: "", // placeholder; se actualiza justo abajo
      accion: "CREATE",
      usuarioId,
      antes: Prisma.JsonNull,
      despues: normalizeSerializable({
        totalItems: items.length,
        status: "EN_PROCESO",
        pagoIds: [],
      }),
    },
  });

  // Actualizar entidadId = id propio para que el índice [entidad, entidadId] sea usable.
  await prisma.auditLog.update({
    where: { id: loteAudit.id },
    data: { entidadId: loteAudit.id },
  });

  // 2) Procesar cada ítem de forma secuencial (cada uno en su propia tx).
  const results: ConciliarLoteItemResult[] = [];

  for (const item of items) {
    try {
      const r = await registrarPagoFacturaAbono({ ...item, usuarioId });
      if (r.ok) {
        results.push({
          facturaId: item.facturaId,
          destino: item.destino,
          ok: true,
          pagoId: r.pago.id,
          saldoNeto: r.saldoNeto.toString(),
        });
      } else {
        results.push({
          facturaId: item.facturaId,
          destino: item.destino,
          ok: false,
          status: r.status,
          error: r.message,
        });
      }
    } catch (err) {
      results.push({
        facturaId: item.facturaId,
        destino: item.destino,
        ok: false,
        status: 500,
        error: err instanceof Error ? err.message : "Error desconocido",
      });
    }
  }

  // 3) Calcular totales y actualizar el AuditLog paraguas con el resultado final.
  const okCount = results.filter((r) => r.ok).length;
  const failedCount = results.length - okCount;
  const batchStatus =
    failedCount === 0 ? "COMPLETADO" : okCount === 0 ? "FALLIDO" : "PARCIAL";

  const pagoIds = results
    .filter((r): r is Extract<ConciliarLoteItemResult, { ok: true }> => r.ok)
    .map((r) => r.pagoId);

  const errores = results
    .filter((r): r is Extract<ConciliarLoteItemResult, { ok: false }> => !r.ok)
    .map((r) => ({ facturaId: r.facturaId, destino: r.destino, error: r.error }));

  await prisma.auditLog.update({
    where: { id: loteAudit.id },
    data: {
      despues: normalizeSerializable({
        totalItems: items.length,
        ok: okCount,
        failed: failedCount,
        status: batchStatus,
        pagoIds,
        errores,
      }),
    },
  });

  return {
    ok: okCount,
    failed: failedCount,
    total: items.length,
    loteAuditId: loteAudit.id,
    results,
  };
}
