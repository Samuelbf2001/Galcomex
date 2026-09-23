"use client";

import { Ship, Folder, FolderOpen, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type ClienteConArchivos,
  fetchClientesConArchivos,
} from "@/components/archivos/archivos-clientes-api";
import { ArchivosApiError } from "@/components/archivos/archivos-api";
import { ModuleState } from "@/components/layout/module-state";
import { TableSkeleton } from "@/components/ui/skeleton";

type LoadState = "loading" | "ready" | "error";

/**
 * Vista "Por cliente": un cliente = una fila, con cuántos DOs y documentos
 * tiene y, si aplica, un enlace directo a sus sueltos del histórico. Datos de
 * la plataforma, no del bucket — por eso aparece cualquier cliente con
 * trámites aunque su carpeta en el bucket tenga otro nombre.
 */
export function ArchivosClientesWorkspace() {
  const [estado, setEstado] = useState<LoadState>("loading");
  const [clientes, setClientes] = useState<ClienteConArchivos[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function cargar() {
      setEstado("loading");
      setError(null);
      try {
        const data = await fetchClientesConArchivos(controller.signal);
        if (controller.signal.aborted) return;
        setClientes(data);
        setEstado("ready");
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setError(e instanceof ArchivosApiError ? e.message : "No fue posible cargar los clientes.");
        setEstado("error");
      }
    }
    void cargar();
    return () => controller.abort();
  }, [intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  const filtroNorm = filtro.trim().toLowerCase();
  const filtrados = useMemo(
    () =>
      clientes.filter(
        (c) => !filtroNorm || c.nombre.toLowerCase().includes(filtroNorm) || c.nit.toLowerCase().includes(filtroNorm),
      ),
    [clientes, filtroNorm],
  );

  const conArchivos = filtrados.filter((c) => c.dos > 0 || c.sueltosPrefix);
  const sinArchivos = filtrados.filter((c) => c.dos === 0 && !c.sueltosPrefix);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Archivos · Por cliente</h1>
          <p className="mt-1 text-sm text-slate-600">
            Cada cliente con sus DOs y documentos. Para navegar carpeta por carpeta,{" "}
            <Link href="/archivos" className="text-cyan-700 hover:underline">
              ver por carpeta
            </Link>
            .
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Buscar cliente o NIT"
            aria-label="Buscar cliente o NIT"
            className="h-9 w-64 rounded-lg border border-slate-300 pl-8 pr-2 text-sm"
          />
        </div>
      </div>

      {estado === "loading" ? (
        <TableSkeleton rows={8} cols={4} />
      ) : estado === "error" ? (
        <ModuleState type="error" title="No fue posible cargar los clientes" detail={error ?? undefined} action={{ label: "Reintentar", onClick: reintentar }} />
      ) : filtrados.length === 0 ? (
        <ModuleState
          type="empty"
          title={filtro ? "Ningún cliente coincide con la búsqueda" : "Todavía no hay clientes"}
          detail={filtro ? `Nada coincide con “${filtro}”.` : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2.5">Cliente</th>
                <th className="border-b border-slate-200 px-4 py-2.5">NIT</th>
                <th className="border-b border-slate-200 px-4 py-2.5 text-right">DOs</th>
                <th className="border-b border-slate-200 px-4 py-2.5 text-right">Documentos</th>
                <th className="border-b border-slate-200 px-4 py-2.5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {conArchivos.map((c) => (
                <FilaCliente key={c.id} cliente={c} />
              ))}
              {sinArchivos.map((c) => (
                <FilaCliente key={c.id} cliente={c} atenuado />
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
            {conArchivos.length} cliente{conArchivos.length === 1 ? "" : "s"} con archivos
            {sinArchivos.length > 0 ? ` · ${sinArchivos.length} sin archivos todavía` : ""}
          </p>
        </div>
      )}
    </section>
  );
}

function FilaCliente({ cliente, atenuado }: { cliente: ClienteConArchivos; atenuado?: boolean }) {
  return (
    <tr className={`border-b border-slate-100 hover:bg-slate-50 ${atenuado ? "text-slate-400" : ""}`}>
      <td className="px-4 py-2.5">
        <Link
          href={`/archivos/clientes/${cliente.id}`}
          className={`flex min-h-9 items-center gap-2 font-medium hover:text-cyan-700 ${atenuado ? "text-slate-500" : "text-slate-900"}`}
        >
          <Folder className={`h-4 w-4 shrink-0 ${atenuado ? "text-slate-300" : "text-amber-500"}`} aria-hidden="true" />
          <span className="truncate">{cliente.nombre}</span>
        </Link>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs">{cliente.nit}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{cliente.dos || "—"}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">{cliente.documentos || "—"}</td>
      <td className="px-4 py-2.5 text-right">
        <div className="flex justify-end gap-1.5">
          {cliente.sueltosPrefix ? (
            <Link
              href={`/archivos?p=${encodeURIComponent(cliente.sueltosPrefix)}`}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
              title="Documentos sueltos del histórico, fuera de un DO"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Sueltos
            </Link>
          ) : null}
          <Link
            href={`/archivos/clientes/${cliente.id}`}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-cyan-600 bg-cyan-600 px-3 text-xs font-medium text-white hover:bg-cyan-700"
          >
            <Ship className="h-3.5 w-3.5" aria-hidden="true" />
            Ver DOs
          </Link>
        </div>
      </td>
    </tr>
  );
}
