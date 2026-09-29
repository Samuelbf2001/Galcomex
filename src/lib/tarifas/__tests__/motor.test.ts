import { describe, expect, it } from "vitest";

import {
  calcularLineasTarifa,
  ejemploTramo,
  minimoDe,
  porcentajeSobre,
  tramoPara,
  valorTramo,
  vigenteEn,
  type ContextoTarifa,
  type ItemTarifaCalculable,
  type TramoTarifa,
} from "../motor";
import { pesos, stringifyDinero } from "@/lib/dinero";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";

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
  item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por embarque", tipoCalculo: "FIJO", valor: pesos(100_000), orden: 1 }),
  item({ concepto: "REVISION_DESPACHO", nombrePublico: "Servicios logísticos de revisión e inventario en despacho", tipoCalculo: "FIJO", valor: pesos(180_000), disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 2 }),
  item({ concepto: "ENTREGA_DIRECTA", nombrePublico: "Servicios logísticos de despacho entrega directa", tipoCalculo: "FIJO", valor: pesos(200_000), disparador: "EVENTO", eventoCodigo: "ENTREGA_DIRECTA", orden: 3 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: pesos(20_000), orden: 4 }),
  item({ concepto: "DOCUMENTACION", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: pesos(10_000), orden: 5 }),
  item({ concepto: "DOCUMENTOS_DESPACHO", tipoCalculo: "FIJO", valor: pesos(20_000), orden: 6 }),
  item({ concepto: "PAPELERIA", tipoCalculo: "FIJO", valor: pesos(10_000), orden: 7 }),
  item({ concepto: "ELABORACION_REGISTRO", tipoCalculo: "FIJO", valor: pesos(433_000), disparador: "EVENTO", eventoCodigo: "ELABORACION_REGISTRO", orden: 8 }),
  item({ concepto: "CLASIFICACION", nombrePublico: "Clasificación arancelaria", tipoCalculo: "PRIMERO_MAS_ADICIONAL", unidad: "ITEM", valor: pesos(380_000), valorAdicional: pesos(180_000), disparador: "MANUAL", orden: 9 }),
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
  item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por contenedor", tipoCalculo: "POR_UNIDAD", unidad: "CONTENEDOR", valor: pesos(100_000), orden: 2 }),
  item({ concepto: "DESPACHO_PARCIAL", tipoCalculo: "POR_UNIDAD", valor: pesos(50_000), disparador: "EVENTO", eventoCodigo: "DESPACHO_PARCIAL", orden: 3 }),
  item({ concepto: "SISTEMATIZACION", tipoCalculo: "FIJO", valor: pesos(30_000), orden: 4 }),
  item({ concepto: "REVISION_DOCUMENTAL", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: pesos(20_000), orden: 5 }),
  item({ concepto: "PAGO_REGISTRO", nombrePublico: "Pago de registro VUCE", tipoCalculo: "ESPEJO_DE_COSTO", conceptoCosto: "registro", aplicaIva: false, orden: 6 }),
];

describe("porcentajeSobre — al PESO, mitad hacia arriba (centavos, A.6)", () => {
  it("0,37 % de 100.000.000 = 370.000", () => {
    expect(porcentajeSobre(pesos(100_000_000), 37)).toBe(pesos(370_000));
  });
  it("redondea al peso, hacia arriba desde ,5", () => {
    // 1.351 × 37 / 10.000 = 4,9987 → 5
    expect(porcentajeSobre(pesos(1_351), 37)).toBe(pesos(5));
    // 1.000 × 37 / 10.000 = 3,7 → 4
    expect(porcentajeSobre(pesos(1_000), 37)).toBe(pesos(4));
    // 100 × 37 / 10.000 = 0,37 → 0
    expect(porcentajeSobre(pesos(100), 37)).toBe(0n);
    // frontera x,5 exacto: 1.500 × 1 % = 15 → exacto; 50 × 1 % = 0,50 → 1 (mitad arriba)
    expect(porcentajeSobre(pesos(50), 100)).toBe(pesos(1));
    // 49,99 × 1 % = 0,4999 → 0
    expect(porcentajeSobre(4_999n, 100)).toBe(0n);
  });
  it("base con centavos: el resultado sigue siendo pesos enteros", () => {
    // 0,37 % de 1.088.360,45 = 4.026,93 → 4.027
    expect(porcentajeSobre(108_836_045n, 37)).toBe(pesos(4_027));
  });
});

