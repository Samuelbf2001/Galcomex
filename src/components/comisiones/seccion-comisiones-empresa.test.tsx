import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComisionesEmpresaRow, FilaComisionFacturadaRow } from "@/components/comisiones/comisiones-api";
import { RolProvider } from "@/lib/auth/rol-context";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock("@/components/comisiones/comisiones-api", async (original) => ({
  ...(await original<typeof import("@/components/comisiones/comisiones-api")>()),
  fetchComisionesEmpresa: vi.fn(),
  deshacerLiquidacionComisiones: vi.fn(),
  facturarComisiones: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: toastMock }),
  describirError: (error: unknown, fallback?: string) =>
    error instanceof Error ? error.message : (fallback ?? "Error"),
}));
vi.mock("@/components/ui/enlace-entidad", () => ({
  EnlaceTramite: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import {
  deshacerLiquidacionComisiones,
  fetchComisionesEmpresa,
} from "@/components/comisiones/comisiones-api";

import { SeccionComisionesEmpresa } from "./seccion-comisiones-empresa";

/**
 * M3 — el bloque «Ya facturadas» de la ficha de LTRANS: botón «Deshacer» por
 * «Otros» (solo ADMIN, solo si se puede) con el motivo escrito en la página.
 */

const facturada = (
  comisionId: string,
  otrosId: string,
  over: Partial<FilaComisionFacturadaRow["otros"]> = {},
): FilaComisionFacturadaRow => ({
  comisionId,
  tramiteId: `do-${comisionId}`,
  consecutivo: `DO.BAQ26-${comisionId}`,
  empresaDo: "POLYREC ZF",
  unidades: 5,
  liquidadaEn: "2026-09-29T10:00:00.000Z",
  otros: {
    id: otrosId,
    consecutivo: otrosId === "otros-1" ? "OTR26-0001" : "OTR26-0002",
    estado: "ENVIADO_A_FACTURAR",
    valorServicio: "900000",
    deshacible: true,
    motivoNoDeshacible: null,
    ...over,
  },
});

const FICHA: ComisionesEmpresaRow = {
  habilitada: true,
  valorUnitario: "90000",
  tasaIva: "19",
  filas: [],
  totales: { unidades: 0, subtotal: "0", iva: "0", total: "0" },
  facturadas: [
    facturada("c1", "otros-1"),
    facturada("c2", "otros-1"),
    facturada("c3", "otros-2", {
      deshacible: false,
      motivoNoDeshacible: "Este servicio ya tiene una factura aprobada o emitida, así que no se puede deshacer.",
    }),
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(fetchComisionesEmpresa).mockResolvedValue(FICHA);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montar(rol: "ADMIN" | "REVISOR") {
  await act(async () =>
    root.render(
      <RolProvider rol={rol}>
        <SeccionComisionesEmpresa empresaId="ltrans-1" />
      </RolProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolver) => setTimeout(resolver, 20));
  });
}

const botones = () => Array.from(container.querySelectorAll("button"));
const boton = (texto: string) => botones().find((b) => b.textContent?.trim() === texto);

async function escribir(area: HTMLTextAreaElement, valor: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, valor);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SeccionComisionesEmpresa — «Ya facturadas» agrupadas por «Otros» y «Deshacer» (M3)", () => {
  it("agrupa por «Otros» y solo ofrece «Deshacer» donde se puede; donde no, dice por qué", async () => {
    await montar("ADMIN");

    expect(container.textContent).toContain("OTR26-0001");
    expect(container.textContent).toContain("10 contenedores"); // c1 + c2
    expect(container.textContent).toContain("OTR26-0002");
    expect(botones().filter((b) => b.textContent?.trim() === "Deshacer")).toHaveLength(1);
    expect(container.textContent).toContain("ya tiene una factura aprobada o emitida");
  });

  it("el motivo se escribe en la página (sin confirm): el botón espera 10 caracteres y manda el motivo limpio", async () => {
    vi.mocked(deshacerLiquidacionComisiones).mockResolvedValue({
      tramiteId: "otros-1",
      consecutivo: "OTR26-0001",
      comisiones: 2,
      unidades: 10,
    });
    const confirmar = vi.spyOn(window, "confirm");
    await montar("ADMIN");

    await act(async () => boton("Deshacer")!.click());
    const area = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    const confirmarDeshacer = boton("Deshacer liquidación") as HTMLButtonElement;
    expect(confirmarDeshacer.disabled).toBe(true);

    await escribir(area, "corto");
    expect((boton("Deshacer liquidación") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("5 / 10 caracteres como mínimo");

    await escribir(area, "  Faltó un DO en la liquidación  ");
    expect((boton("Deshacer liquidación") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => (boton("Deshacer liquidación") as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolver) => setTimeout(resolver, 20));
    });

    expect(deshacerLiquidacionComisiones).toHaveBeenCalledTimes(1);
    expect(deshacerLiquidacionComisiones).toHaveBeenCalledWith("ltrans-1", "otros-1", "Faltó un DO en la liquidación");
    expect(confirmar).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }));
    // Recargó la ficha y cerró el panel.
    expect(fetchComisionesEmpresa).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("si el servidor lo rechaza (409), avisa con un toast de error y recarga", async () => {
    vi.mocked(deshacerLiquidacionComisiones).mockRejectedValue(new Error("Este servicio ya tiene una factura aprobada o emitida."));
    await montar("ADMIN");
    await act(async () => boton("Deshacer")!.click());
    await escribir(container.querySelector("textarea") as HTMLTextAreaElement, "Motivo suficientemente largo");
    await act(async () => (boton("Deshacer liquidación") as HTMLButtonElement).click());
    await act(async () => {
      await new Promise((resolver) => setTimeout(resolver, 20));
    });

    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error", description: "Este servicio ya tiene una factura aprobada o emitida." }),
    );
    expect(fetchComisionesEmpresa).toHaveBeenCalledTimes(2);
  });

  it("un REVISOR ve las facturadas pero ni el botón «Deshacer» ni la explicación", async () => {
    await montar("REVISOR");
    expect(container.textContent).toContain("OTR26-0001");
    expect(boton("Deshacer")).toBeUndefined();
    expect(container.textContent).not.toContain("ya tiene una factura aprobada o emitida");
  });
});
