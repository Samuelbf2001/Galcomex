/**
 * POST /api/lotes-pago — Registra un pago que cubre facturas de varios DOs.
 *
 * Un solo desembolso bancario (la cartera del puerto, típicamente) se convierte
 * en un `LotePago` que agrupa un `PagoTramite` por cada trámite involucrado.
 * Los saldos por trámite siguen calculándose igual que siempre; lo que se
 * comparte es el comprobante, la fecha y la referencia bancaria.
 *
 * Reunión 1-jul-2026, min 00:48–00:50.
 */

import { CanalPago } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, z } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import {
  FacturaDuplicadaEnLoteError,
  LoteSinFacturasError,
  crearLotePago,
} from "@/lib/pagos/lotes-pago-service";
import { ComprobanteObligatorioError } from "@/lib/pagos/service";

const crearLoteSchema = z.object({
  fechaPago: z.coerce.date(),
  canalPago: z.nativeEnum(CanalPago),
  referencia: z.string().trim().min(1).optional().nullable(),
  documentoId: z.string().min(1).optional().nullable(),
  facturas: z
    .array(
      z.object({
        facturaProveedorId: z.string().min(1),
        valor: z.coerce
          .bigint()
          .refine((v) => v > 0n, { message: "El valor pagado debe ser mayor a 0" }),
      }),
    )
    .min(1, "Selecciona al menos una factura"),
  /** Confirma explícitamente una desviación pago↔facturas fuera del umbral. */
  confirmarDesviacion: z.boolean().optional().default(false),
});

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "OPERATIVO"]);
  if (session instanceof NextResponse) return session;

  let payload: z.infer<typeof crearLoteSchema>;
  try {
    payload = crearLoteSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) return validationError(error);
    throw error;
  }

  try {
    const resultado = await crearLotePago({
      fechaPago: payload.fechaPago,
      canalPago: payload.canalPago,
      referencia: payload.referencia,
      documentoId: payload.documentoId,
      facturas: payload.facturas,
      confirmarDesviacion: payload.confirmarDesviacion,
      usuarioId: session.user.id,
    });

    return jsonResponse(
      {
        lote: resultado.lote,
        pagos: resultado.pagos,
        // El operario seleccionó N facturas y el sistema generó M pagos, uno
        // por trámite: devolverlo explícito evita que parezca un error.
        tramitesAfectados: resultado.pagos.length,
      },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof LoteSinFacturasError ||
      error instanceof FacturaDuplicadaEnLoteError ||
      error instanceof ComprobanteObligatorioError
    ) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
