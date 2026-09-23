/**
 * Tests de la cuenta corriente por contraparte (M5) — función pura, sin BD.
 * Tolerancia 0 pesos, como el resto de los cálculos de dinero del proyecto.
 */
import { describe, expect, it } from "vitest";

import {
  asientoDesde,
  asientosDeCompensacion,
  calcularCuentaCorriente,
  describirNeto,
  maximoCompensable,
  type AsientoCuenta,
  type FuenteAsiento,
} from "@/lib/cuenta-corriente/calculo";

let secuencia = 0;

function asiento(
  fuente: FuenteAsiento,
  valor: bigint,
  extras: Partial<AsientoCuenta> = {},
): AsientoCuenta {
  secuencia += 1;
  return asientoDesde({
    id: `a-${secuencia}`,
    fuente,
    lineaServicio: extras.lineaServicio ?? "TRAMITE",
    concepto: extras.concepto ?? fuente,
    fecha: extras.fecha ?? new Date("2026-03-01"),
    valor,
    referencia: extras.referencia ?? null,
  });
}

describe("asientoDesde — signo por fuente", () => {
  it("lo que le facturamos al cliente suma a favor de Galcomex", () => {
    expect(asiento("FACTURA_VENTA", 5_000_000n).valor).toBe(5_000_000n);
    expect(asiento("COMISION", 45_000n).valor).toBe(45_000n);
    expect(asiento("PAGO_PROVEEDOR", 1_000_000n).valor).toBe(1_000_000n);
  });

  it("lo que nos factura o nos paga la empresa suma a su favor", () => {
    expect(asiento("FACTURA_PROVEEDOR", 250_000n).valor).toBe(-250_000n);
    expect(asiento("ABONO_CLIENTE", 3_000_000n).valor).toBe(-3_000_000n);
    expect(asiento("CARGO_MANUAL", 4_000_000n).valor).toBe(-4_000_000n);
  });

  it("normaliza aunque le pasen el importe con el signo cambiado", () => {
    expect(asiento("FACTURA_PROVEEDOR", -250_000n).valor).toBe(-250_000n);
    expect(asiento("FACTURA_VENTA", -5_000_000n).valor).toBe(5_000_000n);
  });

  it("el ajuste conserva el signo que le den: puede ir en cualquier dirección", () => {
    expect(asiento("AJUSTE", -120_000n).valor).toBe(-120_000n);
    expect(asiento("AJUSTE", 120_000n).valor).toBe(120_000n);
  });

  it("facturaId/borradorId son campos aditivos: pasan intactos, sin tocar el signo", () => {
    const conFactura = asientoDesde({
      id: "factura:f1",
      fuente: "FACTURA_VENTA",
      lineaServicio: "TRAMITE",
      concepto: "Factura BAQ-18453",
      fecha: new Date("2026-03-01"),
      valor: 1_946_500n,
      tramiteId: "t1",
      facturaId: "f1",
      borradorId: "b1",
    });

    expect(conFactura.facturaId).toBe("f1");
    expect(conFactura.borradorId).toBe("b1");
    expect(conFactura.valor).toBe(1_946_500n);

    const sinFactura = asientoDesde({
      id: "manual:m1",
      fuente: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Mensualidad",
      fecha: new Date("2026-03-01"),
      valor: 4_000_000n,
    });
    expect(sinFactura.facturaId).toBeUndefined();
    expect(sinFactura.borradorId).toBeUndefined();
  });
});

