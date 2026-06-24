/**
 * Helpers de API para la sección "Configuración de envío Siigo".
 */

export type ClaveSiigo =
  | "SIIGO_TIPO_COMPROBANTE_ID"
  | "SIIGO_VENDEDOR_ID"
  | "SIIGO_PRODUCTO_COMISION_ID"
  | "SIIGO_FORMA_PAGO_DEFAULT_ID"
  | "SIIGO_PRODUCTO_4X1000_ID"
  | "SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID";

export type ParametroSiigoRow = {
  clave: ClaveSiigo;
  valor: string | null;
  descripcion: string | null;
  updatedAt: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function fetchParametrosSiigo(): Promise<ParametroSiigoRow[]> {
  const response = await fetch("/api/configuracion/siigo/parametros", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("No fue posible cargar los parámetros Siigo.");
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.parametros)) return [];
  return (payload.parametros as unknown[])
    .filter(isRecord)
    .map((p) => ({
      clave: p.clave as ClaveSiigo,
      valor: typeof p.valor === "string" ? p.valor : null,
      descripcion: typeof p.descripcion === "string" ? p.descripcion : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    }));
}

export type GuardarResult =
  | { ok: true; actualizados: ClaveSiigo[] }
  | { ok: false; error: string };

export async function guardarParametrosSiigo(
  parametros: Array<{ clave: ClaveSiigo; valor: string }>,
): Promise<GuardarResult> {
  const response = await fetch("/api/configuracion/siigo/parametros", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ parametros }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `Error al guardar (${response.status}).`;
    return { ok: false, error };
  }
  if (isRecord(payload) && Array.isArray(payload.actualizados)) {
    return {
      ok: true,
      actualizados: payload.actualizados as ClaveSiigo[],
    };
  }
  return { ok: false, error: "Respuesta inesperada del servidor." };
}

