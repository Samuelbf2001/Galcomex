/**
 * Servicio de Dashboard — Galcomex
 * A2-T8: Dashboard operativo con métricas en vivo.
 *
 * Expone getDashboardData() y la función pura calcularDiasYAlerta().
 *
 * Rendimiento (2026-09-07):
 *   - Las seis consultas del dashboard son independientes y corren en
 *     paralelo con `Promise.all`.
 *   - Los totales (saldo neto por cliente, anticipos con saldo, cartera
 *     vencida) se agregan en Postgres en vez de traer todas las filas y
 *     sumarlas en memoria. Todo el dinero se castea a `::bigint` en SQL y se
 *     convierte con `BigInt(...)`: cero flotantes.
 *   - Las listas "pendientes de facturar" y "cartera vencida" se limitan a
 *     LIMITE_LISTAS_DASHBOARD filas; el total real viaja en los contadores
 *     `cantidadPendientesFacturar` / `cantidadFacturasVencidas`.
 */

import {
  DestinoPago,
  EstadoBorrador,
  EstadoTramite,
  Prisma,
  TipoPagoFactura,
} from "@prisma/client";

import { getUmbralAlertaCarteraCliente } from "@/lib/alertas/umbrales";
import {
  SQL_FACTURA_HISTORICA_SIN_COBROS,
  TITULO_CARTERA_HISTORICA,
  carteraHistoricaAparte,
  whereFacturaHistoricaSinCobros,
} from "@/lib/cartera/historica";
import { prisma } from "@/lib/db/prisma";

// ─── Función pura testeable ───────────────────────────────────────────────────

/**
 * Calcula cuántos días han pasado desde `fechaRef` hasta `hoy`
 * y si eso supera el SLA definido.
 *
 * @param fechaRef  Fecha de referencia (ej. fechaSalidaCarga). null → 0 días, sin alerta.
 * @param hoy       Fecha actual (inyectable para tests).
 * @param slaDias   Umbral de días para alerta (default 3).
 */
