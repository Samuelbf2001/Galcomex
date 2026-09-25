import { z } from "zod";

// ─── Errores ──────────────────────────────────────────────────────────────────

export class SiigoConfigError extends Error {
  constructor(campo: string) {
    super(`Variable de entorno Siigo no configurada: ${campo}`);
    this.name = "SiigoConfigError";
  }
}

export class SiigoApiError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SiigoApiError";
    this.status = status;
  }
}

/**
 * Siigo respondió 2xx al crear la factura pero el cuerpo no es el esperado
 * (JSON roto, sin consecutivo, sin fecha…). La factura PUDO haberse creado:
 * quien llame no debe reintentar. `idRecuperado` trae el id si venía en el
 * cuerpo, para guardarlo aunque falte lo demás.
 */
export class SiigoRespuestaInvalidaError extends Error {
  public readonly status = 502;
  public readonly idRecuperado: string | null;
  constructor(message: string, idRecuperado: string | null) {
    super(message);
    this.name = "SiigoRespuestaInvalidaError";
    this.idRecuperado = idRecuperado;
  }
}

// ─── Red: timeout, token en caché y 429 ──────────────────────────────────────

/** Tope de espera de cada llamada a Siigo. */
export const TIMEOUT_SIIGO_MS = 20_000;

/** Cada fetch lleva su timeout; si quien llama pasa su propia señal, manda la primera que corte. */
function senalConTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_SIIGO_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Margen antes del vencimiento real del token para pedir uno nuevo. */
const MARGEN_TOKEN_MS = 5 * 60_000;

type TokenEnCache = { clave: string; token: string; vence: number };
let tokenEnCache: TokenEnCache | null = null;
let tokenEnVuelo: { clave: string; promesa: Promise<string> } | null = null;

/** Olvida el token guardado (tras un 401, o en tests). */
export function invalidarTokenSiigo(): void {
  tokenEnCache = null;
  tokenEnVuelo = null;
}

/** Máximo de intentos de un GET que Siigo frena con 429. */
const MAX_INTENTOS_429 = 3;
/** Espera por defecto si el 429 no trae Retry-After, y tope de cualquier espera. */
const ESPERA_429_DEFECTO_MS = 2_000;
const ESPERA_429_MAX_MS = 10_000;

/** Lee Retry-After (segundos o fecha HTTP) y lo acota a una pausa corta. */
export function esperaTrasRetryAfter(valor: string | null, ahora: number = Date.now()): number {
  if (valor === null || valor.trim() === "") return ESPERA_429_DEFECTO_MS;
  const segundos = Number(valor);
  let ms: number;
  if (Number.isFinite(segundos)) {
    ms = segundos * 1000;
  } else {
    const fecha = Date.parse(valor);
    ms = Number.isNaN(fecha) ? ESPERA_429_DEFECTO_MS : fecha - ahora;
  }
  return Math.min(Math.max(ms, 0), ESPERA_429_MAX_MS);
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET autenticado a Siigo. Solo GET (idempotente): si Siigo responde 429 se
 * espera lo que diga Retry-After (acotado) y se reintenta, hasta
 * MAX_INTENTOS_429. Un 401 invalida el token en caché.
 */
async function fetchGetSiigo(
  url: string,
  token: string,
  opciones: OpcionesLlamadaSiigo = {},
): Promise<Response> {
  for (let intento = 1; ; intento += 1) {
    const response = await fetch(url, {
      signal: senalConTimeout(opciones.signal),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Partner-Id": "galcomex",
      },
    });
    if (response.status === 401) invalidarTokenSiigo();
    if (response.status !== 429 || intento >= MAX_INTENTOS_429) return response;
    await esperar(esperaTrasRetryAfter(response.headers.get("retry-after")));
  }
}

// ─── Schemas Zod ─────────────────────────────────────────────────────────────

const siigoTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
});

