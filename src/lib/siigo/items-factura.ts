/**
 * Arma los ítems de la factura de venta que se envía a Siigo desde las líneas
 * del borrador. Función pura (sin BD) para poder probarla contra facturas reales.
 *
 * Formato "COMISION" (Lucho, histórico): cada línea con valor es un ítem sin
 * `taxes`; el IVA viaja como su propia línea IVA_COMISION.
 *
 * Formato "CONCEPTOS_IVA" (Galcomex propio, verificado contra BAQ-18385): la
 * línea IVA_COMISION NO se envía; cada ingreso propio con `aplicaIva` lleva
 * `taxes: [{ id: <IVA 19 %> }]` y Siigo liquida el IVA por ítem. La ReteIVA va a
 * nivel de factura (`retentions`), fuera de este armador.
 *
 * Tercero de cada ítem: IMPUESTO_4X1000 → banco del GMF; TERCEROS sin tipoFija →
 * NIT manual, del beneficiario o del proveedor de la factura vinculada.
 *
 * Dinero (fase centavos): las líneas traen CENTAVOS (`bigint`); Siigo recibe
 * PESOS con decimales (`price: 502801.45`) vía `numeroDeCentavos` del núcleo.
 * `verificarCuadreSiigo` es la comprobación que corta el envío si
 * Σ ítems + IVA − retenciones ≠ `payments.value` (al centavo).
 */

import {
  centavosDeNumero,
  enteroNoDinero,
  formatoPesos,
  numeroDeCentavos,
  porcentajeDe,
  type Centavos,
} from "@/lib/dinero";

import { PRECISION_IVA } from "@/lib/calculations/factura-conceptos";

import type { SiigoFacturaItemDto, SiigoFacturaPostDto } from "./client";

export interface LineaParaSiigo {
  concepto: string;
  /** Valor de la línea en centavos de COP. */
  valorCentavos: bigint;
  orden: number;
  seccion: "TERCEROS" | "OPERACIONAL";
  tipoFija: string | null;
  aplicaIva: boolean;
  productoCodigo: string | null;
  /** NIT ya resuelto (manual → beneficiario → proveedor); null si no hay. */
  nitTercero: string | null;
  /**
   * Id del IVA que el propio producto Siigo tiene configurado, cuando su
   * porcentaje coincide con el que liquidó el motor (`ivaDelProducto`). Manda
   * sobre el IVA global: Siigo rechaza impuestos que no estén asociados al
   * producto. `null`/ausente → se usa `opciones.ivaTaxId` (comportamiento
   * histórico, casos dorados intactos).
   */
  ivaProductoId?: number | null;
}

export interface OpcionesItemsSiigo {
  formato: string;
  /** Id Siigo del IVA para los ítems gravados (solo CONCEPTOS_IVA). */
  ivaTaxId: number | null;
  nit4x1000: string;
}

/** Identificación como la espera Siigo: solo dígitos, sin dígito de verificación ("800.154.017-8" → "800154017"). */
export function identificacionSiigo(nit: string): string {
  return nit.split("-")[0]!.replace(/\D/g, "");
}

const PESO_SECCION = { TERCEROS: 0, OPERACIONAL: 1 } as const;

/** Líneas que viajan como ítem en el formato dado (valor > 0 y, en CONCEPTOS_IVA, sin la línea de IVA). */
export function lineasQueVanComoItem<T extends Pick<LineaParaSiigo, "valorCentavos" | "tipoFija">>(
  lineas: T[],
  formato: string,
): T[] {
  return lineas.filter(
    (l) => l.valorCentavos > 0n && !(formato === "CONCEPTOS_IVA" && l.tipoFija === "IVA_COMISION"),
  );
}

export function construirItemsSiigo(
  lineas: LineaParaSiigo[],
  opciones: OpcionesItemsSiigo,
): SiigoFacturaItemDto[] {
  const conIvaPorItem = opciones.formato === "CONCEPTOS_IVA";
  if (
    conIvaPorItem &&
    opciones.ivaTaxId === null &&
    lineas.some((l) => l.aplicaIva && !l.ivaProductoId)
  ) {
    throw new Error("Falta el impuesto IVA de Siigo para los ítems gravados");
  }

  return lineasQueVanComoItem(lineas, opciones.formato)
    .sort((a, b) => {
      const peso = PESO_SECCION[a.seccion] - PESO_SECCION[b.seccion];
      return peso !== 0 ? peso : a.orden - b.orden;
    })
    .map((l) => {
      if (!l.productoCodigo) {
        throw new Error(`La línea "${l.concepto}" no tiene producto Siigo`);
      }
      let customerNit: string | null = null;
      if (l.tipoFija === "IMPUESTO_4X1000") {
        customerNit = opciones.nit4x1000;
      } else if (l.seccion === "TERCEROS" && !l.tipoFija) {
        customerNit = l.nitTercero;
      }
      const gravado = conIvaPorItem && l.aplicaIva && l.seccion === "OPERACIONAL" && !l.tipoFija;
      // `aplicaIva` decide SI la línea lleva IVA (es lo que liquidó el motor y
      // lo que sostiene `payments.value`); el producto decide CUÁL id se manda.
      const ivaId = gravado ? (l.ivaProductoId ?? opciones.ivaTaxId) : null;

      return {
        code: l.productoCodigo,
        description: l.concepto,
        quantity: 1,
        // Pesos con decimales (502801.45): Siigo acepta 2 decimales en `price`.
        price: numeroDeCentavos(l.valorCentavos),
        ...(ivaId !== null ? { taxes: [{ id: ivaId }] } : {}),
        ...(customerNit
          ? { customer: { identification: identificacionSiigo(customerNit), branch_office: 0 } }
          : {}),
      };
    });
}

