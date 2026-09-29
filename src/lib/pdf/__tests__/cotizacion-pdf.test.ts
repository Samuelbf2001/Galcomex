import { describe, expect, it } from "vitest";

import { CONFIG_OC_DEFECTO } from "@/lib/borradores/orden-compra";
import { armarCotizacion, textoNotaAgencia } from "@/lib/cotizacion/calculo";

import {
  filasCotizacion,
  pesosCotizacion,
  renderCotizacionPdf,
  textoValorOc,
  type CotizacionPdfDto,
} from "../cotizacion-pdf";

/**
 * B7 — el PDF de la cotización. El contenido del PDF va comprimido, así que lo
 * que se verifica son las filas y textos que imprime (funciones puras) y que
 * el documento se genera de verdad.
 */
const $ = (n: number) => BigInt(n);

function dto(over: { usaOrdenCompra?: boolean; conTerceros?: boolean; configOcSoloServicio?: boolean } = {}): CotizacionPdfDto {
  const r = armarCotizacion({
    conceptos: [
      { concepto: "LOGÍSTICA DE SUPERVISIÓN Y DESPACHO", valor: $(255_000), aplicaIva: true },
      { concepto: "DOCUMENTACIÓN", valor: $(20_000), aplicaIva: true },
      { concepto: "PAPELERÍA", valor: $(12_000), aplicaIva: true },
      { concepto: "SISTEMATIZACIÓN", valor: $(20_000), aplicaIva: true },
      { concepto: "SERVICIO LOGÍSTICO", valor: $(100_000), aplicaIva: true },
    ],
    terceros: over.conTerceros ? [{ concepto: "ALMACENAJE ALMACARGA FACT. FE 11298", valor: $(502_801), numSoporte: "FE-11298" }] : [],
    tasaIva: 19n,
    tasa4x1000: 400n,
    reteIvaPorcentaje: 15,
    configOc: over.configOcSoloServicio ? { ...CONFIG_OC_DEFECTO, base: "SOLO_SERVICIO" } : CONFIG_OC_DEFECTO,
    agenciamiento: { agencia: "COLDEX", valor: 145_000n },
  });
  return {
    ...r,
    fecha: new Date("2026-09-29T12:00:00Z"),
    tramite: {
      id: "t1",
      consecutivo: "DO.BAQ26-0171",
      ciudad: "BAQ",
      doCliente: "IM054-26",
      proveedorCliente: "EREMA",
      referenciaExterna: null,
      ordenCompraNumero: "OC11374",
      ordenCompraValor: $(407_000),
    },
    empresa: { id: "e1", nombre: "POLYREC ZONA FRANCA S.A.S", nit: "900123456-1", contactoNombre: "Karina", ciudad: "Barranquilla" },
    tarifario: { id: "tf1", nombre: "Nacionalización ZF 2026", version: 1 },
    usaOrdenCompra: over.usaOrdenCompra ?? true,
    textoNotaAgencia: textoNotaAgencia(r.notaAgencia!),
  };
}

describe("pesosCotizacion", () => {
  it("punto de miles y signo", () => {
    expect(pesosCotizacion($(472_730))).toBe("$ 472.730");
    expect(pesosCotizacion(0n)).toBe("$ 0");
    expect(pesosCotizacion($(-1_500))).toBe("−$ 1.500");
  });
});

describe("filasCotizacion", () => {
  it("DO.26-0171: conceptos, subtotal, IVA, ReteIVA y TOTAL A GIRAR 472.730 (sin filas de terceros ni 4x1000)", () => {
    const filas = filasCotizacion(dto());
    expect(filas.map((f) => [f.tipo, f.texto, f.valor])).toEqual([
      ["concepto", "LOGÍSTICA DE SUPERVISIÓN Y DESPACHO", "$ 255.000"],
      ["concepto", "DOCUMENTACIÓN", "$ 20.000"],
      ["concepto", "PAPELERÍA", "$ 12.000"],
      ["concepto", "SISTEMATIZACIÓN", "$ 20.000"],
      ["concepto", "SERVICIO LOGÍSTICO", "$ 100.000"],
      ["subtotal", "Subtotal servicios", "$ 407.000"],
      ["impuesto", "IVA", "$ 77.330"],
      ["retencion", "ReteIVA (15 % del IVA)", "− $ 11.600"],
      ["total", "TOTAL A GIRAR", "$ 472.730"],
    ]);
  });

  it("con terceros suma sus filas y el 4x1000, y el total a girar es el de la factura", () => {
    const filas = filasCotizacion(dto({ conTerceros: true }));
    expect(filas.find((f) => f.tipo === "tercero")).toEqual({ tipo: "tercero", texto: "ALMACENAJE ALMACARGA FACT. FE 11298", valor: "$ 502.801" });
    expect(filas.find((f) => f.texto.startsWith("Impuesto 4x1000"))?.valor).toBe("$ 2.011");
    expect(filas.at(-1)).toEqual({ tipo: "total", texto: "TOTAL A GIRAR", valor: "$ 977.542" });
  });
});

describe("textoValorOc", () => {
  it("valor para su orden de compra (sin impuestos): 407.000", () => {
    expect(textoValorOc(dto())).toEqual({
      titulo: "Valor para su orden de compra (sin impuestos)",
      valor: "$ 407.000",
      detalle: "servicios $ 407.000 + pagos a terceros $ 0. No incluye IVA, ReteIVA ni 4x1000.",
    });
  });

  it("la regla por empresa cambia el detalle; sin la función de OC no se imprime", () => {
    expect(textoValorOc(dto({ conTerceros: true }))?.valor).toBe("$ 909.801");
    expect(textoValorOc(dto({ conTerceros: true, configOcSoloServicio: true }))).toMatchObject({
      valor: "$ 407.000",
      detalle: "servicios $ 407.000. No incluye IVA, ReteIVA ni 4x1000.",
    });
    expect(textoValorOc(dto({ usaOrdenCompra: false }))).toBeNull();
  });
});

describe("renderCotizacionPdf", () => {
  it("genera un PDF de verdad (con y sin valor para la OC)", async () => {
    for (const usaOrdenCompra of [true, false]) {
      const buffer = await renderCotizacionPdf(dto({ usaOrdenCompra, conTerceros: true }));
      expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(buffer.length).toBeGreaterThan(1_500);
    }
  });
});
