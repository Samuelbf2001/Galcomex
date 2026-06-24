/**
 * Servicio de sincronización manual desde Siigo.
 *
 * El flujo de envío crea un borrador (DRAFT) en Siigo. Un usuario superior
 * valida y estampa esa factura desde el portal Siigo, momento en el cual le
 * asignan el consecutivo definitivo (ej. BAQ-18453) y la fecha real.
 *
 * Como Siigo no nos notifica por push, este servicio consulta GET /v1/invoices/{id}
 * para traer el consecutivo + fecha actuales y, si la factura ya está estampada
 * (o al menos tiene un consecutivo legible), transiciona el borrador local a
 * FACTURADO + crea el registro Factura (alimentación de cartera).
 *
 * Idempotente: si el borrador ya está FACTURADO, no hace nada y devuelve los
 * datos actuales.
 */

import { EstadoBorrador, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

import {
  getInvoiceById,
  getToken,
  SiigoApiError,
  SiigoConfigError,
} from "./client";

// ─── Resultado tipado ─────────────────────────────────────────────────────────

export type SincronizarFacturaResult =
  | {
      ok: true;
      facturada: boolean;
      numFacturaSiigo: string | null;
      fechaFactura: string | null;
      stampStatus: string | null;
      mensaje: string;
    }
  | {
      ok: false;
      tipo: "estado" | "config" | "api" | "db";
      error: string;
    };

// ─── API pública ──────────────────────────────────────────────────────────────

export async function sincronizarFacturaDesdeSiigo(
  borradorId: string,
  usuarioId: string,
): Promise<SincronizarFacturaResult> {
  // ── 1. Cargar borrador ──────────────────────────────────────────────────────
  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: {
      id: true,
      estado: true,
      tramiteId: true,
      siigoDraftId: true,
      numFacturaSiigo: true,
      fechaFactura: true,
      totalFactura: true,
      saldoAFavorCliente: true,
      saldoACargoCliente: true,
      saldoAFavorLM: true,
      saldoACargoLM: true,
      tramite: { select: { clienteId: true } },
    },
  });

  if (!borrador) {
    return { ok: false, tipo: "estado", error: "Borrador no encontrado" };
  }

  if (!borrador.siigoDraftId) {
    return {
      ok: false,
      tipo: "estado",
      error: "El borrador no tiene siigoDraftId. Envíalo a SIIGO primero.",
    };
  }

  // Idempotencia: si ya está FACTURADO, devolvemos lo que tenemos
  if (borrador.estado === EstadoBorrador.FACTURADO) {
    return {
      ok: true,
      facturada: true,
      numFacturaSiigo: borrador.numFacturaSiigo,
      fechaFactura: borrador.fechaFactura?.toISOString() ?? null,
      stampStatus: null,
      mensaje: "El borrador ya estaba marcado como FACTURADO.",
    };
  }

  if (borrador.estado !== EstadoBorrador.APROBADO) {
    return {
      ok: false,
      tipo: "estado",
      error: `El borrador debe estar APROBADO para sincronizar desde SIIGO (estado actual: ${borrador.estado})`,
    };
  }

  // ── 2. Consultar Siigo ─────────────────────────────────────────────────────
  let factura;
  try {
    const token = await getToken();
    factura = await getInvoiceById(token, borrador.siigoDraftId);
  } catch (err) {
    if (err instanceof SiigoConfigError) {
      return { ok: false, tipo: "config", error: err.message };
    }
    if (err instanceof SiigoApiError) {
      return { ok: false, tipo: "api", error: err.message };
    }
    return {
      ok: false,
      tipo: "api",
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }

  // ── 3. Validar que ya tenga consecutivo definitivo ─────────────────────────
  // Si Siigo todavía no la estampó, no tendrá consecutivo (o seguirá siendo el
  // provisional del draft). En ese caso no facturamos — devolvemos estado para
  // que la UI muestre "todavía pendiente".
  if (!factura.consecutivo) {
    return {
      ok: true,
      facturada: false,
      numFacturaSiigo: null,
      fechaFactura: factura.date ?? null,
      stampStatus: factura.stampStatus,
      mensaje:
        "La factura aún no tiene consecutivo en Siigo. Pídele al superior que la valide y estampe.",
    };
  }

  // ── 4. Marcar como FACTURADO + crear Factura ────────────────────────────────
  const fechaFactura = new Date(factura.date);
  if (Number.isNaN(fechaFactura.getTime())) {
    return {
      ok: false,
      tipo: "api",
      error: `Siigo devolvió una fecha inválida: ${factura.date}`,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.borradorFactura.update({
        where: { id: borrador.id },
        data: {
          estado: EstadoBorrador.FACTURADO,
          numFacturaSiigo: factura.consecutivo,
          fechaFactura,
          facturadoPorId: usuarioId,
        },
      });

      // Alimentar cartera
      await tx.factura.create({
        data: {
          borradorId: borrador.id,
          clienteId: borrador.tramite.clienteId,
          numSiigo: factura.consecutivo,
          fecha: fechaFactura,
          totalFactura: borrador.totalFactura,
          saldoAFavorCliente: borrador.saldoAFavorCliente,
          saldoACargoCliente: borrador.saldoACargoCliente,
          saldoAFavorLM: borrador.saldoAFavorLM,
          saldoACargoLM: borrador.saldoACargoLM,
        },
      });

      await tx.auditLog.create({
        data: {
          entidad: "BorradorFactura",
          entidadId: borrador.id,
          accion: "SIIGO_SINCRONIZAR",
          usuarioId,
          tramiteId: borrador.tramiteId,
          antes: { estado: borrador.estado },
          despues: {
            estado: EstadoBorrador.FACTURADO,
            numFacturaSiigo: factura.consecutivo,
            fechaFactura: fechaFactura.toISOString(),
            stampStatus: factura.stampStatus,
            cufe: factura.cufe,
          } as Prisma.InputJsonValue,
        },
      });
    });
  } catch (err) {
    return {
      ok: false,
      tipo: "db",
      error: err instanceof Error ? err.message : "Error guardando en BD",
    };
  }

  return {
    ok: true,
    facturada: true,
    numFacturaSiigo: factura.consecutivo,
    fechaFactura: fechaFactura.toISOString(),
    stampStatus: factura.stampStatus,
    mensaje: `Factura ${factura.consecutivo} sincronizada desde Siigo.`,
  };
}
