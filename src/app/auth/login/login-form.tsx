"use client";

import { Loader2, LogIn } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

import { MENSAJE_USUARIO_DESACTIVADO } from "@/lib/auth/estado-cuenta";
import { destinoInternoSeguro } from "@/lib/auth/rutas-roles";

/**
 * Login. Envía SIEMPRE por /api/login (que aplica el límite de intentos);
 * antes el cliente llamaba directo a Better Auth y el rate-limit solo actuaba
 * sin JavaScript. El destino `?next=` se valida contra redirecciones abiertas
 * y, si no hay destino, el servidor decide la pantalla inicial según el rol.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = destinoInternoSeguro(searchParams.get("next")) ?? "/";
  const errorParam = searchParams.get("error");
  const errorInicial =
    errorParam === "credenciales"
      ? "Correo o contraseña inválidos."
      : errorParam === "desactivado"
        ? MENSAJE_USUARIO_DESACTIVADO
        : null;
  const [error, setError] = useState<string | null>(errorInicial);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    setError(null);
    setIsPending(true);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        body: formData,
        headers: { accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; redirectTo?: string; error?: string }
        | null;

      if (!response.ok) {
        setError(
          payload?.error ??
            (response.status === 401
              ? "Correo o contraseña inválidos."
              : "No se pudo iniciar sesión. Inténtalo de nuevo."),
        );
        return;
      }

      router.push(payload?.redirectTo ?? next);
      router.refresh();
    } catch {
      setError("Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      method="post"
      action="/api/login"
      className="space-y-4"
      noValidate={false}
    >
      <input type="hidden" name="callbackURL" value={next} />
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium text-slate-700">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="nombre@galcomex.com"
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600"
          required
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="password" className="text-sm font-medium text-slate-700">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600"
          required
        />
      </div>
      {error ? (
        <p role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className="inline-flex h-10 w-full items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
        {isPending ? "Ingresando…" : "Ingresar"}
      </button>
    </form>
  );
}
