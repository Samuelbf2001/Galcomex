import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RegistrarFacturaContraparteModal } from "./registrar-factura-contraparte-modal";
import { registrarMovimiento, type CuentaCorriente } from "./cuenta-api";

vi.mock("./cuenta-api", async () => {
  const actual = await vi.importActual<typeof import("./cuenta-api")>("./cuenta-api");
  return { ...actual, registrarMovimiento: vi.fn() };
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

const cuenta: CuentaCorriente = {
  empresa: { id: "cliente-1", nombre: "AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS", nit: "900111222", esCliente: true, esProveedor: true },
  totalACargo: "0",
  totalAFavor: "0",
  neto: "0",
  pendienteCliente: "0",
  pendienteProveedor: "3000000",
  porLinea: [],
  movimientos: [
    {
      id: "movimiento:mov-1",
      fuente: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Quincenas agosto",
      fecha: "2026-08-15T00:00:00.000Z",
      valor: "-1000000",
      referencia: null,
      tramiteId: null,
      facturaId: null,
      borradorId: null,
      compensacionId: null,
      numeroFactura: "FE-0001",
      tieneSoporte: false,
    },
  ],
  cantidad: 1,
  habilitada: true,
  permiteCargosManuales: true,
  maximoCompensable: "0",
  compensables: { facturasVenta: [], facturasProveedor: [] },
};

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

async function montar() {
  await act(async () =>
    root.render(
      <RegistrarFacturaContraparteModal clienteId="cliente-1" cuenta={cuenta} onClose={onClose} onGuardado={onGuardado} />,
    ),
  );
}

function campoPorLabel(texto: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((l) => l.textContent?.includes(texto));
  return label!.querySelector("input")!;
}

async function escribir(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enviar() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("RegistrarFacturaContraparteModal", () => {
  it('usa el nombre corto ("COLDEX") en el título', async () => {
    await montar();
    expect(container.textContent).toContain("Factura de COLDEX");
  });

  it("envía los valores fijos correctos: ABONO + PROVEEDOR + CARGO_MANUAL + TRAMITE", async () => {
    vi.mocked(registrarMovimiento).mockResolvedValueOnce({ ...cuenta, pendienteProveedor: "7500000" });
    await montar();

    await escribir(campoPorLabel("Concepto"), "Servicios aduaneros");
    await escribir(campoPorLabel("N° de factura"), "FE-9999");
    await escribir(campoPorLabel("Valor (COP)"), "4500000");
    await escribir(campoPorLabel("Fecha de la factura"), "2026-09-20");
    await enviar();

    expect(registrarMovimiento).toHaveBeenCalledTimes(1);
    const [clienteIdArg, payload] = vi.mocked(registrarMovimiento).mock.calls[0];
    expect(clienteIdArg).toBe("cliente-1");
    expect(payload).toMatchObject({
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      numeroFactura: "FE-9999",
      valor: "4500000",
    });
    expect(payload.soporte).toBeUndefined();
    expect(payload.fecha).toContain("2026-09-20");
    expect(onGuardado).toHaveBeenCalledWith(expect.objectContaining({ pendienteProveedor: "7500000" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("muestra en el desplegable los conceptos manuales ya usados y los sugeridos", async () => {
    await montar();
    const options = [...container.querySelectorAll("#conceptos-factura-contraparte option")].map(
      (o) => o.getAttribute("value"),
    );
    expect(options).toEqual(expect.arrayContaining(["Servicios aduaneros", "Quincenas", "Primas", "Quincenas agosto"]));
  });

  it("si falla el registro (409/422), muestra el error en el modal y no cierra", async () => {
    vi.mocked(registrarMovimiento).mockRejectedValueOnce(new Error("Ya registraste la factura FE-9999 de COLDEX el 20/09/2026"));
    await montar();

    await escribir(campoPorLabel("Concepto"), "Servicios aduaneros");
    await escribir(campoPorLabel("N° de factura"), "FE-9999");
    await escribir(campoPorLabel("Valor (COP)"), "4500000");
    await escribir(campoPorLabel("Fecha de la factura"), "2026-09-20");
    await enviar();

    expect(container.textContent).toContain("Ya registraste la factura FE-9999 de COLDEX el 20/09/2026");
    expect(onClose).not.toHaveBeenCalled();
    expect(onGuardado).not.toHaveBeenCalled();
  });
});
