import {
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoMovimientoCuenta,
} from "@prisma/client";
import { z } from "zod";

export const movimientoCuentaSchema = z.object({
  rol: z.nativeEnum(RolCuenta),
  tipo: z.nativeEnum(TipoMovimientoCuenta),
  origen: z.nativeEnum(OrigenMovimientoCuenta),
  /** Espejo de `TipoTramite.lineaServicio`. */
  lineaServicio: z.string().trim().min(1).max(40).default("TRAMITE"),
  concepto: z.string().trim().min(1, "El concepto es obligatorio").max(200),
  valor: z.coerce
    .bigint()
    .refine((valor) => valor > 0n, { message: "El valor debe ser mayor a 0" }),
  fecha: z.coerce.date(),
  tramiteId: z.string().min(1).optional().nullable(),
});

export type MovimientoCuentaPayload = z.infer<typeof movimientoCuentaSchema>;
