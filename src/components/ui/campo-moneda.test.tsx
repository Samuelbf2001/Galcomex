import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampoMoneda, useErroresMoneda, type DetalleCampoMoneda } from "./campo-moneda";

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

function visible(): HTMLInputElement {
  return container.querySelector('input[type="text"]') as HTMLInputElement;
}
function oculto(): HTMLInputElement | null {
  return container.querySelector('input[type="hidden"]');
}
function textoError(): string | null {
  return container.querySelector('[data-campo-moneda="error"]')?.textContent ?? null;
}
function textoAyuda(): string | null {
  return container.querySelector('[data-campo-moneda="ayuda"]')?.textContent ?? null;
}

/** Escribe como una persona: enfoca, cambia el texto y sale del campo. */
async function escribir(input: HTMLInputElement, texto: string, { salir = true } = {}) {
  await act(async () => input.focus());
  await act(async () => setNativeValue(input, texto));
  if (salir) await act(async () => input.blur());
}

/** Padre controlado que guarda lo emitido. */
function Controlado(props: {
  inicial: string;
  onEmitir: (texto: string, detalle: DetalleCampoMoneda) => void;
  permitirNegativo?: boolean;
  decimales?: boolean;
}) {
  const [valor, setValor] = useState(props.inicial);
  return (
    <>
      <CampoMoneda
        value={valor}
        permitirNegativo={props.permitirNegativo}
        decimales={props.decimales}
        onValueChange={(texto, detalle) => {
          props.onEmitir(texto, detalle);
          setValor(texto);
        }}
      />
      <button type="button" onClick={() => setValor("")}>
        limpiar
      </button>
      <button type="button" onClick={() => setValor("777000.50")}>
        cargar
      </button>
    </>
  );
}

