import { describe, expect, it } from "vitest";

import { pesos } from "@/lib/dinero";
import { $ } from "@/lib/dinero/test-utils";

import type { SiigoFacturaPostDto } from "../client";
import {
  construirItemsSiigo,
  identificacionSiigo,
  mensajeCuadreSiigo,
  PRECISION_IVA_SIIGO,
  verificarCuadreSiigo,
  type LineaParaSiigo,
} from "../items-factura";

const IVA_19 = 1564;
const OCCIDENTE = "890300279";

function linea(parcial: Partial<LineaParaSiigo> & Pick<LineaParaSiigo, "concepto" | "valorCentavos">): LineaParaSiigo {
  return {
    orden: 1,
    seccion: "OPERACIONAL",
    tipoFija: null,
    aplicaIva: false,
    productoCodigo: "007",
    nitTercero: null,
    ...parcial,
  };
}

/**
 * Borrador CONCEPTOS_IVA equivalente a la factura real BAQ-18385 (Litoplas,
 * DO.26-0069), con los centavos reales de los terceros (fase centavos):
 * Almacarga 502.801,45 (la real de Siigo trae Tampa en 486.075, sin centavos).
 */
const BAQ_18385: LineaParaSiigo[] = [
  linea({ concepto: "SERV COORDINACION EN DESPACHO", valorCentavos: pesos(200_000), orden: 100, aplicaIva: true, productoCodigo: "006" }),
  linea({ concepto: "REVISION DOCUMENTAL", valorCentavos: pesos(20_000), orden: 101, aplicaIva: true, productoCodigo: "002" }),
  linea({ concepto: "SISTEMATIZACION DE ARCHIVOS", valorCentavos: pesos(20_000), orden: 102, aplicaIva: true, productoCodigo: "004" }),
  linea({ concepto: "ASESORIA LOGISTICA OPERATIVA", valorCentavos: pesos(100_000), orden: 103, aplicaIva: true, productoCodigo: "007" }),
  linea({ concepto: "IVA 19%", valorCentavos: pesos(64_600), orden: 992, tipoFija: "IVA_COMISION", productoCodigo: null }),
  linea({ concepto: "ALMACENAJE ALMACARGA FACT. FE 11298", valorCentavos: $("502.801,45"), orden: 1, seccion: "TERCEROS", productoCodigo: "03", nitTercero: "800154017-8" }),
  linea({ concepto: "SERV. REEMPAQUE Y EMBALAJE EXPRESS FACT. FE 6353", valorCentavos: pesos(99_484), orden: 2, seccion: "TERCEROS", productoCodigo: "11", nitTercero: "802.011.826-3" }),
  linea({ concepto: "LIBERACION TAMPA CARGO FACT.71388844", valorCentavos: pesos(486_075), orden: 3, seccion: "TERCEROS", productoCodigo: "31", nitTercero: "890912462" }),
  linea({ concepto: "DECRETO 2331 4X1000", valorCentavos: pesos(4_353), orden: 995, seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000", productoCodigo: "13" }),
];

describe("construirItemsSiigo — CONCEPTOS_IVA (BAQ-18385)", () => {
  const items = construirItemsSiigo(BAQ_18385, { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE });

  it("manda los 8 ítems de la factura real (price en pesos con centavos) y no la línea de IVA", () => {
    expect(items.map((i) => [i.code, i.price])).toEqual([
      ["03", 502_801.45],
      ["11", 99_484],
      ["31", 486_075],
      ["13", 4_353],
      ["006", 200_000],
      ["002", 20_000],
      ["004", 20_000],
      ["007", 100_000],
    ]);
  });

  it("los ingresos propios llevan IVA por ítem; terceros y 4x1000 no", () => {
    expect(items.filter((i) => i.taxes).map((i) => i.code)).toEqual(["006", "002", "004", "007"]);
    expect(items.every((i) => !i.taxes || i.taxes[0]!.id === IVA_19)).toBe(true);
  });

  it("cada tercero va con su NIT sin dígito de verificación y el 4x1000 con Banco de Occidente", () => {
    expect(items.slice(0, 4).map((i) => i.customer?.identification)).toEqual([
      "800154017",
      "802011826",
      "890912462",
      OCCIDENTE,
    ]);
    expect(items.slice(4).every((i) => i.customer === undefined)).toBe(true);
  });

  it("invariante: Σ ítems + IVA − ReteIVA = payments.value = 1.487.623,45 al centavo", () => {
    const dto: Pick<SiigoFacturaPostDto, "items" | "payments" | "retentions"> = {
      items,
      payments: [{ id: 1, value: 1_487_623.45 }],
      retentions: [{ id: 99 }],
    };
    const cuadre = verificarCuadreSiigo(dto, { tasaIva: 19n, retencionesCentavos: pesos(9_690) });
    expect(cuadre).toEqual({
      ok: true,
      subtotalCentavos: $("1.432.713,45"), // bruto real de la factura
      ivaCentavos: pesos(64_600),
      retencionesCentavos: pesos(9_690),
      esperadoCentavos: 148_762_345n,
      pagosCentavos: 148_762_345n,
      diferenciaCentavos: 0n,
    });
  });

  it("instantánea del payload de ítems de BAQ-18385 (JSON que viaja a Siigo)", () => {
    expect(JSON.stringify(items)).toBe(
      JSON.stringify([
        { code: "03", description: "ALMACENAJE ALMACARGA FACT. FE 11298", quantity: 1, price: 502801.45, customer: { identification: "800154017", branch_office: 0 } },
        { code: "11", description: "SERV. REEMPAQUE Y EMBALAJE EXPRESS FACT. FE 6353", quantity: 1, price: 99484, customer: { identification: "802011826", branch_office: 0 } },
        { code: "31", description: "LIBERACION TAMPA CARGO FACT.71388844", quantity: 1, price: 486075, customer: { identification: "890912462", branch_office: 0 } },
        { code: "13", description: "DECRETO 2331 4X1000", quantity: 1, price: 4353, customer: { identification: OCCIDENTE, branch_office: 0 } },
        { code: "006", description: "SERV COORDINACION EN DESPACHO", quantity: 1, price: 200000, taxes: [{ id: IVA_19 }] },
        { code: "002", description: "REVISION DOCUMENTAL", quantity: 1, price: 20000, taxes: [{ id: IVA_19 }] },
        { code: "004", description: "SISTEMATIZACION DE ARCHIVOS", quantity: 1, price: 20000, taxes: [{ id: IVA_19 }] },
        { code: "007", description: "ASESORIA LOGISTICA OPERATIVA", quantity: 1, price: 100000, taxes: [{ id: IVA_19 }] },
      ]),
    );
  });
});

describe("verificarCuadreSiigo — comprobación que corta el envío", () => {
  const items = construirItemsSiigo(BAQ_18385, { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE });

  it("un centavo de diferencia en payments ⇒ no cuadra, con los dos valores en el mensaje", () => {
    const cuadre = verificarCuadreSiigo(
      { items, payments: [{ id: 1, value: 1_487_623.44 }], retentions: [{ id: 99 }] },
      { tasaIva: 19n, retencionesCentavos: pesos(9_690) },
    );
    expect(cuadre.ok).toBe(false);
    expect(cuadre.diferenciaCentavos).toBe(-1n);
    const msg = mensajeCuadreSiigo(cuadre);
    expect(msg).toContain("1.487.623,45");
    expect(msg).toContain("1.487.623,44");
    expect(msg).toContain("-$ 0,01");
  });

  it("sin retentions en el payload las retenciones no se descuentan (formato COMISION)", () => {
    const cuadre = verificarCuadreSiigo(
      { items: [{ code: "007", description: "COMISION", quantity: 1, price: 140_000 }], payments: [{ id: 1, value: 136_010 }] },
      { tasaIva: null, retencionesCentavos: pesos(3_990) },
    );
    expect(cuadre).toMatchObject({ ok: false, retencionesCentavos: 0n, esperadoCentavos: pesos(140_000) });
    expect(mensajeCuadreSiigo(cuadre, pesos(3_990))).toMatch(/retenciones de .*3.990,00 no viajan/);
  });

  it("IVA por ítem al CENTAVO (D-1, como Siigo): 502.801,45 × 19 % = 95.532,28 (no 95.532)", () => {
    const cuadre = verificarCuadreSiigo(
      {
        items: [{ code: "007", description: "X", quantity: 1, price: 502_801.45, taxes: [{ id: IVA_19 }] }],
        payments: [{ id: 1, value: 598_333.73 }],
      },
      { tasaIva: 19n, retencionesCentavos: 0n },
    );
    expect(PRECISION_IVA_SIIGO).toBe("CENTAVO");
    expect(cuadre.ivaCentavos).toBe(9_553_228n);
    expect(cuadre.ok).toBe(true);
  });

  it("FV-2-18702 real: ítem 6.632.007 con IVA → Siigo liquida 1.260.081,33 y el cuadre da exacto", () => {
    const items = [
      { code: "24", description: "PAGO VUCE", quantity: 1, price: 754_200 },
      { code: "13", description: "4X1000", quantity: 1, price: 3_017 },
      { code: "007", description: "SERVICIO LOGISTICO", quantity: 1, price: 6_632_007, taxes: [{ id: IVA_19 }] },
      { code: "006", description: "DESPACHO", quantity: 1, price: 250_000, taxes: [{ id: IVA_19 }] },
      { code: "001", description: "INVENTARIO", quantity: 1, price: 300_000, taxes: [{ id: IVA_19 }] },
      { code: "010", description: "REGISTRO", quantity: 1, price: 754_200, taxes: [{ id: IVA_19 }] },
      { code: "002", description: "DOCUMENTACION", quantity: 1, price: 40_000, taxes: [{ id: IVA_19 }] },
      { code: "003", description: "PAPELERIA", quantity: 1, price: 22_000, taxes: [{ id: IVA_19 }] },
      { code: "004", description: "SISTEMATIZACION", quantity: 1, price: 40_000, taxes: [{ id: IVA_19 }] },
      { code: "005", description: "GASTOS", quantity: 1, price: 100_000, taxes: [{ id: IVA_19 }] },
    ];
    const cuadre = verificarCuadreSiigo(
      { items, retentions: [{ id: 1 }], payments: [{ id: 1, value: 10_209_744.43 }] },
      { tasaIva: 19n, retencionesCentavos: 23_193_890n },
    );
    expect(cuadre.ivaCentavos).toBe(154_625_933n); // 1.546.259,33
    expect(cuadre.diferenciaCentavos).toBe(0n);
    expect(cuadre.ok).toBe(true);
  });

  it("un precio con más de 2 decimales en el payload es error, no se redondea", () => {
    expect(() =>
      verificarCuadreSiigo(
        { items: [{ code: "007", description: "X", quantity: 1, price: 1.005 }], payments: [{ id: 1, value: 1 }] },
        { tasaIva: null, retencionesCentavos: 0n },
      ),
    ).toThrow(/más de 2 decimales/);
  });

  it("un ítem con IVA sin tasa conocida es error", () => {
    expect(() =>
      verificarCuadreSiigo(
        { items: [{ code: "007", description: "X", quantity: 1, price: 100, taxes: [{ id: 1 }] }], payments: [{ id: 1, value: 119 }] },
        { tasaIva: null, retencionesCentavos: 0n },
      ),
    ).toThrow(/tasa/);
  });
});

describe("construirItemsSiigo — COMISION (formato histórico)", () => {
  it("manda la línea de IVA como ítem y ningún ítem con taxes", () => {
    const items = construirItemsSiigo(
      [
        linea({ concepto: "COMISION GALCOMEX", valorCentavos: pesos(400_000), orden: 991, tipoFija: "COMISION", productoCodigo: "007" }),
        linea({ concepto: "IVA COMISION", valorCentavos: pesos(76_000), orden: 992, tipoFija: "IVA_COMISION", productoCodigo: "007", aplicaIva: true }),
        linea({ concepto: "IMPUESTO 4X1000", valorCentavos: pesos(130_088), orden: 995, seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000", productoCodigo: "13" }),
      ],
      { formato: "COMISION", ivaTaxId: null, nit4x1000: OCCIDENTE },
    );
    expect(items.map((i) => [i.code, i.price])).toEqual([["13", 130_088], ["007", 400_000], ["007", 76_000]]);
    expect(items.some((i) => i.taxes)).toBe(false);
  });
});

describe("construirItemsSiigo — el IVA del producto Siigo manda sobre el global", () => {
  const IVA_DEL_PRODUCTO = 1599;

  it("usa el id del producto cuando lo trae y el global cuando no", () => {
    const items = construirItemsSiigo(
      [
        linea({ concepto: "GASTOS OPERATIVOS", valorCentavos: pesos(100_000), orden: 100, aplicaIva: true, productoCodigo: "005", ivaProductoId: IVA_DEL_PRODUCTO }),
        linea({ concepto: "PAPELERÍA", valorCentavos: pesos(10_000), orden: 101, aplicaIva: true, productoCodigo: "003" }),
      ],
      { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE },
    );
    expect(items.map((i) => [i.code, i.taxes?.[0]?.id])).toEqual([
      ["005", IVA_DEL_PRODUCTO],
      ["003", IVA_19],
    ]);
  });

  it("una línea sin IVA no lo lleva aunque su producto tenga impuesto", () => {
    const items = construirItemsSiigo(
      [linea({ concepto: "SELLOS DE SEGURIDAD", valorCentavos: pesos(41_900), orden: 100, aplicaIva: false, productoCodigo: "12", ivaProductoId: IVA_DEL_PRODUCTO })],
      { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE },
    );
    expect(items[0]!.taxes).toBeUndefined();
  });

  it("sin IVA global pero con el del producto no revienta", () => {
    const items = construirItemsSiigo(
      [linea({ concepto: "GASTOS OPERATIVOS", valorCentavos: pesos(100_000), orden: 100, aplicaIva: true, productoCodigo: "005", ivaProductoId: IVA_DEL_PRODUCTO })],
      { formato: "CONCEPTOS_IVA", ivaTaxId: null, nit4x1000: OCCIDENTE },
    );
    expect(items[0]!.taxes).toEqual([{ id: IVA_DEL_PRODUCTO }]);
  });

  it("sin IVA global ni del producto sigue siendo error de configuración", () => {
    expect(() =>
      construirItemsSiigo(
        [linea({ concepto: "GASTOS OPERATIVOS", valorCentavos: pesos(100_000), orden: 100, aplicaIva: true, productoCodigo: "005" })],
        { formato: "CONCEPTOS_IVA", ivaTaxId: null, nit4x1000: OCCIDENTE },
      ),
    ).toThrow(/impuesto IVA/i);
  });
});

describe("identificacionSiigo", () => {
  it("deja solo los dígitos antes del dígito de verificación", () => {
    expect(identificacionSiigo("800.154.017-8")).toBe("800154017");
    expect(identificacionSiigo("890300279")).toBe("890300279");
  });
});
