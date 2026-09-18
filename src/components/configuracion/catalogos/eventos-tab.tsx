"use client";

import { ChevronDown, ChevronUp, Pencil, Plus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import {
  actualizarEventoCatalogo,
  fetchEventosCatalogoAdmin,
  type EventoCatalogoFormValues,
  type EventoCatalogoRow,
} from "@/components/configuracion/catalogos/catalogos-api";
import {
  BadgeActivo,
  BadgeCodigo,
  BTN_PRIMARIO,
  BTN_SECUNDARIO,
  INPUT,
  Interruptor,
  LABEL,
  TEXTAREA,
} from "@/components/configuracion/catalogos/catalogos-ui";
import { ModuleState } from "@/components/layout/module-state";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

// ─── Editor de lista para documentosRequeridos ────────────────────────────────

function DocumentosRequeridosEditor({
  documentos,
  onChange,
  disabled,
}: {
  documentos: string[];
  onChange: (documentos: string[]) => void;
  disabled?: boolean;
}) {
  const [nuevo, setNuevo] = useState("");

  function agregar() {
    const valor = nuevo.trim();
    if (!valor || documentos.includes(valor)) return;
    onChange([...documentos, valor]);
    setNuevo("");
  }

  function quitar(index: number) {
    onChange(documentos.filter((_, i) => i !== index));
  }

  function mover(index: number, direccion: -1 | 1) {
    const destino = index + direccion;
    if (destino < 0 || destino >= documentos.length) return;
    const copia = [...documentos];
    [copia[index], copia[destino]] = [copia[destino], copia[index]];
    onChange(copia);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              agregar();
            }
          }}
          disabled={disabled}
          placeholder="Ej. Foto del sello de revisión"
          maxLength={160}
          className={INPUT}
        />
        <button
          type="button"
          onClick={agregar}
          disabled={disabled || !nuevo.trim()}
          className={BTN_SECUNDARIO}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Agregar
        </button>
      </div>

      {documentos.length === 0 ? (
        <p className="text-xs text-slate-400">Este evento no exige documentos en el checklist.</p>
      ) : (
        <ul className="divide-y divide-slate-100 border border-slate-200">
          {documentos.map((doc, index) => (
            <li key={`${doc}-${index}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="flex-1 truncate text-slate-700">{doc}</span>
              <button
                type="button"
                onClick={() => mover(index, -1)}
                disabled={disabled || index === 0}
                aria-label={`Subir "${doc}"`}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => mover(index, 1)}
                disabled={disabled || index === documentos.length - 1}
                aria-label={`Bajar "${doc}"`}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-30"
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => quitar(index)}
                disabled={disabled}
                aria-label={`Quitar "${doc}"`}
                className="text-rose-500 hover:text-rose-700 disabled:opacity-30"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Modal de edición ──────────────────────────────────────────────────────────

type EventoFormState = EventoCatalogoFormValues;

function estadoInicial(evento: EventoCatalogoRow): EventoFormState {
  return {
    nombre: evento.nombre,
    descripcion: evento.descripcion,
    documentosRequeridos: evento.documentosRequeridos,
    permiteCantidad: evento.permiteCantidad,
    orden: evento.orden,
    activo: evento.activo,
  };
}

function EventoModal({
  evento,
  onClose,
  onSaved,
}: {
  evento: EventoCatalogoRow;
  onClose: () => void;
  onSaved: (evento: EventoCatalogoRow) => void;
}) {
  const { toast } = useToast();
  const [s, setS] = useState<EventoFormState>(() => estadoInicial(evento));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof EventoFormState>(campo: K, valor: EventoFormState[K]) {
    setS((prev) => ({ ...prev, [campo]: valor }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enviando) return;
    setError(null);
    setEnviando(true);
    try {
      const guardado = await actualizarEventoCatalogo(evento.codigo, {
        nombre: s.nombre.trim(),
        descripcion: s.descripcion?.trim() || null,
        documentosRequeridos: s.documentosRequeridos,
        permiteCantidad: s.permiteCantidad,
        orden: s.orden,
        activo: s.activo,
      });
      toast({ title: "Evento actualizado", description: guardado.nombre, variant: "success" });
      onSaved(guardado);
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible guardar el evento.");
      setError(mensaje);
      toast({ title: "No se pudo guardar el evento", description: mensaje, variant: "error" });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ModalShell open onClose={onClose} title={`Editar ${evento.nombre}`} size="lg" dismissible={!enviando}>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={LABEL}>Código</span>
            <div className="pt-1.5">
              <BadgeCodigo codigo={evento.codigo} />
            </div>
          </label>
          <label className="block space-y-1">
            <span className={LABEL}>Nombre *</span>
            <input
              value={s.nombre}
              onChange={(e) => set("nombre", e.target.value)}
              required
              maxLength={160}
              className={INPUT}
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className={LABEL}>Descripción</span>
          <textarea
            value={s.descripcion ?? ""}
            onChange={(e) => set("descripcion", e.target.value)}
            rows={2}
            maxLength={600}
            className={TEXTAREA}
          />
        </label>

        <label className="block space-y-1">
          <span className={LABEL}>Documentos que exige en el checklist</span>
          <DocumentosRequeridosEditor
            documentos={s.documentosRequeridos}
            onChange={(documentos) => set("documentosRequeridos", documentos)}
            disabled={enviando}
          />
          <p className="text-xs text-slate-500">
            Cambiar esta lista solo afecta a los trámites que marquen el evento después: los
            checklist ya creados no se tocan.
          </p>
        </label>

        <label className="block max-w-[10rem] space-y-1">
          <span className={LABEL}>Orden</span>
          <input
            type="number"
            min={0}
            max={9999}
            value={s.orden}
            onChange={(e) => set("orden", Number(e.target.value) || 0)}
            className={INPUT}
          />
        </label>

        <div className="flex flex-wrap gap-6">
          <div className="flex items-center gap-3">
            <Interruptor
              activo={s.permiteCantidad}
              onToggle={() => set("permiteCantidad", !s.permiteCantidad)}
              etiqueta="Permite cantidad"
            />
            <span className="text-sm text-slate-700">Se puede marcar más de una vez</span>
          </div>
          <div className="flex items-center gap-3">
            <Interruptor activo={s.activo} onToggle={() => set("activo", !s.activo)} etiqueta="Evento activo" />
            <span className="text-sm text-slate-700">Activo</span>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button type="button" onClick={onClose} disabled={enviando} className={BTN_SECUNDARIO}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando} className={BTN_PRIMARIO}>
            {enviando ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Pestaña ───────────────────────────────────────────────────────────────────

export function EventosTab() {
  const puedeEditar = usePermiso(["ADMIN"]);

  const [eventos, setEventos] = useState<EventoCatalogoRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editando, setEditando] = useState<EventoCatalogoRow | null>(null);

  useEffect(() => {
    let cancelado = false;
    const controller = new AbortController();
    fetchEventosCatalogoAdmin(controller.signal)
      .then((rows) => {
        if (cancelado) return;
        setEventos(rows);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelado) return;
        setLoadError(describirError(caught, "No fue posible cargar el catálogo de eventos."));
        setLoadState("error");
      });
    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [reloadKey]);

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  function handleSaved(evento: EventoCatalogoRow) {
    setEventos((prev) => prev.map((e) => (e.codigo === evento.codigo ? evento : e)));
    setEditando(null);
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Eventos</h2>
        <p className="text-xs text-slate-500">
          Revisión, entrega directa, modificación de registro… Marcar un evento en un trámite
          crea estos documentos en su checklist y habilita el ítem del tarifario que lo cobra.
        </p>
      </div>

      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={7} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No se pudieron cargar los eventos"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : eventos.length === 0 ? (
        <ModuleState
          type="empty"
          title="No hay eventos en el catálogo"
          detail="Los eventos facturables aparecerán aquí cuando existan en la base de datos."
        />
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Código</th>
                <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-3">Documentos</th>
                <th className="border-b border-slate-200 px-4 py-3">Cantidad</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">Trámites</th>
                <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                {puedeEditar ? <th className="border-b border-slate-200 px-4 py-3 text-right">Acción</th> : null}
              </tr>
            </thead>
            <tbody>
              {eventos.map((e) => (
                <tr key={e.codigo} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-3">
                    <BadgeCodigo codigo={e.codigo} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{e.nombre}</p>
                    {e.descripcion ? (
                      <p className="mt-0.5 max-w-xs truncate text-xs text-slate-500" title={e.descripcion}>
                        {e.descripcion}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {e.documentosRequeridos.length === 0
                      ? "Sin documentos"
                      : `${e.documentosRequeridos.length} documento${e.documentosRequeridos.length === 1 ? "" : "s"}`}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{e.permiteCantidad ? "Sí" : "No"}</td>
                  <td className="px-4 py-3 text-right text-xs text-slate-600">{e.tramitesMarcados}</td>
                  <td className="px-4 py-3">
                    <BadgeActivo activo={e.activo} />
                  </td>
                  {puedeEditar ? (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditando(e)}
                        aria-label={`Editar ${e.nombre}`}
                        className="inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        Editar
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editando ? (
        <EventoModal evento={editando} onClose={() => setEditando(null)} onSaved={handleSaved} />
      ) : null}
    </div>
  );
}
