import { describe, expect, it } from "vitest";

import {
  calcularLineasTarifa,
  porcentajeSobre,
  tramoPara,
  vigenteEn,
  type ContextoTarifa,
  type ItemTarifaCalculable,
} from "../motor";

// ---------------------------------------------------------------------------
// Casos de referencia construidos desde las propuestas comerciales 2026:
//   · LITOPLAS S.A. (feb 2 de 2026 → ene 31 de 2027), importaciones aéreas y
//     marítimas BAQ/CTG.
//   · CW ASIA SAS (marzo 11 de 2026, IPC 5,29 %), tarifa única 0,37 % sobre
//     el valor en aduana con mínimos por tipo de carga.
// No son casos dorados (faltan las facturas reales de Camila); fijan la
// aritmética del motor con tolerancia 0.
// ---------------------------------------------------------------------------

function item(parcial: Partial<ItemTarifaCalculable> & Pick<ItemTarifaCalculable, "concepto" | "tipoCalculo">): ItemTarifaCalculable {
  return {
    nombrePublico: parcial.concepto,
    siigoCodigo: null,
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    orden: 0,
    ...parcial,
  };
}

function ctx(parcial: Partial<ContextoTarifa> = {}): ContextoTarifa {
  return {
    valorCif: null,
    tipoCarga: null,
    numContenedores: null,
    numDeclaraciones: null,
    numDocumentos: null,
    numItems: null,
    eventos: [],
    costos: [],
    ...parcial,
  };
}

const LITOPLAS: ItemTarifaCalculable[] = [
  item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por embarque", tipoCalculo: "FIJO", valor: 100_000n, orden: 1 }),
  item({ concepto: "REVISION_DESPACHO", nombrePublico: "Servicios logísticos de revisión e inventario en despacho", tipoCalculo: "FIJO", valor: 180_000n, disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 2 }),
  item({ concepto: "ENTREGA_DIRECTA", nombrePublico: "Servicios logísticos de despacho entrega directa", tipoCalculo: "FIJO", valor: 200_000n, disparador: "EVENTO", eventoCodigo: "ENTREGA_DIRECTA", orden: 3 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: 20_000n, orden: 4 }),
  item({ concepto: "DOCUMENTACION", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: 10_000n, orden: 5 }),
  item({ concepto: "DOCUMENTOS_DESPACHO", tipoCalculo: "FIJO", valor: 20_000n, orden: 6 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "FIJO", valor: 10_000n, orden: 7 }),
  item({ concepto: "ELABORACION_REGISTRO", tipoCalculo: "FIJO", valor: 433_000n, disparador: "EVENTO", eventoCodigo: "ELABORACION_REGISTRO", orden: 8 }),
  item({ concepto: "CLASIFICACION", nombrePublico: "Clasificación arancelaria", tipoCalculo: "PRIMERO_MAS_ADICIONAL", unidad: "ITEM", valor: 380_000n, valorAdicional: 180_000n, disparador: "MANUAL", orden: 9 }),
];

const CW: ItemTarifaCalculable[] = [
  item({
    concepto: "SERVICIO_UNICO",
    nombrePublico: "Tarifa única de servicio",
    tipoCalculo: "PORCENTAJE_MIN",
    porcentajeBps: 37,
    minimos: { SUELTA: "370000", CONTENEDOR_20: "498000", CONTENEDOR_40: "554000" },
    orden: 1,
  }),
  item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por contenedor", tipoCalculo: "POR_UNIDAD", unidad: "CONTENEDOR", valor: 100_000n, orden: 2 }),
  item({ concepto: "DESPACHO_PARCIAL", tipoCalculo: "POR_UNIDAD", valor: 50_000n, disparador: "EVENTO", eventoCodigo: "DESPACHO_PARCIAL", orden: 3 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: 30_000n, orden: 4 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: 20_000n, orden: 5 }),
  item({ concepto: "PAGO_REGISTRO", nombrePublico: "Pago de registro VUCE", tipoCalculo: "ESPEJO_DE_COSTO", conceptoCosto: "registro", aplicaIva: false, orden: 6 }),
];

