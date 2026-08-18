/**
 * Servicio de lotes de pago — Galcomex (reunión 1-jul-2026, 00:48–00:50).
 *
 * Karina paga la cartera del puerto de una sola transacción bancaria que
 * cubre facturas de proveedor de VARIOS trámites (DOs) a la vez. Hoy el
 * sistema solo permite pagar facturas de UN trámite por pago, así que ella
 * termina armando carpetas por fuera — justo el reproceso que había que
 * eliminar.
 *
 * DECISIÓN DE DISEÑO (ya tomada, ver CLAUDE.md / prisma/schema.prisma):
 * el modelo AGRUPA, no fusiona. Aflojar `PagoTramite.tramiteId` habría
 * obligado a rehacer el motor de cálculo y sus casos dorados intocables. En
 * vez de eso, `LotePago` agrupa varios `PagoTramite` — se sigue creando UNO
 * por trámite, cada uno con su propio `tramiteId` y `valor`, así que los
 * saldos por trámite cuadran exactamente igual que con un pago suelto. El
 * lote solo comparte comprobante, fecha, canal y referencia bancaria.
 */

import { type CanalPago, EstadoFacturaProveedor, type LotePago, type PagoTramite, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  FacturaProveedorNoEncontradaError,
  FacturaProveedorNoModificableError,
} from "@/lib/facturas-proveedor/service";
import { CLAVES_UMBRAL, DEFAULTS_UMBRAL, getParametroBool } from "@/lib/parametros/service";
import {
  agruparFacturasPorTramite,
  repartirCostoBancario,
  type FacturaLoteItem,
} from "@/lib/pagos/lotes-pago-calculo";
import { ComprobanteObligatorioError, crearPagoEnTx, resolverCostoBancario } from "@/lib/pagos/service";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type FacturaLotePagoInput = {
  facturaProveedorId: string;
  /** Monto pagado de ESTA factura en este lote (COP, puede ser parcial). */
  valor: bigint;
};

export type CrearLotePagoInput = {
  fechaPago: Date;
  canalPago: CanalPago;
  /** Nro. de operación del extracto bancario. */
  referencia?: string | null;
  /** Comprobante ÚNICO del desembolso, ya subido y registrado como Documento. */
  documentoId?: string | null;
  facturas: FacturaLotePagoInput[];
  /** Misma semántica que `crearPago`: confirma la desviación pago↔facturas si aplica, por trámite. */
  confirmarDesviacion?: boolean;
  usuarioId: string;
};

export type LotePagoResultado = {
  lote: LotePago;
  pagos: PagoTramite[];
};

// ─── Errores tipados ──────────────────────────────────────────────────────────

export class LoteSinFacturasError extends Error {
  public readonly status = 422;
  constructor() {
    super("Un lote de pago debe incluir al menos una factura.");
    this.name = "LoteSinFacturasError";
  }
}

