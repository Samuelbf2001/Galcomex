/**
 * Cliente HTTP del estado de cuenta con el proveedor (CxP v2, diseño §D.1,
 * paquete P3). Un solo endpoint de lectura: `GET /api/clientes/[id]/cuenta-proveedor`
 * (P1) — ya trae todo lo que la ficha necesita (facturas, pagos, resumen,
 * fichas de pago), serializado con dinero como string ("464077") y fechas de
 * calendario como "YYYY-MM-DD".
 */

import type { EstadoCuentaProveedorJson } from "@/lib/cxp/contratos-api";

export type {
  AjusteFacturaJson,
  EstadoCuentaProveedorJson,
  FilaEstadoCuentaJson,
  PagoDeFacturaJson,
  PagoRealizadoJson,
  ResumenCxpJson,
} from "@/lib/cxp/contratos-api";

export class CxpApiError extends Error {
  status?: number;
  codigo?: string;
  constructor(message: string, status?: number, codigo?: string) {
    super(message);
    this.name = "CxpApiError";
    this.status = status;
    this.codigo = codigo;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mensajeDeError(response: Response, fallback: string): Promise<{ mensaje: string; codigo?: string }> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return { mensaje: payload.error, codigo: typeof payload.codigo === "string" ? payload.codigo : undefined };
    }
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  return { mensaje: fallback };
}

/**
 * `GET /api/clientes/[id]/cuenta-proveedor`. ADMIN y REVISOR reciben la vista
 * COMPLETA (con `resumen` y `pagos`); OPERATIVO recibe SOLO_PENDIENTES
 * (`resumen: null`, `pagos: []`, solo facturas con saldo) — el mismo JSON
 * sirve para los tres roles, la pantalla decide qué mostrar según `vista`.
 */
export async function fetchCuentaProveedor(
  empresaId: string,
  signal?: AbortSignal,
): Promise<EstadoCuentaProveedorJson> {
  const response = await fetch(`/api/clientes/${encodeURIComponent(empresaId)}/cuenta-proveedor`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    const { mensaje, codigo } = await mensajeDeError(response, "No fue posible cargar la cuenta del proveedor.");
    throw new CxpApiError(mensaje, response.status, codigo);
  }

  return (await response.json()) as EstadoCuentaProveedorJson;
}

/**
 * «Enlazar ficha de pago» (solo ADMIN): `POST /api/clientes/[id]/beneficiario/enlazar`.
 * Enlaza a la empresa una ficha suelta con su mismo NIT base (sin adivinar el
 * DV) o le crea una. Idempotente: si ya tenía ficha, la devuelve.
 */
export async function enlazarFichaDePago(empresaId: string): Promise<void> {
  const response = await fetch(`/api/clientes/${encodeURIComponent(empresaId)}/beneficiario/enlazar`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const { mensaje, codigo } = await mensajeDeError(response, `Error ${response.status}`);
    throw new CxpApiError(mensaje, response.status, codigo);
  }
}
