import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizarOrdenCompra, type OrdenCompraBorradorDto } from "@/components/facturacion/facturacion-api";

import { AprobarSinCuadreOcModal } from "./aprobar-sin-cuadre-oc-modal";
import { AvisoOrdenCompra, evaluacionEnVivo } from "./aviso-orden-compra";

/** Quita el espacio (normal o no separable) entre "$" y el número. */
const plano = (s: string) => s.replace(/\$\s/g, "$").replace(/ /g, " ");

const CONFIG = { base: "SERVICIO_Y_TERCEROS", incluye4x1000: false, bloqueaAprobacion: true } as const;

function oc(over: Partial<OrdenCompraBorradorDto> = {}): OrdenCompraBorradorDto {
  return {
    evaluacion: {
      estado: "NO_CUADRA",
      numero: "OC11104",
      valorOc: "539000",
      base: "427000",
      diferencia: "-112000",
      desglose: { servicio: "427000", terceros: "0", cuatroXMil: "0" },
      config: CONFIG,
    },
    config: CONFIG,
    hermanos: [],
    sumaHermanos: null,
    ...over,
  };
}

const linea = (valor: string, seccion: "OPERACIONAL" | "TERCEROS" = "OPERACIONAL", tipoFija: string | null = null) => ({
  valor,
  seccion,
  tipoFija,
});

describe("evaluacionEnVivo", () => {
  it("recalcula con las líneas actuales: al agregar 112.000 pasa de NO_CUADRA a CUADRA", () => {
    const antes = evaluacionEnVivo(oc(), [linea("427000")]);
    expect(antes).toMatchObject({ estado: "NO_CUADRA", base: "427000", diferencia: "-112000" });
    const despues = evaluacionEnVivo(oc(), [linea("427000"), linea("112000")]);
    expect(despues).toMatchObject({ estado: "CUADRA", base: "539000", diferencia: "0" });
  });

  it("no cuenta el IVA ni el 4x1000; con SERVICIO_Y_TERCEROS sí cuenta los reembolsos", () => {
    const ev = evaluacionEnVivo(oc(), [
      linea("827000"),
      linea("83800", "TERCEROS"),
      linea("335", "TERCEROS", "IMPUESTO_4X1000"),
      linea("157130", "OPERACIONAL", "IVA_COMISION"),
    ]);
    expect(ev).toMatchObject({ base: "910800", desglose: { servicio: "827000", terceros: "83800", cuatroXMil: "335" } });
  });

  it("SIN_VALOR no depende de las líneas", () => {
    const sinValor = oc({ evaluacion: { estado: "SIN_VALOR", numero: "OC4369" } });
    expect(evaluacionEnVivo(sinValor, [linea("1")])).toEqual({ estado: "SIN_VALOR", numero: "OC4369" });
  });
});

describe("normalizarOrdenCompra (respuesta del API)", () => {
  it("toma la evaluación del servidor con el dinero en texto; sin OC o sin la función → null", () => {
    const dto = normalizarOrdenCompra({
      activa: true,
      evaluacion: {
        estado: "CUADRA",
        numero: "OC10944",
        valorOc: "910800",
        base: "910800",
        diferencia: "0",
        desglose: { servicio: "827000", terceros: "83800", cuatroXMil: "335" },
        config: { base: "SERVICIO_Y_TERCEROS", incluye4x1000: false, bloqueaAprobacion: true },
      },
      config: { base: "SERVICIO_Y_TERCEROS", incluye4x1000: false, bloqueaAprobacion: true },
      hermanos: [{ consecutivo: "DO.BAQ26-0080", valorOc: "439000" }, { consecutivo: "DO.BAQ26-0081", valorOc: null }],
      sumaHermanos: "1901939",
    });
    expect(dto?.evaluacion.estado).toBe("CUADRA");
    expect(dto?.hermanos).toEqual([{ consecutivo: "DO.BAQ26-0080", valorOc: "439000" }, { consecutivo: "DO.BAQ26-0081", valorOc: null }]);
    expect(dto?.sumaHermanos).toBe("1901939");

    expect(normalizarOrdenCompra(undefined)).toBeNull();
    expect(normalizarOrdenCompra({ activa: false, evaluacion: { estado: "SIN_OC" } })).toBeNull();
    expect(normalizarOrdenCompra({ activa: true, evaluacion: { estado: "SIN_OC" }, config: {} })).toBeNull();
    expect(normalizarOrdenCompra({ activa: true, evaluacion: { estado: "CUADRA", numero: "X", valorOc: "1.5" }, config: {} })).toBeNull();
  });
});

