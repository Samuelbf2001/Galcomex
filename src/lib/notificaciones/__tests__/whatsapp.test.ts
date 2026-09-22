/**
 * Test unitario de `notificarWhatsApp`. Sin BD y sin red: `fetch` y el cliente
 * Prisma están mockeados, así que se puede verificar exactamente qué se manda a
 * la pasarela y qué queda registrado en AuditLog en cada caso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditLogCreate = vi.fn();
const parametroFindUnique = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    auditLog: { create: auditLogCreate },
    parametro: { findUnique: parametroFindUnique },
  },
}));

const {
  ACCION_AUDIT_NOTIFICACION,
  ENTIDAD_AUDIT_NOTIFICACION,
  enmascararDestino,
  notificarWhatsApp,
  obtenerDestinoWhatsAppCamila,
} = await import("../whatsapp");

const URL_PASARELA = "https://n8n.example.test/webhook/whatsapp";

const CONTEXTO = {
  usuarioId: "usr-1",
  evento: "borrador_devuelto",
  entidad: "BorradorFactura",
  entidadId: "bor-1",
  tramiteId: "tra-1",
  datos: { consecutivo: "DO.BAQ26-0001", cliente: "Litoplas S.A." },
};

let urlPrevia: string | undefined;

beforeEach(() => {
  urlPrevia = process.env.WHATSAPP_WEBHOOK_URL;
  auditLogCreate.mockReset().mockResolvedValue({ id: "audit-1" });
  parametroFindUnique.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (urlPrevia === undefined) delete process.env.WHATSAPP_WEBHOOK_URL;
  else process.env.WHATSAPP_WEBHOOK_URL = urlPrevia;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("notificarWhatsApp", () => {
  it("con destinatario y pasarela: postea { to, text, contexto } y audita el envío", async () => {
    process.env.WHATSAPP_WEBHOOK_URL = URL_PASARELA;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await notificarWhatsApp({
      destino: "+573001234567",
      texto: "Galcomex: se devolvió el borrador",
      contexto: CONTEXTO,
    });

    expect(resultado).toEqual({ enviado: true, status: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_PASARELA);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "+573001234567",
      text: "Galcomex: se devolvió el borrador",
      contexto: CONTEXTO,
    });

    expect(auditLogCreate).toHaveBeenCalledTimes(1);
    const { data } = auditLogCreate.mock.calls[0]![0] as {
      data: { entidad: string; accion: string; despues: Record<string, unknown> };
    };
    expect(data.entidad).toBe(ENTIDAD_AUDIT_NOTIFICACION);
    expect(data.accion).toBe(ACCION_AUDIT_NOTIFICACION);
    expect(data.despues.enviado).toBe(true);
    expect(data.despues.status).toBe(200);
  });

  it("sin destinatario: no llama a la pasarela y audita 'sin destinatario configurado'", async () => {
    process.env.WHATSAPP_WEBHOOK_URL = URL_PASARELA;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await notificarWhatsApp({
      destino: "   ",
      texto: "Galcomex: se devolvió el borrador",
      contexto: CONTEXTO,
    });

    expect(resultado).toEqual({ enviado: false, motivo: "sin destinatario configurado" });
    expect(fetchMock).not.toHaveBeenCalled();

    const { data } = auditLogCreate.mock.calls[0]![0] as {
      data: { despues: Record<string, unknown> };
    };
    expect(data.despues.enviado).toBe(false);
    expect(data.despues.motivo).toBe("sin destinatario configurado");
    expect(data.despues.destino).toBeNull();
  });

  it("sin WHATSAPP_WEBHOOK_URL: no llama a la pasarela y lo deja registrado", async () => {
    delete process.env.WHATSAPP_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resultado = await notificarWhatsApp({
      destino: "+573001234567",
      texto: "Hola",
      contexto: CONTEXTO,
    });

    expect(resultado.enviado).toBe(false);
    expect(resultado).toMatchObject({ motivo: "sin pasarela configurada" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditLogCreate).toHaveBeenCalledTimes(1);
  });

  it("si la pasarela responde error HTTP lo registra y NO lanza", async () => {
    process.env.WHATSAPP_WEBHOOK_URL = URL_PASARELA;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));

    const resultado = await notificarWhatsApp({
      destino: "+573001234567",
      texto: "Hola",
      contexto: CONTEXTO,
    });

    expect(resultado).toEqual({
      enviado: false,
      motivo: "la pasarela respondió con error",
      detalle: "HTTP 502",
    });
    const { data } = auditLogCreate.mock.calls[0]![0] as {
      data: { despues: Record<string, unknown> };
    };
    expect(data.despues.detalle).toBe("HTTP 502");
  });

  it("si el fetch falla (red caída) lo registra y NO lanza", async () => {
    process.env.WHATSAPP_WEBHOOK_URL = URL_PASARELA;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const resultado = await notificarWhatsApp({
      destino: "+573001234567",
      texto: "Hola",
      contexto: CONTEXTO,
    });

    expect(resultado).toEqual({
      enviado: false,
      motivo: "error de transporte",
      detalle: "ECONNREFUSED",
    });
  });

  it("un fallo al auditar no tumba el aviso", async () => {
    process.env.WHATSAPP_WEBHOOK_URL = URL_PASARELA;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    auditLogCreate.mockRejectedValue(new Error("FK usuarioId inválido"));

    await expect(
      notificarWhatsApp({ destino: "+573001234567", texto: "Hola", contexto: CONTEXTO }),
    ).resolves.toEqual({ enviado: true, status: 200 });
  });
});

describe("obtenerDestinoWhatsAppCamila", () => {
  it("devuelve el valor del parámetro cuando está configurado", async () => {
    parametroFindUnique.mockResolvedValue({ valor: " +573001234567 " });
    await expect(obtenerDestinoWhatsAppCamila()).resolves.toBe("+573001234567");
  });

  it("devuelve null con el parámetro vacío o ausente", async () => {
    parametroFindUnique.mockResolvedValue({ valor: "" });
    await expect(obtenerDestinoWhatsAppCamila()).resolves.toBeNull();

    parametroFindUnique.mockResolvedValue(null);
    await expect(obtenerDestinoWhatsAppCamila()).resolves.toBeNull();
  });
});

describe("enmascararDestino", () => {
  it("deja solo el indicativo y los últimos 4 dígitos", () => {
    expect(enmascararDestino("+573001234567")).toBe("+57…4567");
    expect(enmascararDestino("123")).toBe("…");
  });
});
