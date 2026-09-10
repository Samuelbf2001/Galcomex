"use client";

import { AlertTriangle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Confirmación accesible basada en <dialog> nativo (foco atrapado, Escape,
 * role="dialog" y backdrop sin código extra). Reemplaza a window.confirm.
 *
 *   const confirmar = useConfirm();
 *   if (!(await confirmar({ title: "¿Anular este pago?", variant: "danger" }))) return;
 *
 * Fuera del provider cae a window.confirm para no romper nada.
 */

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "danger";
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

const fallback: ConfirmFn = async (o) =>
  typeof window !== "undefined" ? window.confirm(o.description ? `${o.title}\n\n${o.description}` : o.title) : false;

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? fallback;
}

type Pending = { options: ConfirmOptions; resolve: (ok: boolean) => void };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending((prev) => {
        prev?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  const cerrar = useCallback((ok: boolean) => {
    setPending((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending) {
      if (!dialog.open) dialog.showModal();
      cancelRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [pending]);

  const value = useMemo(() => confirm, [confirm]);
  const o = pending?.options;
  const danger = o?.variant === "danger";

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        aria-labelledby="confirm-title"
        aria-describedby={o?.description ? "confirm-desc" : undefined}
        onCancel={(e) => {
          e.preventDefault();
          cerrar(false);
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) cerrar(false);
        }}
        className="m-auto w-[min(92vw,440px)] border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50"
      >
        {o ? (
          <div className="p-5">
            <div className="flex items-start gap-3">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center ${danger ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-700"}`}
              >
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 id="confirm-title" className="text-base font-semibold">
                  {o.title}
                </h2>
                {o.description ? (
                  <p id="confirm-desc" className="mt-1 text-sm text-slate-600">
                    {o.description}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => cerrar(false)}
                className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600"
              >
                {o.cancelText ?? "Cancelar"}
              </button>
              <button
                type="button"
                onClick={() => cerrar(true)}
                className={`inline-flex h-9 items-center px-3 text-sm font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${danger ? "bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-600" : "bg-slate-950 hover:bg-slate-800 focus-visible:ring-cyan-600"}`}
              >
                {o.confirmText ?? (danger ? "Sí, continuar" : "Confirmar")}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </ConfirmContext.Provider>
  );
}