describe("calcularCuentaCorriente", () => {
  it("una cuenta vacía queda en cero", () => {
    const resumen = calcularCuentaCorriente([]);

    expect(resumen.totalACargo).toBe(0n);
    expect(resumen.totalAFavor).toBe(0n);
    expect(resumen.neto).toBe(0n);
    expect(resumen.porLinea).toEqual([]);
    expect(resumen.cantidad).toBe(0);
  });

  it("cruza las dos puntas de una empresa que es cliente y proveedor (caso Ascinter)", () => {
    // Le facturamos trámites por 12.000.000, nos abonó 8.000.000,
    // y nos facturó transporte 1.200.000 + asesoría 250.000 que ya le pagamos 1.200.000.
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 12_000_000n),
      asiento("ABONO_CLIENTE", 8_000_000n),
      asiento("FACTURA_PROVEEDOR", 1_200_000n),
      asiento("FACTURA_PROVEEDOR", 250_000n, { lineaServicio: "ASESORIA" }),
      asiento("PAGO_PROVEEDOR", 1_200_000n),
    ]);

    expect(resumen.totalACargo).toBe(13_200_000n); // 12.000.000 + 1.200.000
    expect(resumen.totalAFavor).toBe(9_450_000n); // 8.000.000 + 1.200.000 + 250.000
    expect(resumen.neto).toBe(3_750_000n);
    expect(describirNeto(resumen.neto, "ASCINTER")).toBe("ASCINTER le debe a Galcomex");
  });

  it("un proveedor puro queda con saldo a su favor (caso Coldex)", () => {
    const resumen = calcularCuentaCorriente([
      asiento("CARGO_MANUAL", 4_000_000n, { concepto: "Servicios aduaneros marzo" }),
      asiento("CARGO_MANUAL", 2_100_000n, { concepto: "Quincenas Lucho y Karina" }),
      asiento("PAGO_PROVEEDOR", 3_000_000n),
    ]);

    expect(resumen.totalAFavor).toBe(6_100_000n);
    expect(resumen.totalACargo).toBe(3_000_000n);
    expect(resumen.neto).toBe(-3_100_000n);
    expect(describirNeto(resumen.neto, "COLDEX")).toBe("Galcomex le debe a COLDEX");
  });

  it("acumula las comisiones por contenedor a favor de Galcomex (caso Eltrans)", () => {
    const resumen = calcularCuentaCorriente([
      asiento("COMISION", 45_000n, { lineaServicio: "COMISION", referencia: "DO.BAQ26-0001" }),
      asiento("COMISION", 90_000n, { lineaServicio: "COMISION", referencia: "DO.BAQ26-0002" }),
    ]);

    expect(resumen.neto).toBe(135_000n);
    expect(resumen.porLinea).toEqual([
      { lineaServicio: "COMISION", aCargo: 135_000n, aFavor: 0n, neto: 135_000n },
    ]);
  });

  it("separa las carteras por línea de servicio", () => {
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 5_000_000n),
      asiento("FACTURA_VENTA", 380_000n, { lineaServicio: "CLASIFICACION" }),
      asiento("ABONO_CLIENTE", 380_000n, { lineaServicio: "CLASIFICACION" }),
      asiento("FACTURA_VENTA", 406_525n, { lineaServicio: "PLAN_VALLEJO" }),
    ]);

    expect(resumen.porLinea.map((l) => l.lineaServicio)).toEqual([
      "CLASIFICACION",
      "PLAN_VALLEJO",
      "TRAMITE",
    ]);

    const clasificacion = resumen.porLinea.find((l) => l.lineaServicio === "CLASIFICACION");
    expect(clasificacion?.neto).toBe(0n); // facturada y cobrada
    expect(resumen.neto).toBe(5_406_525n);
  });

  it("la suma de los netos por línea es el neto total", () => {
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 5_000_000n),
      asiento("FACTURA_PROVEEDOR", 1_450_000n, { lineaServicio: "ASESORIA" }),
      asiento("COMISION", 135_000n, { lineaServicio: "COMISION" }),
      asiento("ABONO_CLIENTE", 2_000_000n),
    ]);

    const suma = resumen.porLinea.reduce((acc, linea) => acc + linea.neto, 0n);
    expect(suma).toBe(resumen.neto);
  });

  it("ordena los movimientos del más reciente al más antiguo", () => {
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 1n, { fecha: new Date("2026-01-15"), concepto: "enero" }),
      asiento("FACTURA_VENTA", 1n, { fecha: new Date("2026-03-15"), concepto: "marzo" }),
      asiento("FACTURA_VENTA", 1n, { fecha: new Date("2026-02-15"), concepto: "febrero" }),
    ]);

    expect(resumen.movimientos.map((m) => m.concepto)).toEqual([
      "marzo",
      "febrero",
      "enero",
    ]);
  });

  it("una cuenta saldada da neto cero y se describe como tal", () => {
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 2_500_000n),
      asiento("ABONO_CLIENTE", 2_500_000n),
    ]);

    expect(resumen.neto).toBe(0n);
    expect(describirNeto(0n, "LITOPLAS")).toBe("La cuenta con LITOPLAS está saldada");
  });

  it("no pierde pesos con importes grandes", () => {
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 45_226_000n),
      asiento("ABONO_CLIENTE", 41_868_042n),
    ]);

    expect(resumen.neto).toBe(3_357_958n);
  });
});

