/**
 * `pago-bloque-calculo.ts` — modal "Pagar en bloque" (diseño CxP v2 §D.2).
 * Cifras del caso real (§H): FE-12334 433.361, FE-12481 464.077, FE-12539
 * 461.377 (Almacarga, DOs 26-0069 / 26-0238 / 26-0301) — total 1.358.815,
 * costo Bancolombia/PSE 3.900. Tolerancia 0 pesos.
 */
import { describe, expect, it } from "vitest";

import {
  advertenciasSeleccion,
  costoPorDoDeLaSeleccion,
  desmarcarTodas,
  marcarTodas,
  opcionesCosto,
  seleccionInicial,
  textoConfirmacion,
  textoCostoBancario,
  totalesSeleccion,
  validarMonto,
  type SeleccionBloque,
  faltanteAbono,
  yaPagado,
} from "./pago-bloque-calculo";

import type { FacturaElegibleJson } from "@/lib/cxp/contratos-api";

// ─── Fixture: caso real Almacarga (§H) ───────────────────────────────────────

function fe(overrides: Partial<FacturaElegibleJson> & Pick<FacturaElegibleJson, "id">): FacturaElegibleJson {
  return {
    numFactura: overrides.numFactura ?? "FE-00000",
    numFacturaVisible: overrides.numFacturaVisible ?? "FE 00000",
    valor: "0",
    aplicado: "0",
    ajustes: "0",
    compensado: "0",
    saldo: "0",
    estado: "REGISTRADA",
    fecha: "2026-09-01",
    moneda: "COP",
    valorOrigen: null,
    trm: null,
    tramiteId: "do-x",
    tramiteConsecutivo: "DO.BAQ26-0000",
    doCorto: "26-0000",
    tramiteEstado: "EN_TRAMITE",
    marca: null,
    clienteId: "cliente-litoplas",
    clienteNombre: "LITOPLAS SA",
    beneficiarioId: "ben-almacarga",
    beneficiarioNombre: "ALMACARGA",
    repercutible: true,
    saldoTramite: "0",
    pagable: true,
    motivoNoPagable: null,
    advertencias: [],
    puedeAbsorberCosto: false,
    conciliacionPendiente: false,
    tieneAnticipoAplicado: true,
    facturadaAlCliente: null,
    ...overrides,
  };
}

const FE_12334 = fe({
  id: "f-12334",
  numFactura: "FE-12334",
  numFacturaVisible: "FE 12334",
  saldo: "433361",
  tramiteId: "do-0069",
  tramiteConsecutivo: "DO.BAQ26-0069",
  doCorto: "26-0069",
  puedeAbsorberCosto: false, // ya facturado / cliente CONCEPTOS_IVA
});

const FE_12481 = fe({
  id: "f-12481",
  numFactura: "FE-12481",
  numFacturaVisible: "FE 12481",
  saldo: "464077",
  tramiteId: "do-0238",
  tramiteConsecutivo: "DO.BAQ26-0238",
  doCorto: "26-0238",
  puedeAbsorberCosto: false,
  advertencias: [
    {
      codigo: "ANTICIPO_INSUFICIENTE",
      mensaje: "El DO 26-0238 queda en −$161.377: Galcomex pone la diferencia.",
    },
  ],
});

const FE_12539 = fe({
  id: "f-12539",
  numFactura: "FE-12539",
  numFacturaVisible: "FE 12539",
  saldo: "461377",
  tramiteId: "do-0301",
  tramiteConsecutivo: "DO.BAQ26-0301",
  doCorto: "26-0301",
  puedeAbsorberCosto: true, // el único DO aún no facturado al cliente
});

const FACTURAS_ALMACARGA: FacturaElegibleJson[] = [FE_12334, FE_12481, FE_12539];

