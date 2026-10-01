"use client";

import { HandCoins, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { formatCOP } from "@/components/clientes/tarifas-api";
import {
  fetchComisionesTramite,
  guardarComisionTramite,
  type ComisionesTramiteRow,
} from "@/components/comisiones/comisiones-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";

type LoadState = "loading" | "ready" | "error";

const INPUT =
  "h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-100";

/** "2 contenedores" / "1 contenedor". */
function contenedores(n: number): string {
  return `${n} contenedor${n === 1 ? "" : "es"}`;
}

/**
 * Comisión por contenedor del DO (caso LTRANS). No todos los contenedores del
 * DO son del tercero: se escribe cuántos llevan comisión (de 4, 2 de LTRANS).
 * Solo aparece en DOs de empresas que piden contenedores y si alguna empresa
 * tiene activa «Comisión a cobrar por contenedor».
 */
export function SeccionComisionTramite({
  tramiteId,
  puedeEditar,
  recargaKey,
}: {
  tramiteId: string;
  puedeEditar: boolean;
  /** Cambia cuando el DO se recarga (p. ej. tras guardar sus contenedores). */
  recargaKey?: unknown;
}) {
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [datos, setDatos] = useState<ComisionesTramiteRow | null>(null);
  const [reintento, setReintento] = useState(0);
  const [empresaId, setEmpresaId] = useState("");
  const [unidades, setUnidades] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchComisionesTramite(tramiteId, controller.signal)
      .then((respuesta) => {
        setDatos(respuesta);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "No fue posible cargar la comisión."));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [tramiteId, reintento, recargaKey]);

  if (loadState === "ready" && datos && !datos.aplica) return null;

  const empresaElegida =
    datos?.empresas.find((e) => e.empresaId === empresaId) ??
    (datos && datos.empresas.length === 1 ? datos.empresas[0] : null);
  const actual = datos?.comisiones.find((c) => c.empresaId === empresaElegida?.empresaId) ?? null;
  const otras = (datos?.comisiones ?? [])
    .filter((c) => c.empresaId !== empresaElegida?.empresaId)
    .reduce((suma, c) => suma + c.unidades, 0);
  const libres = datos?.unidadesDisponibles != null ? datos.unidadesDisponibles - otras : null;

  async function guardar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!empresaElegida || guardando) return;
    const n = Number(unidades);
    if (!Number.isInteger(n) || n < 1) {
      toast({ title: "Escribe cuántos contenedores llevan comisión (1 o más).", variant: "error" });
      return;
    }
    setGuardando(true);
    try {
      const respuesta = await guardarComisionTramite(tramiteId, empresaElegida.empresaId, n);
      setDatos(respuesta);
      setUnidades("");
      toast({
        title: `Comisión guardada: ${contenedores(n)} de ${empresaElegida.nombre}`,
        variant: "success",
      });
    } catch (caught) {
      toast({ title: "No se pudo guardar la comisión", description: describirError(caught), variant: "error" });
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(empresa: { empresaId: string; nombre: string }) {
    const ok = await confirmar({
      title: `¿Quitar la comisión de ${empresa.nombre} en este DO?`,
      description: "Estos contenedores dejan de contar para la comisión por facturar.",
      confirmText: "Quitar",
      variant: "danger",
    });
    if (!ok) return;
    setGuardando(true);
    try {
      setDatos(await guardarComisionTramite(tramiteId, empresa.empresaId, 0));
      toast({ title: "Comisión quitada", variant: "success" });
    } catch (caught) {
      toast({ title: "No se pudo quitar la comisión", description: describirError(caught), variant: "error" });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-slate-500" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">Comisión por contenedor</h3>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoadState("loading");
            setReintento((k) => k + 1);
          }}
          className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          aria-label="Refrescar comisión"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {loadState === "loading" || !datos ? (
        loadState === "error" ? (
          <ModuleState
            type="error"
            title="No fue posible cargar la comisión"
            detail={loadError ?? undefined}
            action={{ label: "Reintentar", onClick: () => setReintento((k) => k + 1) }}
          />
        ) : (
          <TableSkeleton rows={2} cols={3} rowHeight={40} />
        )
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Solo en traslados. Escribe cuántos contenedores de este DO trabajó la empresa que le paga
            comisión a Galcomex (ej.: de 4 contenedores, 2 de LTRANS → 2).
          </p>

          <p className="text-sm text-slate-700">
            {datos.unidadesDisponibles === null ? (
              <span className="text-amber-800">
                Falta el número de contenedores del DO: escríbelo en «Base de cálculo y eventos».
              </span>
            ) : datos.tipoCarga === "SUELTA" && (datos.numContenedores ?? 0) === 0 ? (
              <>Carga suelta: cuenta como 1 contenedor para la comisión.</>
            ) : (
              <>
                Contenedores del DO: <strong>{datos.unidadesDisponibles}</strong>
              </>
            )}
          </p>

          {datos.comisiones.length > 0 ? (
            <ul className="divide-y divide-slate-100 border border-slate-200">
              {datos.comisiones.map((c) => (
                <li key={c.empresaId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 font-medium text-slate-900">{c.nombre}</span>
                  <span className="text-slate-700">
                    {contenedores(c.unidades)} × {formatCOP(c.valorUnitario)} ={" "}
                    <strong>{formatCOP(c.subtotal)}</strong> <span className="text-slate-500">+ IVA</span>
                  </span>
                  {c.facturadaEn ? (
                    <span className="text-xs font-medium text-emerald-800">Facturada en {c.facturadaEn}</span>
                  ) : puedeEditar ? (
                    <button
                      type="button"
                      disabled={guardando}
                      onClick={() => void quitar(c)}
                      className="p-1 text-slate-500 transition hover:text-red-600 disabled:opacity-50"
                      aria-label={`Quitar comisión de ${c.nombre}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Este DO no tiene contenedores con comisión.</p>
          )}

          {puedeEditar && datos.empresas.length > 0 && datos.unidadesDisponibles !== null ? (
            <form onSubmit={guardar} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Empresa que paga la comisión
                </span>
                {datos.empresas.length === 1 ? (
                  <p className="flex h-10 items-center border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800">
                    {datos.empresas[0].nombre}
                  </p>
                ) : (
                  <select
                    value={empresaElegida?.empresaId ?? ""}
                    onChange={(e) => setEmpresaId(e.target.value)}
                    className={INPUT}
                  >
                    <option value="">Seleccionar empresa</option>
                    {datos.empresas.map((e) => (
                      <option key={e.empresaId} value={e.empresaId}>
                        {e.nombre}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Contenedores con comisión
                </span>
                <input
                  aria-label="Contenedores con comisión"
                  inputMode="numeric"
                  value={unidades}
                  placeholder={actual ? String(actual.unidades) : libres !== null ? `Máx. ${libres}` : ""}
                  onChange={(e) => setUnidades(e.target.value.replace(/\D/g, ""))}
                  disabled={guardando || !empresaElegida || Boolean(actual?.facturadaEn)}
                  className={INPUT}
                />
              </label>
              <button
                type="submit"
                disabled={guardando || !empresaElegida || unidades === "" || Boolean(actual?.facturadaEn)}
                className="inline-flex h-10 items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {guardando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {actual ? "Cambiar" : "Guardar comisión"}
              </button>
              {actual?.facturadaEn ? (
                <p className="text-xs text-slate-600 sm:col-span-3">
                  Esta comisión ya se facturó en {actual.facturadaEn}: no se puede cambiar ni quitar.
                </p>
              ) : null}
              {empresaElegida && empresaElegida.valorUnitario === "0" ? (
                <p className="text-xs text-amber-800 sm:col-span-3">
                  {empresaElegida.nombre} no tiene configurado el valor por contenedor (su ficha → Funciones →
                  «Comisión a cobrar por contenedor»). Se guardan los contenedores; el valor se calcula al
                  configurarlo.
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}
