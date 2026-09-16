import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorLineas } from "./editor-lineas";
import { crearLineaManual, actualizarLinea, type BorradorRow } from "./facturacion-api";

vi.mock("@/components/facturas-proveedor/facturas-proveedor-api", () => ({ fetchFacturasProveedor: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/configuracion/siigo-productos-api", () => ({ fetchSiigoProductos: vi.fn().mockResolvedValue({ productos: [] }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));
vi.mock("./facturacion-api", async (original) => ({
  ...await original<typeof import("./facturacion-api")>(),
  crearLineaManual: vi.fn(),
  actualizarLinea: vi.fn(),
}));

const borrador = {
  id: "draft-1", tramiteId: "tramite-1", comentariosCabecera: [], comision: "400000",
  ivaComision: "76000", retenciones: "0", totalFactura: "10000", lineasRevision: [
    { id: "line-1", orden: 1, concepto: "Transporte", valor: "10000", seccion: "TERCEROS", tipoFija: null, facturasVinculadas: [], nitTercero: null },
  ],
} as unknown as BorradorRow;

let container: HTMLDivElement;
let root: Root;

async function cambiar(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EditorLineas borrador={borrador} tramiteId="tramite-1" puedeEditar onBorradorActualizado={vi.fn()} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Editor de líneas: recuperación de errores", () => {
  it("conserva los datos de una línea nueva cuando falla el guardado y permite volver a enviarla", async () => {
    vi.mocked(crearLineaManual).mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[placeholder="Ej. Impuestos aduanas importación"]')!;
    const valor = container.querySelector<HTMLInputElement>('input[placeholder="0"]')!;
    await cambiar(concepto, "Flete nuevo");
    await cambiar(valor, "50000");
    const agregar = [...container.querySelectorAll("button")].find((button) => button.textContent === "Agregar línea")!;
    await act(async () => agregar.click());
    expect(concepto.value).toBe("Flete nuevo");
    expect(valor.value).toBe("50000");
    expect(container.textContent).toContain("No se guardó el cambio");
    await act(async () => agregar.click());
    expect(crearLineaManual).toHaveBeenCalledTimes(2);
    expect(concepto.value).toBe("");
  });

  it("guarda el concepto al salir del campo sin abrir un formulario adicional", async () => {
    vi.mocked(actualizarLinea).mockResolvedValue(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Transporte actualizado");
    await act(async () => concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(actualizarLinea).toHaveBeenCalledWith("draft-1", "line-1", { concepto: "Transporte actualizado" });
    expect(container.textContent).toContain("Cambio guardado");
  });

  it("no envía importes vacíos ni cero", async () => {
    const valor = container.querySelector<HTMLInputElement>('input[aria-label="Valor en COP de la línea 1"]')!;
    await cambiar(valor, "0");
    await act(async () => valor.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(actualizarLinea).not.toHaveBeenCalled();
    expect(valor.value).toBe("0");
    expect(valor.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("mayor que cero");
  });

  it("mantiene el cambio fallido al recibir otro borrador y ofrece reintento por campo", async () => {
    vi.mocked(actualizarLinea).mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce(borrador);
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Conservar este concepto");
    await act(async () => concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    const actualizado = { ...borrador, lineasRevision: borrador.lineasRevision.map((linea) => ({ ...linea, concepto: "Otro dato del servidor" })) };
    await act(async () => root.render(<EditorLineas borrador={actualizado} tramiteId="tramite-1" puedeEditar onBorradorActualizado={vi.fn()} />));
    expect(concepto.value).toBe("Conservar este concepto");
    expect(concepto.getAttribute("aria-invalid")).toBe("true");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reintentar este cambio")!;
    await act(async () => retry.click());
    expect(actualizarLinea).toHaveBeenLastCalledWith("draft-1", "line-1", { concepto: "Conservar este concepto" });
    expect(concepto.getAttribute("aria-invalid")).toBe("false");
  });

  it("un doble blur no envía dos veces el mismo cambio", async () => {
    let resolver!: (row: BorradorRow) => void;
    vi.mocked(actualizarLinea).mockImplementationOnce(() => new Promise((resolve) => { resolver = resolve; }));
    const concepto = container.querySelector<HTMLInputElement>('input[aria-label="Concepto de la línea 1"]')!;
    await cambiar(concepto, "Un único cambio");
    await act(async () => {
      concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      concepto.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(actualizarLinea).toHaveBeenCalledTimes(1);
    await act(async () => resolver(borrador));
  });
});
