import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { parsearAprobadores } from "../aprobadores";
import {
  definicionPlantillaPse,
  extraerCodigo,
  formatoPesos,
  leerPayloadBoton,
  mensajePlantillaPse,
  parametrosPlantillaPse,
  payloadNoPuedo,
  textoRespuesta,
} from "../catalogo";
import type { KapsoConfig } from "../config";
import { decidirEntrante, type SolicitudRef } from "../decidir";
import { leerEventosKapso, type MensajeEntrante } from "../entrante";
import { verificarFirmaKapso } from "../firma";
import { KapsoEnvioError, enviarWhatsapp } from "../kapso-cliente";
import { normalizarCelular } from "../telefono";

const SOLICITUD_ID = "cmfq3x2a10000abcd1234efgh";

describe("normalizarCelular", () => {
  it("antepone 57 a un móvil local y deja E.164 como está", () => {
    expect(normalizarCelular("300 123 4567")).toBe("573001234567");
    expect(normalizarCelular("+57 300-123-4567")).toBe("573001234567");
    expect(normalizarCelular("573001234567")).toBe("573001234567");
  });
});

describe("parsearAprobadores", () => {
  it("SIN_CONFIGURAR y vacío = nadie recibe", () => {
    expect(parsearAprobadores("SIN_CONFIGURAR")).toEqual({ ok: true, aprobadores: [] });
    expect(parsearAprobadores("  ")).toEqual({ ok: true, aprobadores: [] });
  });

  it("lee Nombre:celular separados por ; y normaliza", () => {
    const r = parsearAprobadores("María Camila:300 123 4567; Guillermo:+57 3009876543");
    expect(r).toEqual({
      ok: true,
      aprobadores: [
        { nombre: "María Camila", telefono: "573001234567" },
        { nombre: "Guillermo", telefono: "573009876543" },
      ],
    });
  });

  it("rechaza formato, fijo, repetido y nombre vacío", () => {
    expect(parsearAprobadores("María Camila 3001234567").ok).toBe(false);
    expect(parsearAprobadores("Oficina:6053001234").ok).toBe(false);
    expect(parsearAprobadores("A:3001234567;B:3001234567").ok).toBe(false);
    expect(parsearAprobadores(":3001234567").ok).toBe(false);
  });
});

describe("verificarFirmaKapso", () => {
  const cuerpo = '{"message":{"id":"wamid.1"}}';
  const firma = createHmac("sha256", "secreto").update(cuerpo).digest("hex");

  it("acepta la firma HMAC hex del cuerpo crudo, con o sin sha256=", () => {
    expect(verificarFirmaKapso(cuerpo, firma, "secreto")).toBe(true);
    expect(verificarFirmaKapso(cuerpo, `sha256=${firma}`, "secreto")).toBe(true);
  });

  it("rechaza secreto distinto, cuerpo alterado, ausencia y basura", () => {
    expect(verificarFirmaKapso(cuerpo, firma, "otro")).toBe(false);
    expect(verificarFirmaKapso(`${cuerpo} `, firma, "secreto")).toBe(false);
    expect(verificarFirmaKapso(cuerpo, null, "secreto")).toBe(false);
    expect(verificarFirmaKapso(cuerpo, "zz", "secreto")).toBe(false);
    expect(verificarFirmaKapso(cuerpo, firma, "")).toBe(false);
  });
});

