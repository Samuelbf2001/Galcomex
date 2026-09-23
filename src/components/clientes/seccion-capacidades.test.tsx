import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SeccionCapacidades } from "./seccion-capacidades";
import {
  fetchCapacidades,
  fetchTiposTramiteCatalogo,
  guardarCapacidades,
  type CapacidadRow,
} from "./capacidades-api";

let esAdmin = true;

vi.mock("./capacidades-api", () => ({
  fetchCapacidades: vi.fn(),
  fetchTiposTramiteCatalogo: vi.fn(),
  guardarCapacidades: vi.fn(),
}));
vi.mock("@/lib/auth/rol-context", () => ({ useEsAdmin: () => esAdmin }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  describirError: (error: Error) => error.message,
}));

function fila(config: Record<string, unknown> | null, habilitado = true): CapacidadRow {
  return {
    codigo: "do_exige_tarifa_vigente",
    nombre: "DO solo con tarifa vigente",
    descripcion: "No deja crear un DO si la empresa no tiene una tarifa vigente.",
    grupo: "Comercial",
    habilitado,
    config,
    porDefecto: true,
    origenHabilitado: "DEFECTO",
    origenConfig: "DEFECTO",
    tieneOverride: false,
  };
}

let container: HTMLDivElement;
let root: Root;

async function montar(filas: CapacidadRow[]) {
  vi.mocked(fetchCapacidades).mockResolvedValue(filas);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SeccionCapacidades clienteId="empresa-1" />));
}

function casilla(etiqueta: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `input[type="checkbox"][aria-label="DO solo con tarifa vigente: ${etiqueta}"]`,
  );
  if (!input) throw new Error(`No está la casilla ${etiqueta}`);
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  esAdmin = true;
  vi.mocked(fetchTiposTramiteCatalogo).mockResolvedValue([
    { codigo: "IMPORTACION", nombre: "Trámite de importación" },
    { codigo: "CLASIFICACION", nombre: "Clasificación arancelaria" },
    { codigo: "OTRO", nombre: "Otros servicios" },
  ]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Funciones: config por tipo de trámite", () => {
  it("muestra una casilla por tipo y guarda la lista sin el tipo desmarcado", async () => {
    await montar([fila({ tiposTramite: ["IMPORTACION", "CLASIFICACION", "OTRO"] })]);
    vi.mocked(guardarCapacidades).mockResolvedValue([
      fila({ tiposTramite: ["IMPORTACION", "OTRO"] }),
    ]);

    expect(casilla("Importación").checked).toBe(true);
    expect(casilla("Otros (Plan Vallejo, sellos…)").checked).toBe(true);

    await act(async () => casilla("Clasificación arancelaria").click());

    expect(guardarCapacidades).toHaveBeenCalledWith("empresa-1", [
      {
        codigo: "do_exige_tarifa_vigente",
        habilitado: true,
        config: { tiposTramite: ["IMPORTACION", "OTRO"] },
      },
    ]);
    expect(casilla("Clasificación arancelaria").checked).toBe(false);
  });

  it("al marcar respeta el orden del catálogo", async () => {
    await montar([fila({ tiposTramite: ["OTRO"] })]);
    vi.mocked(guardarCapacidades).mockResolvedValue([fila({ tiposTramite: ["IMPORTACION", "OTRO"] })]);

    await act(async () => casilla("Importación").click());

    expect(guardarCapacidades).toHaveBeenCalledWith("empresa-1", [
      expect.objectContaining({ config: { tiposTramite: ["IMPORTACION", "OTRO"] } }),
    ]);
  });

  it("avisa cuando no queda ningún tipo marcado", async () => {
    await montar([fila({ tiposTramite: [] })]);

    expect(container.textContent).toContain("No marcaste ningún tipo");
  });

  it("solo lectura para quien no es ADMIN", async () => {
    esAdmin = false;
    await montar([fila({ tiposTramite: ["IMPORTACION"] })]);

    expect(casilla("Importación").disabled).toBe(true);
  });

  it("con la función apagada no muestra las casillas", async () => {
    await montar([fila({ tiposTramite: ["IMPORTACION"] }, false)]);

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
