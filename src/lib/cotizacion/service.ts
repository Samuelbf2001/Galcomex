/**
 * Cotización / solicitud de fondos por DO (B7, Diseño B, 29-sep-2026) — servicio
 * con BD. La cuenta vive en `calculo.ts` (pura); aquí se arma lo que la factura
 * de venta CONCEPTOS_IVA tomaría del DO y se entrega ya calculado:
 *
 *   - conceptos: la propuesta del tarifario vigente (`propuestaParaTramite`),
 *     o, en un DO de flujo corto («Otros»), lo mismo que facturaría
 *     `resolverFacturableFlujoCorto` (valor y concepto a mano, o su tarifa);
 *   - terceros: las facturas de proveedor que se cobran al cliente y todavía
 *     no van en una factura aprobada/facturada (`lineasTercerosDesdeFacturas`);
 *   - IVA, ReteIVA y 4x1000: los parámetros y la función `factura_conceptos_iva`
 *     de la empresa, igual que `generarBorrador`.
 *
 * Solo lectura: no persiste nada ni toca el estado del DO. Con lo que falta
 * (sin tarifa, pendientes, formato de comisión) responde 422
 * `COTIZACION_INCOMPLETA` diciendo qué.
 */

import { FORMATO_CONCEPTOS_IVA, formatoFacturaDeEmpresa, lineasTercerosDesdeFacturas } from "@/lib/borradores/formato-conceptos";
import { configOrdenCompraDe } from "@/lib/borradores/orden-compra";
import { CAPACIDAD_ORDEN_COMPRA } from "@/lib/borradores/orden-compra-service";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { configDe, tiene } from "@/lib/capacidades/resolver";
import { conceptosParaLineas } from "@/lib/catalogos/conceptos-service";
import { resolverLineaConcepto } from "@/lib/catalogos/nombre-linea";
import {
  armarCotizacion,
  textoNotaAgencia,
  type ConceptoCotizacion,
  type ResultadoCotizacion,
} from "@/lib/cotizacion/calculo";
import { prisma } from "@/lib/db/prisma";
import { getParametrosSistema } from "@/lib/parametros/service";
import { agenciamientoEstandarDe } from "@/lib/tarifas/agenciamiento";
import { propuestaParaTramite, TarifaIncompletaError, type PendienteTarifa } from "@/lib/tarifas/service";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import { resolverFacturableFlujoCorto } from "@/lib/tramites/flujo-corto";

export const CAPACIDAD_OC = CAPACIDAD_ORDEN_COMPRA;

export class TramiteCotizacionNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Trámite no encontrado");
    this.name = "TramiteCotizacionNoEncontradoError";
  }
}

/** No hay con qué armar la cotización (sin tarifa, con pendientes o con otro formato de factura). */
export class CotizacionIncompletaError extends Error {
  public readonly status = 422;
  public readonly codigo = "COTIZACION_INCOMPLETA" as const;
  public readonly pendientes: PendienteTarifa[];
  constructor(mensaje: string, pendientes: PendienteTarifa[] = []) {
    super(mensaje);
    this.name = "CotizacionIncompletaError";
    this.pendientes = pendientes;
  }
}

export interface CotizacionDto extends ResultadoCotizacion {
  fecha: Date;
  tramite: {
    id: string;
    consecutivo: string;
    ciudad: string;
    doCliente: string | null;
    proveedorCliente: string | null;
    referenciaExterna: string | null;
    ordenCompraNumero: string | null;
    ordenCompraValor: bigint | null;
  };
  empresa: { id: string; nombre: string; nit: string; contactoNombre: string | null; ciudad: string | null };
  /** De dónde salen los conceptos: la propuesta del tarifario o el valor escrito a mano en un «Otros». */
  fuente: "TARIFA" | "VALOR";
  tarifario: { id: string; nombre: string; version: number } | null;
  /** La empresa usa la orden de compra en la revisión: el PDF imprime "Valor para su orden de compra". */
  usaOrdenCompra: boolean;
  /** Texto de la nota de la agencia de aduanas (B9), o null si el DO no tiene agencia con agenciamiento. */
  textoNotaAgencia: string | null;
}

