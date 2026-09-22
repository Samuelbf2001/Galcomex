import "dotenv/config";

import { AgenciaAduanas, Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// La llave de cifrado se lee al cargar el módulo: tiene que existir antes de los imports.
const { enviados } = vi.hoisted(() => {
  process.env.PSE_ENCRYPTION_KEY = "a".repeat(64);
  process.env.KAPSO_API_KEY = "k-vitest";
  process.env.KAPSO_PHONE_NUMBER_ID = "999000111";
  process.env.KAPSO_WEBHOOK_SECRET = "s-vitest";
  process.env.NEXT_PUBLIC_APP_URL = "https://galcomex.test";
  return { enviados: [] as Array<{ to: string; type: string; wamid: string; cuerpo: Record<string, unknown>; espera?: number }> };
});

// Nada sale a la red: el envío devuelve un wamid falso y queda registrado.
vi.mock("../kapso-cliente", async (original) => {
  const real = await original<typeof import("../kapso-cliente")>();
  return {
    ...real,
    enviarWhatsapp: vi.fn(async (_config: unknown, cuerpo: { to: string; type: string }, opciones?: { esperaRespuestaSegundos?: number }) => {
      const wamid = `wamid.vitest.${enviados.length + 1}.${Date.now()}`;
      enviados.push({ to: cuerpo.to, type: cuerpo.type, wamid, cuerpo: cuerpo as unknown as Record<string, unknown>, espera: opciones?.esperaRespuestaSegundos });
      return { wamid };
    }),
  };
});

import { prisma } from "@/lib/db/prisma";

import { CLAVE_APROBADORES_PSE } from "../aprobadores";
import { payloadNoPuedo } from "../catalogo";
import { kapsoConfig } from "../config";
import { estadoSolicitudPse, procesarWebhookKapso, solicitarCodigoPse } from "../pse-service";

const PREFIJO = "vitest-whatsapp";
const runId = `${PREFIJO}-${Date.now()}`;
const CAMILA = "573001110001";
const GUILLERMO = "573001110002";
const EXTRANO = "573009990000";

let db = false;
let motivo = "BD no disponible";
let parametroOriginal: string | null = null;
let userId = "";
let clienteId = "";
let tramiteId = "";
let wamidEntrante = 0;

function entrante(from: string, message: Record<string, unknown>, linea = "999000111") {
  wamidEntrante += 1;
  return { phone_number_id: linea, message: { id: `wamid.in.${runId}.${wamidEntrante}`, from, ...message } };
}

async function limpiar() {
  await prisma.whatsappEntrante.deleteMany({ where: { wamid: { contains: runId } } });
  await prisma.auditLog.deleteMany({ where: { usuarioId: userId || "__" } });
  await prisma.tramiteDO.deleteMany({ where: { comentarios: { startsWith: PREFIJO } } });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: PREFIJO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIJO } } });
}

