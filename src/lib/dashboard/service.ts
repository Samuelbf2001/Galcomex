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
 */
export async function getSaldosNetoPorCliente(): Promise<ClienteSaldoNeto[]> {
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
      SELECT "clienteId", SUM("saldoAFavorCliente" - "saldoACargoCliente") AS saldo
      FROM factura
      GROUP BY "clienteId"
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
 * Calcula el saldo neto de cartera (Σ saldoNeto de todas las facturas, ledger
 * destino=CLIENTE — misma fórmula que getCarteraCliente().cruceCliente) para
 * todos los clientes, y retorna solo los que están bajo el umbral de alerta.
 */
export async function getClientesConAlertaCartera(): Promise<ClienteAlertaCarteraRow[]> {
  const [clientesConSaldo, umbral] = await Promise.all([
    getSaldosNetoPorCliente(),
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
  clienteNombre: string;
  estado: EstadoTramite;
  fechaRef: string | null;    // ISO date string
  dias: number;
  alerta: boolean;            // true si > SLA
};

export type CarteraVencidaRow = {
  id: string;
  numSiigo: string;
  clienteNombre: string;
  saldoACargoCliente: string; // BigInt as string
  fechaFactura: string;       // ISO date string
  diasAntiguedad: number;
};

export type AnticiposConSaldoResumen = {
  cantidad: number;
  totalRestante: string;      // BigInt as string
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
 */
async function getCarteraVencida(hoy: Date): Promise<{
  carteraVencida: CarteraVencidaRow[];
  cantidadFacturasVencidas: number;
  totalCarteraVencida: bigint;
}> {
  const whereVencidas: Prisma.FacturaWhereInput = {
    saldoACargoCliente: { gt: 0n },
    fechaPagoCliente: null,
  };

  const [facturasVencidas, agregado] = await Promise.all([
    prisma.factura.findMany({
      where: whereVencidas,
      select: {
        id: true,
        numSiigo: true,
        saldoACargoCliente: true,
        fecha: true,
        cliente: { select: { nombre: true } },
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
      clienteNombre: f.cliente.nombre,
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

  const [gruposPorEstado, pendientes, cartera, anticiposConSaldo, auditLogs, alertasCartera] =
    await Promise.all([
      // 1. Conteo de DOs agrupado por estado
      prisma.tramiteDO.groupBy({
        by: ["estado"],
        _count: { id: true },
      }),
      // 2. Pendientes de facturar (página + contadores)
      getPendientesFacturar(hoy),
      // 3. Cartera vencida (página + total + contador)
      getCarteraVencida(hoy),
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
      getClientesConAlertaCartera(),
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
  };
}
