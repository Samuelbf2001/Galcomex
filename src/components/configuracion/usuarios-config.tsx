"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { FormEvent, useId, useState } from "react";

import { leerErrorRespuesta } from "@/components/configuracion/respuesta-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { describirError, useToast } from "@/components/ui/toast";

export type UsuarioRow = {
  id: string;
  name: string;
  email: string;
  rol: string;
};

export function UsuariosConfig({ usuarios }: { usuarios: UsuarioRow[] }) {
  const { toast } = useToast();
  const confirmar = useConfirm();
  const errorId = useId();
  const [activo, setActivo] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<string | null>(null);

  function abrir(id: string) {
    setActivo(id);
    setValor("");
    setError(null);
    setExito(null);
  }

  function cerrar() {
    setActivo(null);
    setValor("");
    setError(null);
  }

  async function guardar(event: FormEvent<HTMLFormElement>, usuario: UsuarioRow) {
    event.preventDefault();
    if (guardando) return;
    setError(null);
    setExito(null);

    if (valor.length < 8) {
      setError("Mínimo 8 caracteres");
      return;
    }

    // Irreversible: cierra todas las sesiones del usuario.
    const ok = await confirmar({
      title: `¿Restablecer la contraseña de ${usuario.name}?`,
      description:
        "Se cerrarán todas sus sesiones activas y tendrá que entrar con la nueva contraseña.",
      confirmText: "Sí, restablecer",
      variant: "danger",
    });
    if (!ok) return;

    setGuardando(true);
    try {
      const res = await fetch(`/api/usuarios/${usuario.id}/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ nuevaPassword: valor }),
      });
      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        // Muestra el mensaje real del servidor (Zod o dominio), no uno genérico.
        throw new Error(
          leerErrorRespuesta(payload, "No fue posible restablecer la contraseña"),
        );
      }

      const mensaje = `Contraseña de ${usuario.name} restablecida`;
      setExito(mensaje);
      toast({ title: mensaje, variant: "success" });
      cerrar();
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible restablecer la contraseña");
      setError(mensaje);
      toast({ title: "No se pudo restablecer la contraseña", description: mensaje, variant: "error" });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Usuarios</h2>
        <p className="text-sm text-slate-600">
          Restablece la contraseña de cualquier usuario. Se cerrarán sus sesiones
          activas.
        </p>
      </div>
      {exito ? (
        <p
          role="status"
          className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {exito}
        </p>
      ) : null}
      {usuarios.length === 0 && <ModuleState type="empty" title="No hay usuarios disponibles" detail="Los usuarios registrados aparecerán aquí para administrar su acceso." />}
      <div className="overflow-x-auto border border-slate-200 bg-white">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
              <th className="border-b border-slate-200 px-4 py-3">Correo</th>
              <th className="border-b border-slate-200 px-4 py-3">Rol</th>
              <th className="border-b border-slate-200 px-4 py-3 text-right">
                Acción
              </th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((usuario) => (
              <tr key={usuario.id} className="border-b border-slate-100 align-top">
                <td className="px-4 py-3 font-medium">{usuario.name}</td>
                <td className="px-4 py-3 text-slate-600">{usuario.email}</td>
                <td className="px-4 py-3 font-mono text-xs">{usuario.rol}</td>
                <td className="px-4 py-3 text-right">
                  {activo === usuario.id ? (
                    <form
                      onSubmit={(e) => guardar(e, usuario)}
                      className="flex flex-col items-end gap-2"
                    >
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder="Nueva contraseña"
                        aria-label={`Nueva contraseña para ${usuario.name}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        minLength={8}
                        autoFocus
                        disabled={guardando}
                        className={`h-9 w-48 border px-2 text-sm outline-none focus:border-cyan-600 ${
                          error ? "border-rose-500" : "border-slate-300"
                        }`}
                      />
                      {error ? (
                        <span id={errorId} role="alert" className="text-xs text-red-600">
                          {error}
                        </span>
                      ) : null}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={cerrar}
                          disabled={guardando}
                          className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={guardando}
                          className="inline-flex h-8 items-center gap-1.5 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {guardando ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : null}
                          {guardando ? "Guardando…" : "Guardar"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      type="button"
                      disabled={activo !== null}
                      onClick={() => abrir(usuario.id)}
                      className="inline-flex h-8 items-center gap-1.5 border border-slate-300 px-3 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                      Restablecer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
