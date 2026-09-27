/**
 * Núcleo puro de CxP v2 (src/lib/cxp/saldos.ts). Tolerancia 0 pesos.
 * Cifras del caso real (diseño §H): FE-12334 433.361, FE-12481 464.077,
 * FE-12539 461.377 (Almacarga), costo PSE/Bancolombia 3.900.
 */
import { describe, expect, it } from "vitest";

import {
  candidatosNitParecido,
  claveProveedorDeFicha,
  copDesdeUsd,
  costoPorPago,
  digitosSignificativos,
  doCorto,
  dvNit,
  estadoDe,
  etiquetaDe,
  evaluarValorUsd,
  type FacturaEnValidacion,
  formatoCentavos,
  formatoPesos,
  InvarianteCxpError,
  nitBaseDe,
  normalizarNumeroFactura,
  numeroFacturaVisible,
  prorratearExacto,
  puedeAbsorberCosto,
  reglaCostoPorDefecto,
  repartirFIFO,
  resumenProveedor,
  saldoDe,
  validarAplicaciones,
} from "../saldos";

const p = (valor: bigint, aplicado = 0n, ajustes = 0n, compensado = 0n) => ({
  valor,
  aplicado,
  ajustes,
  compensado,
});

describe("saldoDe / estadoDe / etiquetaDe", () => {
  it("saldo = valor − aplicado − ajustes − compensado, exacto al peso", () => {
    expect(saldoDe(p(461_377n))).toBe(461_377n);
    expect(saldoDe(p(461_377n, 200_000n))).toBe(261_377n);
    expect(saldoDe(p(502_801n, 300_000n, 2_801n, 200_000n))).toBe(0n);
  });

  it("lanza InvarianteCxpError si el saldo queda negativo o mayor que el valor", () => {
    expect(() => saldoDe(p(100n, 101n))).toThrow(InvarianteCxpError);
    expect(() => saldoDe(p(100n, -1n))).toThrow(InvarianteCxpError);
    expect(() => saldoDe(p(100n, 50n, 30n, 21n))).toThrow(/saldo negativo/);
  });

  it("estado: = valor → REGISTRADA; 0 < saldo < valor → PARCIAL; 0 → PAGADA", () => {
    expect(estadoDe(p(461_377n))).toBe("REGISTRADA");
    expect(estadoDe(p(461_377n, 200_000n))).toBe("PARCIAL");
    expect(estadoDe(p(461_377n, 461_377n))).toBe("PAGADA");
    // CA-07v2: dos abonos que completan el valor → PAGADA
    expect(estadoDe(p(461_377n, 200_000n + 261_377n))).toBe("PAGADA");
    // Una factura de valor 0 no queda pendiente.
    expect(estadoDe(p(0n))).toBe("PAGADA");
  });

  it("etiqueta: Pendiente / Abonada / Pagada / Cruzada / Pagada con ajuste", () => {
    expect(etiquetaDe({ ...p(100n), tieneAjusteLegado: false })).toBe("Pendiente");
    expect(etiquetaDe({ ...p(100n, 40n), tieneAjusteLegado: false })).toBe("Abonada");
    expect(etiquetaDe({ ...p(100n, 100n), tieneAjusteLegado: false })).toBe("Pagada");
    expect(etiquetaDe({ ...p(100n, 0n, 0n, 100n), tieneAjusteLegado: false })).toBe("Cruzada");
    expect(etiquetaDe({ ...p(100n, 60n, 40n), tieneAjusteLegado: true })).toBe("Pagada con ajuste");
    // Abonada aunque tenga un LEGADO parcial: sigue debiendo.
    expect(etiquetaDe({ ...p(100n, 30n, 20n), tieneAjusteLegado: true })).toBe("Abonada");
  });
});

// ─── validarAplicaciones ─────────────────────────────────────────────────────

