import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanTramites } from "./kanban-tramites";
import { cambiarEstadoTramite, type TramiteRow } from "./tramites-api";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./tramites-api", async (original) => ({
  ...(await original<typeof import("./tramites-api")>()),
  cambiarEstadoTramite: vi.fn(),
}));

const toastSpy = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: toastSpy }),
  describirError: (error: unknown, fallback?: string) =>
    error instanceof Error ? error.message : (fallback ?? "Error"),
}));

vi.mock("@/lib/auth/rol-context", () => ({
  usePermiso: () => true,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function filaTramite(): TramiteRow {
  return {
    id: "tramite-1",
    doNumber: "DO.BAQ26-0001",
    cliente: "LITOPLAS SA",
    clienteId: "cliente-1",
    estado: "APERTURA",
    ciudad: "BAQ",
    modalidad: "MOVIADUANAS",
    referencia: "-",
    fechaApertura: "01/01/2026",
    ultimoMovimiento: "01/01/2026",
    responsable: "Sin asignar",
    documentosPendientes: null,
    esHistorico: false,
  };
}

let container: HTMLDivElement;
let root: Root;

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

async function montar(rows: TramiteRow[]) {
  await act(async () => root.render(<KanbanTramites rows={rows} />));
}

/** Elige "EN_TRAMITE" en el select de la tarjeta y confirma el cambio. */
async function moverTarjeta() {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Mover DO.BAQ26-0001 a otro estado"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      select,
      "EN_TRAMITE",
    );
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const confirmar = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Confirmar cambio de estado de DO.BAQ26-0001"]',
  )!;
  await act(async () => confirmar.click());
}

describe("KanbanTramites — F6: avisa cuando el ADMIN se saltó requisitos al mover un DO", () => {
  it("con advertencias, muestra el toast de éxito y además un toast de advertencia (ámbar) con el detalle", async () => {
    vi.mocked(cambiarEstadoTramite).mockResolvedValue({
      tramite: { id: "tramite-1", estado: "EN_TRAMITE" },
      advertencias: [
        "Falta el BL y la factura comercial del DO.BAQ26-0001. Pasó por excepción de ADMIN y quedó registrado en el historial.",
      ],
    });

    await montar([filaTramite()]);
    await moverTarjeta();

    expect(cambiarEstadoTramite).toHaveBeenCalledWith("tramite-1", "EN_TRAMITE");

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Estado actualizado", variant: "success" }),
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Se avanzó saltando requisitos",
        description: expect.stringContaining("Falta el BL y la factura comercial"),
        variant: "warning",
      }),
    );
  });

  it("sin advertencias, solo muestra el toast de éxito (nada de advertencia)", async () => {
    vi.mocked(cambiarEstadoTramite).mockResolvedValue({
      tramite: { id: "tramite-1", estado: "EN_TRAMITE" },
      advertencias: [],
    });

    await montar([filaTramite()]);
    await moverTarjeta();

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Estado actualizado", variant: "success" }),
    );
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    );
  });
});