/**
 * Impuestos que Siigo devuelve dentro de cada producto de `/v1/products`.
 * Mismo shape que `/v1/taxes`. Se usan para llenar `siigo_producto_impuesto`
 * sin que nadie tenga que asociarlos a mano (ver docs/CATALOGOS.md §2).
 */
const siigoProductoTaxSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  percentage: z.number(),
});

const siigoProductoSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  account_group: z.object({
    id: z.number(),
    name: z.string(),
  }),
  type: z.string(),
  active: z.boolean(),
  tax_classification: z.string(),
  // Algunas cuentas/productos no lo traen: se tolera ausente o null.
  taxes: z.array(siigoProductoTaxSchema).optional().nullable(),
});

export type SiigoProductoTaxRaw = z.infer<typeof siigoProductoTaxSchema>;

const siigoProductosResponseSchema = z.object({
  pagination: z.object({
    total_results: z.number(),
  }),
  results: z.array(siigoProductoSchema),
});

export type SiigoProductoRaw = z.infer<typeof siigoProductoSchema>;

// ─── Config interna ───────────────────────────────────────────────────────────

function leerConfig(): { username: string; accessKey: string; baseUrl: string } {
  const username = process.env.SIIGO_API_USERNAME;
  const accessKey = process.env.SIIGO_API_ACCESS_KEY;
  const baseUrl = process.env.SIIGO_API_BASE_URL ?? "https://api.siigo.com";

  if (!username) throw new SiigoConfigError("SIIGO_API_USERNAME");
  if (!accessKey) throw new SiigoConfigError("SIIGO_API_ACCESS_KEY");

  return { username, accessKey, baseUrl };
}

// ─── Funciones públicas ───────────────────────────────────────────────────────

/** Opciones de red comunes; `signal` permite cortar una llamada que no responde. */
export interface OpcionesLlamadaSiigo {
  signal?: AbortSignal;
}

/**
 * Token de la API de Siigo. Se guarda en memoria hasta `expires_in` menos un
 * margen (Siigo limita cuántos tokens se piden); dos llamadas simultáneas
 * comparten la misma petición.
 */
export async function getToken(opciones: OpcionesLlamadaSiigo = {}): Promise<string> {
  const { username, accessKey, baseUrl } = leerConfig();
  const clave = `${baseUrl}|${username}`;

  if (tokenEnCache && tokenEnCache.clave === clave && Date.now() < tokenEnCache.vence) {
    return tokenEnCache.token;
  }
  if (tokenEnVuelo && tokenEnVuelo.clave === clave) return tokenEnVuelo.promesa;

  const promesa = pedirToken(baseUrl, username, accessKey, opciones).then(
    ({ token, expiresIn }) => {
      const vence = Date.now() + expiresIn * 1000 - MARGEN_TOKEN_MS;
      tokenEnCache = vence > Date.now() ? { clave, token, vence } : null;
      return token;
    },
  );
  const enVuelo = { clave, promesa };
  tokenEnVuelo = enVuelo;
  try {
    return await promesa;
  } finally {
    if (tokenEnVuelo === enVuelo) tokenEnVuelo = null;
  }
}

async function pedirToken(
  baseUrl: string,
  username: string,
  accessKey: string,
  opciones: OpcionesLlamadaSiigo,
): Promise<{ token: string; expiresIn: number }> {
  const response = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    signal: senalConTimeout(opciones.signal),
    headers: {
      "Content-Type": "application/json",
      "Partner-Id": "galcomex",
    },
    body: JSON.stringify({ username, access_key: accessKey }),
  });

  if (!response.ok) {
    throw new SiigoApiError(
      `Siigo auth falló con HTTP ${response.status}`,
      response.status,
    );
  }

  const raw: unknown = await response.json();
  const parsed = siigoTokenResponseSchema.parse(raw);
  return { token: parsed.access_token, expiresIn: parsed.expires_in };
}