export class FacturaDuplicadaEnLoteError extends Error {
  public readonly status = 422;
  constructor(facturaProveedorId: string) {
    super(`La factura ${facturaProveedorId} está repetida en el lote.`);
    this.name = "FacturaDuplicadaEnLoteError";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/** Concepto legible del PagoTramite generado para un grupo del lote. */
function construirConcepto(numFacturas: string[]): string {
  const lista = numFacturas.join(", ");
  return numFacturas.length === 1
    ? `Pago de lote — factura ${lista}`
    : `Pago de lote — ${numFacturas.length} facturas (${lista})`;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea un lote de pago en una sola transacción atómica:
 *  1. Resuelve el trámite REAL de cada factura desde BD (nunca se confía en
 *     un tramiteId enviado por el cliente) y valida que siga "impaga"
 *     (REGISTRADA) — mismo criterio que `listarFacturasImpagasPorCliente`.
 *  2. Agrupa las facturas por trámite (`agruparFacturasPorTramite`).
 *  3. Resuelve el costo bancario del canal UNA sola vez (es un solo
 *     desembolso) y lo imputa completo al primer trámite del lote
 *     (`repartirCostoBancario`) — los demás quedan en costoBancario = 0.
 *  4. Crea el `LotePago` y, reusando `crearPagoEnTx`, UN `PagoTramite` por
 *     cada trámite del grupo — cada uno conserva su propio `tramiteId` y
 *     `valor`, vinculado al lote y a sus facturas (pivote existente
 *     `PagoTramiteFactura`). La validación de desviación pago↔facturas
 *     (`UMBRAL_DESVIACION_PAGO_PCT`) se evalúa POR TRÁMITE dentro de
 *     `crearPagoEnTx`, con la misma semántica que el pago suelto.
 *  5. Registra AuditLog del `LotePago` (cada `PagoTramite` ya audita su
 *     propia creación dentro de `crearPagoEnTx`).
 *
 * Si cualquier paso falla, toda la transacción se revierte: ni el `LotePago`
 * ni ningún `PagoTramite` quedan creados a medias.
 */
export async function crearLotePago(input: CrearLotePagoInput): Promise<LotePagoResultado> {
  const {
    fechaPago,
    canalPago,
    referencia = null,
    documentoId = null,
    facturas,
    confirmarDesviacion = false,
    usuarioId,
  } = input;

  if (facturas.length === 0) {
    throw new LoteSinFacturasError();
  }

  const idsVistos = new Set<string>();
  for (const f of facturas) {
    if (idsVistos.has(f.facturaProveedorId)) {
      throw new FacturaDuplicadaEnLoteError(f.facturaProveedorId);
    }
    idsVistos.add(f.facturaProveedorId);
  }

  // A4 (mismo criterio que el pago suelto, ver crearPago en service.ts): con
  // el parámetro en true, el comprobante es obligatorio. Para el lote se
  // evalúa UNA vez — todos los pagos del lote comparten el mismo comprobante.
  const comprobanteObligatorio = await getParametroBool(
    CLAVES_UMBRAL.pagoComprobanteObligatorio,
    DEFAULTS_UMBRAL.pagoComprobanteObligatorio,
  );
  if (comprobanteObligatorio && !documentoId) {
    throw new ComprobanteObligatorioError();
  }

  return prisma.$transaction(async (tx) => {
    const facturasDb = await tx.facturaProveedor.findMany({
      where: { id: { in: facturas.map((f) => f.facturaProveedorId) } },
      select: { id: true, tramiteId: true, numFactura: true, estado: true },
    });
    const facturasPorId = new Map(facturasDb.map((f) => [f.id, f]));

    // Resolver tramiteId desde BD (nunca del input) y validar que la factura
    // exista y siga impaga. Estrictamente REGISTRADA: una factura ya PAGADA
    // o FACTURADA_CLIENTE no puede volver a entrar a un lote nuevo.
    const items: FacturaLoteItem[] = facturas.map((f) => {
      const fp = facturasPorId.get(f.facturaProveedorId);
      if (!fp) {
        throw new FacturaProveedorNoEncontradaError(f.facturaProveedorId);
      }
      if (fp.estado !== EstadoFacturaProveedor.REGISTRADA) {
        throw new FacturaProveedorNoModificableError(fp.id, fp.estado);
      }
      return { facturaProveedorId: fp.id, tramiteId: fp.tramiteId, valor: f.valor };
    });

    const grupos = agruparFacturasPorTramite(items);

    // Un solo desembolso bancario → el costo bancario del canal se resuelve
    // UNA vez y se imputa completo a un solo trámite del lote, nunca a los N.
    const costoBancarioTotal = await resolverCostoBancario(canalPago, tx);
    const reparto = repartirCostoBancario(
      grupos.map((g) => g.tramiteId),
      costoBancarioTotal,
    );

    const lote = await tx.lotePago.create({
      data: {
        referencia,
        fechaPago,
        canalPago,
        documentoId,
        registradoPorId: usuarioId,
      },
    });

    const pagos: PagoTramite[] = [];
    for (const grupo of grupos) {
      const numFacturasGrupo = grupo.facturaIds.map(
        (id) => facturasPorId.get(id)?.numFactura ?? id,
      );

      const pago = await crearPagoEnTx(tx, {
        tramiteId: grupo.tramiteId,
        concepto: construirConcepto(numFacturasGrupo),
        // La referencia bancaria del lote sirve también de N° de soporte de
        // cada pago individual — trazabilidad hacia el extracto.
        numSoporte: referencia,
        documentoId,
        valor: grupo.valor,
        canalPago,
        fechaRealPago: fechaPago,
        facturaProveedorIds: grupo.facturaIds,
        usuarioId,
        confirmarDesviacion,
        loteId: lote.id,
        costoBancarioOverride: reparto.get(grupo.tramiteId) ?? 0n,
      });

      pagos.push(pago);
    }

    await tx.auditLog.create({
      data: {
        entidad: "LotePago",
        entidadId: lote.id,
        accion: "CREATE",
        usuarioId,
        despues: normalizeSerializable({
          ...lote,
          tramitesInvolucrados: grupos.map((g) => g.tramiteId),
          totalLote: grupos.reduce((sum, g) => sum + g.valor, 0n),
          costoBancarioTotal,
        }),
      },
    });

    return { lote, pagos };
  });
}
