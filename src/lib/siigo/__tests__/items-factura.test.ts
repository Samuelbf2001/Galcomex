import { describe, expect, it } from "vitest";

import { construirItemsSiigo, identificacionSiigo, type LineaParaSiigo } from "../items-factura";

const IVA_19 = 1564;
const OCCIDENTE = "890300279";

function linea(parcial: Partial<LineaParaSiigo> & Pick<LineaParaSiigo, "concepto" | "valor">): LineaParaSiigo {
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

/** Borrador CONCEPTOS_IVA equivalente a la factura real BAQ-18385 (Litoplas, DO.26-0069). */
const BAQ_18385: LineaParaSiigo[] = [
  linea({ concepto: "SERV COORDINACION EN DESPACHO", valor: 200_000n, orden: 100, aplicaIva: true, productoCodigo: "006" }),
  linea({ concepto: "REVISION DOCUMENTAL", valor: 20_000n, orden: 101, aplicaIva: true, productoCodigo: "002" }),
  linea({ concepto: "SISTEMATIZACION DE ARCHIVOS", valor: 20_000n, orden: 102, aplicaIva: true, productoCodigo: "004" }),
  linea({ concepto: "ASESORIA LOGISTICA OPERATIVA", valor: 100_000n, orden: 103, aplicaIva: true, productoCodigo: "007" }),
  linea({ concepto: "IVA 19%", valor: 64_600n, orden: 992, tipoFija: "IVA_COMISION", productoCodigo: null }),
  linea({ concepto: "ALMACENAJE ALMACARGA FACT. FE 11298", valor: 502_801n, orden: 1, seccion: "TERCEROS", productoCodigo: "03", nitTercero: "800154017-8" }),
  linea({ concepto: "SERV. REEMPAQUE Y EMBALAJE EXPRESS FACT. FE 6353", valor: 99_484n, orden: 2, seccion: "TERCEROS", productoCodigo: "11", nitTercero: "802.011.826-3" }),
  linea({ concepto: "LIBERACION TAMPA CARGO FACT.71388844", valor: 486_075n, orden: 3, seccion: "TERCEROS", productoCodigo: "31", nitTercero: "890912462" }),
  linea({ concepto: "DECRETO 2331 4X1000", valor: 4_353n, orden: 995, seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000", productoCodigo: "13" }),
];

describe("construirItemsSiigo — CONCEPTOS_IVA (BAQ-18385)", () => {
  const items = construirItemsSiigo(BAQ_18385, { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE });

  it("manda los 8 ítems de la factura real y no la línea de IVA", () => {
    expect(items.map((i) => [i.code, i.price])).toEqual([
      ["03", 502_801],
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

  it("Σ ítems + IVA = total bruto de la factura real antes de ReteIVA", () => {
    const bruto = items.reduce((s, i) => s + i.price, 0);
    expect(bruto).toBe(1_432_713); // real: 1.432.713,45 (centavos de Almacarga)
    expect(bruto + 64_600 - 9_690).toBe(1_487_623);
  });
});

describe("construirItemsSiigo — COMISION (formato histórico)", () => {
  it("manda la línea de IVA como ítem y ningún ítem con taxes", () => {
    const items = construirItemsSiigo(
      [
        linea({ concepto: "COMISION GALCOMEX", valor: 400_000n, orden: 991, tipoFija: "COMISION", productoCodigo: "007" }),
        linea({ concepto: "IVA COMISION", valor: 76_000n, orden: 992, tipoFija: "IVA_COMISION", productoCodigo: "007", aplicaIva: true }),
        linea({ concepto: "IMPUESTO 4X1000", valor: 130_088n, orden: 995, seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000", productoCodigo: "13" }),
      ],
      { formato: "COMISION", ivaTaxId: null, nit4x1000: OCCIDENTE },
    );
    expect(items.map((i) => i.code)).toEqual(["13", "007", "007"]);
    expect(items.some((i) => i.taxes)).toBe(false);
  });
});

describe("construirItemsSiigo — el IVA del producto Siigo manda sobre el global", () => {
  const IVA_DEL_PRODUCTO = 1599;

  it("usa el id del producto cuando lo trae y el global cuando no", () => {
    const items = construirItemsSiigo(
      [
        linea({ concepto: "GASTOS OPERATIVOS", valor: 100_000n, orden: 100, aplicaIva: true, productoCodigo: "005", ivaProductoId: IVA_DEL_PRODUCTO }),
        linea({ concepto: "PAPELERÍA", valor: 10_000n, orden: 101, aplicaIva: true, productoCodigo: "003" }),
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
      [linea({ concepto: "SELLOS DE SEGURIDAD", valor: 41_900n, orden: 100, aplicaIva: false, productoCodigo: "12", ivaProductoId: IVA_DEL_PRODUCTO })],
      { formato: "CONCEPTOS_IVA", ivaTaxId: IVA_19, nit4x1000: OCCIDENTE },
    );
    expect(items[0]!.taxes).toBeUndefined();
  });

  it("sin IVA global pero con el del producto no revienta", () => {
    const items = construirItemsSiigo(
      [linea({ concepto: "GASTOS OPERATIVOS", valor: 100_000n, orden: 100, aplicaIva: true, productoCodigo: "005", ivaProductoId: IVA_DEL_PRODUCTO })],
      { formato: "CONCEPTOS_IVA", ivaTaxId: null, nit4x1000: OCCIDENTE },
    );
    expect(items[0]!.taxes).toEqual([{ id: IVA_DEL_PRODUCTO }]);
  });

  it("sin IVA global ni del producto sigue siendo error de configuración", () => {
    expect(() =>
      construirItemsSiigo(
        [linea({ concepto: "GASTOS OPERATIVOS", valor: 100_000n, orden: 100, aplicaIva: true, productoCodigo: "005" })],
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