describe("porcentajeSobre — redondeo half-up en enteros", () => {
  it("0,37 % de 100.000.000 = 370.000", () => {
    expect(porcentajeSobre(100_000_000n, 37)).toBe(370_000n);
  });
  it("redondea hacia arriba desde ,5", () => {
    // 1.351 × 37 / 10.000 = 4,9987 → 5
    expect(porcentajeSobre(1_351n, 37)).toBe(5n);
    // 1.000 × 37 / 10.000 = 3,7 → 4
    expect(porcentajeSobre(1_000n, 37)).toBe(4n);
    // 100 × 37 / 10.000 = 0,37 → 0
    expect(porcentajeSobre(100n, 37)).toBe(0n);
  });
});

describe("Litoplas — trámite típico", () => {
  it("sin eventos: solo los ítems SIEMPRE, documentación × declaraciones", () => {
    const r = calcularLineasTarifa(LITOPLAS, ctx({ numDeclaraciones: 3 }));

    expect(r.lineas.map((l) => [l.concepto, l.valor])).toEqual([
      ["GASTOS_TRAMITE", 100_000n],
      ["SISTEMATIZACION", 20_000n],
      ["DOCUMENTACION", 30_000n],
      ["DOCUMENTOS_DESPACHO", 20_000n],
      ["PAPELERIA", 10_000n],
    ]);
    expect(r.total).toBe(180_000n);
    expect(r.pendientes).toEqual([]);
    expect(r.manuales.map((m) => m.concepto)).toEqual(["CLASIFICACION"]);
    expect(r.lineas[2].detalle).toBe("10.000 × 3 declaraciones");
  });

  it("con contenedor abierto y registro elaborado entran las dos líneas de evento", () => {
    const r = calcularLineasTarifa(
      LITOPLAS,
      ctx({
        numDeclaraciones: 1,
        eventos: [
          { codigo: "REVISION_DESPACHO", cantidad: 1 },
          { codigo: "ELABORACION_REGISTRO", cantidad: 1 },
        ],
      }),
    );

    const porConcepto = Object.fromEntries(r.lineas.map((l) => [l.concepto, l.valor]));
    expect(porConcepto.REVISION_DESPACHO).toBe(180_000n);
    expect(porConcepto.ELABORACION_REGISTRO).toBe(433_000n);
    expect(porConcepto.ENTREGA_DIRECTA).toBeUndefined();
    expect(r.total).toBe(100_000n + 180_000n + 20_000n + 10_000n + 20_000n + 10_000n + 433_000n);
    expect(r.lineas.find((l) => l.concepto === "REVISION_DESPACHO")?.origen).toBe("EVENTO");
  });

  it("sin número de declaraciones, DOCUMENTACION queda pendiente en vez de valer 0", () => {
    const r = calcularLineasTarifa(LITOPLAS, ctx());

    expect(r.lineas.map((l) => l.concepto)).not.toContain("DOCUMENTACION");
    expect(r.pendientes).toEqual([
      {
        concepto: "DOCUMENTACION",
        nombrePublico: "DOCUMENTACION",
        motivo: "Falta el número de declaraciones del trámite",
      },
    ]);
  });

  it("cero declaraciones sí es un dato: no genera línea ni pendiente", () => {
    const r = calcularLineasTarifa(LITOPLAS, ctx({ numDeclaraciones: 0 }));
    expect(r.lineas.map((l) => l.concepto)).not.toContain("DOCUMENTACION");
    expect(r.pendientes).toEqual([]);
  });

  it("clasificación: primer ítem 380.000 y cada adicional 180.000", () => {
    const clasificacion = LITOPLAS.filter((i) => i.concepto === "CLASIFICACION").map((i) => ({
      ...i,
      disparador: "SIEMPRE" as const,
    }));

    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 1 })).total).toBe(380_000n);
    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 3 })).total).toBe(380_000n + 2n * 180_000n);
    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 3 })).lineas[0].detalle).toBe(
      "Primer ítem 380.000 + 2 adicionales × 180.000",
    );
  });

  it("IVA del 19 % solo sobre las líneas que lo aplican", () => {
    const r = calcularLineasTarifa(
      [
        item({ concepto: "A", tipoCalculo: "FIJO", valor: 100_000n }),
        item({ concepto: "B", tipoCalculo: "FIJO", valor: 50_000n, aplicaIva: false }),
      ],
      ctx(),
    );
    expect(r.total).toBe(150_000n);
    expect(r.totalConIva).toBe(150_000n + 19_000n);
  });
});

