"use client";

import { Loader2, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth/client";
import { terminarPruebaRol } from "@/lib/auth/rol-simulado-cliente";

export function LogoutButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  async function handleLogout() {
    setIsPending(true);
    try {
      // Si la administradora estaba probando otro rol, se borra esa simulación
      // ANTES de cerrar la sesión (después ya no habría quién la autorice). Si
      // falla o tarda, no impide cerrar: la cookie caduca sola a las 4 h y un
      // no-admin no gana nada con ella.
      await terminarPruebaRol(3000).catch(() => undefined);
      const result = await authClient.signOut();
      if (result.error) {
        throw new Error(result.error.message || "No fue posible cerrar la sesión.");
      }
      router.push("/auth/login");
      router.refresh();
    } catch (caught) {
      // Si falla, el botón vuelve a estar activo para reintentar.
      setIsPending(false);
      toast({
        title: "No se pudo cerrar la sesión",
        description: describirError(caught, "Inténtalo de nuevo."),
        variant: "error",
      });
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isPending}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
      title="Cerrar sesión"
      aria-label="Cerrar sesión"
      aria-busy={isPending || undefined}
    >
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
