/**
 * Notificaciones por WhatsApp — Galcomex
 *
 * Transporte: el MISMO patrón que ya usa el flujo PSE
 * (`src/app/api/tramites/[id]/pse-token/route.ts`): un POST JSON a un webhook
 * de n8n, disparado sin bloquear la respuesta del endpoint. Aquí se generaliza
 * ese `fetch` suelto en una función reutilizable que además:
 *
 *   - lee la URL de la pasarela de `WHATSAPP_WEBHOOK_URL` (sin default: si no
 *     está configurada NO se inventa ningún destino),
 *   - nunca lanza — el peor caso es que el aviso no salga, jamás que se caiga
 *     la operación de negocio que lo disparó,
 *   - deja rastro: `console.error` estructurado cuando no sale, y un `AuditLog`
 *     con entidad `"Notificacion"` SIEMPRE (salga o no), para poder responder
 *     "¿le avisaron a Camila?" sin adivinar.
 *
 * El número destino NO se escribe en código: sale del parámetro del sistema
 * `WHATSAPP_CAMILA` (tabla `Parametro`, editable por ADMIN en Configuración).
 * Si está vacío no se envía nada y queda registrado como
 * "sin destinatario configurado".
 */

import { prisma } from "@/lib/db/prisma";

/** Clave del `Parametro` con el celular de Camila (formato +57…). */
export const PARAMETRO_WHATSAPP_CAMILA = "WHATSAPP_CAMILA";

/** Entidad con la que se registran los avisos en `AuditLog`. */
export const ENTIDAD_AUDIT_NOTIFICACION = "Notificacion";

/** Acción con la que se registran los avisos en `AuditLog`. */
export const ACCION_AUDIT_NOTIFICACION = "NOTIFICAR_WHATSAPP";

/** Corte del POST a la pasarela: un webhook lento no puede colgar el proceso. */
const TIMEOUT_MS = 8_000;

/**
 * Contexto del aviso. Viaja en el body hacia la pasarela y alimenta el
 * `AuditLog`, por eso `usuarioId` es obligatorio (es FK de `AuditLog`).
 */
export type ContextoNotificacion = {
  /** Usuario que disparó el aviso. */
  usuarioId: string;
  /** Etiqueta del evento de negocio, p. ej. "borrador_devuelto". */
  evento: string;
  /** Entidad de origen, p. ej. "BorradorFactura". */
  entidad: string;
  /** Id de la entidad de origen. */
  entidadId: string;
  /** Trámite relacionado, si lo hay (indexa el AuditLog por DO). */
  tramiteId?: string | null;
  /** Datos legibles extra (consecutivo, cliente…). Se mandan tal cual. */
  datos?: Record<string, string>;
};

export type MotivoNoEnviado =
  | "sin destinatario configurado"
  | "sin pasarela configurada"
  | "la pasarela respondió con error"
  | "error de transporte";

export type ResultadoNotificacion =
  | { enviado: true; status: number }
  | { enviado: false; motivo: MotivoNoEnviado; detalle?: string };

export type NotificarWhatsAppInput = {
  /** Celular destino en formato +57…. Vacío o null ⇒ no se envía. */
  destino: string | null | undefined;
  /** Texto del mensaje, ya armado. */
  texto: string;
  contexto: ContextoNotificacion;
};

/**
 * Enmascara el celular para los logs del contenedor (que salen del sistema):
 * `+573001234567` → `+57…4567`. En el `AuditLog` (interno, solo ADMIN) se
 * guarda completo, que es donde sí sirve para verificar a quién se avisó.
 */
export function enmascararDestino(destino: string): string {
  const limpio = destino.trim();
  if (limpio.length <= 4) return "…";
  return `${limpio.slice(0, 3)}…${limpio.slice(-4)}`;
}

/**
 * Lee el celular de Camila del parámetro del sistema. Devuelve `null` si la
 * fila no existe o está vacía (caso de una instalación recién sembrada).
 */
