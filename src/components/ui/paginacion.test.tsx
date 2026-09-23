import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Paginacion, usePaginacionLocal } from "./paginacion";

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

function botonAnterior() {
  return container.querySelector('button[aria-label="Página anterior"]') as HTMLButtonElement;
}
function botonSiguiente() {
  return container.querySelector('button[aria-label="Página siguiente"]') as HTMLButtonElement;
}

describe("Paginacion", () => {
  it("muestra el rango y la etiqueta en la primera página", async () => {
    await act(async () =>
      root.render(
        <Paginacion total={169} pagina={1} porPagina={25} etiqueta="trámites" onPaginaChange={vi.fn()} onPorPaginaChange={vi.fn()} />,
      ),
    );
    expect(container.textContent).toContain("Mostrando 1–25 de 169 trámites");
    expect(container.textContent).toContain("Página 1 de 7");
    expect(botonAnterior().disabled).toBe(true);
    expect(botonSiguiente().disabled).toBe(false);
  });

  it("en la última página el rango se recorta y Siguiente se deshabilita", async () => {
    await act(async () =>
      root.render(
        <Paginacion total={169} pagina={7} porPagina={25} etiqueta="trámites" onPaginaChange={vi.fn()} onPorPaginaChange={vi.fn()} />,
      ),
    );
    expect(container.textContent).toContain("Mostrando 151–169 de 169 trámites");
    expect(botonSiguiente().disabled).toBe(true);
    expect(botonAnterior().disabled).toBe(false);
  });

  it('sin resultados muestra "Sin resultados" y ambos botones deshabilitados', async () => {
    await act(async () =>
      root.render(<Paginacion total={0} pagina={1} porPagina={25} onPaginaChange={vi.fn()} onPorPaginaChange={vi.fn()} />),
    );
    expect(container.textContent).toContain("Sin resultados");
    expect(botonAnterior().disabled).toBe(true);
    expect(botonSiguiente().disabled).toBe(true);
  });

  it("Anterior/Siguiente llaman a onPaginaChange con la página vecina", async () => {
    const onPaginaChange = vi.fn();
    await act(async () =>
      root.render(
        <Paginacion total={169} pagina={3} porPagina={25} onPaginaChange={onPaginaChange} onPorPaginaChange={vi.fn()} />,
      ),
    );
    await act(async () => botonAnterior().click());
    expect(onPaginaChange).toHaveBeenCalledWith(2);
    await act(async () => botonSiguiente().click());
    expect(onPaginaChange).toHaveBeenCalledWith(4);
  });

  it("cambiar 'Por página' llama a onPorPaginaChange y resetea a la página 1", async () => {
    const onPaginaChange = vi.fn();
    const onPorPaginaChange = vi.fn();
    await act(async () =>
      root.render(
        <Paginacion total={169} pagina={3} porPagina={25} onPaginaChange={onPaginaChange} onPorPaginaChange={onPorPaginaChange} />,
      ),
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "50");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPorPaginaChange).toHaveBeenCalledWith(50);
    expect(onPaginaChange).toHaveBeenCalledWith(1);
  });

  it("cargando deshabilita el select y los botones", async () => {
    await act(async () =>
      root.render(
        <Paginacion total={169} pagina={3} porPagina={25} cargando onPaginaChange={vi.fn()} onPorPaginaChange={vi.fn()} />,
      ),
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(botonAnterior().disabled).toBe(true);
    expect(botonSiguiente().disabled).toBe(true);
  });
});

// ── usePaginacionLocal ───────────────────────────────────────────────────────

function Harness({ items }: { items: number[] }) {
  const { pagina, porPagina, total, visibles, setPagina, setPorPagina } = usePaginacionLocal(items, 2);
  return (
    <div>
      <p data-testid="info">{`pagina=${pagina} porPagina=${porPagina} total=${total} visibles=${visibles.join(",")}`}</p>
      <button type="button" onClick={() => setPagina(pagina + 1)}>
        siguiente
      </button>
      <button type="button" onClick={() => setPorPagina(3)}>
        cambiarPorPagina
      </button>
    </div>
  );
}

function leerInfo() {
  return container.querySelector('[data-testid="info"]')!.textContent;
}

describe("usePaginacionLocal", () => {
  it("pagina en memoria y vuelve a la página 1 al cambiar porPagina", async () => {
    await act(async () => root.render(<Harness items={[1, 2, 3, 4, 5]} />));
    expect(leerInfo()).toBe("pagina=1 porPagina=2 total=5 visibles=1,2");

    const [siguiente, cambiarPorPagina] = Array.from(container.querySelectorAll("button"));
    await act(async () => siguiente.click());
    expect(leerInfo()).toBe("pagina=2 porPagina=2 total=5 visibles=3,4");

    await act(async () => cambiarPorPagina.click());
    expect(leerInfo()).toBe("pagina=1 porPagina=3 total=5 visibles=1,2,3");
  });

  it("clampa la página cuando la lista se encoge", async () => {
    await act(async () => root.render(<Harness items={[1, 2, 3, 4, 5, 6]} />));
    const siguiente = container.querySelectorAll("button")[0] as HTMLButtonElement;
    await act(async () => siguiente.click()); // página 2
    await act(async () => siguiente.click()); // página 3
    expect(leerInfo()).toBe("pagina=3 porPagina=2 total=6 visibles=5,6");

    // La lista se reduce a 2 ítems (1 sola página): la página vuelve a 1 sola.
    await act(async () => root.render(<Harness items={[1, 2]} />));
    expect(leerInfo()).toBe("pagina=1 porPagina=2 total=2 visibles=1,2");
  });
});
