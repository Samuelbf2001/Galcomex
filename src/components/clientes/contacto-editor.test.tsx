import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactoEditor } from "./contacto-editor";
import { type ClienteDetalle, updateCliente } from "./clientes-api";

let esAdmin = true;

vi.mock("./clientes-api", async () => {
  const actual = await vi.importActual<typeof import("./clientes-api")>("./clientes-api");
  return { ...actual, updateCliente: vi.fn() };
});
vi.mock("@/lib/auth/rol-context", () => ({ useEsAdmin: () => esAdmin }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));

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

const cliente: ClienteDetalle = {
  id: "cliente-1",
  nombre: "Empresa",
  nit: "9001",
  tipo: "PROPIO",
  contactoNombre: "Ana",
  contactoEmail: "ana@example.com",
  contactoTel: "3001234567",
  ciudad: null,
  manejaAnticipo: true,
  activo: true,
  esCliente: true,
  esProveedor: false,
  grupoEmpresaId: null,
  tarifas: [],
  tramites: [],
  anticipos: [],
  facturas: [],
};

let container: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  esAdmin = true;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montar(clienteProp: ClienteDetalle = cliente) {
  await act(async () => root.render(<ContactoEditor cliente={clienteProp} onClose={onClose} onSaved={onSaved} />));
}

function inputs() {
  return [...container.querySelectorAll("input")];
}

async function escribir(index: number, value: string) {
  const input = inputs()[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function guardar() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Contacto de la empresa — ADMIN", () => {
  it("guarda los tres campos, avisa y cierra el pop-up", async () => {
    vi.mocked(updateCliente).mockResolvedValueOnce({
      ...cliente,
      contactoNombre: "María",
      contactoEmail: "maria@example.com",
      contactoTel: "3009999999",
    });
    await montar();

    await escribir(0, "María");
    await escribir(1, "maria@example.com");
    await escribir(2, "3009999999");
    await guardar();

    expect(updateCliente).toHaveBeenCalledWith("cliente-1", {
      contactoNombre: "María",
      contactoEmail: "maria@example.com",
      contactoTel: "3009999999",
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ contactoNombre: "María", contactoEmail: "maria@example.com", contactoTel: "3009999999" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("un campo vaciado se envía como null", async () => {
    vi.mocked(updateCliente).mockResolvedValueOnce({ ...cliente, contactoTel: null });
    await montar();

    await escribir(2, "");
    await guardar();

    expect(updateCliente).toHaveBeenCalledWith("cliente-1", {
      contactoNombre: "Ana",
      contactoEmail: "ana@example.com",
      contactoTel: null,
    });
  });

  it("si falla, conserva lo escrito y muestra el error sin cerrar", async () => {
    vi.mocked(updateCliente).mockRejectedValueOnce(new Error("Servidor no disponible"));
    await montar();

    await escribir(0, "Nombre sin guardar");
    await guardar();

    expect(inputs()[0].value).toBe("Nombre sin guardar");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Servidor no disponible");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancelar cierra sin guardar", async () => {
    await montar();
    const cancelar = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar")!;

    await act(async () => cancelar.click());

    expect(updateCliente).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Contacto de la empresa — no ADMIN", () => {
  it("muestra los datos en solo lectura, sin formulario ni botón de guardar", async () => {
    esAdmin = false;
    await montar();

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(container.textContent).toContain("Ana");
    expect(container.textContent).toContain("ana@example.com");
    expect(container.textContent).toContain("3001234567");
  });

  it('los campos vacíos muestran "Sin registrar"', async () => {
    esAdmin = false;
    await montar({ ...cliente, contactoNombre: null, contactoEmail: null, contactoTel: null });

    const veces = container.textContent?.match(/Sin registrar/g) ?? [];
    expect(veces.length).toBe(3);
  });
});
