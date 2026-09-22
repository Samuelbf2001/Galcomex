import { Prisma } from "@prisma/client";

import { prisma as db } from "@/lib/db/prisma";
import { decryptPseCode, encryptPseCode, generatePseToken } from "@/lib/crypto/pse";

import { CLAVE_APROBADORES_PSE, aprobadorPorTelefono, parsearAprobadores, type Aprobador } from "./aprobadores";
import { mensajePlantillaPse, mensajeTexto, leerPayloadBoton, textoRespuesta, type TipoRespuesta, type DatosRespuesta } from "./catalogo";
import { kapsoConfig, urlPublicaApp, type KapsoConfig } from "./config";
import { decidirEntrante, type Decision, type SolicitudRef } from "./decidir";
import { leerEventosKapso, type AcuseEntrega, type MensajeEntrante } from "./entrante";
import { KapsoEnvioError, enviarWhatsapp, type CuerpoCloudApi } from "./kapso-cliente";

/** El enlace vive 30 minutos (vigencia estándar de una sesión PSE). */
export const VIGENCIA_SOLICITUD_MS = 30 * 60 * 1000;

export type EstadoEnvio = "PENDIENTE" | "ENVIADO" | "ENTREGADO" | "LEIDO" | "FALLIDO";
export type EstadoCanal = "ENVIADO" | "PARCIAL" | "FALLIDO" | "NO_CONFIGURADO" | "SIN_APROBADORES";

export interface EnvioResumen {
  nombre: string;
  estado: EstadoEnvio;
  error: string | null;
  respuesta: string | null;
}

// ─── Aprobadores ─────────────────────────────────────────────────────────────

export async function cargarAprobadoresPse(): Promise<Aprobador[]> {
  const fila = await db.parametro.findUnique({ where: { clave: CLAVE_APROBADORES_PSE }, select: { valor: true } });
  if (!fila) return [];
  const resultado = parsearAprobadores(fila.valor);
  if (!resultado.ok) {
    // El PATCH del parámetro ya valida el formato; esto solo cubre un valor escrito por fuera.
    console.error("[whatsapp] WHATSAPP_APROBADORES_PSE inválido:", resultado.error);
    return [];
  }
  return resultado.aprobadores;
}

// ─── Salida: pedir el código ─────────────────────────────────────────────────

export interface SolicitarCodigoInput {
  tramiteId: string;
  consecutivo: string;
  usuarioId: string;
  operador: string;
  valor: bigint | null;
  beneficiario: string | null;
  concepto: string | null;
}

export interface SolicitarCodigoResultado {
  solicitudId: string;
  enlace: string;
  expiresAt: Date;
  whatsapp: { estado: EstadoCanal; envios: EnvioResumen[] };
}