const FE_NO_PAGABLE = fe({
  id: "f-cerrada",
  numFactura: "FE-99999",
  saldo: "100000",
  tramiteId: "do-cerrado",
  doCorto: "26-0500",
  pagable: false,
  motivoNoPagable: { codigo: "DO_CERRADO", mensaje: "DO cerrado" },
});

// ─── seleccionInicial / marcarTodas / desmarcarTodas ─────────────────────────

describe("seleccionInicial", () => {
  it("marca todas las pagables con monto = saldo; ignora las no pagables", () => {
    const facturas = [...FACTURAS_ALMACARGA, FE_NO_PAGABLE];
    const sel = seleccionInicial(facturas, false);
    expect(sel).toEqual({
      "f-12334": "433361",
      "f-12481": "464077",
      "f-12539": "461377",
    });
    expect(sel["f-cerrada"]).toBeUndefined();
  });

  it("RF-23: si conciliacionPendiente, abre sin nada marcado", () => {
    expect(seleccionInicial(FACTURAS_ALMACARGA, true)).toEqual({});
  });

  it("marcarTodas / desmarcarTodas", () => {
    expect(marcarTodas(FACTURAS_ALMACARGA)).toEqual({
      "f-12334": "433361",
      "f-12481": "464077",
      "f-12539": "461377",
    });
    expect(desmarcarTodas()).toEqual({});
  });
});

// ─── validarMonto ─────────────────────────────────────────────────────────────

describe("validarMonto", () => {
  const saldo = 464_077n;

  it("acepta un monto entero > 0 y ≤ saldo (abono incluido)", () => {
    expect(validarMonto("464077", saldo)).toEqual({ ok: true, monto: 464_077n });
    expect(validarMonto("200000", saldo)).toEqual({ ok: true, monto: 200_000n });
  });

  it("rechaza vacío, cero, negativo y no numérico", () => {
    expect(validarMonto("", saldo).ok).toBe(false);
    expect(validarMonto("0", saldo).ok).toBe(false);
    expect(validarMonto("-100", saldo).ok).toBe(false);
    expect(validarMonto("abc", saldo).ok).toBe(false);
  });

  it('rechaza un monto mayor que el saldo: "No puedes pagar más de lo que falta ($X)."', () => {
    const r = validarMonto("500000", saldo);
    expect(r).toEqual({ ok: false, mensaje: "No puedes pagar más de lo que falta ($464.077)." });
  });
});

// ─── totalesSeleccion ─────────────────────────────────────────────────────────

describe("totalesSeleccion", () => {
  it("3 facturas de 3 DOs por $1.358.815 (caso real §H), sin abonos", () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const t = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    expect(t.totalSeleccionado).toBe(1_358_815n);
    expect(t.nFacturas).toBe(3);
    expect(t.nDOs).toBe(3);
    expect(t.abonos).toEqual([]);
  });

  it("un monto menor al saldo queda como abono (Abonada)", () => {
    const sel: SeleccionBloque = { "f-12481": "200000" };
    const t = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    expect(t.totalSeleccionado).toBe(200_000n);
    expect(t.nFacturas).toBe(1);
    expect(t.nDOs).toBe(1);
    expect(t.abonos).toEqual([{ facturaId: "f-12481", numFactura: "FE 12481", faltante: 264_077n }]);
  });

  it("ignora entradas en 0, vacías o de facturas que ya no están en la lista", () => {
    const sel: SeleccionBloque = { "f-12334": "0", "f-12481": "", "f-fantasma": "999" };
    const t = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    expect(t.totalSeleccionado).toBe(0n);
    expect(t.nFacturas).toBe(0);
    expect(t.nDOs).toBe(0);
  });

  it("dos facturas del mismo DO cuentan una sola vez en nDOs", () => {
    const otraDelMismoDo = fe({
      id: "f-otra-0238",
      saldo: "50000",
      tramiteId: "do-0238",
      doCorto: "26-0238",
    });
    const facturas = [FE_12481, otraDelMismoDo];
    const sel: SeleccionBloque = { "f-12481": "464077", "f-otra-0238": "50000" };
    const t = totalesSeleccion(facturas, sel);
    expect(t.nDOs).toBe(1);
    expect(t.nFacturas).toBe(2);
  });
});

