/**
 * CxP v2 — Conciliación con el Excel maestro (diseño §E, P7b).
 *
 * Parte pura (sin BD): lectura de la hoja con filas recortadas de los Excel
 * reales de 2026 (CARTERA ALMACARGA / CARTERA EXPRESS), clasificación de cada
 * categoría, precedencia de PAGO_PREVIO_SIN_ENLAZAR, CENTAVOS con valor exacto
 * en el CSV, plan de bloques por fecha de pago y clave determinista.
 *
 * Parte de integración (Postgres local desechable, guardián M5 encendido):
 * simulacro no escribe; aplicar registra un bloque histórico por fecha con
 * costo 0; nunca paga una factura con pago previo sin enlazar; `--enlazar-previos`
 * enlaza sin plata nueva; `--importar-historico` crea la factura y la paga;
 * segunda corrida = 0 cambios; la ficha queda conciliada solo al final;
 * invariantes I1–I7 sin violaciones sobre lo creado.
 */
import "dotenv/config";

import { AgenciaAduanas, CanalPago, Ciudad, EstadoTramite, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import {
  claveBloqueHistorico,
  clasificarCartera,
  encabezadoCsv,
  type FacturaSistema,
  filasCsv,
  filasPagadasEnExcelConSaldo,
  type FilaCartera,
  leerHojaCartera,
  type PagoSistema,
  pesosDesdeCentavos,
  planificarConciliacion,
  resolverDoExcel,
  textoExactoCentavos,
  textoNombraFactura,
  type TramiteSistema,
  conciliarProveedor,
  marcarPagosSinFichaConNombre,
} from "@/lib/cxp/conciliacion";
import { verificarInvariantes } from "@/lib/cxp/invariantes";
import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import { dvNit } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";
import { crearPago } from "@/lib/pagos/service";

// ─── Utilidades de la hoja ────────────────────────────────────────────────────

/** Número de serie de Excel (sistema 1900) de una fecha-calendario. */
function serial(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Filas crudas como las devuelve `sheet_to_json(ws, { header: 1, raw: true, defval: "" })`. */
function hoja(nombre: string, filas: (string | number)[][]): unknown[][] {
  return [
    ["CARTERA", nombre, "", "", "", "C X P", 0],
    ["", "", "", "", "", "", ""],
    ["FACTURA", "PROVEEDOR", "DO", "FECHA", "TOTAL", "PAGO", ""],
    ...filas,
  ];
}

// Recorte TAL CUAL de CARTERA ALMACARGA.xlsx (filas 2026, valores y fechas reales).
const ALMACARGA_2026: (string | number)[][] = [
  ["FE 11265", "BOBST", "26-0049", serial("2026-03-20"), 436065.04, serial("2026-04-23")],
  ["FE 11298", "SRF", "26-0069", serial("2026-03-26"), 502801.45, serial("2026-04-23")],
  ["FE 11604", "COMERCIO UNIVERSAL EPS", "26-0099", serial("2026-05-08"), 490717.23, serial("2026-06-11")],
  ["FE 11831", "BOBST", "26-0141", serial("2026-06-03"), 26180, serial("2026-06-11")],
];
// Recorte TAL CUAL de CARTERA EXPRESS.xlsx.
const EXPRESS_2026: (string | number)[][] = [
  ["FE 6353", "SRF", "26-0069", serial("2026-03-12"), 99484, serial("2026-04-23")],
  ["FE 6628", "COMERCIO UNIVERSAL EPS", "26-0099", serial("2026-05-05"), 99484, serial("2026-06-11")],
];

function fs(p: Partial<FacturaSistema> & Pick<FacturaSistema, "id" | "numFactura" | "valor">): FacturaSistema {
  return {
    numeroNormalizado: p.numFactura.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    beneficiarioId: "ben-almacarga",
    tramiteId: "t-69",
    consecutivo: "DO.BAQ26-0069",
    doAnio: 2026,
    doNumero: 69,
    tramiteEstado: "FACTURADO",
    marcaDo: null,
    aplicado: 0n,
    ajustes: 0n,
    compensado: 0n,
    fecha: "2026-03-26",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...p,
  };
}

function tramite(numero: number, extra: Partial<TramiteSistema> = {}): TramiteSistema {
  return {
    id: `t-${numero}`,
    consecutivo: `DO.BAQ26-${String(numero).padStart(4, "0")}`,
    ciudad: "BAQ",
    anio: 2026,
    numero,
    estado: "FACTURADO",
    marca: null,
    ...extra,
  };
}

function pago(p: Partial<PagoSistema> & Pick<PagoSistema, "id" | "tramiteId" | "valor">): PagoSistema {
  return {
    concepto: "Pago",
    numSoporte: null,
    aplicado: 0n,
    delProveedor: false,
    sinBeneficiario: false,
    fechaRealPago: null,
    createdAt: new Date("2026-09-10T00:00:00Z"),
    ...p,
  };
}

function filaDe(r: { filas: FilaCartera[] }, factura: string): FilaCartera {
  const f = r.filas.find((x) => x.factura === factura);
  if (!f) throw new Error(`fila ${factura} no leída`);
  return f;
}

// ═════════════════════════════════════════════════════════════════════════════
// PURO
// ═════════════════════════════════════════════════════════════════════════════

describe("conciliación — lectura de la hoja (filas reales 2026)", () => {
  it("encuentra el encabezado en la fila 3 y convierte fechas sin corrimiento y TOTAL a centavos exactos", () => {
    const r = leerHojaCartera(hoja("ALMACARGA", ALMACARGA_2026), "CARTERA ALMACARGA.xlsx");
    expect(r.errores).toEqual([]);
    expect(r.filas).toHaveLength(4);
    const f = filaDe(r, "FE 11298");
    expect(f).toMatchObject({
      archivo: "CARTERA ALMACARGA.xlsx",
      fila: 5,
      numeroNormalizado: "FE11298",
      marca: "SRF",
      doTexto: "26-0069",
      doAnio: 2026,
      doNumero: 69,
      fecha: "2026-03-26",
      pago: "2026-04-23",
    });
    expect(f.totalCentavos).toBe(50_280_145n);
    expect(filaDe(r, "FE 11831").totalCentavos).toBe(2_618_000n);
  });

  it("Express: FE 6353 del DO 26-0069 pagada el 23-abr, sin centavos", () => {
    const r = leerHojaCartera(hoja("EXPRESS", EXPRESS_2026), "CARTERA EXPRESS.xlsx");
    expect(r.errores).toEqual([]);
    const f = filaDe(r, "FE 6353");
    expect(f).toMatchObject({ numeroNormalizado: "FE6353", doAnio: 2026, doNumero: 69, fecha: "2026-03-12", pago: "2026-04-23" });
    expect(f.totalCentavos).toBe(9_948_400n);
    expect(filaDe(r, "FE 6628").pago).toBe("2026-06-11");
  });

  it("números de serie reales del archivo (D4 = 45673 → 16-ene-2025, F4 = 45684 → 27-ene-2025)", () => {
    const r = leerHojaCartera(hoja("ALMACARGA", [["FE 8402", "APEX", "25-0004", 45673, 854646.56, 45684]]), "a.xlsx");
    expect(r.filas[0]).toMatchObject({ fecha: "2025-01-16", pago: "2025-01-27", doAnio: 2025, doNumero: 4 });
    expect(r.filas[0].totalCentavos).toBe(85_464_656n);
  });

  it("PAGO vacío = pendiente; filas vacías se saltan; lo ilegible va a errores (nunca se adivina)", () => {
    const r = leerHojaCartera(
      hoja("EXPRESS", [
        ["FE 7001", "BOBST", "26-0200", serial("2026-08-01"), 50000, ""],
        ["", "", "", "", "", ""],
        ["FE 7002", "BOBST", "26-0201", serial("2026-08-01"), "cincuenta", ""],
        ["FE 7003", "BOBST", "26-0202", serial("2026-08-01"), 50000, "ABONO"],
        ["", "BOBST", "26-0203", serial("2026-08-01"), 50000, ""],
      ]),
      "CARTERA EXPRESS.xlsx",
    );
    expect(r.filas.map((f) => [f.factura, f.pago])).toEqual([["FE 7001", null]]);
    expect(r.errores.map((e) => e.fila)).toEqual([6, 7, 8]);
    expect(r.errores[1].motivo).toMatch(/PAGO de FE 7003 no es una fecha/);
  });

  it("sin encabezado → un error y ninguna fila", () => {
    const r = leerHojaCartera([["A", "B"], [1, 2]], "otro.xlsx");
    expect(r.filas).toEqual([]);
    expect(r.errores[0].motivo).toMatch(/encabezado/);
  });
});

describe("conciliación — clasificación", () => {
  const almacarga = leerHojaCartera(hoja("ALMACARGA", ALMACARGA_2026), "CARTERA ALMACARGA.xlsx").filas;

  it("caso real: FE-11298 pendiente en el sistema y pagada el 23-abr en el Excel → candidata con nota CENTAVOS (0,45)", () => {
    const r = clasificarCartera({
      nitBase: "800154017",
      nombreProveedor: "ALMACARGA",
      filas: [filaDe({ filas: almacarga }, "FE 11298")],
      facturas: [fs({ id: "f-11298", numFactura: "FE-11298", valor: 502_801n })],
      pagos: [pago({ id: "p-tampa", tramiteId: "t-69", valor: 486_075n, aplicado: 486_075n, concepto: "Pago histórico TAMPA CARGO" })],
      tramites: [tramite(69)],
    });
    expect(r.filas).toHaveLength(1);
    const s = r.filas[0];
    expect(s.categoria).toBe("PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA");
    expect(s.notas).toContain("CENTAVOS");
    expect(s.diferenciaCentavos).toBe(45n);
    expect(s.saldo).toBe(502_801n);
    expect(r.pagadoSinFacturaPorDo).toEqual([{ tramiteId: "t-69", consecutivo: "DO.BAQ26-0069", monto: 0n }]);

    const plan = planificarConciliacion(r, { archivo: "CARTERA ALMACARGA.xlsx", beneficiarioId: "ben-almacarga", importarHistorico: false });
    expect(plan.bloques).toHaveLength(1);
    expect(plan.bloques[0]).toMatchObject({
      fechaPago: "2026-04-23",
      total: 502_801n,
      concepto: "Pago en bloque 23/04/2026 (registro histórico del Excel CARTERA ALMACARGA.xlsx)",
    });
    // El CSV guarda el TOTAL exacto del Excel (insumo de la fase de centavos).
    const csv = filasCsv(r, plan)[0];
    expect(csv).toContain(",502801.45,");
    expect(csv).toContain("PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA");
    expect(csv).toContain("CENTAVOS");
    expect(encabezadoCsv()).toMatch(/^archivo,fila,nit_base,factura_excel/);
  });

  it("PAGO_PREVIO_SIN_ENLAZAR gana sobre la candidata: pago al mismo proveedor sin aplicar en el DO → no se registra otro pago", () => {
    const r = clasificarCartera({
      nitBase: "800154017",
      nombreProveedor: "ALMACARGA",
      filas: [filaDe({ filas: almacarga }, "FE 11298")],
      facturas: [fs({ id: "f-11298", numFactura: "FE-11298", valor: 502_801n })],
      pagos: [
        pago({ id: "p-otro", tramiteId: "t-69", valor: 90_000n, concepto: "Transporte", delProveedor: false }),
        pago({ id: "p-previo", tramiteId: "t-69", valor: 502_801n, concepto: "ALMACENAJE", delProveedor: true }),
      ],
      tramites: [tramite(69)],
    });
    const s = r.filas[0];
    expect(s.categoria).toBe("PAGO_PREVIO_SIN_ENLAZAR");
    expect(s.propuestaEnlace).toMatchObject({ pagoId: "p-previo", monto: 502_801n, disponible: 502_801n });
    expect(r.pagadoSinFacturaPorDo[0].monto).toBe(502_801n);
    const plan = planificarConciliacion(r, { archivo: "a.xlsx", beneficiarioId: "b", importarHistorico: false });
    expect(plan.bloques).toEqual([]);
    expect(plan.enlaces).toEqual([
      { pagoId: "p-previo", concepto: "ALMACENAJE", valor: 502_801n, aplicaciones: [{ facturaId: "f-11298", numFactura: "FE-11298", monto: 502_801n }] },
    ]);
    expect(filasPagadasEnExcelConSaldo(r)).toHaveLength(1);
  });

  it("pago previo que NOMBRA la factura (sin ficha) también cuenta; uno ignorado a mano no", () => {
    const base = {
      nitBase: "800154017",
      nombreProveedor: "ALMACARGA",
      filas: [filaDe({ filas: almacarga }, "FE 11298")],
      facturas: [fs({ id: "f-11298", numFactura: "FE-11298", valor: 502_801n })],
      pagos: [pago({ id: "p-nombra", tramiteId: "t-69", valor: 300_000n, concepto: "Abono FACT 11298", sinBeneficiario: true })],
      tramites: [tramite(69)],
    };
    const r = clasificarCartera(base);
    expect(r.filas[0].categoria).toBe("PAGO_PREVIO_SIN_ENLAZAR");
    expect(r.filas[0].propuestaEnlace).toMatchObject({ pagoId: "p-nombra", monto: 300_000n });
    const r2 = clasificarCartera({ ...base, ignorarPagos: new Set(["p-nombra"]) });
    expect(r2.filas[0].categoria).toBe("PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA");
  });

  it("un pago previo no se promete dos veces: su disponible se reparte entre las filas del mismo DO", () => {
    const filas = leerHojaCartera(
      hoja("ALMACARGA", [
        ["FE 5001", "X", "26-0300", serial("2026-05-01"), 100000, serial("2026-05-10")],
        ["FE 5002", "X", "26-0300", serial("2026-05-01"), 100000, serial("2026-05-10")],
      ]),
      "a.xlsx",
    ).filas;
    const t = { tramiteId: "t-300", consecutivo: "DO.BAQ26-0300", doNumero: 300 };
    const r = clasificarCartera({
      nitBase: "1",
      nombreProveedor: "X",
      filas,
      facturas: [fs({ id: "f1", numFactura: "FE-5001", valor: 100_000n, ...t }), fs({ id: "f2", numFactura: "FE-5002", valor: 100_000n, ...t })],
      pagos: [pago({ id: "p", tramiteId: "t-300", valor: 150_000n, delProveedor: true })],
      tramites: [tramite(300)],
    });
    expect(r.filas.map((s) => [s.categoria, s.propuestaEnlace?.monto])).toEqual([
      ["PAGO_PREVIO_SIN_ENLAZAR", 100_000n],
      ["PAGO_PREVIO_SIN_ENLAZAR", 50_000n],
    ]);
  });

  it("cada categoría restante", () => {
    const filas = leerHojaCartera(
      hoja("ALMACARGA", [
        ["FE 1001", "A", "26-0010", serial("2026-01-01"), 100000, serial("2026-02-01")], // PAGADA_OK
        ["FE 1002", "A", "26-0010", serial("2026-01-01"), 100000, ""], // PENDIENTE_EN_AMBOS
        ["FE 1003", "A", "26-0010", serial("2026-01-01"), 100000, ""], // PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL
        ["FE 1004", "A", "26-0010", serial("2026-01-01"), 100000, serial("2026-02-01")], // ABONADA_EN_SISTEMA
        ["FE 1005", "A", "26-0011", serial("2026-01-01"), 100000, serial("2026-02-01")], // DO_CERRADO
        ["FE 1006", "A", "26-0099", serial("2026-01-01"), 100000, serial("2026-02-01")], // DO_DISTINTO
        ["FE 1007", "A", "26-0010", serial("2026-01-01"), 100001, serial("2026-02-01")], // VALOR_DISTINTO (≥ $1)
        ["FE 1008", "A", "26-0010", serial("2026-01-01"), 100000, serial("2026-02-01")], // NO_EN_SISTEMA (DO existe)
        ["FE 1009", "A", "26-0777", serial("2026-01-01"), 100000, serial("2026-02-01")], // NO_EN_SISTEMA (sin DO)
        ["FE 01010", "A", "26-0010", serial("2026-01-01"), 100000, ""], // NUMERO_PARECIDO (FE-1010)
        ["FE 1011", "A", "26-0010", serial("2026-01-01"), 100000, ""], // VARIAS_EN_SISTEMA
        ["FE 1001", "A", "26-0010", serial("2026-01-01"), 100000, ""], // REPETIDA_EN_EXCEL
      ]),
      "a.xlsx",
    ).filas;
    const t10 = { tramiteId: "t-10", consecutivo: "DO.BAQ26-0010", doNumero: 10, tramiteEstado: "EN_TRAMITE" as const };
    const r = clasificarCartera({
      nitBase: "1",
      nombreProveedor: "A",
      filas,
      facturas: [
        fs({ id: "f1001", numFactura: "FE-1001", valor: 100_000n, aplicado: 100_000n, ...t10 }),
        fs({ id: "f1002", numFactura: "FE-1002", valor: 100_000n, ...t10 }),
        fs({ id: "f1003", numFactura: "FE-1003", valor: 100_000n, aplicado: 100_000n, ...t10 }),
        fs({ id: "f1004", numFactura: "FE-1004", valor: 100_000n, aplicado: 40_000n, ...t10 }),
        fs({ id: "f1005", numFactura: "FE-1005", valor: 100_000n, tramiteId: "t-11", consecutivo: "DO.BAQ26-0011", doNumero: 11, tramiteEstado: "CERRADO" }),
        fs({ id: "f1006", numFactura: "FE-1006", valor: 100_000n, ...t10 }),
        fs({ id: "f1007", numFactura: "FE-1007", valor: 100_000n, ...t10 }),
        fs({ id: "f1010", numFactura: "FE-1010", valor: 100_000n, ...t10 }),
        fs({ id: "f1011a", numFactura: "FE-1011", valor: 100_000n, ...t10 }),
        fs({ id: "f1011b", numFactura: "FE 1011", valor: 100_000n, ...t10 }),
        fs({ id: "f2000", numFactura: "FE-2000", valor: 70_000n, ...t10 }), // SOLO_EN_SISTEMA
      ],
      pagos: [],
      tramites: [tramite(10, { estado: "EN_TRAMITE" }), tramite(11, { estado: "CERRADO" })],
    });
    const porFactura = (n: string) => r.filas.filter((s) => s.fila?.factura === n).map((s) => s.categoria);
    expect(porFactura("FE 1001")).toEqual(["PAGADA_OK", "REPETIDA_EN_EXCEL"]);
    expect(porFactura("FE 1002")).toEqual(["PENDIENTE_EN_AMBOS"]);
    expect(porFactura("FE 1003")).toEqual(["PAGADA_EN_SISTEMA_PENDIENTE_EN_EXCEL"]);
    expect(porFactura("FE 1004")).toEqual(["ABONADA_EN_SISTEMA"]);
    expect(porFactura("FE 1005")).toEqual(["DO_CERRADO"]);
    expect(porFactura("FE 1006")).toEqual(["DO_DISTINTO"]);
    expect(porFactura("FE 1007")).toEqual(["VALOR_DISTINTO"]);
    expect(porFactura("FE 1008")).toEqual(["NO_EN_SISTEMA"]);
    expect(r.filas.find((s) => s.fila?.factura === "FE 1008")?.tramiteExcel?.id).toBe("t-10");
    expect(porFactura("FE 1009")).toEqual(["NO_EN_SISTEMA"]);
    expect(r.filas.find((s) => s.fila?.factura === "FE 1009")?.notas).toContain("DO_NO_EXISTE");
    expect(porFactura("FE 01010")).toEqual(["NUMERO_PARECIDO"]);
    expect(porFactura("FE 1011")).toEqual(["VARIAS_EN_SISTEMA"]);
    expect(r.filas.filter((s) => s.categoria === "SOLO_EN_SISTEMA").map((s) => s.factura?.id)).toEqual(["f2000"]);
    expect(r.conteo.SOLO_EN_SISTEMA).toBe(1);

    // Nada de esto entra en un bloque: ninguna es candidata.
    const plan = planificarConciliacion(r, { archivo: "a.xlsx", beneficiarioId: "b", importarHistorico: false });
    expect(plan.bloques).toEqual([]);
    // Quedan pagadas en el Excel con saldo: ABONADA, DO_CERRADO, DO_DISTINTO, VALOR_DISTINTO → la cartera no se marca.
    expect(filasPagadasEnExcelConSaldo(r).map((s) => s.categoria).sort()).toEqual(
      ["ABONADA_EN_SISTEMA", "DO_CERRADO", "DO_DISTINTO", "VALOR_DISTINTO"].sort(),
    );
  });

  it("DO del Excel: BAQ + otra ciudad con el mismo número = ambiguo; una sola ciudad = ese DO", () => {
    const baq = tramite(69);
    const ctg = tramite(69, { id: "t-69-ctg", consecutivo: "DO.CTG26-0069", ciudad: "CTG" });
    expect(resolverDoExcel(2026, 69, [baq, ctg])).toEqual({ tramite: null, ambiguo: true });
    expect(resolverDoExcel(2026, 69, [ctg])).toEqual({ tramite: ctg, ambiguo: false });
    expect(resolverDoExcel(2026, 70, [baq])).toEqual({ tramite: null, ambiguo: false });
  });

  it("plan: un bloque por fecha de PAGO, facturas ordenadas por DO, clave determinista que cambia con las facturas", () => {
    const filas = leerHojaCartera(hoja("ALMACARGA", ALMACARGA_2026), "CARTERA ALMACARGA.xlsx").filas;
    const facturas = [
      fs({ id: "f-11265", numFactura: "FE-11265", valor: 436_065n, tramiteId: "t-49", consecutivo: "DO.BAQ26-0049", doNumero: 49 }),
      fs({ id: "f-11298", numFactura: "FE-11298", valor: 502_801n }),
      fs({ id: "f-11604", numFactura: "FE-11604", valor: 490_717n, tramiteId: "t-99", consecutivo: "DO.BAQ26-0099", doNumero: 99 }),
      fs({ id: "f-11831", numFactura: "FE-11831", valor: 26_180n, tramiteId: "t-141", consecutivo: "DO.BAQ26-0141", doNumero: 141 }),
    ];
    const r = clasificarCartera({
      nitBase: "800154017",
      nombreProveedor: "ALMACARGA",
      filas,
      facturas,
      pagos: [],
      tramites: [tramite(49), tramite(69), tramite(99), tramite(141)],
    });
    const plan = planificarConciliacion(r, { archivo: "CARTERA ALMACARGA.xlsx", beneficiarioId: "ben", importarHistorico: false });
    expect(plan.bloques.map((b) => [b.fechaPago, b.facturas.map((f) => f.numFactura), b.total])).toEqual([
      ["2026-04-23", ["FE-11265", "FE-11298"], 938_866n],
      ["2026-06-11", ["FE-11604", "FE-11831"], 516_897n],
    ]);
    const k = plan.bloques[0].claveIdempotencia;
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claveBloqueHistorico("CARTERA ALMACARGA.xlsx", "800154017", "2026-04-23", ["f-11298", "f-11265"])).toBe(k);
    expect(claveBloqueHistorico("CARTERA ALMACARGA.xlsx", "800154017", "2026-04-23", ["f-11298"])).not.toBe(k);
    expect(claveBloqueHistorico("CARTERA EXPRESS.xlsx", "800154017", "2026-04-23", ["f-11298", "f-11265"])).not.toBe(k);
  });

  it("--importar-historico: solo NO_EN_SISTEMA con DO único, abierto y sin pago previo del proveedor; valor redondeado al peso", () => {
    const filas = leerHojaCartera(
      hoja("EXPRESS", [
        ["FE 8001", "A", "26-0010", serial("2026-01-01"), 99484.5, serial("2026-02-01")], // se importa (99.485)
        ["FE 8002", "A", "26-0011", serial("2026-01-01"), 1000, ""], // DO cerrado: no
        ["FE 8003", "A", "26-0012", serial("2026-01-01"), 1000, ""], // DO con pago previo: no
        ["FE 8004", "A", "26-0999", serial("2026-01-01"), 1000, ""], // sin DO: no (nunca crea DOs)
      ]),
      "e.xlsx",
    ).filas;
    const tramites = [tramite(10, { estado: "EN_TRAMITE" }), tramite(11, { estado: "CERRADO" }), tramite(12, { estado: "EN_TRAMITE" })];
    const pagos = [pago({ id: "p12", tramiteId: "t-12", valor: 1000n, delProveedor: true })];
    const r = clasificarCartera({ nitBase: "1", nombreProveedor: "E", filas, facturas: [], pagos, tramites });
    expect(r.conteo.NO_EN_SISTEMA).toBe(4);
    const sin = planificarConciliacion(r, { archivo: "e.xlsx", beneficiarioId: "b", importarHistorico: false, pagos });
    expect(sin.importaciones).toEqual([]);
    const con = planificarConciliacion(r, { archivo: "e.xlsx", beneficiarioId: "b", importarHistorico: true, pagos });
    expect(con.importaciones.map((m) => [m.fila.factura, m.consecutivo, m.valor])).toEqual([["FE 8001", "DO.BAQ26-0010", 99_485n]]);
  });

  it("utilidades: centavos exactos, redondeo al peso, texto que nombra la factura, pagos sin ficha con el nombre del proveedor", () => {
    expect(textoExactoCentavos(50_280_145n)).toBe("502801.45");
    expect(textoExactoCentavos(-45n)).toBe("-0.45");
    expect(pesosDesdeCentavos(50_280_145n)).toBe(502_801n);
    expect(pesosDesdeCentavos(50_280_150n)).toBe(502_802n);
    expect(textoNombraFactura("Pago factura FE-11298", "FE 11298")).toBe(true);
    expect(textoNombraFactura("ALMACENAJE FACT 11298 SRF", "FE 11298")).toBe(true);
    expect(textoNombraFactura("Pago 112980", "FE 11298")).toBe(false);
    expect(textoNombraFactura(null, "FE 11298")).toBe(false);
    const marcados = marcarPagosSinFichaConNombre(
      [
        pago({ id: "a", tramiteId: "t", valor: 1n, concepto: "ALMACENAJE ALMACARGA", sinBeneficiario: true }),
        pago({ id: "b", tramiteId: "t", valor: 1n, concepto: "TRANSPORTE ALMACARGA - POLYREC", sinBeneficiario: false }),
      ],
      ["ALMACARGA"],
    );
    expect(marcados.map((p) => p.delProveedor)).toEqual([true, false]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN (Postgres local desechable)
// ═════════════════════════════════════════════════════════════════════════════

const PREFIJO = "vitest-cxp-conciliacion";
const runId = `${PREFIJO}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** Números de DO altos y distintos por corrida (no chocan con otros datos de 2026). */
const baseDo = 6000 + Math.floor(Math.random() * 3000);
const nitAlma = `7${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const nitExpr = `6${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

interface Ctx {
  userId: string;
  clienteId: string;
  almaId: string;
  exprId: string;
  tampaId: string;
  tramites: Record<"A" | "B" | "C" | "D" | "E", string>;
  numeros: Record<"A" | "B" | "C" | "D" | "E", number>;
}

let ctx: Ctx | null = null;
let motivoSinBd: string | null = null;

function doTexto(numero: number): string {
  return `26-${String(numero).padStart(4, "0")}`;
}

async function limpiar() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: PREFIJO } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: PREFIJO } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { OR: [{ comentarios: { startsWith: PREFIJO } }, { clienteId: { in: clienteIds } }] },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  const fichas = await prisma.beneficiario.findMany({
    where: { OR: [{ nombre: { startsWith: PREFIJO } }, { empresaId: { in: clienteIds } }] },
    select: { id: true },
  });
  const fichaIds = fichas.map((f) => f.id);

  await prisma.auditLog.deleteMany({
    where: { OR: [{ usuarioId: { in: userIds } }, { tramiteId: { in: tramiteIds } }, { entidadId: { in: fichaIds } }] },
  });
  await prisma.pagoTramiteFactura.deleteMany({ where: { pago: { tramiteId: { in: tramiteIds } } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoGrupo.deleteMany({ where: { OR: [{ creadoPorId: { in: userIds } }, { beneficiarioId: { in: fichaIds } }] } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.anticipo.deleteMany({ where: { clienteId: { in: clienteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.beneficiario.deleteMany({ where: { id: { in: fichaIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function crearCtx(): Promise<Ctx> {
  const user = await prisma.user.create({
    data: { email: `${runId}@example.test`, emailVerified: true, name: "Vitest conciliación", rol: Rol.ADMIN },
  });
  const cliente = await prisma.cliente.create({
    data: { nombre: "LITOPLAS SA (conciliación)", nit: `${PREFIJO}-litoplas-${runId}`, tipo: TipoCliente.PROPIO },
  });
  const empAlma = await prisma.cliente.create({
    data: { nombre: "ALMACARGA (conciliación)", nit: `${PREFIJO}-alma-${runId}`, esCliente: false, esProveedor: true },
  });
  const empExpr = await prisma.cliente.create({
    data: { nombre: "EXPRESS (conciliación)", nit: `${PREFIJO}-expr-${runId}`, esCliente: false, esProveedor: true },
  });
  const alma = await prisma.beneficiario.create({
    data: {
      nombre: `${PREFIJO} ALMACENADORA DE CARGA`,
      nombreCorto: "ALMACARGA",
      nit: `${nitAlma}-${dvNit(nitAlma)}`,
      empresaId: empAlma.id,
      numFacturaConEspacio: true,
      conciliacionPendiente: true,
    },
  });
  const expr = await prisma.beneficiario.create({
    data: {
      nombre: `${PREFIJO} EXPRESS LOGISTICA`,
      nombreCorto: "EXPRESS",
      nit: `${nitExpr}-${dvNit(nitExpr)}`,
      empresaId: empExpr.id,
      numFacturaConEspacio: true,
      conciliacionPendiente: true,
    },
  });
  // Fase 3: la ficha de Tampa lleva su empresa solo-proveedora (NIT con el prefijo de prueba, que `limpiar` borra después de las fichas).
  const tampa = await crearFichaConEmpresaTest({ nombre: `${PREFIJO} TAMPA CARGO`, nit: `${PREFIJO}-tampa-${runId}` });

  const numeros = { A: baseDo + 69, B: baseDo + 226, C: baseDo + 238, D: baseDo + 99, E: baseDo + 255 };
  const tramites = {} as Ctx["tramites"];
  for (const [k, numero] of Object.entries(numeros) as [keyof typeof numeros, number][]) {
    const t = await prisma.tramiteDO.create({
      data: {
        consecutivo: `DO.BAQ26-${numero}-${runId}`,
        ciudad: Ciudad.BAQ,
        anio: 2026,
        numero,
        clienteId: cliente.id,
        agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
        creadoPorId: user.id,
        comentarios: `${PREFIJO}:${runId}`,
        estado: EstadoTramite.EN_TRAMITE,
      },
    });
    const anticipo = await prisma.anticipo.create({
      data: { clienteId: cliente.id, monto: 2_000_000n, fecha: new Date("2026-03-01"), tipoRecaudo: TipoRecaudo.BANCOLOMBIA, verificadoBanco: true },
    });
    await prisma.aplicacionAnticipo.create({ data: { anticipoId: anticipo.id, tramiteId: t.id, montoAplicado: 2_000_000n } });
    tramites[k] = t.id;
  }
  return { userId: user.id, clienteId: cliente.id, almaId: alma.id, exprId: expr.id, tampaId: tampa.id, tramites, numeros };
}

function ensure(c: { skip: (n?: string) => void }): Ctx {
  if (!ctx) {
    c.skip(motivoSinBd ?? "BD local no disponible");
    throw new Error("omitido");
  }
  return ctx;
}

async function factura(c: Ctx, tramiteId: string, beneficiarioId: string, numFactura: string, valor: bigint, fecha: string) {
  const f = await crearFacturaProveedor({
    tramiteId,
    beneficiarioId,
    numFactura,
    valor,
    fecha: new Date(`${fecha}T00:00:00Z`),
    concepto: "ALMACENAJE",
    repercutible: true,
    subidaPorId: c.userId,
  });
  return f.id;
}

async function conteos() {
  const [grupos, pagos, puentes, facturas] = await Promise.all([
    prisma.pagoGrupo.count(),
    prisma.pagoTramite.count(),
    prisma.pagoTramiteFactura.count(),
    prisma.facturaProveedor.count(),
  ]);
  return { grupos, pagos, puentes, facturas };
}

async function saldoDo(tramiteId: string): Promise<bigint> {
  return (await cargarContextoDos(prisma, [tramiteId])).get(tramiteId)!.saldoTramite;
}

describe("conciliación — integración con la BD (simulacro, aplicar, idempotencia)", () => {
  const ids: Record<string, string> = {};
  let filasAlma: FilaCartera[] = [];
  let filasExpr: FilaCartera[] = [];
  let pagoPrevioId = "";

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      motivoSinBd = "DATABASE_URL no definida";
      return;
    }
    try {
      await prisma.$connect();
      await limpiar();
      const c = await crearCtx();
      ctx = c;
      const { A, B, C, D, E } = c.tramites;
      // DO A (caso real 26-0069): Almacarga FE 11298 y Express FE 6353 pendientes; Tampa pagada y enlazada.
      ids.alma11298 = await factura(c, A, c.almaId, "FE-911298", 502_801n, "2026-03-26");
      ids.expr6353 = await factura(c, A, c.exprId, "FE-96353", 99_484n, "2026-03-12");
      ids.tampa = await factura(c, A, c.tampaId, "71388844", 486_075n, "2026-03-20");
      await crearPago({
        tramiteId: A,
        concepto: "LIBERACION TAMPA CARGO",
        valor: 486_075n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: ids.tampa, monto: 486_075n }],
        usuarioId: c.userId,
      });
      // DO B: FE 912334 pendiente, pero ya salió un pago a Almacarga sin enlazar (PAGO_PREVIO).
      ids.alma12334 = await factura(c, B, c.almaId, "FE-912334", 433_361n, "2026-08-11");
      const previo = await crearPago({
        tramiteId: B,
        concepto: "Pago almacenaje Almacarga",
        valor: 433_361n,
        canalPago: CanalPago.PSE,
        beneficiarioIds: [c.almaId],
        usuarioId: c.userId,
      });
      pagoPrevioId = previo.id;
      // DO C: FE 912481 ya pagada en el sistema (PAGADA_OK).
      ids.alma12481 = await factura(c, C, c.almaId, "FE-912481", 464_077n, "2026-08-27");
      await crearPago({
        tramiteId: C,
        concepto: "Pago FE 912481",
        valor: 464_077n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: ids.alma12481, monto: 464_077n }],
        usuarioId: c.userId,
      });
      // DO D: FE 911604 pendiente, pagada el 11-jun en el Excel (segundo bloque).
      ids.alma11604 = await factura(c, D, c.almaId, "FE-911604", 490_717n, "2026-05-08");
      // DO E: FE 912539 solo en el sistema.
      ids.alma12539 = await factura(c, E, c.almaId, "FE-912539", 461_377n, "2026-09-02");

      filasAlma = leerHojaCartera(
        hoja("ALMACARGA", [
          ["FE 911298", "SRF", doTexto(c.numeros.A), serial("2026-03-26"), 502801.45, serial("2026-04-23")],
          ["FE 912334", "SRF", doTexto(c.numeros.B), serial("2026-08-11"), 433361, serial("2026-08-20")],
          ["FE 912481", "SRF", doTexto(c.numeros.C), serial("2026-08-27"), 464077, serial("2026-09-01")],
          ["FE 911604", "EPS", doTexto(c.numeros.D), serial("2026-05-08"), 490717.23, serial("2026-06-11")],
          ["FE 918888", "X", doTexto(baseDo + 2999), serial("2026-01-10"), 400000, serial("2026-02-01")],
        ]),
        "CARTERA ALMACARGA.xlsx",
      ).filas;
      filasExpr = leerHojaCartera(
        hoja("EXPRESS", [
          ["FE 96353", "SRF", doTexto(c.numeros.A), serial("2026-03-12"), 99484, serial("2026-04-23")],
          ["FE 96999", "SRF", doTexto(c.numeros.E), serial("2026-07-01"), 50000.4, serial("2026-07-31")],
        ]),
        "CARTERA EXPRESS.xlsx",
      ).filas;
    } catch (e) {
      motivoSinBd = e instanceof Error ? e.message : String(e);
      ctx = null;
    }
  }, 60_000);

  afterAll(async () => {
    if (process.env.DATABASE_URL) await limpiar();
  }, 60_000);

  const opciones = (c: Ctx, extra: Partial<Parameters<typeof conciliarProveedor>[0]> = {}) => ({
    archivo: "CARTERA ALMACARGA.xlsx",
    filas: filasAlma,
    nitBase: nitAlma,
    modo: "simulacro" as const,
    usuarioId: c.userId,
    canal: CanalPago.TRANSF_BANCOLOMBIA,
    ...extra,
  });

  it("simulacro: clasifica y NO escribe nada", async (t) => {
    const c = ensure(t);
    const antes = await conteos();
    const inf = await conciliarProveedor(opciones(c));
    expect(inf.cambios).toBe(0);
    expect(await conteos()).toEqual(antes);
    const cat = (n: string) => inf.antes.filas.find((s) => s.fila?.factura === n)?.categoria;
    expect(cat("FE 911298")).toBe("PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA");
    expect(cat("FE 912334")).toBe("PAGO_PREVIO_SIN_ENLAZAR");
    expect(cat("FE 912481")).toBe("PAGADA_OK");
    expect(cat("FE 911604")).toBe("PAGADA_EN_EXCEL_PENDIENTE_EN_SISTEMA");
    expect(cat("FE 918888")).toBe("NO_EN_SISTEMA");
    expect(inf.antes.filas.filter((s) => s.categoria === "SOLO_EN_SISTEMA").map((s) => s.factura?.id)).toEqual([ids.alma12539]);
    expect(inf.plan.bloques.map((b) => [b.fechaPago, b.total])).toEqual([
      ["2026-04-23", 502_801n],
      ["2026-06-11", 490_717n],
    ]);
    expect(inf.plan.enlaces.map((e) => e.pagoId)).toEqual([pagoPrevioId]);
    // Pendiente: 11298 + 12334 + 11604 + 12539.
    expect(inf.cifrasAntes?.pendiente).toBe(502_801n + 433_361n + 490_717n + 461_377n);
    expect(inf.markdown).toContain("Pagos previos sin enlazar");
    expect(inf.markdown).toContain("23/04/2026");
  });

  it("usuario que no es ADMIN → rechazo sin escribir", async (t) => {
    const c = ensure(t);
    const operativo = await prisma.user.create({
      data: { email: `${runId}-op@example.test`, emailVerified: true, name: "op", rol: Rol.OPERATIVO },
    });
    await expect(conciliarProveedor(opciones(c, { usuarioId: operativo.id, modo: "aplicar" }))).rejects.toThrow(/solo la puede ejecutar un ADMIN/);
  });

  it("aplicar: un bloque histórico por fecha (costo 0, Galcomex), el pago previo NO se duplica y la cartera sigue sin conciliar", async (t) => {
    const c = ensure(t);
    const saldoA = await saldoDo(c.tramites.A);
    const saldoB = await saldoDo(c.tramites.B);
    const inf = await conciliarProveedor(opciones(c, { modo: "aplicar" }));
    expect(inf.ejecucion?.bloques.every((b) => b.ok)).toBe(true);
    expect(inf.ejecucion?.bloques).toHaveLength(2);
    expect(inf.cambios).toBe(2);

    const grupos = await prisma.pagoGrupo.findMany({
      where: { beneficiarioId: c.almaId },
      include: { pagos: { include: { facturasProveedor: true } } },
      orderBy: { fechaRealPago: "asc" },
    });
    expect(grupos).toHaveLength(2);
    expect(grupos[0]).toMatchObject({
      esHistorico: true,
      costoBancario: 0n,
      costoAsumidoPor: "GALCOMEX",
      totalAplicado: 502_801n,
      estado: "ACTIVO",
      documentoId: null,
      concepto: "Pago en bloque 23/04/2026 (registro histórico del Excel CARTERA ALMACARGA.xlsx)",
    });
    expect(grupos[0].fechaRealPago?.toISOString()).toBe("2026-04-23T00:00:00.000Z");
    expect(grupos[0].pagos.map((p) => [p.costoBancario, p.facturasProveedor.map((x) => [x.facturaId, x.monto])])).toEqual([
      [0n, [[ids.alma11298, 502_801n]]],
    ]);

    const estado = async (id: string) => (await prisma.facturaProveedor.findUniqueOrThrow({ where: { id } })).estado;
    expect(await estado(ids.alma11298)).toBe("PAGADA");
    expect(await estado(ids.alma11604)).toBe("PAGADA");
    expect(await estado(ids.alma12334)).toBe("REGISTRADA"); // PAGO_PREVIO: nunca se paga otra vez
    expect(await saldoDo(c.tramites.A)).toBe(saldoA - 502_801n);
    expect(await saldoDo(c.tramites.B)).toBe(saldoB);
    const previo = await prisma.pagoTramite.findUniqueOrThrow({ where: { id: pagoPrevioId }, include: { facturasProveedor: true } });
    expect(previo.facturasProveedor).toEqual([]);

    expect(inf.cifrasDespues?.pendiente).toBe(433_361n + 461_377n);
    expect(inf.ejecucion?.carteraMarcadaConciliada).toBe(false);
    expect(inf.ejecucion?.motivoNoMarcada).toMatch(/FE 912334: PAGO_PREVIO_SIN_ENLAZAR/);
    const ficha = await prisma.beneficiario.findUniqueOrThrow({ where: { id: c.almaId } });
    expect(ficha.conciliacionPendiente).toBe(true);
    expect(ficha.carteraConciliadaEn).toBeNull();
  });

  it("segunda corrida de aplicar = 0 cambios (todo ya está PAGADA_OK)", async (t) => {
    const c = ensure(t);
    const antes = await conteos();
    const inf = await conciliarProveedor(opciones(c, { modo: "aplicar" }));
    expect(inf.cambios).toBe(0);
    expect(inf.plan.bloques).toEqual([]);
    expect(await conteos()).toEqual(antes);
    expect(inf.antes.conteo.PAGADA_OK).toBe(3);
  });

  it("--enlazar-previos: enlaza el pago que ya salió (sin plata nueva) y entonces marca la cartera conciliada una sola vez", async (t) => {
    const c = ensure(t);
    const saldoB = await saldoDo(c.tramites.B);
    const pagosAntes = await prisma.pagoTramite.count();
    const inf = await conciliarProveedor(opciones(c, { modo: "aplicar", enlazarPrevios: [pagoPrevioId] }));
    expect(inf.ejecucion?.enlaces).toEqual([{ pagoId: pagoPrevioId, ok: true, aplicado: 433_361n }]);
    expect(await prisma.pagoTramite.count()).toBe(pagosAntes);
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: ids.alma12334 } })).estado).toBe("PAGADA");
    expect(await saldoDo(c.tramites.B)).toBe(saldoB);
    expect(inf.ejecucion?.carteraMarcadaConciliada).toBe(true);
    const ficha = await prisma.beneficiario.findUniqueOrThrow({ where: { id: c.almaId } });
    expect(ficha.conciliacionPendiente).toBe(false);
    expect(ficha.carteraConciliadaEn).not.toBeNull();
    expect(inf.cifrasDespues?.pendiente).toBe(461_377n);

    // Tercera corrida: 0 cambios y la fecha de conciliación no se mueve.
    const inf3 = await conciliarProveedor(opciones(c, { modo: "aplicar", enlazarPrevios: [pagoPrevioId] }));
    expect(inf3.cambios).toBe(0);
    expect(inf3.ejecucion?.enlaces[0]).toMatchObject({ ok: false }); // ya no es un pago previo sin enlazar
    const ficha3 = await prisma.beneficiario.findUniqueOrThrow({ where: { id: c.almaId } });
    expect(ficha3.carteraConciliadaEn?.getTime()).toBe(ficha.carteraConciliadaEn?.getTime());
  });

  it("Express con --importar-historico: FE-6353 al bloque del 23-abr y la fila que no existía se crea y se paga (sin crear DOs)", async (t) => {
    const c = ensure(t);
    const facturasAntes = await prisma.facturaProveedor.count();
    const inf = await conciliarProveedor(
      opciones(c, {
        archivo: "CARTERA EXPRESS.xlsx",
        filas: filasExpr,
        nitBase: nitExpr,
        modo: "aplicar",
        importarHistorico: { concepto: "TRANSPORTE" },
      }),
    );
    expect(inf.ejecucion?.importaciones).toMatchObject([{ factura: "FE 96999", ok: true }]);
    expect(await prisma.facturaProveedor.count()).toBe(facturasAntes + 1);
    const nueva = await prisma.facturaProveedor.findFirstOrThrow({ where: { tramiteId: c.tramites.E, beneficiarioId: c.exprId } });
    expect(nueva).toMatchObject({ numFactura: "FE 96999", valor: 50_000n, concepto: "TRANSPORTE", estado: "PAGADA" });
    expect(nueva.fecha.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: ids.expr6353 } })).estado).toBe("PAGADA");
    expect(inf.ejecucion?.bloques.map((b) => [b.fechaPago, b.total, b.ok])).toEqual([
      ["2026-04-23", 99_484n, true],
      ["2026-07-31", 50_000n, true],
    ]);
    expect(inf.cifrasDespues?.pendiente).toBe(0n);
    expect(inf.ejecucion?.carteraMarcadaConciliada).toBe(true);

    const otra = await conciliarProveedor(
      opciones(c, { archivo: "CARTERA EXPRESS.xlsx", filas: filasExpr, nitBase: nitExpr, modo: "aplicar", importarHistorico: { concepto: "TRANSPORTE" } }),
    );
    expect(otra.cambios).toBe(0);
    expect(await prisma.facturaProveedor.count()).toBe(facturasAntes + 1);
  });

  it("invariantes I1–I7: 0 violaciones sobre lo que creó la conciliación", async (t) => {
    const c = ensure(t);
    const informe = await verificarInvariantes(prisma);
    const mios = new Set<string>([
      ...Object.values(ids),
      ...(await prisma.pagoTramite.findMany({ where: { tramiteId: { in: Object.values(c.tramites) } }, select: { id: true } })).map((p) => p.id),
      ...(await prisma.pagoGrupo.findMany({ where: { beneficiarioId: { in: [c.almaId, c.exprId] } }, select: { id: true } })).map((g) => g.id),
      `NIT:${nitAlma}`,
      `NIT:${nitExpr}`,
    ]);
    expect(informe.violaciones.filter((h) => mios.has(h.id))).toEqual([]);
    // El pago previo enlazado es un pago de v2 que quedó cubierto completo: sin aviso I3.
    expect(informe.avisos.filter((h) => h.invariante === "I3" && mios.has(h.id))).toEqual([]);
  });
});
