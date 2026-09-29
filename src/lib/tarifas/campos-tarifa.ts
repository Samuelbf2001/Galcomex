/**
 * Qué le pide una tarifa al DO (B2, Diseño B, 29-sep-2026) — función PURA.
 *
 * Un DO de «Otros servicios» (flujo corto) no muestra la base de cálculo de una
 * importación (su tipo dice `camposBaseCalculo = []`): el panel solo debe pedir
 * lo que la tarifa de SU servicio necesita. Ej.: la nacionalización desde zona
 * franca pide CIF, tipo de carga, declaraciones, documentos, la inspección
 * (evento) y la agencia; una DUTA no pide CIF; Plan Vallejo (valor a mano) no
 * pide nada.
 *
 * Reglas (espejo de lo que hace el motor, `motor.ts`, al calcular cada ítem):
 *  - PORCENTAJE_MIN                → `valorCif` (+ `tipoCarga` si tiene mínimos).
 *  - POR_UNIDAD / POR_TRAMO / PRIMERO_MAS_ADICIONAL con disparador SIEMPRE →
 *    el campo de su unidad (CONTENEDOR → numContenedores, DECLARACION →
 *    numDeclaraciones, DOCUMENTO → numDocumentos, ITEM → numItems). Con
 *    disparador EVENTO la cantidad sale del evento, no de la base.
 *  - disparador EVENTO             → su `eventoCodigo`.
 *  - `restaAgenciamiento`          → `agencia: true` (resta lo que factura la agencia del DO).
 *  - MANUAL, FIJO y ESPEJO_DE_COSTO no piden datos del DO.
 */

import type { ItemTarifaCalculable, UnidadTarifa } from "./motor";

export type CampoBaseTarifa =
  | "valorCif"
  | "tipoCarga"
  | "numContenedores"
  | "numDeclaraciones"
  | "numDocumentos"
  | "numItems";

export interface CamposTarifa {
  /** Campos de la base de cálculo del DO que la tarifa necesita, en el orden de la pantalla. */
  base: CampoBaseTarifa[];
  /** Códigos de los eventos que la tarifa cobra. */
  eventos: string[];
  /** La tarifa resta el agenciamiento de la agencia de aduanas del DO: hay que escogerla. */
  agencia: boolean;
}

const ORDEN_BASE: readonly CampoBaseTarifa[] = [
  "valorCif",
  "tipoCarga",
  "numContenedores",
  "numDeclaraciones",
  "numDocumentos",
  "numItems",
];

const CAMPO_DE_UNIDAD: Partial<Record<UnidadTarifa, CampoBaseTarifa>> = {
  CONTENEDOR: "numContenedores",
  DECLARACION: "numDeclaraciones",
  DOCUMENTO: "numDocumentos",
  ITEM: "numItems",
};

export function camposQuePideTarifa(items: readonly ItemTarifaCalculable[]): CamposTarifa {
  const base = new Set<CampoBaseTarifa>();
  const eventos: string[] = [];
  let agencia = false;

  for (const item of items) {
    if (item.disparador === "MANUAL") continue;

    if (item.disparador === "EVENTO" && item.eventoCodigo && !eventos.includes(item.eventoCodigo)) {
      eventos.push(item.eventoCodigo);
    }

    if (item.restaAgenciamiento) agencia = true;

    switch (item.tipoCalculo) {
      case "PORCENTAJE_MIN":
        base.add("valorCif");
        if (item.minimos && Object.keys(item.minimos).length > 0) base.add("tipoCarga");
        break;
      case "POR_UNIDAD":
      case "POR_TRAMO":
      case "PRIMERO_MAS_ADICIONAL": {
        // Con evento, la cantidad es la del evento marcado: no se pide la base.
        if (item.disparador === "EVENTO") break;
        const campo = CAMPO_DE_UNIDAD[item.unidad];
        if (campo) base.add(campo);
        break;
      }
      default:
        break;
    }
  }

  return { base: ORDEN_BASE.filter((c) => base.has(c)), eventos, agencia };
}
