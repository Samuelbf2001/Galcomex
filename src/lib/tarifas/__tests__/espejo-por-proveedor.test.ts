/**
 * B6 (Diseño B, 29-sep-2026) — registro VUCE: «el mayor entre el mínimo y lo
 * pagado», una línea por cada registro. Casos dorados E1–E8 y E10 de
 * `simulacion-camila-27sep/DISENO-B.md` §1.3, al peso. Puros (sin BD).
 *
 * Los pesos van con `$` (BigInt) y nunca se pasan por `.toString()`.
 */
import { describe, expect, it } from "vitest";

import { espejarPorProveedor, type CostoProveedor } from "../espejo-por-proveedor";
import { calcularLineasTarifa, type ContextoTarifa, type ItemTarifaCalculable } from "../motor";

const $ = (n: number) => BigInt(n);

const NIT_MINCIT = "830115297";
const MINCIT = `NIT:${NIT_MINCIT}`;
const INVIMA = "NIT:860075000";

/** DO.CTG26-0148 (FV-2-18521): las 4 facturas de la VUCE traen el producto Siigo 24. */
const CTG0148: CostoProveedor[] = [
  { valor: $(83_800), proveedorClave: MINCIT, productoCodigo: "24", referencia: "491991075" },
  { valor: $(46_260), proveedorClave: INVIMA, productoCodigo: "24", referencia: "64443853" },
  { valor: $(832_680), proveedorClave: INVIMA, productoCodigo: "24", referencia: "611057037" },
  { valor: $(419_000), proveedorClave: MINCIT, productoCodigo: "24", referencia: "639483296" },
];

const base = { nitProveedor: NIT_MINCIT, producto: "24", nombreItem: "ELABORACION REGISTRO" };

describe("espejarPorProveedor — casos dorados", () => {
  it("E1 — Sesderma CTG DO.CTG26-0148: 150.000 + 419.000; el INVIMA no entra", () => {
    const r = espejarPorProveedor({ ...base, minimo: $(150_000), costos: CTG0148, cantidadEvento: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lineas.map((l) => l.valor)).toEqual([$(150_000), $(419_000)]);
    expect(r.lineas[0]!.detalle).toBe("Pago 491991075 83.800; se cobra el mínimo 150.000");
    expect(r.lineas[1]!.detalle).toBe("Igual a lo pagado 639483296 419.000");
  });

  it("E2 — Sesderma BGT DO.BGT26-0157: un registro de 293.300 (el INVIMA de 555.120 no cuenta)", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [
        { valor: $(293_300), proveedorClave: MINCIT, productoCodigo: "24", referencia: "A1" },
        { valor: $(555_120), proveedorClave: INVIMA, productoCodigo: "24", referencia: "B1" },
      ],
      cantidadEvento: 1,
    });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(293_300)]);
  });

  it("E3 — DO.BGT26-0216: un pago de 41.900 → se cobra el mínimo 150.000", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(41_900), proveedorClave: MINCIT, productoCodigo: "24", referencia: "C1" }],
      cantidadEvento: 1,
    });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(150_000)]);
  });

  it("E4 — CW DO.CTG26-0021: mínimo 280.000 y pago de 460.900 → 460.900", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(280_000),
      costos: [{ valor: $(460_900), proveedorClave: MINCIT, productoCodigo: "24", referencia: "REG-50022494" }],
      cantidadEvento: 1,
    });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(460_900)]);
  });

  it("E5 — CW con dos registros (83.800 y 550.000): 280.000 + 550.000 = 830.000", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(280_000),
      costos: [
        { valor: $(83_800), proveedorClave: MINCIT, productoCodigo: "24", referencia: "R1" },
        { valor: $(550_000), proveedorClave: MINCIT, productoCodigo: "24", referencia: "R2" },
      ],
      cantidadEvento: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lineas.map((l) => l.valor)).toEqual([$(280_000), $(550_000)]);
    expect(r.lineas.reduce((a, l) => a + l.valor, 0n)).toBe($(830_000));
  });

  it("E6 — evento marcado y ninguna factura del proveedor → pendiente COSTO_PROVEEDOR", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(46_260), proveedorClave: INVIMA, productoCodigo: "24", referencia: "64443853" }],
      cantidadEvento: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.causa).toBe("COSTO_PROVEEDOR");
    expect(r.motivo).toContain("Marcaste «ELABORACION REGISTRO»");
    expect(r.motivo).toContain("NIT 830115297");
  });

  it("E7 — evento ×2 con un solo pago → pendiente por conteo, nunca cobra a medias", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(83_800), proveedorClave: MINCIT, productoCodigo: "24", referencia: "491991075" }],
      cantidadEvento: 2,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain("Marcaste 2 registros");
    expect(r.motivo).toContain("hay 1 pago");
    expect(r.motivo).toContain("491991075");
  });

  it("E7b — evento ×1 con dos pagos → pendiente por conteo", () => {
    const r = espejarPorProveedor({ ...base, minimo: $(150_000), costos: CTG0148, cantidadEvento: 1 });
    expect(r.ok).toBe(false);
  });

  it("E8 — disparador SIEMPRE sin registro (CW DO.CTG26-0198): sin línea y sin pendiente", () => {
    const r = espejarPorProveedor({ ...base, minimo: $(280_000), costos: [], cantidadEvento: null });
    expect(r).toEqual({ ok: true, lineas: [] });
  });

  it("SIEMPRE con registros: una línea por cada pago del proveedor", () => {
    const r = espejarPorProveedor({ ...base, minimo: $(280_000), costos: CTG0148, cantidadEvento: null });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(280_000), $(419_000)]);
  });
});

