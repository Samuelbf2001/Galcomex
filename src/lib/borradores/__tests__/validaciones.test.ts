/**
 * Tests unitarios — calcularValidacionesCruce
 *
 * Función pura: sin BD, sin efectos secundarios.
 */
import { describe, expect, it } from "vitest";

import { calcularValidacionesCruce } from "../validaciones";

describe("calcularValidacionesCruce", () => {
  it("cuadre exacto: diferencia 0 cuando Σ facturas == Σ pagos vinculados", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:dian", proveedorNombre: "DIAN", valor: 17_299_000n },
    ];
    const pagos = [{ facturaId: "fp-1", valor: 17_299_000n }];

    const result = calcularValidacionesCruce(facturas, pagos, []);

    expect(result.proveedores).toHaveLength(1);
    expect(result.proveedores[0]).toMatchObject({
      proveedorId: "b:dian",
      proveedorNombre: "DIAN",
      totalFacturas: "17299000",
      totalPagos: "17299000",
      diferencia: "0",
      cuadra: true,
    });
  });

  it("diferencia positiva: facturado más de lo pagado (varias facturas del mismo proveedor)", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:contecar", proveedorNombre: "CONTECAR", valor: 7_000_000n },
      { id: "fp-2", proveedorId: "b:contecar", proveedorNombre: "CONTECAR", valor: 5_000_000n },
    ];
    const pagos = [{ facturaId: "fp-1", valor: 7_000_000n }, { facturaId: "fp-2", valor: 3_000_000n }];

    const result = calcularValidacionesCruce(facturas, pagos, []);

    expect(result.proveedores).toHaveLength(1);
    expect(result.proveedores[0]!.totalFacturas).toBe("12000000");
    expect(result.proveedores[0]!.totalPagos).toBe("10000000");
    expect(result.proveedores[0]!.diferencia).toBe("2000000");
    expect(result.proveedores[0]!.cuadra).toBe(false);
  });

  it("diferencia negativa: pagado más de lo facturado", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:naviera", proveedorNombre: "NAVIERA", valor: 5_000_000n },
    ];
    const pagos = [{ facturaId: "fp-1", valor: 6_500_000n }];

    const result = calcularValidacionesCruce(facturas, pagos, []);

    expect(result.proveedores[0]!.diferencia).toBe("-1500000");
    expect(result.proveedores[0]!.cuadra).toBe(false);
  });

  it("proveedor sin pagos: totalPagos 0 y diferencia == totalFacturas", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:puerto", proveedorNombre: "PUERTO", valor: 3_200_000n },
    ];

    const result = calcularValidacionesCruce(facturas, [], []);

    expect(result.proveedores[0]!.totalPagos).toBe("0");
    expect(result.proveedores[0]!.totalFacturas).toBe("3200000");
    expect(result.proveedores[0]!.diferencia).toBe("3200000");
    expect(result.proveedores[0]!.cuadra).toBe(false);
  });

  it("pago sin factura: se reporta como pago suelto, no afecta ningún proveedor", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:dian", proveedorNombre: "DIAN", valor: 1_000_000n },
    ];
    const pagos = [{ facturaId: "fp-1", valor: 1_000_000n }];
    const pagosSueltos = [
      {
        pagoId: "pago-suelto-1",
        concepto: "Transporte interno",
        numSoporte: "SOP-9",
        valor: 250_000n,
      },
    ];

    const result = calcularValidacionesCruce(facturas, pagos, pagosSueltos);

    expect(result.proveedores[0]!.cuadra).toBe(true);
    expect(result.pagosSueltos).toHaveLength(1);
    expect(result.pagosSueltos[0]).toMatchObject({
      pagoId: "pago-suelto-1",
      concepto: "Transporte interno",
      numSoporte: "SOP-9",
      valor: "250000",
    });
  });

  it("sin facturas ni pagos: listas vacías", () => {
    const result = calcularValidacionesCruce([], [], []);
    expect(result.proveedores).toEqual([]);
    expect(result.pagosSueltos).toEqual([]);
  });

  it("mantiene proveedores separados por proveedorId aunque el nombre se repita", () => {
    const facturas = [
      { id: "fp-1", proveedorId: "b:1", proveedorNombre: "Mismo Nombre SAS", valor: 1_000_000n },
      { id: "fp-2", proveedorId: "b:2", proveedorNombre: "Mismo Nombre SAS", valor: 2_000_000n },
    ];

    const result = calcularValidacionesCruce(facturas, [], []);

    expect(result.proveedores).toHaveLength(2);
  });
});