describe("leerEventosKapso", () => {
  it("texto v2 con línea y cita", () => {
    const eventos = leerEventosKapso({
      phone_number_id: "111",
      message: { id: "wamid.A", from: "573001234567", type: "text", text: { body: "482 913" }, context: { id: "wamid.NUESTRO" } },
      conversation: { phone_number_id: "111" },
    });
    expect(eventos).toEqual([
      { tipo: "mensaje", wamid: "wamid.A", remitente: "573001234567", lineaId: "111", clase: "texto", texto: "482 913", contextoId: "wamid.NUESTRO" },
    ]);
  });

  it("botón de plantilla (type=button) y de sesión (button_reply)", () => {
    const [plantilla] = leerEventosKapso({
      message: { id: "wamid.B", from: "3001234567", type: "button", button: { payload: payloadNoPuedo(SOLICITUD_ID), text: "No puedo ahora" } },
    });
    expect(plantilla).toMatchObject({ clase: "boton", botonPayload: `gx_pse_no_puedo:${SOLICITUD_ID}`, remitente: "573001234567", lineaId: null });

    const [sesion] = leerEventosKapso({
      message: { id: "wamid.C", from: "573001234567", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "gx_x", title: "X" } } },
    });
    expect(sesion).toMatchObject({ clase: "boton", botonPayload: "gx_x" });
  });

  it("lote v2 y acuses (v2 y Meta cruda) con motivo de fallo", () => {
    const lote = leerEventosKapso({
      batch: true,
      data: [
        { message: { id: "wamid.D", from: "573001234567", type: "text", text: { body: "hola" } } },
        { message: { id: "wamid.E", kapso: { direction: "outbound", status: "delivered" } } },
        { message: { id: "wamid.F", kapso: { direction: "outbound", status: "failed", statuses: [{ errors: [{ code: 131047, title: "Re-engagement message" }] }] } } },
      ],
    });
    expect(lote.map((e) => e.tipo)).toEqual(["mensaje", "acuse", "acuse"]);
    expect(lote[1]).toMatchObject({ estado: "ENTREGADO" });
    expect(lote[2]).toMatchObject({ estado: "FALLIDO", motivo: "131047 · Re-engagement message" });

    const meta = leerEventosKapso({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "222" },
        messages: [{ id: "wamid.G", from: "573009876543", type: "text", text: { body: "123456" } }],
        statuses: [{ id: "wamid.H", status: "read" }],
      } }] }],
    });
    expect(meta).toEqual([
      { tipo: "mensaje", wamid: "wamid.G", remitente: "573009876543", lineaId: "222", clase: "texto", texto: "123456", contextoId: undefined },
      { tipo: "acuse", wamid: "wamid.H", estado: "LEIDO", lineaId: "222" },
    ]);
  });

  it("basura no produce eventos", () => {
    expect(leerEventosKapso(null)).toEqual([]);
    expect(leerEventosKapso({ foo: 1 })).toEqual([]);
    expect(leerEventosKapso({ message: { id: "x" } })).toEqual([]);
  });
});

