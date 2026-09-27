/**
 * Pagos del trámite listos para separar lo que se le cobra al cliente — Galcomex
 *
 * Lee de la BD los pagos del libro con sus facturas de proveedor enlazadas y
 * arma la entrada de `lib/calculations/pagos-cobrables.ts`. Es la ÚNICA
 * fuente para todo lo que necesita la parte cobrable de un pago
 * (`generarBorrador`, `actualizarComisionInternaLM` y el contexto del motor
 * de tarifas para los ítems ESPEJO_DE_COSTO), así todos reparten igual.
 */

import { Prisma } from "@prisma/client";

import {
  asesoriasSinCubrir,
  desglosarPago,
  enlacesAplicadosEnV2,
  esPagoMixto,
  montoPagadoEnGrupoDeAuditoria,
  montosSonEstimados,
  necesitaMontosDeAuditoria,
  tieneMontosPorEnlace,
  prepararPagosParaCobro,
  sobranteCobradoPorGrupo,
  type AbonoBloqueAuditado,
  type AsesoriaDelTramite,
  type DesglosePago,
  type PagoDelLibro,
  type PagoParaCobro,
} from "@/lib/calculations/pagos-cobrables";

/**
 * Select de Prisma de cada pago con sus facturas de proveedor enlazadas: con
 * ellas `pagos-cobrables` separa lo que NO se le cobra al cliente (asesoría
 * Ascinter, `repercutible = false`) del total de pagos, los costos bancarios y
 * la base del 4x1000. CxP v2: `monto` = lo que ESTE pago le aplicó a la
 * factura; manda siempre sobre la auditoría (ver `prepararPagosParaCobro`).
 */
const SELECT_PAGO_PARA_COBRO = {
  id: true,
  valor: true,
  costoBancario: true,
  concepto: true,
  numSoporte: true,
  grupoPagoId: true,
  facturasProveedor: {
    select: {
      facturaId: true,
      monto: true,
      factura: { select: { valor: true, repercutible: true } },
    },
  },
} satisfies Prisma.PagoTramiteSelect;

export type PagoLeidoParaCobro = Prisma.PagoTramiteGetPayload<{
  select: typeof SELECT_PAGO_PARA_COBRO;
}>;

/** Un pago del libro con su entrada para `desglosarPago`, su desglose y sus marcas. */
export type PagoCargadoParaCobro = {
  pago: PagoLeidoParaCobro;
  paraCobro: PagoParaCobro;
  /** `desglosarPago(paraCobro)`: lo que se le cobra al cliente y lo que no. */
  desglose: DesglosePago;
  /** Bloque con asesoría sin montos confiables en la auditoría (`PagoPreparado`). */
  bloqueSinMontos: boolean;
  /**
   * Su parte cobrable, sola o junto con otros pagos, le cobra al cliente más
   * de lo que valen sus facturas que se cobran (`sobranteCobradoPorGrupo`).
   */
  sobranteCobradoEnGrupo: boolean;
};

/**
 * Pagos del trámite (en el orden del libro) con su entrada para
 * `pagos-cobrables`.
 *
 * Cada enlace lleva su PagoTramiteFactura.monto (CxP v2): lo que el pago le
 * aplicó a esa factura. Con él el reparto es exacto, aunque la auditoría diga
 * otra cosa (p. ej. un bloque editado después). Excepción: en un pago MIXTO
 * (transporte + asesoría) con algún enlace heredado, el monto lo estimó la
 * migración (`montosSonEstimados`, leído de la auditoría de `aplicarSaldo`) y
 * no manda: el pago se reparte con la heurística de Ascinter y se marca si no
 * cuadra.
 *
 * Solo para enlaces heredados sin monto (la migración los dejó en 0 porque no
 * pudo repartirlos) de pagos en bloque que tocan facturas NO SE COBRA, se
 * recupera de la auditoría del bloque lo que se le abonó a cada factura (ver
 * `prepararPagosParaCobro`): así una asesoría pagada neta de retención o de
 * más no se lleva transporte ni se cobra. Si esa auditoría es ambigua (p. ej.
 * un bloque eliminado y rehecho), la asesoría pesa lo mayor entre su factura y
 * lo que la auditoría le registra, y el pago sale con `bloqueSinMontos` (por
 * revisar). Los pagos sueltos y los 100 % repercutibles no consultan nada
 * extra (casos dorados intactos).
 */
