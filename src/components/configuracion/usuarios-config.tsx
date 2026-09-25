"use client";

import { Check, Copy, KeyRound, Loader2, Power, UserPlus } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

import {
  BTN_PRIMARIO,
  BTN_SECUNDARIO,
  INPUT,
  LABEL,
} from "@/components/configuracion/catalogos/catalogos-ui";
import { leerErrorRespuesta, patchJson, postJson } from "@/components/configuracion/respuesta-api";
import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import type { Rol } from "@/lib/auth/auth";
import type { UsuarioDto } from "@/lib/usuarios/service";

/**
 * Configuración → Usuarios (solo ADMIN). Crear usuarios, cambiar rol,
 * desactivar/reactivar y restablecer la clave. Las reglas las impone el
 * servidor (`src/lib/usuarios/reglas.ts`); aquí solo se ocultan o deshabilitan
 * los botones que el servidor rechazaría, con la razón a la vista.
 */

export type UsuarioRow = UsuarioDto;

const ROLES: readonly Rol[] = ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"];

const ETIQUETA_ROL: Record<Rol, string> = {
  ADMIN: "Administrador",
  REVISOR: "Revisor",
  OPERATIVO: "Operativo",
  SOCIO: "Socio",
};

const FECHA = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

type ClaveMostrada = { nombre: string; email: string; clave: string; motivo: "nuevo" | "reset" };

function esRol(valor: string): valor is Rol {
  return (ROLES as readonly string[]).includes(valor);
}

function BadgeEstado({ usuario }: { usuario: UsuarioRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {usuario.activo ? (
        <span className="inline-flex items-center rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          Activo
        </span>
      ) : (
        <span className="inline-flex items-center rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700">
          Desactivado
        </span>
      )}
      {usuario.debeCambiarPassword ? (
        <span className="inline-flex items-center rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
          Clave temporal
        </span>
      ) : null}
    </div>
  );
}

// ─── Modal: clave temporal (se muestra UNA vez) ───────────────────────────────

function ClaveTemporalModal({ datos, onClose }: { datos: ClaveMostrada; onClose: () => void }) {
  const { toast } = useToast();
  const [copiada, setCopiada] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(datos.clave);
      setCopiada(true);
      toast({ title: "Contraseña copiada", variant: "success" });
    } catch (caught) {
      toast({
        title: "No se pudo copiar",
        description: describirError(caught, "Selecciónala y cópiala a mano."),
        variant: "error",
      });
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title={`Contraseña temporal de ${datos.nombre}`}
      description={
        datos.motivo === "nuevo"
          ? "Usuario creado. Entrégale estos datos para su primer ingreso."
          : "Contraseña restablecida. Se cerraron sus sesiones abiertas."
      }
      size="sm"
      footer={
        <button type="button" onClick={onClose} className={BTN_PRIMARIO}>
          Listo, ya la entregué
        </button>
      }
    >
      <div className="space-y-4">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className={LABEL}>Correo</dt>
            <dd className="mt-0.5 break-all font-medium text-slate-900">{datos.email}</dd>
          </div>
          <div>
            <dt className={LABEL}>Contraseña temporal</dt>
            <dd className="mt-1 flex items-center gap-2">
              <code className="flex-1 select-all break-all border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-lg tracking-wider text-slate-950">
                {datos.clave}
              </code>
              <button
                type="button"
                onClick={() => void copiar()}
                className={BTN_SECUNDARIO}
                aria-label="Copiar contraseña temporal"
              >
                {copiada ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copiada ? "Copiada" : "Copiar"}
              </button>
            </dd>
          </div>
        </dl>
        <p
          role="alert"
          className="border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Esta contraseña no se volverá a mostrar; entrégasela por un canal
          privado. Al entrar, el sistema le pedirá cambiarla.
        </p>
      </div>
    </ModalShell>
  );
}

// ─── Modal: nuevo usuario ─────────────────────────────────────────────────────

