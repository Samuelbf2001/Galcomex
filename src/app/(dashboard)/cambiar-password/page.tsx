import { ChangePasswordForm } from "@/components/layout/change-password-form";

export default function CambiarPasswordPage() {
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Cambiar contraseña</h1>
        <p className="mt-1 text-sm text-slate-500">
          Actualiza tu contraseña de acceso. Se cerrarán las demás sesiones
          activas.
        </p>
      </div>
      <div className="border border-slate-200 bg-white p-6">
        <ChangePasswordForm />
      </div>
    </div>
  );
}
