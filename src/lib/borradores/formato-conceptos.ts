/**
 * Formato de factura "CONCEPTOS_IVA" — facturas de Galcomex propio.
 *
 * Lo enciende la función `factura_conceptos_iva` de la empresa y queda fijado en
 * `BorradorFactura.formatoFactura` al generar el borrador (los borradores viejos
 * siguen en "COMISION"). Diferencias con el formato de comisión:
 *
 *   - Cada concepto del tarifario es una línea OPERACIONAL con su producto Siigo
 *     y `aplicaIva`; no hay línea "COMISION GALCOMEX" ni costos bancarios.
 *   - Las líneas de terceros nacen de las facturas de proveedor repercutibles
 *     del trámite ("ALMACENAJE ALMACARGA FACT. FE-11298").
 *   - La línea IVA_COMISION guarda la suma del IVA por ítem y la línea
 *     IMPUESTO_4X1000 el 0,4 % de los terceros. Ambas son derivadas: se
 *     recalculan cada vez que cambian las líneas (`sincronizarLineasDerivadas`).
 *   - La ReteIVA se calcula con el % de la función (`reteIvaPorcentaje`).
 *
 * La matemática vive en `@/lib/calculations/factura-conceptos` (pura, con casos
 * dorados BAQ-18385 y BAQ-18357).
 */

import { EstadoBorrador, type Prisma, SeccionLinea } from "@prisma/client";
import { z } from "zod";

import { calcularFacturaConceptos } from "@/lib/calculations/factura-conceptos";
import { configDe, tiene } from "@/lib/capacidades/resolver";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { getParametrosSistema } from "@/lib/parametros/service";

import { resolverProductosLineasFijas } from "./lineas-fijas";

type Tx = Prisma.TransactionClient;

export const FORMATO_COMISION = "COMISION";
export const FORMATO_CONCEPTOS_IVA = "CONCEPTOS_IVA";

export const CONCEPTO_LINEA_IVA = "IVA 19%";
export const CONCEPTO_LINEA_4X1000 = "DECRETO 2331 4X1000";
export const OBSERVACION_NO_RETENCIONES = "NO PRACTICAR RETEFUENTE NI RETEICA";

const configSchema = z.object({
  reteIvaPorcentaje: z.number().int().min(0).max(100).nullable().optional(),
  observacionNoRetenciones: z.boolean().optional(),
});

export type FormatoEmpresa =
  | { formato: typeof FORMATO_COMISION }
  | {
      formato: typeof FORMATO_CONCEPTOS_IVA;
      /** null = retenciones a mano. */
      reteIvaPorcentaje: number | null;
      observacionNoRetenciones: boolean;
    };

/** Formato con el que se factura a la empresa según su función `factura_conceptos_iva`. */
export async function formatoFacturaDeEmpresa(empresaId: string): Promise<FormatoEmpresa> {
  const capacidades = await capacidadesDeEmpresa(empresaId);
  if (!tiene(capacidades, "factura_conceptos_iva")) {
    return { formato: FORMATO_COMISION };
  }
  const parsed = configSchema.safeParse(configDe(capacidades, "factura_conceptos_iva") ?? {});
  const config = parsed.success ? parsed.data : {};
  return {
    formato: FORMATO_CONCEPTOS_IVA,
    reteIvaPorcentaje: config.reteIvaPorcentaje ?? null,
    observacionNoRetenciones: config.observacionNoRetenciones ?? true,
  };
}

/** "ALMACENAJE ALMACARGA FACT. FE-11298": concepto, proveedor y n° de factura, como en Siigo. */
export function conceptoLineaTercero(factura: {
  concepto: string | null;
  proveedorNombre: string;
  numFactura: string;
  siigoProducto: { nombre: string } | null;
}): string {
  const base =
    factura.concepto?.trim() || factura.siigoProducto?.nombre.trim() || "PAGO A TERCEROS";
  return `${base} ${factura.proveedorNombre.trim()} FACT. ${factura.numFactura.trim()}`
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * Líneas TERCEROS para `lineasRevision.create`: una por factura de proveedor
 * repercutible del trámite que no esté ya en un borrador aprobado o facturado.
 */
export async function lineasTercerosDesdeFacturas(
  tx: Tx,
  tramiteId: string,
): Promise<Prisma.LineaRevisionCreateWithoutBorradorInput[]> {
  const facturas = await tx.facturaProveedor.findMany({
    where: {
      tramiteId,
      repercutible: true,
      estado: { not: "FACTURADA_CLIENTE" },
      lineasRevision: {
        none: {
          linea: {
            borrador: {
              estado: { in: [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] },
            },
          },
        },
      },
    },
    orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      concepto: true,
      proveedorNombre: true,
      numFactura: true,
      valor: true,
      siigoProductoId: true,
      siigoProducto: { select: { nombre: true } },
    },
  });

  return facturas.map((factura, index) => ({
    concepto: conceptoLineaTercero(factura),
    numSoporte: factura.numFactura,
    valor: factura.valor,
    orden: index + 1,
    origen: "AUTO",
    seccion: SeccionLinea.TERCEROS,
    aplicaIva: false,
    ...(factura.siigoProductoId
      ? { siigoProducto: { connect: { id: factura.siigoProductoId } } }
      : {}),
    facturas: { create: [{ factura: { connect: { id: factura.id } } }] },
  }));
}