describe("Litoplas — trámite típico", () => {
  it("sin eventos: solo los ítems SIEMPRE, documentación × declaraciones", () => {
    const r = calcularLineasTarifa(LITOPLAS, ctx({ numDeclaraciones: 3 }));

    expect(r.lineas.map((l) => [l.concepto, l.valor])).toEqual([
      ["GASTOS_TRAMITE", pesos(100_000)],
      ["SISTEMATIZACION", pesos(20_000)],
      ["DOCUMENTACION", pesos(30_000)],
      ["DOCUMENTOS_DESPACHO", pesos(20_000)],
      ["PAPELERIA", pesos(10_000)],
    ]);
    expect(r.total).toBe(pesos(180_000));
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
    expect(porConcepto.REVISION_DESPACHO).toBe(pesos(180_000));
    expect(porConcepto.ELABORACION_REGISTRO).toBe(pesos(433_000));
    expect(porConcepto.ENTREGA_DIRECTA).toBeUndefined();
    expect(r.total).toBe(pesos(100_000) + pesos(180_000) + pesos(20_000) + pesos(10_000) + pesos(20_000) + pesos(10_000) + pesos(433_000));
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
        causa: "BASE_DO",
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

    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 1 })).total).toBe(pesos(380_000));
    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 3 })).total).toBe(pesos(380_000) + 2n * pesos(180_000));
    expect(calcularLineasTarifa(clasificacion, ctx({ numItems: 3 })).lineas[0].detalle).toBe(
      "Primer ítem 380.000 + 2 adicionales × 180.000",
    );
  });

  it("IVA del 19 % solo sobre las líneas que lo aplican", () => {
    const r = calcularLineasTarifa(
      [
        item({ concepto: "A", tipoCalculo: "FIJO", valor: pesos(100_000) }),
        item({ concepto: "B", tipoCalculo: "FIJO", valor: pesos(50_000), aplicaIva: false }),
      ],
      ctx(),
    );
    expect(r.total).toBe(pesos(150_000));
    expect(r.totalConIva).toBe(pesos(150_000) + pesos(19_000));
  });

  it("IVA por ítem AL CENTAVO (D-1, igual que Siigo): 6.632.007 → 1.260.081,33", () => {
    const r = calcularLineasTarifa(
      [
        item({ concepto: "A", tipoCalculo: "FIJO", valor: pesos(6_632_007) }),
        item({ concepto: "B", tipoCalculo: "FIJO", valor: pesos(12_345) }),
      ],
      ctx(),
    );
    // 1.260.081,33 + 2.345,55 (por ítem; sobre la suma daría lo mismo aquí, pero
    // al peso habría dado 1.260.081 + 2.346).
    expect(r.totalConIva).toBe(pesos(6_644_352) + 126_008_133n + 234_555n);
  });
});

