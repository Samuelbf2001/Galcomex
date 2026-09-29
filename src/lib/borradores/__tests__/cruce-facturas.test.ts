/**
 * Tests unitarios — calcularCruceFacturas
 *
 * Función pura: sin BD, sin efectos secundarios.
 */
import { describe, expect, it } from "vitest";

import { calcularCruceFacturas, desviacionesDelCruce } from "../cruce-facturas";

const fp1 = { id: "fp-1", proveedorNombre: "DIAN", numFactura: "D-001", valor: 17_299_000n };
const fp2 = { id: "fp-2", proveedorNombre: "CONTECAR", numFactura: "C-002", valor: 7_024_869n };

describe("calcularCruceFacturas", () => {
  it("devuelve diferencia 0 cuando pagado == facturado (caso BAQ-18453)", () => {
    const pagosPivot = [
      { facturaId: "fp-1", monto: 17_299_000n },
      { facturaId: "fp-2", monto: 7_024_869n },
    ];
    const lineasPivot = [
      { facturaId: "fp-1", linea: { valor: 17_299_000n } },
      { facturaId: "fp-2", linea: { valor: 7_024_869n } },
    ];

    const result = calcularCruceFacturas([fp1, fp2], pagosPivot, lineasPivot);

    expect(result).toHaveLength(2);
    expect(result[0]!.diferencia).toBe(0n);
    expect(result[1]!.diferencia).toBe(0n);
    expect(result[0]!.montoPagado).toBe(17299000n);
    expect(result[0]!.montoFacturado).toBe(17299000n);
    expect(result[1]!.montoPagado).toBe(7024869n);
    expect(result[1]!.montoFacturado).toBe(7024869n);
  });

  it("devuelve diferencia positiva cuando montoFacturado > montoPagado", () => {
    const pagosPivot = [{ facturaId: "fp-1", monto: 10_000_000n }];
    const lineasPivot = [{ facturaId: "fp-1", linea: { valor: 12_000_000n } }];

    const result = calcularCruceFacturas([fp1], pagosPivot, lineasPivot);

    expect(result[0]!.diferencia).toBe(2000000n);
    expect(result[0]!.montoPagado).toBe(10000000n);
    expect(result[0]!.montoFacturado).toBe(12000000n);
  });

  it("devuelve diferencia negativa cuando montoPagado > montoFacturado", () => {
    const pagosPivot = [{ facturaId: "fp-2", monto: 8_000_000n }];
    const lineasPivot = [{ facturaId: "fp-2", linea: { valor: 7_024_869n } }];

    const result = calcularCruceFacturas([fp2], pagosPivot, lineasPivot);

    expect(result[0]!.diferencia).toBe(-975131n);
  });

  it("devuelve montoPagado y montoFacturado 0 cuando no hay pivots para esa factura", () => {
    const result = calcularCruceFacturas([fp1], [], []);

    expect(result[0]!.montoPagado).toBe(0n);
    expect(result[0]!.montoFacturado).toBe(0n);
    expect(result[0]!.diferencia).toBe(0n);
  });

  it("acumula correctamente múltiples pagos y líneas para la misma factura", () => {
    const pagosPivot = [
      { facturaId: "fp-1", monto: 10_000_000n },
      { facturaId: "fp-1", monto: 7_299_000n },
    ];
    const lineasPivot = [
      { facturaId: "fp-1", linea: { valor: 9_000_000n } },
      { facturaId: "fp-1", linea: { valor: 8_299_000n } },
    ];

    const result = calcularCruceFacturas([fp1], pagosPivot, lineasPivot);

    expect(result[0]!.montoPagado).toBe(17299000n);
    expect(result[0]!.montoFacturado).toBe(17299000n);
    expect(result[0]!.diferencia).toBe(0n);
  });
});

