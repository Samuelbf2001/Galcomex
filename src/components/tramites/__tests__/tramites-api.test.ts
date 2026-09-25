/**
 * F1 (fase 1 del plan "una sola Empresa"): el selector de cliente del
 * formulario de trámites debe pedirle a `GET /api/clientes` solo empresas
 * marcadas como CLIENTE — una empresa solo-proveedor (ALMACARGA, EXPRESS
 * LOGISTICA) no puede aparecer aquí. Sin BD: `fetch` mockeado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchClienteOptions } from "../tramites-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClienteOptions (selector de cliente de trámites)", () => {
  it("pide GET /api/clientes?rol=cliente", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ clientes: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchClienteOptions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/clientes?rol=cliente");
  });
});