describe("pse-service contra Postgres", () => {
  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch (error) {
      motivo = error instanceof Error ? error.message : String(error);
      return;
    }
    await limpiar();
    const actual = await prisma.parametro.findUnique({ where: { clave: CLAVE_APROBADORES_PSE } });
    parametroOriginal = actual?.valor ?? null;
    await prisma.parametro.upsert({
      where: { clave: CLAVE_APROBADORES_PSE },
      update: { valor: `María Camila:${CAMILA.slice(2)}; Guillermo:${GUILLERMO.slice(2)}` },
      create: { clave: CLAVE_APROBADORES_PSE, valor: `María Camila:${CAMILA.slice(2)}; Guillermo:${GUILLERMO.slice(2)}` },
    });
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, name: "Karina", rol: Rol.OPERATIVO, emailVerified: true },
    });
    userId = user.id;
    const cliente = await prisma.cliente.create({ data: { nombre: "Cliente WhatsApp", nit: `${PREFIJO}-${runId}`, tipo: TipoCliente.PROPIO } });
    clienteId = cliente.id;
    const tramite = await prisma.tramiteDO.create({
      data: {
        consecutivo: `DO.BAQ99-${runId}`,
        ciudad: Ciudad.BAQ,
        anio: 3099,
        numero: Math.floor(Math.random() * 1_000_000),
        clienteId,
        agenciaAduanas: AgenciaAduanas.COLDEX,
        creadoPorId: userId,
        comentarios: `${PREFIJO}:${runId}`,
      },
    });
    tramiteId = tramite.id;
  });

  afterAll(async () => {
    if (db) {
      await limpiar();
      if (parametroOriginal === null) await prisma.parametro.deleteMany({ where: { clave: CLAVE_APROBADORES_PSE } });
      else await prisma.parametro.update({ where: { clave: CLAVE_APROBADORES_PSE }, data: { valor: parametroOriginal } });
    }
    await prisma.$disconnect();
  });

  beforeEach((ctx) => {
    if (!db) ctx.skip(motivo);
    enviados.length = 0;
  });

  const config = () => {
    const c = kapsoConfig();
    if (!c) throw new Error("config de prueba incompleta");
    return c;
  };

  const pedir = () =>
    solicitarCodigoPse({
      tramiteId,
      consecutivo: `DO.BAQ99-${runId}`,
      usuarioId: userId,
      operador: "Karina",
      valor: 4233902n,
      beneficiario: "Almacarga",
      concepto: "Almacenaje",
    });

  it("pedir el código: una plantilla por aprobador, enlace absoluto y auditoría", async () => {
    const r = await pedir();
    expect(r.whatsapp.estado).toBe("ENVIADO");
    expect(r.whatsapp.envios.map((e) => e.nombre)).toEqual(["María Camila", "Guillermo"]);
    expect(r.enlace).toMatch(/^https:\/\/galcomex\.test\/pse\/[0-9a-f]{64}$/);
    // Se envían en paralelo: el orden de llegada no es contrato.
    expect(enviados.map((e) => [e.to, e.type]).sort()).toEqual([[CAMILA, "template"], [GUILLERMO, "template"]]);
    // La plantilla reclama las respuestas sin cita durante la vigencia (afinidad en la pasarela).
    expect(enviados.every((e) => e.espera === 1800)).toBe(true);

    const mensajes = await prisma.whatsappMensaje.findMany({ where: { pseSolicitudId: r.solicitudId } });
    expect(mensajes.every((m) => m.estado === "ENVIADO" && m.wamid)).toBe(true);
    expect(await prisma.auditLog.count({ where: { entidad: "PseSolicitud", entidadId: r.solicitudId } })).toBe(1);
  });

  it("una solicitud nueva del mismo DO anula la anterior; su botón ya no cuenta", async () => {
    const vieja = await pedir();
    const nueva = await pedir();
    const filaVieja = await prisma.pseSolicitud.findUniqueOrThrow({ where: { id: vieja.solicitudId } });
    expect(filaVieja.anuladaAt).not.toBeNull();

    enviados.length = 0;
    const [res] = await procesarWebhookKapso(
      entrante(CAMILA, { type: "button", button: { payload: payloadNoPuedo(vieja.solicitudId), text: "No puedo ahora" } }),
      config(),
    );
    expect(res.resultado).toBe("procesado:pse_cerrada");
    expect(enviados).toHaveLength(1);
    expect((await prisma.pseSolicitud.findUniqueOrThrow({ where: { id: nueva.solicitudId } })).noPuedeAt).toBeNull();
  });

  it("Camila responde el código: se guarda cifrado, el operario lo ve y ella recibe confirmación", async () => {
    const r = await pedir();
    enviados.length = 0;
    const [res] = await procesarWebhookKapso(entrante(CAMILA, { type: "text", text: { body: "482 913" } }), config());
    expect(res.resultado).toBe("procesado:codigo");

    const fila = await prisma.pseSolicitud.findUniqueOrThrow({ where: { id: r.solicitudId } });
    expect(fila.codigoPseEnc).not.toContain("482913");
    expect(fila).toMatchObject({ respondidaPor: "María Camila", canal: "WHATSAPP" });

    const estado = await estadoSolicitudPse(tramiteId);
    expect(estado).toMatchObject({ ready: true, codigo: "482913", respondidaPor: "María Camila", canal: "WHATSAPP" });
    expect(estado.envios.find((e) => e.nombre === "María Camila")?.respuesta).toBe("CODIGO");

    expect(enviados).toHaveLength(1);
    expect(enviados[0].to).toBe(CAMILA);
    expect(enviados[0].espera).toBeUndefined(); // la confirmación no reclama afinidad
    expect(JSON.stringify(enviados[0].cuerpo)).toContain("Karina ya lo tiene en pantalla");

    // Guillermo llega tarde: se le dice quién ya lo mandó y el código no cambia.
    enviados.length = 0;
    const [tarde] = await procesarWebhookKapso(entrante(GUILLERMO, { type: "text", text: { body: "111222" } }), config());
    expect(tarde.resultado).toBe("procesado:pse_ya_atendida");
    expect(JSON.stringify(enviados[0].cuerpo)).toContain("Ese código ya lo envió María Camila");
    const [tardeConCodigo] = await procesarWebhookKapso(
      entrante(GUILLERMO, {
        type: "text",
        text: { body: "111222" },
        context: { id: (await prisma.whatsappMensaje.findFirstOrThrow({ where: { pseSolicitudId: r.solicitudId, destinatario: GUILLERMO } })).wamid },
      }),
      config(),
    );
    expect(tardeConCodigo.resultado).toBe("procesado:pse_ya_atendida");
    expect((await estadoSolicitudPse(tramiteId)).codigo).toBe("482913");
  });

  it("la misma entrega dos veces se procesa una sola vez", async () => {
    await pedir();
    enviados.length = 0;
    const evento = entrante(CAMILA, { type: "text", text: { body: "555666" } });
    const [primera] = await procesarWebhookKapso(evento, config());
    const [segunda] = await procesarWebhookKapso(evento, config());
    expect(primera.resultado).toBe("procesado:codigo");
    expect(segunda.resultado).toBe("ignorado:duplicado");
    expect(enviados).toHaveLength(1);
  });

  it("aislamiento: número ajeno y otra línea no reciben nada ni tocan nada", async () => {
    await pedir();
    enviados.length = 0;
    const [ajeno] = await procesarWebhookKapso(entrante(EXTRANO, { type: "text", text: { body: "123456" } }), config());
    const [otraLinea] = await procesarWebhookKapso(entrante(CAMILA, { type: "text", text: { body: "123456" } }, "555000"), config());
    expect(ajeno.resultado).toBe("ignorado:remitente_no_aprobador");
    expect(otraLinea.resultado).toBe("ignorado:otra_linea");
    expect(enviados).toHaveLength(0);
    expect((await estadoSolicitudPse(tramiteId)).ready).toBe(false);
    // El cuerpo del mensaje nunca se guarda.
    const fila = await prisma.whatsappEntrante.findUniqueOrThrow({ where: { wamid: ajeno.wamid } });
    expect(JSON.stringify(fila)).not.toContain("123456");
  });

  it("'No puedo ahora' avisa al operario; el texto sin código se corrige", async () => {
    const r = await pedir();
    enviados.length = 0;
    const [noPuedo] = await procesarWebhookKapso(
      entrante(GUILLERMO, { type: "button", button: { payload: payloadNoPuedo(r.solicitudId), text: "No puedo ahora" } }),
      config(),
    );
    expect(noPuedo.resultado).toBe("procesado:no_puedo");
    const estado = await estadoSolicitudPse(tramiteId);
    expect(estado.noPuede?.por).toBe("Guillermo");
    expect(estado.envios.find((e) => e.nombre === "Guillermo")?.respuesta).toBe("NO_PUEDO");

    const [formato] = await procesarWebhookKapso(entrante(CAMILA, { type: "text", text: { body: "ya voy" } }), config());
    expect(formato.resultado).toBe("procesado:pse_formato");
  });

  it("acuses: suben de estado en orden y un 'failed' tardío no pisa un 'leído'", async () => {
    const r = await pedir();
    const msg = await prisma.whatsappMensaje.findFirstOrThrow({ where: { pseSolicitudId: r.solicitudId, destinatario: CAMILA } });
    const acuse = (status: string) => ({ phone_number_id: "999000111", message: { id: msg.wamid, kapso: { direction: "outbound", status } } });

    await procesarWebhookKapso(acuse("read"), config());
    const [viejo] = await procesarWebhookKapso(acuse("delivered"), config());
    const [falla] = await procesarWebhookKapso(acuse("failed"), config());
    expect(viejo.resultado).toBe("ignorado:acuse_viejo");
    expect(falla.resultado).toBe("ignorado:acuse_viejo");
    expect((await prisma.whatsappMensaje.findUniqueOrThrow({ where: { id: msg.id } })).estado).toBe("LEIDO");
  });
});
