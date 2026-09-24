import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapacidadRow } from "@/components/clientes/capacidades-api";
import type { EventoCatalogoRow } from "@/components/clientes/tarifas-api";
import type { ChecklistItem } from "@/components/tramites/checklist-api";
import type { EventoTramiteRow, PropuestaTarifaRow } from "@/components/tramites/eventos-api";
import { RolProvider } from "@/lib/auth/rol-context";

import {
  camposBaseCalculoVisibles,
  muestraListaEventos,
  SeccionEventosTramite,
} from "./seccion-eventos-tramite";

vi.mock("@/components/clientes/capacidades-api", () => ({
  fetchCapacidades: vi.fn(),
}));
vi.mock("@/components/clientes/tarifas-api", async (original) => ({
  ...(await original<typeof import("@/components/clientes/tarifas-api")>()),
  fetchEventosCatalogo: vi.fn(),
}));
vi.mock("@/components/tramites/eventos-api", () => ({
  fetchEventosTramite: vi.fn(),
  fetchPropuestaTarifa: vi.fn(),
  guardarAtributosTramite: vi.fn(),
  guardarEventosTramite: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  describirError: (error: unknown, fallback?: string) =>
    error instanceof Error ? error.message : (fallback ?? "Error"),
}));

import { fetchCapacidades } from "@/components/clientes/capacidades-api";
import { fetchEventosCatalogo } from "@/components/clientes/tarifas-api";
import { fetchEventosTramite, fetchPropuestaTarifa } from "@/components/tramites/eventos-api";

function capacidad(codigo: string, habilitado: boolean): CapacidadRow {
  return {
    codigo,
    nombre: codigo,
    descripcion: "",
    grupo: "Comercial",
    habilitado,
    config: null,
    porDefecto: false,
    origenHabilitado: "EMPRESA",
    origenConfig: "DEFECTO",
    tieneOverride: false,
  };
}

const EVENTO_CONTENEDOR: EventoCatalogoRow = {
  codigo: "CONTENEDOR_ABIERTO",
  nombre: "Contenedor abierto",
  descripcion: null,
  documentosRequeridos: [],
  permiteCantidad: false,
};

const PROPUESTA_SIN_TARIFARIO: PropuestaTarifaRow = {
  tarifario: null,
  motivo: "Sin tarifario vigente.",
  resultado: null,
  contexto: {
    valorCif: null,
    tipoCarga: null,
    numContenedores: null,
    numDeclaraciones: null,
    numDocumentos: null,
    numItems: null,
    ordenCompraNumero: null,
    ordenCompraValor: null,
    eventos: [],
  },
};

const SIN_EVENTOS_MARCADOS: EventoTramiteRow[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  // Empresa con tarifario propio y eventos facturables encendidos: así, si
  // CLASIFICACION oculta el CIF o los eventos, es por el tipo de trámite
  // (usaEventos/camposBaseCalculo), no porque la capacidad esté apagada.
  vi.mocked(fetchCapacidades).mockResolvedValue([
    capacidad("tarifario_propio", true),
    capacidad("eventos_facturables", true),
    capacidad("base_cif", false),
    capacidad("orden_compra_en_revision", false),
  ]);
  vi.mocked(fetchEventosCatalogo).mockResolvedValue([EVENTO_CONTENEDOR]);
  vi.mocked(fetchEventosTramite).mockResolvedValue(SIN_EVENTOS_MARCADOS);
  vi.mocked(fetchPropuestaTarifa).mockResolvedValue(PROPUESTA_SIN_TARIFARIO);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montar(props: Partial<React.ComponentProps<typeof SeccionEventosTramite>> = {}) {
  await act(async () =>
    root.render(
      <SeccionEventosTramite tramiteId="tramite-1" clienteId="cliente-1" puedeEditar {...props} />,
    ),
  );
  // Deja que se resuelva el Promise.all de las 4 llamadas mockeadas (todas ya
  // resueltas, pero el estado se actualiza tras varios ticks de microtareas).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("SeccionEventosTramite — panel por tipo de trámite (M4)", () => {
  it("IMPORTACION (sin restricción de tipo): muestra los seis campos y la lista de eventos", async () => {
    await montar({ camposBaseCalculo: null, usaEventos: true });

    expect(container.textContent).toContain("Valor CIF (COP)");
    expect(container.textContent).toContain("Tipo de carga");
    expect(container.textContent).toContain("Contenedores");
    expect(container.textContent).toContain("Declaraciones");
    expect(container.textContent).toContain("Documentos revisados");
    expect(container.textContent).toContain("Ítems clasificados");
    expect(container.textContent).toContain("Contenedor abierto");
  });

  it("CLASIFICACION (camposBaseCalculo=[numItems], usaEventos=false): solo Ítems clasificados, sin eventos", async () => {
    await montar({ camposBaseCalculo: ["numItems"], usaEventos: false });

    expect(container.textContent).toContain("Ítems clasificados");
    expect(container.textContent).not.toContain("Valor CIF (COP)");
    expect(container.textContent).not.toContain("Tipo de carga");
    expect(container.textContent).not.toContain("Contenedores");
    expect(container.textContent).not.toContain("Declaraciones");
    expect(container.textContent).not.toContain("Documentos revisados");
    expect(container.textContent).not.toContain("Contenedor abierto");
    expect(container.textContent).toContain("Este tipo de trámite no usa eventos.");
  });

  it("sin props de tipo (respuesta vieja) conserva el comportamiento histórico: los seis campos y eventos", async () => {
    await montar();

    expect(container.textContent).toContain("Valor CIF (COP)");
    expect(container.textContent).toContain("Ítems clasificados");
    expect(container.textContent).toContain("Contenedor abierto");
  });
});