// ─── advertenciasSeleccion ────────────────────────────────────────────────────

describe("advertenciasSeleccion", () => {
  it('incluye "El DO 26-0238 queda en −$161.377…" solo si esa factura está seleccionada', () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const advertencias = advertenciasSeleccion(FACTURAS_ALMACARGA, sel);
    expect(advertencias).toEqual([
      { codigo: "ANTICIPO_INSUFICIENTE", mensaje: "El DO 26-0238 queda en −$161.377: Galcomex pone la diferencia." },
    ]);
  });

  it("sin esa factura en la selección, no aparece la advertencia", () => {
    const sel: SeleccionBloque = { "f-12334": "433361" };
    expect(advertenciasSeleccion(FACTURAS_ALMACARGA, sel)).toEqual([]);
  });

  it("no repite la misma advertencia si dos facturas del mismo DO la traen duplicada", () => {
    const gemela = fe({
      id: "f-12481-b",
      saldo: "10000",
      tramiteId: "do-0238",
      doCorto: "26-0238",
      advertencias: FE_12481.advertencias,
    });
    const facturas = [FE_12481, gemela];
    const sel: SeleccionBloque = { "f-12481": "464077", "f-12481-b": "10000" };
    expect(advertenciasSeleccion(facturas, sel)).toHaveLength(1);
  });
});

// ─── opcionesCosto ────────────────────────────────────────────────────────────

describe("opcionesCosto", () => {
  it("con un DO que puede absorber, ofrece las 3 opciones y el defecto es PRIMER_DO (ese DO)", () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const r = opcionesCosto(FACTURAS_ALMACARGA, sel);
    expect(r.defecto).toBe("PRIMER_DO");
    expect(r.primerDoCorto).toBe("26-0301");
    expect(r.notaSoloGalcomex).toBeNull();
    expect(r.opciones.map((o) => o.value)).toEqual(["PRIMER_DO", "PRORRATEADO", "GALCOMEX"]);
    expect(r.opciones[0]!.label).toBe("Al primer DO que aún se puede cobrar (26-0301)");
  });

  it("si ningún DO de la selección puede absorber, solo aparece Galcomex con la nota", () => {
    const sel: SeleccionBloque = { "f-12334": "433361", "f-12481": "464077" }; // ninguno puedeAbsorberCosto
    const r = opcionesCosto(FACTURAS_ALMACARGA, sel);
    expect(r.defecto).toBe("GALCOMEX");
    expect(r.primerDoCorto).toBeNull();
    expect(r.opciones).toEqual([{ value: "GALCOMEX", label: "Galcomex (no se cobra a nadie)" }]);
    expect(r.notaSoloGalcomex).toMatch(/lo asume Galcomex/);
  });

  it("sin selección, no hay DO que pueda absorber (lista vacía)", () => {
    const r = opcionesCosto(FACTURAS_ALMACARGA, {});
    expect(r.opciones).toEqual([{ value: "GALCOMEX", label: "Galcomex (no se cobra a nadie)" }]);
  });
});

describe("costoPorDoDeLaSeleccion", () => {
  it("PRIMER_DO: todo el costo al único DO que puede absorberlo (26-0301)", () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const r = costoPorDoDeLaSeleccion(FACTURAS_ALMACARGA, sel, "PRIMER_DO", 3_900n);
    const total = r.reduce((s, x) => s + x.costo, 0n);
    expect(total).toBe(3_900n);
    expect(r.find((x) => x.doCorto === "26-0301")?.costo).toBe(3_900n);
    expect(r.find((x) => x.doCorto === "26-0069")?.costo).toBe(0n);
  });

  it("GALCOMEX: todo en 0", () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const r = costoPorDoDeLaSeleccion(FACTURAS_ALMACARGA, sel, "GALCOMEX", 3_900n);
    expect(r.every((x) => x.costo === 0n)).toBe(true);
  });
});

