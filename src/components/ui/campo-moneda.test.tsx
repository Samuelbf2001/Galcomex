import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampoMoneda, digitosDesdeTextoCOP, formatearMilesCOP } from "./campo-moneda";

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

function setNativeValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("formatearMilesCOP", () => {
  it("agrupa de a miles con punto", () => {
    expect(formatearMilesCOP("1234567")).toBe("1.234.567");
  });
  it("conserva el signo negativo", () => {
    expect(formatearMilesCOP("-45712")).toBe("-45.712");
  });
  it("vacío se queda vacío", () => {
    expect(formatearMilesCOP("")).toBe("");
  });
  it("por debajo de mil no lleva punto", () => {
    expect(formatearMilesCOP("500")).toBe("500");
  });
});

describe("digitosDesdeTextoCOP", () => {
  it("quita el símbolo de moneda y los puntos de miles", () => {
    expect(digitosDesdeTextoCOP("$200.000")).toBe("200000");
  });
  it("la coma es separador decimal: descarta los decimales", () => {
    expect(digitosDesdeTextoCOP("$ 200.000,50")).toBe("200000");
    expect(digitosDesdeTextoCOP("200.000,00")).toBe("200000");
  });
  it("texto ya limpio se mantiene igual", () => {
    expect(digitosDesdeTextoCOP("200000")).toBe("200000");
  });
  it("quita ceros a la izquierda", () => {
    expect(digitosDesdeTextoCOP("007")).toBe("7");
    expect(digitosDesdeTextoCOP("0")).toBe("0");
  });
  it("el signo negativo solo se conserva con permitirNegativo", () => {
    expect(digitosDesdeTextoCOP("-45.712", true)).toBe("-45712");
    expect(digitosDesdeTextoCOP("-45.712", false)).toBe("45712");
  });
  it("limita a 15 dígitos", () => {
    const texto = "1234567890123456789"; // 19 dígitos
    const resultado = digitosDesdeTextoCOP(texto);
    expect(resultado).toBe("123456789012345");
    expect(resultado.length).toBe(15);
  });
  it("vacío se queda vacío", () => {
    expect(digitosDesdeTextoCOP("")).toBe("");
  });
});

describe("CampoMoneda", () => {
  it("uncontrolled: formatea el defaultValue y se reformatea al escribir", async () => {
    await act(async () => root.render(<CampoMoneda defaultValue="200000" />));
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("200.000");

    await act(async () => setNativeValue(input, "1234567"));
    expect(input.value).toBe("1.234.567");
  });

  it("controlled: refleja `value` y `onValueChange` recibe solo dígitos", async () => {
    const onValueChange = vi.fn();

    function Wrapper() {
      const [valor, setValor] = useState("5000");
      return (
        <CampoMoneda
          value={valor}
          onValueChange={(digitos) => {
            onValueChange(digitos);
            setValor(digitos);
          }}
        />
      );
    }

    await act(async () => root.render(<Wrapper />));
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("5.000");

    await act(async () => setNativeValue(input, "50000"));
    expect(onValueChange).toHaveBeenCalledWith("50000");
    expect(input.value).toBe("50.000");
  });

  it("con `name` agrega un input oculto con los dígitos; el visible no lleva name", async () => {
    await act(async () =>
      root.render(
        <form>
          <CampoMoneda name="monto" defaultValue="200000" />
        </form>,
      ),
    );

    const form = container.querySelector("form") as HTMLFormElement;
    const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
    const oculto = container.querySelector('input[type="hidden"]') as HTMLInputElement;

    expect(visible.getAttribute("name")).toBeNull();
    expect(oculto.name).toBe("monto");
    expect(oculto.value).toBe("200000");
    expect(new FormData(form).get("monto")).toBe("200000");

    await act(async () => setNativeValue(visible, "1500000"));
    expect(new FormData(form).get("monto")).toBe("1500000");
  });

  it("muestra el prefijo $ salvo que prefijo=false", async () => {
    await act(async () => root.render(<CampoMoneda defaultValue="1000" />));
    expect(container.querySelector('span[aria-hidden="true"]')?.textContent).toBe("$");
    const inputConPrefijo = container.querySelector("input") as HTMLInputElement;
    expect(inputConPrefijo.style.paddingLeft).toBe("1.75rem");

    await act(async () => root.render(<CampoMoneda defaultValue="1000" prefijo={false} />));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
  });
});
