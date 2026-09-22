import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { procesar } = vi.hoisted(() => ({
  procesar: vi.fn(async () => [{ wamid: "wamid.A", resultado: "procesado:codigo" }]),
}));
vi.mock("@/lib/whatsapp/pse-service", () => ({ procesarWebhookKapso: procesar }));

import { POST } from "../route";

const SECRETO = "secreto-de-prueba";
const cuerpo = JSON.stringify({ message: { id: "wamid.A", from: "573001234567", type: "text", text: { body: "482913" } } });
const firmar = (texto: string, secreto = SECRETO) => createHmac("sha256", secreto).update(texto).digest("hex");

function peticion(texto: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/whatsapp/kapso", { method: "POST", body: texto, headers });
}

describe("POST /api/whatsapp/kapso", () => {
  beforeEach(() => {
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "111";
    process.env.KAPSO_WEBHOOK_SECRET = SECRETO;
    delete process.env.KAPSO_WEBHOOK_TOKEN;
    procesar.mockClear();
  });
  afterEach(() => {
    delete process.env.KAPSO_API_KEY;
    delete process.env.KAPSO_PHONE_NUMBER_ID;
    delete process.env.KAPSO_WEBHOOK_SECRET;
    delete process.env.KAPSO_WEBHOOK_TOKEN;
  });

  it("503 con el canal sin configurar (nunca procesa a medias)", async () => {
    delete process.env.KAPSO_WEBHOOK_SECRET;
    const r = await POST(peticion(cuerpo, { "x-webhook-signature": firmar(cuerpo) }));
    expect(r.status).toBe(503);
    expect(procesar).not.toHaveBeenCalled();
  });

  it("401 sin firma o con firma de otro secreto", async () => {
    expect((await POST(peticion(cuerpo))).status).toBe(401);
    expect((await POST(peticion(cuerpo, { "x-webhook-signature": firmar(cuerpo, "otro") }))).status).toBe(401);
    expect(procesar).not.toHaveBeenCalled();
  });

  it("firma válida → procesa y responde 200", async () => {
    const r = await POST(peticion(cuerpo, { "x-webhook-signature": firmar(cuerpo) }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, eventos: 1 });
    expect(procesar).toHaveBeenCalledTimes(1);
  });

  it("con KAPSO_WEBHOOK_TOKEN exige además el header fijo", async () => {
    process.env.KAPSO_WEBHOOK_TOKEN = "cerrojo";
    const firma = { "x-webhook-signature": firmar(cuerpo) };
    expect((await POST(peticion(cuerpo, firma))).status).toBe(401);
    expect((await POST(peticion(cuerpo, { ...firma, "x-galcomex-token": "cerrojo" }))).status).toBe(200);
  });

  it("413 si el cuerpo supera 100 KB", async () => {
    const grande = JSON.stringify({ relleno: "x".repeat(110_000) });
    const r = await POST(peticion(grande, { "x-webhook-signature": firmar(grande) }));
    expect(r.status).toBe(413);
  });

  it("503 si el procesamiento revienta (Kapso reintenta)", async () => {
    procesar.mockRejectedValueOnce(new Error("BD caída"));
    const r = await POST(peticion(cuerpo, { "x-webhook-signature": firmar(cuerpo) }));
    expect(r.status).toBe(503);
  });
});
