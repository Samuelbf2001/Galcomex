/**
 * validaciones.ts — cálculo puro de cruce POR PROVEEDOR/BENEFICIARIO entre
 * facturas de proveedor y pagos del trámite, más detección de pagos sueltos
 * (sin ninguna factura de proveedor vinculada).
 *
 * Complementa a cruce-facturas.ts (que cruza pago↔línea de factura de venta
 * por FacturaProveedor individual). Este módulo agrega POR PROVEEDOR y no
 * depende de las líneas del borrador: compara directamente
 * Σ FacturaProveedor.valor vs Σ PagoTramite.valor vinculados vía
 * PagoTramiteFactura, para que el revisor vea de un vistazo qué proveedor
 * cuadra y cuál no, y qué pagos quedaron sin soporte de factura.
 *
 * Función pura, sin BD; recibe los datos ya leídos por el endpoint.
 *
 * Fase centavos: montos en CENTAVOS (`bigint`) de entrada y de salida (la API
 * los emite como pesos texto con 2 decimales). Los ajustes `REDONDEO` de una
 * factura re-expresada a sus centavos reales cuentan como pagado (D-8), con
 * nota, igual que en `cruce-facturas.ts`.
 */

import type { Centavos } from "@/lib/dinero";

import { notaRedondeo } from "./cruce-facturas";

export type FacturaProveedorParaValidacion = {
  id: string;
  /** Clave de agrupación: beneficiarioId si existe, si no un fallback estable por nombre. */
  proveedorId: string;
  proveedorNombre: string;
  /** Centavos. */
  valor: Centavos;
};

/** Un pago vinculado a una factura de proveedor (vía pivot PagoTramiteFactura). */
export type PagoVinculadoParaValidacion = {
  facturaId: string;
  /** Centavos. */
  valor: Centavos;
};

/** Ajuste REDONDEO de una factura (D-8): cuenta como pagado. Centavos, > 0. */
export type AjusteRedondeoParaValidacion = {
  facturaId: string;
  monto: Centavos;
};

/** Un pago del trámite que NO está vinculado a ninguna factura de proveedor. */
export type PagoSueltoParaValidacion = {
  pagoId: string;
  concepto: string;
  numSoporte: string | null;
  /** Centavos. */
  valor: Centavos;
};

export type ValidacionProveedor = {
  proveedorId: string;
  proveedorNombre: string;
  /** Centavos. */
  totalFacturas: Centavos;
  /** Centavos: Σ pagos vinculados + Σ ajustes REDONDEO (D-8). */
  totalPagos: Centavos;
  /** Centavos: totalFacturas − totalPagos. Positivo = facturado más de lo pagado. */
  diferencia: Centavos;
  /** Centavos: parte de `totalPagos` que viene de ajustes REDONDEO. */
  redondeo: Centavos;
  /** «incluye redondeo de $0,45» cuando hay REDONDEO; si no, null. */
  nota: string | null;
  /** true cuando diferencia === 0 */
  cuadra: boolean;
};

export type PagoSueltoRow = {
  pagoId: string;
  concepto: string;
  numSoporte: string | null;
  /** Centavos. */
  valor: Centavos;
};

export type ValidacionesCruce = {
  proveedores: ValidacionProveedor[];
  pagosSueltos: PagoSueltoRow[];
};

/**
 * Calcula, por cada proveedor/beneficiario presente en `facturas`, la suma de
 * facturas vs la suma de pagos vinculados a esas facturas — y separa los
 * pagos sin ninguna factura vinculada (`pagosSueltosInput`) para que el
 * revisor los vea con la nota "sin factura vinculada".
 */
export function calcularValidacionesCruce(
  facturas: FacturaProveedorParaValidacion[],
  pagosVinculados: PagoVinculadoParaValidacion[],
  pagosSueltosInput: PagoSueltoParaValidacion[],
  ajustesRedondeo: AjusteRedondeoParaValidacion[] = [],
): ValidacionesCruce {
  // Σ facturas por proveedor, preservando el orden de primera aparición.
  const ordenProveedores: string[] = [];
  const totalFacturasPorProveedor = new Map<string, bigint>();
  const nombrePorProveedor = new Map<string, string>();
  const facturaToProveedor = new Map<string, string>();

  for (const f of facturas) {
    if (!totalFacturasPorProveedor.has(f.proveedorId)) {
      ordenProveedores.push(f.proveedorId);
      nombrePorProveedor.set(f.proveedorId, f.proveedorNombre);
    }
    totalFacturasPorProveedor.set(
      f.proveedorId,
      (totalFacturasPorProveedor.get(f.proveedorId) ?? 0n) + f.valor,
    );
    facturaToProveedor.set(f.id, f.proveedorId);
  }

  // Σ pagos vinculados por proveedor (a través de la factura a la que apunta cada pago).
  const totalPagosPorProveedor = new Map<string, bigint>();
  for (const p of pagosVinculados) {
    const proveedorId = facturaToProveedor.get(p.facturaId);
    if (!proveedorId) continue; // pago vinculado a una factura fuera del set recibido
    totalPagosPorProveedor.set(
      proveedorId,
      (totalPagosPorProveedor.get(proveedorId) ?? 0n) + p.valor,
    );
  }

  // Σ ajustes REDONDEO por proveedor (D-8).
  const redondeoPorProveedor = new Map<string, bigint>();
  for (const a of ajustesRedondeo) {
    const proveedorId = facturaToProveedor.get(a.facturaId);
    if (!proveedorId) continue;
    redondeoPorProveedor.set(proveedorId, (redondeoPorProveedor.get(proveedorId) ?? 0n) + a.monto);
  }

  const proveedores: ValidacionProveedor[] = ordenProveedores.map((proveedorId) => {
    const totalFacturas = totalFacturasPorProveedor.get(proveedorId) ?? 0n;
    const redondeo = redondeoPorProveedor.get(proveedorId) ?? 0n;
    const totalPagos = (totalPagosPorProveedor.get(proveedorId) ?? 0n) + redondeo;
    const diferencia = totalFacturas - totalPagos;
    return {
      proveedorId,
      proveedorNombre: nombrePorProveedor.get(proveedorId) ?? "",
      totalFacturas,
      totalPagos,
      diferencia,
      redondeo,
      nota: notaRedondeo(redondeo),
      cuadra: diferencia === 0n,
    };
  });

  const pagosSueltos: PagoSueltoRow[] = pagosSueltosInput.map((p) => ({
    pagoId: p.pagoId,
    concepto: p.concepto,
    numSoporte: p.numSoporte,
    valor: p.valor,
  }));

  return { proveedores, pagosSueltos };
}
