// @vitest-environment node
/**
 * Cliente HTTP de Siigo: timeout en cada llamada, token en caché, 429 con
 * Retry-After solo en GET, y el POST de facturas NUNCA se reintenta. `fetch`
 * está mockeado: no sale nada a la red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  esperaTrasRetryAfter,
  getInvoiceById,
  getProductos,
  getToken,
  invalidarTokenSiigo,
  postFactura,
  SiigoApiError,
  SiigoRespuestaInvalidaError,
  TIMEOUT_SIIGO_MS,
  type SiigoFacturaPostDto,
} from "../client";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenOk(expiresIn = 86_400) {
  return json({ access_token: "tok-1", token_type: "Bearer", expires_in: expiresIn });
}

const DTO: SiigoFacturaPostDto = {
  document: { id: 1 },
  date: "2026-09-25",
  customer: { identification: "900123456", branch_office: 0 },
  seller: 2,
  items: [],
  payments: [{ id: 3, value: 1000 }],
  stamp: { send: false },
};

beforeEach(() => {
  process.env.SIIGO_API_USERNAME = "usuario-prueba";
  process.env.SIIGO_API_ACCESS_KEY = "clave-prueba";
  process.env.SIIGO_API_BASE_URL = "https://siigo.invalid";
  invalidarTokenSiigo();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("timeout en cada llamada", () => {
  it("token, GET y POST llevan AbortSignal.timeout(20000)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json({ id: "sg-1", date: "2026-09-25" }))
      .mockResolvedValueOnce(json({ id: "sg-1", name: "FV-2-1", date: "2026-09-25" }));

    const token = await getToken();
    await getInvoiceById(token, "sg-1");
    await postFactura(token, DTO);

    expect(TIMEOUT_SIIGO_MS).toBe(20_000);
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 20_000)).toBe(true);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("si quien llama pasa su propia señal, abortarla corta la llamada", async () => {
    const control = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const promesa = getInvoiceById("tok", "sg-1", { signal: control.signal });
    control.abort(new DOMException("cancelado", "AbortError"));

    await expect(promesa).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("token en caché", () => {
  it("dos llamadas seguidas piden un solo token", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    await expect(getToken()).resolves.toBe("tok-1");
    await expect(getToken()).resolves.toBe("tok-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dos llamadas simultáneas comparten la misma petición", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk());

    const [a, b] = await Promise.all([getToken(), getToken()]);

    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un token que vence dentro del margen no se guarda", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk(60)).mockResolvedValueOnce(tokenOk(60));

    await getToken();
    await getToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("un 401 de Siigo invalida el token guardado", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(tokenOk());

    const token = await getToken();
    await expect(getInvoiceById(token, "sg-1")).rejects.toBeInstanceOf(SiigoApiError);
    await getToken();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("429 con Retry-After (solo GET)", () => {
  it("GET paginado: espera y reintenta tras un 429", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "too many" }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ pagination: { total_results: 0 }, results: [] }));

    await expect(getProductos("tok")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("GET: se rinde tras 3 intentos con 429", async () => {
    fetchMock.mockImplementation(async () => json({ error: "too many" }, 429, { "retry-after": "0" }));

    const err = await getProductos("tok").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiigoApiError);
    expect((err as SiigoApiError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Retry-After: segundos, fecha HTTP, ausente y tope", () => {
    const ahora = Date.parse("2026-09-25T12:00:00Z");
    expect(esperaTrasRetryAfter("3", ahora)).toBe(3_000);
    expect(esperaTrasRetryAfter("600", ahora)).toBe(10_000);
    expect(esperaTrasRetryAfter(null, ahora)).toBe(2_000);
    expect(esperaTrasRetryAfter("Fri, 25 Sep 2026 12:00:04 GMT", ahora)).toBe(4_000);
    expect(esperaTrasRetryAfter("basura", ahora)).toBe(2_000);
  });
});

describe("POST /v1/invoices", () => {
  it("un 429 NO se reintenta: una sola llamada", async () => {
    fetchMock.mockResolvedValue(json({ error: "too many" }, 429, { "retry-after": "0" }));

    const err = await postFactura("tok", DTO).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiigoApiError);
    expect((err as SiigoApiError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("un 500 NO se reintenta", async () => {
    fetchMock.mockResolvedValue(json({ error: "boom" }, 500));

    await expect(postFactura("tok", DTO)).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("2xx completo → id, consecutivo y fecha", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "sg-1", number: 18600, date: "2026-09-25" }, 201));

    await expect(postFactura("tok", DTO)).resolves.toEqual({
      id: "sg-1",
      name: "18600",
      date: "2026-09-25",
    });
  });

  it("2xx sin consecutivo pero con id → SiigoRespuestaInvalidaError con el id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "sg-9", date: "2026-09-25" }, 201));

    const err = await postFactura("tok", DTO).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiigoRespuestaInvalidaError);
    expect((err as SiigoRespuestaInvalidaError).idRecuperado).toBe("sg-9");
  });

  it("2xx sin fecha pero con id → SiigoRespuestaInvalidaError con el id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "sg-9", name: "FV-2-1" }, 201));

    const err = await postFactura("tok", DTO).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiigoRespuestaInvalidaError);
    expect((err as SiigoRespuestaInvalidaError).idRecuperado).toBe("sg-9");
  });

  it("2xx con cuerpo ilegible → SiigoRespuestaInvalidaError sin id", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }));

    const err = await postFactura("tok", DTO).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SiigoRespuestaInvalidaError);
    expect((err as SiigoRespuestaInvalidaError).idRecuperado).toBeNull();
  });
});
