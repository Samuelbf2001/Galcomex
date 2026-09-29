import { describe, expect, it } from "vitest";

import {
  CONFIG_OC_COTIZACION_DEFECTO,
  armarCotizacion,
  configOcCotizacionDe,
  textoNotaAgencia,
  type EntradaCotizacion,
} from "@/lib/cotizacion/calculo";

/**
 * B7 (Diseño B) — la cotización usa LA MISMA cuenta que la factura CONCEPTOS_IVA
 * (`calcularFacturaConceptos`). Casos dorados de facturas reales 2026, con
 * tolerancia 0. `$` = pesos como BigInt.
 */
const $ = (n: number) => BigInt(n);

const BASE: Omit<EntradaCotizacion, "conceptos" | "terceros"> = {
  tasaIva: 19n,
  tasa4x1000: 400n,
  reteIvaPorcentaje: 15,
  configOc: CONFIG_OC_COTIZACION_DEFECTO,
  agenciamiento: { agencia: null, valor: null },
};

const concepto = (nombre: string, valor: number, aplicaIva = true) => ({ concepto: nombre, valor: $(valor), aplicaIva });
const tercero = (nombre: string, valor: number) => ({ concepto: nombre, valor: $(valor), numSoporte: null });

describe("armarCotizacion — casos dorados", () => {
  it("DO.26-0171 (FV-2-18589, Polyrec ZF): 407.000 + IVA 77.330 − ReteIVA 11.600 = 472.730; OC 407.000; nota Coldex 172.550", () => {
    const r = armarCotizacion({
      ...BASE,
      conceptos: [
        concepto("LOGÍSTICA DE SUPERVISIÓN Y DESPACHO", 255_000),
        concepto("DOCUMENTACIÓN", 20_000),
        concepto("PAPELERÍA", 12_000),
        concepto("SISTEMATIZACIÓN", 20_000),
        concepto("SERVICIO LOGÍSTICO", 100_000),
      ],
      terceros: [],
      agenciamiento: { agencia: "COLDEX", valor: 145_000n },
    });
    expect(r.baseConceptos).toBe($(407_000));
    expect(r.iva).toBe($(77_330));
    expect(r.retenciones).toBe($(11_600));
    expect(r.impuesto4x1000).toBe(0n);
    expect(r.totalAGirar).toBe($(472_730));
    expect(r.valorParaOc.valor).toBe($(407_000));
    expect(r.notaAgencia).toEqual({ agencia: "COLDEX", valor: $(145_000), iva: $(27_550), total: $(172_550) });
    expect(textoNotaAgencia(r.notaAgencia!)).toBe(
      "Orden de compra aparte para COLDEX: 145.000 + IVA 27.550 = 172.550 (la factura la hace Coldex)",
    );
    // El IVA por ítem suma el IVA total (cada uno redondeado al peso).
    expect(r.conceptos.map((c) => c.iva)).toEqual([$(48_450), $(3_800), $(2_280), $(3_800), $(19_000)]);
  });

  it("DO.BGT26-0228 (FV-2-18716, Polyrec S.A.S.): 797.000 + IVA 151.430 − ReteIVA 22.715 = 925.715 (el fondo real fue 967.000: sobraron 41.285)", () => {
    const r = armarCotizacion({
      ...BASE,
      conceptos: [
        concepto("SERVICIO LOGÍSTICO", 297_000),
        concepto("SERVICIO LOGÍSTICO (despacho)", 180_000),
        concepto("COORDINACIÓN DE INSPECCIÓN", 180_000),
        concepto("DOCUMENTACIÓN", 20_000),
        concepto("SISTEMATIZACIÓN", 20_000),
        concepto("SERVICIO LOGÍSTICO", 100_000),
      ],
      terceros: [],
    });
    expect(r.baseConceptos).toBe($(797_000));
    expect(r.iva).toBe($(151_430));
    expect(r.retenciones).toBe($(22_715));
    expect(r.totalAGirar).toBe($(925_715));
    expect($(967_000) - r.totalAGirar).toBe($(41_285));
  });

  it("BAQ-18385 (Litoplas): con terceros el 4x1000 sale de ellos y el total a girar es el de la factura (1.487.623)", () => {
    const entrada = {
      ...BASE,
      conceptos: [
        concepto("HONORARIOS", 200_000),
        concepto("DOCUMENTACIÓN", 20_000),
        concepto("SISTEMATIZACIÓN", 20_000),
        concepto("SERVICIO LOGÍSTICO", 100_000),
      ],
      terceros: [
        tercero("ALMACENAJE ALMACARGA FACT. FE 11298", 502_801),
        tercero("LIBERACIÓN TAMPA CARGO FACT. 71388844", 99_484),
        tercero("PAGO VUCE FACT. REG-50151039", 486_075),
      ],
    };
    const r = armarCotizacion(entrada);
    expect(r.baseTerceros).toBe($(1_088_360));
    expect(r.impuesto4x1000).toBe($(4_353));
    expect(r.iva).toBe($(64_600));
    expect(r.retenciones).toBe($(9_690));
    expect(r.totalAGirar).toBe($(1_487_623));
    // OC por defecto: servicio + terceros, sin IVA, sin ReteIVA, sin 4x1000.
    expect(r.valorParaOc).toMatchObject({ servicio: $(340_000), terceros: $(1_088_360), cuatroXMil: $(4_353), valor: $(1_428_360) });
    // Configurable por empresa.
    expect(armarCotizacion({ ...entrada, configOc: { base: "SOLO_SERVICIO", incluye4x1000: false } }).valorParaOc.valor).toBe($(340_000));
    expect(armarCotizacion({ ...entrada, configOc: { base: "SERVICIO_Y_TERCEROS", incluye4x1000: true } }).valorParaOc.valor).toBe($(1_432_713));
    // La OC no cambia el total a girar.
    expect(armarCotizacion({ ...entrada, configOc: { base: "SOLO_SERVICIO", incluye4x1000: false } }).totalAGirar).toBe($(1_487_623));
  });

  it("BAQ-18357 (Litoplas, sin terceros): 400.000 + IVA 76.000 − ReteIVA 11.400 = 464.600", () => {
    const r = armarCotizacion({
      ...BASE,
      conceptos: [concepto("HONORARIOS", 200_000), concepto("DOCUMENTACIÓN", 80_000), concepto("SISTEMATIZACIÓN", 20_000), concepto("SERVICIO LOGÍSTICO", 100_000)],
      terceros: [],
    });
    expect(r.iva).toBe($(76_000));
    expect(r.retenciones).toBe($(11_400));
    expect(r.totalAGirar).toBe($(464_600));
  });

  it("DUTA (FV-2-18211, DO.CTG25-0311): 380.000 + IVA 72.200 − ReteIVA 10.830 = 441.370", () => {
    const r = armarCotizacion({
      ...BASE,
      conceptos: [concepto("SERVICIO LOGÍSTICO", 240_000), concepto("DOCUMENTACIÓN", 10_000), concepto("PAPELERÍA", 10_000), concepto("SISTEMATIZACIÓN", 20_000), concepto("SERVICIO LOGÍSTICO (otro)", 100_000)],
      terceros: [],
    });
    expect(r.totalAGirar).toBe($(441_370));
  });
});

