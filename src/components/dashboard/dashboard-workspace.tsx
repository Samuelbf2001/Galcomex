"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  Receipt,
  RotateCcw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError } from "@/components/ui/toast";
import { EnlaceCliente, EnlaceFacturaVenta, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { EstadoTramiteBadge, etiquetaEstadoTramite } from "@/components/ui/estado-tramite";
import { describirActividad } from "@/lib/auditoria/describir-actividad";

import {
  type DashboardApiData,
  type PendienteFacturarRow,
  type CarteraVencidaRow,
  type ActividadRecienteRow,
  type CarteraHistoricaResumen,
  type ClienteAlertaCarteraRow,
  DashboardApiError,
  fetchDashboard,
  formatCOP,
  formatDate,
  formatDateTime,
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
      className={`group flex h-full flex-col border bg-white p-4 transition hover:bg-slate-50 ${
        alert ? "border-rose-300" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`text-xs font-medium uppercase tracking-wide ${alert ? "text-rose-600" : "text-slate-500"}`}>
          {label}
        </p>
        <span className={`mt-0.5 ${alert ? "text-rose-400" : "text-slate-500"}`}>
          {icon}
        </span>
      </div>
      <p className={`mt-3 text-2xl font-semibold ${alert ? "text-rose-700" : "text-slate-900"}`}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
      ) : null}
      <p className="mt-auto flex items-center gap-1 pt-2 text-xs text-cyan-700">
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
                <EnlaceTramite id={row.id}>{row.consecutivo}</EnlaceTramite>
              </td>
              <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap">
                <EnlaceCliente id={row.clienteId}>{row.clienteNombre}</EnlaceCliente>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <EstadoTramiteBadge estado={row.estado} />
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
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-3 py-2.5">Factura</th>
            <th className="border-b border-slate-200 px-3 py-2.5">Cliente</th>
            <th className="whitespace-nowrap border-b border-slate-200 px-3 py-2.5 text-right">Por cobrar</th>
            <th className="border-b border-slate-200 px-3 py-2.5">Fecha</th>
            <th className="border-b border-slate-200 px-3 py-2.5 text-right">Días</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors"
            >
              <td className="px-3 py-2.5 font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
                <EnlaceFacturaVenta tramiteId={row.tramiteId} borradorId={row.borradorId}>
                  {row.numSiigo}
                </EnlaceFacturaVenta>
              </td>
              <td className="min-w-[9rem] px-3 py-2.5 text-xs text-slate-700">
                <EnlaceCliente id={row.clienteId}>{row.clienteNombre}</EnlaceCliente>
              </td>
              <td className="px-3 py-2.5 text-right text-sm font-semibold text-rose-600 whitespace-nowrap">
                {formatCOP(row.saldoACargoCliente)}
              </td>
              <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                {formatDate(row.fechaFactura)}
              </td>
              <td className="px-3 py-2.5 text-right text-xs text-slate-500 whitespace-nowrap">
                {row.diasAntiguedad}d
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tabla alertas de cartera por cliente ─────────────────────────────────────

function TablaAlertasCartera({ rows }: { rows: ClienteAlertaCarteraRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-slate-500">
        Ningún cliente está por debajo del umbral de alerta de cartera.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Saldo neto</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Ver cartera</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const negativo = BigInt(row.saldoNeto) < 0n;
            const absStr = negativo ? (-BigInt(row.saldoNeto)).toString() : row.saldoNeto;
            return (
              <tr
                key={row.clienteId}
                className="border-b border-slate-100 bg-rose-50/40 last:border-b-0 transition-colors hover:bg-rose-50"
              >
                <td className="px-4 py-3 text-xs font-medium text-slate-800 whitespace-nowrap">
                  <EnlaceCliente id={row.clienteId}>{row.clienteNombre}</EnlaceCliente>
                </td>
                <td className="px-4 py-3 text-right text-sm font-bold text-rose-600 whitespace-nowrap">
                  {negativo ? "−" : ""}
                  {formatCOP(absStr)}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <Link
                    href={`/cartera?clienteId=${row.clienteId}`}
                    className="inline-flex items-center gap-1 text-xs text-cyan-700 hover:underline"
                  >
                    Cartera <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Cartera histórica 2026 (cobros aún no cargados) ─────────────────────────

/** Monto con signo explícito: −$ 47.468.751 / +$ 5.030.347 / $ 0. */
function formatCOPConSigno(valor: string): string {
  const n = BigInt(valor);
  if (n === 0n) return formatCOP("0");
  return `${n < 0n ? "−" : "+"}${formatCOP((n < 0n ? -n : n).toString())}`;
}

function TablaCarteraHistorica({ resumen }: { resumen: CarteraHistoricaResumen }) {
  const neto = (BigInt(resumen.totalAFavor) - BigInt(resumen.totalACargo)).toString();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Facturas</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">A cargo</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">A favor</th>
            <th className="border-b border-slate-200 px-4 py-2.5 text-right">Neto</th>
          </tr>
        </thead>
        <tbody>
          {resumen.porCliente.map((row) => (
            <tr key={row.clienteId} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
              <td className="px-4 py-3 text-xs font-medium text-slate-800 whitespace-nowrap">
                <EnlaceCliente id={row.clienteId}>{row.clienteNombre}</EnlaceCliente>
              </td>
              <td className="px-4 py-3 text-right text-xs text-slate-700 whitespace-nowrap">{row.facturas}</td>
              <td className="px-4 py-3 text-right text-xs text-slate-700 whitespace-nowrap">{formatCOP(row.totalACargo)}</td>
              <td className="px-4 py-3 text-right text-xs text-slate-700 whitespace-nowrap">{formatCOP(row.totalAFavor)}</td>
              <td className="px-4 py-3 text-right text-sm font-semibold text-slate-900 whitespace-nowrap">
                {formatCOPConSigno(row.saldoNeto)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 text-xs font-semibold text-slate-800">
            <td className="px-4 py-2.5">Total</td>
            <td className="px-4 py-2.5 text-right">{resumen.cantidadFacturas}</td>
            <td className="px-4 py-2.5 text-right whitespace-nowrap">{formatCOP(resumen.totalACargo)}</td>
            <td className="px-4 py-2.5 text-right whitespace-nowrap">{formatCOP(resumen.totalAFavor)}</td>
            <td className="px-4 py-2.5 text-right whitespace-nowrap">{formatCOPConSigno(neto)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Actividad reciente en lenguaje humano ────────────────────────────────────

// La traducción entidad+acción → frase vive en lib/auditoria (la comparte el Historial del DO).
export { describirActividad };

/** Inicial para el avatar de la fila. */
function inicialUsuario(nombre: string): string {
  const limpio = nombre.trim();
  return limpio ? limpio.charAt(0).toUpperCase() : "?";
}

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
      {rows.map((row) => {
        const usuario = row.usuarioNombre.trim() || "Alguien";
        return (
          <li key={row.id} className="flex items-start gap-3 px-4 py-3">
            <span
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-xs font-medium text-slate-600"
              aria-hidden="true"
            >
              {inicialUsuario(usuario)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm text-slate-800">
                <span className="font-medium">{usuario}</span> {describirActividad(row)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{formatDateTime(row.createdAt)}</p>
            </div>
          </li>
        );
      })}
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
            : describirError(err, "Error al cargar el dashboard."),
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

  // ── Loading: mismas alturas que el contenido real para evitar el salto ───
  if (loadState === "loading" && !data) {
    return (
      <section className="space-y-6" aria-busy="true">
        <DashboardHeader onRefresh={handleRefresh} refreshing />
        <CardsSkeleton count={4} height={136} />
        <TableSkeleton rows={5} cols={5} rowHeight={45} />
        <TableSkeleton rows={2} cols={3} rowHeight={45} />
        <div className="grid gap-4 lg:grid-cols-2">
          <TableSkeleton rows={4} cols={5} rowHeight={45} />
          <TableSkeleton rows={4} cols={2} rowHeight={53} />
        </div>
      </section>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (!data) {
    return (
      <section className="space-y-5">
        <DashboardHeader onRefresh={handleRefresh} refreshing={false} hideRefresh />
        <ModuleState
          type="error"
          title="No fue posible cargar el dashboard"
          detail={errorMsg ?? undefined}
          action={{ label: "Reintentar", onClick: handleRefresh }}
        />
      </section>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────
  // Los KPI usan los contadores totales del API; las listas vienen limitadas a 20 filas.
  const alertaPendientes = data.cantidadPendientesConAlerta > 0;
  const historica = data.carteraHistorica;
  const muestraHistorica = historica.activa && historica.cantidadFacturas > 0;

  return (
    <section className="space-y-6">
      <DashboardHeader onRefresh={handleRefresh} refreshing={loadState === "loading"} hideRefresh={loadState === "error"} />
      {loadState === "loading" && <p role="status" className="text-sm text-cyan-700">Actualizando el resumen. Puedes seguir consultando los datos visibles.</p>}
      {loadState === "error" && <ModuleState type="error" title="No se pudo actualizar el resumen" detail={`${errorMsg ?? "Revisa tu conexión."} Los datos visibles corresponden a la última carga correcta.`} action={{ label: "Reintentar", onClick: handleRefresh }} />}

      {/* Envíos a SIIGO sin confirmar: reenviarlos a ciegas puede duplicar la factura. */}
      {data.cantidadEnviosSiigoSinConfirmar > 0 ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-semibold">
                {data.cantidadEnviosSiigoSinConfirmar === 1
                  ? "1 factura con envío a SIIGO sin confirmar."
                  : `${data.cantidadEnviosSiigoSinConfirmar} facturas con envío a SIIGO sin confirmar.`}
              </span>{" "}
              SIIGO pudo haberlas creado: no se reenvían hasta que un ADMIN use «Revisar en SIIGO».
            </span>
          </p>
          <Link
            href="/facturacion"
            className="inline-flex items-center gap-1 font-semibold text-amber-900 underline-offset-2 hover:underline"
          >
            Ir a facturación
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {/* Tarjetas de métricas. Orden fijo: primera fila = lo que pide acción;
          segunda = contexto. Siempre en el mismo sitio, haya o no alerta. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Pendientes de facturar"
          value={String(data.cantidadPendientesFacturar)}
          sub={
            alertaPendientes
              ? `${data.cantidadPendientesConAlerta} con alerta SLA`
              : "Sin alertas SLA"
          }
          href="/tramites"
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
          alert={alertaPendientes}
        />
        <MetricCard
          label="Cartera vencida"
          value={
            data.cantidadFacturasVencidas > 0
              ? formatCOP(data.totalCarteraVencida)
              : "$0"
          }
          sub={`${
            data.cantidadFacturasVencidas > 0
              ? `${data.cantidadFacturasVencidas} factura${data.cantidadFacturasVencidas !== 1 ? "s" : ""} sin cobrar`
              : "Al día"
          }${historica.activa ? " · sin la cartera histórica" : ""}`}
          href="/cartera?pendientes=true"
          icon={<Wallet className="h-4 w-4" aria-hidden="true" />}
          alert={data.cantidadFacturasVencidas > 0}
        />
        <MetricCard
          label="Pagos sin comprobante"
          value={String(data.cantidadPagosSinComprobante)}
          sub={
            data.cantidadPagosSinComprobante > 0
              ? "Falta el comprobante bancario"
              : "Todos con comprobante"
          }
          href="/pagos"
          icon={<Receipt className="h-4 w-4" aria-hidden="true" />}
          alert={data.cantidadPagosSinComprobante > 0}
        />
        <MetricCard
          label="DO activos"
          value={String(data.dosActivos)}
          sub="Trámites que aún no se han cerrado"
          href="/tramites"
          icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
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
              ? `${data.anticiposConSaldo.cantidad} anticipo${data.anticiposConSaldo.cantidad !== 1 ? "s" : ""} con saldo disponible`
              : "Sin saldo disponible"
          }
          href="/anticipos?con_saldo=true"
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
        />
        {muestraHistorica ? (
          // Sin `alert`: no es deuda confirmada (faltan los cobros históricos).
          <MetricCard
            label="Cartera histórica 2026"
            value={formatCOP(historica.totalACargo)}
            sub={`${historica.cantidadACargo} factura${historica.cantidadACargo !== 1 ? "s" : ""} · cobros aún no cargados`}
            href="/cartera?pendientes=true"
            icon={<Wallet className="h-4 w-4" aria-hidden="true" />}
          />
        ) : null}
      </div>

      {/* Lo que no tiene nada pendiente ocupa una sola línea neutra: la atención
          se queda en lo que sí pide acción. */}
      {data.pendientesFacturar.length === 0 || data.alertasCartera.length === 0 ? (
        <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
          {data.pendientesFacturar.length === 0 ? (
            <FilaTodoEnOrden texto="No hay DO pendientes de facturar." href="/tramites" enlace="Ver trámites" />
          ) : null}
          {data.alertasCartera.length === 0 ? (
            <FilaTodoEnOrden
              texto="Ningún cliente está por debajo del umbral de alerta de cartera."
              href="/cartera"
              enlace="Ir a cartera"
            />
          ) : null}
        </ul>
      ) : null}

      {/* Sección pendientes de facturar */}
      {data.pendientesFacturar.length > 0 ? (
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
      ) : null}

      {/* Sección alertas de cartera — clientes bajo el umbral configurado */}
      {data.alertasCartera.length > 0 ? (
        <div className="overflow-hidden border border-rose-200 bg-white">
          <div className="flex items-center justify-between border-b border-rose-200 bg-rose-50/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-600" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-rose-900">Alertas de cartera</h2>
            </div>
            <Link
              href="/cartera"
              className="flex items-center gap-1 text-xs text-cyan-700 hover:underline"
            >
              Ir a cartera <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
          <TablaAlertasCartera rows={data.alertasCartera} />
        </div>
      ) : null}

      {/* Grid: cartera vencida (más ancha: es una tabla) + actividad reciente */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
        <div className="self-start overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center border-b border-slate-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Actividad reciente
            </h2>
          </div>
          <ListaActividad rows={data.actividadReciente} />
        </div>
      </div>

      {/* Cartera histórica 2026 — facturas de trámites históricos sin cobros cargados (D0).
          Va después de lo vencido: es contexto, no deuda confirmada. */}
      {muestraHistorica ? (
        <div className="overflow-hidden border border-amber-200 bg-white">
          <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50/60 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-amber-900">{historica.titulo}</h2>
            <Link
              href="/cartera"
              className="flex items-center gap-1 text-xs text-cyan-700 hover:underline"
            >
              Ir a cartera <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
          <p className="border-b border-amber-100 px-4 py-2.5 text-xs leading-relaxed text-amber-900">
            Facturas de trámites históricos cargadas desde Siigo sin sus cobros. No es deuda confirmada: no gestionar
            cobros ni devolver o cruzar saldos a favor hasta cargar los cobros. Cada factura sale de aquí sola cuando se
            le registra un cobro.
          </p>
          <TablaCarteraHistorica resumen={historica} />
        </div>
      ) : null}

      {/* Pipeline de DOs por estado */}
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Flujo de trámites
          </h2>
        </div>
        <div className="flex flex-wrap gap-0 divide-x divide-slate-100">
          {data.dosPorEstado.length === 0 && <div className="w-full p-4"><ModuleState type="empty" title="Todavía no hay trámites" detail="Los trámites aparecerán aquí agrupados por su etapa de trabajo." /></div>}
          {[...data.dosPorEstado]
            .sort((a, b) => ORDEN_ESTADO.indexOf(a.estado) - ORDEN_ESTADO.indexOf(b.estado))
            .map((d) => (
              <div key={d.estado} className="min-w-24 px-4 py-3 text-center">
                <p className="text-lg font-semibold text-slate-900">{d.count}</p>
                <p className="mt-0.5 text-xs text-slate-500">{etiquetaEstadoTramite(d.estado)}</p>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

// ─── Fila "todo en orden" ────────────────────────────────────────────────────

function FilaTodoEnOrden({ texto, href, enlace }: { texto: string; href: string; enlace: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm text-slate-600">
      <span className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
        {texto}
      </span>
      <Link href={href} className="flex items-center gap-1 text-xs text-cyan-700 hover:underline">
        {enlace} <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </li>
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
  hideRefresh?: boolean;
};

function DashboardHeader({ onRefresh, refreshing, hideRefresh }: DashboardHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal">
          Dashboard operativo
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Revisa lo pendiente y abre el trámite o la cartera para continuar.
        </p>
      </div>
      {!hideRefresh && <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
      >
        <RotateCcw
          className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        {refreshing ? "Actualizando…" : "Actualizar"}
      </button>}
    </div>
  );
}