function NuevoUsuarioModal({
  onClose,
  onCreado,
}: {
  onClose: () => void;
  onCreado: (usuario: UsuarioRow, clave: string) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<Rol>("OPERATIVO");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enviando) return;
    setError(null);
    setEnviando(true);
    try {
      const payload = await postJson(
        "/api/usuarios",
        { name, email, rol },
        "No fue posible crear el usuario",
      );
      const { usuario, passwordTemporal } = payload as {
        usuario: UsuarioRow;
        passwordTemporal: string;
      };
      toast({ title: `Usuario ${usuario.name} creado`, variant: "success" });
      onCreado(usuario, passwordTemporal);
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible crear el usuario");
      setError(mensaje);
      toast({ title: "No se pudo crear el usuario", description: mensaje, variant: "error" });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Nuevo usuario"
      description="El sistema genera una contraseña temporal que se muestra una sola vez."
      size="sm"
      dismissible={!enviando}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <label className="block space-y-1">
          <span className={LABEL}>Nombre *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={120}
            autoComplete="off"
            disabled={enviando}
            className={INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>Correo (usuario de acceso) *</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            autoComplete="off"
            placeholder="nombre@galcomex.com"
            disabled={enviando}
            className={INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>Rol *</span>
          <select
            value={rol}
            onChange={(e) => {
              if (esRol(e.target.value)) setRol(e.target.value);
            }}
            disabled={enviando}
            className={INPUT}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ETIQUETA_ROL[r]}
              </option>
            ))}
          </select>
        </label>

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
            {enviando ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {enviando ? "Creando…" : "Crear usuario"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Sección ──────────────────────────────────────────────────────────────────

export function UsuariosConfig({
  usuarios: iniciales,
  usuarioActualId,
}: {
  usuarios: UsuarioRow[];
  usuarioActualId: string;
}) {
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [usuarios, setUsuarios] = useState<UsuarioRow[]>(iniciales);
  const [pendienteId, setPendienteId] = useState<string | null>(null);
  const [nuevoAbierto, setNuevoAbierto] = useState(false);
  const [claveMostrada, setClaveMostrada] = useState<ClaveMostrada | null>(null);

  const adminsActivos = usuarios.filter((u) => u.rol === "ADMIN" && u.activo).length;

  /** Razón por la que el servidor rechazaría quitarle el ADMIN o desactivarlo (null = se puede). */
  function bloqueoAdmin(usuario: UsuarioRow, accion: "rol" | "desactivar"): string | null {
    const esYo = usuario.id === usuarioActualId;
    if (esYo && accion === "desactivar") return "No puedes desactivar tu propio usuario.";
    if (usuario.rol !== "ADMIN") return null;
    if (esYo) return "No puedes quitarte tu propio rol de administrador.";
    if (usuario.activo && adminsActivos <= 1) return "Es el único administrador activo.";
    return null;
  }

  async function recargar() {
    try {
      const res = await fetch("/api/usuarios", { headers: { accept: "application/json" } });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(leerErrorRespuesta(payload, "No fue posible recargar la lista"));
      setUsuarios((payload as { usuarios: UsuarioRow[] }).usuarios);
    } catch (caught) {
      toast({
        title: "No se pudo recargar la lista de usuarios",
        description: describirError(caught, "Recarga la página."),
        variant: "error",
      });
    }
  }

  async function cambiarRol(usuario: UsuarioRow, nuevoRol: Rol) {
    if (nuevoRol === usuario.rol || pendienteId) return;
    const ok = await confirmar({
      title: `¿Cambiar el rol de ${usuario.name}?`,
      description: `Pasará de ${ETIQUETA_ROL[usuario.rol]} a ${ETIQUETA_ROL[nuevoRol]}. El cambio se aplica en su próxima navegación (puede tardar hasta 5 minutos) y no cierra su sesión.`,
      confirmText: "Sí, cambiar rol",
      variant: nuevoRol === "ADMIN" || usuario.rol === "ADMIN" ? "danger" : "default",
    });
    if (!ok) return;

    setPendienteId(usuario.id);
    try {
      await patchJson(`/api/usuarios/${usuario.id}`, { rol: nuevoRol }, "No fue posible cambiar el rol");
      toast({ title: `${usuario.name} ahora es ${ETIQUETA_ROL[nuevoRol]}`, variant: "success" });
      await recargar();
    } catch (caught) {
      toast({
        title: "No se pudo cambiar el rol",
        description: describirError(caught, "No fue posible cambiar el rol"),
        variant: "error",
      });
    } finally {
      setPendienteId(null);
    }
  }

  async function cambiarEstado(usuario: UsuarioRow) {
    if (pendienteId) return;
    const desactivar = usuario.activo;
    const ok = await confirmar(
      desactivar
        ? {
            title: `¿Desactivar a ${usuario.name}?`,
            description:
              "No podrá volver a iniciar sesión y se le cierran las sesiones abiertas (puede tardar hasta 5 minutos en quedar fuera). Su historial se conserva y puedes reactivarlo cuando quieras.",
            confirmText: "Sí, desactivar",
            variant: "danger",
          }
        : {
            title: `¿Reactivar a ${usuario.name}?`,
            description: "Podrá volver a iniciar sesión con su contraseña actual.",
            confirmText: "Sí, reactivar",
          },
    );
    if (!ok) return;

    setPendienteId(usuario.id);
    try {
      await patchJson(
        `/api/usuarios/${usuario.id}`,
        { activo: !desactivar },
        desactivar ? "No fue posible desactivar el usuario" : "No fue posible reactivar el usuario",
      );
      toast({
        title: desactivar ? `${usuario.name} quedó desactivado` : `${usuario.name} quedó activo`,
        variant: "success",
      });
      await recargar();
    } catch (caught) {
      toast({
        title: desactivar ? "No se pudo desactivar" : "No se pudo reactivar",
        description: describirError(caught, "Inténtalo de nuevo."),
        variant: "error",
      });
    } finally {
      setPendienteId(null);
    }
  }

  async function restablecer(usuario: UsuarioRow) {
    if (pendienteId) return;
    const ok = await confirmar({
      title: `¿Restablecer la contraseña de ${usuario.name}?`,
      description:
        "Se genera una contraseña temporal, se cierran todas sus sesiones y tendrá que cambiarla al entrar.",
      confirmText: "Sí, restablecer",
      variant: "danger",
    });
    if (!ok) return;

    setPendienteId(usuario.id);
    try {
      const payload = await postJson(
        `/api/usuarios/${usuario.id}/reset-password`,
        {},
        "No fue posible restablecer la contraseña",
      );
      const clave = (payload as { passwordTemporal?: string }).passwordTemporal;
      if (!clave) throw new Error("El servidor no devolvió la contraseña temporal");
      setClaveMostrada({ nombre: usuario.name, email: usuario.email, clave, motivo: "reset" });
      await recargar();
    } catch (caught) {
      toast({
        title: "No se pudo restablecer la contraseña",
        description: describirError(caught, "No fue posible restablecer la contraseña"),
        variant: "error",
      });
    } finally {
      setPendienteId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Usuarios</h2>
          <p className="text-sm text-slate-600">
            Crea usuarios, cambia su rol, desactívalos o restablece su contraseña.
            Nadie puede registrarse por su cuenta.
          </p>
        </div>
        <button type="button" onClick={() => setNuevoAbierto(true)} className={BTN_PRIMARIO}>
          <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Nuevo usuario
        </button>
      </div>

      {usuarios.length === 0 ? (
        <ModuleState
          type="empty"
          title="No hay usuarios"
          detail="Crea el primero con «Nuevo usuario»."
        />
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-3">Correo</th>
                <th className="border-b border-slate-200 px-4 py-3">Rol</th>
                <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                <th className="border-b border-slate-200 px-4 py-3">Último ingreso</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((usuario) => {
                const esYo = usuario.id === usuarioActualId;
                const ocupado = pendienteId === usuario.id;
                const bloqueoRol = bloqueoAdmin(usuario, "rol");
                const bloqueoDesactivar = usuario.activo ? bloqueoAdmin(usuario, "desactivar") : null;
                return (
                  <tr
                    key={usuario.id}
                    className={`border-b border-slate-100 align-top ${usuario.activo ? "" : "bg-slate-50 text-slate-500"}`}
                  >
                    <td className="px-4 py-3 font-medium">
                      {usuario.name}
                      {esYo ? <span className="ml-1 text-xs font-normal text-slate-500">(tú)</span> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{usuario.email}</td>
                    <td className="px-4 py-3">
                      <select
                        value={usuario.rol}
                        onChange={(e) => {
                          if (esRol(e.target.value)) void cambiarRol(usuario, e.target.value);
                        }}
                        disabled={pendienteId !== null}
                        aria-label={`Rol de ${usuario.name}`}
                        title={bloqueoRol ?? undefined}
                        className="h-9 border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:border-cyan-600 disabled:bg-slate-50"
                      >
                        {ROLES.map((r) => (
                          <option
                            key={r}
                            value={r}
                            // Con bloqueo solo queda elegible su rol actual (ADMIN).
                            disabled={bloqueoRol !== null && r !== usuario.rol}
                          >
                            {ETIQUETA_ROL[r]}
                          </option>
                        ))}
                      </select>
                      {bloqueoRol ? (
                        <p className="mt-1 max-w-48 text-xs text-slate-500">{bloqueoRol}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <BadgeEstado usuario={usuario} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {usuario.ultimoIngreso ? FECHA.format(new Date(usuario.ultimoIngreso)) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        {esYo ? (
                          <Link href="/cambiar-password" className={BTN_SECUNDARIO}>
                            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                            Cambiar mi contraseña
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void restablecer(usuario)}
                            disabled={pendienteId !== null}
                            className={BTN_SECUNDARIO}
                          >
                            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                            Restablecer clave
                          </button>
                        )}
                        {bloqueoDesactivar === null && !esYo ? (
                          <button
                            type="button"
                            onClick={() => void cambiarEstado(usuario)}
                            disabled={pendienteId !== null}
                            className={
                              usuario.activo
                                ? `${BTN_SECUNDARIO} text-red-700 hover:bg-red-50`
                                : BTN_SECUNDARIO
                            }
                          >
                            {ocupado ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Power className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            {usuario.activo ? "Desactivar" : "Reactivar"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nuevoAbierto ? (
        <NuevoUsuarioModal
          onClose={() => setNuevoAbierto(false)}
          onCreado={(usuario, clave) => {
            setNuevoAbierto(false);
            setClaveMostrada({ nombre: usuario.name, email: usuario.email, clave, motivo: "nuevo" });
            void recargar();
          }}
        />
      ) : null}

      {claveMostrada ? (
        <ClaveTemporalModal datos={claveMostrada} onClose={() => setClaveMostrada(null)} />
      ) : null}
    </div>
  );
}
