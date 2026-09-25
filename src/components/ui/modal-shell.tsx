"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Contenedor de modal accesible sobre <dialog> nativo: role="dialog",
 * aria-labelledby, foco atrapado, scroll del body bloqueado. Sustituye a los
 * `fixed inset-0` artesanales.
 *
 * Pedido de Ernesto, 22-sep: solo se cierra con la X o con los botones del
 * pie — ni el clic en el fondo ni Escape cierran, para no perder lo que el
 * usuario ya escribió.
 *
 *   <ModalShell open={open} onClose={() => setOpen(false)} title="Nuevo pago" size="lg">
 *     <form>…</form>
 *   </ModalShell>
 */
type ModalShellProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Si es false, el botón X se deshabilita (p. ej. mientras se guarda). */
  dismissible?: boolean;
  children: ReactNode;
  footer?: ReactNode;
};

const SIZES: Record<NonNullable<ModalShellProps["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  full: "max-w-6xl",
};

export function ModalShell({
  open,
  onClose,
  title,
  description,
  size = "md",
  dismissible = true,
  children,
  footer,
}: ModalShellProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Foco al primer control del contenido, no al botón de cerrar.
      const first = dialog.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([data-modal-close]):not([disabled])',
      );
      first?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onKeyDown={(e) => {
        // F2: en Chrome/Edge recientes, un segundo Escape sin interacción
        // del usuario dispara un `cancel` NO cancelable (el
        // `e.preventDefault()` de `onCancel` de abajo ya no alcanza) y el
        // <dialog> nativo se cierra solo mientras React sigue creyendo que
        // `open` es `true` — el modal "desaparece" y no se puede reabrir.
        // Cancelar el keydown de Escape corta la solicitud de cierre antes
        // de que el navegador la considere.
        if (e.key === "Escape") {
          e.preventDefault();
        }
      }}
      onCancel={(e) => {
        // Escape no cierra: solo evita que el <dialog> nativo se cierre solo.
        e.preventDefault();
      }}
      onClose={() => {
        // Red de seguridad: si el <dialog> igual se cerró por su cuenta
        // (evento `close`) mientras React sigue con `open=true`, se reabre
        // para no dejar el modal atascado sin forma de volver a mostrarlo.
        if (open && ref.current && !ref.current.open) {
          ref.current.showModal();
        }
      }}
      className={`m-auto w-[calc(100vw-2rem)] ${SIZES[size]} rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50`}
    >
      {open ? (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={descId} className="mt-0.5 text-sm text-slate-600">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              data-modal-close
              onClick={onClose}
              disabled={!dismissible}
              className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
