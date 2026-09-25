import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchCuentaCorriente, type CuentaCorriente } from "@/components/clientes/cuenta-api";
import { RolProvider } from "@/lib/auth/rol-context";

import { SeccionCuentaCorriente } from "./seccion-cuenta-corriente";

vi.mock("@/components/clientes/cuenta-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/clientes/cuenta-api")>();
  return { ...original, fetchCuentaCorriente: vi.fn() };
});

function cuentaBase(overrides: Partial<CuentaCorriente> = {}): CuentaCorriente {
  return {
    empresa: { id: "cliente-1", nombre: "AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS", nit: "900111222", esCliente: true, esProveedor: false },
    totalACargo: "0",
    totalAFavor: "0",
    neto: "0",
    pendienteCliente: "0",
    pendienteProveedor: "0",
    porLinea: [],
    movimientos: [],
    cantidad: 0,
    habilitada: true,
    permiteCargosManuales: true,
    maximoCompensable: "0",
    compensables: { facturasVenta: [], facturasProveedor: [] },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function montar(cuenta: CuentaCorriente, rol: "ADMIN" | "REVISOR" | "OPERATIVO" = "ADMIN") {
  vi.mocked(fetchCuentaCorriente).mockResolvedValue(cuenta);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <RolProvider rol={rol}>
        <SeccionCuentaCorriente clienteId="cliente-1" />
      </RolProvider>,
    ),
  );
}

function botonPorTexto(texto: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SeccionCuentaCorriente — botón «Registrar factura»", () => {
  it('con permiteCargosManuales=true y esProveedor=false igual muestra "Registrar factura" (sin nombre de empresa)', async () => {
    await montar(cuentaBase({ permiteCargosManuales: true, empresa: { id: "cliente-1", nombre: "AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS", nit: "900111222", esCliente: true, esProveedor: false } }));

    const principal = botonPorTexto("Registrar factura");
    expect(principal).toBeDefined();
    expect(container.textContent).not.toContain("Registrar factura de COLDEX");
  });

  it("sin permiteCargosManuales, el botón principal es «Registrar movimiento» y no hay «Otro ajuste»", async () => {
    await montar(cuentaBase({ permiteCargosManuales: false }));

    expect(botonPorTexto("Registrar movimiento")).toBeDefined();
    expect(botonPorTexto("Registrar factura")).toBeUndefined();
    expect(botonPorTexto("Otro ajuste")).toBeUndefined();
  });

  it('el título de «Otro ajuste» ya no nombra la empresa', async () => {
    await montar(cuentaBase({ permiteCargosManuales: true }));

    const otroAjuste = botonPorTexto("Otro ajuste");
    expect(otroAjuste?.getAttribute("title")).toBe(
      "Correcciones y comisiones. Para una factura que esta empresa nos cobra usa «Registrar factura».",
    );
  });

  it("la sección se muestra (habilitada=true) aunque la empresa no sea proveedora", async () => {
    await montar(cuentaBase({ habilitada: true, permiteCargosManuales: true }));

    expect(container.textContent).toContain("Cuenta corriente");
  });
});