describe("espejarPorProveedor — filtros y bordes", () => {
  it("solo por producto (sin NIT) toma todas las facturas de ese producto, en el orden recibido", () => {
    const r = espejarPorProveedor({ ...base, nitProveedor: null, minimo: $(0), costos: CTG0148, cantidadEvento: 4 });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(83_800), $(46_260), $(832_680), $(419_000)]);
  });

  it("solo por NIT (sin producto) ignora el producto de la factura", () => {
    const r = espejarPorProveedor({
      ...base,
      producto: null,
      minimo: $(150_000),
      costos: [
        { valor: $(200_000), proveedorClave: MINCIT, productoCodigo: null, referencia: "X1" },
        { valor: $(10_000), proveedorClave: MINCIT, productoCodigo: "99", referencia: "X2" },
      ],
      cantidadEvento: 2,
    });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(200_000), $(150_000)]);
  });

  it("con NIT y producto exige los dos: una factura del NIT con otro producto no entra", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(200_000), proveedorClave: MINCIT, productoCodigo: "31", referencia: "X1" }],
      cantidadEvento: null,
    });
    expect(r).toEqual({ ok: true, lineas: [] });
  });

  it("un beneficiario sin NIT colombiano (BEN:…) no se confunde con el NIT", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(200_000), proveedorClave: "BEN:abc", productoCodigo: "24", referencia: "X1" }],
      cantidadEvento: null,
    });
    expect(r).toEqual({ ok: true, lineas: [] });
  });

  it("mínimo 0 = espejo puro: cada pago tal cual", () => {
    const r = espejarPorProveedor({ ...base, minimo: $(0), costos: CTG0148, cantidadEvento: 2 });
    expect(r.ok && r.lineas.map((l) => l.valor)).toEqual([$(83_800), $(419_000)]);
    expect(r.ok && r.lineas[0]!.detalle).toBe("Igual a lo pagado 491991075 83.800");
  });

  it("un pago igual al mínimo se rotula «igual a lo pagado»", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(150_000),
      costos: [{ valor: $(150_000), proveedorClave: MINCIT, productoCodigo: "24", referencia: "Z" }],
      cantidadEvento: 1,
    });
    expect(r.ok && r.lineas[0]!.detalle).toBe("Igual a lo pagado Z 150.000");
  });

  it("pago en cero y sin mínimo no genera una línea en cero", () => {
    const r = espejarPorProveedor({
      ...base,
      minimo: $(0),
      costos: [{ valor: $(0), proveedorClave: MINCIT, productoCodigo: "24", referencia: "Z" }],
      cantidadEvento: 1,
    });
    expect(r).toEqual({ ok: true, lineas: [] });
  });
});

// ─── Dentro del motor ─────────────────────────────────────────────────────────

function itemRegistro(over: Partial<ItemTarifaCalculable> = {}): ItemTarifaCalculable {
  return {
    concepto: "ELABORACION_REGISTRO",
    nombrePublico: "ELABORACION REGISTRO",
    siigoCodigo: "010",
    tipoCalculo: "ESPEJO_DE_COSTO",
    disparador: "EVENTO",
    eventoCodigo: "ELABORACION_REGISTRO",
    unidad: "TRAMITE",
    valor: $(150_000),
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    nitProveedorCosto: NIT_MINCIT,
    productoCosto: "24",
    tramos: null,
    aplicaIva: true,
    orden: 70,
    ...over,
  };
}

