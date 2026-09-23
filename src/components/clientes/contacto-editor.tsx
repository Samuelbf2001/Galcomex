"use client";

import { Loader2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { type ClienteDetalle, updateCliente } from "@/components/clientes/clientes-api";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";

const CAMPOS = [
  { key: "contactoNombre", label: "Nombre del contacto", type: "text" },
  { key: "contactoEmail", label: "Correo electrónico", type: "email" },
  { key: "contactoTel", label: "Teléfono", type: "tel" },
] as const;

type ClaveContacto = (typeof CAMPOS)[number]["key"];
type Draft = Record<ClaveContacto, string>;

const INPUT_CONTACTO =
  "h-11 w-full border px-3 text-sm outline-none transition focus:border-cyan-600 disabled:bg-slate-50 disabled:opacity-60";

function claseInputContacto(invalido: boolean): string {
  return `${INPUT_CONTACTO} ${invalido ? "border-rose-500 bg-rose-50/40" : "border-slate-300"}`;
}

function draftDesdeCliente(cliente: ClienteDetalle): Draft {
  return {
    contactoNombre: cliente.contactoNombre ?? "",
    contactoEmail: cliente.contactoEmail ?? "",
    contactoTel: cliente.contactoTel ?? "",
  };
}

/**
 * Pop-up "Contacto de la empresa" de la ficha del cliente. ADMIN ve un
 * formulario editable (nombre, correo, teléfono); el resto de roles ve la
 * misma información en solo lectura, con "Sin registrar" para lo vacío.
 */
export function ContactoEditor({
  cliente,
  onClose,
  onSaved,
}: {
  cliente: ClienteDetalle;
  onClose: () => void;
  onSaved: (cliente: ClienteDetalle) => void;
}) {
  const esAdmin = useEsAdmin();
  const { toast } = useToast();
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftDesdeCliente(cliente));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cambiar(clave: ClaveContacto, valor: string) {
    setDraft((prev) => ({ ...prev, [clave]: valor }));
  }

  async function guardar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guardando) return;
    setError(null);
    setGuardando(true);
    try {
      const updated = await updateCliente(cliente.id, {
        contactoNombre: draft.contactoNombre.trim() || null,
        contactoEmail: draft.contactoEmail.trim() || null,
        contactoTel: draft.contactoTel.trim() || null,
      });
      toast({ title: "Contacto actualizado", variant: "success" });
      onSaved({ ...cliente, ...updated });
      onClose();
    } catch (caught) {
      // Lo escrito se conserva: el `draft` no se toca en el catch.
      setError(describirError(caught, "No fue posible guardar el contacto. Tus cambios se conservan."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Contacto de la empresa"
      size="md"
      dismissible={!guardando}
      footer={
        esAdmin ? (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={guardando}
              className="min-h-11 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              form={formId}
              disabled={guardando}
              className="inline-flex min-h-11 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {guardando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {guardando ? "Guardando…" : "Guardar contacto"}
            </button>
          </>
        ) : undefined
      }
    >
      {esAdmin ? (
        <form id={formId} onSubmit={guardar} className="space-y-4">
          {CAMPOS.map(({ key, label, type }) => (
            <label key={key} className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">{label}</span>
              <input
                type={type}
                value={draft[key]}
                disabled={guardando}
                onChange={(event) => cambiar(key, event.target.value)}
                placeholder="Sin registrar"
                className={claseInputContacto(false)}
              />
            </label>
          ))}

          {error ? (
            <div role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
        </form>
      ) : (
        <dl className="space-y-3">
          {CAMPOS.map(({ key, label }) => (
            <div key={key}>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{cliente[key] || "Sin registrar"}</dd>
            </div>
          ))}
        </dl>
      )}
    </ModalShell>
  );
}