export async function obtenerDestinoWhatsAppCamila(): Promise<string | null> {
  const parametro = await prisma.parametro.findUnique({
    where: { clave: PARAMETRO_WHATSAPP_CAMILA },
    select: { valor: true },
  });
  const valor = parametro?.valor?.trim() ?? "";
  return valor.length > 0 ? valor : null;
}

/**
 * Registra el intento en `AuditLog`. Aislado en su propio try/catch: que no se
 * pueda auditar no puede tumbar el aviso ni la operación que lo disparó.
 */
async function registrarAuditoria(
  input: NotificarWhatsAppInput,
  /** Destino ya normalizado (trim); `null` cuando no había. */
  destino: string | null,
  resultado: ResultadoNotificacion,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        entidad: ENTIDAD_AUDIT_NOTIFICACION,
        entidadId: input.contexto.entidadId,
        accion: ACCION_AUDIT_NOTIFICACION,
        usuarioId: input.contexto.usuarioId,
        tramiteId: input.contexto.tramiteId ?? null,
        antes: undefined,
        despues: {
          canal: "WHATSAPP",
          evento: input.contexto.evento,
          entidadOrigen: input.contexto.entidad,
          destino,
          texto: input.texto,
          enviado: resultado.enviado,
          ...(resultado.enviado
            ? { status: resultado.status }
            : { motivo: resultado.motivo, detalle: resultado.detalle ?? null }),
          ...(input.contexto.datos ? { datos: input.contexto.datos } : {}),
        },
      },
    });
  } catch (error) {
    console.error(
      "[notificaciones/whatsapp] no se pudo registrar el AuditLog",
      JSON.stringify({
        evento: input.contexto.evento,
        entidadId: input.contexto.entidadId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Envía un mensaje de WhatsApp por la pasarela configurada.
 *
 * **Nunca lanza.** Devuelve siempre un `ResultadoNotificacion` para que quien
 * la llame pueda decidir; los llamadores de negocio la disparan sin `await`
 * (`void notificarWhatsApp(...)`) para no bloquear la respuesta HTTP.
 *
 * Body que recibe la pasarela: `{ to, text, contexto }`.
 */
export async function notificarWhatsApp(
  input: NotificarWhatsAppInput,
): Promise<ResultadoNotificacion> {
  const destino = input.destino?.trim() ?? "";
  const url = process.env.WHATSAPP_WEBHOOK_URL?.trim() ?? "";

  let resultado: ResultadoNotificacion;

  if (destino.length === 0) {
    resultado = { enviado: false, motivo: "sin destinatario configurado" };
  } else if (url.length === 0) {
    resultado = {
      enviado: false,
      motivo: "sin pasarela configurada",
      detalle: "Falta la variable de entorno WHATSAPP_WEBHOOK_URL",
    };
  } else {
    try {
      const respuesta = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: destino,
          text: input.texto,
          contexto: input.contexto,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      resultado = respuesta.ok
        ? { enviado: true, status: respuesta.status }
        : {
            enviado: false,
            motivo: "la pasarela respondió con error",
            detalle: `HTTP ${respuesta.status}`,
          };
    } catch (error) {
      resultado = {
        enviado: false,
        motivo: "error de transporte",
        detalle: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!resultado.enviado) {
    console.error(
      "[notificaciones/whatsapp] aviso no enviado",
      JSON.stringify({
        evento: input.contexto.evento,
        entidad: input.contexto.entidad,
        entidadId: input.contexto.entidadId,
        tramiteId: input.contexto.tramiteId ?? null,
        destino: destino.length > 0 ? enmascararDestino(destino) : null,
        motivo: resultado.motivo,
        detalle: resultado.detalle ?? null,
      }),
    );
  }

  await registrarAuditoria(input, destino.length > 0 ? destino : null, resultado);

  return resultado;
}
