import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Rol } from "@/lib/auth/auth";
import { RolProvider } from "@/lib/auth/rol-context";

import type { ChecklistItem } from "./checklist-api";
import { ChecklistItemRow } from "./tramite-detalle";

// ─── D0: la fila del cuadre de plata histórica solo tiene su casilla ─────────
//
// El cuadre lo cierran ADMIN o REVISOR con la casilla (PATCH con AuditLog
// UPDATE_CHECKLIST_ITEM). Ninguna otra acción de la fila puede cerrarlo.
// Esta prueba vigila la integración con feat/eventos-subir-archivos (934bbdf),
// que agrega a TODAS las filas del checklist un botón para subir archivos que
// marca el ítem como recibido y se mezcla con D0 sin conflicto: en la fila del
// cuadre no debe aparecer ningún control de subida, para ningún rol.

const CUADRE: ChecklistItem = {
  id: "item-cuadre",
  descripcion: "CUADRE DE PLATA HISTÓRICA · ROJO",
  requerido: true,
  recibido: false,
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

async function renderFila(rol: Rol, editable: boolean) {
  await act(async () => {
    root.render(
      <RolProvider rol={rol}>
        <ul>
          <ChecklistItemRow
            item={CUADRE}
            tramiteId="tramite-1"
            editable={editable}
            esCuadre
            onChanged={() => {}}
            onSubido={() => {}}
          />
        </ul>
      </RolProvider>,
    );
  });
}

function controlesDeSubida(): Element[] {
  const inputs = Array.from(container.querySelectorAll('input[type="file"]'));
  const botones = Array.from(container.querySelectorAll("button")).filter((b) =>
    /subir|adjuntar|cargar/i.test(`${b.textContent ?? ""} ${b.getAttribute("aria-label") ?? ""}`),
  );
  return [...inputs, ...botones];
}

describe("ChecklistItemRow — fila del cuadre de plata histórica", () => {
  // editable = lo que calcula la ficha: solo ADMIN/REVISOR pueden cerrar el cuadre.
  it.each<[Rol, boolean]>([
    ["ADMIN", true],
    ["REVISOR", true],
    ["OPERATIVO", false],
    ["SOCIO", false],
  ])("%s: sin controles para subir archivos", async (rol, editable) => {
    await renderFila(rol, editable);

    expect(container.textContent).toContain("CUADRE DE PLATA HISTÓRICA · ROJO");
    expect(controlesDeSubida()).toEqual([]);
  });

  it("ADMIN ve la casilla para cerrar el cuadre; OPERATIVO no ve ninguna casilla", async () => {
    await renderFila("ADMIN", true);
    const casilla = container.querySelector('input[type="checkbox"]');
    expect(casilla?.getAttribute("aria-label")).toBe('Cerrar el cuadre "CUADRE DE PLATA HISTÓRICA · ROJO"');

    await renderFila("OPERATIVO", false);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

// ─── 30-sep-2026: un documento que no aplica al servicio del DO ───────────────
describe("ChecklistItemRow — ítem que no aplica al servicio", () => {
  const BL: ChecklistItem = {
    id: "item-bl",
    descripcion: "BL (Bill of Lading)",
    requerido: true,
    recibido: false,
    categoriaDocumento: "BL",
  };

  async function render(noAplica: string | null) {
    await act(async () => {
      root.render(
        <RolProvider rol="OPERATIVO">
          <ul>
            <ChecklistItemRow
              item={BL}
              tramiteId="tramite-1"
              editable={false}
              noAplica={noAplica}
              onChanged={() => {}}
              onSubido={() => {}}
            />
          </ul>
        </RolProvider>,
      );
    });
  }

  it("en una nacionalización el BL dice «no aplica» en vez de «requerido»", async () => {
    await render("Nacionalización desde zona franca");
    expect(container.textContent).toContain("(no aplica a Nacionalización desde zona franca)");
    expect(container.textContent).not.toContain("(requerido)");
  });

  it("sin servicio que lo quite, sigue «requerido»", async () => {
    await render(null);
    expect(container.textContent).toContain("(requerido)");
  });
});