describe("CW ASIA — tarifa única sobre el CIF con mínimos", () => {
  it("CIF alto: 0,37 % manda", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: pesos(300_000_000), tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 2 }));
    const unico = r.lineas.find((l) => l.concepto === "SERVICIO_UNICO");
    expect(unico?.valor).toBe(pesos(1_110_000));
    expect(unico?.detalle).toBe("0,37 % sobre CIF 300.000.000");
  });

  it("CIF bajo en contenedor de 20′: aplica el mínimo 498.000", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: pesos(50_000_000), tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 1 }));
    const unico = r.lineas.find((l) => l.concepto === "SERVICIO_UNICO");
    expect(unico?.valor).toBe(pesos(498_000));
    expect(unico?.detalle).toBe("0,37 % sobre CIF = 185.000; aplica mínimo contenedor de 20′");
  });

  it("mínimo de 40′ es 554.000 (la transcripción decía 154.000: era la propuesta la que manda)", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: pesos(10_000_000), tipoCarga: "CONTENEDOR_40", numContenedores: 2, numDocumentos: 1 }));
    expect(r.lineas.find((l) => l.concepto === "SERVICIO_UNICO")?.valor).toBe(pesos(554_000));
    expect(r.lineas.find((l) => l.concepto === "GASTOS_TRAMITE")?.valor).toBe(pesos(200_000));
  });

  it("sin CIF ni tipo de carga, el ítem queda pendiente con el motivo exacto", () => {
    const r = calcularLineasTarifa(CW, ctx({ numContenedores: 1, numDocumentos: 1 }));
    expect(r.pendientes.map((p) => p.motivo)).toContain("Falta el valor CIF (valor en aduana) del trámite");

    const r2 = calcularLineasTarifa(CW, ctx({ valorCif: pesos(1_000_000), numContenedores: 1, numDocumentos: 1 }));
    expect(r2.pendientes.map((p) => p.motivo)).toContain("Falta el tipo de carga para aplicar el mínimo");
  });

  it("despacho parcial ×2 multiplica por la cantidad del evento", () => {
    const r = calcularLineasTarifa(
      CW,
      ctx({ valorCif: pesos(300_000_000), tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0, eventos: [{ codigo: "DESPACHO_PARCIAL", cantidad: 2 }] }),
    );
    expect(r.lineas.find((l) => l.concepto === "DESPACHO_PARCIAL")?.valor).toBe(pesos(100_000));
    // Cero contenedores y cero documentos: no hay línea, tampoco pendiente.
    expect(r.lineas.map((l) => l.concepto)).not.toContain("GASTOS_TRAMITE");
    expect(r.pendientes.map((p) => p.concepto)).not.toContain("GASTOS_TRAMITE");
  });

  it("espejo de costo: el pago del registro se cobra tal cual se pagó, sin IVA", () => {
    const con = calcularLineasTarifa(
      CW,
      ctx({ valorCif: pesos(300_000_000), tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0, costos: [{ concepto: "Pago registro VUCE", valor: pesos(550_000) }] }),
    );
    const espejo = con.lineas.find((l) => l.concepto === "PAGO_REGISTRO");
    expect(espejo?.valor).toBe(pesos(550_000));
    expect(espejo?.aplicaIva).toBe(false);

    const sin = calcularLineasTarifa(CW, ctx({ valorCif: pesos(300_000_000), tipoCarga: "SUELTA", numContenedores: 0, numDocumentos: 0 }));
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
    expect(r.lineas[0].valorUnitario).toBe(pesos(300_000));
    expect(r.lineas[0].valor).toBe(pesos(300_000));
    expect(r.lineas[0].detalle).toBe("300.000 × 1 contenedor (tramo 1 contenedor)");
  });

  it("dos contenedores: 250.000 cada uno = 500.000 (no 300 + 250)", () => {
    const r = calcularLineasTarifa(POLYREC_ZF, ctx({ numContenedores: 2 }));
    expect(r.lineas[0].valorUnitario).toBe(pesos(250_000));
    expect(r.lineas[0].valor).toBe(pesos(500_000));
    expect(r.lineas[0].detalle).toBe("250.000 × 2 contenedores (tramo 2 o más contenedores)");
  });

  it("cinco contenedores: 1.250.000", () => {
    expect(calcularLineasTarifa(POLYREC_ZF, ctx({ numContenedores: 5 })).total).toBe(pesos(1_250_000));
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
    expect(r.lineas[0].valor).toBe(pesos(240));
    expect(r.lineas[0].detalle).toBe("60 × 4 declaraciones (tramo 4 o más declaraciones)");
  });
});