describe("CampoMoneda — valor de máquina (pesos texto) ↔ pantalla es-CO", () => {
  it("defaultValue en pesos (heredado, canónico o de la API) se muestra en es-CO", async () => {
    await act(async () => root.render(<CampoMoneda defaultValue="200000" />));
    expect(visible().value).toBe("200.000");
    await act(async () => root.render(<CampoMoneda key="b" defaultValue="502801.45" />));
    expect(visible().value).toBe("502.801,45");
    await act(async () => root.render(<CampoMoneda key="c" defaultValue="502801.00" />));
    expect(visible().value).toBe("502.801");
  });

  it('escribir "502801,45" ⇒ emite "502801.45" y al salir muestra "502.801,45"', async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "502801,45", { salir: false });
    expect(onEmitir).toHaveBeenLastCalledWith("502801.45", { ok: true, centavos: 50_280_145n });
    // Mientras edita: texto tal cual + ayuda con el monto interpretado.
    expect(visible().value).toBe("502801,45");
    expect(textoAyuda()).toBe("$ 502.801,45");
    await act(async () => visible().blur());
    expect(visible().value).toBe("502.801,45");
    expect(textoAyuda()).toBeNull();
    expect(textoError()).toBeNull();
  });

  it('pegar "502801.45" (Excel/API) ⇒ emite "502801.45"', async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "502801.45");
    expect(onEmitir).toHaveBeenLastCalledWith("502801.45", { ok: true, centavos: 50_280_145n });
    expect(visible().value).toBe("502.801,45");
  });

  it('"$ 1.500.000" y "1500000" ⇒ "1500000"', async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "$ 1.500.000");
    expect(onEmitir).toHaveBeenLastCalledWith("1500000", { ok: true, centavos: 150_000_000n });
    expect(visible().value).toBe("1.500.000");
    await escribir(visible(), "1500000");
    expect(onEmitir).toHaveBeenLastCalledWith("1500000", { ok: true, centavos: 150_000_000n });
  });

  it('rechaza "1,500" y "1,505" con FORMATO (nunca 1.000 veces menos) y conserva lo escrito', async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "1,500");
    expect(onEmitir).toHaveBeenLastCalledWith("", expect.objectContaining({ ok: false, motivo: "FORMATO" }));
    expect(visible().value).toBe("1,500");
    expect(textoError()).toBe("¿Quisiste decir 1.500 o 1,50? Usa punto para miles y coma para decimales");
    expect(visible().getAttribute("aria-invalid")).toBe("true");

    await escribir(visible(), "1,505");
    expect(onEmitir).toHaveBeenLastCalledWith("", expect.objectContaining({ ok: false, motivo: "FORMATO" }));
    expect(textoError()).toMatch(/1\.505 o 1,50/);
  });

  it("más de 2 decimales ⇒ error, no se trunca", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "200.000,501");
    expect(onEmitir).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ ok: false, motivo: "MAS_DE_2_DECIMALES" }),
    );
    expect(visible().value).toBe("200.000,501");
    expect(textoError()).toMatch(/2 decimales/);
  });

  it("el error no aparece mientras se escribe; al corregir desaparece", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "1,500", { salir: false });
    expect(textoError()).toBeNull();
    await act(async () => visible().blur());
    expect(textoError()).not.toBeNull();
    await escribir(visible(), "1.500");
    expect(textoError()).toBeNull();
    expect(visible().value).toBe("1.500");
    expect(onEmitir).toHaveBeenLastCalledWith("1500", { ok: true, centavos: 150_000n });
  });

  it("al enfocar muestra el valor sin puntos de miles (borrar un dígito no lo vuelve decimal)", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="1500" onEmitir={onEmitir} />));
    expect(visible().value).toBe("1.500");
    await act(async () => visible().focus());
    expect(visible().value).toBe("1500");
    await act(async () => setNativeValue(visible(), "150")); // borró el último 0
    expect(onEmitir).toHaveBeenLastCalledWith("150", { ok: true, centavos: 15_000n });
    await act(async () => visible().blur());
    expect(visible().value).toBe("150");
  });

  it("vacío emite \"\" con ok y centavos null", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="5000" onEmitir={onEmitir} />));
    await escribir(visible(), "");
    expect(onEmitir).toHaveBeenLastCalledWith("", { ok: true, centavos: null });
    expect(visible().value).toBe("");
    expect(textoError()).toBeNull();
  });

  it("si el padre cambia el valor (limpiar/cargar), se descarta lo escrito", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "1,500");
    expect(visible().value).toBe("1,500");
    await act(async () => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(visible().value).toBe("777.000,50");
    expect(textoError()).toBeNull();
    await escribir(visible(), "12");
    await act(async () => (container.querySelectorAll("button")[0] as HTMLButtonElement).click());
    expect(visible().value).toBe("");
  });

  it("negativos: solo con permitirNegativo", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} permitirNegativo />));
    await escribir(visible(), "-45.712");
    expect(onEmitir).toHaveBeenLastCalledWith("-45712", { ok: true, centavos: -4_571_200n });
    expect(visible().value).toBe("-45.712");

    await act(async () => root.render(<Controlado key="sin" inicial="" onEmitir={onEmitir} />));
    await escribir(visible(), "-45.712");
    expect(onEmitir).toHaveBeenLastCalledWith("", expect.objectContaining({ ok: false, motivo: "NEGATIVO" }));
  });

  it("decimales={false}: solo pesos enteros", async () => {
    const onEmitir = vi.fn();
    await act(async () => root.render(<Controlado inicial="" onEmitir={onEmitir} decimales={false} />));
    expect(visible().getAttribute("inputmode")).toBe("numeric");
    await escribir(visible(), "150.000,50");
    expect(onEmitir).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ ok: false, motivo: "CON_CENTAVOS", mensaje: "Solo pesos enteros, sin centavos" }),
    );
    await escribir(visible(), "150.000");
    expect(onEmitir).toHaveBeenLastCalledWith("150000", { ok: true, centavos: 15_000_000n });
  });

  it("con `name` agrega un input oculto con el texto canónico; el visible no lleva name", async () => {
    await act(async () =>
      root.render(
        <form>
          <CampoMoneda name="monto" defaultValue="200000" />
        </form>,
      ),
    );
    const form = container.querySelector("form") as HTMLFormElement;
    expect(visible().getAttribute("name")).toBeNull();
    expect(oculto()!.name).toBe("monto");
    expect(new FormData(form).get("monto")).toBe("200000");

    await escribir(visible(), "502.801,45");
    expect(new FormData(form).get("monto")).toBe("502801.45");

    await escribir(visible(), "1,500");
    expect(new FormData(form).get("monto")).toBe("");
  });

  it("value de la API con 2 decimales: se muestra sin ',00' y el oculto va canónico", async () => {
    await act(async () => root.render(<CampoMoneda name="v" value="502801.00" onValueChange={() => {}} />));
    expect(visible().value).toBe("502.801");
    expect(oculto()!.value).toBe("502801");
  });

  it("un value ilegible se muestra tal cual y no se envía", async () => {
    await act(async () => root.render(<CampoMoneda name="v" value="abc" onValueChange={() => {}} />));
    expect(visible().value).toBe("abc");
    expect(oculto()!.value).toBe("");
  });

  it("inputMode decimal por defecto y respeta onFocus/onBlur del padre", async () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    await act(async () => root.render(<CampoMoneda defaultValue="1" onFocus={onFocus} onBlur={onBlur} />));
    expect(visible().getAttribute("inputmode")).toBe("decimal");
    await act(async () => visible().focus());
    await act(async () => visible().blur());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("muestra el prefijo $ salvo que prefijo=false", async () => {
    await act(async () => root.render(<CampoMoneda defaultValue="1000" />));
    expect(container.querySelector('span[aria-hidden="true"]')?.textContent).toBe("$");
    expect(visible().style.paddingLeft).toBe("1.75rem");

    await act(async () => root.render(<CampoMoneda defaultValue="1000" prefijo={false} />));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
  });
});

