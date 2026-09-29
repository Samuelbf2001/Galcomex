import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { centavosDeNumero, pesos } from "@/lib/dinero";
import { $ } from "@/lib/dinero/test-utils";

import {
  construirFacturaSiigoImportXlsx,
  construirFilasSiigoImport,
  lineasImportDesdeBorrador,
  type SiigoFacturaImportDto,
  type SiigoImportConfig,
} from "../siigo-import";

const config: SiigoImportConfig = {
  tipoComprobante: "1",
  codProducto: "SERV-GALCOMEX",
  idVendedor: "12345678",
  codIva: "IVA19",
  codFormaPago: "1",
};

const dto: SiigoFacturaImportDto = {
  identificacionTercero: "900123456-7",
  fecha: new Date(Date.UTC(2026, 2, 23)), // 23/03/2026
  observaciones: "DO DO.BUN26-0026",
  lineas: [
    { concepto: "ANTICIPO LUIS INSP INVIMA", valor: pesos(1_000_000) },
    { concepto: "COMISION GALCOMEX", valor: pesos(200_000), esComision: true },
  ],
  totalFormaPago: pesos(41_868_042),
};

describe("SIIGO import — facturas de venta", () => {
  it("emite las 31 columnas oficiales (A–AE) en el encabezado", () => {
    const filas = construirFilasSiigoImport(dto, config);
    expect(filas[0]).toHaveLength(31);
    expect(filas[0][0]).toBe("Tipo de comprobante");
    expect(filas[0][30]).toBe("Observaciones");
  });

  it("mapea tipo, tercero (sin DV), fecha y valores como número", () => {
    const filas = construirFilasSiigoImport(dto, config);
    const fila1 = filas[1];
    expect(fila1[0]).toBe("1"); // A tipo comprobante
    expect(fila1[2]).toBe("900123456"); // C identificación sin dígito de verificación
    expect(fila1[5]).toBe("23/03/2026"); // F fecha DD/MM/AAAA
    expect(fila1[6]).toBe("COP"); // G moneda
    expect(fila1[13]).toBe("SERV-GALCOMEX"); // N código producto
    expect(fila1[17]).toBe(1); // R cantidad
    expect(fila1[18]).toBe(1_000_000); // S valor unitario (número)
    // Forma de pago va una sola vez en la primera línea con el total
    expect(fila1[27]).toBe("1"); // AB forma de pago
    expect(fila1[28]).toBe(41_868_042); // AC valor forma de pago
  });

  it("aplica el código IVA solo a la línea de comisión", () => {
    const filas = construirFilasSiigoImport(dto, config);
    expect(filas[1][22]).toBeNull(); // línea normal sin IVA
    expect(filas[2][22]).toBe("IVA19"); // comisión con código IVA
    // la forma de pago no se repite en líneas siguientes
    expect(filas[2][27]).toBeNull();
  });

  it("genera un XLSX legible con hoja 'Facturas' y valores numéricos", () => {
    const buffer = construirFacturaSiigoImportXlsx(dto, config);
    expect(buffer.length).toBeGreaterThan(0);
    const wb = XLSX.read(buffer, { type: "buffer" });
    expect(wb.SheetNames).toContain("Facturas");
    const ws = wb.Sheets["Facturas"];
    // S2 = valor unitario de la primera línea, debe ser número
    expect(ws["S2"].t).toBe("n");
    expect(ws["S2"].v).toBe(1_000_000);
  });
});

describe("SIIGO import — centavos", () => {
  it("valor unitario y forma de pago en pesos con 2 decimales (502801.45 / 1487623.45)", () => {
    const filas = construirFilasSiigoImport(
      { ...dto, lineas: [{ concepto: "ALMACENAJE", valor: $("502.801,45") }], totalFormaPago: $("1.487.623,45") },
      config,
    );
    expect(filas[1][18]).toBe(502_801.45);
    expect(filas[1][28]).toBe(1_487_623.45);
    const wb = XLSX.read(construirFacturaSiigoImportXlsx({ ...dto, lineas: [{ concepto: "ALMACENAJE", valor: $("502.801,45") }] }, config), {
      type: "buffer",
      cellNF: true,
    });
    const s2 = wb.Sheets["Facturas"]!["S2"] as XLSX.CellObject;
    expect(s2.v).toBe(502_801.45);
    expect(s2.z).toBe("#,##0.00");
    expect(centavosDeNumero(s2.v as number)).toBe($("502.801,45"));
  });
});

