"use client";

import {
  AlertTriangle,
  ArrowRight,
  Clock,
  FileText,
  Loader2,
  RotateCcw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";

import {
  type DashboardApiData,
  type PendienteFacturarRow,
  type CarteraVencidaRow,
  type ActividadRecienteRow,
  DashboardApiError,
  fetchDashboard,
  formatCOP,
  formatDate,
  labelEstado,
} from "./dashboard-api";

// ─── Tipos locales ────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

// ─── Tarjeta de métrica ───────────────────────────────────────────────────────

type MetricCardProps = {
  label: string;
  value: string;
  sub?: string;
  href: string;
  icon: React.ReactNode;
  alert?: boolean;
};

function MetricCard({ label, value, sub, href, icon, alert = false }: MetricCardProps) {
  return (
    <Link
      href={href}
      className={`group block border bg-white p-4 transition hover:bg-slate-50 ${
        alert ? "border-rose-300" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`text-xs font-medium uppercase tracking-wide ${alert ? "text-rose-600" : "text-slate-500"}`}>
          {label}
        </p>
        <span className={`mt-0.5 ${alert ? "text-rose-400" : "text-slate-400"}`}>
          {icon}
        </span>
      </div>
      <p className={`mt-3 text-2xl font-semibold ${alert ? "text-rose-700" : "text-slate-900"}`}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
      ) : null}
      <p className="mt-2 flex items-center gap-1 text-xs text-cyan-700 opacity-0 transition-opacity group-hover:opacity-100">
        Ver módulo <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </p>
    </Link>
  );
}

// ─── Tabla pendientes de facturar ─────────────────────────────────────────────

function TablaPendientesFacturar({ rows }: { rows: PendienteFacturarRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        No hay DOs pendientes de facturar.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-2.5">DO</th>
            <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
            <th className="border-b border-slate-200 px-4 py-2.5">Estado</th>
            <th className="border-b border-slate-200 px-4 py-2.5">Fecha ref.</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Días</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`border-b border-slate-100 last:border-b-0 transition-colors ${
                row.alerta
                  ? "bg-rose-50 hover:bg-rose-100"
                  : "hover:bg-slate-50"
              }`}
            >
              <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
                {row.consecutivo}
              </td>
              <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                {row.clienteNombre}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <span className="inline-flex h-5 items-center border border-slate-200 bg-white px-1.5 text-xs text-slate-600">
                  {labelEstado(row.estado)}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                {formatDate(row.fechaRef)}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                <span
                  className={`inline-flex items-center gap-1 font-semibold ${
                    row.alerta ? "text-rose-600" : "text-slate-700"
                  }`}
                >
                  {row.alerta ? (
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : null}
                  {row.dias}d
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tabla cartera vencida ────────────────────────────────────────────────────

function TablaCarteraVencida({ rows }: { rows: CarteraVencidaRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        No hay facturas con saldo pendiente de cobro.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[500px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-2.5">Factura</th>
            <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Saldo a cobrar</th>
            <th className="border-b border-slate-200 px-4 py-2.5">Fecha</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Días</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors"
            >
              <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
                {row.numSiigo}
              </td>
              <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                {row.clienteNombre}
              </td>
              <td className="px-4 py-3 text-right text-sm font-semibold text-rose-600 whitespace-nowrap">
                {formatCOP(row.saldoACargoCliente)}
              </td>
              <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                {formatDate(row.fechaFactura)}
              </td>
              <td className="px-4 py-3 text-right text-xs text-slate-500 whitespace-nowrap">
                {row.diasAntiguedad}d
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Lista actividad reciente ─────────────────────────────────────────────────

function ListaActividad({ rows }: { rows: ActividadRecienteRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        Sin actividad reciente registrada.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
            {row.accion.slice(0, 2)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-slate-800">
              <span className="font-medium">{row.accion}</span>{" "}
              <span className="text-slate-500">{row.entidad}</span>
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {row.usuarioNombre} · {formatDate(row.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function DashboardWorkspace() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [data, setData] = useState<DashboardApiData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setErrorMsg(null);
      try {
        const d = await fetchDashboard(controller.signal);
        setData(d);
        setLoadState("ready");
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setErrorMsg(
          err instanceof DashboardApiError
            ? err.message
            : "Error al cargar el dashboard.",
        );
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [refreshKey]);

  function handleRefresh() {
    setRefreshKey((k) => k + 1);
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loadState === "loading") {
    return (
      <section className="space-y-5">
        <DashboardHeader onRefresh={handleRefresh} refreshing />
        <ModuleState type="loading" title="Cargando datos operativos…" />
      </section>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (loadState === "error" || !data) {
    return (
      <section className="space-y-5">
        <DashboardHeader onRefresh={handleRefresh} refreshing={false} />
        <div className="flex items-start gap-3 border border-dashed border-rose-300 bg-rose-50 px-4 py-5 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">No fue posible cargar el dashboard</p>
            {errorMsg ? <p className="mt-1">{errorMsg}</p> : null}
          </div>
        </div>
      </section>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────
  const alertaPendientes = data.pendientesFacturar.some((p) => p.alerta);

  return (
    <section className="space-y-6">
      <DashboardHeader onRefresh={handleRefresh} refreshing={false} />

      {/* Tarjetas de métricas */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="DOs activos"
          value={String(data.dosActivos)}
          sub="En pipeline (excl. cerrados)"
          href="/tramites"
          icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
        />
        <MetricCard
          label="Pendientes de facturar"
          value={String(data.pendientesFacturar.length)}
          sub={
            alertaPendientes
              ? `${data.pendientesFacturar.filter((p) => p.alerta).length} con alerta SLA`
              : "Sin alertas SLA"
          }
          href="/tramites"
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
          alert={alertaPendientes}
        />
        <MetricCard
          label="Cartera vencida"
          value={
            data.carteraVencida.length > 0
              ? formatCOP(data.totalCarteraVencida)
              : "$0"
          }
          sub={
            data.carteraVencida.length > 0
              ? `${data.carteraVencida.length} factura${data.carteraVencida.length !== 1 ? "s" : ""} sin cobrar`
              : "Al día"
          }
          href="/cartera?pendientes=true"
          icon={<Wallet className="h-4 w-4" aria-hidden="true" />}
          alert={data.carteraVencida.length > 0}
        />
        <MetricCard
          label="Anticipos con saldo"
          value={
            data.anticiposConSaldo.cantidad > 0
              ? formatCOP(data.anticiposConSaldo.totalRestante)
              : "$0"
          }
          sub={
            data.anticiposConSaldo.cantidad > 0
              ? `${data.anticiposConSaldo.cantidad} anticipo${data.anticiposConSaldo.cantidad !== 1 ? "s" : ""} disponibles`
              : "Sin saldo disponible"
          }
          href="/anticipos?con_saldo=true"
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      {/* Sección pendientes de facturar */}
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Pendientes de facturar
            </h2>
            {alertaPendientes ? (
              <span className="inline-flex items-center gap-1 border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                SLA excedido
              </span>
            ) : null}
          </div>
          <Link
            href="/tramites"
            className="flex items-center gap-1 text-xs text-cyan-700 hover:underline"
          >
            Ver todos <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        <TablaPendientesFacturar rows={data.pendientesFacturar} />
      </div>

      {/* Grid: cartera vencida + actividad reciente */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Cartera vencida */}
        <div className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Cartera vencida
            </h2>
            <Link
              href="/cartera?pendientes=true"
              className="flex items-center gap-1 text-xs text-cyan-700 hover:underline"
            >
              Ir a cartera <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
          <TablaCarteraVencida rows={data.carteraVencida} />
          {data.carteraVencida.length > 0 ? (
            <div className="border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-xs">
              <span className="text-slate-500">Total a cobrar: </span>
              <span className="font-semibold text-rose-600">
                {formatCOP(data.totalCarteraVencida)}
              </span>
            </div>
          ) : null}
        </div>

        {/* Actividad reciente */}
        <div className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Actividad reciente
            </h2>
          </div>
          <ListaActividad rows={data.actividadReciente} />
        </div>
      </div>

      {/* Pipeline de DOs por estado */}
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Pipeline de trámites
          </h2>
        </div>
        <div className="flex flex-wrap gap-0 divide-x divide-slate-100">
          {data.dosPorEstado
            .sort((a, b) => ORDEN_ESTADO.indexOf(a.estado) - ORDEN_ESTADO.indexOf(b.estado))
            .map((d) => (
              <div key={d.estado} className="min-w-24 px-4 py-3 text-center">
                <p className="text-lg font-semibold text-slate-900">{d.count}</p>
                <p className="mt-0.5 text-xs text-slate-500">{labelEstado(d.estado)}</p>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

// ─── Header con botón de actualizar ──────────────────────────────────────────

const ORDEN_ESTADO = [
  "SOLICITUD",
  "APERTURA",
  "EN_TRAMITE",
  "EN_PUERTO",
  "DESPACHADO",
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
  "CERRADO",
];

type DashboardHeaderProps = {
  onRefresh: () => void;
  refreshing: boolean;
};

function DashboardHeader({ onRefresh, refreshing }: DashboardHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">
          Dashboard operativo
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          DOs por estado, pendientes de facturar, cartera y anticipos.
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
      >
        <RotateCcw
          className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        {refreshing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : null}
        Actualizar
      </button>
    </div>
  );
}
