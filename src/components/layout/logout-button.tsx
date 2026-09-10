"use client";

import { Loader2, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth/client";

export function LogoutButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, setIsPending] = useState(false);

  async function handleLogout() {
    setIsPending(true);
    try {
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
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
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