function factura(over: Partial<FacturaEnValidacion> & { id: string }): FacturaEnValidacion {
  return {
    numFactura: `FE ${over.id}`,
    tramiteId: "do-0238",
    beneficiarioId: "ben-almacarga",
    proveedorClave: "NIT:800154017",
    nombreProveedor: "ALMACARGA",
    valor: 464_077n,
    aplicado: 0n,
    ajustes: 0n,
    compensado: 0n,
    ...over,
  };
}

function mapa(...fs: FacturaEnValidacion[]): Map<string, FacturaEnValidacion> {
  return new Map(fs.map((f) => [f.id, f]));
}

describe("validarAplicaciones", () => {
  it("abono permitido: deja el saldo restante (CA-07v2: 200.000 de 461.377 → 261.377)", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "12539", monto: 200_000n }],
      facturas: mapa(factura({ id: "12539", valor: 461_377n })),
    });
    expect(r).toEqual({ ok: true, saldosDespues: new Map([["12539", 261_377n]]) });
  });

  it("pagar exactamente el saldo deja 0", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "12539", monto: 261_377n }],
      facturas: mapa(factura({ id: "12539", valor: 461_377n, aplicado: 200_000n })),
    });
    expect(r.ok && r.saldosDespues.get("12539")).toBe(0n);
  });

  it("MONTO_EXCEDE_SALDO: un peso de más se rechaza (461.378 sobre 461.377)", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "12539", monto: 461_378n }],
      facturas: mapa(factura({ id: "12539", valor: 461_377n })),
    });
    expect(r).toEqual({
      ok: false,
      errores: [{ codigo: "MONTO_EXCEDE_SALDO", numFactura: "FE 12539", monto: 461_378n, saldo: 461_377n }],
    });
  });

  it("FACTURA_SIN_SALDO: una factura pagada no se vuelve a pagar", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "12481", monto: 1n }],
      facturas: mapa(factura({ id: "12481", aplicado: 464_077n })),
    });
    expect(r).toEqual({
      ok: false,
      errores: [{ codigo: "FACTURA_SIN_SALDO", numFactura: "FE 12481", proveedor: "ALMACARGA" }],
    });
  });

  it("MONTO_INVALIDO (0 o negativo), FACTURA_NO_ENCONTRADA y FACTURA_REPETIDA", () => {
    const r = validarAplicaciones({
      solicitudes: [
        { facturaProveedorId: "a", monto: 0n },
        { facturaProveedorId: "b", monto: -5n },
        { facturaProveedorId: "x", monto: 10n },
        { facturaProveedorId: "c", monto: 10n },
        { facturaProveedorId: "c", monto: 10n },
      ],
      facturas: mapa(factura({ id: "a" }), factura({ id: "b" }), factura({ id: "c" })),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores).toEqual([
      { codigo: "MONTO_INVALIDO", numFactura: "FE a" },
      { codigo: "MONTO_INVALIDO", numFactura: "FE b" },
      { codigo: "FACTURA_NO_ENCONTRADA", facturaProveedorId: "x" },
      { codigo: "FACTURA_REPETIDA", numFactura: "FE c" },
    ]);
  });

  it("FACTURA_DE_OTRO_DO en pago simple", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "a", monto: 10n }],
      facturas: mapa(factura({ id: "a", tramiteId: "do-0226" })),
      tramiteIdPago: "do-0238",
    });
    expect(r).toEqual({ ok: false, errores: [{ codigo: "FACTURA_DE_OTRO_DO", numFactura: "FE a" }] });
  });

  it("FACTURA_SIN_PROVEEDOR si la factura no tiene ficha", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "a", monto: 10n }],
      facturas: mapa(factura({ id: "a", beneficiarioId: null, proveedorClave: null })),
    });
    expect(r).toEqual({ ok: false, errores: [{ codigo: "FACTURA_SIN_PROVEEDOR", numFactura: "FE a" }] });
  });

  it("FACTURA_DE_OTRO_PROVEEDOR: pago a Tampa Cargo con factura de Almacarga (CA-10)", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "11298", monto: 502_801n }],
      facturas: mapa(factura({ id: "11298", valor: 502_801n, numFactura: "FE-11298" })),
      proveedoresPago: [{ id: "ben-tampa", nombre: "TAMPA CARGO", clave: "NIT:890912462" }],
    });
    expect(r).toEqual({
      ok: false,
      errores: [
        {
          codigo: "FACTURA_DE_OTRO_PROVEEDOR",
          numFactura: "FE-11298",
          proveedorFactura: "ALMACARGA",
          proveedorPago: "TAMPA CARGO",
        },
      ],
    });
  });

  it("dos fichas del mismo NIT base son el mismo proveedor (varias cuentas bancarias)", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "a", monto: 10n }],
      facturas: mapa(factura({ id: "a", beneficiarioId: "ben-almacarga-cuenta-1" })),
      proveedoresPago: [{ id: "ben-almacarga-cuenta-2", nombre: "ALMACARGA", clave: "NIT:800154017" }],
    });
    expect(r.ok).toBe(true);
  });

  it("proveedorBloque: todas las facturas deben ser del proveedor del bloque", () => {
    const r = validarAplicaciones({
      solicitudes: [
        { facturaProveedorId: "a", monto: 10n },
        { facturaProveedorId: "e", monto: 10n },
      ],
      facturas: mapa(
        factura({ id: "a" }),
        factura({ id: "e", nombreProveedor: "EXPRESS", proveedorClave: "NIT:802011826", beneficiarioId: "ben-express" }),
      ),
      proveedorBloque: { clave: "NIT:800154017", nombre: "ALMACARGA" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores).toEqual([
      { codigo: "FACTURA_DE_OTRO_PROVEEDOR", numFactura: "FE e", proveedorFactura: "EXPRESS", proveedorPago: "ALMACARGA" },
      { codigo: "PROVEEDORES_MEZCLADOS", numeros: ["FE a", "FE e"] },
    ]);
  });

  it("PROVEEDORES_MEZCLADOS aunque no se indique el proveedor del pago", () => {
    const r = validarAplicaciones({
      solicitudes: [
        { facturaProveedorId: "a", monto: 10n },
        { facturaProveedorId: "e", monto: 10n },
      ],
      facturas: mapa(
        factura({ id: "a" }),
        factura({ id: "e", proveedorClave: "NIT:802011826", beneficiarioId: "ben-express" }),
      ),
    });
    expect(r).toEqual({ ok: false, errores: [{ codigo: "PROVEEDORES_MEZCLADOS", numeros: ["FE a", "FE e"] }] });
  });

  it("sin proveedorClave (ficha sin NIT colombiano) compara por BEN:<id>", () => {
    const r = validarAplicaciones({
      solicitudes: [{ facturaProveedorId: "a", monto: 10n }],
      facturas: mapa(factura({ id: "a", proveedorClave: null, beneficiarioId: "ben-x" })),
      proveedoresPago: [{ id: "ben-x", nombre: "PROVEEDOR EXTERIOR", clave: null }],
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Reparto FIFO ────────────────────────────────────────────────────────────

describe("repartirFIFO", () => {
  const f = (id: string, saldo: bigint, fecha: string, creado = fecha) => ({
    id,
    saldo,
    fecha: new Date(`${fecha}T00:00:00.000Z`),
    createdAt: new Date(`${creado}T12:00:00.000Z`),
  });

  it("reparte por fecha, luego createdAt, luego id; cada factura hasta su saldo", () => {
    const r = repartirFIFO(900_000n, [
      f("12539", 461_377n, "2026-09-10"),
      f("12334", 433_361n, "2026-08-20"),
      f("12481", 464_077n, "2026-09-01"),
    ]);
    // 900.000 − 433.361 = 466.639 → 464.077 a FE-12481 y 2.562 a FE-12539
    expect(r).toEqual({
      aplicaciones: [
        { facturaProveedorId: "12334", monto: 433_361n },
        { facturaProveedorId: "12481", monto: 464_077n },
        { facturaProveedorId: "12539", monto: 2_562n },
      ],
      sobrante: 0n,
      sinMonto: [],
    });
  });

  it("valor exacto: 433.361 + 464.077 + 461.377 = 1.358.815, sin sobrante", () => {
    const r = repartirFIFO(1_358_815n, [
      f("12334", 433_361n, "2026-08-20"),
      f("12481", 464_077n, "2026-09-01"),
      f("12539", 461_377n, "2026-09-10"),
    ]);
    expect(r.aplicaciones.map((a) => a.monto)).toEqual([433_361n, 464_077n, 461_377n]);
    expect(r.sobrante).toBe(0n);
    expect(r.sinMonto).toEqual([]);
  });

  it("sobrante > 0 cuando el valor supera Σ saldos (PAGO_EXCEDE_SALDO: 928.154 contra 464.077)", () => {
    const r = repartirFIFO(928_154n, [f("12481", 464_077n, "2026-09-01")]);
    expect(r.aplicaciones).toEqual([{ facturaProveedorId: "12481", monto: 464_077n }]);
    expect(r.sobrante).toBe(464_077n);
  });

  it("empate de fecha: createdAt y luego id", () => {
    const r = repartirFIFO(15n, [
      f("b", 10n, "2026-09-01", "2026-09-02"),
      f("c", 10n, "2026-09-01", "2026-09-01"),
      f("a", 10n, "2026-09-01", "2026-09-02"),
    ]);
    expect(r.aplicaciones).toEqual([
      { facturaProveedorId: "c", monto: 10n },
      { facturaProveedorId: "a", monto: 5n },
    ]);
    expect(r.sinMonto).toEqual(["b"]);
  });

  it("una factura sin saldo queda en sinMonto; valor negativo lanza", () => {
    expect(repartirFIFO(10n, [f("a", 0n, "2026-09-01")])).toEqual({ aplicaciones: [], sobrante: 10n, sinMonto: ["a"] });
    expect(() => repartirFIFO(-1n, [])).toThrow(InvarianteCxpError);
  });
});

// ─── Prorrateo y costo bancario (D-1) ────────────────────────────────────────

describe("prorratearExacto", () => {
  it("3.900 entre 433.361 / 464.077 / 461.377 → 1.244 / 1.332 / 1.324 (Σ = 3.900)", () => {
    const partes = prorratearExacto(3_900n, [433_361n, 464_077n, 461_377n]);
    expect(partes).toEqual([1_244n, 1_332n, 1_324n]);
    expect(partes.reduce((a, b) => a + b, 0n)).toBe(3_900n);
  });

  it("empate de restos → índice menor", () => {
    expect(prorratearExacto(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n]);
    expect(prorratearExacto(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
  });

  it("pesos todos en 0 → partes iguales; total 0 → ceros; sin pesos y total 0 → []", () => {
    expect(prorratearExacto(10n, [0n, 0n, 0n])).toEqual([4n, 3n, 3n]);
    expect(prorratearExacto(0n, [5n, 7n])).toEqual([0n, 0n]);
    expect(prorratearExacto(0n, [])).toEqual([]);
  });

  it("siempre suma exactamente el total (barrido)", () => {
    const pesos = [7n, 13n, 1n, 999_999n, 0n, 42n];
    for (let total = 0n; total < 500n; total += 7n) {
      expect(prorratearExacto(total, pesos).reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });

  it("entradas inválidas lanzan", () => {
    expect(() => prorratearExacto(-1n, [1n])).toThrow(InvarianteCxpError);
    expect(() => prorratearExacto(1n, [-1n, 2n])).toThrow(InvarianteCxpError);
    expect(() => prorratearExacto(1n, [])).toThrow(InvarianteCxpError);
  });
});

describe("costoPorPago / reglaCostoPorDefecto / puedeAbsorberCosto (D-1)", () => {
  const litoplas = [
    { valor: 433_361n, puedeAbsorber: false },
    { valor: 464_077n, puedeAbsorber: false },
    { valor: 461_377n, puedeAbsorber: false },
  ];
  const lucho = [
    { valor: 433_361n, puedeAbsorber: true },
    { valor: 464_077n, puedeAbsorber: true },
    { valor: 461_377n, puedeAbsorber: true },
  ];

  it("CA-06: ningún DO puede absorber (Litoplas, CONCEPTOS_IVA, FACTURADO) → GALCOMEX, todo 0", () => {
    expect(reglaCostoPorDefecto(litoplas)).toBe("GALCOMEX");
    expect(costoPorPago("PRIMER_DO", 3_900n, litoplas)).toEqual([0n, 0n, 0n]);
    expect(costoPorPago("PRORRATEADO", 3_900n, litoplas)).toEqual([0n, 0n, 0n]);
    expect(costoPorPago("GALCOMEX", 3_900n, litoplas)).toEqual([0n, 0n, 0n]);
  });

  it("CA-06-P: PRORRATEADO entre los que pueden → 1.244 / 1.332 / 1.324", () => {
    expect(costoPorPago("PRORRATEADO", 3_900n, lucho)).toEqual([1_244n, 1_332n, 1_324n]);
  });

  it("CA-06-L: defecto PRIMER_DO → todo al primero que puede; si el primero no puede, al segundo", () => {
    expect(reglaCostoPorDefecto(lucho)).toBe("PRIMER_DO");
    expect(costoPorPago("PRIMER_DO", 3_900n, lucho)).toEqual([3_900n, 0n, 0n]);
    const primeroFacturado = [{ ...lucho[0], puedeAbsorber: false }, lucho[1], lucho[2]];
    expect(costoPorPago("PRIMER_DO", 3_900n, primeroFacturado)).toEqual([0n, 3_900n, 0n]);
  });

  it("PRORRATEADO solo entre los que pueden (el que no puede queda en 0)", () => {
    const mixto = [lucho[0], { ...lucho[1], puedeAbsorber: false }, lucho[2]];
    const partes = costoPorPago("PRORRATEADO", 3_900n, mixto);
    expect(partes[1]).toBe(0n);
    expect(partes.reduce((a, b) => a + b, 0n)).toBe(3_900n);
    expect(partes).toEqual([1_889n, 0n, 2_011n]);
  });

  it("GALCOMEX explícito o costo 0 → todo 0; costo negativo lanza", () => {
    expect(costoPorPago("GALCOMEX", 3_900n, lucho)).toEqual([0n, 0n, 0n]);
    expect(costoPorPago("PRIMER_DO", 0n, lucho)).toEqual([0n, 0n, 0n]);
    expect(() => costoPorPago("PRIMER_DO", -1n, lucho)).toThrow(InvarianteCxpError);
  });

  it("puedeAbsorberCosto: sin CONCEPTOS_IVA y borrador ausente/BORRADOR/EN_REVISION", () => {
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: false, estadoBorrador: null })).toBe(true);
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: false, estadoBorrador: "BORRADOR" })).toBe(true);
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: false, estadoBorrador: "EN_REVISION" })).toBe(true);
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: false, estadoBorrador: "APROBADO" })).toBe(false);
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: false, estadoBorrador: "FACTURADO" })).toBe(false);
    expect(puedeAbsorberCosto({ clienteUsaConceptosIva: true, estadoBorrador: null })).toBe(false);
  });
});

