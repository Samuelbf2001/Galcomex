"use client";

import { HandCoins, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatCOP } from "@/components/clientes/tarifas-api";
import {
  deshacerLiquidacionComisiones,
  facturarComisiones,
  fetchComisionesEmpresa,
  type ComisionesEmpresaRow,
  type FilaComisionFacturadaRow,
  type LiquidacionComisionesRow,
} from "@/components/comisiones/comisiones-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceTramite } from "@/components/ui/enlace-entidad";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";
import { totalesComision } from "@/lib/comisiones/calculo";

type LoadState = "loading" | "ready" | "error";

/** Mismo mínimo que valida el servidor (`MOTIVO_FORZAR_MIN`). */
const MOTIVO_MIN = 10;

/** Comisiones ya facturadas, agrupadas por el «Otros» donde salieron. */
function agruparPorOtros(facturadas: FilaComisionFacturadaRow[]) {
  const grupos = new Map<string, { otros: FilaComisionFacturadaRow["otros"]; filas: FilaComisionFacturadaRow[] }>();
  for (const fila of facturadas) {
    const grupo = grupos.get(fila.otros.id);
    if (grupo) grupo.filas.push(fila);
    else grupos.set(fila.otros.id, { otros: fila.otros, filas: [fila] });
  }
  return [...grupos.values()];
}

/**
 * Ficha de la empresa que paga comisión por contenedor (LTRANS): qué DOs
 * llevan comisión, cuántos contenedores y cuánto va por facturar (+ IVA).
 * Solo aparece si la empresa tiene «Comisión a cobrar por contenedor».
 *
 * B10 (Diseño B): el ADMIN marca las comisiones por facturar y con "Facturar
 * seleccionadas" crea un «Otros» a nombre de la empresa; las comisiones pasan
 * a "Ya facturadas" con el número de ese «Otros».
 */
