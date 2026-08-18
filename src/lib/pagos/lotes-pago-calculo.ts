/**
 * Lote de pago — agrupamiento de facturas por trámite y reparto del costo
 * bancario (reunión 1-jul-2026, 00:48–00:50: Karina paga la cartera del
 * puerto de una sola transacción bancaria que cubre facturas de VARIOS
 * trámites).
 *
 * Funciones PURAS, sin BD — el servicio (`lotes-pago-service.ts`) las usa
 * para decidir cuántos `PagoTramite` crear (uno por trámite involucrado,
 * nunca uno por factura) y cuánto va en cada uno. Se testean aisladas con
 * tolerancia 0 pesos porque de ellas depende que la suma de los
 * `PagoTramite` del lote cuadre exactamente con lo que Karina realmente
 * pagó, y que el costo bancario del desembolso único no se multiplique por
 * el número de trámites agrupados.
 */

// ─── Agrupamiento de facturas por trámite ──────────────────────────────────

export type FacturaLoteItem = {
  facturaProveedorId: string;
  /** Trámite dueño de la factura — SIEMPRE resuelto desde BD, nunca del input del cliente. */
  tramiteId: string;
  /** Monto pagado de esta factura en este lote (puede ser parcial). */
  valor: bigint;
};

export type GrupoTramite = {
  tramiteId: string;
  facturaIds: string[];
  /** Σ valor de las facturas del grupo — este es el `PagoTramite.valor` que se crea para el trámite. */
  valor: bigint;
};

/**
 * Agrupa las facturas seleccionadas por trámite, preservando el orden de
 * primera aparición de cada trámite en `items` (relevante para
 * `repartirCostoBancario`, que imputa el costo al primer grupo).
 *
 * Invariante: Σ(grupo.valor) para todos los grupos == Σ(item.valor) para
 * todos los items — no se pierde ni se duplica un peso (ver test
 * "conserva el total exacto").
 */
export function agruparFacturasPorTramite(items: FacturaLoteItem[]): GrupoTramite[] {
  const ordenTramites: string[] = [];
  const grupos = new Map<string, GrupoTramite>();

  for (const item of items) {
    let grupo = grupos.get(item.tramiteId);
    if (!grupo) {
      grupo = { tramiteId: item.tramiteId, facturaIds: [], valor: 0n };
      grupos.set(item.tramiteId, grupo);
      ordenTramites.push(item.tramiteId);
    }
    grupo.facturaIds.push(item.facturaProveedorId);
    grupo.valor += item.valor;
  }

  return ordenTramites.map((tramiteId) => {
    const grupo = grupos.get(tramiteId);
    if (!grupo) {
      throw new Error(`Inconsistencia interna: grupo ${tramiteId} no encontrado`);
    }
    return grupo;
  });
}

// ─── Reparto del costo bancario único del lote ─────────────────────────────

/**
 * El lote corresponde a UN SOLO desembolso bancario: Karina hace UNA
 * transferencia/pago que el banco cobra UNA vez, sin importar cuántos
 * trámites cubra. El costo bancario (tomado de `MatrizPago` según el canal)
 * se imputa COMPLETO al primer trámite del lote — el que aparece primero en
 * `tramiteIdsEnOrden` (por convención, el orden de `agruparFacturasPorTramite`,
 * es decir el trámite de la primera factura que Karina seleccionó). Los
 * demás trámites del lote llevan costoBancario = 0n.
 *
 * Es una decisión arbitraria pero determinística y documentada: lo único que
 * importa contablemente es que Σ costoBancario de los PagoTramite del lote
 * sea EXACTAMENTE el costo real cobrado una vez por el banco (nunca N veces),
 * y que quede en un solo PagoTramite trazable en vez de repartirse en
 * fracciones de peso que no significan nada por separado.
 */
export function repartirCostoBancario(
  tramiteIdsEnOrden: string[],
  costoBancarioTotal: bigint,
): Map<string, bigint> {
  const reparto = new Map<string, bigint>();
  tramiteIdsEnOrden.forEach((tramiteId, index) => {
    reparto.set(tramiteId, index === 0 ? costoBancarioTotal : 0n);
  });
  return reparto;
}
