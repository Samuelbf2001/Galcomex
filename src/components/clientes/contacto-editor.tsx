"use client";

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { type ClienteDetalle, updateCliente } from "./clientes-api";
import { describirError, useToast } from "@/components/ui/toast";

const fields = [
  { key: "contactoNombre", label: "Nombre del contacto", type: "text" },
  { key: "contactoEmail", label: "Correo electrónico", type: "email" },
  { key: "contactoTel", label: "Teléfono", type: "tel" },
] as const;
type Contacto = Record<(typeof fields)[number]["key"], string>;

export function ContactoEditor({ cliente, onSaved }: { cliente: ClienteDetalle; onSaved: (cliente: ClienteDetalle) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Partial<Contacto>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const changed = fields.some(({ key }) => draft[key] !== undefined && draft[key] !== (cliente[key] ?? ""));

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const patch = Object.fromEntries(fields.filter(({ key }) => draft[key] !== undefined).map(({ key }) => [key, draft[key]?.trim() || null]));
      const updated = await updateCliente(cliente.id, patch);
      onSaved({ ...cliente, ...updated });
      setDraft({});
      toast({ title: "Contacto actualizado", variant: "success" });
    } catch (caught) { setError(describirError(caught, "No se pudo guardar el contacto. Tus cambios se conservan.")); }
    finally { setSaving(false); }
  }

  return <form onSubmit={save} aria-busy={saving} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
    <div><h2 className="text-sm font-semibold text-slate-900">Contacto de la empresa</h2><p className="mt-1 text-xs text-slate-500">Edita directamente los datos. Guarda los cambios al terminar.</p></div>
    <div className="grid gap-3 md:grid-cols-3">{fields.map(({ key, label, type }) => <label key={key} className="min-w-0 space-y-1.5">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input type={type} value={draft[key] ?? cliente[key] ?? ""} disabled={saving} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { setDraft((prev) => ({ ...prev, [key]: event.target.value })); setError(null); }} className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-100 disabled:opacity-60" placeholder="Sin registrar" />
    </label>)}</div>
    {changed ? <div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={saving} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-60">{saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{saving ? "Guardando…" : error ? "Reintentar guardado" : "Guardar contacto"}</button><button type="button" disabled={saving} onClick={() => { setDraft({}); setError(null); }} className="min-h-11 px-3 text-sm text-slate-600">Deshacer</button><span className="text-xs text-slate-500" role="status">Cambios sin guardar</span></div> : null}
    {error ? <p id={`${id}-error`} role="alert" className="text-sm text-rose-700">{error}</p> : null}
  </form>;
}
