import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineTramiteField } from "./inline-tramite-field";

vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(onSave: (value: string) => Promise<void>, value = "Original") {
  await act(async () => root.render(<InlineTramiteField label="Referencia" type="text" value={value} onSave={onSave} />));
}
async function change(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }

describe("Edición directa del trámite", () => {
  it("no envía un campo sin cambios y Escape deshace el borrador", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await render(save); await submit(); expect(save).not.toHaveBeenCalled();
    await change("Borrador");
    await act(async () => { container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(container.querySelector("input")!.value).toBe("Original");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it("retiene el texto tras un fallo y reintenta exactamente ese cambio", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValueOnce(undefined);
    await render(save); await change("Nueva referencia"); await submit();
    expect(container.querySelector("input")!.value).toBe("Nueva referencia");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Sin conexión");
    expect(container.textContent).toContain("Reintentar guardado");
    await submit(); await render(save, "Nueva referencia");
    expect(save.mock.calls).toEqual([["Nueva referencia"], ["Nueva referencia"]]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it("conserva el borrador al refrescar otros datos del trámite", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await render(save); await change("Mi borrador"); await render(save, "Valor actualizado por servidor");
    expect(container.querySelector("input")!.value).toBe("Mi borrador");
    await submit(); expect(save).toHaveBeenCalledWith("Mi borrador");
  });

  it("bloquea edición y envíos repetidos mientras el guardado está pendiente", async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await render(save); await change("Pendiente"); await submit(); await submit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")!.disabled).toBe(true);
    expect(container.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => resolve());
    expect(container.querySelector("input")!.disabled).toBe(false);
  });
});