// ─── Resumen del proveedor ───────────────────────────────────────────────────

describe("resumenProveedor", () => {
  it("CA-03: Almacarga antes de conciliar = 1.861.616 pendiente en 4 facturas", () => {
    const r = resumenProveedor(
      [p(502_801n), p(433_361n), p(464_077n), p(461_377n)],
      0n,
    );
    expect(r.facturado).toBe(1_861_616n);
    expect(r.pendiente).toBe(1_861_616n);
    expect(r.nPendientes).toBe(4);
  });

  it("CA-04: tras conciliar FE-11298 → pendiente 1.358.815; con abono y cruce cuadra I1", () => {
    const r = resumenProveedor(
      [p(502_801n, 502_801n), p(433_361n), p(464_077n, 100_000n), p(461_377n, 0n, 0n, 461_377n), p(10n, 6n, 4n)],
      5_000n,
    );
    expect(r).toEqual({
      facturado: 1_861_626n,
      pagado: 602_807n,
      ajustado: 4n,
      cruzado: 461_377n,
      pendiente: 797_438n,
      pagadoSinFactura: 5_000n,
      nPendientes: 1,
      nAbonadas: 1,
      nPagadas: 3,
    });
    expect(r.facturado).toBe(r.pagado + r.ajustado + r.cruzado + r.pendiente);
  });

  it("lanza si una fila está sobre-aplicada", () => {
    expect(() => resumenProveedor([p(10n, 11n)], 0n)).toThrow(InvarianteCxpError);
  });
});