describe("catálogo", () => {
  it("extraerCodigo acepta dígitos y alfanuméricos con al menos un número", () => {
    expect(extraerCodigo(" 482 913 ")).toBe("482913");
    expect(extraerCodigo("482-913")).toBe("482913");
    expect(extraerCodigo("e11027")).toBe("E11027");
    expect(extraerCodigo("gracias")).toBeNull();
    expect(extraerCodigo("123")).toBeNull();
    expect(extraerCodigo("el código es 482913")).toBeNull();
  });

  it("payload de botón: solo el nuestro y con id válido", () => {
    expect(leerPayloadBoton(payloadNoPuedo(SOLICITUD_ID))).toEqual({ accion: "NO_PUEDO", solicitudId: SOLICITUD_ID });
    expect(leerPayloadBoton("gx_pse_no_puedo:")).toBeNull();
    expect(leerPayloadBoton("gx_otro:abc")).toBeNull();
    expect(leerPayloadBoton(`gx_pse_no_puedo:${SOLICITUD_ID}:extra`)).toBeNull();
  });

  it("formatoPesos con separador de miles", () => {
    expect(formatoPesos(4233902n)).toBe("$4.233.902");
    expect(formatoPesos(0n)).toBe("$0");
  });

  it("parámetros de la plantilla limpios (sin vacíos ni saltos de línea)", () => {
    expect(
      parametrosPlantillaPse({ nombreAprobador: "María\nCamila", operador: "", consecutivo: "DO.BAQ26-0142", beneficiario: null, valor: null }),
    ).toEqual(["María Camila", "El equipo de Galcomex", "DO.BAQ26-0142", "Sin especificar", "Sin especificar"]);
  });

  it("envío de plantilla: 5 variables, quick reply con id y botón URL con el token", () => {
    const cuerpo = mensajePlantillaPse({
      to: "573001234567",
      plantilla: "galcomex_codigo_pse",
      idioma: "es",
      solicitudId: SOLICITUD_ID,
      token: "abc123",
      datos: { nombreAprobador: "María Camila", operador: "Karina", consecutivo: "DO.BAQ26-0142", beneficiario: "Almacarga", valor: 4233902n },
    });
    expect(cuerpo.type).toBe("template");
    const [body, rapido, url] = cuerpo.template.components;
    expect(body.parameters.map((p) => ("text" in p ? p.text : ""))).toEqual(["María Camila", "Karina", "DO.BAQ26-0142", "Almacarga", "$4.233.902"]);
    expect(rapido).toEqual({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `gx_pse_no_puedo:${SOLICITUD_ID}` }] });
    expect(url).toEqual({ type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "abc123" }] });
  });

  it("la definición de Meta cuadra con el envío: 5 variables y los botones en el mismo orden", () => {
    const def = definicionPlantillaPse("galcomex_codigo_pse", "es", "https://galcomex.sixteam.pro");
    const body = def.components[0] as { text: string; example: { body_text: string[][] } };
    expect(body.text.match(/\{\{\d\}\}/g)).toEqual(["{{1}}", "{{2}}", "{{3}}", "{{4}}", "{{5}}"]);
    expect(body.example.body_text[0]).toHaveLength(5);
    const botones = (def.components[1] as { buttons: Array<{ type: string; url?: string }> }).buttons;
    expect(botones.map((b) => b.type)).toEqual(["QUICK_REPLY", "URL"]);
    expect(botones[1].url).toBe("https://galcomex.sixteam.pro/pse/{{1}}");
  });

  it("todas las respuestas tienen texto", () => {
    for (const tipo of ["PSE_RECIBIDO", "PSE_NO_PUEDO_OK", "PSE_YA_ATENDIDA", "PSE_CERRADA", "PSE_FORMATO", "PSE_AMBIGUA", "PSE_SIN_SOLICITUD"] as const) {
      expect(textoRespuesta(tipo, { consecutivos: ["A", "B"] }).length).toBeGreaterThan(10);
    }
    expect(textoRespuesta("PSE_RECIBIDO", { nombre: "Camila", consecutivo: "DO.BAQ26-0142", operador: "Karina" })).toBe(
      "Listo, Camila. Recibimos el código del DO DO.BAQ26-0142 y Karina ya lo tiene en pantalla.",
    );
  });
});

