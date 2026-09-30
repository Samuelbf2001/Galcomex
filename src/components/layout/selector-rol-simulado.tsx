"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Loader2, UserCog } from "lucide-react";
import { useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";
import {
  ETIQUETA_ROL_SIMULABLE,
  ROLES_SIMULABLES,
  esRolSimulable,
  type RolSimulable,
} from "@/lib/auth/rol-simulado";
import { iniciarPruebaRol, recargarEn, terminarPruebaRol } from "@/lib/auth/rol-simulado-cliente";

const ITEM =
  "flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-md px-3 text-sm text-slate-800 outline-none data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-950";

/**
 * «Probar como…» en la cabecera. Solo se pinta para la administradora (el
 * padre decide con el rol REAL: `useRol()` devolvería el rol probado). Radix
 * aporta el manejo de teclado (flechas, Enter, Escape, foco de vuelta).
 *
 * Al elegir un rol se activa la simulación y se recarga por la raíz: `/`
 * redirige a la primera pantalla útil del rol probado.
 */
export function SelectorRolSimulado({ rolSimulado }: { rolSimulado: RolSimulable | null }) {
  const { toast } = useToast();
  const [pendiente, setPendiente] = useState(false);

  async function probarComo(rol: RolSimulable) {
    if (rol === rolSimulado) return;
    setPendiente(true);
    try {
      await iniciarPruebaRol(rol);
      recargarEn("/");
    } catch (caught) {
      setPendiente(false);
      toast({
        title: "No se pudo cambiar de rol",
        description: describirError(caught, "Inténtalo de nuevo."),
        variant: "error",
      });
    }
  }

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
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={pendiente}
          aria-busy={pendiente || undefined}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
        >
          {pendiente ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <UserCog className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">Probar como…</span>
          <span className="sr-only sm:hidden">Probar como otro rol</span>
          <ChevronDown className="hidden h-4 w-4 sm:inline" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-64 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
        >
          <DropdownMenu.Label className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Probar la plataforma como
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={rolSimulado ?? ""}
            onValueChange={(valor) => {
              if (esRolSimulable(valor)) void probarComo(valor);
            }}
          >
            {ROLES_SIMULABLES.map((rol) => (
              <DropdownMenu.RadioItem key={rol} value={rol} className={ITEM}>
                <span className="flex h-4 w-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {ETIQUETA_ROL_SIMULABLE[rol]}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {rolSimulado ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-slate-200" />
              <DropdownMenu.Item className={ITEM + " font-semibold"} onSelect={() => void volver()}>
                <span className="h-4 w-4" aria-hidden="true" />
                Volver a administradora
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