describe("lineasImportDesdeBorrador — Σ S − retenciones = AC (hallazgo 7)", () => {
  const sinEspejos = { comisionCentavos: 0n, ivaComisionCentavos: 0n, impuesto4x1000Centavos: 0n, costosBancariosCentavos: 0n };

  it("CONCEPTOS_IVA (caso de galcomex_sim_centavos): no duplica conceptos, IVA ni 4x1000", () => {
    const lineasRevision = [
      { concepto: "IVA 19%", valorCentavos: pesos(28_500), seccion: "OPERACIONAL" as const, orden: 90, tipoFija: "IVA_COMISION" },
      { concepto: "AGENCIAMIENTO", valorCentavos: pesos(150_000), seccion: "OPERACIONAL" as const, orden: 10, tipoFija: null },
      { concepto: "ALMACENAJE ALMACARGA FACT. FE-11298", valorCentavos: pesos(1_241_076), seccion: "TERCEROS" as const, orden: 1, tipoFija: null },
      { concepto: "IMPUESTO 4X1000", valorCentavos: pesos(4_964), seccion: "TERCEROS" as const, orden: 99, tipoFija: "IMPUESTO_4X1000" },
    ];
    const retenciones = pesos(4_275);
    const totalFactura = pesos(1_420_265);
    // Los espejos del borrador (comision = Σ conceptos propios, IVA, 4x1000) YA están en las líneas.
    const lineas = lineasImportDesdeBorrador(lineasRevision, {
      comisionCentavos: pesos(150_000),
      ivaComisionCentavos: pesos(28_500),
      impuesto4x1000Centavos: pesos(4_964),
      costosBancariosCentavos: 0n,
    });
    expect(lineas.map((l) => l.concepto)).toEqual([
      "ALMACENAJE ALMACARGA FACT. FE-11298",
      "IMPUESTO 4X1000",
      "AGENCIAMIENTO",
      "IVA 19%",
    ]);
    const filas = construirFilasSiigoImport({ ...dto, lineas, totalFormaPago: totalFactura }, config).slice(1);
    const sumaS = filas.reduce((s, f) => s + centavosDeNumero(f[18] as number), 0n);
    expect(sumaS).toBe(pesos(1_424_540)); // antes: 1.608.004 (183.464 duplicados)
    expect(sumaS - retenciones).toBe(centavosDeNumero(filas[0]![28] as number));
  });

  it("formato COMISION: la línea fija COMISION lleva la marca de la columna W", () => {
    const lineas = lineasImportDesdeBorrador(
      [
        { concepto: "FLETE", valorCentavos: pesos(1_000_000), seccion: "TERCEROS", orden: 1, tipoFija: null },
        { concepto: "COMISION GALCOMEX", valorCentavos: pesos(200_000), seccion: "OPERACIONAL", orden: 2, tipoFija: "COMISION" },
        { concepto: "IVA COMISION", valorCentavos: pesos(38_000), seccion: "OPERACIONAL", orden: 3, tipoFija: "IVA_COMISION" },
        { concepto: "COSTOS BANCARIOS", valorCentavos: 0n, seccion: "OPERACIONAL", orden: 4, tipoFija: "COSTOS_BANCARIOS" },
      ],
      { ...sinEspejos, comisionCentavos: pesos(200_000), ivaComisionCentavos: pesos(38_000) },
    );
    expect(lineas).toEqual([
      { concepto: "FLETE", valor: pesos(1_000_000) },
      { concepto: "COMISION GALCOMEX", valor: pesos(200_000), esComision: true },
      { concepto: "IVA COMISION", valor: pesos(38_000) },
    ]);
  });

  it("borrador viejo SIN líneas fijas: conserva los espejos (comportamiento anterior)", () => {
    const lineas = lineasImportDesdeBorrador(
      [{ concepto: "FLETE", valorCentavos: pesos(1_000_000), seccion: "TERCEROS", orden: 1, tipoFija: null }],
      { comisionCentavos: pesos(200_000), ivaComisionCentavos: pesos(38_000), impuesto4x1000Centavos: 0n, costosBancariosCentavos: pesos(3_900) },
    );
    expect(lineas.map((l) => [l.concepto, l.valor])).toEqual([
      ["FLETE", pesos(1_000_000)],
      ["COMISION GALCOMEX", pesos(200_000)],
      ["IVA COMISION", pesos(38_000)],
      ["COSTOS BANCARIOS", pesos(3_900)],
    ]);
  });
});
