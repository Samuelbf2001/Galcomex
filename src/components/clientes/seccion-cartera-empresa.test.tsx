import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CarteraData, FacturaRow } from "@/components/cartera/cartera-api";
import { fetchCartera, formatCOP } from "@/components/cartera/cartera-api";
import { RolProvider } from "@/lib/auth/rol-context";

import {
  calcularKpisCarteraEmpresa,
  estadoFacturaCartera,
  fraseNetoCartera,
  SeccionCarteraEmpresa,
} from "./seccion-cartera-empresa";

vi.mock("@/components/cartera/cartera-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/cartera/cartera-api")>();
  return { ...original, fetchCartera: vi.fn() };
});

// ─── Helpers puros ────────────────────────────────────────────────────────────

function fila(overrides: Partial<FacturaRow> = {}): FacturaRow {
  return {
    id: "f1",
    borradorId: "b1",
    clienteId: "c1",
    numSiigo: "BAQ-1",
    fecha: "2026-01-10T00:00:00.000Z",
    totalFactura: "1000000",
    saldoAFavorCliente: "0",
    saldoACargoCliente: "1000000",
    saldoAFavorLM: "0",
    saldoACargoLM: "0",
    fechaPagoCliente: null,
    fechaPagoLM: null,
    createdAt: "2026-01-10T00:00:00.000Z",
    updatedAt: "2026-01-10T00:00:00.000Z",
    borrador: { tramiteId: "t1", tramite: { consecutivo: "DO.BAQ26-0001" } },
    saldoNetoCliente: "-500000",
    pendienteCobroCliente: "500000",
    pendienteDevolucionCliente: "0",
    saldoNetoLM: "0",
    pendienteCobroLM: "0",
    pendienteDevolucionLM: "0",
    costosBancariosCliente: "0",
    costosBancariosLM: "0",
    totalRealLM: "0",
    pagos: [],
    lineaServicio: "TRAMITE",
    abonosCliente: "0",
    devolucionesCliente: "0",
    ...overrides,
  };
}

describe("estadoFacturaCartera", () => {
  it("por cobrar cuando queda pendiente de cobro (a cargo del cliente)", () => {
    expect(
      estadoFacturaCartera({ pendienteCobroCliente: "500000", pendienteDevolucionCliente: "0" }),
    ).toBe("POR_COBRAR");
  });

  it("por devolver cuando queda a favor del cliente", () => {
    expect(
      estadoFacturaCartera({ pendienteCobroCliente: "0", pendienteDevolucionCliente: "200000" }),
    ).toBe("POR_DEVOLVER");
  });

  it("saldada cuando los dos pendientes están en cero", () => {
    expect(
      estadoFacturaCartera({ pendienteCobroCliente: "0", pendienteDevolucionCliente: "0" }),
    ).toBe("SALDADA");
  });
});

describe("calcularKpisCarteraEmpresa", () => {
  it("suma los pendientes de cobro y de devolución por separado, con BigInt", () => {
    const kpis = calcularKpisCarteraEmpresa([
      { pendienteCobroCliente: "500000", pendienteDevolucionCliente: "0" },
      { pendienteCobroCliente: "0", pendienteDevolucionCliente: "200000" },
      { pendienteCobroCliente: "0", pendienteDevolucionCliente: "0" },
    ]);

    expect(kpis.totalACargo).toBe(500_000n);
    expect(kpis.totalAFavor).toBe(200_000n);
  });

  it("sin facturas, los dos totales quedan en cero", () => {
    expect(calcularKpisCarteraEmpresa([])).toEqual({ totalACargo: 0n, totalAFavor: 0n });
  });
});

describe("fraseNetoCartera", () => {
  it("cruce negativo: el cliente le debe a Galcomex", () => {
    expect(fraseNetoCartera("-300000", "Coldex")).toBe(`Coldex le debe a Galcomex ${formatCOP("300000")}`);
  });

  it("cruce positivo: Galcomex le debe al cliente", () => {
    expect(fraseNetoCartera("300000", "Coldex")).toBe(`Galcomex le debe a Coldex ${formatCOP("300000")}`);
  });

  it("cruce en cero: saldada", () => {
    expect(fraseNetoCartera("0", "Coldex")).toBe("Saldada");
  });
});

// ─── Componente ────────────────────────────────────────────────────────────