type LineaParaSincronizar = {
  id: string;
  valor: bigint;
  seccion: SeccionLinea;
  tipoFija: string | null;
  aplicaIva: boolean;
};

async function fijarLineaDerivada(
  tx: Tx,
  borradorId: string,
  lineas: LineaParaSincronizar[],
  tipoFija: "IVA_COMISION" | "IMPUESTO_4X1000",
  valor: bigint,
  productoId: string | null,
): Promise<void> {
  const existente = lineas.find((l) => l.tipoFija === tipoFija);
  if (valor === 0n) {
    if (existente) await tx.lineaRevision.delete({ where: { id: existente.id } });
    return;
  }
  if (existente) {
    if (existente.valor !== valor) {
      await tx.lineaRevision.update({ where: { id: existente.id }, data: { valor } });
    }
    return;
  }
  const esIva = tipoFija === "IVA_COMISION";
  await tx.lineaRevision.create({
    data: {
      borradorId,
      concepto: esIva ? CONCEPTO_LINEA_IVA : CONCEPTO_LINEA_4X1000,
      valor,
      orden: esIva ? 992 : 995,
      origen: "AUTO",
      seccion: esIva ? SeccionLinea.OPERACIONAL : SeccionLinea.TERCEROS,
      tipoFija,
      aplicaIva: false,
      siigoProductoId: esIva ? null : productoId,
    },
  });
}

/**
 * Recalcula las líneas derivadas (IVA, 4x1000) y la ReteIVA de un borrador
 * CONCEPTOS_IVA. No-op para el formato de comisión. Debe correr dentro de la
 * transacción que modificó las líneas, antes de sumar el total.
 */
export async function sincronizarLineasDerivadas(tx: Tx, borradorId: string): Promise<void> {
  const borrador = await tx.borradorFactura.findUniqueOrThrow({
    where: { id: borradorId },
    select: {
      formatoFactura: true,
      reteIvaPorcentaje: true,
      retenciones: true,
      lineasRevision: {
        select: { id: true, valor: true, seccion: true, tipoFija: true, aplicaIva: true },
      },
    },
  });
  if (borrador.formatoFactura !== FORMATO_CONCEPTOS_IVA) return;

  const params = await getParametrosSistema();
  const lineas = borrador.lineasRevision;
  const calc = calcularFacturaConceptos({
    terceros: lineas
      .filter((l) => l.seccion === SeccionLinea.TERCEROS && !l.tipoFija)
      .map((l) => l.valor),
    conceptos: lineas
      .filter((l) => l.seccion === SeccionLinea.OPERACIONAL && !l.tipoFija)
      .map((l) => ({ valor: l.valor, aplicaIva: l.aplicaIva })),
    tasaIva: params.tasaIva,
    tasa4x1000: params.tasa4x1000,
    reteIvaPorcentaje: borrador.reteIvaPorcentaje,
    retencionesManuales: borrador.retenciones,
    totalAnticipo: 0n,
  });

  const productos = await resolverProductosLineasFijas(tx);

  // En este formato no existen la comisión global ni los costos bancarios.
  const sobrantes = lineas.filter(
    (l) => l.tipoFija === "COMISION" || l.tipoFija === "COSTOS_BANCARIOS",
  );
  if (sobrantes.length > 0) {
    await tx.lineaRevision.deleteMany({ where: { id: { in: sobrantes.map((l) => l.id) } } });
  }

  await fijarLineaDerivada(tx, borradorId, lineas, "IVA_COMISION", calc.iva, null);
  await fijarLineaDerivada(
    tx,
    borradorId,
    lineas,
    "IMPUESTO_4X1000",
    calc.impuesto4x1000,
    productos.producto4x1000Id,
  );

  if (borrador.reteIvaPorcentaje !== null && borrador.retenciones !== calc.retenciones) {
    await tx.borradorFactura.update({
      where: { id: borradorId },
      data: { retenciones: calc.retenciones },
    });
  }
}