export async function solicitarCodigoPse(input: SolicitarCodigoInput): Promise<SolicitarCodigoResultado> {
  const token = generatePseToken();
  const ahora = new Date();
  const expiresAt = new Date(ahora.getTime() + VIGENCIA_SOLICITUD_MS);

  const solicitud = await db.$transaction(async (tx) => {
    // Una sola solicitud viva por trámite: la nueva reemplaza a las anteriores,
    // así un código tardío nunca se pega al pago equivocado.
    await tx.pseSolicitud.updateMany({
      where: { tramiteId: input.tramiteId, respondidaAt: null, anuladaAt: null, expiresAt: { gt: ahora } },
      data: { anuladaAt: ahora },
    });
    const creada = await tx.pseSolicitud.create({
      data: {
        tramiteId: input.tramiteId,
        token,
        solicitadoPor: input.usuarioId,
        expiresAt,
        valor: input.valor,
        beneficiario: input.beneficiario,
        concepto: input.concepto,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        entidad: "PseSolicitud",
        entidadId: creada.id,
        accion: "CREATE",
        usuarioId: input.usuarioId,
        tramiteId: input.tramiteId,
        despues: {
          valor: input.valor?.toString() ?? null,
          beneficiario: input.beneficiario,
          concepto: input.concepto,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });
    return creada;
  });

  const enlace = `${urlPublicaApp()}/pse/${token}`;
  const base = { solicitudId: solicitud.id, enlace, expiresAt };

  const config = kapsoConfig();
  if (!config) return { ...base, whatsapp: { estado: "NO_CONFIGURADO", envios: [] } };
  const aprobadores = await cargarAprobadoresPse();
  if (aprobadores.length === 0) return { ...base, whatsapp: { estado: "SIN_APROBADORES", envios: [] } };

  // Destinatarios distintos: se puede enviar en paralelo (el límite de Kapso es por destinatario).
  const envios = await Promise.all(
    aprobadores.map((aprobador) =>
      enviarRegistrado(config, {
        tipo: "PSE_CODIGO",
        pseSolicitudId: solicitud.id,
        aprobador,
        // Mientras la solicitud vive, un código escrito sin citar vuelve a Galcomex.
        esperaRespuestaSegundos: VIGENCIA_SOLICITUD_MS / 1000,
        cuerpo: mensajePlantillaPse({
          to: aprobador.telefono,
          plantilla: config.plantillaPse,
          idioma: config.idiomaPlantilla,
          solicitudId: solicitud.id,
          token,
          datos: {
            nombreAprobador: aprobador.nombre,
            operador: input.operador,
            consecutivo: input.consecutivo,
            beneficiario: input.beneficiario,
            valor: input.valor,
          },
        }),
      }),
    ),
  );

  const ok = envios.filter((e) => e.estado !== "FALLIDO").length;
  const estado: EstadoCanal = ok === envios.length ? "ENVIADO" : ok === 0 ? "FALLIDO" : "PARCIAL";
  return { ...base, whatsapp: { estado, envios } };
}

/** Registra el mensaje, lo envía y deja el resultado. Nunca lanza. */
async function enviarRegistrado(
  config: KapsoConfig,
  m: { tipo: string; pseSolicitudId: string | null; aprobador: Aprobador; cuerpo: CuerpoCloudApi; esperaRespuestaSegundos?: number },
): Promise<EnvioResumen> {
  const registro = await db.whatsappMensaje.create({
    data: {
      tipo: m.tipo,
      pseSolicitudId: m.pseSolicitudId,
      destinatario: m.aprobador.telefono,
      nombreDestino: m.aprobador.nombre,
    },
    select: { id: true },
  });
  try {
    const { wamid } = await enviarWhatsapp(config, m.cuerpo, { esperaRespuestaSegundos: m.esperaRespuestaSegundos });
    await db.whatsappMensaje.update({ where: { id: registro.id }, data: { wamid, estado: "ENVIADO" } });
    return { nombre: m.aprobador.nombre, estado: "ENVIADO", error: null, respuesta: null };
  } catch (error) {
    const codigo = error instanceof KapsoEnvioError ? error.codigo : "KAPSO_ERROR";
    await db.whatsappMensaje.update({ where: { id: registro.id }, data: { estado: "FALLIDO", error: codigo } });
    return { nombre: m.aprobador.nombre, estado: "FALLIDO", error: codigo, respuesta: null };
  }
}

// ─── Estado para el operario (polling) ───────────────────────────────────────

export interface EstadoSolicitudPse {
  ready: boolean;
  codigo?: string;
  respondidaPor: string | null;
  canal: string | null;
  noPuede: { por: string | null; at: Date } | null;
  expiresAt: Date | null;
  envios: EnvioResumen[];
}

export async function estadoSolicitudPse(tramiteId: string): Promise<EstadoSolicitudPse> {
  const solicitud = await db.pseSolicitud.findFirst({
    where: { tramiteId, anuladaAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: {
      codigoPseEnc: true,
      respondidaAt: true,
      respondidaPor: true,
      canal: true,
      noPuedeAt: true,
      noPuedePor: true,
      expiresAt: true,
      mensajes: {
        where: { tipo: "PSE_CODIGO" },
        orderBy: { createdAt: "asc" },
        select: { nombreDestino: true, estado: true, error: true, respuesta: true },
      },
    },
  });
  if (!solicitud) {
    return { ready: false, respondidaPor: null, canal: null, noPuede: null, expiresAt: null, envios: [] };
  }
  const envios: EnvioResumen[] = solicitud.mensajes.map((m) => ({
    nombre: m.nombreDestino ?? "Aprobador",
    estado: m.estado as EstadoEnvio,
    error: m.error,
    respuesta: m.respuesta,
  }));
  const noPuede = solicitud.noPuedeAt ? { por: solicitud.noPuedePor, at: solicitud.noPuedeAt } : null;
  const comun = { respondidaPor: solicitud.respondidaPor, canal: solicitud.canal, noPuede, expiresAt: solicitud.expiresAt, envios };

  if (!solicitud.codigoPseEnc || !solicitud.respondidaAt) return { ready: false, ...comun };
  return { ready: true, codigo: decryptPseCode(solicitud.codigoPseEnc), ...comun };
}

// ─── Entrada: webhook de Kapso ───────────────────────────────────────────────

export interface ResultadoEvento {
  wamid: string;
  resultado: string;
}

export async function procesarWebhookKapso(cuerpo: unknown, config: KapsoConfig): Promise<ResultadoEvento[]> {
  const resultados: ResultadoEvento[] = [];
  for (const evento of leerEventosKapso(cuerpo)) {
    // La línea se revisa para acuses y mensajes: si algún día llegara tráfico de
    // otra línea (2brain, Mizar) a este webhook, se descarta sin tocar nada.
    if (evento.lineaId && evento.lineaId !== config.phoneNumberId) {
      resultados.push({ wamid: evento.wamid, resultado: "ignorado:otra_linea" });
      continue;
    }
    if (evento.tipo === "acuse") {
      resultados.push({ wamid: evento.wamid, resultado: await aplicarAcuse(evento) });
      continue;
    }
    resultados.push({ wamid: evento.wamid, resultado: await atenderMensaje(evento, config) });
  }
  return resultados;
}

const RANGO_ESTADO: Record<EstadoEnvio, number> = { PENDIENTE: 0, ENVIADO: 1, ENTREGADO: 2, LEIDO: 3, FALLIDO: 1 };

/** Los acuses llegan desordenados: nunca se baja de "leído" a "entregado". */
async function aplicarAcuse(acuse: AcuseEntrega): Promise<string> {
  const mensaje = await db.whatsappMensaje.findUnique({ where: { wamid: acuse.wamid }, select: { id: true, estado: true } });
  if (!mensaje) return "ignorado:acuse_ajeno";
  const actual = mensaje.estado as EstadoEnvio;
  const sube = acuse.estado === "FALLIDO" ? RANGO_ESTADO[actual] < RANGO_ESTADO.ENTREGADO : RANGO_ESTADO[acuse.estado] > RANGO_ESTADO[actual];
  if (!sube) return "ignorado:acuse_viejo";
  await db.whatsappMensaje.update({
    where: { id: mensaje.id },
    data: { estado: acuse.estado, ...(acuse.estado === "FALLIDO" ? { error: acuse.motivo ?? "META_FAILED" } : {}) },
  });
  return `procesado:acuse_${acuse.estado.toLowerCase()}`;
}

function esDuplicado(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function atenderMensaje(mensaje: MensajeEntrante, config: KapsoConfig): Promise<string> {
  // Dedupe: Kapso entrega at-least-once. El wamid único hace de candado.
  try {
    await db.whatsappEntrante.create({
      data: { wamid: mensaje.wamid, remitente: mensaje.remitente, tipo: mensaje.clase, resultado: "procesando" },
    });
  } catch (error) {
    if (esDuplicado(error)) return "ignorado:duplicado";
    throw error;
  }

  let resultado: string;
  try {
    const aprobadores = await cargarAprobadoresPse();
    const aprobador = aprobadorPorTelefono(aprobadores, mensaje.remitente);
    const decision = aprobador
      ? decidirEntrante({
          mensaje,
          aprobador,
          referida: await solicitudReferida(mensaje),
          abiertas: await solicitudesAbiertasDe(mensaje.remitente),
          reciente: await solicitudRecienteDe(mensaje.remitente),
        })
      : decidirEntrante({ mensaje, aprobador: null, referida: null, abiertas: [] });
    resultado = await ejecutar(decision, aprobador, config);
  } catch (error) {
    console.error("[whatsapp] fallo atendiendo mensaje", mensaje.wamid, error instanceof Error ? error.message : "");
    resultado = "error:procesamiento";
  }
  await db.whatsappEntrante.update({ where: { wamid: mensaje.wamid }, data: { resultado } });
  return resultado;
}

const SELECT_SOLICITUD = {
  id: true,
  expiresAt: true,
  respondidaAt: true,
  respondidaPor: true,
  anuladaAt: true,
  solicitadoPor: true,
  tramite: { select: { consecutivo: true } },
} as const;

type FilaSolicitud = Prisma.PseSolicitudGetPayload<{ select: typeof SELECT_SOLICITUD }>;

async function aRef(fila: FilaSolicitud): Promise<SolicitudRef> {
  const estado = fila.respondidaAt ? "RESPONDIDA" : fila.anuladaAt || fila.expiresAt <= new Date() ? "CERRADA" : "ABIERTA";
  const usuario = await db.user.findUnique({ where: { id: fila.solicitadoPor }, select: { name: true } });
  return {
    id: fila.id,
    consecutivo: fila.tramite.consecutivo,
    estado,
    respondidaPor: fila.respondidaPor,
    operador: usuario?.name ?? null,
  };
}

/** La solicitud a la que apunta el botón o la cita — solo si el aviso fue a ESTE remitente. */
async function solicitudReferida(mensaje: MensajeEntrante): Promise<SolicitudRef | null> {
  let solicitudId: string | null = null;
  if (mensaje.clase === "boton" && mensaje.botonPayload) {
    solicitudId = leerPayloadBoton(mensaje.botonPayload)?.solicitudId ?? null;
  }
  const aviso = await db.whatsappMensaje.findFirst({
    where: {
      destinatario: mensaje.remitente,
      tipo: "PSE_CODIGO",
      ...(solicitudId ? { pseSolicitudId: solicitudId } : mensaje.contextoId ? { wamid: mensaje.contextoId } : { id: "__ninguno__" }),
    },
    select: { pseSolicitud: { select: SELECT_SOLICITUD } },
  });
  return aviso?.pseSolicitud ? aRef(aviso.pseSolicitud) : null;
}

async function solicitudRecienteDe(remitente: string): Promise<SolicitudRef | null> {
  const aviso = await db.whatsappMensaje.findFirst({
    where: {
      destinatario: remitente,
      tipo: "PSE_CODIGO",
      createdAt: { gt: new Date(Date.now() - VIGENCIA_SOLICITUD_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { pseSolicitud: { select: SELECT_SOLICITUD } },
  });
  return aviso?.pseSolicitud ? aRef(aviso.pseSolicitud) : null;
}

async function solicitudesAbiertasDe(remitente: string): Promise<SolicitudRef[]> {
  const filas = await db.pseSolicitud.findMany({
    where: {
      respondidaAt: null,
      anuladaAt: null,
      expiresAt: { gt: new Date() },
      mensajes: { some: { destinatario: remitente, tipo: "PSE_CODIGO" } },
    },
    orderBy: { createdAt: "asc" },
    select: SELECT_SOLICITUD,
  });
  return Promise.all(filas.map(aRef));
}

async function ejecutar(
  decision: Decision,
  aprobador: Aprobador | null,
  config: KapsoConfig,
): Promise<string> {
  if (decision.accion === "IGNORAR") return `ignorado:${decision.motivo}`;
  if (!aprobador) return "ignorado:remitente_no_aprobador";

  if (decision.accion === "RESPONDER") {
    await responder(config, aprobador, decision.respuesta, decision.datos, null);
    return `procesado:${decision.respuesta.toLowerCase()}`;
  }

  const s = decision.solicitud;
  const ahora = new Date();
  const abierta = { id: s.id, respondidaAt: null, anuladaAt: null, expiresAt: { gt: ahora } };

  if (decision.accion === "GUARDAR_CODIGO") {
    // updateMany condicionado = el primero que llega gana, sin carreras entre aprobadores.
    const { count } = await db.pseSolicitud.updateMany({
      where: abierta,
      data: {
        codigoPseEnc: encryptPseCode(decision.codigo),
        respondidaAt: ahora,
        respondidaPor: aprobador.nombre,
        canal: "WHATSAPP",
      },
    });
    if (count === 0) {
      const fila = await db.pseSolicitud.findUnique({ where: { id: s.id }, select: SELECT_SOLICITUD });
      const ref = fila ? await aRef(fila) : s;
      const tipo: TipoRespuesta = ref.estado === "RESPONDIDA" ? "PSE_YA_ATENDIDA" : "PSE_CERRADA";
      await responder(config, aprobador, tipo, { quien: ref.respondidaPor ?? undefined }, s.id);
      return `procesado:${tipo.toLowerCase()}`;
    }
    await marcarRespuesta(s.id, aprobador.telefono, "CODIGO");
    await responder(config, aprobador, "PSE_RECIBIDO", { nombre: aprobador.nombre, consecutivo: s.consecutivo, operador: s.operador ?? undefined }, s.id);
    return "procesado:codigo";
  }

  // NO_PUEDO
  await db.pseSolicitud.updateMany({ where: abierta, data: { noPuedeAt: ahora, noPuedePor: aprobador.nombre } });
  await marcarRespuesta(s.id, aprobador.telefono, "NO_PUEDO");
  await responder(config, aprobador, "PSE_NO_PUEDO_OK", { operador: s.operador ?? undefined }, s.id);
  return "procesado:no_puedo";
}

async function marcarRespuesta(solicitudId: string, telefono: string, respuesta: "CODIGO" | "NO_PUEDO"): Promise<void> {
  await db.whatsappMensaje.updateMany({
    where: { pseSolicitudId: solicitudId, destinatario: telefono, tipo: "PSE_CODIGO" },
    data: { respuesta, respondidoAt: new Date() },
  });
}

async function responder(
  config: KapsoConfig,
  aprobador: Aprobador,
  tipo: TipoRespuesta,
  datos: DatosRespuesta,
  pseSolicitudId: string | null,
): Promise<void> {
  await enviarRegistrado(config, {
    tipo,
    pseSolicitudId,
    aprobador,
    cuerpo: mensajeTexto(aprobador.telefono, textoRespuesta(tipo, datos)),
  });
}