// ─── Invariante de cuadre (comprobación que corta el envío) ──────────────────

/**
 * Precisión con la que se calcula el IVA por ítem al comprobar el cuadre.
 * D-1 (corregida por evidencia, 2026-09-24): AL CENTAVO, como liquida Siigo.
 * Es la MISMA constante del motor (`calculations/factura-conceptos.ts`), así
 * el borrador y la comprobación no pueden divergir.
 */
export const PRECISION_IVA_SIIGO = PRECISION_IVA;

export interface CuadreSiigo {
  ok: boolean;
  /** Σ price × quantity de los ítems, en centavos. */
  subtotalCentavos: Centavos;
  /** IVA de los ítems con `taxes`, calculado por nosotros (PRECISION_IVA_SIIGO). */
  ivaCentavos: Centavos;
  /** Retenciones que viajan en `retentions` (0 si no viaja ninguna). */
  retencionesCentavos: Centavos;
  /** subtotal + IVA − retenciones: lo que Siigo liquidará. */
  esperadoCentavos: Centavos;
  /** Σ `payments[].value`, en centavos. */
  pagosCentavos: Centavos;
  /** pagos − esperado. */
  diferenciaCentavos: Centavos;
}

/**
 * Comprueba, sobre el payload EXACTO que se va a mandar, que
 *   Σ ítems (+ IVA de los ítems gravados − retenciones) = Σ payments.value
 * al centavo. Pura: no toca BD ni red.
 *
 * - Ítems y pagos se leen de vuelta desde los `number` del payload con
 *   `centavosDeNumero` (un precio con más de 2 decimales lanza).
 * - El IVA se calcula por ítem con `porcentajeDe(price, tasaIva, 100)` a la
 *   precisión de D-1; un ítem con `taxes` sin `tasaIva` es error.
 * - Las retenciones solo cuentan si el payload las manda (`retentions`); en el
 *   formato COMISION no viajan y por tanto Siigo no las descuenta del total.
 */
export function verificarCuadreSiigo(
  dto: Pick<SiigoFacturaPostDto, "items" | "payments" | "retentions">,
  opciones: { tasaIva: bigint | null; retencionesCentavos: Centavos },
): CuadreSiigo {
  let subtotalCentavos = 0n;
  let ivaCentavos = 0n;
  for (const item of dto.items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Cantidad inválida en el ítem "${item.description}"`);
    }
    const valor = centavosDeNumero(item.price) * enteroNoDinero(item.quantity);
    subtotalCentavos += valor;
    if (item.taxes && item.taxes.length > 0) {
      if (opciones.tasaIva === null) {
        throw new Error(`El ítem "${item.description}" lleva IVA pero no se conoce la tasa`);
      }
      ivaCentavos += porcentajeDe(valor, opciones.tasaIva, 100n, { precision: PRECISION_IVA_SIIGO });
    }
  }
  const retencionesCentavos =
    dto.retentions && dto.retentions.length > 0 ? opciones.retencionesCentavos : 0n;
  const pagosCentavos = dto.payments.reduce((s, p) => s + centavosDeNumero(p.value), 0n);
  const esperadoCentavos = subtotalCentavos + ivaCentavos - retencionesCentavos;
  const diferenciaCentavos = pagosCentavos - esperadoCentavos;
  return {
    ok: diferenciaCentavos === 0n,
    subtotalCentavos,
    ivaCentavos,
    retencionesCentavos,
    esperadoCentavos,
    pagosCentavos,
    diferenciaCentavos,
  };
}

/**
 * Mensaje para la persona cuando el cuadre falla (montos con ",00", como en la
 * factura). `retencionesNoEnviadas` > 0 explica el caso COMISION con retenciones.
 */
export function mensajeCuadreSiigo(c: CuadreSiigo, retencionesNoEnviadas: Centavos = 0n): string {
  const f = (v: Centavos) => formatoPesos(v, { decimales: "siempre" });
  const partes = [
    `La factura no cuadra para SIIGO y no se envió: ítems ${f(c.subtotalCentavos)}`,
    c.ivaCentavos !== 0n ? ` + IVA ${f(c.ivaCentavos)}` : "",
    c.retencionesCentavos !== 0n ? ` − retenciones ${f(c.retencionesCentavos)}` : "",
    ` = ${f(c.esperadoCentavos)}, pero el total a pagar es ${f(c.pagosCentavos)}`,
    ` (diferencia ${f(c.diferenciaCentavos)}).`,
  ];
  if (retencionesNoEnviadas !== 0n) {
    partes.push(
      ` Las retenciones de ${f(retencionesNoEnviadas)} no viajan a SIIGO en este formato de factura.`,
    );
  }
  partes.push(" Revisa las líneas del borrador (valores negativos, IVA o retenciones) antes de reintentar.");
  return partes.join("");
}