export function SeccionComisionesEmpresa({ empresaId }: { empresaId: string }) {
  // GET /api/clientes/[id]/comisiones → ADMIN y REVISOR (los que ven cartera).
  const puedeVer = usePermiso(["ADMIN", "REVISOR"]);
  // POST /api/clientes/[id]/comisiones/liquidar y DELETE .../liquidaciones/[id] → solo ADMIN.
  const puedeFacturar = usePermiso(["ADMIN"]);
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [datos, setDatos] = useState<ComisionesEmpresaRow | null>(null);
  const [reintento, setReintento] = useState(0);
  /** Ids de comisión marcados para facturar. Se marcan todas al cargar. */
  const [marcadas, setMarcadas] = useState<ReadonlySet<string>>(new Set());
  const [facturando, setFacturando] = useState(false);
  const [ultimaFactura, setUltimaFactura] = useState<LiquidacionComisionesRow | null>(null);
  /** M3 — «Otros» cuyo panel "Deshacer" está abierto, su motivo y si la llamada está en curso. */
  const [deshaciendoId, setDeshaciendoId] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [deshaciendo, setDeshaciendo] = useState(false);

  useEffect(() => {
    if (!puedeVer) return;
    const controller = new AbortController();
    fetchComisionesEmpresa(empresaId, controller.signal)
      .then((respuesta) => {
        setDatos(respuesta);
        setMarcadas(new Set(respuesta.filas.map((f) => f.comisionId)));
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "No fue posible cargar las comisiones."));
        setLoadState("error");
      });
    return () => controller.abort();
  }, [empresaId, puedeVer, reintento]);

  // Lo marcado y lo que se facturaría: la misma cuenta que hace el servidor.
  const seleccion = useMemo(() => {
    if (!datos) return null;
    const valorUnitario = BigInt(datos.valorUnitario);
    return totalesComision(
      datos.filas
        .filter((f) => marcadas.has(f.comisionId))
        .map((f) => ({ unidades: f.unidades, valorUnitario })),
      BigInt(datos.tasaIva),
    );
  }, [datos, marcadas]);

  if (!puedeVer) return null;
  if (
    loadState === "ready" &&
    datos &&
    !datos.habilitada &&
    datos.filas.length === 0 &&
    datos.facturadas.length === 0
  ) {
    return null;
  }

  const recargar = () => {
    setLoadState("loading");
    setReintento((k) => k + 1);
  };

  const alternar = (comisionId: string) =>
    setMarcadas((previas) => {
      const siguientes = new Set(previas);
      if (siguientes.has(comisionId)) siguientes.delete(comisionId);
      else siguientes.add(comisionId);
      return siguientes;
    });

  async function facturarSeleccionadas() {
    if (!datos || !seleccion || facturando || marcadas.size === 0) return;
    const ok = await confirmar({
      title: `¿Facturar ${seleccion.unidades} contenedor${seleccion.unidades === 1 ? "" : "es"}?`,
      description: `Se crea un servicio «Otros» a nombre de esta empresa por ${formatCOP(String(seleccion.subtotal))} + IVA (${formatCOP(String(seleccion.total))} con IVA) y estas comisiones dejan de estar por facturar. Después se manda a facturar como cualquier «Otros».`,
      confirmText: "Facturar comisiones",
    });
    if (!ok) return;
    setFacturando(true);
    try {
      const creada = await facturarComisiones(empresaId, [...marcadas]);
      setUltimaFactura(creada);
      toast({
        title: `Comisiones facturadas en ${creada.consecutivo}`,
        description: `${creada.unidades} contenedores · ${formatCOP(creada.total)} + IVA. Mándalo a facturar desde ese servicio.`,
        variant: "success",
      });
    } catch (caught) {
      toast({
        title: "No se pudieron facturar las comisiones",
        description: describirError(caught),
        variant: "error",
      });
    } finally {
      setFacturando(false);
      // Éxito o 409 (otra persona ya facturó): recargar muestra lo que sigue por facturar.
      recargar();
    }
  }

  async function deshacerLiquidacion(otrosId: string, otrosConsecutivo: string) {
    const motivoLimpio = motivo.trim();
    if (deshaciendo || motivoLimpio.length < MOTIVO_MIN) return;
    setDeshaciendo(true);
    try {
      const r = await deshacerLiquidacionComisiones(empresaId, otrosId, motivoLimpio);
      setDeshaciendoId(null);
      setMotivo("");
      setUltimaFactura(null);
      toast({
        title: `Liquidación de ${otrosConsecutivo} deshecha`,
        description: `${r.unidades} contenedor${r.unidades === 1 ? "" : "es"} vuelven a estar por facturar. El servicio ${otrosConsecutivo} quedó anulado.`,
        variant: "success",
      });
    } catch (caught) {
      toast({
        title: "No se pudo deshacer la liquidación",
        description: describirError(caught),
        variant: "error",
      });
    } finally {
      setDeshaciendo(false);
      recargar();
    }
  }

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

          {ultimaFactura ? (
            <p role="status" className="border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              Comisiones facturadas en{" "}
              <strong>
                <EnlaceTramite id={ultimaFactura.tramiteId}>{ultimaFactura.consecutivo}</EnlaceTramite>
              </strong>{" "}
              ({ultimaFactura.unidades} contenedores · {formatCOP(ultimaFactura.total)} + IVA). Abre ese servicio y
              mándalo a facturar.
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
              title={
                datos.facturadas.length > 0 ? "No hay comisiones por facturar" : "Todavía no hay DOs con comisión"
              }
              detail={
                datos.facturadas.length > 0
                  ? "Todo lo registrado ya está facturado (abajo)."
                  : "Se marcan dentro de cada DO de traslado, en «Comisión por contenedor»."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    {puedeFacturar ? (
                      <th className="w-8 px-2 py-2">
                        <span className="sr-only">Facturar</span>
                      </th>
                    ) : null}
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
                    <tr key={f.comisionId || f.tramiteId}>
                      {puedeFacturar ? (
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            checked={marcadas.has(f.comisionId)}
                            disabled={facturando}
                            onChange={() => alternar(f.comisionId)}
                            aria-label={`Facturar la comisión de ${f.consecutivo}`}
                            className="h-4 w-4"
                          />
                        </td>
                      ) : null}
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

          {puedeFacturar && datos.filas.length > 0 && seleccion ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                Se crea un servicio «Otros» a nombre de esta empresa; las comisiones marcadas quedan ligadas a él y
                ya no se pueden cambiar ni cobrar otra vez.
              </p>
              <button
                type="button"
                onClick={() => void facturarSeleccionadas()}
                disabled={facturando || marcadas.size === 0 || datos.valorUnitario === "0"}
                className="inline-flex h-10 items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {facturando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Facturar seleccionadas ({seleccion.unidades} contenedor{seleccion.unidades === 1 ? "" : "es"} ·{" "}
                {formatCOP(String(seleccion.subtotal))} + IVA)
              </button>
            </div>
          ) : null}

          {datos.facturadas.length > 0 ? (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">Ya facturadas</h3>
              {agruparPorOtros(datos.facturadas).map(({ otros, filas }) => {
                const abierto = deshaciendoId === otros.id;
                const contenedores = filas.reduce((suma, f) => suma + f.unidades, 0);
                const motivoLargo = motivo.trim().length;
                return (
                  <div key={otros.id} className="space-y-2 border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-slate-700">
                        <strong>
                          <EnlaceTramite id={otros.id}>{otros.consecutivo}</EnlaceTramite>
                        </strong>
                        <span className="ml-2 text-xs text-slate-500">
                          {contenedores} contenedor{contenedores === 1 ? "" : "es"}
                          {otros.valorServicio ? ` · ${formatCOP(otros.valorServicio)} + IVA (toda la factura)` : ""}
                        </span>
                      </p>
                      {puedeFacturar && otros.deshacible && !abierto ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDeshaciendoId(otros.id);
                            setMotivo("");
                          }}
                          className="inline-flex h-8 items-center border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                        >
                          Deshacer
                        </button>
                      ) : null}
                    </div>

                    {puedeFacturar && !otros.deshacible && otros.motivoNoDeshacible ? (
                      <p className="text-xs text-slate-500">{otros.motivoNoDeshacible}</p>
                    ) : null}

                    {abierto ? (
                      <div
                        role="group"
                        aria-label={`Deshacer la liquidación de ${otros.consecutivo}`}
                        className="space-y-2 border border-amber-300 bg-amber-50 p-3"
                      >
                        <p className="text-sm text-amber-900">
                          Las {contenedores} comisiones de {otros.consecutivo} vuelven a estar por facturar y ese
                          servicio queda anulado (sin valor y cerrado). Si ya lo mandaste a facturar, se elimina su
                          borrador de factura.
                        </p>
                        <label
                          className="block text-sm font-medium text-slate-900"
                          htmlFor={`motivo-deshacer-${otros.id}`}
                        >
                          Motivo (mínimo {MOTIVO_MIN} caracteres)
                        </label>
                        <textarea
                          id={`motivo-deshacer-${otros.id}`}
                          value={motivo}
                          onChange={(evento) => setMotivo(evento.target.value)}
                          rows={2}
                          maxLength={500}
                          disabled={deshaciendo}
                          className="w-full border border-slate-300 bg-white px-2 py-1.5 text-sm"
                          placeholder="Ej.: faltó incluir el DO.BAQ26-0249 en la liquidación"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-slate-600">
                            {motivoLargo} / {MOTIVO_MIN} caracteres como mínimo
                          </span>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setDeshaciendoId(null);
                                setMotivo("");
                              }}
                              disabled={deshaciendo}
                              className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              onClick={() => void deshacerLiquidacion(otros.id, otros.consecutivo)}
                              disabled={deshaciendo || motivoLargo < MOTIVO_MIN}
                              className="inline-flex h-9 items-center justify-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                            >
                              {deshaciendo ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                              Deshacer liquidación
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[520px] text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                            <th className="px-2 py-2">DO</th>
                            <th className="px-2 py-2">Empresa del DO</th>
                            <th className="px-2 py-2 text-right">Contenedores</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filas.map((f) => (
                            <tr key={f.comisionId}>
                              <td className="px-2 py-2 font-medium">
                                <EnlaceTramite id={f.tramiteId}>{f.consecutivo}</EnlaceTramite>
                              </td>
                              <td className="px-2 py-2 text-slate-700">{f.empresaDo}</td>
                              <td className="px-2 py-2 text-right font-semibold text-slate-900">{f.unidades}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
