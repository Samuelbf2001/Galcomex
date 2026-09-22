import type { Aprobador } from "./aprobadores";
import { PREFIJO_BOTON, extraerCodigo, leerPayloadBoton, type DatosRespuesta, type TipoRespuesta } from "./catalogo";
import type { MensajeEntrante } from "./entrante";

/**
 * Qué hacer con un mensaje entrante. Función PURA: el servicio le entrega el
 * estado ya consultado y ejecuta la decisión. Aquí viven las reglas de
 * aislamiento, así que se prueban sin BD ni red.
 *
 * Reglas, en orden:
 *  1. Quien no es aprobador NO recibe respuesta jamás (ni un "no entiendo").
 *     Si la línea se compartiera, la plataforma no le habla a nadie ajeno.
 *  2. Un botón solo cuenta si es nuestro ("gx_") y trae el id de la solicitud.
 *  3. Un texto se asigna a una solicitud: la que la persona citó (context.id)
 *     o, si no citó, la ÚNICA que tiene abierta. Con varias abiertas y sin cita
 *     se le pide citar: nunca se adivina a qué pago va un código.
 *  4. Un texto sin pinta de código ("gracias") no dispara nada si no hay nada
 *     que corregir.
 */

export type EstadoSolicitud = "ABIERTA" | "RESPONDIDA" | "CERRADA";

export interface SolicitudRef {
  id: string;
  consecutivo: string;
  estado: EstadoSolicitud;
  respondidaPor: string | null;
  operador: string | null;
}

export type Decision =
  | { accion: "IGNORAR"; motivo: string }
  | { accion: "GUARDAR_CODIGO"; solicitud: SolicitudRef; codigo: string }
  | { accion: "NO_PUEDO"; solicitud: SolicitudRef }
  | { accion: "RESPONDER"; respuesta: TipoRespuesta; datos: DatosRespuesta; motivo: string };

export interface EntradaDecision {
  mensaje: MensajeEntrante;
  aprobador: Aprobador | null;
  /** Solicitud a la que apunta el botón (por id) o la cita (por context.id), en cualquier estado. */
  referida: SolicitudRef | null;
  /** Solicitudes abiertas cuyo aviso se mandó a este remitente. */
  abiertas: SolicitudRef[];
  /** La última solicitud avisada a este remitente dentro de la vigencia, en cualquier estado. */
  reciente?: SolicitudRef | null;
}

function respuestaSegunEstado(s: SolicitudRef, motivo: string): Decision {
  if (s.estado === "RESPONDIDA") {
    return { accion: "RESPONDER", respuesta: "PSE_YA_ATENDIDA", datos: { quien: s.respondidaPor ?? undefined }, motivo };
  }
  return { accion: "RESPONDER", respuesta: "PSE_CERRADA", datos: {}, motivo };
}

export function decidirEntrante({ mensaje, aprobador, referida, abiertas, reciente = null }: EntradaDecision): Decision {
  if (!aprobador) return { accion: "IGNORAR", motivo: "remitente_no_aprobador" };

  if (mensaje.clase === "boton") {
    const payload = mensaje.botonPayload ?? "";
    if (!payload.startsWith(PREFIJO_BOTON)) return { accion: "IGNORAR", motivo: "boton_ajeno" };
    if (!leerPayloadBoton(payload)) return { accion: "IGNORAR", motivo: "boton_desconocido" };
    if (!referida) return { accion: "IGNORAR", motivo: "solicitud_inexistente" };
    if (referida.estado === "ABIERTA") return { accion: "NO_PUEDO", solicitud: referida };
    return respuestaSegunEstado(referida, "boton_solicitud_cerrada");
  }

  if (mensaje.clase === "texto") {
    const codigo = extraerCodigo(mensaje.texto ?? "");
    let objetivo: SolicitudRef | null = referida;
    if (!objetivo) {
      if (abiertas.length === 1) {
        objetivo = abiertas[0];
      } else if (abiertas.length > 1) {
        if (!codigo) return { accion: "IGNORAR", motivo: "texto_sin_codigo" };
        return {
          accion: "RESPONDER",
          respuesta: "PSE_AMBIGUA",
          datos: { consecutivos: abiertas.map((s) => s.consecutivo) },
          motivo: "varias_abiertas_sin_cita",
        };
      } else {
        if (!codigo) return { accion: "IGNORAR", motivo: "texto_sin_solicitud" };
        // Llegó tarde a una solicitud que ya se cerró (típico: otro aprobador respondió primero).
        if (reciente && reciente.estado !== "ABIERTA") return respuestaSegunEstado(reciente, "codigo_a_solicitud_reciente");
        return { accion: "RESPONDER", respuesta: "PSE_SIN_SOLICITUD", datos: {}, motivo: "codigo_sin_solicitud" };
      }
    }

    if (objetivo.estado === "ABIERTA") {
      if (!codigo) {
        return { accion: "RESPONDER", respuesta: "PSE_FORMATO", datos: {}, motivo: "formato_invalido" };
      }
      return { accion: "GUARDAR_CODIGO", solicitud: objetivo, codigo };
    }
    if (!codigo) return { accion: "IGNORAR", motivo: "texto_a_solicitud_cerrada" };
    return respuestaSegunEstado(objetivo, "codigo_a_solicitud_cerrada");
  }

  // Audio, imagen, sticker...: si hay algo abierto se le explica cómo responder.
  if (abiertas.length > 0) {
    return { accion: "RESPONDER", respuesta: "PSE_FORMATO", datos: {}, motivo: "tipo_no_soportado" };
  }
  return { accion: "IGNORAR", motivo: "tipo_no_soportado" };
}