describe("CW ASIA — tarifa única sobre el CIF con mínimos", () => {
  it("CIF alto: 0,37 % manda", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: 300_000_000n, tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 2 }));
    const unico = r.lineas.find((l) => l.concepto === "SERVICIO_UNICO");
    expect(unico?.valor).toBe(1_110_000n);
    expect(unico?.detalle).toBe("0,37 % sobre CIF 300.000.000");
  });

  it("CIF bajo en contenedor de 20′: aplica el mínimo 498.000", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: 50_000_000n, tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 1 }));
    const unico = r.lineas.find((l) => l.concepto === "SERVICIO_UNICO");
    expect(unico?.valor).toBe(498_000n);
    expect(unico?.detalle).toBe("0,37 % sobre CIF = 185.000; aplica mínimo contenedor de 20′");
  });

  it("mínimo de 40′ es 554.000 (la transcripción decía 154.000: era la propuesta la que manda)", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: 10_000_000n, tipoCarga: "CONTENEDOR_40", numContenedores: 2, numDocumentos: 1 }));
    expect(r.lineas.find((l) => l.concepto === "SERVICIO_UNICO")?.valor).toBe(554_000n);
    expect(r.lineas.find((l) => l.concepto === "GASTOS_TRAMITE")?.valor).toBe(200_000n);
  });

  it("sin CIF ni tipo de carga, el ítem queda pendiente con el motivo exacto", () => {
    const r = calcularLineasTarifa(CW, ctx({ numContenedores: 1, numDocumentos: 1 }));
    expect(r.pendientes.map((p) => p.motivo)).toContain("Falta el valor CIF (valor en aduana) del trámite");

    const r2 = calcularLineasTarifa(CW, ctx({ valorCif: 1_000_000n, numContenedores: 1, numDocumentos: 1 }));
    expect(r2.pendientes.map((p) => p.motivo)).toContain("Falta el tipo de carga para aplicar el mínimo");
  });

  it("despacho parcial ×2 multiplica por la cantidad del evento", () => {
    const r = calcularLineasTarifa(
      CW,
      ctx({ valorCif: 300_000_000n, tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0, eventos: [{ codigo: "DESPACHO_PARCIAL", cantidad: 2 }] }),
    );
    expect(r.lineas.find((l) => l.concepto === "DESPACHO_PARCIAL")?.valor).toBe(100_000n);
    // Cero contenedores y cero documentos: no hay línea, tampoco pendiente.
    expect(r.lineas.map((l) => l.concepto)).not.toContain("GASTOS_TRAMITE");
    expect(r.pendientes.map((p) => p.concepto)).not.toContain("GASTOS_TRAMITE");
  });

  it("espejo de costo: el pago del registro se cobra tal cual se pagó, sin IVA", () => {
    const con = calcularLineasTarifa(
      CW,
      ctx({ valorCif: 300_000_000n, tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0, costos: [{ concepto: "Pago registro VUCE", valor: 550_000n }] }),
    );
    const espejo = con.lineas.find((l) => l.concepto === "PAGO_REGISTRO");
    expect(espejo?.valor).toBe(550_000n);
    expect(espejo?.aplicaIva).toBe(false);

    const sin = calcularLineasTarifa(CW, ctx({ valorCif: 300_000_000n, tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0 }));
    expect(sin.pendientes.find((p) => p.concepto === "PAGO_REGISTRO")?.motivo).toBe(
      'No hay un pago o factura de proveedor que contenga "registro"',
    );
  });
});

// Polyrec ZF, traslados (reunión 10-sep-2026, min 83:31): "si es un contenedor
// son 300; si son dos o más, 250 cada contenedor".
const POLYREC_ZF: ItemTarifaCalculable[] = [
  item({
    concepto: "TRASLADO_ZF",
    nombrePublico: "Traslado de contenedor en zona franca",
    tipoCalculo: "POR_TRAMO",
    unidad: "CONTENEDOR",
    // A propósito desordenados: el motor los ordena.
    tramos: [
      { hasta: null, valor: "250000" },
      { hasta: 1, valor: "300000" },
    ],
    orden: 1,
  }),
];

