"use client";

import { Calculator, Loader2, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { fetchCapacidades } from "@/components/clientes/capacidades-api";
import { fetchEventosCatalogo, formatCOP, type EventoCatalogoRow } from "@/components/clientes/tarifas-api";
import { ModuleState } from "@/components/layout/module-state";
import {
  fetchEventosTramite,
  fetchPropuestaTarifa,
  guardarAtributosTramite,
  guardarEventosTramite,
  type AtributosTramite,
  type EventoTramiteRow,
  type PropuestaTarifaRow,
  type TipoCarga,
} from "@/components/tramites/eventos-api";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";

type LoadState = "loading" | "ready" | "error";

const INPUT = "h-9 w-full border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:border-cyan-600 disabled:bg-slate-50";
const LABEL = "text-[11px] font-medium uppercase tracking-wide text-slate-500";

type FormAtributos = {
  valorCif: string;
  tipoCarga: TipoCarga | "";
  numContenedores: string;
  numDeclaraciones: string;
  numDocumentos: string;
  numItems: string;
  ordenCompraNumero: string;
  ordenCompraValor: string;
};

function formDesde(ctx: AtributosTramite): FormAtributos {
  return {
    valorCif: ctx.valorCif ?? "",
    tipoCarga: ctx.tipoCarga ?? "",
    numContenedores: ctx.numContenedores === null ? "" : String(ctx.numContenedores),
    numDeclaraciones: ctx.numDeclaraciones === null ? "" : String(ctx.numDeclaraciones),
    numDocumentos: ctx.numDocumentos === null ? "" : String(ctx.numDocumentos),
    numItems: ctx.numItems === null ? "" : String(ctx.numItems),
    ordenCompraNumero: ctx.ordenCompraNumero ?? "",
    ordenCompraValor: ctx.ordenCompraValor ?? "",
  };
}

function enteroONull(raw: string): number | null {
  return raw.trim() === "" ? null : Number(raw);
}

/**
 * Base de cálculo del tarifario y eventos del trámite (M2 + M3). Va en la
 * pestaña Resumen del DO. Solo aparece cuando la empresa tiene encendida
 * alguna de las funciones que lo usan (tarifario propio, eventos, CIF).
 */
export function SeccionEventosTramite({
  tramiteId,
  clienteId,
  puedeEditar,
  onRefresh,
}: {
  tramiteId: string;
  clienteId: string;
  puedeEditar: boolean;
  onRefresh?: () => void;
}) {
  const { toast } = useToast();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [aplica, setAplica] = useState<{ tarifario: boolean; eventos: boolean; cif: boolean; oc: boolean }>({ tarifario: false, eventos: false, cif: false, oc: false });
  const [catalogo, setCatalogo] = useState<EventoCatalogoRow[]>([]);
  const [marcados, setMarcados] = useState<EventoTramiteRow[]>([]);
  const [propuesta, setPropuesta] = useState<PropuestaTarifaRow | null>(null);
  const [form, setForm] = useState<FormAtributos | null>(null);
  const [guardandoAtributos, setGuardandoAtributos] = useState(false);
  const [guardandoEvento, setGuardandoEvento] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    Promise.all([
      fetchCapacidades(clienteId, controller.signal),
      fetchEventosCatalogo(controller.signal),
      fetchEventosTramite(tramiteId, controller.signal),
      fetchPropuestaTarifa(tramiteId, controller.signal),
    ])
      .then(([caps, cat, ev, prop]) => {
        const tiene = (codigo: string) => caps.some((c) => c.codigo === codigo && c.habilitado);
        setAplica({ tarifario: tiene("tarifario_propio"), eventos: tiene("eventos_facturables"), cif: tiene("base_cif"), oc: tiene("orden_compra_en_revision") });
        setCatalogo(cat);
        setMarcados(ev);
        setPropuesta(prop);
        setForm((prev) => prev ?? formDesde(prop.contexto));
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar la base de cálculo."));
        setLoadState("error");
      });

    return () => controller.abort();
  }, [tramiteId, clienteId, reloadKey]);

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  const refrescarPropuesta = useCallback(async () => {
    try {
      const prop = await fetchPropuestaTarifa(tramiteId);
      setPropuesta(prop);
    } catch {
      /* la propuesta es informativa; el error de guardado ya se mostró */
    }
  }, [tramiteId]);

  if (loadState === "ready" && !aplica.tarifario && !aplica.eventos && !aplica.cif && !aplica.oc) {
    return null;
  }

  async function guardarAtributos() {
    if (!form || guardandoAtributos) return;
    setGuardandoAtributos(true);
    try {
      await guardarAtributosTramite(tramiteId, {
        valorCif: form.valorCif.trim() === "" ? null : form.valorCif.replace(/\D/g, ""),
        tipoCarga: form.tipoCarga === "" ? null : form.tipoCarga,
        numContenedores: enteroONull(form.numContenedores),
        numDeclaraciones: enteroONull(form.numDeclaraciones),
        numDocumentos: enteroONull(form.numDocumentos),
        numItems: enteroONull(form.numItems),
        ...(aplica.oc
          ? {
              ordenCompraNumero: form.ordenCompraNumero.trim() === "" ? null : form.ordenCompraNumero.trim(),
              ordenCompraValor: form.ordenCompraValor.trim() === "" ? null : form.ordenCompraValor.replace(/\D/g, ""),
            }
          : {}),
      });
      toast({ title: "Base de cálculo guardada", variant: "success" });
      await refrescarPropuesta();
      onRefresh?.();
    } catch (caught) {
      toast({ title: "No se pudo guardar", description: describirError(caught), variant: "error" });
    } finally {
      setGuardandoAtributos(false);
    }
  }

  async function aplicarEventos(siguiente: { codigo: string; cantidad: number; observacion?: string | null }[], codigoTocado: string) {
    setGuardandoEvento(codigoTocado);
    try {
      const ev = await guardarEventosTramite(tramiteId, siguiente);
      setMarcados(ev);
      await refrescarPropuesta();
      onRefresh?.();
    } catch (caught) {
      toast({ title: "No se pudo actualizar el evento", description: describirError(caught), variant: "error" });
    } finally {
      setGuardandoEvento(null);
    }
  }

  function toggleEvento(ev: EventoCatalogoRow) {
    const ya = marcados.find((m) => m.codigo === ev.codigo);
    const siguiente = ya
      ? marcados.filter((m) => m.codigo !== ev.codigo).map((m) => ({ codigo: m.codigo, cantidad: m.cantidad, observacion: m.observacion }))
      : [...marcados.map((m) => ({ codigo: m.codigo, cantidad: m.cantidad, observacion: m.observacion })), { codigo: ev.codigo, cantidad: 1 }];
    void aplicarEventos(siguiente, ev.codigo);
  }

  function cambiarCantidad(codigo: string, cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1) return;
    const actual = marcados.find((m) => m.codigo === codigo);
    if (!actual || actual.cantidad === cantidad) return;
    void aplicarEventos(
      marcados.map((m) => ({ codigo: m.codigo, cantidad: m.codigo === codigo ? cantidad : m.cantidad, observacion: m.observacion })),
      codigo,
    );
  }

  const resultado = propuesta?.resultado ?? null;
  const editableEventos = puedeEditar && aplica.eventos;

  return (
    <div className="border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">Base de cálculo y eventos</h3>
        </div>
        <button type="button" onClick={recargar} className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="Refrescar">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {loadState === "loading" || !form ? (
        <TableSkeleton rows={3} cols={3} rowHeight={40} />
      ) : loadState === "error" ? (
        <ModuleState type="error" title="No fue posible cargar la base de cálculo" detail={loadError ?? undefined} action={{ label: "Reintentar", onClick: recargar }} />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Atributos */}
            <div>
              <p className="mb-2 text-xs text-slate-500">Lo que el tarifario necesita para calcular. Vacío = todavía no se sabe.</p>
              <div className="grid grid-cols-2 gap-3">
                {aplica.cif || aplica.tarifario ? (
                  <>
                    <label className="block space-y-1">
                      <span className={LABEL}>Valor CIF (COP)</span>
                      <input value={form.valorCif} onChange={(e) => setForm({ ...form, valorCif: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} placeholder="300000000" />
                    </label>
                    <label className="block space-y-1">
                      <span className={LABEL}>Tipo de carga</span>
                      <select value={form.tipoCarga} onChange={(e) => setForm({ ...form, tipoCarga: e.target.value as TipoCarga | "" })} disabled={!puedeEditar} className={INPUT}>
                        <option value="">—</option>
                        <option value="SUELTA">Carga suelta</option>
                        <option value="CONTENEDOR_20">Contenedor 20′</option>
                        <option value="CONTENEDOR_40">Contenedor 40′ / HQ</option>
                      </select>
                    </label>
                  </>
                ) : null}
                <label className="block space-y-1">
                  <span className={LABEL}>Contenedores</span>
                  <input value={form.numContenedores} onChange={(e) => setForm({ ...form, numContenedores: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Declaraciones</span>
                  <input value={form.numDeclaraciones} onChange={(e) => setForm({ ...form, numDeclaraciones: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Documentos revisados</span>
                  <input value={form.numDocumentos} onChange={(e) => setForm({ ...form, numDocumentos: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} />
                </label>
                <label className="block space-y-1">
                  <span className={LABEL}>Ítems clasificados</span>
                  <input value={form.numItems} onChange={(e) => setForm({ ...form, numItems: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} />
                </label>
                {aplica.oc ? (
                  <>
                    <label className="block space-y-1">
                      <span className={LABEL}>N° orden de compra</span>
                      <input value={form.ordenCompraNumero} onChange={(e) => setForm({ ...form, ordenCompraNumero: e.target.value })} disabled={!puedeEditar} className={INPUT} placeholder="OC-2026-0154" />
                    </label>
                    <label className="block space-y-1">
                      <span className={LABEL}>Valor de la OC (COP, sin IVA)</span>
                      <input value={form.ordenCompraValor} onChange={(e) => setForm({ ...form, ordenCompraValor: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!puedeEditar} className={INPUT} placeholder="4500000" />
                    </label>
                    <p className="col-span-2 text-xs text-slate-500">El cliente devuelve la OC por el valor de la solicitud de fondos. En la revisión de la factura se contrasta y el número va en la descripción.</p>
                  </>
                ) : null}
              </div>
              {puedeEditar ? (
                <button type="button" onClick={() => void guardarAtributos()} disabled={guardandoAtributos} className="mt-3 inline-flex h-9 items-center gap-1.5 border border-slate-950 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                  {guardandoAtributos ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
                  Guardar base de cálculo
                </button>
              ) : null}
            </div>

            {/* Eventos */}
            <div>
              <p className="mb-2 text-xs text-slate-500">
                {aplica.eventos
                  ? "Lo circunstancial: se marca solo si pasó. Al marcarlo entran sus documentos al checklist y su cobro al tarifario."
                  : "Esta empresa no tiene encendidos los eventos facturables (ficha, pestaña Funciones)."}
              </p>
              {aplica.eventos ? (
                <ul className="divide-y divide-slate-100 border border-slate-200">
                  {catalogo.map((ev) => {
                    const marcado = marcados.find((m) => m.codigo === ev.codigo);
                    const ocupado = guardandoEvento === ev.codigo;
                    return (
                      <li key={ev.codigo} className="flex items-start gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          id={`evento-${ev.codigo}`}
                          checked={Boolean(marcado)}
                          disabled={!editableEventos || ocupado}
                          onChange={() => toggleEvento(ev)}
                          className="mt-1 h-4 w-4"
                        />
                        <label htmlFor={`evento-${ev.codigo}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="block text-sm font-medium text-slate-900">{ev.nombre}</span>
                          {ev.descripcion ? <span className="block text-xs text-slate-500">{ev.descripcion}</span> : null}
                          {ev.documentosRequeridos.length > 0 ? (
                            <span className="block text-xs text-amber-700">Exige: {ev.documentosRequeridos.join(", ")}</span>
                          ) : null}
                          {marcado ? (
                            <span className="block text-[11px] text-slate-400">
                              Marcado por {marcado.marcadoPor}
                            </span>
                          ) : null}
                        </label>
                        {marcado && ev.permiteCantidad ? (
                          <input
                            type="number"
                            min={1}
                            max={999}
                            defaultValue={marcado.cantidad}
                            disabled={!editableEventos || ocupado}
                            onBlur={(e) => cambiarCantidad(ev.codigo, Number(e.target.value))}
                            aria-label={`Cantidad de ${ev.nombre}`}
                            className="h-8 w-16 border border-slate-300 px-2 text-sm"
                          />
                        ) : null}
                        {ocupado ? <Loader2 className="mt-1 h-4 w-4 animate-spin text-slate-400" aria-hidden="true" /> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </div>

          {/* Propuesta del tarifario */}
          {aplica.tarifario ? (
            <div className="border-t border-slate-200 pt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Lo que propone el tarifario</p>
                {propuesta?.tarifario ? (
                  <span className="text-xs text-slate-500">
                    {propuesta.tarifario.nombre} v{propuesta.tarifario.version}
                  </span>
                ) : null}
              </div>
              {!propuesta?.tarifario ? (
                <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{propuesta?.motivo ?? "Sin tarifario vigente."}</p>
              ) : resultado ? (
                <div className="space-y-3">
                  {resultado.lineas.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-3 py-2">Concepto</th>
                            <th className="px-3 py-2">Detalle</th>
                            <th className="px-3 py-2 text-right">Valor</th>
                          </tr>
                        </thead>
                        <tbody>
                          {resultado.lineas.map((l) => (
                            <tr key={l.concepto} className="border-t border-slate-100">
                              <td className="px-3 py-2">
                                <span className="font-medium text-slate-900">{l.nombrePublico}</span>
                                {l.origen === "EVENTO" ? <span className="ml-2 border border-cyan-200 bg-cyan-50 px-1.5 text-[10px] font-semibold uppercase text-cyan-700">evento</span> : null}
                                {!l.aplicaIva ? <span className="ml-2 text-[10px] uppercase text-slate-400">sin IVA</span> : null}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-500">{l.detalle}</td>
                              <td className="px-3 py-2 text-right font-mono text-slate-900">{formatCOP(l.valor)}</td>
                            </tr>
                          ))}
                          <tr className="border-t border-slate-200 bg-slate-50">
                            <td className="px-3 py-2 text-sm font-semibold text-slate-900" colSpan={2}>
                              Total conceptos (antes de IVA)
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">{formatCOP(resultado.total)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">Ningún ítem aplica todavía.</p>
                  )}
                  {resultado.pendientes.length > 0 ? (
                    <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <strong>Falta para calcular:</strong>{" "}
                      {resultado.pendientes.map((p) => `${p.nombrePublico} (${p.motivo.toLowerCase()})`).join(" · ")}
                      . El borrador de factura no se genera hasta completarlo.
                    </div>
                  ) : null}
                  {resultado.manuales.length > 0 ? (
                    <p className="text-xs text-slate-500">A mano, si aplica: {resultado.manuales.map((m) => m.nombrePublico).join(", ")}.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