describe("camposBaseCalculoVisibles — función pura", () => {
  it("universo vacío/ausente = sin restricción de tipo (IMPORTACION, OTRO)", () => {
    expect([...camposBaseCalculoVisibles(null, true)].sort()).toEqual(
      ["numContenedores", "numDeclaraciones", "numDocumentos", "numItems", "tipoCarga", "valorCif"].sort(),
    );
  });

  it("CLASIFICACION: solo numItems, incluso con la capacidad CIF encendida", () => {
    expect([...camposBaseCalculoVisibles(["numItems"], true)]).toEqual(["numItems"]);
  });

  it("intersecta con la capacidad CIF/tarifario: sin ella, oculta valorCif/tipoCarga aunque el tipo los liste", () => {
    const visibles = camposBaseCalculoVisibles(
      ["valorCif", "tipoCarga", "numItems"],
      false,
    );
    expect(visibles.has("valorCif")).toBe(false);
    expect(visibles.has("tipoCarga")).toBe(false);
    expect(visibles.has("numItems")).toBe(true);
  });
});

describe("muestraListaEventos — función pura", () => {
  it("true solo si el tipo los usa Y la empresa tiene la capacidad encendida", () => {
    expect(muestraListaEventos(true, true)).toBe(true);
    expect(muestraListaEventos(false, true)).toBe(false);
    expect(muestraListaEventos(true, false)).toBe(false);
  });

  it("ausente (respuesta vieja) = sin restricción de tipo", () => {
    expect(muestraListaEventos(undefined, true)).toBe(true);
    expect(muestraListaEventos(null, true)).toBe(true);
  });
});

const EVENTO_REVISION: EventoCatalogoRow = {
  codigo: "REVISION_DESPACHO",
  nombre: "Revisión e inventario en despacho",
  descripcion: null,
  documentosRequeridos: ["Fotos de la revisión de la carga"],
  permiteCantidad: false,
};

const REVISION_MARCADA: EventoTramiteRow = {
  codigo: "REVISION_DESPACHO",
  nombre: "Revisión e inventario en despacho",
  cantidad: 1,
  observacion: null,
  marcadoPor: "Camila",
  marcadoAt: "2026-09-24T12:00:00.000Z",
  documentosRequeridos: ["Fotos de la revisión de la carga"],
};

function fotos(recibido: boolean, archivos: number): ChecklistItem {
  return { id: "item-fotos", descripcion: "Fotos de la revisión de la carga", requerido: true, recibido, _count: { documentos: archivos } };
}

describe("SeccionEventosTramite — documentos que exige un evento (revisión 24-sep)", () => {
  beforeEach(() => {
    vi.mocked(fetchEventosCatalogo).mockResolvedValue([EVENTO_REVISION]);
  });

  it("sin marcar: avisa qué pedirá, sin botón de subir", async () => {
    await montar({ checklistItems: [] });

    expect(container.textContent).toContain("Al marcarlo pide: Fotos de la revisión de la carga");
    expect(container.querySelector("[aria-label=\"Subir archivos de Fotos de la revisión de la carga\"]")).toBeNull();
  });

  it("marcada y sin fotos: pide subirlas ahí mismo", async () => {
    vi.mocked(fetchEventosTramite).mockResolvedValue([REVISION_MARCADA]);
    await montar({ checklistItems: [fotos(false, 0)] });

    expect(container.textContent).toContain("Falta 1 documento: súbelo aquí");
    const boton = container.querySelector("[aria-label=\"Subir archivos de Fotos de la revisión de la carga\"]");
    expect(boton?.textContent).toContain("Subir");
    const input = container.querySelector("input[type=file]");
    expect(input?.hasAttribute("multiple")).toBe(true);
  });

  it("con las fotos subidas: completo y muestra cuántas", async () => {
    vi.mocked(fetchEventosTramite).mockResolvedValue([REVISION_MARCADA]);
    await montar({ checklistItems: [fotos(true, 12)] });

    expect(container.textContent).toContain("Documentos completos");
    expect(container.textContent).toContain("12 archivos");
    expect(container.textContent).toContain("Subir más");
  });

  it("el REVISOR ve el estado pero no puede subir (el servidor no se lo permite)", async () => {
    vi.mocked(fetchEventosTramite).mockResolvedValue([REVISION_MARCADA]);
    await act(async () =>
      root.render(
        <RolProvider rol="REVISOR">
          <SeccionEventosTramite tramiteId="tramite-1" clienteId="cliente-1" puedeEditar checklistItems={[fotos(false, 0)]} />
        </RolProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).toContain("Falta 1 documento");
    expect(container.querySelector("input[type=file]")).toBeNull();
  });
});
