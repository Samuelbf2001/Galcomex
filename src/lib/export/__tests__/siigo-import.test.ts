import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  construirFacturaSiigoImportXlsx,
  construirFilasSiigoImport,
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
    { concepto: "ANTICIPO LUIS INSP INVIMA", valor: 1_000_000n },
    { concepto: "COMISION GALCOMEX", valor: 200_000n, esComision: true },
  ],
  totalFormaPago: 41_868_042n,
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
