import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/layout/change-password-form";
import { MENSAJE_DEBE_CAMBIAR_PASSWORD } from "@/lib/auth/estado-cuenta";
import { debeCambiarPasswordAhora, getCurrentSession } from "@/lib/auth/session";

/**
 * Abierta a cualquier usuario con sesión, también al que tiene clave temporal
 * (NO llama a `exigirAccesoPagina`, que lo mandaría aquí mismo en bucle).
 */
export default async function CambiarPasswordPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/auth/login?next=/cambiar-password");

  const obligatorio = await debeCambiarPasswordAhora(session);

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Cambiar contraseña</h1>
        <p className="mt-1 text-sm text-slate-500">
          Actualiza tu contraseña de acceso. Se cerrarán las demás sesiones
          activas.
        </p>
      </div>
      {obligatorio ? (
        <p
          role="alert"
          className="mb-4 border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900"
        >
          {MENSAJE_DEBE_CAMBIAR_PASSWORD} En «Contraseña actual» escribe la
          temporal que te entregó el administrador.
        </p>
      ) : null}
      <div className="border border-slate-200 bg-white p-6">
        <ChangePasswordForm obligatorio={obligatorio} />
      </div>
    </div>
  );
}
