"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Toasts de la app (sin dependencias). Uso:
 *
 *   const { toast } = useToast();
 *   toast({ title: "Pago guardado", variant: "success" });
 *   toast({ title: "No se pudo guardar", description: describirError(e), variant: "error" });
 *   toast({ title: "Se avanzó saltando requisitos", description: "...", variant: "warning" });
 *
 * Fuera del provider `toast` no rompe: no hace nada.
 */

export type ToastVariant = "success" | "error" | "warning" | "info";

export type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** ms; por defecto 5000 (8000 para error). */
  duration?: number;
};

type ToastItem = ToastInput & { id: number; variant: ToastVariant };

type ToastContextValue = {
  toast: (input: ToastInput) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const NOOP: ToastContextValue = { toast: () => {}, dismiss: () => {} };

export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? NOOP;
}

/** Convierte cualquier `catch (e)` en un mensaje legible para el usuario. */
export function describirError(caught: unknown, fallback = "Ocurrió un error inesperado."): string {
  if (caught instanceof Error && caught.message.trim()) {
    if (/failed to fetch|networkerror|load failed/i.test(caught.message)) {
      return "Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.";
    }
    return caught.message;
  }
  if (typeof caught === "string" && caught.trim()) return caught;
  return fallback;
}

const STYLES: Record<ToastVariant, { box: string; icon: typeof Info }> = {
  success: { box: "border-emerald-300 bg-emerald-50 text-emerald-900", icon: CheckCircle2 },
  error: { box: "border-rose-300 bg-rose-50 text-rose-900", icon: AlertTriangle },
  // F6: avisos de "pasó, pero se saltó un requisito" (excepción de ADMIN) —
  // ni éxito limpio ni error, ámbar como el resto de advertencias de la app.
  warning: { box: "border-amber-300 bg-amber-50 text-amber-900", icon: AlertTriangle },
  info: { box: "border-slate-300 bg-white text-slate-900", icon: Info },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const variant = input.variant ?? "info";
      const duration =
        input.duration ?? (variant === "error" ? 8000 : variant === "warning" ? 7000 : 5000);
      setItems((prev) => [...prev.slice(-4), { ...input, id, variant }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2"
      >
        {items.map((item) => {
          const style = STYLES[item.variant];
          const Icon = style.icon;
          return (
            <div
              key={item.id}
              className={`pointer-events-auto flex items-start gap-3 border px-4 py-3 text-sm shadow-lg ${style.box}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 break-words text-[13px] opacity-90">{item.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center opacity-70 transition hover:opacity-100"
                aria-label="Cerrar aviso"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