// Editor de escalas de volumen (B6, 22-sep): el ejemplo en vivo reusa
// `tramoPara`, la misma selección de tramo que usa `calcularLineasTarifa`.
describe("causa de cada pendiente (a dónde manda el modal a arreglarlo)", () => {
  it("falta un dato del DO → BASE_DO; falta un costo → COSTO_PROVEEDOR; ítem mal configurado → TARIFARIO", () => {
    const r = calcularLineasTarifa(
      [
        item({ concepto: "AGE", tipoCalculo: "PORCENTAJE_MIN", porcentajeBps: 37, orden: 1 }),
        item({ concepto: "ESPEJO", tipoCalculo: "ESPEJO_DE_COSTO", conceptoCosto: "bodegaje", orden: 2 }),
        item({ concepto: "SIN_TRAMOS", tipoCalculo: "POR_TRAMO", unidad: "CONTENEDOR", orden: 3 }),
        item({ concepto: "SIN_PCT", tipoCalculo: "PORCENTAJE_MIN", orden: 4 }),
      ],
      ctx({ numContenedores: 1 }),
    );
    expect(r.pendientes.map((p) => [p.concepto, p.causa])).toEqual([
      ["AGE", "BASE_DO"],
      ["ESPEJO", "COSTO_PROVEEDOR"],
      ["SIN_TRAMOS", "TARIFARIO"],
      ["SIN_PCT", "BASE_DO"],
    ]);
    const conCif = calcularLineasTarifa(
      [item({ concepto: "SIN_PCT", tipoCalculo: "PORCENTAJE_MIN" })],
      ctx({ valorCif: 1_000_000n }),
    );
    expect(conCif.pendientes.map((p) => p.causa)).toEqual(["TARIFARIO"]);
  });
});

describe("ejemploTramo", () => {
  const ESCALAS: TramoTarifa[] = [
    { hasta: 10, valor: "500000" },
    { hasta: 20, valor: "250000" },
    { hasta: null, valor: "200000" },
  ];

  it("12 unidades caen en la escala 11–20", () => {
    expect(ejemploTramo(ESCALAS, 12)).toEqual({
      rango: "11–20",
      cantidad: 12,
      valorUnitario: pesos(250_000),
      total: pesos(3_000_000),
    });
  });

  it("1 unidad: cae en la primera escala (1–10)", () => {
    expect(ejemploTramo(ESCALAS, 1)?.rango).toBe("1–10");
  });

  it("por encima del último tope cerrado: escala abierta", () => {
    expect(ejemploTramo(ESCALAS, 25)).toEqual({
      rango: "21 o más",
      cantidad: 25,
      valorUnitario: pesos(200_000),
      total: pesos(5_000_000),
    });
  });

  it("0 o negativo, sin tramos, o ningún tramo cubre la cantidad → null", () => {
    expect(ejemploTramo(ESCALAS, 0)).toBeNull();
    expect(ejemploTramo(ESCALAS, -1)).toBeNull();
    expect(ejemploTramo([], 5)).toBeNull();
    expect(ejemploTramo([{ hasta: 2, valor: "1000" }], 5)).toBeNull();
  });

  it("Polyrec ZF: 1 contenedor 300.000; 2 contenedores 250.000 c/u = 500.000", () => {
    const polyrecZf: TramoTarifa[] = [
      { hasta: 1, valor: "300000" },
      { hasta: null, valor: "250000" },
    ];
    expect(ejemploTramo(polyrecZf, 1)).toEqual({ rango: "1", cantidad: 1, valorUnitario: pesos(300_000), total: pesos(300_000) });
    expect(ejemploTramo(polyrecZf, 2)).toEqual({
      rango: "2 o más",
      cantidad: 2,
      valorUnitario: pesos(250_000),
      total: pesos(500_000),
    });
  });
});

