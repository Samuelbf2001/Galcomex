import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  eliminarMovimiento,
  fetchCuentaCorriente,
  type CuentaCorriente,
  type MovimientoCuentaRow,
} from "@/components/clientes/cuenta-api";
import { RolProvider } from "@/lib/auth/rol-context";

import { SeccionCuentaCorriente } from "./seccion-cuenta-corriente";

// jsdom no implementa <dialog>.showModal()/close() (ver modal-shell.test.tsx).
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (typeof HTMLDialogElement.prototype.close !== "function") {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

vi.mock("@/components/clientes/cuenta-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/clientes/cuenta-api")>();
  return { ...original, fetchCuentaCorriente: vi.fn(), eliminarMovimiento: vi.fn() };
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
    cuentaCorrienteActiva: true,
    maximoCompensable: "0",
    compensables: { facturasVenta: [], facturasProveedor: [] },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function montar(
  cuenta: CuentaCorriente,
  rol: "ADMIN" | "REVISOR" | "OPERATIVO" = "ADMIN",
  opciones: { proveedorPuro?: boolean } = {},
) {
  vi.mocked(fetchCuentaCorriente).mockResolvedValue(cuenta);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <RolProvider rol={rol}>
        <SeccionCuentaCorriente clienteId="cliente-1" proveedorPuro={opciones.proveedorPuro} />
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

  it("con solo «Registrar facturas» encendida (sin cuenta corriente) no ofrece «Otro ajuste»", async () => {
    await montar(cuentaBase({ permiteCargosManuales: true, cuentaCorrienteActiva: false }));

    expect(botonPorTexto("Registrar factura")).toBeDefined();
    expect(botonPorTexto("Otro ajuste")).toBeUndefined();
    expect(botonPorTexto("Registrar movimiento")).toBeUndefined();
  });

  it("los recuadros de saldo muestran lo pendiente, no los totales brutos", async () => {
    await montar(
      cuentaBase({ totalACargo: "14230187", totalAFavor: "8300000", pendienteCliente: "5930187", pendienteProveedor: "0", neto: "5930187" }),
    );

    expect(container.textContent).toContain("5.930.187");
    expect(container.textContent).not.toContain("14.230.187");
    expect(container.textContent).not.toContain("8.300.000");
  });

  it("la sección se muestra (habilitada=true) aunque la empresa no sea proveedora", async () => {
    await montar(cuentaBase({ habilitada: true, permiteCargosManuales: true }));

    expect(container.textContent).toContain("Cuenta corriente");
  });
});

// Rebase CxP v2 sobre Coldex: la regla §D.1 (proveedor puro) respeta el flag
// nuevo: la sección aparece con «Registrar factura» aunque no esté encendida la
// cuenta corriente completa, y se oculta si solo repetiría el estado de cuenta.
describe("SeccionCuentaCorriente — proveedor puro (§D.1) con las capacidades de Coldex", () => {

  const proveedorPuro = {
    id: "cliente-1",
    nombre: "ALMACARGA S.A.S",
    nit: "800154017",
    esCliente: false,
    esProveedor: true,
  };

  it("con solo «Registrar facturas» encendida se muestra, con «Registrar factura» y sin «Otro ajuste»", async () => {
    await montar(
      cuentaBase({ empresa: proveedorPuro, habilitada: true, permiteCargosManuales: true, cuentaCorrienteActiva: false }),
      "ADMIN",
      { proveedorPuro: true },
    );

    expect(container.textContent).toContain("Cuenta corriente");
    expect(botonPorTexto("Registrar factura")).toBeDefined();
    expect(botonPorTexto("Otro ajuste")).toBeUndefined();
  });

  it("con solo la cuenta corriente encendida (sin «Registrar facturas») no se muestra: repetiría el estado de cuenta", async () => {
    await montar(
      cuentaBase({ empresa: proveedorPuro, habilitada: true, permiteCargosManuales: false, cuentaCorrienteActiva: true }),
      "ADMIN",
      { proveedorPuro: true },
    );

    expect(container.textContent).not.toContain("Cuenta corriente");
  });
});

function movimientoManual(overrides: Partial<MovimientoCuentaRow> = {}): MovimientoCuentaRow {
  return {
    id: "movimiento:mov-1",
    fuente: "CARGO_MANUAL",
    lineaServicio: "TRAMITE",
    concepto: "Servicios aduaneros agosto",
    fecha: "2026-08-15T00:00:00.000Z",
    valor: "4000000",
    referencia: null,
    tramiteId: null,
    facturaId: null,
    borradorId: null,
    compensacionId: null,
    numeroFactura: "FE-0001",
    tieneSoporte: false,
    ...overrides,
  };
}

