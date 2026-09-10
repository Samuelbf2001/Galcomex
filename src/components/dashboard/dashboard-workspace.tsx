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
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError } from "@/components/ui/toast";

import {
  type DashboardApiData,
  type PendienteFacturarRow,
  type CarteraVencidaRow,
  type ActividadRecienteRow,
  type ClienteAlertaCarteraRow,
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
                  {row.clienteNombre}
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

// ─── Actividad reciente en lenguaje humano ────────────────────────────────────

/**
 * Traducción `entidad:accion` → frase. Los códigos vienen de los `AuditLog`
 * que escriben los servicios (`grep -rn "accion:" src/lib`): CREATE/UPDATE/
 * DELETE son genéricos y solo tienen sentido junto a la entidad, por eso la
 * clave compuesta va primero y `ACCIONES_GENERICAS` es el segundo intento.
 */
const ACTIVIDAD_POR_ENTIDAD: Record<string, string> = {
  // Trámites (DO)
  "TramiteDO:CREATE": "creó el DO",
  "TramiteDO:CREATE_TRAMITE": "creó el DO",
  "TramiteDO:CREAR_TRAMITE": "creó el DO",
  "TramiteDO:UPDATE": "editó el DO",
  "TramiteDO:UPDATE_ESTADO": "cambió el estado del DO",
  "TramiteDO:CAMBIO_ESTADO": "cambió el estado del DO",
  "TramiteDO:REAPERTURA": "reabrió el DO",
  // Borradores de factura de venta
  "BorradorFactura:CREATE": "generó un borrador de factura",
  "BorradorFactura:UPDATE": "actualizó un borrador de factura",
  "BorradorFactura:UPDATE_ESTADO": "cambió el estado de un borrador de factura",
  "BorradorFactura:FACTURAR": "marcó como facturado un borrador",
  "BorradorFactura:UPDATE_COMISION": "actualizó la comisión de un borrador",
  "BorradorFactura:UPDATE_COMISION_INTERNA_LM": "actualizó la comisión interna LM de un borrador",
  "BorradorFactura:UPDATE_COMENTARIOS": "editó las observaciones de un borrador",
  "BorradorFactura:SIIGO_ENVIAR_OK": "envió una factura a SIIGO",
  "BorradorFactura:SIIGO_ENVIAR_ERROR": "intentó enviar una factura a SIIGO (falló)",
  "BorradorFactura:SIIGO_SINCRONIZAR": "sincronizó una factura desde SIIGO",
  "LineaRevision:CREATE": "agregó una línea al borrador",
  "LineaRevision:UPDATE": "editó una línea del borrador",
  "LineaRevision:DELETE": "eliminó una línea del borrador",
  // Cartera
  "Factura:UPDATE": "actualizó una factura",
  "PagoFactura:CREATE": "registró un abono o devolución de factura",
  "PagoFactura:CREATE_PAGO": "registró un abono o devolución de factura",
  "PagoFactura:DELETE": "anuló un pago de factura",
  "PagoFactura:VERIFICAR": "verificó en banco un pago de factura",
  "ConciliacionBatchCartera:CREATE": "concilió un lote de cartera",
  // Anticipos
  "Anticipo:CREATE": "registró un anticipo",
  "Anticipo:CREATE_ANTICIPO": "registró un anticipo",
  "Anticipo:VERIFICAR": "verificó en banco un anticipo",
  "AplicacionAnticipo:APLICAR_ANTICIPO": "aplicó un anticipo a un DO",
  "AplicacionAnticipo:ELIMINAR_APLICACION_ANTICIPO": "quitó la aplicación de un anticipo",
  // Pagos a proveedores / facturas de proveedor
  "PagoTramite:CREATE": "registró un pago a proveedor",
  "PagoTramite:CREATE_PAGO": "registró un pago a proveedor",
  "PagoTramite:UPDATE": "editó un pago a proveedor",
  "PagoTramite:DELETE": "eliminó un pago a proveedor",
  "PagoTramiteGrupo:CREATE": "registró un grupo de pagos a proveedores",
  "FacturaProveedor:CREATE": "registró una factura de proveedor",
  "FacturaProveedor:UPDATE": "editó una factura de proveedor",
  "FacturaProveedor:DELETE": "eliminó una factura de proveedor",
  "FacturaProveedor:UPDATE_ESTADO": "cambió el estado de una factura de proveedor",
  // Beneficiarios y cuenta corriente
  "Beneficiario:CREATE_BENEFICIARIO": "creó un beneficiario",
  "Beneficiario:UPDATE_BENEFICIARIO": "editó un beneficiario",
  "MovimientoCuenta:CREATE_MOVIMIENTO_CUENTA": "registró un movimiento de cuenta corriente",
  "MovimientoCuenta:DELETE_MOVIMIENTO_CUENTA": "eliminó un movimiento de cuenta corriente",
  // Documentos
  "Documento:CREATE": "subió un documento",
  "Documento:DELETE": "eliminó un documento",
  "Documento:REPLACE": "reemplazó un documento",
  "DocumentoEnlace:CREATE": "creó un enlace para compartir un documento",
  "DocumentoEnlace:REVOKE": "revocó un enlace de documento",
  // Configuración
  "EmpresaCapacidad:SET_CAPACIDAD_EMPRESA": "activó o desactivó una función de la empresa",
  "EmpresaCapacidad:RESET_CAPACIDAD_EMPRESA": "restableció una función de la empresa",
  "Parametro:UPDATE": "editó un parámetro del sistema",
  "MatrizRecaudo:UPDATE": "editó la matriz de recaudo",
  "MatrizPago:UPDATE": "editó la matriz de pagos",
  "SiigoProducto:SYNC": "sincronizó los productos de SIIGO",
  "SiigoImpuesto:SYNC": "sincronizó los impuestos de SIIGO",
  "SiigoFormaPago:SYNC": "sincronizó las formas de pago de SIIGO",
  "SiigoTipoComprobante:SYNC": "sincronizó los tipos de comprobante de SIIGO",
  "SiigoVendedor:SYNC": "sincronizó los vendedores de SIIGO",
  "SiigoProductoImpuesto:UPDATE": "asoció impuestos a un producto de SIIGO",
  "User:RESET_PASSWORD": "restableció la contraseña de un usuario",
};

/** Segundo intento: solo por acción (para entidades nuevas o no listadas). */
const ACCIONES_GENERICAS: Record<string, string> = {
  CREATE: "creó",
  CREATE_TRAMITE: "creó el DO",
  CREAR_TRAMITE: "creó el DO",
  UPDATE: "editó",
  UPDATE_ESTADO: "cambió el estado de",
  CAMBIO_ESTADO: "cambió el estado de",
  DELETE: "eliminó",
  REPLACE: "reemplazó",
  REVOKE: "revocó",
  SYNC: "sincronizó",
  VERIFICAR: "verificó",
  FACTURAR: "marcó como facturado",
  REAPERTURA: "reabrió",
  CREATE_PAGO: "registró un pago",
  CREATE_ANTICIPO: "registró un anticipo",
  APLICAR_ANTICIPO: "aplicó un anticipo",
  ELIMINAR_APLICACION_ANTICIPO: "quitó la aplicación de un anticipo",
  SET_CAPACIDAD_EMPRESA: "activó o desactivó una función de la empresa",
  RESET_CAPACIDAD_EMPRESA: "restableció una función de la empresa",
  RESET_PASSWORD: "restableció una contraseña",
};

/** Nombre legible de la entidad, para las acciones genéricas y el fallback. */
const ENTIDAD_LEGIBLE: Record<string, string> = {
  TramiteDO: "el DO",
  BorradorFactura: "un borrador de factura",
  LineaRevision: "una línea de borrador",
  Factura: "una factura",
  PagoFactura: "un pago de factura",
  ConciliacionBatchCartera: "un lote de cartera",
  Anticipo: "un anticipo",
  AplicacionAnticipo: "una aplicación de anticipo",
  PagoTramite: "un pago a proveedor",
  PagoTramiteGrupo: "un grupo de pagos",
  FacturaProveedor: "una factura de proveedor",
  Beneficiario: "un beneficiario",
  MovimientoCuenta: "un movimiento de cuenta corriente",
  Documento: "un documento",
  DocumentoEnlace: "un enlace de documento",
  EmpresaCapacidad: "una función de la empresa",
  Parametro: "un parámetro",
  MatrizRecaudo: "la matriz de recaudo",
  MatrizPago: "la matriz de pagos",
  User: "un usuario",
};

/** "SET_CAPACIDAD_EMPRESA" → "Set capacidad empresa". */
function humanizarCodigo(codigo: string): string {
  const texto = codigo.replace(/_/g, " ").trim().toLowerCase();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : codigo;
}

/**
 * Frase para la actividad, sin el nombre del usuario: "creó el DO",
 * "registró un anticipo", …  Orden: entidad+acción → acción+entidad legible →
 * fallback legible del código.
 */
export function describirActividad(row: Pick<ActividadRecienteRow, "accion" | "entidad">): string {
  const porEntidad = ACTIVIDAD_POR_ENTIDAD[`${row.entidad}:${row.accion}`];
  if (porEntidad) return porEntidad;

  const generica = ACCIONES_GENERICAS[row.accion];
  const entidad = ENTIDAD_LEGIBLE[row.entidad];
  if (generica && entidad) {
    // "creó" + "un anticipo" → "creó un anticipo"; "cambió el estado de" + "el DO"
    return `${generica} ${entidad}`;
  }
  if (generica) return `${generica} ${humanizarCodigo(row.entidad).toLowerCase()}`;

  const accion = humanizarCodigo(row.accion).toLowerCase();
  return entidad ? `${accion} · ${entidad}` : `${accion} · ${humanizarCodigo(row.entidad)}`;
}

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
              <p
                className="truncate text-sm text-slate-800"
                title={`${row.entidad} · ${row.accion}`}
              >
                <span className="font-medium">{usuario}</span> {describirActividad(row)}
                <span className="text-slate-400"> · {formatDate(row.createdAt)}</span>
              </p>
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
  if (loadState === "loading") {
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
  if (loadState === "error" || !data) {
    return (
      <section className="space-y-5">
        <DashboardHeader onRefresh={handleRefresh} refreshing={false} />
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
          sub={
            data.cantidadFacturasVencidas > 0
              ? `${data.cantidadFacturasVencidas} factura${data.cantidadFacturasVencidas !== 1 ? "s" : ""} sin cobrar`
              : "Al día"
          }
          href="/cartera?pendientes=true"
          icon={<Wallet className="h-4 w-4" aria-hidden="true" />}
          alert={data.cantidadFacturasVencidas > 0}
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

      {/* Sección alertas de cartera — clientes bajo el umbral configurado */}
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
