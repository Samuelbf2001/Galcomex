"use client";

import { FlaskConical, Loader2 } from "lucide-react";
import { useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";
import { ETIQUETA_ROL_SIMULABLE, type RolSimulable } from "@/lib/auth/rol-simulado";
import { recargarEn, terminarPruebaRol } from "@/lib/auth/rol-simulado-cliente";

/**
 * Franja fija arriba de todo mientras la administradora prueba la plataforma
 * como otro rol. Es intencionalmente grande y ámbar para que nadie olvide en
 * qué modo está. El botón borra la simulación y vuelve al inicio de la
 * administradora (recarga completa: menú, páginas y API vuelven a ADMIN).
 */
export function FranjaRolSimulado({ rolSimulado }: { rolSimulado: RolSimulable }) {
  const { toast } = useToast();
  const [pendiente, setPendiente] = useState(false);

  async function volver() {
    setPendiente(true);
    try {
      await terminarPruebaRol();
      recargarEn("/dashboard");
    } catch (caught) {
      setPendiente(false);
      toast({
        title: "No se pudo volver a administradora",
        description: describirError(caught, "Inténtalo de nuevo."),
        variant: "error",
      });
    }
  }

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b-2 border-amber-600 bg-amber-300 px-4 py-3 text-amber-950 sm:px-6"
    >
      <p className="flex min-w-0 flex-1 items-start gap-3 text-base font-semibold leading-snug">
        <FlaskConical className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>
          Estás probando la plataforma como {ETIQUETA_ROL_SIMULABLE[rolSimulado]}. Ves y puedes hacer
          solo lo que ese rol puede. Lo que hagas queda a tu nombre.{" "}
          <strong className="font-extrabold underline decoration-amber-950/60 underline-offset-2">
            Los cambios que hagas son reales: no es una copia de prueba.
          </strong>
        </span>
      </p>
      <button
        type="button"
        onClick={volver}
        disabled={pendiente}
        aria-busy={pendiente || undefined}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-amber-950 px-4 text-sm font-semibold text-amber-50 transition hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-950 disabled:opacity-60"
      >
        {pendiente ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        Volver a administradora
      </button>
    </div>
  );
}