describe("SeccionCuentaCorriente — columna «Línea»", () => {
  it("muestra etiquetas legibles en vez del código crudo", async () => {
    await montar(
      cuentaBase({
        movimientos: [
          movimientoManual({ id: "movimiento:mov-tramite", lineaServicio: "TRAMITE" }),
          movimientoManual({ id: "movimiento:mov-comision", lineaServicio: "COMISION", numeroFactura: null }),
        ],
      }),
    );

    expect(container.textContent).toContain("Trámites");
    expect(container.textContent).toContain("Comisiones");
    // El código crudo ya no aparece suelto en la tabla.
    const celdas = [...container.querySelectorAll("td")].map((td) => td.textContent?.trim());
    expect(celdas).not.toContain("TRAMITE");
    expect(celdas).not.toContain("COMISION");
  });

  it("un código sin etiqueta conocida se muestra tal cual (no revienta)", async () => {
    await montar(cuentaBase({ movimientos: [movimientoManual({ lineaServicio: "CODIGO_NUEVO" })] }));

    expect(container.textContent).toContain("CODIGO_NUEVO");
  });
});

describe("SeccionCuentaCorriente — eliminar movimiento manual", () => {
  it("ADMIN ve «Eliminar» en un movimiento manual que no es un cruce", async () => {
    await montar(cuentaBase({ movimientos: [movimientoManual()] }));

    expect(botonPorTexto("Eliminar")).toBeDefined();
  });

  it("REVISOR no ve «Eliminar» (no puede registrar/borrar)", async () => {
    await montar(cuentaBase({ movimientos: [movimientoManual()] }), "REVISOR");

    expect(botonPorTexto("Eliminar")).toBeUndefined();
  });

  it("un movimiento que es parte de un cruce no ofrece «Eliminar» (se deshace el cruce completo)", async () => {
    await montar(
      cuentaBase({
        movimientos: [movimientoManual({ compensacionId: "comp-1", fuente: "COMPENSACION" })],
      }),
    );

    expect(botonPorTexto("Eliminar")).toBeUndefined();
  });

  it("una factura de venta (no es un movimiento manual) no ofrece «Eliminar»", async () => {
    await montar(
      cuentaBase({
        movimientos: [
          movimientoManual({ id: "factura:fac-1", fuente: "FACTURA_VENTA", numeroFactura: null }),
        ],
      }),
    );

    expect(botonPorTexto("Eliminar")).toBeUndefined();
  });

  it("confirma, llama a eliminarMovimiento con el id sin prefijo y muestra la cuenta actualizada", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(eliminarMovimiento).mockResolvedValue(cuentaBase({ movimientos: [] }));

    await montar(cuentaBase({ movimientos: [movimientoManual()] }));

    await act(async () => {
      botonPorTexto("Eliminar")!.click();
    });

    expect(eliminarMovimiento).toHaveBeenCalledWith("cliente-1", "mov-1");
    expect(container.textContent).toContain("Sin movimientos en la cuenta.");
  });

  it("si se cancela la confirmación, no llama a la API", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await montar(cuentaBase({ movimientos: [movimientoManual()] }));

    await act(async () => {
      botonPorTexto("Eliminar")!.click();
    });

    expect(eliminarMovimiento).not.toHaveBeenCalled();
  });
});

describe("SeccionCuentaCorriente — modal «Otro ajuste» sin ejemplos inventados", () => {
  async function abrirOtroAjuste(mostrarAyuda: boolean) {
    await montar(
      cuentaBase({ permiteCargosManuales: mostrarAyuda, cuentaCorrienteActiva: true }),
    );
    // Con «Registrar factura» encendida el modal se abre desde «Otro ajuste»;
    // sin ella, «Otro ajuste» ni aparece y el único botón es «Registrar
    // movimiento» (mismo modal, ver `seccion-cuenta-corriente.tsx`).
    const boton = mostrarAyuda ? botonPorTexto("Otro ajuste") : botonPorTexto("Registrar movimiento");
    await act(async () => {
      boton!.click();
    });
  }

  it("ya no sugiere «mensualidades» ni «Servicios aduaneros marzo» como ejemplo", async () => {
    await abrirOtroAjuste(false);

    expect(container.textContent).not.toContain("mensualidades");
    expect(container.textContent).not.toContain("Servicios aduaneros marzo");
    const concepto = container.querySelector<HTMLInputElement>('input[name="concepto"]');
    expect(concepto?.placeholder ?? "").not.toContain("Servicios aduaneros marzo");
  });

  it("muestra la ayuda de «Registrar factura» solo cuando la empresa la tiene encendida", async () => {
    await abrirOtroAjuste(true);
    expect(container.textContent).toContain("Para una factura que la empresa nos cobra usa «Registrar factura».");
  });

  it("sin «Registrar factura» encendida, no muestra esa ayuda", async () => {
    await abrirOtroAjuste(false);
    expect(container.textContent).not.toContain("Para una factura que la empresa nos cobra usa «Registrar factura».");
  });
});