describe("AvisoOrdenCompra", () => {
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

  it("no pinta nada sin OC (o sin la función)", async () => {
    await act(async () => root.render(<AvisoOrdenCompra oc={null} lineas={[]} />));
    expect(container.innerHTML).toBe("");
    await act(async () => root.render(<AvisoOrdenCompra oc={oc({ evaluacion: { estado: "SIN_OC" } })} lineas={[]} />));
    expect(container.innerHTML).toBe("");
  });

  it("no cuadra: rojo, dice cuánto falta y que no se puede aprobar (O2, faltan 112.000)", async () => {
    await act(async () => root.render(<AvisoOrdenCompra oc={oc()} lineas={[linea("427000")]} />));
    const texto = plano(container.textContent ?? "");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector(".bg-rose-50")).not.toBeNull();
    expect(texto).toContain("No cuadra con la orden de compra OC11104: faltan $112.000");
    expect(texto).toContain("La factura suma $427.000");
    expect(texto).toContain("la OC es de $539.000");
    expect(texto).toContain("No se puede aprobar");
  });

  it("cuadra: verde, con el desglose (servicio + reembolsos) y aclarando que el 4x1000 no entra (O1)", async () => {
    const cuadra = oc({
      evaluacion: {
        estado: "CUADRA",
        numero: "OC11374",
        valorOc: "407000",
        base: "407000",
        diferencia: "0",
        desglose: { servicio: "407000", terceros: "0", cuatroXMil: "0" },
        config: CONFIG,
      },
    });
    await act(async () => root.render(<AvisoOrdenCompra oc={cuadra} lineas={[linea("407000")]} />));
    const texto = plano(container.textContent ?? "");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector(".bg-emerald-50")).not.toBeNull();
    expect(texto).toContain("Cuadra con la orden de compra OC11374 por $407.000");
    expect(texto).toContain("servicio $407.000 + reembolsos $0; el 4x1000 no entra");
  });

  it("OC compartida: lista los DOs hermanos y la suma de las partes para compararla con el PDF (O6)", async () => {
    const compartida = oc({
      evaluacion: {
        estado: "CUADRA",
        numero: "OC10944",
        valorOc: "910800",
        base: "910800",
        diferencia: "0",
        desglose: { servicio: "827000", terceros: "83800", cuatroXMil: "335" },
        config: CONFIG,
      },
      hermanos: [
        { consecutivo: "DO.BAQ26-0080", valorOc: "439000" },
        { consecutivo: "DO.BAQ26-0081", valorOc: "552139" },
      ],
      sumaHermanos: "1901939",
    });
    await act(async () =>
      root.render(<AvisoOrdenCompra oc={compartida} lineas={[linea("827000"), linea("83800", "TERCEROS")]} />),
    );
    const texto = plano(container.textContent ?? "");
    expect(texto).toContain("Esta OC también está en DO.BAQ26-0080 ($439.000) y DO.BAQ26-0081 ($552.139)");
    expect(texto).toContain("las partes suman $1.901.939. Compáralo con el PDF de la OC.");
  });

  it("OC sin valor: rojo y pide escribirlo en el DO (O8)", async () => {
    await act(async () =>
      root.render(<AvisoOrdenCompra oc={oc({ evaluacion: { estado: "SIN_VALOR", numero: "OC4369" } })} lineas={[linea("500000")]} />),
    );
    const texto = plano(container.textContent ?? "");
    expect(container.querySelector(".bg-rose-50")).not.toBeNull();
    expect(texto).toContain("Orden de compra N° OC4369 (sin valor registrado en el DO)");
    expect(texto).toContain("Escribe el valor de la OC en el Resumen del DO");
  });

  it("si la empresa no frena (bloqueaAprobacion en false) el mismo descuadre es ámbar y solo avisa", async () => {
    const avisa = oc({ config: { ...CONFIG, bloqueaAprobacion: false } });
    await act(async () => root.render(<AvisoOrdenCompra oc={avisa} lineas={[linea("427000")]} />));
    const texto = plano(container.textContent ?? "");
    expect(container.querySelector(".bg-amber-50")).not.toBeNull();
    expect(texto).toContain("Revisa antes de aprobar");
    expect(texto).not.toContain("No se puede aprobar");
  });
});

describe("AprobarSinCuadreOcModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // <dialog> nativo: jsdom no implementa showModal.
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("muestra el mensaje del servidor y no deja aprobar sin un motivo de al menos 10 caracteres", async () => {
    const onAprobar = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <AprobarSinCuadreOcModal
          consecutivo="DO.BAQ26-0130"
          mensaje="La factura suma $427.000 sin impuestos y la orden de compra OC11104 es de $539.000: faltan $112.000."
          onCancelar={() => undefined}
          onAprobar={onAprobar}
        />,
      ),
    );
    expect(container.textContent).toContain("faltan $112.000");
    const boton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Aprobar con este motivo"))!;
    expect(boton.disabled).toBe(true);
    expect(onAprobar).not.toHaveBeenCalled();
  });
});