function ctx(costos: ContextoTarifa["costos"], cantidad: number): ContextoTarifa {
  return {
    valorCif: null,
    tipoCarga: null,
    numContenedores: null,
    numDeclaraciones: null,
    numDocumentos: null,
    numItems: null,
    eventos: [{ codigo: "ELABORACION_REGISTRO", cantidad }],
    costos,
  };
}

describe("calcularLineasTarifa — ítem ESPEJO_DE_COSTO por proveedor", () => {
  const costosCtg = CTG0148.map((c) => ({
    concepto: "PAGO VUCE REG IMP",
    valor: c.valor,
    proveedorClave: c.proveedorClave,
    productoCodigo: c.productoCodigo,
    referencia: c.referencia,
  }));

  it("E1 — dos líneas del mismo concepto (150.000 y 419.000), con IVA y origen EVENTO", () => {
    const r = calcularLineasTarifa([itemRegistro()], ctx(costosCtg, 2));
    expect(r.pendientes).toEqual([]);
    expect(r.lineas).toHaveLength(2);
    expect(r.lineas.map((l) => l.valor)).toEqual([$(150_000), $(419_000)]);
    expect(r.lineas.map((l) => l.valorUnitario)).toEqual([$(150_000), $(419_000)]);
    expect(r.lineas.every((l) => l.cantidad === 1 && l.aplicaIva && l.origen === "EVENTO" && l.siigoCodigo === "010")).toBe(true);
    expect(r.lineas.every((l) => l.concepto === "ELABORACION_REGISTRO")).toBe(true);
    expect(r.total).toBe($(569_000));
  });

  it("E6 — sin factura del Ministerio queda pendiente COSTO_PROVEEDOR y no hay líneas", () => {
    const r = calcularLineasTarifa([itemRegistro()], ctx([], 1));
    expect(r.lineas).toEqual([]);
    expect(r.pendientes).toHaveLength(1);
    expect(r.pendientes[0]!.causa).toBe("COSTO_PROVEEDOR");
  });

  it("los pagos del libro (sin proveedor ni producto) no entran a este modo", () => {
    const r = calcularLineasTarifa(
      [itemRegistro()],
      ctx([{ concepto: "PAGO VUCE REGISTRO", valor: $(419_000) }], 1),
    );
    expect(r.lineas).toEqual([]);
    expect(r.pendientes[0]!.causa).toBe("COSTO_PROVEEDOR");
  });

  it("E8 — disparador SIEMPRE sin registro: sin línea ni pendiente", () => {
    const item = itemRegistro({ disparador: "SIEMPRE", eventoCodigo: null, valor: $(280_000) });
    const r = calcularLineasTarifa([item], { ...ctx([], 1), eventos: [] });
    expect(r.lineas).toEqual([]);
    expect(r.pendientes).toEqual([]);
  });

  it("E10 — el espejo viejo (solo conceptoCosto) sigue tomando el primer costo que contiene el texto", () => {
    const viejo = itemRegistro({
      nitProveedorCosto: null,
      productoCosto: null,
      conceptoCosto: "registro",
      valor: $(0),
      disparador: "SIEMPRE",
      eventoCodigo: null,
    });
    const r = calcularLineasTarifa(
      [viejo],
      { ...ctx([{ concepto: "PAGO REGISTRO VUCE", valor: $(419_000) }, { concepto: "PAGO REGISTRO 2", valor: $(83_800) }], 1), eventos: [] },
    );
    expect(r.pendientes).toEqual([]);
    expect(r.lineas.map((l) => l.valor)).toEqual([$(419_000)]);
    expect(r.lineas[0]!.detalle).toBe('Espejo de "PAGO REGISTRO VUCE"');
  });

  it("E10 — un FIJO con evento (Litoplas, 433.000 × cantidad) no cambia", () => {
    const fijo = itemRegistro({
      tipoCalculo: "FIJO",
      nitProveedorCosto: null,
      productoCosto: null,
      valor: $(433_000),
    });
    const r = calcularLineasTarifa([fijo], ctx([], 2));
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0]!.valor).toBe($(866_000));
    expect(r.lineas[0]!.cantidad).toBe(2);
  });
});
