import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactoEditor } from "./contacto-editor";
import { type ClienteDetalle, updateCliente } from "./clientes-api";

vi.mock("./clientes-api", () => ({ updateCliente: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));
const cliente: ClienteDetalle = { id: "cliente-1", nombre: "Empresa", nit: "9001", tipo: "PROPIO", contactoNombre: "Ana", contactoEmail: "ana@example.com", contactoTel: "3001234567", manejaAnticipo: true, activo: true, esCliente: true, esProveedor: false, grupoEmpresaId: null, tarifas: [], tramites: [], anticipos: [], facturas: [] };
let container: HTMLDivElement;
let root: Root;
const saved = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ContactoEditor cliente={cliente} onSaved={saved} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function change(index: number, value: string) {
  const input = container.querySelectorAll("input")[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }

describe("Contacto de empresa", () => {
  it("no escribe sin cambios y Deshacer recupera los tres valores guardados", async () => {
    await submit(); expect(updateCliente).not.toHaveBeenCalled();
    await change(0, "Otro nombre"); await change(2, "999");
    await act(async () => { [...container.querySelectorAll("button")].find((b) => b.textContent === "Deshacer")!.click(); });
    expect([...container.querySelectorAll("input")].map((input) => input.value)).toEqual(["Ana", "ana@example.com", "3001234567"]);
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it("conserva los campos tras un error y envía solo los editados al reintentar", async () => {
    vi.mocked(updateCliente).mockRejectedValueOnce(new Error("Servidor no disponible")).mockResolvedValueOnce({ ...cliente, contactoNombre: "María", contactoTel: null });
    await change(0, " María "); await change(2, ""); await submit();
    expect(container.querySelectorAll("input")[0].value).toBe(" María ");
    expect(container.querySelectorAll("input")[2].value).toBe("");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Servidor no disponible");
    expect(saved).not.toHaveBeenCalled();
    await submit();
    expect(updateCliente).toHaveBeenNthCalledWith(2, "cliente-1", { contactoNombre: "María", contactoTel: null });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ contactoEmail: "ana@example.com", contactoNombre: "María", contactoTel: null, tramites: [] }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("mantiene el borrador cuando se actualiza la ficha desde el servidor", async () => {
    await change(0, "Mi contacto");
    await act(async () => root.render(<ContactoEditor cliente={{ ...cliente, contactoTel: "111" }} onSaved={saved} />));
    expect(container.querySelectorAll("input")[0].value).toBe("Mi contacto");
    expect(container.querySelectorAll("input")[2].value).toBe("111");
  });
});