describe("decidirEntrante", () => {
  const camila = { nombre: "María Camila", telefono: "573001234567" };
  const abierta: SolicitudRef = { id: SOLICITUD_ID, consecutivo: "DO.BAQ26-0142", estado: "ABIERTA", respondidaPor: null, operador: "Karina" };
  const otra: SolicitudRef = { ...abierta, id: "cmfq3x2a10000zzzz9999yyyy", consecutivo: "DO.BAQ26-0150" };
  const texto = (t: string, contextoId?: string): MensajeEntrante => ({
    tipo: "mensaje", wamid: "w", remitente: camila.telefono, lineaId: null, clase: "texto", texto: t, contextoId,
  });
  const boton = (payload: string): MensajeEntrante => ({
    tipo: "mensaje", wamid: "w", remitente: camila.telefono, lineaId: null, clase: "boton", botonPayload: payload,
  });

  it("a un número que no es aprobador no se le responde nunca", () => {
    expect(decidirEntrante({ mensaje: texto("482913"), aprobador: null, referida: abierta, abiertas: [abierta] })).toEqual({
      accion: "IGNORAR", motivo: "remitente_no_aprobador",
    });
  });

  it("código con una sola solicitud abierta → se guarda", () => {
    expect(decidirEntrante({ mensaje: texto("482 913"), aprobador: camila, referida: null, abiertas: [abierta] })).toEqual({
      accion: "GUARDAR_CODIGO", solicitud: abierta, codigo: "482913",
    });
  });

  it("con varias abiertas: sin cita pide citar; con cita va a la citada", () => {
    expect(decidirEntrante({ mensaje: texto("482913"), aprobador: camila, referida: null, abiertas: [abierta, otra] })).toMatchObject({
      accion: "RESPONDER", respuesta: "PSE_AMBIGUA", datos: { consecutivos: ["DO.BAQ26-0142", "DO.BAQ26-0150"] },
    });
    expect(decidirEntrante({ mensaje: texto("482913", "wamid.otra"), aprobador: camila, referida: otra, abiertas: [abierta, otra] })).toEqual({
      accion: "GUARDAR_CODIGO", solicitud: otra, codigo: "482913",
    });
  });

  it("texto que no es código: corrige si hay algo abierto, calla si no", () => {
    expect(decidirEntrante({ mensaje: texto("ya va"), aprobador: camila, referida: null, abiertas: [abierta] })).toMatchObject({ respuesta: "PSE_FORMATO" });
    expect(decidirEntrante({ mensaje: texto("gracias"), aprobador: camila, referida: null, abiertas: [] })).toMatchObject({ accion: "IGNORAR" });
    expect(decidirEntrante({ mensaje: texto("482913"), aprobador: camila, referida: null, abiertas: [] })).toMatchObject({ respuesta: "PSE_SIN_SOLICITUD" });
    // Llegó tarde: otro aprobador ya respondió la solicitud reciente.
    const yaRespondida = { ...abierta, estado: "RESPONDIDA" as const, respondidaPor: "Guillermo" };
    expect(decidirEntrante({ mensaje: texto("482913"), aprobador: camila, referida: null, abiertas: [], reciente: yaRespondida })).toMatchObject({
      respuesta: "PSE_YA_ATENDIDA", datos: { quien: "Guillermo" },
    });
  });

  it("código a una solicitud ya respondida o cerrada", () => {
    const respondida = { ...abierta, estado: "RESPONDIDA" as const, respondidaPor: "Guillermo" };
    expect(decidirEntrante({ mensaje: texto("482913", "w1"), aprobador: camila, referida: respondida, abiertas: [] })).toMatchObject({
      respuesta: "PSE_YA_ATENDIDA", datos: { quien: "Guillermo" },
    });
    expect(decidirEntrante({ mensaje: texto("482913", "w1"), aprobador: camila, referida: { ...abierta, estado: "CERRADA" }, abiertas: [] })).toMatchObject({
      respuesta: "PSE_CERRADA",
    });
  });

  it("botones: el nuestro marca no-puedo; uno ajeno o sin solicitud se ignora", () => {
    expect(decidirEntrante({ mensaje: boton(payloadNoPuedo(SOLICITUD_ID)), aprobador: camila, referida: abierta, abiertas: [abierta] })).toEqual({
      accion: "NO_PUEDO", solicitud: abierta,
    });
    expect(decidirEntrante({ mensaje: boton("Continuar"), aprobador: camila, referida: null, abiertas: [abierta] })).toEqual({
      accion: "IGNORAR", motivo: "boton_ajeno",
    });
    expect(decidirEntrante({ mensaje: boton(payloadNoPuedo(SOLICITUD_ID)), aprobador: camila, referida: null, abiertas: [] })).toEqual({
      accion: "IGNORAR", motivo: "solicitud_inexistente",
    });
  });
});

describe("enviarWhatsapp", () => {
  const config: KapsoConfig = {
    apiKey: "k", phoneNumberId: "111", webhookSecret: "s", baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
    plantillaPse: "galcomex_codigo_pse", idiomaPlantilla: "es", webhookToken: null, timeoutMs: 1000,
  };
  const cuerpo = { messaging_product: "whatsapp", to: "573001234567", type: "text", text: { body: "hola" } };

  it("POST al proxy con X-API-Key y devuelve el wamid", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    await expect(enviarWhatsapp(config, cuerpo, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ wamid: "wamid.OK" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/111/messages");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("k");
    expect((init.headers as Record<string, string>)["X-Gateway-Espera-Respuesta"]).toBeUndefined();
  });

  it("con espera de respuesta manda el header de afinidad de la pasarela", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    await enviarWhatsapp(config, cuerpo, { fetchImpl: fetchImpl as unknown as typeof fetch, esperaRespuestaSegundos: 1800 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Gateway-Espera-Respuesta"]).toBe("1800");
  });

  it("error de Meta → código sin datos personales, y una sola llamada (sin reintentos)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 131047, message: "to 573001234567" } }), { status: 400 }));
    const promesa = enviarWhatsapp(config, cuerpo, { fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(promesa).rejects.toBeInstanceOf(KapsoEnvioError);
    await expect(promesa).rejects.toMatchObject({ codigo: "KAPSO_HTTP_400_131047" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