// ─── Número de factura y DO ──────────────────────────────────────────────────

describe("número de factura", () => {
  it("normalizarNumeroFactura ≡ cxp_normalizar_num", () => {
    expect(normalizarNumeroFactura("FE- 12481")).toBe("FE12481");
    expect(normalizarNumeroFactura("fe 12481")).toBe("FE12481");
    expect(normalizarNumeroFactura("FE-012481")).toBe("FE012481");
    expect(normalizarNumeroFactura("FL-2026-001")).toBe("FL2026001");
    expect(normalizarNumeroFactura(" -- ")).toBe("");
  });

  it("digitosSignificativos", () => {
    expect(digitosSignificativos("FE-012481")).toBe("12481");
    expect(digitosSignificativos("12481")).toBe("12481");
    expect(digitosSignificativos("FE 000")).toBe("0");
    expect(digitosSignificativos("SIN NUMERO")).toBe("");
  });

  it("numeroFacturaVisible con la marca «FE 11298»", () => {
    expect(numeroFacturaVisible("FE- 12334", true)).toBe("FE 12334");
    expect(numeroFacturaVisible("FE-12481", true)).toBe("FE 12481");
    expect(numeroFacturaVisible("fe12481", true)).toBe("FE 12481");
    expect(numeroFacturaVisible("FE 11298", true)).toBe("FE 11298");
    expect(numeroFacturaVisible("  FE  6353 ", true)).toBe("FE 6353");
    expect(numeroFacturaVisible("12481", true)).toBe("12481");
  });

  it("numeroFacturaVisible sin la marca respeta lo digitado", () => {
    expect(numeroFacturaVisible("REG-50151039", false)).toBe("REG-50151039");
    expect(numeroFacturaVisible("71388844", false)).toBe("71388844");
    expect(numeroFacturaVisible("  FE-12481  ", false)).toBe("FE-12481");
    expect(numeroFacturaVisible("FE  12481", false)).toBe("FE 12481");
  });

  it("doCorto", () => {
    expect(doCorto(2026, 69)).toBe("26-0069");
    expect(doCorto(2026, 238)).toBe("26-0238");
    expect(doCorto(3003, 1)).toBe("03-0001");
  });
});

