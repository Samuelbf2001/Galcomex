"use client";

import { ChevronLeft, FolderOpen, Ship } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ArchivosApiError } from "@/components/archivos/archivos-api";
import {
  type ClienteConDetalle,
  fetchClienteConArchivos,
} from "@/components/archivos/archivos-clientes-api";
import { ModuleState } from "@/components/layout/module-state";
import { EstadoTramiteBadge } from "@/components/ui/estado-tramite";
import { Paginacion, usePaginacionLocal } from "@/components/ui/paginacion";
import { TableSkeleton } from "@/components/ui/skeleton";

type LoadState = "loading" | "ready" | "error";

const SIN_TRAMITES: ClienteConDetalle["tramites"] = [];

/** Todos los DOs de un cliente, cada uno con su carpeta del explorador, más sus sueltos si hay. */
export function ArchivosClienteDetalleWorkspace({ clienteId }: { clienteId: string }) {
  const [estado, setEstado] = useState<LoadState>("loading");
  const [data, setData] = useState<ClienteConDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  const { visibles, pagina, porPagina, total, setPagina, setPorPagina } = usePaginacionLocal(
    data?.tramites ?? SIN_TRAMITES,
    25,
    { pagina: "pagina", porPagina: "porPagina" },
  );

  useEffect(() => {
    const controller = new AbortController();
    async function cargar() {
      setEstado("loading");
      setError(null);
      try {
        const d = await fetchClienteConArchivos(clienteId, controller.signal);
        if (controller.signal.aborted) return;
        setData(d);
        setEstado("ready");
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setError(e instanceof ArchivosApiError ? e.message : "No fue posible cargar este cliente.");
        setEstado("error");
      }
    }
    void cargar();
    return () => controller.abort();
  }, [clienteId, intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  return (
    <section className="space-y-5">
      <div>
        <Link href="/archivos/clientes" className="inline-flex items-center gap-1 text-sm text-cyan-700 hover:underline">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Por cliente
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{data ? data.nombre : "Cliente"}</h1>
        {data ? <p className="mt-1 font-mono text-xs text-slate-500">NIT {data.nit}</p> : null}
      </div>

      {estado === "loading" ? (
        <TableSkeleton rows={6} cols={4} />
      ) : estado === "error" ? (
        <ModuleState type="error" title="No fue posible cargar este cliente" detail={error ?? undefined} action={{ label: "Reintentar", onClick: reintentar }} />
      ) : !data ? null : (
        <>
          {data.sueltosPrefix ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3">
              <p className="text-sm text-slate-600">
                Este cliente tiene documentos del histórico cargados fuera de un DO (sin registrar en la app).
              </p>
              <Link
                href={`/archivos?p=${encodeURIComponent(data.sueltosPrefix)}`}
                className="inline-flex min-h-9 items-center gap-1 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                Ver sueltos
              </Link>
            </div>
          ) : null}

          {data.tramites.length === 0 ? (
            <ModuleState type="empty" title="Este cliente todavía no tiene DOs con documentos" />
          ) : (
            <div className="border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="border-b border-slate-200 px-4 py-2.5">DO</th>
                      <th className="border-b border-slate-200 px-4 py-2.5">Estado</th>
                      <th className="border-b border-slate-200 px-4 py-2.5 text-right">Documentos</th>
                      <th className="border-b border-slate-200 px-4 py-2.5 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((t) => (
                      <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-2.5">
                          <Link href={`/tramites/${t.id}`} className="flex min-h-9 items-center gap-2 font-medium text-slate-900 hover:text-cyan-700">
                            <Ship className="h-4 w-4 shrink-0 text-cyan-600" aria-hidden="true" />
                            {t.consecutivo}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          <EstadoTramiteBadge estado={t.estado} />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{t.documentos || "—"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Link
                            href={`/archivos?p=${encodeURIComponent(t.prefix)}`}
                            className="inline-flex min-h-9 items-center gap-1 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                            Ver archivos
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Paginacion
                total={total}
                pagina={pagina}
                porPagina={porPagina}
                onPaginaChange={setPagina}
                onPorPaginaChange={setPorPagina}
                etiqueta="DO"
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
