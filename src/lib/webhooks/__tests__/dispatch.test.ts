/**
 * Tests de dispatch.ts — sin red real: `fetch` global queda mockeado en
 * todos los casos. Cubre las reglas críticas de negocio del dispatcher:
 * sin URL configurada es no-op silencioso, sin secreto no se envía sin
 * firmar, un webhook fallido no lanza (nunca puede tumbar al caller), y el
 * request saliente lleva las cabeceras de firma/timestamp esperadas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchWebhookEvent, enviarWebhookFirmado } from "../dispatch";
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from "../signature";

const SECRETO = "secreto-de-test";
const URL_DESTINO = "https://n8n.example.test/webhook/galcomex";

describe("enviarWebhookFirmado", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("no-op silencioso si no hay URL configurada — no llama a fetch", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await enviarWebhookFirmado({
      url: undefined,
      secreto: SECRETO,
      body: "{}",
      etiqueta: "test.evento",
    });

    expect(result).toEqual({ ok: false, motivo: "sin_url" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("no envía sin secreto configurado (no manda sin firmar) — no llama a fetch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await enviarWebhookFirmado({
      url: URL_DESTINO,
      secreto: undefined,
      body: "{}",
      etiqueta: "test.evento",
    });

    expect(result).toEqual({ ok: false, motivo: "sin_secreto" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("envía firmado con las cabeceras esperadas cuando hay URL y secreto", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const body = JSON.stringify({ hola: "mundo" });

    const result = await enviarWebhookFirmado({
      url: URL_DESTINO,
      secreto: SECRETO,
      body,
      etiqueta: "test.evento",
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(URL_DESTINO);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);

    const headers = init.headers as Record<string, string>;
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
  });

  it("propaga http_error sin lanzar cuando el destino responde con error", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await enviarWebhookFirmado({
      url: URL_DESTINO,
      secreto: SECRETO,
      body: "{}",
      etiqueta: "test.evento",
    });

    expect(result).toEqual({ ok: false, motivo: "http_error", status: 500 });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("nunca lanza si fetch rechaza (falla de red) — la operación de negocio no se tumba", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      enviarWebhookFirmado({ url: URL_DESTINO, secreto: SECRETO, body: "{}", etiqueta: "test.evento" }),
    ).resolves.toMatchObject({ ok: false, motivo: "error_red" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("nunca loguea el secreto ni la firma completa", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await enviarWebhookFirmado({ url: URL_DESTINO, secreto: SECRETO, body: "{}", etiqueta: "test.evento" });

    const todasLasLlamadas = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat();
    for (const arg of todasLasLlamadas) {
      const texto = typeof arg === "string" ? arg : JSON.stringify(arg);
      expect(texto).not.toContain(SECRETO);
    }
  });
});

describe("dispatchWebhookEvent", () => {
  const ENV_BACKUP = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...ENV_BACKUP };
  });

  it("es no-op (sin lanzar) si WEBHOOK_N8N_URL no está configurada", async () => {
    delete process.env.WEBHOOK_N8N_URL;
    process.env.WEBHOOK_SECRET = SECRETO;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchWebhookEvent("cartera.vencida", {
      clienteId: "cli_1",
      clienteNombre: "Cliente Test",
      saldoNetoAcumulado: "-21000000",
      deuda: "21000000",
      umbral: "20000000",
    });

    expect(result).toEqual({ ok: false, motivo: "sin_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("construye el sobre {evento, emitidoEn, data} y lo firma cuando hay URL y secreto", async () => {
    process.env.WEBHOOK_N8N_URL = URL_DESTINO;
    process.env.WEBHOOK_SECRET = SECRETO;

    const result = await dispatchWebhookEvent("do.creado", {
      tramiteId: "tr_1",
      consecutivo: "DO.CTG26-0124",
      clienteId: "cli_1",
      clienteNombre: "Cliente Test",
      ciudad: "CTG",
      agenciaAduanas: "MOVIADUANAS",
      creadoPorId: "user_1",
      createdAt: "2026-08-18T12:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as { evento: string; emitidoEn: string; data: unknown };
    expect(sentBody.evento).toBe("do.creado");
    expect(typeof sentBody.emitidoEn).toBe("string");
    expect(sentBody.data).toMatchObject({ consecutivo: "DO.CTG26-0124" });
  });
});