describe("CampoMoneda — «inválido» no se confunde con «vacío» (hallazgo 1)", () => {
  function Formulario(props: { onEnviar: (monto: string) => void }) {
    const [monto, setMonto] = useState("");
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onEnviar(monto);
        }}
      >
        <CampoMoneda value={monto} onValueChange={setMonto} />
        <button type="submit">Generar</button>
      </form>
    );
  }

  function enviar() {
    const form = container.querySelector("form") as HTMLFormElement;
    form.requestSubmit(container.querySelector('button[type="submit"]') as HTMLButtonElement);
  }

  it.each(["875,944", "1.000,555", "15,555"])('"%s" deja el input inválido y el <form> no se envía', async (texto) => {
    const onEnviar = vi.fn();
    await act(async () => root.render(<Formulario onEnviar={onEnviar} />));
    await escribir(visible(), texto);
    expect(visible().validity.customError).toBe(true);
    expect(visible().validationMessage).not.toBe("");
    await act(async () => enviar());
    expect(onEnviar).not.toHaveBeenCalled();
  });

  it("vacío o válido: el <form> se envía; corregir lo inválido lo destraba", async () => {
    const onEnviar = vi.fn();
    await act(async () => root.render(<Formulario onEnviar={onEnviar} />));
    await act(async () => enviar());
    expect(onEnviar).toHaveBeenLastCalledWith("");
    await escribir(visible(), "875,944");
    await act(async () => enviar());
    expect(onEnviar).toHaveBeenCalledTimes(1);
    await escribir(visible(), "875.944");
    expect(visible().validity.valid).toBe(true);
    await act(async () => enviar());
    expect(onEnviar).toHaveBeenLastCalledWith("875944");
  });

  it("si el padre carga otro valor, el input deja de estar inválido", async () => {
    await act(async () => root.render(<Controlado inicial="" onEmitir={() => {}} />));
    await escribir(visible(), "1,500");
    expect(visible().validity.valid).toBe(false);
    await act(async () => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(visible().validity.valid).toBe(true);
  });

  it("respeta un ref del padre (objeto)", async () => {
    const ref = { current: null as HTMLInputElement | null };
    await act(async () => root.render(<CampoMoneda ref={ref} defaultValue="1" />));
    expect(ref.current).toBe(visible());
  });

  it("useErroresMoneda: registra, da el primer error con el nombre del campo y lo olvida al corregir", async () => {
    function ConHook() {
      const errores = useErroresMoneda();
      const [cif, setCif] = useState("300000000");
      return (
        <>
          <CampoMoneda
            value={cif}
            onValueChange={(t, d) => {
              setCif(t);
              errores.registrar("Valor CIF", d);
            }}
          />
          <output data-primer-error="">{errores.primerError ?? ""}</output>
        </>
      );
    }
    const leerPrimer = () => container.querySelector("[data-primer-error]")?.textContent || null;
    await act(async () => root.render(<ConHook />));
    expect(leerPrimer()).toBeNull();
    await escribir(visible(), "300.000.000,555");
    expect(leerPrimer()).toBe("Valor CIF: Máximo 2 decimales (centavos)");
    await escribir(visible(), "");
    expect(leerPrimer()).toBeNull();
  });
});