/** Una línea antes de resolver su nombre: sale de la tarifa o del valor a mano del «Otros». */
type LineaOrigen = {
  nombrePublico: string;
  valor: bigint;
  /** `undefined`/`null` = el IVA por defecto del concepto del maestro (o sí). */
  aplicaIva?: boolean | null;
  detalle?: string;
  siigoCodigo?: string | null;
  /** Código del maestro de conceptos. */
  concepto?: string;
};

export async function cotizacionDeTramite(
  tramiteId: string,
  opciones: { fecha?: Date } = {},
): Promise<CotizacionDto> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      id: true,
      consecutivo: true,
      ciudad: true,
      clienteId: true,
      doCliente: true,
      proveedorCliente: true,
      referenciaExterna: true,
      ordenCompraNumero: true,
      ordenCompraValor: true,
      valorServicio: true,
      conceptoServicioCodigo: true,
      agenciaAduanas: true,
      cliente: { select: { id: true, nombre: true, nit: true, contactoNombre: true, ciudad: true } },
      tipoTramite: { select: { flujoCorto: true, lineaServicio: true } },
    },
  });
  if (!tramite) throw new TramiteCotizacionNoEncontradoError();

  // Misma condición que la factura: la cuenta por conceptos e IVA es la del formato CONCEPTOS_IVA.
  const formato = await formatoFacturaDeEmpresa(tramite.clienteId);
  if (formato.formato !== FORMATO_CONCEPTOS_IVA) {
    throw new CotizacionIncompletaError(
      `${tramite.cliente.nombre} factura con el formato de comisión: no tiene cotización por conceptos e IVA. Activa «Factura con conceptos e IVA» en su ficha si debe tenerla.`,
    );
  }

  const fecha = opciones.fecha ?? fechaCalendarioBogota();
  let fuente: CotizacionDto["fuente"] = "TARIFA";
  let tarifario: CotizacionDto["tarifario"] = null;
  let lineas: LineaOrigen[] = [];

  if (tramite.tipoTramite.flujoCorto) {
    // «Otros»: lo mismo que facturaría `generarBorrador` (valor a mano manda; si no, su tarifa).
    const facturable = await resolverFacturableFlujoCorto(
      {
        clienteId: tramite.clienteId,
        valorServicio: tramite.valorServicio,
        conceptoServicioCodigo: tramite.conceptoServicioCodigo,
        tipoTramite: tramite.tipoTramite,
      },
      tramiteId,
    );
    if (!facturable || !facturable.ok) {
      const error = facturable && !facturable.ok ? facturable.error : null;
      throw new CotizacionIncompletaError(
        error?.message ?? "No hay con qué armar la cotización de este servicio.",
        error instanceof TarifaIncompletaError ? error.pendientes : [],
      );
    }
    if (facturable.modo === "VALOR") {
      fuente = "VALOR";
      lineas = [
        {
          nombrePublico: "SERVICIO",
          valor: tramite.valorServicio!,
          concepto: tramite.conceptoServicioCodigo!,
        },
      ];
    } else {
      const { tarifario: t, resultado } = facturable.propuesta;
      tarifario = { id: t!.id, nombre: t!.nombre, version: t!.version };
      lineas = resultado!.lineas.map((l) => ({ ...l }));
    }
  } else {
    const propuesta = await propuestaParaTramite(tramiteId, fecha);
    if (!propuesta.tarifario || !propuesta.resultado) {
      throw new CotizacionIncompletaError(
        `No hay tarifa para cotizar: ${propuesta.motivo ?? "la empresa no tiene un tarifario vigente"}.`,
      );
    }
    if (propuesta.resultado.pendientes.length > 0) {
      throw new CotizacionIncompletaError(
        new TarifaIncompletaError(propuesta.resultado.pendientes).message,
        propuesta.resultado.pendientes,
      );
    }
    if (propuesta.resultado.lineas.length === 0) {
      throw new CotizacionIncompletaError(
        `El tarifario ${propuesta.tarifario.nombre} v${propuesta.tarifario.version} no propone líneas para este trámite: completa su base de cálculo o los eventos.`,
      );
    }
    tarifario = {
      id: propuesta.tarifario.id,
      nombre: propuesta.tarifario.nombre,
      version: propuesta.tarifario.version,
    };
    lineas = propuesta.resultado.lineas.map((l) => ({ ...l }));
  }

  const codigosSiigo = lineas.map((l) => l.siigoCodigo).filter((c): c is string => Boolean(c));
  const [productos, maestro, params, capacidades, tercerosCrudos, agenciamiento] = await Promise.all([
    codigosSiigo.length > 0
      ? prisma.siigoProducto
          .findMany({ where: { codigo: { in: codigosSiigo } }, select: { id: true, codigo: true, nombre: true } })
          .then((filas) => new Map(filas.map((p) => [p.codigo, p])))
      : Promise.resolve(new Map<string, { id: string; codigo: string; nombre: string }>()),
    conceptosParaLineas(lineas.map((l) => l.concepto ?? "")),
    getParametrosSistema(),
    capacidadesDeEmpresa(tramite.clienteId),
    // Los terceros que la factura llevaría: facturas de proveedor que se cobran y aún no van en una aprobada/facturada.
    lineasTercerosDesdeFacturas(prisma, tramiteId),
    agenciamientoEstandarDe(tramite.agenciaAduanas),
  ]);

  // El mismo nombre y el mismo IVA que tendrá la línea de la factura (regla de nombre del catálogo).
  const conceptos: ConceptoCotizacion[] = lineas.map((l) => {
    const resuelta = resolverLineaConcepto({
      nombrePublico: l.nombrePublico,
      productoDelItem: l.siigoCodigo ? (productos.get(l.siigoCodigo) ?? null) : null,
      concepto: l.concepto ? (maestro.get(l.concepto) ?? null) : null,
      aplicaIvaItem: l.aplicaIva ?? null,
    });
    return {
      // Solo las líneas del maestro adoptan el nombre del catálogo (igual que `generarBorrador`).
      concepto: l.concepto ? resuelta.nombre : l.nombrePublico,
      detalle: l.detalle ?? null,
      valor: l.valor,
      aplicaIva: resuelta.aplicaIva,
    };
  });

  const resultado = armarCotizacion({
    conceptos,
    terceros: tercerosCrudos.map((t) => ({
      concepto: t.concepto,
      valor: BigInt(t.valor),
      numSoporte: t.numSoporte ?? null,
    })),
    tasaIva: params.tasaIva,
    tasa4x1000: params.tasa4x1000,
    reteIvaPorcentaje: formato.reteIvaPorcentaje,
    configOc: configOrdenCompraDe(configDe(capacidades, CAPACIDAD_OC)),
    // INTEG-B DUDA: la nota sale con CUALQUIER agencia que tenga agenciamiento estándar (`AGENCIAMIENTO_<AGENCIA>`), aunque
    // la tarifa no reste ese valor (`restaAgenciamiento`). Es solo informativa (B9): no cambia ningún total.
    agenciamiento,
  });

  return {
    ...resultado,
    // Día calendario en Bogotá (00:00 UTC de ese día): el PDF imprime "Barranquilla, septiembre 29 de 2026".
    fecha,
    tramite: {
      id: tramite.id,
      consecutivo: tramite.consecutivo,
      ciudad: tramite.ciudad,
      doCliente: tramite.doCliente,
      proveedorCliente: tramite.proveedorCliente,
      referenciaExterna: tramite.referenciaExterna,
      ordenCompraNumero: tramite.ordenCompraNumero,
      ordenCompraValor: tramite.ordenCompraValor,
    },
    empresa: tramite.cliente,
    fuente,
    tarifario,
    usaOrdenCompra: tiene(capacidades, CAPACIDAD_OC),
    textoNotaAgencia: resultado.notaAgencia ? textoNotaAgencia(resultado.notaAgencia) : null,
  };
}
