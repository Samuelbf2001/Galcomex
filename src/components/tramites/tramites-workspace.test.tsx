import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateTramiteDialog, TramitesWorkspace } from "./tramites-workspace";
import {
  fetchClienteOptions,
  fetchRequisitosDo,
  fetchTiposTramiteEmpresa,
  fetchTramitesPage,
  type ClienteOption,
  type DocumentoObligatorioCodigo,
  type RequisitosDo,
  type TipoTramiteOption,
  type TramiteRow,
} from "./tramites-api";

// jsdom no implementa <dialog>.showModal()/close() (ver modal-shell.test.tsx):
// se agrega el mismo polyfill mínimo para poder montar CreateTramiteDialog.
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

let rol: "ADMIN" | "REVISOR" | "OPERATIVO" | "SOCIO" = "ADMIN";

vi.mock("./tramites-api", async (original) => ({
  ...(await original<typeof import("./tramites-api")>()),
  createTramite: vi.fn(),
  fetchClienteOptions: vi.fn(),
  fetchRequisitosDo: vi.fn(),
  fetchTiposTramiteEmpresa: vi.fn(),
  fetchTramitesPage: vi.fn(),
}));
vi.mock("@/lib/auth/rol-context", () => ({
  usePermiso: (roles: string[]) => roles.includes(rol),
  useEsAdmin: () => rol === "ADMIN",
  useRol: () => rol,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  describirError: (error: unknown, fallback?: string) =>
    error instanceof Error ? error.message : (fallback ?? "Error"),
}));

const CLIENTE_LITOPLAS: ClienteOption = {
  id: "cliente-1",
  nombre: "LITOPLAS SA",
  nit: "900123456",
  tipo: "PROPIO",
};

const TIPO_IMPORTACION: TipoTramiteOption = {
  codigo: "IMPORTACION",
  nombre: "Importación",
  descripcion: null,
  prefijoConsecutivo: "DO",
  requiereAgenciaAduanas: true,
  requiereEta: true,
  etiquetaReferenciaExterna: null,
};

function requisitosFixture(
  tarifa: Partial<RequisitosDo["tarifaVigente"]> = {},
  documentosRequeridos: DocumentoObligatorioCodigo[] = [],
): RequisitosDo {
  return {
    tarifaVigente: {
      requerida: true,
      cumple: true,
      lineaServicio: "TRAMITE",
      tarifario: null,
      tarifarioPropioHabilitado: true,
      mensaje: null,
      ...tarifa,
    },
    documentosObligatorios: { requeridos: documentosRequeridos },
  };
}

