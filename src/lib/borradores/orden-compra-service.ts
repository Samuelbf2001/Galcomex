/**
 * Orden de compra del cliente vs. borrador (B4, Diseño B, 29-sep-2026) —
 * lado con BD de `orden-compra.ts` (la regla pura).
 *
 * Solo evalúa cuando la empresa del DO tiene la capacidad
 * `orden_compra_en_revision` encendida y el borrador es CONCEPTOS_IVA (el
 * formato COMISION de Lucho y las empresas sin la función no cambian): en
 * cualquier otro caso devuelve `SIN_OC` y `activa: false`.
 *
 * OC compartida por varios DOs: cada DO lleva SU parte en `ordenCompraValor`
 * (el esquema ya permite el mismo número en varios DOs). Aquí se listan los
 * DOs hermanos (misma empresa, mismo número) y la suma de todas las partes,
 * para compararla con el PDF de la OC. No hay columna nueva de «total de la OC».
 */

import type { Prisma } from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { configDe, tiene } from "@/lib/capacidades/resolver";

import { FORMATO_CONCEPTOS_IVA } from "./formato-conceptos";
import {
  CONFIG_OC_DEFECTO,
  configOrdenCompraDe,
  desgloseParaOc,
  evaluarOrdenCompra,
  type ConfigOrdenCompra,
  type EvaluacionOc,
} from "./orden-compra";

type Tx = Prisma.TransactionClient;

export const CAPACIDAD_ORDEN_COMPRA = "orden_compra_en_revision";

export type HermanoOc = { consecutivo: string; valorOc: bigint | null };

export type OrdenCompraDeBorrador = {
  /** ¿La empresa tiene la función y el borrador es CONCEPTOS_IVA? Si no, nada de esto aplica. */
  activa: boolean;
  evaluacion: EvaluacionOc;
  config: ConfigOrdenCompra;
  /** Otros DOs de la misma empresa con el mismo N° de OC (sin este). */
  hermanos: HermanoOc[];
  /**
   * Suma de las partes de TODOS los DOs con ese N° de OC (este incluido) —
   * lo que hay que comparar con el total del PDF de la OC. `null` si el DO no
   * comparte la OC con otro.
   */
  sumaHermanos: bigint | null;
};

const SIN_OC: OrdenCompraDeBorrador = {
  activa: false,
  evaluacion: { estado: "SIN_OC" },
  config: CONFIG_OC_DEFECTO,
  hermanos: [],
  sumaHermanos: null,
};

export async function evaluarOcDeBorrador(tx: Tx, borradorId: string): Promise<OrdenCompraDeBorrador> {
  const borrador = await tx.borradorFactura.findUnique({
    where: { id: borradorId },
    select: {
      formatoFactura: true,
      tramite: {
        select: { id: true, clienteId: true, ordenCompraNumero: true, ordenCompraValor: true },
      },
      lineasRevision: { select: { valor: true, seccion: true, tipoFija: true } },
    },
  });
  if (!borrador || borrador.formatoFactura !== FORMATO_CONCEPTOS_IVA) return SIN_OC;
  // Camino corto (la gran mayoría de los DOs): sin N° de OC no hay nada que contrastar.
  if (!borrador.tramite.ordenCompraNumero?.trim()) return SIN_OC;

  const capacidades = await capacidadesDeEmpresa(borrador.tramite.clienteId);
  if (!tiene(capacidades, CAPACIDAD_ORDEN_COMPRA)) return SIN_OC;
  const config = configOrdenCompraDe(configDe(capacidades, CAPACIDAD_ORDEN_COMPRA));

  const evaluacion = evaluarOrdenCompra({
    numero: borrador.tramite.ordenCompraNumero,
    valorOc: borrador.tramite.ordenCompraValor,
    desglose: desgloseParaOc(borrador.lineasRevision),
    config,
  });

  const { hermanos, sumaHermanos } = await hermanosDeOc(tx, {
    tramiteId: borrador.tramite.id,
    clienteId: borrador.tramite.clienteId,
    numero: borrador.tramite.ordenCompraNumero,
    valorPropio: borrador.tramite.ordenCompraValor,
  });

  return { activa: true, evaluacion, config, hermanos, sumaHermanos };
}

/**
 * `evaluarOcDeBorrador` para las LECTURAS (GET, respuesta del PATCH y del
 * generar): el aviso es de apoyo, así que si no se puede evaluar, la respuesta
 * sale sin el campo (`null`) en vez de tumbar una operación que ya se hizo.
 * El freno de `transicionarBorrador` NO usa esto: ahí un error corta.
 * `null` también cuando no aplica (sin la función, sin N° de OC, COMISION).
 */
export async function evaluarOcSinRomper(tx: Tx, borradorId: string): Promise<OrdenCompraDeBorrador | null> {
  try {
    const oc = await evaluarOcDeBorrador(tx, borradorId);
    return oc.activa ? oc : null;
  } catch (error) {
    console.error(`[borradores/orden-compra] no se pudo evaluar la OC del borrador ${borradorId}`, error);
    return null;
  }
}

function normalizarNumeroOc(n: string): string {
  return n.trim().toUpperCase();
}

async function hermanosDeOc(
  tx: Tx,
  d: { tramiteId: string; clienteId: string; numero: string | null; valorPropio: bigint | null },
): Promise<{ hermanos: HermanoOc[]; sumaHermanos: bigint | null }> {
  const numero = d.numero ? normalizarNumeroOc(d.numero) : "";
  if (numero === "") return { hermanos: [], sumaHermanos: null };

  const candidatos = await tx.tramiteDO.findMany({
    where: {
      clienteId: d.clienteId,
      id: { not: d.tramiteId },
      // `contains` y no `equals`: un N° guardado con espacios (datos importados) también debe
      // salir; la comparación exacta (trim + mayúsculas) se hace abajo.
      ordenCompraNumero: { contains: numero, mode: "insensitive" },
    },
    select: { consecutivo: true, ordenCompraNumero: true, ordenCompraValor: true },
    orderBy: { consecutivo: "asc" },
  });

  const hermanos = candidatos
    .filter((c) => c.ordenCompraNumero !== null && normalizarNumeroOc(c.ordenCompraNumero) === numero)
    .map((c) => ({ consecutivo: c.consecutivo, valorOc: c.ordenCompraValor }));
  if (hermanos.length === 0) return { hermanos: [], sumaHermanos: null };

  const suma = hermanos.reduce((a, h) => a + (h.valorOc ?? 0n), d.valorPropio ?? 0n);
  return { hermanos, sumaHermanos: suma };
}
