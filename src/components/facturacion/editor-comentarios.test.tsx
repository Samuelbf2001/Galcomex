import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorLineas } from "./editor-lineas";
import { actualizarComentariosCabecera, type BorradorRow } from "./facturacion-api";

vi.mock("@/components/facturas-proveedor/facturas-proveedor-api", () => ({ fetchFacturasProveedor: vi.fn().mockResolvedValue([]) }));
vi.mock("@/components/configuracion/siigo-productos-api", () => ({ fetchSiigoProductos: vi.fn().mockResolvedValue({ productos: [] }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }), describirError: (error: Error) => error.message }));
vi.mock("./facturacion-api", async (original) => ({ ...await original<typeof import("./facturacion-api")>(), actualizarComentariosCabecera: vi.fn() }));
const borrador = { id: "b-1", tramiteId: "t-1", comentariosCabecera: ["Comentario original"], comision: "400000", ivaComision: "76000", retenciones: "0", totalFactura: "0", lineasRevision: [] } as unknown as BorradorRow;
let container: HTMLDivElement;
let root: Root;
async function render(row = borrador) { await act(async () => root.render(<EditorLineas borrador={row} tramiteId="t-1" puedeEditar onBorradorActualizado={vi.fn()} />)); }
beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("conserva un comentario rechazado cuando otra operación devuelve el borrador del servidor", async () => {
  vi.mocked(actualizarComentariosCabecera).mockRejectedValueOnce(new Error("Sin conexión"));
  const comentario = container.querySelector<HTMLInputElement>('input[placeholder^="Ej. FACTURA COMERCIAL"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(comentario, "Comentario pendiente");
    comentario.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { comentario.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(actualizarComentariosCabecera).toHaveBeenCalledWith("b-1", ["Comentario pendiente"]);
  expect(comentario.value).toBe("Comentario pendiente");
  await render({ ...borrador, comentariosCabecera: [...borrador.comentariosCabecera], totalFactura: "10000" });
  expect(comentario.value).toBe("Comentario pendiente");
});
