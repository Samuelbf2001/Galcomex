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
 * Fase centavos (D.4, D-7 por defecto): antes de crear la `Factura` se lee el
 * TOTAL que liquidó Siigo (y, en CONCEPTOS_IVA, su IVA y retenciones) y se
 * compara al centavo con el borrador. Si difieren, NO se crea la `Factura`, el
 * borrador sigue APROBADO y se devuelve `SIIGO_TOTAL_DISTINTO` con los dos
 * valores: la factura legal ya existe en Siigo y una persona decide.
 *
 * Idempotente: si el borrador ya está FACTURADO, no hace nada y devuelve los
 * datos actuales.
 */

import { EstadoBorrador, Prisma } from "@prisma/client";

import { FORMATO_CONCEPTOS_IVA } from "@/lib/borradores/formato-conceptos";
import { prisma } from "@/lib/db/prisma";
import { formatoPesos, type Centavos } from "@/lib/dinero";

import {
  getInvoiceById,
  getToken,
  SiigoApiError,
  SiigoConfigError,
  type MontosFacturaSiigo,
} from "./client";

// ─── Resultado tipado ─────────────────────────────────────────────────────────

export const CODIGO_SIIGO_TOTAL_DISTINTO = "SIIGO_TOTAL_DISTINTO";

/** Un monto que Siigo y el borrador no tienen igual (centavos). */
export interface DiferenciaSiigo {
  campo: "total" | "iva" | "retenciones";
  /** null = Siigo no devolvió el dato (no se puede comprobar). */
  siigoCentavos: Centavos | null;
  borradorCentavos: Centavos;
}

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
    }
  | {
      ok: false;
      tipo: "total_distinto";
      codigo: typeof CODIGO_SIIGO_TOTAL_DISTINTO;
      error: string;
      numFacturaSiigo: string;
      /** Total de Siigo en centavos (null si Siigo no lo devolvió). */
      totalSiigoCentavos: Centavos | null;
      totalBorradorCentavos: Centavos;
      diferencias: DiferenciaSiigo[];
    };

// ─── Comparación pura (D-7) ───────────────────────────────────────────────────

export interface MontosBorradorParaSiigo {
  formatoFactura: string;
  totalFacturaCentavos: Centavos;
  ivaComisionCentavos: Centavos;
  retencionesCentavos: Centavos;
}

/**
 * Diferencias al centavo entre lo que liquidó Siigo y el borrador. Vacío = cuadra.
 *
 * - El TOTAL se compara siempre; si Siigo no lo devolvió, es una diferencia
 *   (no se puede comprobar ⇒ no se factura a ciegas).
 * - IVA y retenciones solo en CONCEPTOS_IVA (en COMISION el IVA viaja como un
 *   ítem y no se mandan retenciones) y solo si Siigo los devolvió.
 */
export function compararMontosSiigo(
  siigo: MontosFacturaSiigo,
  borrador: MontosBorradorParaSiigo,
): DiferenciaSiigo[] {
  const diferencias: DiferenciaSiigo[] = [];
  if (siigo.totalCentavos === null || siigo.totalCentavos !== borrador.totalFacturaCentavos) {
    diferencias.push({
      campo: "total",
      siigoCentavos: siigo.totalCentavos,
      borradorCentavos: borrador.totalFacturaCentavos,
    });
  }
  if (borrador.formatoFactura === FORMATO_CONCEPTOS_IVA) {
    if (siigo.ivaCentavos !== null && siigo.ivaCentavos !== borrador.ivaComisionCentavos) {
      diferencias.push({
        campo: "iva",
        siigoCentavos: siigo.ivaCentavos,
        borradorCentavos: borrador.ivaComisionCentavos,
      });
    }
    if (
      siigo.retencionesCentavos !== null &&
      siigo.retencionesCentavos !== borrador.retencionesCentavos
    ) {
      diferencias.push({
        campo: "retenciones",
        siigoCentavos: siigo.retencionesCentavos,
        borradorCentavos: borrador.retencionesCentavos,
      });
    }
  }
  return diferencias;
}

const NOMBRE_CAMPO: Record<DiferenciaSiigo["campo"], string> = {
  total: "total",
  iva: "IVA",
  retenciones: "retenciones",
};

/** Texto para la persona con los dos valores de cada diferencia (",00" como en la factura). */
export function mensajeTotalDistinto(consecutivo: string, diferencias: DiferenciaSiigo[]): string {
  const f = (c: Centavos) => formatoPesos(c, { decimales: "siempre" });
  const detalle = diferencias
    .map((d) =>
      d.siigoCentavos === null
        ? `${NOMBRE_CAMPO[d.campo]}: SIIGO no lo devolvió; borrador ${f(d.borradorCentavos)}`
        : `${NOMBRE_CAMPO[d.campo]}: SIIGO ${f(d.siigoCentavos)} · borrador ${f(d.borradorCentavos)} (diferencia ${f(d.siigoCentavos - d.borradorCentavos)})`,
    )
    .join("; ");
  return (
    `La factura ${consecutivo} de SIIGO no coincide con el borrador (${detalle}). ` +
    "No se marcó como facturada ni pasó a cartera: revisa la factura en SIIGO y corrige el borrador o regístrala a mano."
  );
}

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
      formatoFactura: true,
      totalFacturaCentavos: true,
      ivaComisionCentavos: true,
      retencionesCentavos: true,
      saldoAFavorClienteCentavos: true,
      saldoACargoClienteCentavos: true,
      saldoAFavorLMCentavos: true,
      saldoACargoLMCentavos: true,
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

  // ── 3b. Total de Siigo = total del borrador, al centavo (D-7) ──────────────
  const diferencias = compararMontosSiigo(factura.montos, borrador);
  if (diferencias.length > 0) {
    return {
      ok: false,
      tipo: "total_distinto",
      codigo: CODIGO_SIIGO_TOTAL_DISTINTO,
      error: mensajeTotalDistinto(factura.consecutivo, diferencias),
      numFacturaSiigo: factura.consecutivo,
      totalSiigoCentavos: factura.montos.totalCentavos,
      totalBorradorCentavos: borrador.totalFacturaCentavos,
      diferencias,
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

      // Alimentar cartera (el total ya se comprobó igual al de Siigo).
      await tx.factura.create({
        data: {
          borradorId: borrador.id,
          clienteId: borrador.tramite.clienteId,
          numSiigo: factura.consecutivo,
          fecha: fechaFactura,
          totalFacturaCentavos: borrador.totalFacturaCentavos,
          saldoAFavorClienteCentavos: borrador.saldoAFavorClienteCentavos,
          saldoACargoClienteCentavos: borrador.saldoACargoClienteCentavos,
          saldoAFavorLMCentavos: borrador.saldoAFavorLMCentavos,
          saldoACargoLMCentavos: borrador.saldoACargoLMCentavos,
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
