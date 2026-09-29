/**
 * Alta rápida de proveedor desde el combo (CxP v2, revisión adversarial FIX):
 * cerrar el aviso de ficha existente / posible duplicada (Escape, la X o el
 * botón de cancelar) NUNCA crea una ficha nueva. Crear otra ficha es la acción
 * explícita del botón de confirmar.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  confirmar: vi.fn<(o: unknown) => Promise<boolean>>(),
  toast: vi.fn(),
  createBeneficiario: vi.fn(),
  fetchBeneficiarios: vi.fn(async () => [] as { id: string; nombre: string; nit: string | null }[]),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => h.confirmar }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: h.toast }),
  describirError: (e: unknown, fallback = "Error") => (e instanceof Error ? e.message : fallback),
}));
vi.mock("@/lib/auth/rol-context", () => ({
  usePermiso: () => true,
  useEsAdmin: () => true,
}));
vi.mock("./beneficiario-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./beneficiario-api")>();
  return {
    ...real,
    createBeneficiario: h.createBeneficiario,
    fetchBeneficiarios: h.fetchBeneficiarios,
  };
});

const { BeneficiarioCombobox } = await import("./beneficiario-combobox");
const { BeneficiarioApiError } = await import("./beneficiario-api");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.confirmar.mockReset();
  h.toast.mockReset();
  h.createBeneficiario.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const EXISTENTE = { id: "ben-almacarga", nombre: "ALMACARGA", nit: "800154017" };

function escribir(input: HTMLInputElement, texto: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, texto);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function intentarCrear(onChange: (b: unknown) => void) {
  await act(async () => {
    root.render(<BeneficiarioCombobox value={null} onChange={onChange} />);
  });
  const trigger = container.querySelector("button") as HTMLButtonElement;
  await act(async () => trigger.click());
  const buscar = container.querySelector('input[aria-label="Buscar beneficiario por nombre o NIT"]') as HTMLInputElement;
  await act(async () => escribir(buscar, "ALMACARGA"));
  await act(async () => {
    buscar.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  // Fase 3: el proveedor nuevo crea también su empresa, así que el NIT es obligatorio.
  const nit = container.querySelector('input[placeholder="NIT sin DV *"]') as HTMLInputElement;
  expect(nit).not.toBeNull();
  await act(async () => escribir(nit, EXISTENTE.nit ?? ""));
  const crear = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Crear");
  expect(crear).toBeDefined();
  await act(async () => crear!.click());
}

describe("BeneficiarioCombobox — cerrar el aviso de duplicado no crea la ficha", () => {
  it("BENEFICIARIO_EXISTE (ADMIN) + Escape: usa la ficha existente, una sola llamada de creación", async () => {
    h.createBeneficiario.mockRejectedValueOnce(
      new BeneficiarioApiError("Ya existe esa ficha.", 409, "BENEFICIARIO_EXISTE", { existente: EXISTENTE }),
    );
    h.confirmar.mockResolvedValueOnce(false); // Escape / X / "No, usar esa ficha"
    const onChange = vi.fn();

    await intentarCrear(onChange);

    expect(h.createBeneficiario).toHaveBeenCalledTimes(1);
    expect(h.confirmar).toHaveBeenCalledWith(expect.objectContaining({ confirmText: "Sí, crear otra ficha" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: EXISTENTE.id }));
  });

  it("BENEFICIARIO_EXISTE (ADMIN) + confirmar explícito: crea la otra cuenta del mismo proveedor", async () => {
    h.createBeneficiario
      .mockRejectedValueOnce(
        new BeneficiarioApiError("Ya existe esa ficha.", 409, "BENEFICIARIO_EXISTE", { existente: EXISTENTE }),
      )
      .mockResolvedValueOnce({ id: "ben-nueva", nombre: "ALMACARGA", nit: "800154017" });
    h.confirmar.mockResolvedValueOnce(true);
    const onChange = vi.fn();

    await intentarCrear(onChange);

    expect(h.createBeneficiario).toHaveBeenCalledTimes(2);
    expect(h.createBeneficiario.mock.calls[1]![0]).toMatchObject({ otraCuentaMismoProveedor: true });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "ben-nueva" }));
  });

  it("POSIBLE_BENEFICIARIO_DUPLICADO + Escape sin ficha en los detalles: no crea nada y lo dice", async () => {
    h.createBeneficiario.mockRejectedValueOnce(
      new BeneficiarioApiError("Hay una ficha con un NIT parecido.", 409, "POSIBLE_BENEFICIARIO_DUPLICADO", {}),
    );
    h.confirmar.mockResolvedValueOnce(false);
    const onChange = vi.fn();

    await intentarCrear(onChange);

    expect(h.createBeneficiario).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No se creó la ficha");
  });
});
