import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AvisoSinGastos } from "./aviso-sin-gastos";

// El texto que manda el servidor (`AVISO_SIN_GASTOS_GALCOMEX`); no se importa aquí para no cargar Prisma en la prueba de pantalla.
const AVISO_SIN_GASTOS_GALCOMEX =
  "Este trámite no tiene gastos pagados por Galcomex registrados. Si Galcomex pagó algo por el cliente (VUCE, puerto, transporte), regístralo antes de aprobar.";

describe("AvisoSinGastos (M2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("no pinta nada sin aviso (null, undefined o texto vacío)", async () => {
    for (const aviso of [null, undefined, ""]) {
      await act(async () => root.render(<AvisoSinGastos aviso={aviso} />));
      expect(container.innerHTML, String(aviso)).toBe("");
    }
  });

  it("pinta el aviso en ámbar, como estado (no como error), con el texto que manda el servidor", async () => {
    await act(async () => root.render(<AvisoSinGastos aviso={AVISO_SIN_GASTOS_GALCOMEX} />));
    const caja = container.querySelector('[role="status"]');
    expect(caja).not.toBeNull();
    expect(caja?.className).toContain("border-amber-300");
    expect(caja?.className).toContain("bg-amber-50");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe(AVISO_SIN_GASTOS_GALCOMEX);
    expect(container.textContent).toContain("regístralo antes de aprobar");
  });
});
