/**
 * Validaciones Zod — Cartera (pagos de factura)
 */

import { CanalPago, DestinoPago, TipoPagoFactura, TipoRecaudo } from "@prisma/client";
import { z } from "zod";

export const registrarPagoFacturaSchema = z
  .object({
    destino: z.nativeEnum(DestinoPago),
    tipo: z.nativeEnum(TipoPagoFactura),
    monto: z.coerce
      .bigint()
      .refine((v) => v > 0n, { message: "El monto debe ser mayor a 0" }),
    fecha: z.coerce.date(),
    // Exactamente uno de (tipoRecaudo, canalPago) debe estar seteado.
    // Callers que solo mandan canalPago siguen siendo válidos (compat).
    tipoRecaudo: z.nativeEnum(TipoRecaudo).optional(),
    canalPago: z.nativeEnum(CanalPago).optional(),
    comprobanteKey: z.string().min(1).optional().nullable(),
    verificadoBanco: z.boolean().default(false),
  })
  .refine(
    (data) => {
      const hasRecaudo = data.tipoRecaudo !== undefined;
      const hasCanal = data.canalPago !== undefined;
      // Exactamente uno debe estar presente
      return hasRecaudo !== hasCanal;
    },
    {
      message:
        "Debe especificarse exactamente uno de tipoRecaudo o canalPago (no ambos, no ninguno).",
      path: ["tipoRecaudo"],
    },
  );

export type RegistrarPagoFacturaPayload = z.infer<typeof registrarPagoFacturaSchema>;

export const ingresosQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
});
