import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Alert — primitivo shadcn/ui mínimo (sin Radix, es solo un div con rol de
 * alerta). Paleta alineada a los colores que ya usa el resto de la app
 * (rose = destructiva, amber = advertencia) en vez de los tokens
 * --card/--destructive de shadcn, que este proyecto no define en globals.css.
 */

const alertVariants = cva(
  "relative w-full grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4",
  {
    variants: {
      variant: {
        default: "border-slate-200 bg-white text-slate-900 [&>svg]:text-slate-500",
        destructive: "border-rose-300 bg-rose-50 text-rose-800 [&>svg]:text-rose-600",
        warning: "border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-600",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 text-sm leading-relaxed [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
