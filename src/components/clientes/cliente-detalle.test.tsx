import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClienteCabecera, seccionesDeFicha } from "./cliente-detalle";
import type { ClienteDetalle } from "./clientes-api";

const cliente: ClienteDetalle = {
  id: "cliente-1",
  nombre: "Litoplas",
  nit: "9001",
  tipo: "PROPIO",
  contactoNombre: null,
  contactoEmail: null,
  contactoTel: null,
  ciudad: "Barranquilla",
  manejaAnticipo: false,
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

function boton(etiqueta: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${etiqueta}"]`);
}

function tieneEditarEmpresa(): boolean {
  return [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Editar empresa"));
}

describe("seccionesDeFicha (§D.1: qué sección se ve según el rol de la empresa)", () => {
  it("cliente puro (esCliente, no esProveedor): cartera y anticipos sí; estado de cuenta del proveedor no; trámites siempre", () => {
    const s = seccionesDeFicha({ esCliente: true, esProveedor: false });
    expect(s.cartera).toBe(true);
    expect(s.anticipos).toBe(true);
    expect(s.estadoCuentaProveedor).toBe(false);
    expect(s.cuentaCorrienteRequiereCargosManuales).toBe(false);
    expect(s.tramitesSoloSiTiene).toBe(false);
  });

  it("proveedor puro (esProveedor, no esCliente, como Almacarga): sin cartera ni anticipos; sí estado de cuenta; trámites solo si tiene y cuenta corriente exige cargos manuales", () => {
    const s = seccionesDeFicha({ esCliente: false, esProveedor: true });
    expect(s.cartera).toBe(false);
    expect(s.anticipos).toBe(false);
    expect(s.estadoCuentaProveedor).toBe(true);
    expect(s.cuentaCorrienteRequiereCargosManuales).toBe(true);
    expect(s.tramitesSoloSiTiene).toBe(true);
  });

  it("cliente y proveedor a la vez: se ve todo, cuenta corriente no exige nada extra", () => {
    const s = seccionesDeFicha({ esCliente: true, esProveedor: true });
    expect(s.cartera).toBe(true);
    expect(s.anticipos).toBe(true);
    expect(s.estadoCuentaProveedor).toBe(true);
    expect(s.cuentaCorrienteRequiereCargosManuales).toBe(false);
    expect(s.tramitesSoloSiTiene).toBe(false);
  });

  it("ni cliente ni proveedor (dato raro): se trata como no-proveedor-puro, con cartera y anticipos visibles", () => {
    const s = seccionesDeFicha({ esCliente: false, esProveedor: false });
    expect(s.cartera).toBe(true);
    expect(s.anticipos).toBe(true);
    expect(s.estadoCuentaProveedor).toBe(false);
  });
});

describe("ClienteCabecera", () => {
  it("muestra los botones Funciones, Contacto y Tarifas, además de Editar empresa y la Ciudad", async () => {
    await act(async () =>
      root.render(
        <ClienteCabecera
          cliente={cliente}
          puedeEditar
          contactoVacio={false}
          sinTarifaVigente={false}
          onAbrirPopup={vi.fn()}
          onEdit={vi.fn()}
        />,
      ),
    );

    expect(boton("Funciones")).not.toBeNull();
    expect(boton("Contacto")).not.toBeNull();
    expect(boton("Tarifas")).not.toBeNull();
    expect(tieneEditarEmpresa()).toBe(true);
    expect(container.textContent).toContain("Barranquilla");
  });

  it("sin permiso de editar no muestra Editar empresa (pero sí los pop-ups)", async () => {
    await act(async () =>
      root.render(
        <ClienteCabecera
          cliente={cliente}
          puedeEditar={false}
          contactoVacio={false}
          sinTarifaVigente={false}
          onAbrirPopup={vi.fn()}
          onEdit={vi.fn()}
        />,
      ),
    );

    expect(tieneEditarEmpresa()).toBe(false);
    expect(boton("Funciones")).not.toBeNull();
    expect(boton("Contacto")).not.toBeNull();
    expect(boton("Tarifas")).not.toBeNull();
  });

  it("cada botón llama a onAbrirPopup con su propia clave", async () => {
    const onAbrirPopup = vi.fn();
    await act(async () =>
      root.render(
        <ClienteCabecera
          cliente={cliente}
          puedeEditar
          contactoVacio={false}
          sinTarifaVigente={false}
          onAbrirPopup={onAbrirPopup}
          onEdit={vi.fn()}
        />,
      ),
    );

    await act(async () => boton("Funciones")!.click());
    await act(async () => boton("Contacto")!.click());
    await act(async () => boton("Tarifas")!.click());

    expect(onAbrirPopup).toHaveBeenNthCalledWith(1, "funciones");
    expect(onAbrirPopup).toHaveBeenNthCalledWith(2, "contacto");
    expect(onAbrirPopup).toHaveBeenNthCalledWith(3, "tarifas");
  });

  it("sin ciudad no se muestra el datum Ciudad", async () => {
    await act(async () =>
      root.render(
        <ClienteCabecera
          cliente={{ ...cliente, ciudad: null }}
          puedeEditar
          contactoVacio={false}
          sinTarifaVigente={false}
          onAbrirPopup={vi.fn()}
          onEdit={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).not.toContain("Barranquilla");
  });

  describe("punto ámbar de aviso", () => {
    it("Contacto: solo aparece cuando contactoVacio es true", async () => {
      await act(async () =>
        root.render(
          <ClienteCabecera cliente={cliente} puedeEditar contactoVacio sinTarifaVigente={false} onAbrirPopup={vi.fn()} onEdit={vi.fn()} />,
        ),
      );
      expect(boton("Contacto")!.querySelector(".bg-amber-500")).not.toBeNull();

      await act(async () =>
        root.render(
          <ClienteCabecera cliente={cliente} puedeEditar contactoVacio={false} sinTarifaVigente={false} onAbrirPopup={vi.fn()} onEdit={vi.fn()} />,
        ),
      );
      expect(boton("Contacto")!.querySelector(".bg-amber-500")).toBeNull();
    });

    it('Tarifas: con sinTarifaVigente aparece el punto y el title pasa a "Sin tarifa vigente"', async () => {
      await act(async () =>
        root.render(
          <ClienteCabecera cliente={cliente} puedeEditar contactoVacio={false} sinTarifaVigente onAbrirPopup={vi.fn()} onEdit={vi.fn()} />,
        ),
      );
      const tarifas = boton("Tarifas")!;
      expect(tarifas.querySelector(".bg-amber-500")).not.toBeNull();
      expect(tarifas.title).toBe("Sin tarifa vigente");

      await act(async () =>
        root.render(
          <ClienteCabecera cliente={cliente} puedeEditar contactoVacio={false} sinTarifaVigente={false} onAbrirPopup={vi.fn()} onEdit={vi.fn()} />,
        ),
      );
      const tarifasOk = boton("Tarifas")!;
      expect(tarifasOk.querySelector(".bg-amber-500")).toBeNull();
      expect(tarifasOk.title).not.toBe("Sin tarifa vigente");
    });
  });
});