describe("calcularCruceFacturas — repercusión al cliente (M6)", () => {
  const asesoria = {
    id: "fp-asesoria",
    proveedorNombre: "ASCINTER",
    numFactura: "A-900",
    valor: 250_000n,
    repercutible: false,
  };

  it("por defecto una factura es repercutible", () => {
    const result = calcularCruceFacturas([fp1], [], []);

    expect(result[0]!.repercutible).toBe(true);
  });

  it("marca desviación cuando una factura repercutible no cuadra", () => {
    const result = calcularCruceFacturas(
      [fp1],
      [{ facturaId: "fp-1", monto: 17_299_000n }],
      [],
    );

    expect(result[0]!.diferencia).toBe(-17299000n);
    expect(result[0]!.esDesviacion).toBe(true);
  });

  it("la factura que no se traslada al cliente nunca es desviación", () => {
    const result = calcularCruceFacturas(
      [asesoria],
      [{ facturaId: "fp-asesoria", monto: 250_000n }],
      [],
    );

    expect(result[0]!.repercutible).toBe(false);
    expect(result[0]!.montoFacturado).toBe(0n);
    expect(result[0]!.diferencia).toBe(-250000n);
    expect(result[0]!.esDesviacion).toBe(false);
  });

  it("desviacionesDelCruce deja solo lo que el revisor debe mirar", () => {
    const result = calcularCruceFacturas(
      [fp1, asesoria],
      [
        { facturaId: "fp-1", monto: 17_299_000n },
        { facturaId: "fp-asesoria", monto: 250_000n },
      ],
      [],
    );

    const desviaciones = desviacionesDelCruce(result);

    expect(desviaciones).toHaveLength(1);
    expect(desviaciones[0]!.id).toBe("fp-1");
  });
});

describe("calcularCruceFacturas — CxP v2: montoPagado = lo aplicado del puente (CA-40)", () => {
  it("un pago que cubre dos facturas cuenta en cada una solo su monto, no el valor del pago", () => {
    // Pago de 900.000 repartido 502.801 + 397.199 (antes cada factura sumaba 900.000).
    const a = { id: "fa", proveedorNombre: "ALMACARGA", numFactura: "FE 11298", valor: 502_801n };
    const b = { id: "fb", proveedorNombre: "ALMACARGA", numFactura: "FE 12334", valor: 433_361n };
    const result = calcularCruceFacturas(
      [a, b],
      [
        { facturaId: "fa", monto: 502_801n },
        { facturaId: "fb", monto: 397_199n },
      ],
      [
        { facturaId: "fa", linea: { valor: 502_801n } },
        { facturaId: "fb", linea: { valor: 433_361n } },
      ],
    );
    expect(result[0]!.montoPagado).toBe(502801n);
    expect(result[0]!.diferencia).toBe(0n);
    expect(result[1]!.montoPagado).toBe(397199n);
    // Abonada: se facturó al cliente el total, se ha pagado solo el abono.
    expect(result[1]!.diferencia).toBe(36162n);
    expect(result[1]!.esDesviacion).toBe(true);
  });

  it("dos abonos a la misma factura suman exactamente su valor", () => {
    const f = { id: "f", proveedorNombre: "ALMACARGA", numFactura: "FE 12602", valor: 300_000n };
    const result = calcularCruceFacturas(
      [f],
      [
        { facturaId: "f", monto: 100_000n },
        { facturaId: "f", monto: 200_000n },
      ],
      [{ facturaId: "f", linea: { valor: 300_000n } }],
    );
    expect(result[0]!.montoPagado).toBe(300000n);
    expect(result[0]!.esDesviacion).toBe(false);
  });
});