// ─── NIT ─────────────────────────────────────────────────────────────────────

describe("NIT sin adivinar el DV", () => {
  it("nitBaseDe: solo separa el DV si viene con guion", () => {
    expect(nitBaseDe("800154017")).toBe("800154017");
    expect(nitBaseDe("802011826")).toBe("802011826");
    expect(nitBaseDe("800.154.017-8")).toBe("800154017");
    expect(nitBaseDe("800154017-8")).toBe("800154017");
    expect(nitBaseDe("800154017 - 8")).toBe("800154017");
    expect(nitBaseDe("8001540178")).toBe("8001540178");
    expect(nitBaseDe("NIT 890.912.462-2")).toBe("890912462");
    expect(nitBaseDe("NIT: 802011826-3")).toBe("802011826");
  });

  it("una cédula de 10 dígitos no pierde dígitos", () => {
    expect(nitBaseDe("1143123456")).toBe("1143123456");
    expect(nitBaseDe("1.143.123.456")).toBe("1143123456");
  });

  it("con letras no es NIT colombiano → null; vacío o solo ceros → null", () => {
    expect(nitBaseDe("vitest-cxp-almacarga-ben-1")).toBeNull();
    expect(nitBaseDe("US-123456")).toBeNull();
    expect(nitBaseDe("")).toBeNull();
    expect(nitBaseDe("   ")).toBeNull();
    expect(nitBaseDe("000")).toBeNull();
    expect(nitBaseDe(null)).toBeNull();
  });

  it("quita ceros a la izquierda (igual que SQL ltrim)", () => {
    expect(nitBaseDe("0800154017")).toBe("800154017");
  });

  it("dvNit (DIAN): Almacarga 8, Express 3, Tampa 2", () => {
    expect(dvNit("800154017")).toBe(8);
    expect(dvNit("802011826")).toBe(3);
    expect(dvNit("890912462")).toBe(2);
    expect(dvNit("890300279")).toBe(4); // Banco de Occidente 890.300.279-4
    expect(() => dvNit("80015401X")).toThrow(RangeError);
  });

  it("candidatosNitParecido: base, base sin último dígito, base + DV", () => {
    expect(candidatosNitParecido("800154017")).toEqual(["800154017", "80015401", "8001540178"]);
    // Escrito con el DV pegado → aparece la ficha de Almacarga (sin último dígito).
    expect(candidatosNitParecido("8001540178")).toContain("800154017");
    expect(candidatosNitParecido("800.154.017-8")).toEqual(["800154017", "80015401", "8001540178"]);
    expect(candidatosNitParecido("ABC")).toEqual([]);
  });

  it("claveProveedorDeFicha ≡ cxp_clave_proveedor", () => {
    expect(claveProveedorDeFicha({ id: "b1", nitBase: "800154017" })).toBe("NIT:800154017");
    expect(claveProveedorDeFicha({ id: "b1", nitBase: null })).toBe("BEN:b1");
  });
});

