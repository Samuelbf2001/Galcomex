import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RolProvider } from "@/lib/auth/rol-context";
import type { Rol } from "@/lib/auth/auth";

import {
  EnlaceCliente,
  EnlaceFacturaVenta,
  EnlaceTramite,
  rutaFacturaVenta,
  rutaTramite,
} from "./enlace-entidad";

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

async function render(rol: Rol, ui: React.ReactNode) {
  await act(async () => root.render(<RolProvider rol={rol}>{ui}</RolProvider>));
}

describe("rutas", () => {
  it("arma la ruta del trámite con y sin pestaña", () => {
    expect(rutaTramite("t1")).toBe("/tramites/t1");
    expect(rutaTramite("t1", "pagos")).toBe("/tramites/t1?tab=pagos");
  });

  it("arma la ruta de la factura de venta", () => {
    expect(rutaFacturaVenta("t1", "b1")).toBe("/facturacion?tramiteId=t1&borrador=b1");
    expect(rutaFacturaVenta("t1")).toBe("/facturacion?tramiteId=t1");
  });
});

describe("EnlaceTramite / EnlaceCliente", () => {
  it("enlaza el DO a su detalle", async () => {
    await render("ADMIN", <EnlaceTramite id="t1">DO.CTG26-0201</EnlaceTramite>);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/tramites/t1");
    expect(a?.textContent).toBe("DO.CTG26-0201");
  });

  it("sin id pinta texto plano", async () => {
    await render("ADMIN", <EnlaceTramite id={null}>DO.CTG26-0201</EnlaceTramite>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("DO.CTG26-0201");
  });

  it("no enlaza a Empresas a un rol que no puede abrirla (SOCIO)", async () => {
    await render("SOCIO", <EnlaceCliente id="c1">Litoplas</EnlaceCliente>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Litoplas");
  });

  it("no propaga el clic a la fila que lo contiene", async () => {
    let clicsFila = 0;
    await render(
      "ADMIN",
      <div onClick={() => { clicsFila += 1; }}>
        <EnlaceCliente id="c1">Litoplas</EnlaceCliente>
      </div>,
    );
    const a = container.querySelector("a")!;
    a.addEventListener("click", (e) => e.preventDefault());
    await act(async () => { a.click(); });
    expect(clicsFila).toBe(0);
  });
});

describe("EnlaceFacturaVenta", () => {
  it("ADMIN abre el revisor en Facturación", async () => {
    await render("ADMIN", <EnlaceFacturaVenta tramiteId="t1" borradorId="b1">BAQ-18794</EnlaceFacturaVenta>);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/facturacion?tramiteId=t1&borrador=b1");
  });

  it("OPERATIVO (sin Facturación) cae a la pestaña del trámite", async () => {
    await render("OPERATIVO", <EnlaceFacturaVenta tramiteId="t1" borradorId="b1">BAQ-18794</EnlaceFacturaVenta>);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/tramites/t1?tab=facturacion");
  });
});