describe("SeccionCarteraEmpresa", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function montar(datos: CarteraData, rol: "ADMIN" | "REVISOR" | "OPERATIVO" = "ADMIN") {
    vi.mocked(fetchCartera).mockResolvedValue(datos);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <RolProvider rol={rol}>
          <SeccionCarteraEmpresa clienteId="c1" nombreEmpresa="Coldex" />
        </RolProvider>,
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("no consulta ni pinta nada para un rol sin permiso (OPERATIVO)", async () => {
    await montar({ facturas: [fila()], cruceCliente: "-500000", cruceLM: "0", totalFacturas: 1 }, "OPERATIVO");

    expect(fetchCartera).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("pinta los 3 KPIs, la tabla con estado por fila y el enlace a Cartera", async () => {
    const facturas = [
      fila({
        id: "f1",
        numSiigo: "BAQ-1",
        fecha: "2026-01-10T00:00:00.000Z",
        pendienteCobroCliente: "500000",
        pendienteDevolucionCliente: "0",
        abonosCliente: "450000",
        devolucionesCliente: "50000",
        borrador: { tramiteId: "t1", tramite: { consecutivo: "DO.BAQ26-0001" } },
      }),
      fila({
        id: "f2",
        numSiigo: "BAQ-2",
        fecha: "2026-02-15T00:00:00.000Z",
        pendienteCobroCliente: "0",
        pendienteDevolucionCliente: "200000",
        borrador: { tramiteId: "t2", tramite: { consecutivo: "DO.BAQ26-0002" } },
      }),
      fila({
        id: "f3",
        numSiigo: "BAQ-3",
        fecha: "2026-03-01T00:00:00.000Z",
        pendienteCobroCliente: "0",
        pendienteDevolucionCliente: "0",
        borrador: null,
      }),
    ];

    await montar({ facturas, cruceCliente: "-300000", cruceLM: "0", totalFacturas: 3 });

    expect(fetchCartera).toHaveBeenCalledWith("c1", false, undefined, undefined, expect.any(AbortSignal));

    // KPIs
    expect(container.textContent).toContain("Saldo a cargo del cliente");
    expect(container.textContent).toContain(formatCOP("500000"));
    expect(container.textContent).toContain("Saldo a favor del cliente");
    expect(container.textContent).toContain(formatCOP("200000"));
    expect(container.textContent).toContain(`Coldex le debe a Galcomex ${formatCOP("300000")}`);

    // Newest first: BAQ-3, BAQ-2, BAQ-1
    const numeros = [...container.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
    expect(numeros).toEqual(["BAQ-3", "BAQ-2", "BAQ-1"]);

    // Estado por fila
    expect(container.textContent).toContain("Por cobrar");
    expect(container.textContent).toContain("Por devolver o cruzar");
    expect(container.textContent).toContain("Saldada");

    // Abonado con la línea de devolución
    expect(container.textContent).toContain(`Devuelto ${formatCOP("50000")}`);

    // BAQ-1 enlaza a Facturación (ADMIN); BAQ-3 sin borrador no enlaza.
    const enlaceBaq1 = [...container.querySelectorAll("a")].find((a) => a.textContent === "BAQ-1");
    expect(enlaceBaq1?.getAttribute("href")).toBe("/facturacion?tramiteId=t1&borrador=b1");
    const filaBaq3 = [...container.querySelectorAll("tbody tr")].find((tr) =>
      tr.textContent?.includes("BAQ-3"),
    );
    expect(filaBaq3?.querySelector("a")).toBeNull();

    // Enlace a la vista completa de Cartera
    const verEnCartera = [...container.querySelectorAll("a")].find((a) => a.textContent === "Ver en Cartera");
    expect(verEnCartera?.getAttribute("href")).toBe("/cartera?clienteId=c1");
  });

  it("vacío: avisa que la empresa no tiene facturas", async () => {
    await montar({ facturas: [], cruceCliente: "0", cruceLM: "0", totalFacturas: 0 });
    expect(container.textContent).toContain("Esta empresa no tiene facturas");
  });

  it("error: ofrece reintentar", async () => {
    vi.mocked(fetchCartera).mockRejectedValue(new Error("Caída de red"));
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <RolProvider rol="ADMIN">
          <SeccionCarteraEmpresa clienteId="c1" nombreEmpresa="Coldex" />
        </RolProvider>,
      ),
    );

    expect(container.textContent).toContain("No se pudo cargar la cartera");
    expect(container.textContent).toContain("Caída de red");
    expect(container.textContent).toContain("Reintentar");
  });
});