describe("Polyrec ZF — tarifa por tramos", () => {
  it("un contenedor: 300.000", () => {
    const r = calcularLineasTarifa(POLYREC_ZF, ctx({ numContenedores: 1 }));
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0].valorUnitario).toBe(300_000n);
    expect(r.lineas[0].valor).toBe(300_000n);
    expect(r.lineas[0].detalle).toBe("300.000 × 1 contenedor (tramo 1 contenedor)");
  });

  it("dos contenedores: 250.000 cada uno = 500.000 (no 300 + 250)", () => {
    const r = calcularLineasTarifa(POLYREC_ZF, ctx({ numContenedores: 2 }));
    expect(r.lineas[0].valorUnitario).toBe(250_000n);
    expect(r.lineas[0].valor).toBe(500_000n);
    expect(r.lineas[0].detalle).toBe("250.000 × 2 contenedores (tramo 2 o más contenedores)");
  });

  it("cinco contenedores: 1.250.000", () => {
    expect(calcularLineasTarifa(POLYREC_ZF, ctx({ numContenedores: 5 })).total).toBe(1_250_000n);
  });

  it("sin número de contenedores queda pendiente, nunca en cero", () => {
    const r = calcularLineasTarifa(POLYREC_ZF, ctx());
    expect(r.lineas).toEqual([]);
    expect(r.pendientes[0].motivo).toBe("Falta el número de contenedores del trámite");
  });

  it("tramos cerrados que no cubren la cantidad → pendiente con el motivo", () => {
    const cerrado = [item({ concepto: "X", tipoCalculo: "POR_TRAMO", unidad: "CONTENEDOR", tramos: [{ hasta: 2, valor: "1000" }] })];
    const r = calcularLineasTarifa(cerrado, ctx({ numContenedores: 3 }));
    expect(r.pendientes[0].motivo).toBe("Ningún tramo cubre 3 contenedores");
  });

  it("tres tramos cerrados + abierto: cada cantidad cae en el suyo", () => {
    const escalonado = [
      item({
        concepto: "E",
        tipoCalculo: "POR_TRAMO",
        unidad: "DECLARACION",
        tramos: [
          { hasta: 1, valor: "100" },
          { hasta: 3, valor: "80" },
          { hasta: null, valor: "60" },
        ],
      }),
    ];
    expect(tramoPara(escalonado[0].tramos!, 1)?.valor).toBe("100");
    expect(tramoPara(escalonado[0].tramos!, 2)?.valor).toBe("80");
    expect(tramoPara(escalonado[0].tramos!, 3)?.valor).toBe("80");
    expect(tramoPara(escalonado[0].tramos!, 4)?.valor).toBe("60");
    const r = calcularLineasTarifa(escalonado, ctx({ numDeclaraciones: 4 }));
    expect(r.lineas[0].valor).toBe(240n);
    expect(r.lineas[0].detalle).toBe("60 × 4 declaraciones (tramo 4 o más declaraciones)");
  });
});

describe("vigenteEn", () => {
  const litoplas = { vigenteDesde: new Date("2026-02-02T00:00:00.000Z"), vigenteHasta: new Date("2027-01-31T00:00:00.000Z") };

  it("inclusivo en ambos extremos, por día", () => {
    expect(vigenteEn(litoplas, new Date("2026-02-02T00:00:00.000Z"))).toBe(true);
    expect(vigenteEn(litoplas, new Date("2027-01-31T15:00:00.000Z"))).toBe(true);
    expect(vigenteEn(litoplas, new Date("2026-02-01T23:59:59.000Z"))).toBe(false);
    expect(vigenteEn(litoplas, new Date("2027-02-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("determinismo", () => {
  it("mismo input, mismo output, sin importar el orden de entrada", () => {
    const c = ctx({ numDeclaraciones: 2, eventos: [{ codigo: "ENTREGA_DIRECTA", cantidad: 1 }] });
    const a = calcularLineasTarifa(LITOPLAS, c);
    const b = calcularLineasTarifa([...LITOPLAS].reverse(), c);
    expect(a).toEqual(b);
  });
});
