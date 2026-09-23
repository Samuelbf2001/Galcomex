import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalShell } from "./modal-shell";

// jsdom no implementa <dialog>.showModal()/close() (ver
// node_modules/jsdom/lib/jsdom/living/nodes/HTMLDialogElement-impl.js):
// solo reflejan el atributo `open`. Se agrega un polyfill mínimo para poder
// montar ModalShell en los tests; en el navegador real nunca se usa.
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

describe("ModalShell — pedido de Ernesto 22-sep: solo se cierra con la X o el pie", () => {
  it("el clic en el fondo (el propio <dialog>) NO cierra", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba">
          contenido
        </ModalShell>,
      ),
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;

    // Un clic en el fondo reporta target === dialog (el contenido está en un
    // <div> hijo); así es como los navegadores marcan el clic en el ::backdrop.
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape (evento cancel del <dialog>) NO cierra", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba">
          contenido
        </ModalShell>,
      ),
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;

    await act(async () => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("el botón X sí cierra", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba">
          contenido
        </ModalShell>,
      ),
    );
    const cerrar = container.querySelector('button[aria-label="Cerrar"]') as HTMLButtonElement;

    await act(async () => cerrar.click());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismissible=false deshabilita la X (pero no cambia Escape/backdrop, que ya no cierran)", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba" dismissible={false}>
          contenido
        </ModalShell>,
      ),
    );
    const cerrar = container.querySelector('button[aria-label="Cerrar"]') as HTMLButtonElement;
    expect(cerrar.disabled).toBe(true);
  });

  it("F2 — Escape se cancela en keydown (blindaje contra el segundo Escape de Chrome/Edge)", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba">
          contenido
        </ModalShell>,
      ),
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;

    const evento = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    await act(async () => {
      dialog.dispatchEvent(evento);
    });

    expect(evento.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("F2 — si el <dialog> se cierra solo (evento close) con open=true, se vuelve a abrir", async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <ModalShell open onClose={onClose} title="Prueba">
          contenido
        </ModalShell>,
      ),
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);

    const showModalSpy = vi.spyOn(dialog, "showModal");

    // Simula el bug del segundo Escape: el navegador cierra el <dialog> por
    // su cuenta (se le quita el atributo `open` y dispara `close`) mientras
    // React sigue creyendo que `open` es `true`.
    await act(async () => {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    });

    expect(showModalSpy).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
  });

  it('size="full" usa max-w-6xl', async () => {
    await act(async () =>
      root.render(
        <ModalShell open onClose={vi.fn()} title="Prueba" size="full">
          contenido
        </ModalShell>,
      ),
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.className).toContain("max-w-6xl");
  });
});