export async function cargarPagosParaCobro(
  db: Prisma.TransactionClient,
  tramiteId: string,
): Promise<PagoCargadoParaCobro[]> {
  const pagos = await db.pagoTramite.findMany({
    where: { tramiteId },
    orderBy: { orden: "asc" },
    select: SELECT_PAGO_PARA_COBRO,
  });

  const delLibro: PagoDelLibro[] = pagos.map((p) => ({
    id: p.id,
    valor: p.valor,
    costoBancario: p.costoBancario,
    grupoPagoId: p.grupoPagoId,
    facturas: p.facturasProveedor.map((e) => ({
      facturaId: e.facturaId,
      valorFactura: e.factura.valor,
      repercutible: e.factura.repercutible,
      monto: e.monto,
    })),
  }));

  // Auditoría de las facturas de (1) pagos MIXTOS con montos, para saber si
  // esos montos los aplicó CxP v2 o los estimó la migración, y (2) bloques
  // con asesoría sin montos, para recuperar lo que el bloque le abonó a cada
  // factura. Los pagos sueltos y los 100 % repercutibles no consultan nada.
  const facturaIdsAuditables = new Set<string>();
  for (const p of delLibro) {
    if ((esPagoMixto(p) && tieneMontosPorEnlace(p)) || necesitaMontosDeAuditoria(p)) {
      for (const f of p.facturas) facturaIdsAuditables.add(f.facturaId);
    }
  }

  let abonos: AbonoBloqueAuditado[] = [];
  if (facturaIdsAuditables.size > 0) {
    const filas = await db.auditLog.findMany({
      where: {
        entidad: "FacturaProveedor",
        accion: "UPDATE_ESTADO",
        tramiteId,
        entidadId: { in: [...facturaIdsAuditables] },
      },
      select: { entidadId: true, antes: true, despues: true },
    });
    const aplicadosEnV2 = enlacesAplicadosEnV2(filas);
    for (const p of delLibro) {
      if (tieneMontosPorEnlace(p) && montosSonEstimados(p, aplicadosEnV2)) p.montosEstimados = true;
    }
    abonos = filas.flatMap((f) => {
      const monto = montoPagadoEnGrupoDeAuditoria(f.antes);
      return monto === null ? [] : [{ facturaId: f.entidadId, monto }];
    });
  }

  const preparados = prepararPagosParaCobro(delLibro, abonos);
  const desgloses = preparados.map((p) => desglosarPago(p.paraCobro));
  // De cada pago cuenta lo que se le cobra al cliente (también la parte
  // cobrable de un pago mixto), contra sus facturas que se cobran.
  const sobrantes = sobranteCobradoPorGrupo(
    delLibro.map((p, i) => ({ cobrable: desgloses[i].cobrable.valor, facturas: p.facturas })),
  );
  return pagos.map((pago, i) => ({
    pago,
    ...preparados[i],
    desglose: desgloses[i],
    sobranteCobradoEnGrupo: sobrantes[i],
  }));
}

/**
 * Facturas NO SE COBRA del trámite (asesoría), enlazadas o no a pagos, con lo
 * necesario para saber si alguna queda sin cubrir (`asesoriasSinCubrir`).
 */
export async function cargarAsesoriasDelTramite(
  db: Prisma.TransactionClient,
  tramiteId: string,
): Promise<AsesoriaDelTramite[]> {
  const facturas = await db.facturaProveedor.findMany({
    where: { tramiteId, repercutible: false },
    orderBy: { id: "asc" },
    select: { id: true, valor: true, compensacionId: true, montoCompensado: true },
  });
  return facturas.map((f) => ({
    facturaId: f.id,
    valor: f.valor,
    compensada: f.compensacionId !== null,
    // CxP v2: un cruce puede ser parcial; solo esa parte queda cubierta.
    montoCompensado: f.montoCompensado,
  }));
}

/** Marcas del trámite que dependen de su asesoría (ver `ContextoRevisionPago`). */
export type AsesoriaDePagos = {
  /** Hay al menos una factura NO SE COBRA (cubierta o no): habilita SOBRANTE_COBRADO. */
  tramiteConAsesoria: boolean;
  /**
   * Alguna factura NO SE COBRA no la cubre lo no cobrable de sus pagos
   * enlazados ni se compensó: habilita PAGO_SIN_FACTURAS.
   */
  asesoriaSinCubrir: boolean;
};

/**
 * ¿El trámite tiene asesoría y queda alguna sin cubrir por los pagos del
 * libro enlazados a ella? Pura: recibe lo que ya cargaron
 * `cargarAsesoriasDelTramite` y `cargarPagosParaCobro`.
 */
export function asesoriaDePagos(
  asesorias: readonly AsesoriaDelTramite[],
  pagos: readonly PagoCargadoParaCobro[],
): AsesoriaDePagos {
  const sinCubrir = asesoriasSinCubrir(
    asesorias,
    pagos.map((p) => ({
      facturaIds: p.pago.facturasProveedor.map((e) => e.facturaId),
      paraCobro: p.paraCobro,
      noCobrable: p.desglose.noCobrable,
    })),
  );
  return { tramiteConAsesoria: asesorias.length > 0, asesoriaSinCubrir: sinCubrir.length > 0 };
}