describe("armarCotizacion — reglas", () => {
  it("un concepto sin IVA no suma IVA y una línea en cero no llega a la cotización", () => {
    const r = armarCotizacion({
      ...BASE,
      conceptos: [concepto("A", 100_000), concepto("SIN IVA", 50_000, false), concepto("CERO", 0)],
      terceros: [tercero("CERO", 0)],
    });
    expect(r.conceptos.map((c) => c.concepto)).toEqual(["A", "SIN IVA"]);
    expect(r.terceros).toEqual([]);
    expect(r.iva).toBe($(19_000));
    expect(r.conceptos.find((c) => c.concepto === "SIN IVA")!.iva).toBe(0n);
    expect(r.totalAGirar).toBe($(150_000) + $(19_000) - $(2_850));
  });

  it("sin porcentaje de ReteIVA (a mano) no descuenta nada y lo avisa", () => {
    const r = armarCotizacion({ ...BASE, reteIvaPorcentaje: null, conceptos: [concepto("A", 100_000)], terceros: [] });
    expect(r.reteIvaManual).toBe(true);
    expect(r.retenciones).toBe(0n);
    expect(r.totalAGirar).toBe($(119_000));
  });

  it("ReteIVA 0 % (LTRANS): total = subtotal × 1,19", () => {
    const r = armarCotizacion({ ...BASE, reteIvaPorcentaje: 0, conceptos: [concepto("COMISIÓN", 1_350_000)], terceros: [] });
    expect(r.reteIvaManual).toBe(false);
    expect(r.totalAGirar).toBe($(1_606_500));
  });

  it("la nota de la agencia solo sale con agencia Y agenciamiento estándar (>0)", () => {
    const con = (agenciamiento: EntradaCotizacion["agenciamiento"]) =>
      armarCotizacion({ ...BASE, conceptos: [concepto("A", 100_000)], terceros: [], agenciamiento }).notaAgencia;
    expect(con({ agencia: null, valor: null })).toBeNull();
    expect(con({ agencia: "COLDEX", valor: null })).toBeNull();
    expect(con({ agencia: "COLDEX", valor: 0n })).toBeNull();
    expect(con({ agencia: "AR_LOGISTY", valor: 100_000n })).toEqual({ agencia: "AR_LOGISTY", valor: $(100_000), iva: $(19_000), total: $(119_000) });
    expect(textoNotaAgencia(con({ agencia: "AR_LOGISTY", valor: 100_000n })!)).toBe(
      "Orden de compra aparte para AR LOGISTY: 100.000 + IVA 19.000 = 119.000 (la factura la hace AR Logisty)",
    );
  });
});

describe("configOcCotizacionDe (regla de la orden de compra, como B4)", () => {
  it("sin config o con config rota: servicio + terceros, sin 4x1000", () => {
    expect(configOcCotizacionDe(null)).toEqual({ base: "SERVICIO_Y_TERCEROS", incluye4x1000: false });
    expect(configOcCotizacionDe({})).toEqual({ base: "SERVICIO_Y_TERCEROS", incluye4x1000: false });
    expect(configOcCotizacionDe({ base: "OTRA_COSA" })).toEqual({ base: "SERVICIO_Y_TERCEROS", incluye4x1000: false });
    expect(configOcCotizacionDe({ incluye4x1000: "sí" })).toEqual({ base: "SERVICIO_Y_TERCEROS", incluye4x1000: false });
  });

  it("lee base e incluye4x1000 e ignora el resto de la config (p. ej. bloqueaAprobacion de B4)", () => {
    expect(configOcCotizacionDe({ base: "SOLO_SERVICIO", incluye4x1000: true, bloqueaAprobacion: true })).toEqual({
      base: "SOLO_SERVICIO",
      incluye4x1000: true,
    });
  });
});
