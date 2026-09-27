/**
 * Helpers de API para fichas de pago (`Beneficiario`, CxP v2 §D.6). NIT y DV
 * en campos separados; alta rápida desde el combo con avisos de duplicado.
 */

export type BeneficiarioRow = {
  id: string;
  nombre: string;
  /** "800154017-8" (con DV, si venía separado) o tal cual se digitó. */
  nit: string | null;
  /** NIT sin DV, calculado por el trigger. null = no es NIT colombiano. */
  nitBase: string | null;
  banco: string | null;
  numCuenta: string | null;
  /** Nombre como sale en la línea de terceros de la factura de venta ("ALMACARGA"). */
  nombreCorto: string | null;
  /** "Numerar sus facturas como FE 11298". */
  numFacturaConEspacio: boolean;
  /** RF-23: su cartera aún no se cruzó contra el Excel de Camila. */
  conciliacionPendiente: boolean;
};

export type BeneficiarioResumen = { id: string; nombre: string; nit: string | null };

export class BeneficiarioApiError extends Error {
  status?: number;
  /** Código del error de CxP (§B.7): NIT_DV_INVALIDO, BENEFICIARIO_EXISTE, POSIBLE_BENEFICIARIO_DUPLICADO… */
  codigo?: string;
  detalles?: unknown;
  constructor(message: string, status?: number, codigo?: string, detalles?: unknown) {
    super(message);
    this.name = "BeneficiarioApiError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapBeneficiario(b: Record<string, unknown>): BeneficiarioRow {
  return {
    id: String(b.id ?? ""),
    nombre: String(b.nombre ?? ""),
    nit: typeof b.nit === "string" ? b.nit : null,
    nitBase: typeof b.nitBase === "string" ? b.nitBase : null,
    banco: typeof b.banco === "string" ? b.banco : null,
    numCuenta: typeof b.numCuenta === "string" ? b.numCuenta : null,
    nombreCorto: typeof b.nombreCorto === "string" ? b.nombreCorto : null,
    numFacturaConEspacio: b.numFacturaConEspacio === true,
    conciliacionPendiente: b.conciliacionPendiente === true,
  };
}

async function leerError(response: Response): Promise<BeneficiarioApiError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // ignore
  }
  const mensaje =
    isRecord(payload) && typeof payload.error === "string" ? payload.error : `Error ${response.status}`;
  const codigo = isRecord(payload) && typeof payload.codigo === "string" ? payload.codigo : undefined;
  const detalles = isRecord(payload) ? payload.detalles : undefined;
  return new BeneficiarioApiError(mensaje, response.status, codigo, detalles);
}

export async function fetchBeneficiarios(
  query?: string,
  signal?: AbortSignal,
): Promise<BeneficiarioRow[]> {
  const url = new URL("/api/beneficiarios", window.location.origin);
  if (query) url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.beneficiarios)) {
    throw new BeneficiarioApiError("Respuesta de beneficiarios no válida.");
  }

  return (payload.beneficiarios as unknown[]).filter(isRecord).map(mapBeneficiario);
}

export type BeneficiarioInput = {
  nombre?: string;
  /** NIT sin DV (o con el DV pegado con guion). Cédulas y extranjeros: sin DV. */
  nit?: string | null;
  /** Dígito de verificación (0-9). Si no cuadra con el NIT → `NIT_DV_INVALIDO`. */
  dv?: number | string | null;
  banco?: string | null;
  numCuenta?: string | null;
  empresaId?: string | null;
  nombreCorto?: string | null;
  numFacturaConEspacio?: boolean;
  /** Reenvío tras 409 `POSIBLE_BENEFICIARIO_DUPLICADO` ("Es otra, crearla"). */
  confirmarOtraFicha?: boolean;
  /** Solo ADMIN: crear otra ficha con el MISMO NIT (otra cuenta bancaria del mismo proveedor). */
  otraCuentaMismoProveedor?: boolean;
};

export async function updateBeneficiario(
  id: string,
  input: BeneficiarioInput,
): Promise<BeneficiarioRow> {
  const response = await fetch(`/api/beneficiarios/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.beneficiario)) {
    throw new BeneficiarioApiError("Respuesta de actualización no válida.");
  }

  return mapBeneficiario(payload.beneficiario);
}

export async function createBeneficiario(input: BeneficiarioInput): Promise<BeneficiarioRow> {
  const response = await fetch("/api/beneficiarios", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw await leerError(response);

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.beneficiario)) {
    throw new BeneficiarioApiError("Respuesta de creación no válida.");
  }

  return mapBeneficiario(payload.beneficiario);
}

/** Extrae `detalles.existente` (BENEFICIARIO_EXISTE) o el primero de `detalles.existentes` (POSIBLE_BENEFICIARIO_DUPLICADO). */
export function existenteDeDetalles(detalles: unknown): BeneficiarioResumen | null {
  if (!isRecord(detalles)) return null;
  const uno = isRecord(detalles.existente) ? detalles.existente : null;
  const lista = Array.isArray(detalles.existentes) ? detalles.existentes.find(isRecord) : null;
  const fuente = uno ?? lista;
  if (!fuente) return null;
  return {
    id: String(fuente.id ?? ""),
    nombre: String(fuente.nombre ?? ""),
    nit: typeof fuente.nit === "string" ? fuente.nit : null,
  };
}
