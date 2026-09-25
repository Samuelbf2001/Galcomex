import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDashboard, type CarteraHistoricaResumen, type DashboardApiData } from "./dashboard-api";
import { DashboardWorkspace } from "./dashboard-workspace";

vi.mock("./dashboard-api", async (original) => ({
  ...(await original<typeof import("./dashboard-api")>()),
  fetchDashboard: vi.fn(),
}));

const TITULO = "Cartera histórica 2026 (cobros aún no cargados)";

function historica(activa: boolean): CarteraHistoricaResumen {
  return activa
    ? {
        activa: true,
        titulo: TITULO,
        cantidadFacturas: 3,
        cantidadACargo: 2,
        totalACargo: "47468751",
        totalAFavor: "8058882",
        porCliente: [
          { clienteId: "c-1", clienteNombre: "SESDERMA", facturas: 2, totalACargo: "47468751", totalAFavor: "0", saldoNeto: "-47468751" },
          { clienteId: "c-2", clienteNombre: "LITOPLAS", facturas: 1, totalACargo: "0", totalAFavor: "8058882", saldoNeto: "8058882" },
        ],
      }
    : { activa: false, titulo: "", cantidadFacturas: 0, cantidadACargo: 0, totalACargo: "0", totalAFavor: "0", porCliente: [] };
}

function datos(carteraHistorica: CarteraHistoricaResumen): DashboardApiData {
  return {
    dosActivos: 1,
    dosPorEstado: [],
    pendientesFacturar: [],
    cantidadPendientesFacturar: 0,
    cantidadPendientesConAlerta: 0,
    carteraVencida: [],
    cantidadFacturasVencidas: 0,
    totalCarteraVencida: "0",
    anticiposConSaldo: { cantidad: 0, totalRestante: "0" },
    actividadReciente: [],
    alertasCartera: [],
    cantidadPagosSinComprobante: 0,
    carteraHistorica,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function montar() {
  await act(async () => root.render(<DashboardWorkspace />));
}

describe("DashboardWorkspace — D0: cartera histórica aparte", () => {
  it("activa: muestra la tarjeta, la sección con su título, la nota y el total; la vencida dice «sin la cartera histórica»", async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(datos(historica(true)));
    await montar();

    const texto = container.textContent ?? "";
    expect(texto).toContain("Cartera histórica 2026");
    expect(texto).toContain("2 facturas · cobros aún no cargados");
    const titulos = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
    expect(titulos).toContain(TITULO);
    expect(texto).toContain("No es deuda confirmada");
    expect(texto).toContain("SESDERMA");
    expect(texto).toContain("LITOPLAS");
    expect(texto).toContain("sin la cartera histórica");
  });

  it("inactiva (CARTERA_HISTORICA_APARTE = NO): no hay tarjeta ni sección, y la vencida no lo menciona", async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(datos(historica(false)));
    await montar();

    const texto = container.textContent ?? "";
    expect(texto).not.toContain("Cartera histórica 2026");
    expect(texto).not.toContain("sin la cartera histórica");
    expect(Array.from(container.querySelectorAll("h2")).map((h) => h.textContent)).not.toContain(TITULO);
  });
});
