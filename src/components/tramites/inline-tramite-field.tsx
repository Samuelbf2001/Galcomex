"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { describirError, useToast } from "@/components/ui/toast";

/** Direct editing with an explicit save, preserving drafts when a request fails. */
export function InlineTramiteField({ label, type, value, onSave }: {
  label: string;
  type: "date" | "text" | "textarea";
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const changed = draft !== null && draft !== value;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft!);
      setDraft(null);
      toast({ title: `${label}: cambios guardados`, variant: "success" });
    } catch (caught) {
      setError(describirError(caught, "No se pudo guardar. Tu cambio sigue aquí para reintentar."));
    } finally { setSaving(false); }
  }

  const inputProps = {
    id,
    value: draft ?? value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(event.target.value); setError(null); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Escape" && !saving) { setDraft(null); setError(null); }
    },
    disabled: saving,
    "aria-invalid": Boolean(error),
    "aria-describedby": error ? `${id}-error` : undefined,
    className: "min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100 disabled:opacity-60",
  };
  return (
    <form onSubmit={save} className="min-w-0 space-y-2" aria-busy={saving}>
      <label htmlFor={id} className="block text-xs font-medium text-slate-500">{label}</label>
      {type === "textarea" ? <textarea {...inputProps} rows={3} placeholder="Añade una nota para el equipo" /> : <input {...inputProps} type={type} placeholder="Sin registrar" />}
      {changed || saving ? <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-cyan-700 px-3 text-sm font-semibold text-white disabled:opacity-60">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{saving ? "Guardando…" : error ? "Reintentar guardado" : "Guardar"}
        </button>
        <button type="button" disabled={saving} onClick={() => { setDraft(null); setError(null); }} className="min-h-11 px-3 text-sm text-slate-600">Deshacer</button>
        <span className="text-xs text-slate-500" role="status">{saving ? "" : "Cambio sin guardar"}</span>
      </div> : null}
      {error ? <p id={`${id}-error`} role="alert" className="text-sm text-rose-700">{error}</p> : null}
    </form>
  );
}
