"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Contenedor de modal accesible sobre <dialog> nativo: role="dialog",
 * aria-labelledby, foco atrapado, Escape cierra, clic en el fondo cierra,
 * scroll del body bloqueado. Sustituye a los `fixed inset-0` artesanales.
 *
 *   <ModalShell open={open} onClose={() => setOpen(false)} title="Nuevo pago" size="lg">
 *     <form>…</form>
 *   </ModalShell>
 */
type ModalShellProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg" | "xl";
  /** Si es false, ni Escape ni el fondo cierran (p. ej. mientras se guarda). */
  dismissible?: boolean;
  children: ReactNode;
  footer?: ReactNode;
};

const SIZES: Record<NonNullable<ModalShellProps["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
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
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
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
