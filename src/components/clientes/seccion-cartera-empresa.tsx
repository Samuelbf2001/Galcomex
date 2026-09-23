"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  fetchCartera,
  formatCOP,
  formatDate,
  type FacturaRow,
} from "@/components/cartera/cartera-api";
import { ModuleState } from "@/components/layout/module-state";
import { EnlaceFacturaVenta, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { Paginacion, usePaginacionLocal } from "@/components/ui/paginacion";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

/**
 * Sección «Cartera» de la ficha de empresa (revisión 22-sep): el cruce de
 * cartera factura por factura, ya descontando abonos y devoluciones. Wording
 * fijo con los documentos de Galcomex: "saldo a favor del cliente" = Galcomex
 * le debe; "saldo a cargo del cliente" = el cliente le debe a Galcomex. Nunca
 * rojo/verde para estos dos conceptos — ámbar y cian, iguales en toda la ficha.
 *
 * No repite el listado de /cartera (esa es la vista operativa con filtros,
 * conciliación y export); aquí solo el resumen de esta empresa con enlace a
 * la vista completa, donde se registran los abonos.
 */

// ─── Helpers puros (testeados en seccion-cartera-empresa.test.tsx) ───────────

export type EstadoFacturaCartera = "SALDADA" | "POR_COBRAR" | "POR_DEVOLVER";

type FilaEstado = Pick<FacturaRow, "pendienteCobroCliente" | "pendienteDevolucionCliente">;

/** Estado de una factura ya neto de abonos y devoluciones (ledger de cartera). */
export function estadoFacturaCartera(fila: FilaEstado): EstadoFacturaCartera {
  if (BigInt(fila.pendienteCobroCliente || "0") > 0n) return "POR_COBRAR";
  if (BigInt(fila.pendienteDevolucionCliente || "0") > 0n) return "POR_DEVOLVER";
  return "SALDADA";
}

export const ESTADO_CARTERA_LABEL: Record<EstadoFacturaCartera, string> = {
  SALDADA: "Saldada",
  POR_COBRAR: "Por cobrar",
  POR_DEVOLVER: "Por devolver o cruzar",
};

const ESTADO_CARTERA_CLASE: Record<EstadoFacturaCartera, string> = {
  SALDADA: "border-slate-200 bg-slate-50 text-slate-600",
  POR_COBRAR: "border-amber-200 bg-amber-50 text-amber-800",
  POR_DEVOLVER: "border-cyan-200 bg-cyan-50 text-cyan-800",
};

export type KpisCarteraEmpresa = { totalACargo: bigint; totalAFavor: bigint };

/** Σ pendienteCobroCliente / Σ pendienteDevolucionCliente de un grupo de facturas. */
export function calcularKpisCarteraEmpresa(facturas: FilaEstado[]): KpisCarteraEmpresa {
  return facturas.reduce<KpisCarteraEmpresa>(
    (acc, f) => ({
      totalACargo: acc.totalACargo + BigInt(f.pendienteCobroCliente || "0"),
      totalAFavor: acc.totalAFavor + BigInt(f.pendienteDevolucionCliente || "0"),
    }),
    { totalACargo: 0n, totalAFavor: 0n },
  );
}

/** Frase del neto (`cruceCliente`): quién le debe a quién, con el monto incluido. */
export function fraseNetoCartera(cruceCliente: string, nombreEmpresa: string): string {
  let cruce: bigint;
  try {
    cruce = BigInt(cruceCliente);
  } catch {
    return "Saldada";
  }
  if (cruce === 0n) return "Saldada";
  if (cruce < 0n) return `${nombreEmpresa} le debe a Galcomex ${formatCOP((-cruce).toString())}`;
  return `Galcomex le debe a ${nombreEmpresa} ${formatCOP(cruce.toString())}`;
}

/** Color del texto del KPI "Neto" según el signo del cruce (ámbar/cian, nunca rojo/verde). */
function colorNetoCartera(cruceCliente: string): string {
  let cruce: bigint;
  try {
    cruce = BigInt(cruceCliente);
  } catch {
    return "text-slate-600";
  }
  if (cruce < 0n) return "text-amber-800";
  if (cruce > 0n) return "text-cyan-800";
  return "text-slate-600";
}

// ─── Componente ────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "error";

export function SeccionCarteraEmpresa({
  clienteId,
  nombreEmpresa,
}: {
  clienteId: string;
  nombreEmpresa: string;
}) {
  // GET /api/cartera es ADMIN/REVISOR.
  const puedeVer = usePermiso(["ADMIN", "REVISOR"]);

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [facturas, setFacturas] = useState<FacturaRow[]>([]);
  const [cruceCliente, setCruceCliente] = useState("0");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Con criterio explícito: si el rol no puede, ni se consulta.
    if (!puedeVer) return;

    const controller = new AbortController();

    fetchCartera(clienteId, false, undefined, undefined, controller.signal)
      .then((datos) => {
        setFacturas(datos.facturas);
        setCruceCliente(datos.cruceCliente);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar la cartera."));
        setLoadState("error");
      });

    return () => controller.abort();
  }, [clienteId, puedeVer, reloadKey]);

  // Más reciente primero; el API ya ordena así, pero no dependemos de eso.
  const ordenadas = useMemo(
    () => [...facturas].sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()),
    [facturas],
  );

  const kpis = useMemo(() => calcularKpisCarteraEmpresa(ordenadas), [ordenadas]);

  useEffect(() => {
    if (loadState !== "ready") return;
    let cruce: bigint;
    try {
      cruce = BigInt(cruceCliente);
    } catch {
      return;
    }
    // La suma de filas (a favor − a cargo) tiene que dar lo mismo que el
    // cruce que manda el API: es la misma fórmula. Si no cuadra, manda el
    // API (puede estar mirando algo distinto) y se deja constancia aquí.
    if (kpis.totalAFavor - kpis.totalACargo !== cruce) {
      console.warn(
        `[SeccionCarteraEmpresa] La suma de facturas (${(kpis.totalAFavor - kpis.totalACargo).toString()}) no coincide con cruceCliente (${cruce.toString()}) para el cliente ${clienteId}.`,
      );
    }
  }, [loadState, kpis, cruceCliente, clienteId]);

  const { visibles, pagina, porPagina, setPagina, setPorPagina, total } = usePaginacionLocal(
    ordenadas,
    25,
  );

  if (!puedeVer) return null;

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Cartera</p>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-500">
            Cruce de cartera: lo que el cliente le debe a Galcomex y lo que Galcomex le debe,
            factura por factura. Ya descuenta abonos y devoluciones.
          </p>
        </div>
        <Link
          href={`/cartera?clienteId=${clienteId}`}
          className="text-xs text-cyan-700 underline hover:text-cyan-900"
        >
          Ver en Cartera
        </Link>
      </div>

      {loadState === "loading" ? (
        <div className="p-4">
          <TableSkeleton rows={6} cols={9} />
        </div>
      ) : loadState === "error" ? (
        <div className="p-4">
          <ModuleState
            type="error"
            title="No se pudo cargar la cartera"
            detail={loadError ?? undefined}
            action={{ label: "Reintentar", onClick: recargar }}
          />
        </div>
      ) : facturas.length === 0 ? (
        <div className="p-4">
          <ModuleState type="empty" title="Esta empresa no tiene facturas" />
        </div>
      ) : (
        <>
          <div className="grid gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-3">
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Saldo a cargo del cliente
              </p>
              <p className="mt-0.5 font-mono text-lg font-bold text-amber-800">
                {formatCOP(kpis.totalACargo.toString())}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">le debe a Galcomex</p>
            </div>
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Saldo a favor del cliente
              </p>
              <p className="mt-0.5 font-mono text-lg font-bold text-cyan-800">
                {formatCOP(kpis.totalAFavor.toString())}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">Galcomex le debe</p>
            </div>
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Neto</p>
              <p className={`mt-0.5 text-sm font-semibold ${colorNetoCartera(cruceCliente)}`}>
                {fraseNetoCartera(cruceCliente, nombreEmpresa)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2.5">Factura</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">DO</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Fecha</th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total factura</th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">Abonado</th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                    Saldo a cargo del cliente
                  </th>
                  <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                    Saldo a favor del cliente
                  </th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Estado</th>
                  <th className="border-b border-slate-200 px-4 py-2.5">Fecha de pago</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((f) => {
                  const estado = estadoFacturaCartera(f);
                  const devoluciones = BigInt(f.devolucionesCliente || "0");
                  const aCargo = BigInt(f.pendienteCobroCliente || "0");
                  const aFavor = BigInt(f.pendienteDevolucionCliente || "0");

                  return (
                    <tr key={f.id} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-4 py-2.5 font-mono font-semibold">
                        <EnlaceFacturaVenta
                          tramiteId={f.borrador?.tramiteId ?? null}
                          borradorId={f.borradorId}
                        >
                          {f.numSiigo}
                        </EnlaceFacturaVenta>
                      </td>
                      <td className="px-4 py-2.5">
                        <EnlaceTramite id={f.borrador?.tramiteId ?? null}>
                          {f.borrador?.tramite.consecutivo ?? "—"}
                        </EnlaceTramite>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{formatDate(f.fecha)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-900">
                        {formatCOP(f.totalFactura)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-900">
                        {formatCOP(f.abonosCliente || "0")}
                        {devoluciones > 0n ? (
                          <span className="mt-0.5 block text-xs font-normal text-slate-500">
                            Devuelto {formatCOP(devoluciones.toString())}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-amber-800">
                        {aCargo > 0n ? formatCOP(aCargo.toString()) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-cyan-800">
                        {aFavor > 0n ? formatCOP(aFavor.toString()) : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex h-6 items-center whitespace-nowrap border px-2 text-xs font-semibold ${ESTADO_CARTERA_CLASE[estado]}`}
                        >
                          {ESTADO_CARTERA_LABEL[estado]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">{formatDate(f.fechaPagoCliente)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Paginacion
            total={total}
            pagina={pagina}
            porPagina={porPagina}
            onPaginaChange={setPagina}
            onPorPaginaChange={setPorPagina}
            etiqueta="facturas"
          />
        </>
      )}
    </div>
  );
}
