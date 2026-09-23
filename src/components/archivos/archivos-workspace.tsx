"use client";

import {
  ChevronRight,
  CornerLeftUp,
  Download,
  ExternalLink,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  HardDrive,
  Image as ImageIcon,
  RotateCcw,
  Search,
  Ship,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  type ArchivoRow,
  type CarpetaData,
  type CarpetaRow,
  ArchivosApiError,
  etiquetaCategoria,
  fetchCarpeta,
  formatBytes,
  formatFechaHora,
  prefijoDeConsecutivo,
  prefijoPadre,
} from "@/components/archivos/archivos-api";
import { ModuleState } from "@/components/layout/module-state";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { TableSkeleton } from "@/components/ui/skeleton";

type LoadState = "idle" | "loading" | "ready" | "error";

function hrefDe(prefix: string): string {
  return prefix ? `/archivos?p=${encodeURIComponent(prefix)}` : "/archivos";
}

function IconoArchivo({ nombre }: { nombre: string }) {
  const ext = nombre.toLowerCase().slice(nombre.lastIndexOf(".") + 1);
  const cls = "h-4 w-4 shrink-0";
  if (ext === "pdf") return <FileText className={`${cls} text-rose-600`} aria-hidden="true" />;
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return <ImageIcon className={`${cls} text-violet-600`} aria-hidden="true" />;
  if (["xlsx", "xls", "csv"].includes(ext)) return <FileSpreadsheet className={`${cls} text-emerald-600`} aria-hidden="true" />;
  return <File className={`${cls} text-slate-500`} aria-hidden="true" />;
}