function filaTramite(id: string): TramiteRow {
  return {
    id,
    doNumber: `DO.BAQ26-000${id}`,
    cliente: "LITOPLAS SA",
    clienteId: "cliente-1",
    estado: "APERTURA",
    ciudad: "BAQ",
    modalidad: "MOVIADUANAS",
    referencia: "-",
    fechaApertura: "01/01/2026",
    ultimoMovimiento: "01/01/2026",
    responsable: "Sin asignar",
    documentosPendientes: null,
    esHistorico: false,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  rol = "ADMIN";
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  vi.mocked(fetchClienteOptions).mockResolvedValue([CLIENTE_LITOPLAS]);
  vi.mocked(fetchTiposTramiteEmpresa).mockResolvedValue({ tipos: [TIPO_IMPORTACION], reglaAgencia: null });
  vi.mocked(fetchTramitesPage).mockResolvedValue({
    rows: [filaTramite("1"), filaTramite("2"), filaTramite("3")],
    total: 60,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montarDialogo() {
  await act(async () => root.render(<CreateTramiteDialog open onClose={vi.fn()} onCreated={vi.fn()} />));
}

async function montarWorkspace() {
  await act(async () => root.render(<TramitesWorkspace />));
}

/** Elige la empresa LITOPLAS (PROPIO) en el select del modal de creación. */
async function elegirClienteLitoplas() {
  const select = container.querySelector<HTMLSelectElement>('select[name="clienteId"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "cliente-1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** El chequeo de requisitos tiene un debounce real de 300ms (ver tramites-workspace.tsx). */
async function esperarRequisitos() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function ultimaLlamadaPagina() {
  const llamadas = vi.mocked(fetchTramitesPage).mock.calls;
  return llamadas[llamadas.length - 1]?.[2];
}

describe("Crear DO — D1 tarifa vigente", () => {
  it("muestra el panel ámbar con el mensaje del servidor y deshabilita 'Crear DO' cuando no cumple", async () => {
    vi.mocked(fetchRequisitosDo).mockResolvedValue(
      requisitosFixture({
        cumple: false,
        tarifarioPropioHabilitado: true,
        mensaje: "LITOPLAS SA no tiene una tarifa vigente de importación.",
      }),
    );

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    expect(container.textContent).toContain("LITOPLAS SA no tiene una tarifa vigente de importación.");
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("no muestra el panel ni deshabilita el envío cuando la tarifa cumple", async () => {
    vi.mocked(fetchRequisitosDo).mockResolvedValue(requisitosFixture({ cumple: true }));

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    expect(container.querySelector('[role="alert"].border-amber-400')).toBeNull();
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("ADMIN ve el enlace 'Crear tarifa' con el href de la empresa cuando el tarifario propio ya está habilitado", async () => {
    vi.mocked(fetchRequisitosDo).mockResolvedValue(
      requisitosFixture({ cumple: false, tarifarioPropioHabilitado: true, mensaje: "Sin tarifa." }),
    );

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    const enlace = [...container.querySelectorAll("a")].find((a) => a.textContent === "Crear tarifa");
    expect(enlace?.getAttribute("href")).toBe("/clientes/cliente-1?abrir=tarifas");
  });

  it("tarifarioPropioHabilitado=false muestra 'Activar «Tarifario propio»' en vez de 'Crear tarifa'", async () => {
    vi.mocked(fetchRequisitosDo).mockResolvedValue(
      requisitosFixture({ cumple: false, tarifarioPropioHabilitado: false, mensaje: "Sin tarifa." }),
    );

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    const enlace = [...container.querySelectorAll("a")].find((a) => a.textContent === "Activar «Tarifario propio»");
    expect(enlace?.getAttribute("href")).toBe("/clientes/cliente-1?abrir=funciones");
    expect(container.textContent).not.toContain("Crear tarifa");
  });

  it("OPERATIVO no ve botones de acción: solo el texto para pedirle a Camila", async () => {
    rol = "OPERATIVO";
    vi.mocked(fetchRequisitosDo).mockResolvedValue(
      requisitosFixture({ cumple: false, tarifarioPropioHabilitado: true, mensaje: "Sin tarifa." }),
    );

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    expect(container.textContent).toContain("Pídele a Camila que publique la tarifa de esta empresa.");
    const haySoloTexto = [...container.querySelectorAll("a")].every(
      (a) => a.textContent !== "Crear tarifa" && a.textContent !== "Activar «Tarifario propio»",
    );
    expect(haySoloTexto).toBe(true);
  });
});

describe("Crear DO — D2 documentos obligatorios", () => {
  it("los documentos obligatorios vienen de 'requeridos', no del tipo de cliente", async () => {
    // CLIENTE_LITOPLAS es PROPIO (no SOCIO_LM): antes de D2 esta empresa nunca
    // pedía BL/factura comercial. Ahora lo decide el servidor.
    vi.mocked(fetchRequisitosDo).mockResolvedValue(
      requisitosFixture({ requerida: false, cumple: true }, ["BL", "FACTURA_COMERCIAL"]),
    );

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    const listas = [...container.querySelectorAll("ul")];
    const listaObligatorios = listas.find((ul) => ul.className.includes("border-rose-200"))!;
    const listaGenerica = listas.find(
      (ul) => ul.className.includes("border-slate-200") && ul.className.includes("bg-white"),
    )!;

    expect(listaObligatorios.textContent).toContain("BL o guía");
    expect(listaObligatorios.textContent).toContain("Factura comercial");
    // No aparecen duplicados en la lista genérica de adjuntos.
    expect(listaGenerica.textContent).not.toContain("BL (Bill of Lading)");
    expect(listaGenerica.textContent).not.toContain("Factura comercial");

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("sin documentos requeridos no aparece la sección de obligatorios", async () => {
    vi.mocked(fetchRequisitosDo).mockResolvedValue(requisitosFixture({ requerida: false, cumple: true }, []));

    await montarDialogo();
    await elegirClienteLitoplas();
    await esperarRequisitos();

    expect(container.textContent).not.toContain("Documentos obligatorios");
  });
});

describe("Trámites — A7 paginación", () => {
  it("pide la primera página con el tamaño por defecto (25)", async () => {
    await montarWorkspace();

    expect(ultimaLlamadaPagina()).toEqual({ take: 25, skip: 0 });
  });

  it("cambiar de página y 'Por página' consultan el take/skip correctos", async () => {
    await montarWorkspace();
    expect(ultimaLlamadaPagina()).toEqual({ take: 25, skip: 0 });

    const siguiente = container.querySelector('button[aria-label="Página siguiente"]') as HTMLButtonElement;
    await act(async () => siguiente.click());
    expect(ultimaLlamadaPagina()).toEqual({ take: 25, skip: 25 });

    const porPagina = container.querySelector<HTMLSelectElement>('nav[aria-label="Paginación"] select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(porPagina, "50");
      porPagina.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Cambiar el tamaño de página también vuelve a la página 1 (Paginacion).
    expect(ultimaLlamadaPagina()).toEqual({ take: 50, skip: 0 });
  });

  it("cambiar un filtro reinicia la página a 1", async () => {
    await montarWorkspace();

    const siguiente = container.querySelector('button[aria-label="Página siguiente"]') as HTMLButtonElement;
    await act(async () => siguiente.click());
    expect(ultimaLlamadaPagina()).toEqual({ take: 25, skip: 25 });

    // Primer <select> del DOM = filtro "Estado" (los de Paginacion van después, en la tabla).
    const estadoSelect = container.querySelectorAll("select")[0] as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(estadoSelect, "EN_TRAMITE");
      estadoSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(ultimaLlamadaPagina()).toEqual({ take: 25, skip: 0 });
  });
});
