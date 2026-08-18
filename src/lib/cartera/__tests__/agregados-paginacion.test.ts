/**
 * Tests de la función pura calcularAgregadoCartera — D2-b
 *
 * Cartera sin paginación server-side traía TODAS las facturas del cliente y
 * agregaba en memoria (`.claude/PENDIENTES.md` D2-b). `calcularAgregadoCartera`
 * es el núcleo puro que separa "filas de la página" (idsPagina, respeta
 * take/skip y soloPendientes) de "agregados del total" (cruceCliente,
 * cruceLM, totalFacturas — SIEMPRE sobre el conjunto completo, nunca sobre la
 * página). No requiere BD — es una función pura sobre BigInt, igual que
 * `calcularSaldoNeto` en `service.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  calcularAgregadoCartera,
  type FacturaBaseLedger,
  type SumaPagosFactura,
} from "../service";

function factura(id: string, partial: Partial<FacturaBaseLedger> = {}): FacturaBaseLedger {
  return {
    id,
    saldoAFavorCliente: 0n,
    saldoACargoCliente: 0n,
    saldoAFavorLM: 0n,
    saldoACargoLM: 0n,
    ...partial,
  };
}

describe("calcularAgregadoCartera", () => {
  it("sin take/skip (undefined) devuelve TODAS las facturas en idsPagina — modo 'sin paginar' del export/PDF", () => {
    const facturas = [
      factura("f1", { saldoACargoCliente: 100_000n }),
      factura("f2", { saldoACargoCliente: 200_000n }),
      factura("f3", { saldoACargoCliente: 300_000n }),
    ];

    const result = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
    });

    expect(result.idsPagina).toEqual(["f1", "f2", "f3"]);
    expect(result.totalFacturas).toBe(3);
  });

  it("take/skip pagina idsPagina SIN alterar los agregados del total (cruceCliente/cruceLM/totalFacturas)", () => {
    const facturas = [
      factura("f1", { saldoACargoCliente: 500_000n }),
      factura("f2", { saldoACargoCliente: 300_000n }),
      factura("f3", { saldoAFavorCliente: 150_000n }),
      factura("f4", { saldoAFavorCliente: 250_000n }),
      factura("f5", { saldoACargoCliente: 200_000n }),
    ];

    // cruceCliente = Σ(saldoAFavor − saldoACargo) = -500k -300k +150k +250k -200k = -600.000
    const esperadoCruceCliente = -600_000n;

    const pagina1 = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
      take: 2,
      skip: 0,
    });
    const pagina2 = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
      take: 2,
      skip: 2,
    });
    const pagina3 = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
      take: 2,
      skip: 4,
    });

    // Las tres páginas cubren el conjunto completo sin solaparse ni perder filas.
    expect(pagina1.idsPagina).toEqual(["f1", "f2"]);
    expect(pagina2.idsPagina).toEqual(["f3", "f4"]);
    expect(pagina3.idsPagina).toEqual(["f5"]);

    // El agregado es EXACTAMENTE el mismo en las tres páginas — nunca se
    // calcula sobre la porción visible, siempre sobre el total.
    for (const pagina of [pagina1, pagina2, pagina3]) {
      expect(pagina.cruceCliente).toBe(esperadoCruceCliente);
      expect(pagina.totalFacturas).toBe(5);
    }
  });

  it("página fuera de rango (skip >= total) devuelve idsPagina vacío pero conserva el agregado del total", () => {
    const facturas = [
      factura("f1", { saldoACargoCliente: 100_000n }),
      factura("f2", { saldoACargoCliente: 200_000n }),
    ];

    const result = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
      take: 10,
      skip: 50,
    });

    expect(result.idsPagina).toEqual([]);
    expect(result.totalFacturas).toBe(2);
    expect(result.cruceCliente).toBe(-300_000n);
  });

  it("soloPendientes excluye solo facturas saldadas en AMBOS destinos (saldoNetoCliente===0 Y saldoNetoLM===0)", () => {
    const facturas = [
      // Saldada en ambos destinos → excluida.
      factura("saldada", {}),
      // A cargo del cliente, LM en cero → incluida (cliente != 0).
      factura("pendiente-cliente", { saldoACargoCliente: 100_000n }),
      // Cliente saldado, LM pendiente → incluida (LM != 0).
      factura("pendiente-lm", { saldoACargoLM: 50_000n }),
    ];

    const result = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: true,
    });

    expect(result.idsPagina.sort()).toEqual(["pendiente-cliente", "pendiente-lm"]);
    expect(result.totalFacturas).toBe(2);
  });

  it("soloPendientes NO afecta cruceCliente/cruceLM: las facturas excluidas siempre aportan 0 (por definición del filtro)", () => {
    const facturas = [
      factura("saldada", {}), // saldoNeto 0 en ambos destinos por construcción
      factura("pendiente", { saldoACargoCliente: 400_000n }),
    ];

    const conFiltro = calcularAgregadoCartera(facturas, new Map(), { soloPendientes: true });
    const sinFiltro = calcularAgregadoCartera(facturas, new Map(), { soloPendientes: false });

    expect(conFiltro.cruceCliente).toBe(sinFiltro.cruceCliente);
    expect(conFiltro.cruceCliente).toBe(-400_000n);
    // Pero totalFacturas SÍ difiere — ese es justamente el propósito del filtro.
    expect(conFiltro.totalFacturas).toBe(1);
    expect(sinFiltro.totalFacturas).toBe(2);
  });

  it("las sumas de abonos/devoluciones (groupBy) se reflejan en el saldoNeto agregado", () => {
    const facturas = [factura("f1", { saldoACargoCliente: 1_000_000n, saldoACargoLM: 500_000n })];

    const sumas = new Map<string, SumaPagosFactura>([
      [
        "f1",
        {
          abonosCliente: 400_000n,
          devolucionesCliente: 0n,
          abonosLM: 500_000n, // salda LM exactamente
          devolucionesLM: 0n,
        },
      ],
    ]);

    const result = calcularAgregadoCartera(facturas, sumas, { soloPendientes: false });

    // saldoNetoCliente = 0 - 1.000.000 + 400.000 - 0 = -600.000
    // saldoNetoLM      = 0 -   500.000 + 500.000 - 0 =        0
    expect(result.cruceCliente).toBe(-600_000n);
    expect(result.cruceLM).toBe(0n);

    // soloPendientes=true la mantiene (cliente != 0), aunque LM ya esté en 0.
    const soloPend = calcularAgregadoCartera(facturas, sumas, { soloPendientes: true });
    expect(soloPend.idsPagina).toEqual(["f1"]);
  });

  it("factura sin entrada en el mapa de sumas se trata como sin abonos/devoluciones (0n)", () => {
    const facturas = [factura("sin-pagos", { saldoACargoCliente: 250_000n })];

    const result = calcularAgregadoCartera(facturas, new Map(), { soloPendientes: false });

    expect(result.cruceCliente).toBe(-250_000n);
  });

  it("conjunto vacío devuelve agregados en cero sin lanzar", () => {
    const result = calcularAgregadoCartera([], new Map(), {
      soloPendientes: true,
      take: 50,
      skip: 0,
    });

    expect(result.idsFiltrados).toEqual([]);
    expect(result.idsPagina).toEqual([]);
    expect(result.totalFacturas).toBe(0);
    expect(result.cruceCliente).toBe(0n);
    expect(result.cruceLM).toBe(0n);
  });

  it("skip sin take (take undefined) devuelve todo desde skip en adelante, sin límite superior", () => {
    const facturas = [factura("f1"), factura("f2"), factura("f3"), factura("f4")];

    const result = calcularAgregadoCartera(facturas, new Map(), {
      soloPendientes: false,
      skip: 2,
    });

    expect(result.idsPagina).toEqual(["f3", "f4"]);
  });
});
