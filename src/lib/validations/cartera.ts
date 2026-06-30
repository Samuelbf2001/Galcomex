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

// ─── Schema batch (conciliar lote) ───────────────────────────────────────────

export const conciliarLoteItemSchema = z
  .object({
    facturaId: z.string().min(1),
    destino: z.nativeEnum(DestinoPago),
    tipo: z.nativeEnum(TipoPagoFactura),
    monto: z.coerce
      .bigint()
      .refine((v) => v > 0n, { message: "El monto debe ser mayor a 0" }),
    fecha: z.coerce.date(),
    tipoRecaudo: z.nativeEnum(TipoRecaudo).optional(),
    canalPago: z.nativeEnum(CanalPago).optional(),
    comprobanteKey: z.string().min(1).optional().nullable(),
    verificadoBanco: z.boolean().default(false),
  })
  .refine(
    (data) => (data.tipoRecaudo !== undefined) !== (data.canalPago !== undefined),
    {
      message: "Debe especificarse exactamente uno de tipoRecaudo o canalPago.",
      path: ["tipoRecaudo"],
    },
  );

export const conciliarLoteSchema = z
  .object({
    items: z.array(conciliarLoteItemSchema).min(1).max(50),
  })
  .refine(
    (data) =>
      new Set(data.items.map((i) => `${i.facturaId}:${i.destino}`)).size ===
      data.items.length,
    {
      message: "Cada (facturaId, destino) debe aparecer una sola vez en el lote",
      path: ["items"],
    },
  );

export type ConciliarLoteItemPayload = z.infer<typeof conciliarLoteItemSchema>;
export type ConciliarLotePayload = z.infer<typeof conciliarLoteSchema>;

// ─── Otros schemas ────────────────────────────────────────────────────────────

export const ingresosQuerySchema = z.object({
  clienteId: z.string().min(1).optional(),
  desde: z.coerce.date().optional(),
  hasta: z.coerce.date().optional(),
});