// ─── textoCostoBancario / textoConfirmacion ──────────────────────────────────

describe("textoCostoBancario", () => {
  it("null si no hay costo", () => {
    expect(textoCostoBancario(0n, "GALCOMEX", null)).toBeNull();
  });

  it("Galcomex", () => {
    expect(textoCostoBancario(3_900n, "GALCOMEX", null)).toBe(
      "Costo de la transferencia: $3.900 (lo asume Galcomex).",
    );
  });

  it("Primer DO", () => {
    expect(textoCostoBancario(3_900n, "PRIMER_DO", "26-0301")).toBe(
      "Costo de la transferencia: $3.900 (lo asume el DO 26-0301).",
    );
  });

  it("Prorrateado", () => {
    expect(textoCostoBancario(3_900n, "PRORRATEADO", null)).toBe(
      "Costo de la transferencia: $3.900 (se reparte entre los DOs que pueden absorberlo).",
    );
  });
});

describe("textoConfirmacion (CA-05)", () => {
  it('"Vas a pagar 3 facturas de 3 DOs por $1.358.815 a ALMACARGA. Costo de la transferencia: $3.900 (lo asume el DO 26-0301). ¿Confirmas?"', () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const totales = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    const texto = textoConfirmacion({
      nombreProveedor: "ALMACARGA",
      totales,
      costoBancario: 3_900n,
      costoAsumidoPor: "PRIMER_DO",
      primerDoCorto: "26-0301",
      conciliacionPendiente: false,
    });
    expect(texto).toBe(
      "Vas a pagar 3 facturas de 3 DOs por $1.358.815 a ALMACARGA. " +
        "Costo de la transferencia: $3.900 (lo asume el DO 26-0301). ¿Confirmas?",
    );
  });

  it('con un abono: "1 queda abonada: faltan $200.000."', () => {
    const sel: SeleccionBloque = { "f-12481": "200000" };
    const totales = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    const texto = textoConfirmacion({
      nombreProveedor: "ALMACARGA",
      totales,
      costoBancario: 0n,
      costoAsumidoPor: "GALCOMEX",
      primerDoCorto: null,
      conciliacionPendiente: false,
    });
    expect(texto).toBe(
      "Vas a pagar 1 factura de 1 DO por $200.000 a ALMACARGA. 1 queda abonada: faltan $264.077. ¿Confirmas?",
    );
  });

  it("con dos abonos: plural y unión con «y»", () => {
    const sel: SeleccionBloque = { "f-12334": "300000", "f-12481": "200000" };
    const totales = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    const texto = textoConfirmacion({
      nombreProveedor: "ALMACARGA",
      totales,
      costoBancario: 0n,
      costoAsumidoPor: "GALCOMEX",
      primerDoCorto: null,
      conciliacionPendiente: false,
    });
    expect(texto).toContain("2 quedan abonadas: faltan $133.361 y $264.077.");
  });

  it("RF-23: agrega la pregunta de conciliación pendiente al final", () => {
    const sel = seleccionInicial(FACTURAS_ALMACARGA, false);
    const totales = totalesSeleccion(FACTURAS_ALMACARGA, sel);
    const texto = textoConfirmacion({
      nombreProveedor: "ALMACARGA",
      totales,
      costoBancario: 0n,
      costoAsumidoPor: "GALCOMEX",
      primerDoCorto: null,
      conciliacionPendiente: true,
    });
    expect(texto).toContain(
      "La cartera de ALMACARGA aún no está conciliada. ¿Revisaste en tu Excel que ninguna de estas facturas ya se pagó?",
    );
  });
});