// Fase centavos, D-8: una factura pagada por el entero (502.801) y re-expresada
// a sus centavos reales (502.801,45) queda cerrada con un ajuste REDONDEO de
// 45 centavos. El cruce lo cuenta como pagado y lo dice en la nota.
describe("calcularCruceFacturas — ajuste REDONDEO cuenta como pagado (D-8)", () => {
  const fe11298 = { id: "fe", proveedorNombre: "ALMACARGA", numFactura: "FE-11298", valor: 50_280_145n };

  it("pagado 502.801 + REDONDEO 0,45 = facturado 502.801,45 → sin desviación y con nota", () => {
    const [fila] = calcularCruceFacturas(
      [fe11298],
      [{ facturaId: "fe", monto: 50_280_100n }],
      [{ facturaId: "fe", linea: { valor: 50_280_145n } }],
      [{ facturaId: "fe", tipo: "REDONDEO", monto: 45n }],
    );
    expect(fila!.montoPagado).toBe(50_280_145n);
    expect(fila!.redondeo).toBe(45n);
    expect(fila!.diferencia).toBe(0n);
    expect(fila!.esDesviacion).toBe(false);
    expect(fila!.nota).toBe("incluye redondeo de $\u00a00,45");
  });

  it("sin el ajuste aparecería la desviación de 0,45 (lo que D-8 evita)", () => {
    const [fila] = calcularCruceFacturas(
      [fe11298],
      [{ facturaId: "fe", monto: 50_280_100n }],
      [{ facturaId: "fe", linea: { valor: 50_280_145n } }],
    );
    expect(fila!.diferencia).toBe(45n);
    expect(fila!.esDesviacion).toBe(true);
    expect(fila!.nota).toBeNull();
    expect(fila!.redondeo).toBe(0n);
  });

  it("otros ajustes (nota crédito, LEGADO…) no cuentan como pagado", () => {
    const [fila] = calcularCruceFacturas(
      [fe11298],
      [{ facturaId: "fe", monto: 50_000_000n }],
      [{ facturaId: "fe", linea: { valor: 50_280_145n } }],
      [
        { facturaId: "fe", tipo: "NOTA_CREDITO", monto: 280_145n },
        { facturaId: "fe", tipo: "LEGADO", monto: 1n },
      ],
    );
    expect(fila!.montoPagado).toBe(50_000_000n);
    expect(fila!.redondeo).toBe(0n);
  });
});

describe("calcularCruceFacturas — lo facturado al cliente no pasa del valor de la factura", () => {
  it("líneas TERCEROS que suman más que el valor de la factura → facturadoExcedeValor y desviación", () => {
    const f = { id: "f", proveedorNombre: "ALMACARGA", numFactura: "FE 12481", valor: 500_000n };
    const [fila] = calcularCruceFacturas(
      [f],
      [{ facturaId: "f", monto: 500_000n }],
      [
        { facturaId: "f", linea: { valor: 500_000n } },
        { facturaId: "f", linea: { valor: 120_000n } },
      ],
    );
    expect(fila!.montoFacturado).toBe(620_000n);
    expect(fila!.facturadoExcedeValor).toBe(true);
    expect(fila!.noCobrableFacturada).toBe(false);
    expect(fila!.esDesviacion).toBe(true);
  });

  it("facturado igual al valor no es exceso, aunque la factura esté solo abonada", () => {
    const f = { id: "f", proveedorNombre: "ALMACARGA", numFactura: "FE 12539", valor: 500_000n };
    const [fila] = calcularCruceFacturas(
      [f],
      [{ facturaId: "f", monto: 200_000n }],
      [{ facturaId: "f", linea: { valor: 500_000n } }],
    );
    expect(fila!.facturadoExcedeValor).toBe(false);
    // Desfase pagado ↔ facturado (abono): sigue siendo desviación, no exceso.
    expect(fila!.esDesviacion).toBe(true);
  });

  it("una asesoría NO SE COBRA con líneas de venta vinculadas es desviación (se le cobraría al cliente)", () => {
    const s = {
      id: "s",
      proveedorNombre: "ASCINTER",
      numFactura: "S-1",
      valor: 300_000n,
      repercutible: false,
    };
    const [fila] = calcularCruceFacturas(
      [s],
      [{ facturaId: "s", monto: 300_000n }],
      [{ facturaId: "s", linea: { valor: 300_000n } }],
    );
    expect(fila!.noCobrableFacturada).toBe(true);
    expect(fila!.esDesviacion).toBe(true);
    // Sin líneas, la asesoría no molesta.
    const [limpia] = calcularCruceFacturas([s], [{ facturaId: "s", monto: 300_000n }], []);
    expect(limpia!.noCobrableFacturada).toBe(false);
    expect(limpia!.esDesviacion).toBe(false);
  });
});
