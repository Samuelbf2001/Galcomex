"use client";

import {
  ArrowDownCircle,
  ArrowUpCircle,
  BadgeCheck,
  CalendarDays,
  Filter,
  RotateCcw,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { EnlaceCliente, EnlaceFacturaVenta, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import {
  type FilaIngreso,
  type TipoIngreso,
  IngresosApiError,
  fetchIngresos,
  formatCOP,
  formatDate,
} from "@/components/ingresos/ingresos-api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type LoadState = "idle" | "loading" | "ready" | "error";

function tipoBadge(tipo: TipoIngreso): React.ReactNode {
  switch (tipo) {
    case "ANTICIPO":
      return (
        <span className="inline-flex items-center gap-1 border border-cyan-300 bg-cyan-50 px-1.5 py-0.5 text-xs font-medium text-cyan-700">
          <ArrowDownCircle className="h-3 w-3" aria-hidden="true" />
          Anticipo
        </span>
      );
    case "ABONO":
      return (
        <span className="inline-flex items-center gap-1 border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
          <ArrowDownCircle className="h-3 w-3" aria-hidden="true" />
          Abono
        </span>
      );
    case "DEVOLUCION":
      return (
        <span className="inline-flex items-center gap-1 border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700">
          <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
          Devolución
        </span>
      );
  }
}

function montoCell(fila: FilaIngreso): React.ReactNode {
  const n = BigInt(fila.montoConSigno);
  const label = formatCOP(fila.monto);
  if (n >= 0n) {
    return <span className="text-emerald-700 font-semibold">+{label}</span>;
  }
  return <span className="text-violet-700 font-semibold">-{label}</span>;
}

function referenciaCell(fila: FilaIngreso): React.ReactNode {
  if (fila.tipo === "ANTICIPO") {
    return <EnlaceTramite id={fila.tramiteId}>{fila.referencia}</EnlaceTramite>;
  }
  return (
    <EnlaceFacturaVenta tramiteId={fila.tramiteId} borradorId={fila.borradorId}>
      {fila.referencia}
    </EnlaceFacturaVenta>
  );
}

function saldoCorridoCell(valor: string): React.ReactNode {
  const n = BigInt(valor);
  const label = formatCOP(valor);
  const colorClass =
    n > 0n ? "text-emerald-700" : n < 0n ? "text-rose-600" : "text-slate-500";
  return <span className={`font-semibold ${colorClass}`}>{label}</span>;
}

/** Primer y último día del mes en curso (YYYY-MM-DD, zona local). */
function rangoMesActual(): { desde: string; hasta: string } {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ultimoDia = new Date(anio, mes + 1, 0).getDate();
  return {
    desde: `${anio}-${pad(mes + 1)}-01`,
    hasta: `${anio}-${pad(mes + 1)}-${pad(ultimoDia)}`,
  };
}

/** "2026-09-07" → "07/09/2026" sin pasar por Date (evita desfases de zona). */
function formatFechaCorta(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return y && m && d ? `${d}/${m}/${y}` : ymd;
}

// ─── Componente principal ─────────────────────────────────────────────────────

type ClienteOption = { id: string; nombre: string; nit: string };

async function fetchClienteOptions(): Promise<ClienteOption[]> {
  const res = await fetch("/api/clientes", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("No se pudo cargar la lista de clientes.");
  const payload: unknown = await res.json().catch(() => null);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as Record<string, unknown>).clientes)
  )
    throw new Error("La lista de clientes no tiene el formato esperado.");
  const clientes = (payload as Record<string, unknown>).clientes as unknown[];
  return clientes
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && !Array.isArray(c),
    )
    .map((c) => ({
      id: String(c.id ?? ""),
      nombre: String(c.nombre ?? ""),
      nit: String(c.nit ?? ""),
    }))
    .filter((c) => c.id);
}

