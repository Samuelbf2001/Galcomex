import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompensacionModal } from "./compensacion-modal";
import { registrarCompensacion, type CuentaCorriente } from "./cuenta-api";

vi.mock("./cuenta-api", async () => {
  const actual = await vi.importActual<typeof import("./cuenta-api")>("./cuenta-api");
  return { ...actual, registrarCompensacion: vi.fn() };
});
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  describirError: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));

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

/**
 * Caso Coldex: nos debe 10.080.187; le debemos una factura que se cobra al
 * cliente (2.000.000, no cruzable) y una que no (500.000, cruzable).
 */
function cuentaColdex(overrides: Partial<CuentaCorriente> = {}): CuentaCorriente {
  return {
    empresa: { id: "cliente-1", nombre: "COLDEX", nit: "900111222", esCliente: true, esProveedor: true },
    totalACargo: "10080187",
    totalAFavor: "2500000",
    neto: "7580187",
    pendienteCliente: "10080187",
    pendienteProveedor: "2500000",
    porLinea: [],
    movimientos: [],
    cantidad: 0,
    habilitada: true,
    permiteCargosManuales: true,
    cuentaCorrienteActiva: true,
    maximoCompensable: "2500000",
    maximoSinFacturaProveedor: "0",
    compensables: {
      facturasVenta: [],
      facturasProveedor: [{ id: "fp-1", numFactura: "AS-20001", referencia: "DO.BAQ26-0001", valor: "500000" }],
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onGuardado = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montar(cuenta: CuentaCorriente) {
  await act(async () =>
    root.render(<CompensacionModal clienteId="cliente-1" cuenta={cuenta} onClose={onClose} onGuardado={onGuardado} />),
  );
}

function labelCon(texto: string): HTMLLabelElement {
  return [...container.querySelectorAll("label")].find((l) => l.textContent?.includes(texto))!;
}

function selectProveedor(): HTMLSelectElement {
  return labelCon("Contra qué factura de proveedor").querySelector("select")!;
}

function campoValor(): HTMLInputElement {
  return labelCon("Valor a cruzar").querySelector("input")!;
}

function botonCruzar(): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cruzar")!;
}

async function escribir(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function elegir(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function enviar() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompensacionModal — «Sin factura» de proveedor solo cruza lo registrado a mano", () => {
  it("sin nada registrado a mano: la opción «Sin factura» está deshabilitada, lo explica y no deja cruzar", async () => {
    await montar(cuentaColdex());

    const sinFactura = selectProveedor().querySelector<HTMLOptionElement>('option[value=""]')!;
    expect(sinFactura.disabled).toBe(true);
    expect(container.textContent).toContain("no hay nada registrado a mano a favor de COLDEX");
    expect(container.textContent).toContain("las demás se pagan por el libro de pagos o en «Pagar en bloque»");
    expect(botonCruzar().disabled).toBe(true);

    await escribir(labelCon("Concepto").querySelector("input")!, "Asesoría contra mensualidad");
    await enviar();
    expect(registrarCompensacion).not.toHaveBeenCalled();
  });

  it("eligiendo una factura que no se cobra al cliente sí cruza, por su saldo", async () => {
    vi.mocked(registrarCompensacion).mockResolvedValueOnce(cuentaColdex());
    await montar(cuentaColdex());

    await elegir(selectProveedor(), "fp-1");
    expect(botonCruzar().disabled).toBe(false);
    await escribir(labelCon("Concepto").querySelector("input")!, "Asesoría contra mensualidad");
    await enviar();

    expect(registrarCompensacion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registrarCompensacion).mock.calls[0]![1]).toMatchObject({
      valor: undefined,
      facturaProveedorId: "fp-1",
    });
  });

  it("con 1.000.000 registrado a mano: prellena ese tope, avisa y bloquea si se pasa, y cruza hasta ese valor", async () => {
    vi.mocked(registrarCompensacion).mockResolvedValueOnce(cuentaColdex());
    await montar(cuentaColdex({ maximoSinFacturaProveedor: "1000000", maximoCompensable: "3500000" }));

    const sinFactura = selectProveedor().querySelector<HTMLOptionElement>('option[value=""]')!;
    expect(sinFactura.disabled).toBe(false);
    expect(sinFactura.textContent).toContain("hasta $ 1.000.000");
    expect(campoValor().value).toBe("1.000.000");

    await escribir(campoValor(), "1000001");
    expect(container.textContent).toContain("Sin factura de proveedor solo se cruza lo registrado a mano: hasta $ 1.000.000");
    expect(botonCruzar().disabled).toBe(true);

    await escribir(campoValor(), "1000000");
    expect(botonCruzar().disabled).toBe(false);
    await escribir(labelCon("Concepto").querySelector("input")!, "Cruce contra servicios aduaneros");
    await enviar();

    expect(registrarCompensacion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registrarCompensacion).mock.calls[0]![1]).toMatchObject({
      valor: "1000000",
      facturaProveedorId: null,
    });
  });

  it("volver de una factura a «Sin factura» prellena otra vez el tope sin factura", async () => {
    await montar(cuentaColdex({ maximoSinFacturaProveedor: "1000000", maximoCompensable: "3500000" }));

    await elegir(selectProveedor(), "fp-1");
    expect(campoValor().value).toBe("500.000");
    await elegir(selectProveedor(), "");
    expect(campoValor().value).toBe("1.000.000");
  });
});