export async function getProductos(
  token: string,
  opciones: OpcionesLlamadaSiigo = {},
): Promise<SiigoProductoRaw[]> {
  const { baseUrl } = leerConfig();
  const todos: SiigoProductoRaw[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const url = `${baseUrl}/v1/products?page=${page}&page_size=${pageSize}`;

    const response = await fetchGetSiigo(url, token, opciones);

    if (!response.ok) {
      throw new SiigoApiError(
        `Siigo GET /v1/products falló con HTTP ${response.status} en página ${page}`,
        response.status,
      );
    }

    const raw: unknown = await response.json();
    const parsed = siigoProductosResponseSchema.parse(raw);

    todos.push(...parsed.results);

    if (parsed.results.length < pageSize) break;
    page += 1;
  }

  return todos;
}

// ─── Lookups de configuración (document-types, users, payment-types, taxes) ──
//
// Estos endpoints sirven para descubrir los IDs numéricos que SIIGO espera en
// el payload de POST /v1/invoices. Se usan desde scripts/siigo-config-lookup.ts
// para llenar las variables SIIGO_INVOICE_* del .env.

async function getJson(token: string, path: string): Promise<unknown> {
  const { baseUrl } = leerConfig();
  const url = `${baseUrl}${path}`;
  const response = await fetchGetSiigo(url, token);
  if (!response.ok) {
    throw new SiigoApiError(
      `Siigo GET ${path} falló con HTTP ${response.status}`,
      response.status,
    );
  }
  return response.json();
}

export interface SiigoDocumentType {
  id: number;
  code: string;
  name: string;
  type: string;
  active?: boolean;
}

export interface SiigoUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  active?: boolean;
}

export interface SiigoPaymentType {
  id: number;
  name: string;
  type?: string;
  active?: boolean;
}

export interface SiigoTax {
  id: number;
  name: string;
  type: string;
  percentage: number;
  active?: boolean;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "object" && value !== null) {
    const obj = value as { results?: unknown };
    if (Array.isArray(obj.results)) return obj.results as T[];
  }
  return [];
}

export async function getDocumentTypes(token: string): Promise<SiigoDocumentType[]> {
  // type=FV filtra a "Facturas de Venta". Si SIIGO no soporta el filtro
  // devuelve todos los tipos y el script de lookup los muestra todos.
  const raw = await getJson(token, "/v1/document-types?type=FV");
  return asArray<SiigoDocumentType>(raw);
}

export async function getUsers(token: string): Promise<SiigoUser[]> {
  const raw = await getJson(token, "/v1/users");
  return asArray<SiigoUser>(raw);
}

export async function getPaymentTypes(token: string): Promise<SiigoPaymentType[]> {
  const raw = await getJson(token, "/v1/payment-types?document_type=FV");
  return asArray<SiigoPaymentType>(raw);
}

export async function getTaxes(token: string): Promise<SiigoTax[]> {
  const raw = await getJson(token, "/v1/taxes");
  return asArray<SiigoTax>(raw);
}

// ─── POST factura de venta ────────────────────────────────────────────────────

const siigoFacturaResponseSchema = z.object({
  id: z.string(),
  // SIIGO devuelve el consecutivo como "name" o "number" según versión; aceptamos
  // ambos y normalizamos al campo `name` para el resto del código.
  name: z.string().optional(),
  number: z.union([z.string(), z.number()]).optional(),
  date: z.string(),
});

export interface SiigoFacturaItemDto {
  /** Código del producto en Siigo (linea_revision.siigoProducto.codigo) */
  code: string;
  /** Descripción libre — se mapea al concepto de la línea */
  description: string;
  quantity: number;
  /** Precio unitario en COP (entero, sin decimales) */
  price: number;
  /** IDs de impuestos Siigo aplicables a la línea (ej. IVA en línea de comisión) */
  taxes?: Array<{ id: number }>;
  /**
   * Tercero asociado a la línea — solo aplica a productos cuyo grupo contable
   * es "Ingresos recibidos para terceros" (típicamente todas las líneas TERCEROS
   * de Galcomex). Aparece como columna "Id. Tercero" en el PDF de Siigo y como
   * `<cac:InformationContentProviderParty>` en el XML UBL/DIAN.
   *
   * Formato verificado contra GET /v1/invoices/{id} de una factura real de
   * Galcomex (FV-2-18582): { identification: "<NIT>", branch_office: 0 }.
   */
  customer?: {
    identification: string;
    branch_office?: number;
  };
}