export function IngresosWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialClienteId = searchParams.get("clienteId") ?? "";
  // Sin fechas en la URL, el filtro arranca en el mes en curso (el API
  // acepta desde/hasta); si la URL trae alguna fecha, se respeta tal cual.
  const hayFechasEnUrl = searchParams.has("desde") || searchParams.has("hasta");
  const mesActual = rangoMesActual();
  const initialDesde = hayFechasEnUrl ? (searchParams.get("desde") ?? "") : mesActual.desde;
  const initialHasta = hayFechasEnUrl ? (searchParams.get("hasta") ?? "") : mesActual.hasta;

  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [clientesEstado, setClientesEstado] = useState<LoadState>("loading");
  const [clientesRecarga, setClientesRecarga] = useState(0);
  const [clienteId, setClienteId] = useState(initialClienteId);
  const [desde, setDesde] = useState(initialDesde);
  const [hasta, setHasta] = useState(initialHasta);

  const [filas, setFilas] = useState<FilaIngreso[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Sincronizar URL ──────────────────────────────────────────────────────

  const syncUrl = useCallback(
    (cid: string, d: string, h: string) => {
      const params = new URLSearchParams();
      if (cid) params.set("clienteId", cid);
      // Se escriben siempre (aunque vacías) para que "todo el historial" no se
      // reinterprete como "mes actual" al recargar la página.
      params.set("desde", d);
      params.set("hasta", h);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  function aplicarRango(d: string, h: string) {
    setDesde(d);
    setHasta(h);
    syncUrl(clienteId, d, h);
  }

  // ── Cargar clientes ──────────────────────────────────────────────────────

  useEffect(() => {
    let activo = true;
    async function cargarClientes() {
      setClientesEstado("loading");
      try {
        const opciones = await fetchClienteOptions();
        if (!activo) return;
        setClientes(opciones);
        setClientesEstado("ready");
      } catch {
        if (activo) setClientesEstado("error");
      }
    }
    void cargarClientes();
    return () => { activo = false; };
  }, [clientesRecarga]);

  // ── Cargar ingresos ──────────────────────────────────────────────────────

  const [reloadKey, setReloadKey] = useState(0);

  const recargar = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      const data = await fetchIngresos(
        {
          clienteId: clienteId || undefined,
          desde: desde || undefined,
          hasta: hasta || undefined,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setFilas(data);
      setLoadState("ready");
    }

    load().catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(
        err instanceof IngresosApiError
          ? err.message
          : "Error al cargar los ingresos.",
      );
      setLoadState("error");
    });

    return () => controller.abort();
  }, [clienteId, desde, hasta, reloadKey]);

  // ── Totales ──────────────────────────────────────────────────────────────

  const totalEntradas = filas
    .filter((f) => BigInt(f.montoConSigno) > 0n)
    .reduce((acc, f) => acc + BigInt(f.monto), 0n);
  const totalSalidas = filas
    .filter((f) => BigInt(f.montoConSigno) < 0n)
    .reduce((acc, f) => acc + BigInt(f.monto), 0n);
  const saldoFinal =
    filas.length > 0 ? BigInt(filas[filas.length - 1]!.saldoCorrido) : 0n;

  const esMesActual = desde === mesActual.desde && hasta === mesActual.hasta;
  const rangoActivo =
    desde && hasta
      ? `${formatFechaCorta(desde)} – ${formatFechaCorta(hasta)}`
      : desde
        ? `desde ${formatFechaCorta(desde)}`
        : hasta
          ? `hasta ${formatFechaCorta(hasta)}`
          : "todo el historial";

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="space-y-5">
      {/* Encabezado */}
      <div>
        <h1 className="text-2xl font-semibold">Ingresos</h1>
        <p className="mt-1 text-sm text-slate-600">
          Libro de bancos unificado: anticipos, abonos de factura y devoluciones.
        </p>
      </div>

      {clientesEstado === "error" ? (
        <ModuleState type="error" title="No se pudo cargar el filtro de clientes" detail="Puedes consultar los movimientos mientras recuperamos las opciones del filtro." action={{ label: "Cargar clientes", onClick: () => setClientesRecarga((n) => n + 1) }} />
      ) : null}
      {/* Filtros */}
      <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-4 py-3">
        <Filter className="h-4 w-4 text-slate-400 self-end mb-2.5" aria-hidden="true" />

        {/* Cliente */}
        <label className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
            Cliente
          </span>
          <select
            value={clienteId}
            disabled={clientesEstado !== "ready"}
            onChange={(e) => {
              setClienteId(e.target.value);
              syncUrl(e.target.value, desde, hasta);
            }}
            aria-label="Filtrar por cliente"
            className="h-10 w-80 max-w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
          >
            <option value="">{clientesEstado === "loading" ? "Cargando clientes…" : "Todos los clientes"}</option>
            {clienteId && !clientes.some((c) => c.id === clienteId) ? <option value={clienteId}>Cliente seleccionado</option> : null}
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre} — {c.nit}
              </option>
            ))}
          </select>
        </label>

        {/* Desde */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
            Desde
          </span>
          <input
            type="date"
            value={desde}
            max={hasta || undefined}
            onChange={(e) => aplicarRango(e.target.value, hasta)}
            aria-label="Desde (fecha del movimiento)"
            className="h-10 border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        {/* Hasta */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
            Hasta
          </span>
          <input
            type="date"
            value={hasta}
            min={desde || undefined}
            onChange={(e) => aplicarRango(desde, e.target.value)}
            aria-label="Hasta (fecha del movimiento)"
            className="h-10 border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
          />
        </label>

        {/* Atajos de rango */}
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-600 uppercase tracking-wide">
            Rango
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => aplicarRango(mesActual.desde, mesActual.hasta)}
              aria-pressed={esMesActual}
              className={`h-10 border px-3 text-xs font-semibold transition ${
                esMesActual
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Mes actual
            </button>
            <button
              type="button"
              onClick={() => aplicarRango("", "")}
              aria-pressed={!desde && !hasta}
              className={`h-10 border px-3 text-xs font-semibold transition ${
                !desde && !hasta
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Todo el historial
            </button>
          </div>
        </div>

        {/* Refrescar */}
        <button
          type="button"
          onClick={() => recargar()}
          disabled={loadState === "loading"}
          className="ml-auto inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {loadState === "loading" ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {/* Rango activo */}
      <p className="flex items-center gap-1.5 text-xs text-slate-600" aria-live="polite">
        <CalendarDays className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
        Mostrando movimientos de{" "}
        <span className="font-semibold text-slate-800">{rangoActivo}</span>
        {esMesActual ? <span className="text-slate-400">(mes actual)</span> : null}
      </p>

      {/* Tarjetas de totales */}
      {loadState === "loading" ? <CardsSkeleton count={3} height={100} /> : null}
      {loadState === "ready" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="border border-slate-200 bg-white px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total entradas
            </p>
            <p className="mt-1 text-xl font-bold text-emerald-700">
              +{formatCOP(totalEntradas.toString())}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Anticipos + abonos en el período
            </p>
          </div>
          <div className="border border-slate-200 bg-white px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total salidas
            </p>
            <p className="mt-1 text-xl font-bold text-violet-700">
              -{formatCOP(totalSalidas.toString())}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Devoluciones en el período
            </p>
          </div>
          <div className="border border-slate-200 bg-white px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Saldo de caja
            </p>
            <p
              className={`mt-1 text-xl font-bold ${
                saldoFinal > 0n
                  ? "text-emerald-700"
                  : saldoFinal < 0n
                    ? "text-rose-600"
                    : "text-slate-500"
              }`}
            >
              {formatCOP(saldoFinal.toString())}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {clienteId ? (
                <EnlaceCliente id={clienteId}>
                  {clientes.find((c) => c.id === clienteId)?.nombre ?? "Cliente"}
                </EnlaceCliente>
              ) : (
                "Acumulado por cliente"
              )}
            </p>
          </div>
        </div>
      )}

      {/* Estado */}
      {loadState === "loading" ? (
        <TableSkeleton rows={8} cols={8} rowHeight={45} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No fue posible cargar los ingresos"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : loadState === "ready" && filas.length === 0 ? (
        <ModuleState
          type="empty"
          title="Sin movimientos"
          detail={`No hay anticipos, abonos ni devoluciones en ${rangoActivo}.`}
          action={
            desde || hasta || clienteId
              ? { label: "Quitar filtros", onClick: () => { setClienteId(""); setDesde(""); setHasta(""); syncUrl("", "", ""); }, icon: false }
              : undefined
          }
        />
      ) : loadState === "ready" ? (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 text-xs">
            <p className="font-semibold text-slate-900">
              Movimientos de caja
            </p>
            <p className="text-slate-500">
              {filas.length} registro{filas.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2.5">Fecha</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Tipo</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Referencia</th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                    Entrada / Salida
                  </th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Canal</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Verificado</th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                    Saldo corrido
                  </th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr
                    key={f.id}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                      {formatDate(f.fecha)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {tipoBadge(f.tipo)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700 whitespace-nowrap max-w-[160px] truncate">
                      <EnlaceCliente id={f.clienteId}>{f.clienteNombre}</EnlaceCliente>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-800 whitespace-nowrap">
                      {referenciaCell(f)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {montoCell(f)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600 whitespace-nowrap">
                      {f.canalPago}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {f.verificadoBanco ? (
                        <BadgeCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {saldoCorridoCell(f.saldoCorrido)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
