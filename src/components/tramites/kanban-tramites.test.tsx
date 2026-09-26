import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanTramites } from "./kanban-tramites";
import { TramitesApiError, cambiarEstadoTramite, type TramiteRow } from "./tramites-api";

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
    cuadrePendiente: false,
    tieneCuadre: false,
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

/** Elige el estado (EN_TRAMITE por defecto) en el select de la tarjeta y confirma el cambio. */
async function moverTarjeta(estado = "EN_TRAMITE") {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Mover DO.BAQ26-0001 a otro estado"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      select,
      estado,
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

describe("KanbanTramites — D0: cuadre de plata histórica", () => {
  it("con solo el cuadre pendiente muestra «Cuadre pendiente» y no «1 doc pendiente»", async () => {
    await montar([{ ...filaTramite(), esHistorico: true, tieneCuadre: true, cuadrePendiente: true, documentosPendientes: 0 }]);

    expect(container.textContent).toContain("Cuadre pendiente");
    expect(container.textContent).not.toMatch(/doc(s)? pendiente/);
  });

  it("con cuadre y 2 documentos pendientes muestra los dos chips", async () => {
    await montar([{ ...filaTramite(), esHistorico: true, tieneCuadre: true, cuadrePendiente: true, documentosPendientes: 2 }]);

    expect(container.textContent).toContain("Cuadre pendiente");
    expect(container.textContent).toContain("2 docs pendientes");
  });

  it("con el cuadre cerrado no muestra el chip", async () => {
    await montar([{ ...filaTramite(), esHistorico: true, tieneCuadre: true, cuadrePendiente: false, documentosPendientes: 0 }]);

    expect(container.textContent).not.toContain("Cuadre pendiente");
  });
});

describe("KanbanTramites — Facturado solo con factura emitida (decisión 25-sep-2026)", () => {
  const rechazo = (puedeForzar: boolean) =>
    new TramitesApiError(
      "El DO.BAQ26-0001 no tiene factura emitida: su borrador está aprobado, sin enviar a Siigo. Pasa a Facturado cuando su factura salga (borrador en Facturado).",
      422,
      { codigo: "FACTURA_NO_EMITIDA", detalles: { puedeForzar } },
    );

  it("a quien no es ADMIN le muestra el motivo del bloqueo, sin opción de forzar", async () => {
    vi.mocked(cambiarEstadoTramite).mockRejectedValue(rechazo(false));

    await montar([{ ...filaTramite(), estado: "ENVIADO_A_FACTURAR" }]);
    await moverTarjeta("FACTURADO");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("no tiene factura emitida");
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("al ADMIN le abre «forzar con motivo» y reintenta el cambio con ese motivo", async () => {
    vi.mocked(cambiarEstadoTramite)
      .mockRejectedValueOnce(rechazo(true))
      .mockResolvedValueOnce({
        tramite: { id: "tramite-1", estado: "FACTURADO" },
        advertencias: ["DO.BAQ26-0001 pasó a FACTURADO sin factura emitida, por excepción de ADMIN. Motivo: va en la BAQ-18701"],
      });

    await montar([{ ...filaTramite(), estado: "ENVIADO_A_FACTURAR" }]);
    await moverTarjeta("FACTURADO");

    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("sin factura");
    const enviar = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Forzar con este motivo"),
    )!;
    expect(enviar.disabled).toBe(true);

    const textarea = dialog.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        "va en la BAQ-18701",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(enviar.disabled).toBe(false);
    await act(async () => enviar.click());

    expect(cambiarEstadoTramite).toHaveBeenLastCalledWith("tramite-1", "FACTURADO", {
      motivoExcepcion: "va en la BAQ-18701",
    });
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Estado actualizado" }));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning", description: expect.stringContaining("Motivo: va en la BAQ-18701") }),
    );
    expect(document.querySelector("dialog")).toBeNull();
  });
});