export interface SiigoFacturaPostDto {
  /** ID del tipo de comprobante en Siigo (factura de venta) */
  document: { id: number };
  /** Fecha de la factura en formato YYYY-MM-DD */
  date: string;
  /** Cliente principal de la factura. branch_office=0 por defecto. */
  customer: { identification: string; branch_office?: number };
  /** ID del vendedor (usuario interno Siigo) */
  seller: number;
  /** Observaciones (comentariosCabecera unidos por saltos de línea) */
  observations?: string;
  items: SiigoFacturaItemDto[];
  /** Forma de pago — para crédito basta con id + value */
  payments: Array<{ id: number; value: number; due_date?: string }>;
  /**
   * Retenciones a nivel de factura (ReteIVA, ReteICA, autorretención) por id de
   * impuesto Siigo. `payments[].value` = subtotal + IVA de ítems − retenciones.
   */
  retentions?: Array<{ id: number }>;
  /**
   * Control del estampado/envío a DIAN. send=false deja la factura como
   * BORRADOR en Siigo para que un usuario superior la valide y la envíe
   * manualmente desde el portal Siigo.
   */
  stamp?: { send: boolean };
}

export interface SiigoFacturaPostResponse {
  id: string;
  /** Consecutivo legible devuelto por SIIGO (ej. "BAQ-18288") */
  name: string;
  date: string;
}

/** Saca el id de un cuerpo 2xx aunque el resto no valide (string o número no vacío). */
function idDeRespuesta(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || !("id" in raw)) return null;
  const id = (raw as { id: unknown }).id;
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

/**
 * Crea la factura en Siigo. NUNCA se reintenta aquí (ni por 429 ni por
 * timeout): cada POST puede crear un documento. Errores:
 * - `SiigoApiError` (status HTTP) si Siigo respondió con error.
 * - `SiigoRespuestaInvalidaError` si respondió 2xx con un cuerpo inesperado:
 *   la factura pudo haberse creado.
 * - TimeoutError / TypeError de red si no hubo respuesta.
 */
export async function postFactura(
  token: string,
  dto: SiigoFacturaPostDto,
  opciones: OpcionesLlamadaSiigo = {},
): Promise<SiigoFacturaPostResponse> {
  const { baseUrl } = leerConfig();

  const response = await fetch(`${baseUrl}/v1/invoices`, {
    method: "POST",
    signal: senalConTimeout(opciones.signal),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Partner-Id": "galcomex",
    },
    body: JSON.stringify(dto),
  });

  if (response.status === 401) invalidarTokenSiigo();

  if (!response.ok) {
    // SIIGO devuelve detalles de validación en el body — los propagamos para
    // que el ADMIN pueda corregir el borrador antes de reintentar.
    let detalle = "";
    try {
      const body: unknown = await response.json();
      detalle =
        typeof body === "string"
          ? body
          : ` — ${JSON.stringify(body)}`;
    } catch {
      // body no es JSON; ignoramos
    }
    throw new SiigoApiError(
      `Siigo POST /v1/invoices falló con HTTP ${response.status}${detalle}`,
      response.status,
    );
  }

  // Desde aquí Siigo dijo 2xx: cualquier sorpresa es "pudo haberse creado".
  let raw: unknown;
  try {
    raw = JSON.parse(await response.text());
  } catch {
    throw new SiigoRespuestaInvalidaError(
      `Siigo respondió HTTP ${response.status} al crear la factura, pero la respuesta no se pudo leer`,
      null,
    );
  }
  const idRecuperado = idDeRespuesta(raw);
  const parsed = siigoFacturaResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SiigoRespuestaInvalidaError(
      `Siigo respondió HTTP ${response.status} al crear la factura, pero la respuesta no trae los campos esperados (id, consecutivo, fecha)`,
      idRecuperado,
    );
  }
  const consecutivo =
    parsed.data.name ??
    (parsed.data.number !== undefined ? String(parsed.data.number) : undefined);
  if (!consecutivo) {
    throw new SiigoRespuestaInvalidaError(
      "Siigo aceptó la factura pero no devolvió consecutivo (name/number)",
      idRecuperado,
    );
  }
  return { id: parsed.data.id, name: consecutivo, date: parsed.data.date };
}

