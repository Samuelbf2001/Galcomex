"use client";

import { HandCoins, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { formatCOP } from "@/components/clientes/tarifas-api";
import {
  fetchComisionesEmpresa,
  type ComisionesEmpresaRow,
} from "@/components/comisiones/comisiones-api";
import { ModuleState } from "@/components/layout/module-state";
import { EnlaceTramite } from "@/components/ui/enlace-entidad";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

/**
 * Ficha de la empresa que paga comisión por contenedor (LTRANS): qué DOs
 * llevan comisión, cuántos contenedores y cuánto va por facturar (+ IVA).
 * Solo aparece si la empresa tiene «Comisión a cobrar por contenedor».
 */
export function SeccionComisionesEmpresa({ empresaId }: { empresaId: string }) {
  // GET /api/clientes/[id]/comisiones → ADMIN y REVISOR (los que ven cartera).
  const puedeVer = usePermiso(["ADMIN", "REVISOR"]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [datos, setDatos] = useState<ComisionesEmpresaRow | null>(null);
  const [reintento, setReintento] = useState(0);

  useEffect(() => {
    if (!puedeVer) return;
    const controller = new AbortController();
    fetchComisionesEmpresa(empresaId, controller.signal)
      .then((respuesta) => {
        setDatos(respuesta);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "No fue posible cargar las comisiones."));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [empresaId, puedeVer, reintento]);

  if (!puedeVer) return null;
  if (loadState === "ready" && datos && !datos.habilitada && datos.filas.length === 0) return null;

  const recargar = () => {
    setLoadState("loading");
    setReintento((k) => k + 1);
  };

  return (
    <section className="border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-slate-900">Comisiones por contenedor — por facturar</h2>
        </div>
        <button
          type="button"
          onClick={recargar}
          className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          aria-label="Refrescar comisiones"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {loadState === "error" ? (
        <ModuleState
          type="error"
          title="No fue posible cargar las comisiones"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : loadState === "loading" || !datos ? (
        <TableSkeleton rows={3} cols={5} rowHeight={40} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Lo que esta empresa le debe a Galcomex por los contenedores marcados con comisión en cada DO.
            Valor por contenedor: <strong>{formatCOP(datos.valorUnitario)}</strong> + IVA {datos.tasaIva} %.
          </p>

          {datos.valorUnitario === "0" ? (
            <p role="alert" className="border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Falta el valor por contenedor: configúralo en Funciones → «Comisión a cobrar por contenedor» →
              valor (hoy LTRANS paga 90000).
            </p>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-4">
            <div className="border border-slate-200 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Contenedores</dt>
              <dd className="text-lg font-semibold text-slate-900">{datos.totales.unidades}</dd>
            </div>
            <div className="border border-slate-200 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">Subtotal</dt>
              <dd className="font-mono text-lg font-semibold text-slate-900">{formatCOP(datos.totales.subtotal)}</dd>
            </div>
            <div className="border border-slate-200 p-3">
              <dt className="text-xs uppercase tracking-wide text-slate-500">IVA</dt>
              <dd className="font-mono text-lg font-semibold text-slate-900">{formatCOP(datos.totales.iva)}</dd>
            </div>
            <div className="border border-emerald-300 bg-emerald-50 p-3">
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Total por facturar</dt>
              <dd className="font-mono text-lg font-semibold text-emerald-900">{formatCOP(datos.totales.total)}</dd>
            </div>
          </dl>

          {datos.filas.length === 0 ? (
            <ModuleState
              type="empty"
              title="Todavía no hay DOs con comisión"
              detail="Se marcan dentro de cada DO de traslado, en «Comisión por contenedor»."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-2">DO</th>
                    <th className="px-2 py-2">Empresa del DO</th>
                    <th className="px-2 py-2">Referencia</th>
                    <th className="px-2 py-2 text-right">Contenedores del DO</th>
                    <th className="px-2 py-2 text-right">Con comisión</th>
                    <th className="px-2 py-2 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {datos.filas.map((f) => (
                    <tr key={f.tramiteId}>
                      <td className="px-2 py-2 font-medium">
                        <EnlaceTramite id={f.tramiteId}>{f.consecutivo}</EnlaceTramite>
                      </td>
                      <td className="px-2 py-2 text-slate-700">{f.empresaDo}</td>
                      <td className="px-2 py-2 text-slate-600">{f.referencia ?? "—"}</td>
                      <td className="px-2 py-2 text-right text-slate-700">{f.numContenedores ?? "—"}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-900">{f.unidades}</td>
                      <td className="px-2 py-2 text-right font-mono text-slate-900">{formatCOP(f.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