export function calcularDiasYAlerta(
  fechaRef: Date | null,
  hoy: Date,
  slaDias = 3,
): { dias: number; alerta: boolean } {
  if (!fechaRef) {
    return { dias: 0, alerta: false };
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  const diff = hoy.getTime() - fechaRef.getTime();
  const dias = Math.max(0, Math.floor(diff / msPerDay));

  return { dias, alerta: dias > slaDias };
}

// ─── Alertas de cartera por cliente ──────────────────────────────────────────

export type ClienteSaldoNeto = {
  clienteId: string;
  clienteNombre: string;
  /** Σ saldoNeto (WS-D) de todas las facturas del cliente. Negativo = el cliente debe. */
  saldoNeto: bigint;
};

export type ClienteAlertaCarteraRow = {
  clienteId: string;
  clienteNombre: string;
  saldoNeto: string; // BigInt as string
};

/**
 * Función pura testeable: de una lista de clientes con su saldo neto de
 * cartera ya calculado, retorna los que están por debajo del umbral
 * (Parametro UMBRAL_ALERTA_CARTERA_CLIENTE, default −20.000.000 COP),
 * ordenados de peor a mejor saldo (más negativo primero).
 */
export function seleccionarClientesEnAlertaCartera(
  clientes: ClienteSaldoNeto[],
  umbral: bigint,
): ClienteAlertaCarteraRow[] {
  return clientes
    .filter((c) => c.saldoNeto < umbral)
    .sort((a, b) => (a.saldoNeto < b.saldoNeto ? -1 : a.saldoNeto > b.saldoNeto ? 1 : 0))
    .map((c) => ({
      clienteId: c.clienteId,
      clienteNombre: c.clienteNombre,
      saldoNeto: c.saldoNeto.toString(),
    }));
}

/** Fila cruda del agregado SQL; `saldoNeto` llega como int8 (bigint). */
type SaldoNetoClienteDbRow = {
  clienteId: string;
  clienteNombre: string;
  saldoNeto: bigint;
};

/**
 * Saldo neto de cartera por cliente, agregado en Postgres.
 *
 * Misma fórmula que `calcularSaldoNeto` (cartera/service.ts) sumada sobre
 * todas las facturas del cliente, ledger destino=CLIENTE:
 *   Σ (saldoAFavorCliente − saldoACargoCliente) + Σ abonos − Σ devoluciones
 * Incluye TODOS los clientes (sin facturas → 0), igual que el findMany
 * original, para que el umbral se evalúe sobre la misma población.
 *
 * Con la cartera histórica aparte (`aparte`; si no se pasa, se lee el
 * parámetro CARTERA_HISTORICA_APARTE) se excluyen las facturas de trámites
 * históricos sin cobros. La subconsulta de pagos no cambia: por definición,
 * esas facturas no tienen pagos del CLIENTE.
 */
export async function getSaldosNetoPorCliente(opts: { aparte?: boolean } = {}): Promise<ClienteSaldoNeto[]> {
  const aparte = opts.aparte ?? (await carteraHistoricaAparte());
  const filtroFacturas = aparte ? Prisma.sql`NOT ${SQL_FACTURA_HISTORICA_SIN_COBROS}` : Prisma.sql`TRUE`;
  const rows = await prisma.$queryRaw<SaldoNetoClienteDbRow[]>`
    SELECT
      c.id AS "clienteId",
      c.nombre AS "clienteNombre",
      (
        COALESCE(f.saldo, 0)
        + COALESCE(p.abonos, 0)
        - COALESCE(p.devoluciones, 0)
      )::bigint AS "saldoNeto"
    FROM cliente c
    LEFT JOIN (
      SELECT fa."clienteId", SUM(fa."saldoAFavorCliente" - fa."saldoACargoCliente") AS saldo
      FROM factura fa
      WHERE ${filtroFacturas}
      GROUP BY fa."clienteId"
    ) f ON f."clienteId" = c.id
    LEFT JOIN (
      SELECT
        fa."clienteId",
        SUM(CASE WHEN pf.tipo = ${TipoPagoFactura.ABONO}::"TipoPagoFactura" THEN pf.monto ELSE 0 END) AS abonos,
        SUM(CASE WHEN pf.tipo = ${TipoPagoFactura.DEVOLUCION}::"TipoPagoFactura" THEN pf.monto ELSE 0 END) AS devoluciones
      FROM pago_factura pf
      JOIN factura fa ON fa.id = pf."facturaId"
      WHERE pf.destino = ${DestinoPago.CLIENTE}::"DestinoPago"
      GROUP BY fa."clienteId"
    ) p ON p."clienteId" = c.id
    ORDER BY c.id ASC
  `;

  return rows.map((row) => ({
    clienteId: row.clienteId,
    clienteNombre: row.clienteNombre,
    saldoNeto: BigInt(row.saldoNeto),
  }));
}

/**
 * Calcula el saldo neto de cartera (Σ saldoNeto de las facturas, ledger
 * destino=CLIENTE — misma fórmula que getCarteraCliente().cruceCliente, sin la
 * cartera histórica sin cobros cuando está aparte) para todos los clientes, y
 * retorna solo los que están bajo el umbral de alerta.
 */
export async function getClientesConAlertaCartera(aparte?: boolean): Promise<ClienteAlertaCarteraRow[]> {
  const [clientesConSaldo, umbral] = await Promise.all([
    getSaldosNetoPorCliente({ aparte }),
    getUmbralAlertaCarteraCliente(),
  ]);

  return seleccionarClientesEnAlertaCartera(clientesConSaldo, umbral);
}

// ─── Tipos de retorno ─────────────────────────────────────────────────────────

export type DosPorEstado = {
  estado: EstadoTramite;
  count: number;
};

export type PendienteFacturarRow = {
  id: string;
  consecutivo: string;
  clienteId: string;
  clienteNombre: string;
  estado: EstadoTramite;
  fechaRef: string | null;    // ISO date string
  dias: number;
  alerta: boolean;            // true si > SLA
};

export type CarteraVencidaRow = {
  id: string;
  numSiigo: string;
  clienteId: string;
  clienteNombre: string;
  tramiteId: string;
  borradorId: string;
  saldoACargoCliente: string; // BigInt as string
  fechaFactura: string;       // ISO date string
  diasAntiguedad: number;
};

export type AnticiposConSaldoResumen = {
  cantidad: number;
  totalRestante: string;      // BigInt as string
};

export type CarteraHistoricaClienteRow = {
  clienteId: string;
  clienteNombre: string;
  /** Facturas históricas sin cobros con algún saldo (a cargo o a favor). */
  facturas: number;
  totalACargo: string;        // BigInt as string
  totalAFavor: string;        // BigInt as string
  /** totalAFavor − totalACargo. Negativo = el cliente debe (según Siigo, sin cobros cargados). */
  saldoNeto: string;          // BigInt as string
};

/**
 * Cartera histórica 2026 (cobros aún no cargados): facturas de trámites
 * históricos sin ningún pago del CLIENTE, fuera de la cartera vencida y de
 * las alertas mientras CARTERA_HISTORICA_APARTE ≠ "NO".
 */
export type CarteraHistoricaResumen = {
  /** false con CARTERA_HISTORICA_APARTE = "NO": todo vuelve a la cartera normal. */
  activa: boolean;
  titulo: string;
  /** Facturas con saldo (a cargo o a favor). */
  cantidadFacturas: number;
  /** Facturas con saldo a cargo del cliente. */
  cantidadACargo: number;
  totalACargo: string;        // BigInt as string
  totalAFavor: string;        // BigInt as string
  porCliente: CarteraHistoricaClienteRow[];
};

export type ActividadRecienteRow = {
  id: string;
  accion: string;
  entidad: string;
  entidadId: string;
  usuarioNombre: string;
  createdAt: string;          // ISO date string
};

export type DashboardData = {
  dosActivos: number;
  dosPorEstado: DosPorEstado[];
  /** Hasta LIMITE_LISTAS_DASHBOARD filas, las más urgentes (más días) primero. */
  pendientesFacturar: PendienteFacturarRow[];
  /** Total real de trámites pendientes de facturar (la lista puede estar recortada). */
  cantidadPendientesFacturar: number;
  /** Cuántos de los pendientes (todos, no solo los listados) exceden el SLA. */
  cantidadPendientesConAlerta: number;
  /** Hasta LIMITE_LISTAS_DASHBOARD facturas, las más antiguas primero. */
  carteraVencida: CarteraVencidaRow[];
  /** Total real de facturas vencidas (la lista puede estar recortada). */
  cantidadFacturasVencidas: number;
  /** Σ saldoACargoCliente de TODAS las facturas vencidas. BigInt as string. */
  totalCarteraVencida: string;
  anticiposConSaldo: AnticiposConSaldoResumen;
  actividadReciente: ActividadRecienteRow[];
  /** Clientes con saldo neto de cartera por debajo de UMBRAL_ALERTA_CARTERA_CLIENTE. */
  alertasCartera: ClienteAlertaCarteraRow[];
  /** Facturas de trámites históricos sin cobros, aparte de la vencida y de las alertas. */
  carteraHistorica: CarteraHistoricaResumen;
  /**
   * Pagos del libro (de TODOS los DOs) sin comprobante bancario (`documentoId`
   * null). Solo el número — sin lista — mismo criterio que `faltaComprobante`
   * en `lib/pagos/service.ts` (decisión: alertar, no bloquear — caso Karina).
   */
  cantidadPagosSinComprobante: number;
};

// ─── Estados que cuentan como "activos" ──────────────────────────────────────

const ESTADOS_ACTIVOS: EstadoTramite[] = [
  EstadoTramite.SOLICITUD,
  EstadoTramite.APERTURA,
  EstadoTramite.EN_TRAMITE,
  EstadoTramite.EN_PUERTO,
  EstadoTramite.DESPACHADO,
  EstadoTramite.ENVIADO_A_FACTURAR,
  EstadoTramite.FACTURADO,
  EstadoTramite.PAGADO,
];

const ESTADOS_PENDIENTE_FACTURAR: EstadoTramite[] = [
  EstadoTramite.DESPACHADO,
  EstadoTramite.ENVIADO_A_FACTURAR,
];

/** Máximo de filas que viajan en las listas del dashboard. */
export const LIMITE_LISTAS_DASHBOARD = 20;

/** SLA (días) a partir del cual un pendiente de facturar entra en alerta. */
const SLA_DIAS_PENDIENTE_FACTURAR = 3;

const MS_POR_DIA = 1000 * 60 * 60 * 24;

// ─── Consultas parciales ──────────────────────────────────────────────────────

type PendienteFacturarDbRow = {
  id: string;
  consecutivo: string;
  estado: EstadoTramite;
  fechaSalidaCarga: Date | null;
  fechaEnviadoAFacturar: Date | null;
  clienteId: string;
  clienteNombre: string;
};

type ConteoPendientesDbRow = {
  total: number;
  conAlerta: number;
};

/**
 * Pendientes de facturar: DESPACHADO o ENVIADO_A_FACTURAR sin borrador
 * FACTURADO. La página se ordena en SQL por la fecha de referencia
 * (fechaSalidaCarga, o fechaEnviadoAFacturar si la primera es null) para que
 * las LIMITE filas sean exactamente las de más días; luego se ordena en
 * memoria por `dias` desc como siempre.
 */
async function getPendientesFacturar(hoy: Date): Promise<{
  pendientesFacturar: PendienteFacturarRow[];
  cantidadPendientesFacturar: number;
  cantidadPendientesConAlerta: number;
}> {
  const estadosSql = Prisma.join(
    ESTADOS_PENDIENTE_FACTURAR.map((estado) => Prisma.sql`${estado}::"EstadoTramite"`),
  );

  // Mismo filtro que `{ estado: { in }, borradores: { none: { estado: FACTURADO } } }`.
  const wherePendientes = Prisma.sql`
    t.estado IN (${estadosSql})
    AND NOT EXISTS (
      SELECT 1
      FROM borrador_factura b
      WHERE b."tramiteId" = t.id
        AND b.estado = ${EstadoBorrador.FACTURADO}::"EstadoBorrador"
    )
  `;

  // alerta ⟺ floor((hoy − fechaRef) / día) > SLA ⟺ fechaRef ≤ hoy − (SLA + 1) días.
  const limiteAlerta = new Date(hoy.getTime() - (SLA_DIAS_PENDIENTE_FACTURAR + 1) * MS_POR_DIA);

  const [rows, conteos] = await Promise.all([
    prisma.$queryRaw<PendienteFacturarDbRow[]>`
      SELECT
        t.id,
        t.consecutivo,
        t.estado,
        t."fechaSalidaCarga",
        t."fechaEnviadoAFacturar",
        c.id AS "clienteId",
        c.nombre AS "clienteNombre"
      FROM tramite_do t
      JOIN cliente c ON c.id = t."clienteId"
      WHERE ${wherePendientes}
      ORDER BY
        COALESCE(t."fechaSalidaCarga", t."fechaEnviadoAFacturar") ASC NULLS LAST,
        t.id ASC
      LIMIT ${Prisma.raw(String(LIMITE_LISTAS_DASHBOARD))}
    `,
    prisma.$queryRaw<ConteoPendientesDbRow[]>`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE COALESCE(t."fechaSalidaCarga", t."fechaEnviadoAFacturar") <= ${limiteAlerta}
        )::int AS "conAlerta"
      FROM tramite_do t
      WHERE ${wherePendientes}
    `,
  ]);

  const pendientesFacturar: PendienteFacturarRow[] = rows
    .map((do_) => {
      // Preferir fechaSalidaCarga; si no, fechaEnviadoAFacturar
      const fechaRef = do_.fechaSalidaCarga ?? do_.fechaEnviadoAFacturar;
      const { dias, alerta } = calcularDiasYAlerta(fechaRef, hoy, SLA_DIAS_PENDIENTE_FACTURAR);

      return {
        id: do_.id,
        consecutivo: do_.consecutivo,
        clienteId: do_.clienteId,
        clienteNombre: do_.clienteNombre,
        estado: do_.estado,
        fechaRef: fechaRef ? fechaRef.toISOString() : null,
        dias,
        alerta,
      };
    })
    // Ordenar por días descendente (los más urgentes primero)
    .sort((a, b) => b.dias - a.dias);

  const conteo = conteos[0];

  return {
    pendientesFacturar,
    cantidadPendientesFacturar: conteo ? Number(conteo.total) : 0,
    cantidadPendientesConAlerta: conteo ? Number(conteo.conAlerta) : 0,
  };
}

/**
 * Cartera vencida: facturas con saldoACargoCliente > 0 y sin fecha de pago.
 * La lista se recorta a LIMITE filas (más antiguas primero); el total en COP
 * y el conteo se agregan en BD sobre TODAS las facturas vencidas.
 * Con la cartera histórica aparte, excluye las facturas de trámites
 * históricos sin cobros (van en `getCarteraHistorica`).
 */
async function getCarteraVencida(hoy: Date, aparte: boolean): Promise<{
  carteraVencida: CarteraVencidaRow[];
  cantidadFacturasVencidas: number;
  totalCarteraVencida: bigint;
}> {
  const whereVencidas: Prisma.FacturaWhereInput = {
    saldoACargoCliente: { gt: 0n },
    fechaPagoCliente: null,
    ...(aparte ? { NOT: whereFacturaHistoricaSinCobros } : {}),
  };

  const [facturasVencidas, agregado] = await Promise.all([
    prisma.factura.findMany({
      where: whereVencidas,
      select: {
        id: true,
        numSiigo: true,
        saldoACargoCliente: true,
        fecha: true,
        clienteId: true,
        cliente: { select: { nombre: true } },
        borradorId: true,
        borrador: { select: { tramiteId: true } },
      },
      orderBy: [{ fecha: "asc" }, { id: "asc" }],
      take: LIMITE_LISTAS_DASHBOARD,
    }),
    prisma.factura.aggregate({
      where: whereVencidas,
      _sum: { saldoACargoCliente: true },
      _count: { id: true },
    }),
  ]);

  const carteraVencida: CarteraVencidaRow[] = facturasVencidas.map((f) => {
    const diasAntiguedad = Math.max(
      0,
      Math.floor((hoy.getTime() - f.fecha.getTime()) / MS_POR_DIA),
    );

    return {
      id: f.id,
      numSiigo: f.numSiigo,
      clienteId: f.clienteId,
      clienteNombre: f.cliente.nombre,
      tramiteId: f.borrador.tramiteId,
      borradorId: f.borradorId,
      saldoACargoCliente: f.saldoACargoCliente.toString(),
      fechaFactura: f.fecha.toISOString(),
      diasAntiguedad,
    };
  });

  return {
    carteraVencida,
    cantidadFacturasVencidas: agregado._count.id,
    totalCarteraVencida: agregado._sum.saldoACargoCliente ?? 0n,
  };
}

type CarteraHistoricaDbRow = {
  clienteId: string;
  clienteNombre: string;
  facturas: number;
  facturasACargo: number;
  totalACargo: bigint;
  totalAFavor: bigint;
};

/**
 * Cartera histórica 2026 (cobros aún no cargados): facturas de trámites
 * históricos sin pagos del CLIENTE y con algún saldo, por cliente (peor saldo
 * neto primero). Sin LIMIT: como mucho, una fila por cliente con históricos.
 * Los totales se suman en TypeScript con BigInt.
 */
export async function getCarteraHistorica(aparte: boolean): Promise<CarteraHistoricaResumen> {
  if (!aparte) {
    return {
      activa: false,
      titulo: TITULO_CARTERA_HISTORICA,
      cantidadFacturas: 0,
      cantidadACargo: 0,
      totalACargo: "0",
      totalAFavor: "0",
      porCliente: [],
    };
  }

  const rows = await prisma.$queryRaw<CarteraHistoricaDbRow[]>`
    SELECT
      c.id AS "clienteId",
      c.nombre AS "clienteNombre",
      COUNT(*)::int AS facturas,
      COUNT(*) FILTER (WHERE fa."saldoACargoCliente" > 0)::int AS "facturasACargo",
      COALESCE(SUM(fa."saldoACargoCliente"), 0)::bigint AS "totalACargo",
      COALESCE(SUM(fa."saldoAFavorCliente"), 0)::bigint AS "totalAFavor"
    FROM factura fa
    JOIN cliente c ON c.id = fa."clienteId"
    WHERE ${SQL_FACTURA_HISTORICA_SIN_COBROS}
      AND (fa."saldoACargoCliente" > 0 OR fa."saldoAFavorCliente" > 0)
    GROUP BY c.id, c.nombre
    ORDER BY
      (COALESCE(SUM(fa."saldoAFavorCliente"), 0) - COALESCE(SUM(fa."saldoACargoCliente"), 0)) ASC,
      c.id ASC
  `;

  let cantidadFacturas = 0;
  let cantidadACargo = 0;
  let totalACargo = 0n;
  let totalAFavor = 0n;
  const porCliente: CarteraHistoricaClienteRow[] = rows.map((row) => {
    const aCargo = BigInt(row.totalACargo);
    const aFavor = BigInt(row.totalAFavor);
    cantidadFacturas += Number(row.facturas);
    cantidadACargo += Number(row.facturasACargo);
    totalACargo += aCargo;
    totalAFavor += aFavor;
    return {
      clienteId: row.clienteId,
      clienteNombre: row.clienteNombre,
      facturas: Number(row.facturas),
      totalACargo: aCargo.toString(),
      totalAFavor: aFavor.toString(),
      saldoNeto: (aFavor - aCargo).toString(),
    };
  });

  return {
    activa: true,
    titulo: TITULO_CARTERA_HISTORICA,
    cantidadFacturas,
    cantidadACargo,
    totalACargo: totalACargo.toString(),
    totalAFavor: totalAFavor.toString(),
    porCliente,
  };
}

type AnticiposConSaldoDbRow = {
  cantidad: number;
  totalRestante: bigint;
};

/**
 * Anticipos con saldo restante > 0 (monto − Σ montoAplicado), contados y
 * sumados en Postgres. No filtra por estado del anticipo (igual que antes).
 */
export async function getAnticiposConSaldo(): Promise<AnticiposConSaldoResumen> {
  const [row] = await prisma.$queryRaw<AnticiposConSaldoDbRow[]>`
    SELECT
      COUNT(*)::int AS cantidad,
      COALESCE(SUM(t.restante), 0)::bigint AS "totalRestante"
    FROM (
      SELECT a.monto - COALESCE(ap.aplicado, 0) AS restante
      FROM anticipo a
      LEFT JOIN (
        SELECT "anticipoId", SUM("montoAplicado") AS aplicado
        FROM aplicacion_anticipo
        GROUP BY "anticipoId"
      ) ap ON ap."anticipoId" = a.id
    ) t
    WHERE t.restante > 0
  `;

  return {
    cantidad: row ? Number(row.cantidad) : 0,
    totalRestante: (row ? BigInt(row.totalRestante) : 0n).toString(),
  };
}

// ─── Servicio principal ───────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const hoy = new Date();
  // Una sola lectura del parámetro: vencida, alertas y sección histórica usan el mismo valor.
  const aparte = await carteraHistoricaAparte();

  const [
    gruposPorEstado,
    pendientes,
    cartera,
    anticiposConSaldo,
    auditLogs,
    alertasCartera,
    cantidadPagosSinComprobante,
    carteraHistorica,
  ] = await Promise.all([
    // 1. Conteo de DOs agrupado por estado
    prisma.tramiteDO.groupBy({
      by: ["estado"],
      _count: { id: true },
    }),
    // 2. Pendientes de facturar (página + contadores)
    getPendientesFacturar(hoy),
    // 3. Cartera vencida (página + total + contador), sin la histórica sin cobros
    getCarteraVencida(hoy, aparte),
    // 4. Anticipos con saldo restante > 0
    getAnticiposConSaldo(),
    // 5. Actividad reciente — últimos 10 AuditLog
    prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        accion: true,
        entidad: true,
        entidadId: true,
        createdAt: true,
        usuario: { select: { name: true } },
      },
    }),
    // 6. Alertas de cartera — clientes con saldo neto por debajo del umbral
    getClientesConAlertaCartera(aparte),
    // 7. Pagos de todos los DOs sin comprobante bancario (documentoId null)
    prisma.pagoTramite.count({ where: { documentoId: null } }),
    // 8. Cartera histórica 2026 (cobros aún no cargados)
    getCarteraHistorica(aparte),
  ]);

  const dosPorEstado: DosPorEstado[] = gruposPorEstado.map((g) => ({
    estado: g.estado,
    count: g._count.id,
  }));

  // DOs activos: todo excepto CERRADO
  const dosActivos = dosPorEstado
    .filter((d) => ESTADOS_ACTIVOS.includes(d.estado))
    .reduce((sum, d) => sum + d.count, 0);

  const actividadReciente: ActividadRecienteRow[] = auditLogs.map((log) => ({
    id: log.id,
    accion: log.accion,
    entidad: log.entidad,
    entidadId: log.entidadId,
    usuarioNombre: log.usuario.name,
    createdAt: log.createdAt.toISOString(),
  }));

  return {
    dosActivos,
    dosPorEstado,
    pendientesFacturar: pendientes.pendientesFacturar,
    cantidadPendientesFacturar: pendientes.cantidadPendientesFacturar,
    cantidadPendientesConAlerta: pendientes.cantidadPendientesConAlerta,
    carteraVencida: cartera.carteraVencida,
    cantidadFacturasVencidas: cartera.cantidadFacturasVencidas,
    totalCarteraVencida: cartera.totalCarteraVencida.toString(),
    anticiposConSaldo,
    actividadReciente,
    alertasCartera,
    cantidadPagosSinComprobante,
    carteraHistorica,
  };
}
