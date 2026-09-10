"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth/client";

/**
 * Traduce el error de Better Auth a un mensaje útil. Antes todo error
 * (incluida la caída de red) se mostraba como "contraseña actual incorrecta".
 */
function mensajeDeAuth(error: { code?: string; message?: string; status?: number }): string {
  switch (error.code) {
    case "INVALID_PASSWORD":
      return "La contraseña actual es incorrecta.";
    case "PASSWORD_TOO_SHORT":
      return "La nueva contraseña es demasiado corta.";
    case "PASSWORD_TOO_LONG":
      return "La nueva contraseña es demasiado larga.";
    default:
      break;
  }
  if (error.status === 401 || error.status === 403) {
    return "Tu sesión expiró. Vuelve a iniciar sesión e inténtalo de nuevo.";
  }
  if (error.message?.trim()) return error.message;
  return "No fue posible cambiar la contraseña.";
}

export function ChangePasswordForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    // `currentTarget` deja de estar disponible tras el primer `await`.
    const form = event.currentTarget;
    const formData = new FormData(form);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (newPassword.length < 8) {
      setError("La nueva contraseña debe tener al menos 8 caracteres");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("La confirmación no coincide con la nueva contraseña");
      return;
    }

    setIsPending(true);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });

      if (result.error) {
        const mensaje = mensajeDeAuth(result.error);
        setError(mensaje);
        toast({ title: "No se pudo cambiar la contraseña", description: mensaje, variant: "error" });
        return;
      }

      setSuccess(true);
      toast({ title: "Contraseña actualizada", variant: "success" });
      form.reset();
      router.refresh();
    } catch (caught) {
      // Red caída, servidor sin responder, etc.
      const mensaje = describirError(caught, "No fue posible cambiar la contraseña.");
      setError(mensaje);
      toast({ title: "No se pudo cambiar la contraseña", description: mensaje, variant: "error" });
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="currentPassword"
          className="text-sm font-medium text-slate-700"
        >
          Contraseña actual
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          disabled={isPending}
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600 disabled:bg-slate-50"
          required
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="newPassword"
          className="text-sm font-medium text-slate-700"
        >
          Nueva contraseña
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          disabled={isPending}
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600 disabled:bg-slate-50"
          required
        />
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor="confirmPassword"
          className="text-sm font-medium text-slate-700"
        >
          Confirmar nueva contraseña
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          disabled={isPending}
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600 disabled:bg-slate-50"
          required
        />
      </div>
      {error ? (
        <p role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Contraseña actualizada correctamente
        </p>
      ) : null}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex h-10 w-full items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyRound className="h-4 w-4" aria-hidden="true" />
        )}
        {isPending ? "Guardando…" : "Cambiar contraseña"}
      </button>
    </form>
  );
}
