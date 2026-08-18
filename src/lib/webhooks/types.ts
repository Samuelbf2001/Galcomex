/**
 * Tipos de evento de los webhooks n8n — Galcomex.
 *
 * Los cinco eventos documentados en CLAUDE.md ("Webhooks n8n"). Cada uno
 * tiene un payload tipado (sin `any`). El dinero viaja como `string`
 * (`BigInt.toString()`) porque `JSON.stringify` no serializa `BigInt`
 * directo — mismo patrón que ya usa `src/lib/http/json.ts` (replacer que
 * convierte BigInt → string) y que `src/lib/dashboard/service.ts` aplica a
 * mano en varios puntos.
 *
 * Este archivo NO cablea nada: solo define la forma de los eventos. El
 * cableado (dónde en el código de negocio se dispara cada uno) es trabajo
 * aparte.
 */

export const WEBHOOK_EVENT_TYPES = [
  "do.creado",
  "do.enviado_a_facturar",
  "factura.aprobada",
  "factura.facturada",
  "cartera.vencida",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// ─── Payloads por evento ────────────────────────────────────────────────────

/** Se crea un nuevo trámite (DO). */
export type DoCreadoPayload = {
  tramiteId: string;
  consecutivo: string; // DO.CTG26-0124
  clienteId: string;
  clienteNombre: string;
  ciudad: string; // Ciudad enum: BAQ | CTG | BUN | SMR
  agenciaAduanas: string;
  creadoPorId: string;
  createdAt: string; // ISO 8601
};

/** El DO pasa a estado ENVIADO_A_FACTURAR. */
export type DoEnviadoAFacturarPayload = {
  tramiteId: string;
  consecutivo: string;
  clienteId: string;
  clienteNombre: string;
  fechaEnviadoAFacturar: string; // ISO 8601
};

/**
 * Un borrador de factura queda aprobado (ADMIN/REVISOR). Reunión 1-jul-2026
 * (min 00:59): alertar a Camila cuando la factura tenga observaciones —
 * `tieneObservaciones`/`observaciones` viajan para que n8n decida el canal
 * (ej. solo notifica si `tieneObservaciones === true`).
 */
export type FacturaAprobadaPayload = {
  borradorId: string;
  tramiteId: string;
  consecutivo: string;
  clienteId: string;
  clienteNombre: string;
  totalFactura: string; // BigInt → string
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
  tieneObservaciones: boolean;
  observaciones: string | null;
  aprobadoPorId: string;
};

/** La factura queda marcada como facturada (con número SIIGO). */
export type FacturaFacturadaPayload = {
  facturaId: string;
  borradorId: string;
  tramiteId: string;
  consecutivo: string;
  clienteId: string;
  clienteNombre: string;
  numSiigo: string; // BAQ-18288
  totalFactura: string; // BigInt → string
  fecha: string; // ISO 8601
};

/**
 * La cartera acumulada de un cliente cae bajo el umbral. Reunión 1-jul-2026
 * (min 01:14): alertar a Guillermo. `deuda` y `umbral` en COP, BigInt →
 * string. Convención de signo idéntica a `evaluarAlertaCarteraCliente` en
 * `src/lib/cartera/service.ts`: `saldoNetoAcumulado < 0` ⇒ el cliente le
 * debe a Galcomex; `deuda = max(0, -saldoNetoAcumulado)`.
 */
export type CarteraVencidaPayload = {
  clienteId: string;
  clienteNombre: string;
  saldoNetoAcumulado: string; // BigInt → string, puede ser negativo
  deuda: string; // BigInt → string, siempre ≥ 0
  umbral: string; // BigInt → string
};

/** Mapa evento → payload, usado para tipar `dispatchWebhookEvent` sin `any`. */
export type WebhookEventPayloadMap = {
  "do.creado": DoCreadoPayload;
  "do.enviado_a_facturar": DoEnviadoAFacturarPayload;
  "factura.aprobada": FacturaAprobadaPayload;
  "factura.facturada": FacturaFacturadaPayload;
  "cartera.vencida": CarteraVencidaPayload;
};

/** Sobre (envelope) que se serializa y firma tal cual para cada evento. */
export type WebhookEvent<T extends WebhookEventType = WebhookEventType> = {
  evento: T;
  emitidoEn: string; // ISO 8601, momento de creación del evento
  data: WebhookEventPayloadMap[T];
};