// ─── USD y formatos ──────────────────────────────────────────────────────────

describe("USD", () => {
  it("copDesdeUsd: USD 131,00 × TRM 3.710,50 = 486.075,5 → 486.076 (mitad arriba)", () => {
    expect(copDesdeUsd(13_100n, 371_050n)).toBe(486_076n);
    expect(copDesdeUsd(10_000n, 400_000n)).toBe(400_000n);
    expect(copDesdeUsd(1n, 4_999n)).toBe(0n); // 0,4999 → 0
    expect(copDesdeUsd(1n, 5_000n)).toBe(1n); // 0,5 → 1
    expect(() => copDesdeUsd(-1n, 1n)).toThrow(InvarianteCxpError);
  });

  it("evaluarValorUsd: 900 % de diferencia y umbral del 5 %", () => {
    expect(evaluarValorUsd({ valorOrigenCentavos: 13_100n, trmCentavos: 371_050n, valor: 4_860_760n })).toEqual({
      sugerido: 486_076n,
      diferenciaPorcentaje: 900n,
      lejos: true,
    });
    // 5 % exacto no es "lejos"; un peso más sí.
    expect(evaluarValorUsd({ valorOrigenCentavos: 10_000n, trmCentavos: 400_000n, valor: 420_000n }).lejos).toBe(false);
    expect(evaluarValorUsd({ valorOrigenCentavos: 10_000n, trmCentavos: 400_000n, valor: 420_001n }).lejos).toBe(true);
    expect(evaluarValorUsd({ valorOrigenCentavos: 10_000n, trmCentavos: 400_000n, valor: 380_000n }).lejos).toBe(false);
    expect(evaluarValorUsd({ valorOrigenCentavos: 13_100n, trmCentavos: 371_050n, valor: 486_076n })).toEqual({
      sugerido: 486_076n,
      diferenciaPorcentaje: 0n,
      lejos: false,
    });
  });

  it("formatoPesos y formatoCentavos", () => {
    expect(formatoPesos(1_358_815n)).toBe("$1.358.815");
    expect(formatoPesos(0n)).toBe("$0");
    expect(formatoPesos(-161_377n)).toBe("−$161.377");
    expect(formatoCentavos(13_100n)).toBe("131,00");
    expect(formatoCentavos(371_050n)).toBe("3.710,50");
    expect(formatoCentavos(5n)).toBe("0,05");
  });
});
