/**
 * Servicio de Dashboard — Galcomex
 * A2-T8: Dashboard operativo con métricas en vivo.
 *
 * Expone getDashboardData() y la función pura calcularDiasYAlerta().
 */

import { EstadoTramite } from "@prisma/client";

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
  pendientesFacturar: PendienteFacturarRow[];
  carteraVencida: CarteraVencidaRow[];
  totalCarteraVencida: string;  // BigInt as string
  anticiposConSaldo: AnticiposConSaldoResumen;
  actividadReciente: ActividadRecienteRow[];
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

// ─── Servicio principal ───────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const hoy = new Date();

  // 1. Conteo de DOs agrupado por estado
  const gruposPorEstado = await prisma.tramiteDO.groupBy({
    by: ["estado"],
    _count: { id: true },
  });

  const dosPorEstado: DosPorEstado[] = gruposPorEstado.map((g) => ({
    estado: g.estado,
    count: g._count.id,
  }));

  // DOs activos: todo excepto CERRADO
  const dosActivos = dosPorEstado
    .filter((d) => ESTADOS_ACTIVOS.includes(d.estado))
    .reduce((sum, d) => sum + d.count, 0);

  // 2. Pendientes de facturar: DESPACHADO o ENVIADO_A_FACTURAR sin factura emitida
  const dosPendientes = await prisma.tramiteDO.findMany({
    where: {
      estado: { in: ESTADOS_PENDIENTE_FACTURAR },
      borradores: {
        none: {
          estado: "FACTURADO",
        },
      },
    },
    select: {
      id: true,
      consecutivo: true,
      estado: true,
      fechaSalidaCarga: true,
      fechaEnviadoAFacturar: true,
      cliente: { select: { nombre: true } },
    },
    orderBy: { fechaSalidaCarga: "asc" },
  });

  const pendientesFacturar: PendienteFacturarRow[] = dosPendientes
    .map((do_) => {
      // Preferir fechaSalidaCarga; si no, fechaEnviadoAFacturar
      const fechaRef = do_.fechaSalidaCarga ?? do_.fechaEnviadoAFacturar;
      const { dias, alerta } = calcularDiasYAlerta(fechaRef, hoy);

      return {
        id: do_.id,
        consecutivo: do_.consecutivo,
        clienteNombre: do_.cliente.nombre,
        estado: do_.estado,
        fechaRef: fechaRef ? fechaRef.toISOString() : null,
        dias,
        alerta,
      };
    })
    // Ordenar por días descendente (los más urgentes primero)
    .sort((a, b) => b.dias - a.dias);

  // 3. Cartera vencida: facturas con saldoACargoCliente > 0 y sin fecha de pago
  const facturasVencidas = await prisma.factura.findMany({
    where: {
      saldoACargoCliente: { gt: 0n },
      fechaPagoCliente: null,
    },
    select: {
      id: true,
      numSiigo: true,
      saldoACargoCliente: true,
      fecha: true,
      cliente: { select: { nombre: true } },
    },
    orderBy: { fecha: "asc" },
  });

  const carteraVencida: CarteraVencidaRow[] = facturasVencidas.map((f) => {
    const msPerDay = 1000 * 60 * 60 * 24;
    const diasAntiguedad = Math.max(
      0,
      Math.floor((hoy.getTime() - f.fecha.getTime()) / msPerDay),
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

  const totalCarteraVencidaBigInt = facturasVencidas.reduce(
    (sum, f) => sum + f.saldoACargoCliente,
    0n,
  );

  // 4. Anticipos con saldo restante > 0
  const anticipos = await prisma.anticipo.findMany({
    select: {
      monto: true,
      aplicaciones: { select: { montoAplicado: true } },
    },
  });

  let anticiposCantidad = 0;
  let anticiposTotalRestante = 0n;

  for (const anticipo of anticipos) {
    const aplicado = anticipo.aplicaciones.reduce(
      (sum, ap) => sum + ap.montoAplicado,
      0n,
    );
    const restante = anticipo.monto - aplicado;
    if (restante > 0n) {
      anticiposCantidad++;
      anticiposTotalRestante += restante;
    }
  }

  // 5. Actividad reciente — últimos 10 AuditLog
  const auditLogs = await prisma.auditLog.findMany({
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
  });

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
    pendientesFacturar,
    carteraVencida,
    totalCarteraVencida: totalCarteraVencidaBigInt.toString(),
    anticiposConSaldo: {
      cantidad: anticiposCantidad,
      totalRestante: anticiposTotalRestante.toString(),
    },
    actividadReciente,
  };
}
