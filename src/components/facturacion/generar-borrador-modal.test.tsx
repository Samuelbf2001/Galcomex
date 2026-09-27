/**
 * Modal "Generar borrador" (Facturación) con tarifario propio.
 *
 * Bug 24-sep: el modal arrancaba con comisión 150.000 y SIEMPRE la mandaba en
 * el POST; como `generarBorrador` solo usa el tarifario cuando NO llega
 * comisión, una empresa con tarifario (Litoplas) salía con una línea de
 * 150.000 en vez de los valores del tarifario. Aquí se fija que:
 * - con propuesta vigente, se muestra la propuesta y el POST va SIN comisión;
 * - con pendientes, no se genera y se enlaza a la base de cálculo del DO;
 * - "Usar otra comisión" es la única forma de mandar comisión a mano;
 * - sin tarifario propio (Lucho y demás), todo sigue como antes (150.000).
 *
 * Pulido tras la revisión (hallazgos 1-6, 24-sep):
 * 1. el POST con tarifario dice cuál espera (`usarTarifario` + `tarifarioId`);
 *    un 409 del servidor se muestra y ofrece volver a consultar;
 * 3. "Usar otra comisión" mantiene visibles los pendientes y exige confirmar
 *    "Voy a facturar sin los valores del tarifario";
 * 4. cada pendiente enlaza a donde se arregla (DO / pago o factura / tarifario);
 * 5. se listan los conceptos "a mano, si aplica" (y el tarifario solo-MANUAL);
 * 6. tras fallar la consulta, a mano se puede volver a intentar y, si la
 *    empresa no tiene tarifario propio, arranca en 150.000.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BorradorRow, TramiteParaFacturacion } from "@/components/facturacion/facturacion-api";
import type { PropuestaTarifaRow } from "@/components/tramites/eventos-api";

vi.mock("@/components/facturacion/facturacion-api", async (original) => ({
  ...(await original<typeof import("@/components/facturacion/facturacion-api")>()),
  generarBorrador: vi.fn(),
}));
vi.mock("@/components/tramites/eventos-api", () => ({
  fetchPropuestaTarifa: vi.fn(),
}));
vi.mock("@/components/clientes/capacidades-api", () => ({
  fetchCapacidades: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  describirError: (error: unknown, fallback?: string) =>
    error instanceof Error ? error.message : (fallback ?? "Error"),
}));

import type { CapacidadRow } from "@/components/clientes/capacidades-api";
import { fetchCapacidades } from "@/components/clientes/capacidades-api";
import { FacturacionApiError, generarBorrador } from "@/components/facturacion/facturacion-api";
import { fetchPropuestaTarifa } from "@/components/tramites/eventos-api";

import { GenerarBorradorModal, gruposDePendientes, modoComisionDe } from "./generar-borrador-modal";

// jsdom no implementa <dialog>.showModal()/close(): polyfill mínimo (igual que modal-shell.test).
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

const TRAMITE: TramiteParaFacturacion = {
  id: "tramite-1",
  consecutivo: "DO.BAQ26-0101",
  estado: "ENVIADO_A_FACTURAR",
  eta: null,
  flujoCorto: false,
  cliente: { id: "cliente-1", nombre: "LITOPLAS", nit: "800000001" },
  ordenCompraNumero: null,
  ordenCompraValor: null,
  borradores: [],
};

const CONTEXTO: PropuestaTarifaRow["contexto"] = {
  valorCif: "300000000",
  tipoCarga: "CONTENEDOR_20",
  numContenedores: 1,
  numDeclaraciones: 1,
  numDocumentos: null,
  numItems: null,
  ordenCompraNumero: null,
  ordenCompraValor: null,
  eventos: [],
};

const TARIFARIO = {
  id: "tarifario-1",
  nombre: "Tarifas 2026 importaciones",
  version: 2,
  alcance: "TRAMITE",
  vigenteDesde: "2026-01-01T00:00:00.000Z",
  vigenteHasta: "2026-12-31T00:00:00.000Z",
};

function linea(concepto: string, nombrePublico: string, valor: string) {
  return {
    concepto,
    nombrePublico,
    siigoCodigo: `S-${concepto}`,
    cantidad: 1,
    valorUnitario: valor,
    valor,
    aplicaIva: true,
    origen: "SIEMPRE" as const,
    detalle: "Valor fijo por trámite",
  };
}

const PROPUESTA_TARIFARIO: PropuestaTarifaRow = {
  tarifario: TARIFARIO,
  motivo: null,
  tarifarioPropio: true,
  resultado: {
    lineas: [
      linea("GASTOS_TRAMITE", "Gastos de trámite", "380000"),
      linea("SISTEMATIZACION", "Sistematización", "95000"),
    ],
    pendientes: [],
    manuales: [],
    total: "475000",
    totalConIva: "565250",
  },
  contexto: CONTEXTO,
};

const PROPUESTA_CON_PENDIENTES: PropuestaTarifaRow = {
  ...PROPUESTA_TARIFARIO,
  resultado: {
    ...PROPUESTA_TARIFARIO.resultado!,
    lineas: [linea("SISTEMATIZACION", "Sistematización", "95000")],
    pendientes: [
      {
        concepto: "AGENCIAMIENTO",
        nombrePublico: "Agenciamiento aduanero",
        motivo: "Falta el valor CIF",
        causa: "BASE_DO",
      },
    ],
    total: "95000",
  },
};

const PROPUESTA_SIN_TARIFARIO_PROPIO: PropuestaTarifaRow = {
  tarifario: null,
  motivo: "LUCHO no tiene habilitado el tarifario propio",
  tarifarioPropio: false,
  resultado: null,
  contexto: CONTEXTO,
};

const PROPUESTA_SIN_VIGENTE: PropuestaTarifaRow = {
  tarifario: null,
  motivo: "LITOPLAS no tiene un tarifario vigente para tramite en esta fecha",
  tarifarioPropio: true,
  resultado: null,
  contexto: CONTEXTO,
};

const PROPUESTA_PENDIENTES_MIXTOS: PropuestaTarifaRow = {
  ...PROPUESTA_TARIFARIO,
  resultado: {
    ...PROPUESTA_TARIFARIO.resultado!,
    pendientes: [
      { concepto: "AGE", nombrePublico: "Agenciamiento aduanero", motivo: "Falta el valor CIF", causa: "BASE_DO" },
      {
        concepto: "BODEGAJE",
        nombrePublico: "Bodegaje",
        motivo: 'No hay un pago o factura de proveedor que contenga "BODEGAJE"',
        causa: "COSTO_PROVEEDOR",
      },
      { concepto: "MANEJO", nombrePublico: "Manejo de carga", motivo: "El ítem no tiene tramos configurados", causa: "TARIFARIO" },
    ],
  },
};

const PROPUESTA_CON_MANUALES: PropuestaTarifaRow = {
  ...PROPUESTA_TARIFARIO,
  resultado: {
    ...PROPUESTA_TARIFARIO.resultado!,
    manuales: [
      { concepto: "HORAS_EXTRA", nombrePublico: "Horas extra" },
      { concepto: "RECONOCIMIENTO", nombrePublico: "Reconocimiento previo" },
    ],
  },
};

const PROPUESTA_SOLO_MANUALES: PropuestaTarifaRow = {
  ...PROPUESTA_TARIFARIO,
  resultado: {
    ...PROPUESTA_TARIFARIO.resultado!,
    lineas: [],
    pendientes: [],
    manuales: [{ concepto: "HORAS_EXTRA", nombrePublico: "Horas extra" }],
    total: "0",
    totalConIva: "0",
  },
};

function capacidadTarifario(habilitado: boolean): CapacidadRow[] {
  return [
    {
      codigo: "tarifario_propio",
      nombre: "Tarifario propio",
      descripcion: "",
      grupo: "Facturación",
      habilitado,
      config: null,
      porDefecto: false,
      origenHabilitado: "EMPRESA",
      origenConfig: "DEFECTO",
      tieneOverride: true,
    },
  ];
}

const BORRADOR = { id: "borrador-1", totalFactura: "1000000" } as unknown as BorradorRow;

let container: HTMLDivElement;
let root: Root;
let onGenerado: ReturnType<typeof vi.fn<(borrador: BorradorRow) => void>>;

async function montar(propuesta: PropuestaTarifaRow | Error) {
  if (propuesta instanceof Error) vi.mocked(fetchPropuestaTarifa).mockRejectedValue(propuesta);
  else vi.mocked(fetchPropuestaTarifa).mockResolvedValue(propuesta);
  onGenerado = vi.fn<(borrador: BorradorRow) => void>();
  await act(async () => {
    root.render(<GenerarBorradorModal tramite={TRAMITE} onClose={vi.fn()} onGenerado={onGenerado} />);
  });
}

function boton(texto: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto);
}

function botonQueContiene(texto: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));
}

function enlace(texto: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.textContent?.includes(texto));
}

async function confirmarSinTarifario() {
  const check = container.querySelector<HTMLInputElement>('[data-testid="confirma-sin-tarifario"]')!;
  await act(async () => check.click());
}

function botonEnviar(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

function campoComision(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="Comisión Galcomex/LM (COP)"]');
}

async function escribir(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enviar() {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generarBorrador).mockResolvedValue(BORRADOR);
  vi.mocked(fetchCapacidades).mockResolvedValue(capacidadTarifario(true));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("modoComisionDe", () => {
  it("tarifario vigente con líneas → TARIFARIO", () => {
    expect(modoComisionDe(PROPUESTA_TARIFARIO)).toBe("TARIFARIO");
  });
  it("tarifario vigente solo con pendientes → TARIFARIO (el servidor bloquearía)", () => {
    expect(
      modoComisionDe({
        ...PROPUESTA_CON_PENDIENTES,
        resultado: { ...PROPUESTA_CON_PENDIENTES.resultado!, lineas: [] },
      }),
    ).toBe("TARIFARIO");
  });
  it("tarifario vigente sin líneas ni pendientes → SIN_VIGENTE (el servidor usaría la comisión)", () => {
    expect(
      modoComisionDe({
        ...PROPUESTA_TARIFARIO,
        resultado: { ...PROPUESTA_TARIFARIO.resultado!, lineas: [], total: "0" },
      }),
    ).toBe("SIN_VIGENTE");
  });
  it("función encendida sin tarifario vigente → SIN_VIGENTE", () => {
    expect(modoComisionDe(PROPUESTA_SIN_VIGENTE)).toBe("SIN_VIGENTE");
  });
  it("sin la función tarifario_propio → SIN_TARIFARIO", () => {
    expect(modoComisionDe(PROPUESTA_SIN_TARIFARIO_PROPIO)).toBe("SIN_TARIFARIO");
  });
});

describe("GenerarBorradorModal — empresa con tarifario vigente", () => {
  it("muestra los conceptos del tarifario con sus valores y el total, sin campo de comisión", async () => {
    await montar(PROPUESTA_TARIFARIO);
    const texto = container.textContent ?? "";
    expect(texto).toContain("Tarifario Tarifas 2026 importaciones v2");
    expect(texto).toContain("Gastos de trámite");
    expect(texto).toContain("Sistematización");
    expect(container.querySelector('[data-testid="total-tarifario"]')?.textContent).toMatch(/475\.000/);
    expect(campoComision()).toBeNull();
    expect(texto).not.toContain("150.000");
    expect(botonEnviar().textContent).toContain("Generar con el tarifario");
    expect(botonEnviar().disabled).toBe(false);
  });

  it("genera el borrador SIN comisión ni conceptos (el servidor usa el tarifario)", async () => {
    await montar(PROPUESTA_TARIFARIO);
    await enviar();
    expect(generarBorrador).toHaveBeenCalledTimes(1);
    const [tramiteId, input] = vi.mocked(generarBorrador).mock.calls[0];
    expect(tramiteId).toBe("tramite-1");
    expect(input.comision).toBeUndefined();
    expect(input.conceptosOperacionales).toBeUndefined();
    expect(input.retenciones).toBe("0");
    // Hallazgo 1: dice qué tarifario espera; el servidor nunca cae a 150.000.
    expect(input.usarTarifario).toBe(true);
    expect(input.tarifarioId).toBe("tarifario-1");
    // Y el total que vio el revisor: si al generar da otro, el servidor responde 409.
    expect(input.totalTarifario).toBe("475000");
    expect(onGenerado).toHaveBeenCalledWith(BORRADOR);
  });

  it("si el servidor ya no aplica ese tarifario (409), lo dice y ofrece volver a consultarlo", async () => {
    await montar(PROPUESTA_TARIFARIO);
    vi.mocked(generarBorrador).mockRejectedValueOnce(
      new FacturacionApiError(
        "No se generó el borrador: el tarifario cambió mientras revisabas; ahora rige Tarifas 2027 v3.",
        409,
      ),
    );
    await enviar();
    expect(onGenerado).not.toHaveBeenCalled();
    expect(container.textContent).toContain("el tarifario cambió mientras revisabas");
    expect(vi.mocked(fetchPropuestaTarifa)).toHaveBeenCalledTimes(1);

    await act(async () => botonQueContiene("Volver a consultar el tarifario")!.click());
    expect(vi.mocked(fetchPropuestaTarifa)).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("el tarifario cambió mientras revisabas");
  });

  it("otros errores del servidor no ofrecen reconsultar el tarifario", async () => {
    await montar(PROPUESTA_TARIFARIO);
    vi.mocked(generarBorrador).mockRejectedValueOnce(new FacturacionApiError("Trámite cerrado", 422));
    await enviar();
    expect(container.textContent).toContain("Trámite cerrado");
    expect(botonQueContiene("Volver a consultar el tarifario")).toBeUndefined();
  });

  it("lista los conceptos del tarifario que van a mano, si aplica (hallazgo 5)", async () => {
    await montar(PROPUESTA_CON_MANUALES);
    expect(container.querySelector('[data-testid="manuales-tarifario"]')?.textContent).toContain(
      "A mano, si aplica: Horas extra, Reconocimiento previo.",
    );
  });

  it("'Usar otra comisión' pasa a comisión a mano (vacía, sin 150.000) y la manda", async () => {
    await montar(PROPUESTA_TARIFARIO);
    await act(async () => boton("Usar otra comisión")!.click());
    const campo = campoComision();
    expect(campo).not.toBeNull();
    expect(campo!.value).toBe("");
    expect(container.textContent).toContain("sin los valores del tarifario");

    // Vacía: no se manda nada.
    await enviar();
    expect(generarBorrador).not.toHaveBeenCalled();

    await escribir(campo!, "200000");
    // Hallazgo 3: sin la confirmación explícita no se manda.
    expect(botonEnviar().disabled).toBe(true);
    await enviar();
    expect(generarBorrador).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirma que vas a facturar sin los valores del tarifario");

    await confirmarSinTarifario();
    expect(botonEnviar().disabled).toBe(false);
    await enviar();
    expect(generarBorrador).toHaveBeenCalledTimes(1);
    const input = vi.mocked(generarBorrador).mock.calls[0][1];
    expect(input.comision).toBe("200000");
    expect(input.usarTarifario).toBeUndefined();
    expect(input.tarifarioId).toBeUndefined();
  });

  it("'Volver al tarifario' deshace el modo manual y vuelve a generar sin comisión", async () => {
    await montar(PROPUESTA_TARIFARIO);
    await act(async () => boton("Usar otra comisión")!.click());
    await escribir(campoComision()!, "200000");
    await act(async () => boton("Volver al tarifario")!.click());
    expect(campoComision()).toBeNull();
    await enviar();
    expect(vi.mocked(generarBorrador).mock.calls[0][1].comision).toBeUndefined();
  });
});

describe("GenerarBorradorModal — tarifario con pendientes en la base de cálculo", () => {
  it("lista los pendientes, enlaza a la base de cálculo del DO y no deja generar", async () => {
    await montar(PROPUESTA_CON_PENDIENTES);
    const texto = container.textContent ?? "";
    expect(texto).toContain("Faltan datos para calcular un concepto del tarifario");
    expect(texto).toContain("Agenciamiento aduanero");
    expect(texto).toContain("Falta el valor CIF");
    const enlace = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Completar la base de cálculo"),
    );
    expect(enlace?.getAttribute("href")).toBe("/tramites/tramite-1?tab=resumen");
    expect(botonEnviar().disabled).toBe(true);

    await enviar();
    expect(generarBorrador).not.toHaveBeenCalled();
  });

  it("aun con pendientes, 'Usar otra comisión' permite facturar a mano con confirmación, sin esconder la lista", async () => {
    await montar(PROPUESTA_CON_PENDIENTES);
    await act(async () => boton("Usar otra comisión")!.click());
    // Hallazgo 3: la lista sigue a la vista en modo manual.
    const pendientes = container.querySelector('[data-testid="pendientes-tarifario"]');
    expect(pendientes?.textContent).toContain("Agenciamiento aduanero");
    expect(pendientes?.textContent).toContain("Si facturas a mano, estos conceptos no quedan en la factura.");
    expect(container.textContent).toContain("Voy a facturar sin los valores del tarifario");
    await escribir(campoComision()!, "300000");
    expect(botonEnviar().disabled).toBe(true);
    await confirmarSinTarifario();
    expect(botonEnviar().disabled).toBe(false);
    await enviar();
    expect(vi.mocked(generarBorrador).mock.calls[0][1].comision).toBe("300000");
  });

  it("cada pendiente enlaza a donde se arregla: DO, pago o factura de proveedor, tarifario (hallazgo 4)", async () => {
    await montar(PROPUESTA_PENDIENTES_MIXTOS);
    expect(container.textContent).toContain("Faltan datos para calcular 3 conceptos del tarifario");
    const grupo = (causa: string) => container.querySelector(`[data-causa="${causa}"]`);
    expect(grupo("BASE_DO")?.textContent).toContain("Agenciamiento aduanero");
    expect(grupo("BASE_DO")?.querySelector("a")?.getAttribute("href")).toBe("/tramites/tramite-1?tab=resumen");
    expect(grupo("COSTO_PROVEEDOR")?.textContent).toContain("Bodegaje");
    expect([...grupo("COSTO_PROVEEDOR")!.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/tramites/tramite-1?tab=pagos",
      "/tramites/tramite-1?tab=facturas-proveedor",
    ]);
    expect(grupo("TARIFARIO")?.textContent).toContain("Manejo de carga");
    expect(enlace("Corregir el tarifario de la empresa")?.getAttribute("href")).toBe(
      "/clientes/cliente-1?abrir=tarifas",
    );
    // El enlace a la base de cálculo solo acompaña a lo que falta del DO.
    expect(grupo("TARIFARIO")?.textContent).not.toContain("Completar la base de cálculo");
    expect(botonEnviar().disabled).toBe(true);
  });
});

describe("GenerarBorradorModal — empresa SIN tarifario propio (Lucho y demás): sin cambios", () => {
  it("arranca con 150.000 y lo manda como siempre", async () => {
    await montar(PROPUESTA_SIN_TARIFARIO_PROPIO);
    expect(campoComision()!.value).toBe("150.000");
    expect(container.textContent).toContain("Default: $150.000");
    expect(boton("Usar otra comisión")).toBeUndefined();
    expect(container.textContent).not.toContain("no tiene habilitado el tarifario propio");
    await enviar();
    const input = vi.mocked(generarBorrador).mock.calls[0][1];
    expect(input.comision).toBe("150000");
    expect(input.conceptosOperacionales).toBeUndefined();
  });

  it("el desglose de conceptos sigue exigiendo que sumen la comisión", async () => {
    await montar(PROPUESTA_SIN_TARIFARIO_PROPIO);
    const check = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => check.click());
    const nombre = container.querySelector<HTMLInputElement>('input[placeholder="Nombre del concepto"]')!;
    const valor = container.querySelector<HTMLInputElement>('input[placeholder="Valor"]')!;
    await escribir(nombre, "Sistematización");
    await escribir(valor, "100000");
    expect(container.textContent).toContain("debe igualar la comisión");
    expect(botonEnviar().disabled).toBe(true);
    await escribir(valor, "150000");
    await enviar();
    expect(vi.mocked(generarBorrador).mock.calls[0][1]).toMatchObject({
      comision: "150000",
      conceptosOperacionales: [{ concepto: "Sistematización", valor: "150000" }],
    });
  });
});

describe("GenerarBorradorModal — función encendida sin tarifario vigente", () => {
  it("avisa, enlaza al tarifario de la empresa y exige escribir la comisión (sin 150.000)", async () => {
    await montar(PROPUESTA_SIN_VIGENTE);
    expect(container.textContent).toContain("no tiene un tarifario vigente");
    const enlace = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("revisa el tarifario"),
    );
    expect(enlace?.getAttribute("href")).toBe("/clientes/cliente-1?abrir=tarifas");
    expect(campoComision()!.value).toBe("");
    await enviar();
    expect(generarBorrador).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Escribe la comisión");
  });
});

describe("gruposDePendientes", () => {
  it("un pendiente sin causa (servidor viejo) cuenta como base de cálculo del DO", () => {
    const grupos = gruposDePendientes(
      [{ concepto: "X", nombrePublico: "X", motivo: "Falta algo" }],
      TRAMITE,
    );
    expect(grupos.map((g) => g.causa)).toEqual(["BASE_DO"]);
  });
});

describe("GenerarBorradorModal — tarifario solo con conceptos a mano", () => {
  it("lo dice y pide la comisión a mano (hallazgo 5)", async () => {
    await montar(PROPUESTA_SOLO_MANUALES);
    expect(container.textContent).toContain(
      "El tarifario Tarifas 2026 importaciones v2 solo tiene conceptos que se cobran a mano (Horas extra).",
    );
    expect(campoComision()!.value).toBe("");
    expect(container.textContent).not.toContain("Default: $150.000");
  });
});

describe("GenerarBorradorModal — falla la consulta del tarifario", () => {
  it("no genera a ciegas: ofrece reintentar o escribir la comisión a mano", async () => {
    await montar(new Error("Error 500"));
    expect(container.textContent).toContain("No se pudo consultar el tarifario");
    expect(botonEnviar().disabled).toBe(true);
    expect(campoComision()).toBeNull();

    vi.mocked(fetchPropuestaTarifa).mockResolvedValue(PROPUESTA_TARIFARIO);
    await act(async () => boton("Reintentar")!.click());
    expect(container.textContent).toContain("Tarifario Tarifas 2026 importaciones v2");
  });

  it("'Escribir la comisión a mano' habilita el campo vacío si la empresa tiene tarifario propio y exige confirmar (hallazgo 5 de la revisión final)", async () => {
    await montar(new Error("Error 500"));
    await act(async () => boton("Escribir la comisión a mano")!.click());
    expect(campoComision()!.value).toBe("");
    expect(container.textContent).not.toContain("Default: $150.000");
    await escribir(campoComision()!, "180000");
    // Sin confirmar no se genera: la empresa factura por tarifario.
    expect(botonEnviar().disabled).toBe(true);
    await enviar();
    expect(generarBorrador).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirma que vas a facturar sin los valores del tarifario.");
    // Con el error no hay tarifario al que volver: solo «Volver a intentar».
    expect(boton("Volver al tarifario")).toBeUndefined();

    await confirmarSinTarifario();
    expect(botonEnviar().disabled).toBe(false);
    await enviar();
    const input = vi.mocked(generarBorrador).mock.calls[0][1];
    expect(input.comision).toBe("180000");
    expect(input.usarTarifario).toBeUndefined();
  });

  it("si tampoco se sabe si tiene tarifario propio, la comisión arranca vacía y también exige confirmar", async () => {
    vi.mocked(fetchCapacidades).mockRejectedValue(new Error("Error 500"));
    await montar(new Error("Error 500"));
    await act(async () => boton("Escribir la comisión a mano")!.click());
    expect(campoComision()!.value).toBe("");
    await escribir(campoComision()!, "150000");
    expect(botonEnviar().disabled).toBe(true);
    await confirmarSinTarifario();
    await enviar();
    expect(vi.mocked(generarBorrador).mock.calls[0][1].comision).toBe("150000");
  });

  it("empresa SIN tarifario propio (Lucho): a mano arranca en 150.000 como antes (hallazgo 6)", async () => {
    vi.mocked(fetchCapacidades).mockResolvedValue(capacidadTarifario(false));
    await montar(new Error("Error 500"));
    expect(fetchCapacidades).toHaveBeenCalledWith("cliente-1", expect.anything());
    await act(async () => boton("Escribir la comisión a mano")!.click());
    expect(campoComision()!.value).toBe("150.000");
    expect(container.textContent).toContain("Default: $150.000");
    expect(container.textContent).toContain("La empresa no factura por tarifario");
    // Seguro que NO factura por tarifario: sin casilla de confirmación.
    expect(container.querySelector('[data-testid="confirma-sin-tarifario"]')).toBeNull();
    await enviar();
    expect(vi.mocked(generarBorrador).mock.calls[0][1].comision).toBe("150000");
  });

  it("a mano tras el error, ofrece volver a intentar con el tarifario (hallazgo 6)", async () => {
    await montar(new Error("Error 500"));
    await act(async () => boton("Escribir la comisión a mano")!.click());
    expect(container.textContent).toContain("sin haber visto el tarifario");

    vi.mocked(fetchPropuestaTarifa).mockResolvedValue(PROPUESTA_TARIFARIO);
    await act(async () => botonQueContiene("Volver a intentar con el tarifario")!.click());
    expect(container.textContent).toContain("Tarifario Tarifas 2026 importaciones v2");
    expect(campoComision()).toBeNull();
    await enviar();
    const input = vi.mocked(generarBorrador).mock.calls[0][1];
    expect(input.comision).toBeUndefined();
    expect(input.usarTarifario).toBe(true);
  });
});