// ─── GET factura por id ──────────────────────────────────────────────────────
//
// Usado por el flujo de "Sincronizar desde Siigo": consulta la factura por su
// id (siigoDraftId) y devuelve el consecutivo + fecha actuales. Si un superior
// ya la estampó en el portal Siigo, el consecutivo será el definitivo (ej.
// BAQ-18453) y `stamp.status` indicará si DIAN la aceptó.

const siigoInvoiceGetSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  number: z.union([z.string(), z.number()]).optional(),
  date: z.string(),
  // Información de estampado DIAN. Presente solo cuando la factura fue
  // procesada por la facturación electrónica. Cuando un superior valida y
  // estampa el draft, este bloque aparece con status="Stamped" (o similar).
  stamp: z
    .object({
      status: z.string().optional(),
      cufe: z.string().optional(),
      cude: z.string().optional(),
    })
    .optional()
    .nullable(),
  // Algunos endpoints devuelven el consecutivo en `prefix` + `consecutive`.
  prefix: z.string().optional(),
  consecutive: z.union([z.string(), z.number()]).optional(),
});

export interface SiigoInvoiceGetResponse {
  id: string;
  /**
   * Consecutivo legible normalizado (ej. "BAQ-18453"). Si Siigo todavía no
   * lo asignó (draft sin estampar), puede venir como provisional o vacío.
   */
  consecutivo: string;
  date: string;
  /** "Stamped" cuando DIAN la aceptó; null/undefined si aún es draft. */
  stampStatus: string | null;
  /** CUFE/CUDE de DIAN cuando ya fue estampada. */
  cufe: string | null;
}

export async function getInvoiceById(
  token: string,
  id: string,
  opciones: OpcionesLlamadaSiigo = {},
): Promise<SiigoInvoiceGetResponse> {
  const { baseUrl } = leerConfig();

  const response = await fetchGetSiigo(
    `${baseUrl}/v1/invoices/${encodeURIComponent(id)}`,
    token,
    opciones,
  );

  if (!response.ok) {
    let detalle = "";
    try {
      const body: unknown = await response.json();
      detalle = typeof body === "string" ? body : ` — ${JSON.stringify(body)}`;
    } catch {
      // body no JSON
    }
    throw new SiigoApiError(
      `Siigo GET /v1/invoices/${id} falló con HTTP ${response.status}${detalle}`,
      response.status,
    );
  }

  const raw: unknown = await response.json();
  const parsed = siigoInvoiceGetSchema.parse(raw);

  // Normalizar consecutivo: name > prefix+consecutive > number
  let consecutivo = parsed.name ?? "";
  if (!consecutivo && parsed.prefix && parsed.consecutive !== undefined) {
    consecutivo = `${parsed.prefix}-${parsed.consecutive}`;
  }
  if (!consecutivo && parsed.number !== undefined) {
    consecutivo = String(parsed.number);
  }

  return {
    id: parsed.id,
    consecutivo,
    date: parsed.date,
    stampStatus: parsed.stamp?.status ?? null,
    cufe: parsed.stamp?.cufe ?? parsed.stamp?.cude ?? null,
  };
}