function Migas({ migas }: { migas: CarpetaData["migas"] }) {
  return (
    <nav aria-label="Ruta actual" className="min-w-0 flex-1">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {migas.map((m, i) => {
          const ultima = i === migas.length - 1;
          return (
            <li key={m.prefix || "raiz"} className="flex items-center gap-1">
              {i > 0 ? <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" /> : null}
              {ultima ? (
                <span className="font-semibold text-slate-900" aria-current="location">{m.nombre}</span>
              ) : (
                <Link href={hrefDe(m.prefix)} className="text-cyan-700 hover:underline">{m.nombre}</Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function FilaCarpeta({ carpeta }: { carpeta: CarpetaRow }) {
  // Dentro de un DO las carpetas son categorías (FACTURA_COMERCIAL…): se
  // muestra su nombre legible cuando lo conocemos.
  const categoria = etiquetaCategoria(carpeta.nombre);
  const detalleCategoria = categoria && categoria !== carpeta.nombre ? categoria : null;
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-4 py-2.5">
        <Link href={hrefDe(carpeta.prefix)} className="flex min-h-9 items-center gap-2 font-medium text-slate-900 hover:text-cyan-700">
          <Folder className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <span className="truncate">{carpeta.nombre}</span>
        </Link>
      </td>
      <td className="px-4 py-2.5 text-slate-600">
        {carpeta.tramite ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 text-cyan-700">
              <Ship className="h-3.5 w-3.5" aria-hidden="true" />
              <EnlaceTramite id={carpeta.tramite.id}>{carpeta.tramite.consecutivo}</EnlaceTramite>
            </span>
            <span className="truncate">
              <EnlaceCliente id={carpeta.tramite.clienteId}>{carpeta.tramite.cliente}</EnlaceCliente>
            </span>
          </span>
        ) : detalleCategoria ? (
          <span className="inline-flex items-center border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-medium text-slate-700">{detalleCategoria}</span>
        ) : (
          <span className="text-slate-400">Carpeta</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right text-slate-400">—</td>
      <td className="px-4 py-2.5 text-slate-400">—</td>
      <td className="px-4 py-2.5 text-right">
        <Link href={hrefDe(carpeta.prefix)} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100">
          Abrir
        </Link>
      </td>
    </tr>
  );
}

function FilaArchivo({ archivo }: { archivo: ArchivoRow }) {
  const nombre = archivo.nombreRegistrado ?? archivo.nombre;
  const categoria = etiquetaCategoria(archivo.categoria);
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-4 py-2.5">
        <div className="flex min-h-9 items-center gap-2">
          <IconoArchivo nombre={nombre} />
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900" title={nombre}>{nombre}</p>
            {archivo.nombreRegistrado && archivo.nombreRegistrado !== archivo.nombre ? (
              <p className="truncate text-xs text-slate-400" title={archivo.nombre}>{archivo.nombre}</p>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-2.5 text-slate-600">
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {categoria ? (
            <span className="inline-flex items-center border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-medium text-slate-700">{categoria}</span>
          ) : null}
          {archivo.tramite ? (
            <EnlaceTramite id={archivo.tramite.id}>{archivo.tramite.consecutivo}</EnlaceTramite>
          ) : null}
          {archivo.subidoPor ? <span className="text-xs text-slate-500">subido por {archivo.subidoPor}</span> : null}
          {!categoria && !archivo.tramite ? <span className="text-xs text-slate-400">Cargado por fuera de la app</span> : null}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{formatBytes(archivo.size)}</td>
      <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{formatFechaHora(archivo.lastModified)}</td>
      <td className="px-4 py-2.5">
        <div className="flex justify-end gap-1.5">
          <a href={archivo.urlVer} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100" aria-label={`Ver ${nombre}`}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Ver
          </a>
          <a href={archivo.urlDescargar} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-cyan-600 bg-cyan-600 px-3 text-xs font-medium text-white hover:bg-cyan-700" aria-label={`Descargar ${nombre}`}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Descargar
          </a>
        </div>
      </td>
    </tr>
  );
}

/**
 * Explorador de archivos del almacenamiento (MinIO, Cloudflare R2, Backblaze…)
 * al estilo de la consola de MinIO pero dentro de la app: carpetas, migas de
 * pan, filtro por nombre, atajo "Ir al DO" y ver/descargar con enlaces
 * firmados. La carpeta actual va en la URL (`?p=`) para poder compartirla y
 * usar atrás/adelante del navegador.
 */
export function ArchivosWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefix = searchParams.get("p") ?? "";

  const [estado, setEstado] = useState<LoadState>("idle");
  const [data, setData] = useState<CarpetaData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // El filtro se guarda junto con la carpeta a la que aplica: al cambiar de
  // carpeta queda vacío sin necesitar un efecto que lo resetee.
  const [filtroPor, setFiltroPor] = useState<{ prefix: string; valor: string }>({ prefix: "", valor: "" });
  const filtro = filtroPor.prefix === prefix ? filtroPor.valor : "";
  const setFiltro = useCallback((valor: string) => setFiltroPor({ prefix, valor }), [prefix]);
  const [irDo, setIrDo] = useState("");
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function cargar() {
      setEstado("loading");
      setError(null);
      try {
        const d = await fetchCarpeta(prefix, controller.signal);
        if (controller.signal.aborted) return;
        setData(d);
        setEstado("ready");
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setError(e instanceof ArchivosApiError ? e.message : "No fue posible cargar la carpeta.");
        setEstado("error");
      }
    }

    void cargar();
    return () => controller.abort();
  }, [prefix, intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);

  const filtroNorm = filtro.trim().toLowerCase();
  const carpetas = useMemo(
    () =>
      (data?.carpetas ?? []).filter(
        (c) =>
          !filtroNorm ||
          c.nombre.toLowerCase().includes(filtroNorm) ||
          c.tramite?.consecutivo.toLowerCase().includes(filtroNorm) ||
          c.tramite?.cliente.toLowerCase().includes(filtroNorm),
      ),
    [data, filtroNorm],
  );
  const archivos = useMemo(
    () =>
      (data?.archivos ?? []).filter(
        (a) =>
          !filtroNorm ||
          a.nombre.toLowerCase().includes(filtroNorm) ||
          a.nombreRegistrado?.toLowerCase().includes(filtroNorm) ||
          etiquetaCategoria(a.categoria)?.toLowerCase().includes(filtroNorm),
      ),
    [data, filtroNorm],
  );

  function onIrDo(event: FormEvent) {
    event.preventDefault();
    const valor = irDo.trim();
    if (!valor) return;
    router.push(hrefDe(prefijoDeConsecutivo(valor)));
    setIrDo("");
  }

  const vacio = estado === "ready" && data && data.carpetas.length === 0 && data.archivos.length === 0;
  const sinCoincidencias = estado === "ready" && !vacio && carpetas.length === 0 && archivos.length === 0;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Archivos</h1>
          <p className="mt-1 text-sm text-slate-600">
            Explorador del almacenamiento de documentos, carpeta por carpeta. Los archivos de cada DO están en{" "}
            <span className="font-mono text-xs">tramites/</span>. Para ver un cliente con todos sus DOs,{" "}
            <Link href="/archivos/clientes" className="text-cyan-700 hover:underline">
              ver por cliente
            </Link>
            .
          </p>
        </div>
        {data ? (
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600" title={data.proveedor.endpoint}>
            <HardDrive className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>
              <span className="font-semibold text-slate-800">{data.proveedor.nombreProveedor}</span>
              {" · bucket "}
              <span className="font-mono">{data.proveedor.bucket}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
        {prefix ? (
          <Link href={hrefDe(prefijoPadre(prefix))} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100" aria-label="Subir un nivel">
            <CornerLeftUp className="h-3.5 w-3.5" aria-hidden="true" />
            Subir
          </Link>
        ) : null}
        <Migas migas={data?.migas ?? [{ nombre: "Archivos", prefix: "" }]} />
        <form onSubmit={onIrDo} className="flex items-center gap-2">
          <label htmlFor="archivos-ir-do" className="text-xs font-medium text-slate-600">Ir al DO</label>
          <input
            id="archivos-ir-do"
            value={irDo}
            onChange={(e) => setIrDo(e.target.value)}
            placeholder="DO.BUN26-0026"
            className="h-9 w-40 rounded-lg border border-slate-300 px-2 text-sm"
          />
          <button type="submit" className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100">Ir</button>
        </form>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Filtrar en esta carpeta"
            aria-label="Filtrar en esta carpeta"
            className="h-9 w-56 rounded-lg border border-slate-300 pl-8 pr-2 text-sm"
          />
        </div>
      </div>

      {estado === "loading" || estado === "idle" ? (
        <TableSkeleton rows={8} cols={5} />
      ) : estado === "error" ? (
        <ModuleState
          type="error"
          title="No fue posible cargar esta carpeta"
          detail={error ?? undefined}
          action={{ label: "Reintentar", onClick: reintentar }}
        />
      ) : vacio ? (
        <ModuleState
          type="empty"
          title={prefix ? "Esta carpeta está vacía" : "El almacenamiento está vacío"}
          detail={
            prefix
              ? "Aún no hay archivos aquí."
              : "Cuando se suban documentos a un DO, o se cargue el histórico, aparecerán aquí."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2.5">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-2.5">Detalle</th>
                <th className="border-b border-slate-200 px-4 py-2.5 text-right">Tamaño</th>
                <th className="border-b border-slate-200 px-4 py-2.5">Modificado</th>
                <th className="border-b border-slate-200 px-4 py-2.5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {carpetas.map((c) => <FilaCarpeta key={c.prefix} carpeta={c} />)}
              {archivos.map((a) => <FilaArchivo key={a.key} archivo={a} />)}
              {sinCoincidencias ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Nada coincide con “{filtro}” en esta carpeta.
                    <button type="button" onClick={() => setFiltro("")} className="ml-2 inline-flex items-center gap-1 text-cyan-700 hover:underline">
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      Quitar filtro
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {data ? (
            <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
              {data.resumen.carpetas} carpeta{data.resumen.carpetas === 1 ? "" : "s"} · {data.resumen.archivos} archivo{data.resumen.archivos === 1 ? "" : "s"}
              {data.resumen.bytes > 0 ? ` · ${formatBytes(data.resumen.bytes)} en esta carpeta` : ""}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