// Fase centavos, hito P3-a (A.9): minimos y tramos son PESOS texto; se leen con
// centavosDeTexto (heredado "300000", canónico con centavos "300000.45" y ".00").
describe("lectores de mínimos y tramos (PESOS texto → centavos)", () => {
  it("valorTramo: heredado, con centavos y con .00", () => {
    expect(valorTramo({ hasta: 1, valor: "300000" })).toBe(pesos(300_000));
    expect(valorTramo({ hasta: 1, valor: "300000.45" })).toBe(30_000_045n);
    expect(valorTramo({ hasta: 1, valor: "300000.00" })).toBe(pesos(300_000));
    expect(valorTramo({ hasta: 1, valor: "300000.5" })).toBe(30_000_050n);
  });

  it("valorTramo: ilegible o negativo → null (nunca un número inventado)", () => {
    expect(valorTramo({ hasta: 1, valor: "300.000" })).toBeNull();
    expect(valorTramo({ hasta: 1, valor: "300000,45" })).toBeNull();
    expect(valorTramo({ hasta: 1, valor: "300000.455" })).toBeNull();
    expect(valorTramo({ hasta: 1, valor: "1e5" })).toBeNull();
    expect(valorTramo({ hasta: 1, valor: "-1" })).toBeNull();
  });

  it("minimoDe: heredado, con centavos, con .00, ausente e ilegible", () => {
    expect(minimoDe({ CONTENEDOR_20: "300000" }, "CONTENEDOR_20")).toEqual({ ok: true, valor: pesos(300_000) });
    expect(minimoDe({ CONTENEDOR_20: "300000.45" }, "CONTENEDOR_20")).toEqual({ ok: true, valor: 30_000_045n });
    expect(minimoDe({ CONTENEDOR_20: "300000.00" }, "CONTENEDOR_20")).toEqual({ ok: true, valor: pesos(300_000) });
    expect(minimoDe({ CONTENEDOR_20: "300000" }, "SUELTA")).toEqual({ ok: true, valor: null });
    expect(minimoDe(null, "SUELTA")).toEqual({ ok: true, valor: null });
    expect(minimoDe({ SUELTA: "370.000" }, "SUELTA")).toEqual({ ok: false, raw: "370.000" });
  });

  it("un tramo \"300000.00\" ya NO se ignora: calcula igual que \"300000\"", () => {
    const conPuntoCero = [item({ concepto: "T", tipoCalculo: "POR_TRAMO", unidad: "CONTENEDOR", tramos: [{ hasta: null, valor: "300000.00" }] })];
    expect(calcularLineasTarifa(conPuntoCero, ctx({ numContenedores: 2 })).total).toBe(pesos(600_000));
  });

  it("tramo con centavos: total exacto al centavo", () => {
    const conCentavos = [item({ concepto: "T", tipoCalculo: "POR_TRAMO", unidad: "CONTENEDOR", tramos: [{ hasta: null, valor: "250000.45" }] })];
    const r = calcularLineasTarifa(conCentavos, ctx({ numContenedores: 3 }));
    expect(r.lineas[0].valorUnitario).toBe(25_000_045n);
    expect(r.total).toBe(75_000_135n);
    expect(r.lineas[0].detalle).toBe("250.000,45 × 3 contenedores (tramo 1 o más contenedores)");
  });

  it("tramo ilegible → pendiente visible con el motivo", () => {
    const malo = [item({ concepto: "T", tipoCalculo: "POR_TRAMO", unidad: "CONTENEDOR", tramos: [{ hasta: null, valor: "250.000" }] })];
    const r = calcularLineasTarifa(malo, ctx({ numContenedores: 1 }));
    expect(r.lineas).toEqual([]);
    expect(r.pendientes[0].motivo).toBe('Un tramo tiene un valor ilegible ("250.000"); corrige el tarifario');
  });

  it("mínimo con .00 y con centavos se aplica; ilegible → pendiente (antes se ignoraba en silencio)", () => {
    const base = { concepto: "U", tipoCalculo: "PORCENTAJE_MIN" as const, porcentajeBps: 37 };
    const c = ctx({ valorCif: pesos(10_000_000), tipoCarga: "CONTENEDOR_20" });
    expect(calcularLineasTarifa([item({ ...base, minimos: { CONTENEDOR_20: "498000.00" } })], c).total).toBe(pesos(498_000));
    expect(calcularLineasTarifa([item({ ...base, minimos: { CONTENEDOR_20: "498000.45" } })], c).total).toBe(49_800_045n);
    const r = calcularLineasTarifa([item({ ...base, minimos: { CONTENEDOR_20: "498.000" } })], c);
    expect(r.lineas).toEqual([]);
    expect(r.pendientes[0].motivo).toBe('El mínimo de contenedor de 20′ tiene un valor ilegible ("498.000"); corrige el tarifario');
  });

  it("ejemploTramo (contrato A.9): heredado, canónico con centavos, .00 e ilegible", () => {
    expect(ejemploTramo([{ hasta: null, valor: "250000" }], 2)).toEqual({ rango: "1 o más", cantidad: 2, valorUnitario: pesos(250_000), total: pesos(500_000) });
    expect(ejemploTramo([{ hasta: null, valor: "250000.00" }], 2)?.total).toBe(pesos(500_000));
    expect(ejemploTramo([{ hasta: null, valor: "250000.50" }], 3)).toEqual({ rango: "1 o más", cantidad: 3, valorUnitario: 25_000_050n, total: 75_000_150n });
    expect(ejemploTramo([{ hasta: null, valor: "250000," }], 3)).toBeNull();
    expect(ejemploTramo([{ hasta: null, valor: "250000" }], 1.5)).toBeNull();
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

describe("vigenteEn + fechaCalendarioBogota (F5) — 'hoy' es el día calendario en Bogotá, no el instante UTC", () => {
  const litoplas = { vigenteDesde: new Date("2026-02-02T00:00:00.000Z"), vigenteHasta: new Date("2027-01-31T00:00:00.000Z") };

  // `vigenteEn` no cambia (compara por día, en UTC — a propósito): el fix es
  // pasarle el "hoy" ya convertido al día calendario de Bogotá.
  it("vigenteHasta 2027-01-31: sigue vigente a las 23:30 Bogotá y ya no a las 00:30 Bogotá del día siguiente", () => {
    // 2027-01-31 23:30 Bogotá = 2027-02-01 04:30Z (Colombia es UTC−5)
    expect(vigenteEn(litoplas, fechaCalendarioBogota(new Date("2027-02-01T04:30:00.000Z")))).toBe(
      true,
    );
    // 2027-02-01 00:30 Bogotá = 2027-02-01 05:30Z
    expect(vigenteEn(litoplas, fechaCalendarioBogota(new Date("2027-02-01T05:30:00.000Z")))).toBe(
      false,
    );
  });

  it("vigenteDesde 2026-09-22: no vigente a las 20:00 Bogotá del día anterior", () => {
    const tarifario = {
      vigenteDesde: new Date("2026-09-22T00:00:00.000Z"),
      vigenteHasta: new Date("2026-12-31T00:00:00.000Z"),
    };
    // 2026-09-21 20:00 Bogotá = 2026-09-22 01:00Z
    expect(
      vigenteEn(tarifario, fechaCalendarioBogota(new Date("2026-09-22T01:00:00.000Z"))),
    ).toBe(false);
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

// A.2: los bigint que no son dinero (tasas, cantidades) nunca viajan en un DTO;
// el dinero del motor sale por el serializador único como PESOS con 2 decimales.
describe("DTO del motor serializado (fase centavos)", () => {
  it("valores en pesos '100000.00', mínimos/tramos intactos, sin llaves de tasas", () => {
    const r = calcularLineasTarifa(CW, ctx({ valorCif: pesos(50_000_000), tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 1 }));
    const json = JSON.parse(stringifyDinero({ resultado: r })) as {
      resultado: { total: string; lineas: { valor: string; valorUnitario: string }[]; manuales: unknown[] };
    };
    expect(json.resultado.total).toBe(stringifyDinero(r.total).replaceAll('"', ""));
    expect(json.resultado.lineas.find((l) => l.valor === "498000.00")).toBeDefined();
    const texto = stringifyDinero({ resultado: r });
    expect(texto).not.toMatch(/tasaIva|tasa4x1000/);
    // Los ítems del tarifario (como los devuelve la API): valor en pesos con 2 decimales,
    // mínimos en PESOS texto tal como se guardan (canónico).
    const items = stringifyDinero(CW);
    expect(items).toContain('"CONTENEDOR_20":"498000"');
    expect(items).toContain('"valor":"100000.00"');
  });
});