describe("cruce de saldos (compensación)", () => {

  it("maximoCompensable es el pendiente menor, y cero si alguna punta no debe", () => {
    expect(maximoCompensable({ pendienteCliente: 1_500_000n, pendienteProveedor: 4_000_000n })).toBe(1_500_000n);
    expect(maximoCompensable({ pendienteCliente: 9_000_000n, pendienteProveedor: 4_000_000n })).toBe(4_000_000n);
    expect(maximoCompensable({ pendienteCliente: 0n, pendienteProveedor: 4_000_000n })).toBe(0n);
    expect(maximoCompensable({ pendienteCliente: 2_000_000n, pendienteProveedor: -300_000n })).toBe(0n);
  });

  it("los pendientes son netos por punta, no flujos brutos", () => {
    // Le facturamos 10M y nos abonó 8M: bruto 10M / 8M, pero solo nos debe 2M.
    const resumen = calcularCuentaCorriente([
      asiento("FACTURA_VENTA", 10_000_000n),
      asiento("ABONO_CLIENTE", 8_000_000n),
      asiento("FACTURA_PROVEEDOR", 3_000_000n),
      asiento("PAGO_PROVEEDOR", 500_000n),
    ]);
    expect(resumen.totalACargo).toBe(10_500_000n);
    expect(resumen.totalAFavor).toBe(11_000_000n);
    expect(resumen.pendienteCliente).toBe(2_000_000n);
    expect(resumen.pendienteProveedor).toBe(2_500_000n);
    expect(resumen.neto).toBe(resumen.pendienteCliente - resumen.pendienteProveedor);
    expect(maximoCompensable(resumen)).toBe(2_000_000n);
  });

  it("las dos puntas del cruce bajan cada lado por el mismo importe y el neto no cambia", () => {
    // Coldex: nos debe 1.500.000 (liberación de BL) y le debemos 4.000.000 (mensualidad).
    const base = [
      asiento("FACTURA_VENTA", 1_500_000n, { concepto: "Liberación de BL" }),
      asiento("CARGO_MANUAL", 4_000_000n, { concepto: "Mensualidad" }),
    ];
    const antes = calcularCuentaCorriente(base);
    expect(antes.pendienteCliente).toBe(1_500_000n);
    expect(antes.pendienteProveedor).toBe(4_000_000n);
    expect(antes.neto).toBe(-2_500_000n);

    const cruce = asientosDeCompensacion({
      compensacionId: "c1",
      valor: 1_500_000n,
      fecha: new Date("2026-03-15"),
      concepto: "Liberación de BL contra mensualidad",
      lineaServicio: "TRAMITE",
    });
    const despues = calcularCuentaCorriente([...base, ...cruce]);
    expect(despues.pendienteCliente).toBe(0n);
    expect(despues.pendienteProveedor).toBe(2_500_000n);
    expect(despues.neto).toBe(antes.neto);
    // En bruto, el cruce cuenta como un abono y un pago: no se pierde el rastro.
    expect(despues.totalACargo).toBe(3_000_000n);
    expect(despues.totalAFavor).toBe(5_500_000n);
    expect(cruce.every((a) => a.compensacionId === "c1")).toBe(true);
  });

  it("asientoDesde conserva el signo de COMPENSACION", () => {
    expect(asiento("COMPENSACION", -700_000n).valor).toBe(-700_000n);
    expect(asiento("COMPENSACION", 700_000n).valor).toBe(700_000n);
  });
});
