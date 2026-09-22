import { normalizarCelular } from "./telefono";

/**
 * Traduce lo que Kapso entrega al webhook a eventos simples. Puro, sin red ni BD.
 *
 * Formas que acepta (todas vistas o documentadas):
 *  - Kapso v2, una entrega:  { message, conversation, phone_number_id }
 *  - Kapso v2 en lote:       { batch: true, data: [{ message, conversation, phone_number_id }] }
 *  - Meta cruda:             { entry: [{ changes: [{ value: { metadata, messages[], statuses[] } }] }] }
 *
 * Tipos de mensaje entrante que importan:
 *  - text                              → el código que escribe el aprobador
 *  - button (botón de PLANTILLA)       → message.button.payload ("No puedo ahora")
 *  - interactive/button_reply (sesión) → message.interactive.button_reply.id
 * `context.id` es el wamid del mensaje nuestro que la persona citó o cuyo botón tocó.
 *
 * Acuses de entrega: en v2 llegan como message.kapso.{direction:"outbound", status};
 * en Meta cruda como value.statuses[]. Solo se usan para marcar el estado del envío.
 */

export type EstadoAcuse = "ENVIADO" | "ENTREGADO" | "LEIDO" | "FALLIDO";

export interface MensajeEntrante {
  tipo: "mensaje";
  wamid: string;
  /** Normalizado 57XXXXXXXXXX. */
  remitente: string;
  /** phone_number_id de la línea que recibió el mensaje, si la envoltura lo trae. */
  lineaId: string | null;
  clase: "texto" | "boton" | "otro";
  texto?: string;
  botonPayload?: string;
  contextoId?: string;
}

export interface AcuseEntrega {
  tipo: "acuse";
  wamid: string;
  estado: EstadoAcuse;
  /** "131047 · Re-engagement message": código de Meta + título, nunca el teléfono. */
  motivo?: string;
  lineaId: string | null;
}

export type EventoEntrante = MensajeEntrante | AcuseEntrega;

type Objeto = Record<string, unknown>;

function obj(valor: unknown): Objeto | null {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Objeto) : null;
}

function str(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim() !== "") return valor.trim();
  if (typeof valor === "number") return String(valor);
  return null;
}

const ESTADO_POR_STATUS: Record<string, EstadoAcuse> = {
  sent: "ENVIADO",
  delivered: "ENTREGADO",
  read: "LEIDO",
  failed: "FALLIDO",
};

function motivoDeErrores(errores: unknown): string | undefined {
  if (!Array.isArray(errores)) return undefined;
  for (const e of errores) {
    const error = obj(e);
    if (!error) continue;
    const texto = [str(error.code), str(error.title)].filter(Boolean).join(" · ");
    if (texto) return texto.slice(0, 120);
  }
  return undefined;
}

/** Lee un objeto `message` (forma Meta, igual en v2) como mensaje entrante. */
function leerMensaje(message: Objeto, lineaId: string | null): MensajeEntrante | null {
  const wamid = str(message.id);
  const from = str(message.from);
  if (!wamid || !from) return null;
  const remitente = normalizarCelular(from);
  const contextoId = str(obj(message.context)?.id) ?? undefined;
  const base = { tipo: "mensaje" as const, wamid, remitente, lineaId, contextoId };

  if (message.type === "text") {
    const cuerpo = obj(message.text)?.body;
    return { ...base, clase: "texto", texto: typeof cuerpo === "string" ? cuerpo : "" };
  }
  if (message.type === "button") {
    const boton = obj(message.button);
    const payload = str(boton?.payload) ?? str(boton?.text);
    return payload ? { ...base, clase: "boton", botonPayload: payload } : { ...base, clase: "otro" };
  }
  if (message.type === "interactive") {
    const interactive = obj(message.interactive);
    const id = interactive?.type === "button_reply" ? str(obj(interactive.button_reply)?.id) : null;
    return id ? { ...base, clase: "boton", botonPayload: id } : { ...base, clase: "otro" };
  }
  return { ...base, clase: "otro" };
}

/** Una entrega v2: `{ message, conversation, phone_number_id }`. */
function leerEntregaV2(entrega: Objeto): EventoEntrante | null {
  const message = obj(entrega.message);
  if (!message) return null;
  const lineaId = str(entrega.phone_number_id) ?? str(obj(entrega.conversation)?.phone_number_id);

  const kapso = obj(message.kapso);
  if (kapso && kapso.direction === "outbound") {
    const wamid = str(message.id);
    const estado = ESTADO_POR_STATUS[String(kapso.status ?? "")];
    if (!wamid || !estado) return null;
    const statuses = Array.isArray(kapso.statuses) ? kapso.statuses : [];
    const motivo = estado === "FALLIDO" ? statuses.map((s) => motivoDeErrores(obj(s)?.errors)).find(Boolean) : undefined;
    return { tipo: "acuse", wamid, estado, lineaId, ...(motivo ? { motivo } : {}) };
  }
  return leerMensaje(message, lineaId);
}

/** Meta cruda: entry[].changes[].value.{messages[], statuses[]}. */
function leerMetaCruda(cuerpo: Objeto): EventoEntrante[] {
  const eventos: EventoEntrante[] = [];
  const entries = Array.isArray(cuerpo.entry) ? cuerpo.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(obj(entry)?.changes) ? (obj(entry)?.changes as unknown[]) : [];
    for (const change of changes) {
      const value = obj(obj(change)?.value);
      if (!value) continue;
      const lineaId = str(obj(value.metadata)?.phone_number_id);
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const m of messages) {
        const leido = obj(m) ? leerMensaje(obj(m) as Objeto, lineaId) : null;
        if (leido) eventos.push(leido);
      }
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const s of statuses) {
        const status = obj(s);
        const wamid = str(status?.id);
        const estado = ESTADO_POR_STATUS[String(status?.status ?? "")];
        if (!wamid || !estado) continue;
        const motivo = estado === "FALLIDO" ? motivoDeErrores(status?.errors) : undefined;
        eventos.push({ tipo: "acuse", wamid, estado, lineaId, ...(motivo ? { motivo } : {}) });
      }
    }
  }
  return eventos;
}

export function leerEventosKapso(cuerpo: unknown): EventoEntrante[] {
  const raiz = obj(cuerpo);
  if (!raiz) return [];
  if (Array.isArray(raiz.entry)) return leerMetaCruda(raiz);
  if (raiz.batch === true && Array.isArray(raiz.data)) {
    return raiz.data
      .map((d) => (obj(d) ? leerEntregaV2(obj(d) as Objeto) : null))
      .filter((e): e is EventoEntrante => e !== null);
  }
  const unico = leerEntregaV2(raiz);
  return unico ? [unico] : [];
}
