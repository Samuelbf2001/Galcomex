"use client";

import { KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";

export type UsuarioRow = {
  id: string;
  name: string;
  email: string;
  rol: string;
};

export function UsuariosConfig({ usuarios }: { usuarios: UsuarioRow[] }) {
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
    setError(null);
    setExito(null);

    if (valor.length < 8) {
      setError("Minimo 8 caracteres");
      return;
    }

    setGuardando(true);
    const res = await fetch(`/api/usuarios/${usuario.id}/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nuevaPassword: valor }),
    });
    setGuardando(false);

    if (!res.ok) {
      setError("No fue posible restablecer la contraseña");
      return;
    }

    setExito(`Contrasena de ${usuario.name} restablecida`);
    cerrar();
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
        <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {exito}
        </p>
      ) : null}
      <div className="overflow-hidden border border-slate-200 bg-white">
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
                        value={valor}
                        onChange={(e) => setValor(e.target.value)}
                        minLength={8}
                        autoFocus
                        className="h-9 w-48 border border-slate-300 px-2 text-sm outline-none focus:border-cyan-600"
                      />
                      {error ? (
                        <span className="text-xs text-red-600">{error}</span>
                      ) : null}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={cerrar}
                          className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100"
                        >
                          Cancelar
                        </button>
                        <button
                          type="submit"
                          disabled={guardando}
                          className="h-8 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {guardando ? "Guardando" : "Guardar"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      type="button"
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
