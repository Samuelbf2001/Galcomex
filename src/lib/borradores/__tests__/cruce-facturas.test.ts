/**
 * Tests unitarios — calcularCruceFacturas
 *
 * Función pura: sin BD, sin efectos secundarios.
 */
import { describe, expect, it } from "vitest";

import { calcularCruceFacturas } from "../cruce-facturas";

const fp1 = { id: "fp-1", proveedorNombre: "DIAN", numFactura: "D-001", valor: 17_299_000n };
const fp2 = { id: "fp-2", proveedorNombre: "CONTECAR", numFactura: "C-002", valor: 7_024_869n };

describe("calcularCruceFacturas", () => {
  it("devuelve diferencia 0 cuando pagado == facturado (caso BAQ-18453)", () => {
    const pagosPivot = [
      { facturaId: "fp-1", pago: { valor: 17_299_000n } },
      { facturaId: "fp-2", pago: { valor: 7_024_869n } },
    ];
    const lineasPivot = [
      { facturaId: "fp-1", linea: { valor: 17_299_000n } },
      { facturaId: "fp-2", linea: { valor: 7_024_869n } },
    ];

    const result = calcularCruceFacturas([fp1, fp2], pagosPivot, lineasPivot);

    expect(result).toHaveLength(2);
    expect(result[0]!.diferencia).toBe("0");
    expect(result[1]!.diferencia).toBe("0");
    expect(result[0]!.montoPagado).toBe("17299000");
    expect(result[0]!.montoFacturado).toBe("17299000");
    expect(result[1]!.montoPagado).toBe("7024869");
    expect(result[1]!.montoFacturado).toBe("7024869");
  });

  it("devuelve diferencia positiva cuando montoFacturado > montoPagado", () => {
    const pagosPivot = [{ facturaId: "fp-1", pago: { valor: 10_000_000n } }];
    const lineasPivot = [{ facturaId: "fp-1", linea: { valor: 12_000_000n } }];

    const result = calcularCruceFacturas([fp1], pagosPivot, lineasPivot);

    expect(result[0]!.diferencia).toBe("2000000");
    expect(result[0]!.montoPagado).toBe("10000000");
    expect(result[0]!.montoFacturado).toBe("12000000");
  });

  it("devuelve diferencia negativa cuando montoPagado > montoFacturado", () => {
    const pagosPivot = [{ facturaId: "fp-2", pago: { valor: 8_000_000n } }];
    const lineasPivot = [{ facturaId: "fp-2", linea: { valor: 7_024_869n } }];

    const result = calcularCruceFacturas([fp2], pagosPivot, lineasPivot);

    expect(result[0]!.diferencia).toBe("-975131");
  });

  it("devuelve montoPagado y montoFacturado 0 cuando no hay pivots para esa factura", () => {
    const result = calcularCruceFacturas([fp1], [], []);

    expect(result[0]!.montoPagado).toBe("0");
    expect(result[0]!.montoFacturado).toBe("0");
    expect(result[0]!.diferencia).toBe("0");
  });

  it("acumula correctamente múltiples pagos y líneas para la misma factura", () => {
    const pagosPivot = [
      { facturaId: "fp-1", pago: { valor: 10_000_000n } },
      { facturaId: "fp-1", pago: { valor: 7_299_000n } },
    ];
    const lineasPivot = [
      { facturaId: "fp-1", linea: { valor: 9_000_000n } },
      { facturaId: "fp-1", linea: { valor: 8_299_000n } },
    ];

    const result = calcularCruceFacturas([fp1], pagosPivot, lineasPivot);

    expect(result[0]!.montoPagado).toBe("17299000");
    expect(result[0]!.montoFacturado).toBe("17299000");
    expect(result[0]!.diferencia).toBe("0");
  });
});