describe("faltanteAbono / yaPagado — filas del modal «Pagar en bloque» (§D.2)", () => {
  it("FE 12602 Abonada (total 300.000, saldo 200.000): Ya pagado 100.000; con 100.000 quedará debiendo 100.000", () => {
    expect(yaPagado({ valor: "300000", saldo: "200000" })).toBe("100000");
    expect(faltanteAbono("100000", "200000")).toBe(100_000n);
  });
  it("pagar todo el saldo, vacío, cero o más que el saldo no es abono", () => {
    expect(faltanteAbono("200000", "200000")).toBeNull();
    expect(faltanteAbono("", "200000")).toBeNull();
    expect(faltanteAbono("0", "200000")).toBeNull();
    expect(faltanteAbono("250000", "200000")).toBeNull();
    expect(faltanteAbono("abc", "200000")).toBeNull();
  });
});

// ─── Costo del bloque y asesoría (NO SE COBRA) ───────────────────────────────

describe("opcionesCosto / costoPorDoDeLaSeleccion con un DO de solo asesoría", () => {
  // DO 26-0400 (primero por consecutivo): solo la asesoría NO SE COBRA.
  // DO 26-0401: transporte que se cobra. Los dos con borrador abierto.
  const ASESORIA = fe({
    id: "f-ase",
    saldo: "300000",
    tramiteId: "do-0400",
    doCorto: "26-0400",
    repercutible: false,
    puedeAbsorberCosto: true,
  });
  const TRANSPORTE = fe({
    id: "f-tr",
    saldo: "1000000",
    tramiteId: "do-0401",
    doCorto: "26-0401",
    repercutible: true,
    puedeAbsorberCosto: true,
  });
  const facturas = [ASESORIA, TRANSPORTE];
  const sel: SeleccionBloque = { "f-ase": "300000", "f-tr": "1000000" };

  it("el costo va al primer DO con algo que se cobra, no al de solo asesoría", () => {
    const r = opcionesCosto(facturas, sel);
    expect(r.defecto).toBe("PRIMER_DO");
    expect(r.primerDoCorto).toBe("26-0401");
    const costos = costoPorDoDeLaSeleccion(facturas, sel, "PRIMER_DO", 3_900n);
    expect(costos.find((x) => x.doCorto === "26-0400")?.costo).toBe(0n);
    expect(costos.find((x) => x.doCorto === "26-0401")?.costo).toBe(3_900n);
  });

  it("si el bloque es todo asesoría, solo queda Galcomex", () => {
    const r = opcionesCosto(facturas, { "f-ase": "300000" });
    expect(r.defecto).toBe("GALCOMEX");
    expect(r.primerDoCorto).toBeNull();
  });

  it("un DO con asesoría Y transporte sí puede absorberlo", () => {
    const transporteMismoDo = fe({ ...TRANSPORTE, id: "f-tr2", tramiteId: "do-0400", doCorto: "26-0400" });
    const r = opcionesCosto([ASESORIA, transporteMismoDo], { "f-ase": "300000", "f-tr2": "1000000" });
    expect(r.primerDoCorto).toBe("26-0400");
  });

  it("PRORRATEADO pesa solo lo que se cobra: DO1 (T 100.000 + asesoría 900.000) y DO2 (T 1.000.000), costo 7.300 → 664 y 6.636, no 3.650 y 3.650", () => {
    const t1 = fe({ ...TRANSPORTE, id: "f-t1", saldo: "100000", tramiteId: "do-0400", doCorto: "26-0400" });
    const a1 = fe({ ...ASESORIA, id: "f-a1", saldo: "900000" });
    const facturasMixtas = [t1, a1, TRANSPORTE];
    const selMixta: SeleccionBloque = { "f-t1": "100000", "f-a1": "900000", "f-tr": "1000000" };
    const costos = costoPorDoDeLaSeleccion(facturasMixtas, selMixta, "PRORRATEADO", 7_300n);
    expect(costos.map((c) => [c.doCorto, c.costo])).toEqual([
      ["26-0400", 664n],
      ["26-0401", 6_636n],
    ]);
  });
});
