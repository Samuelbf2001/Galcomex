/**
 * Cliente HTTP de la cuenta corriente por contraparte (M5).
 * BigInt serializado como string desde el backend.
 */

export type MovimientoCuentaRow = {
  id: string;
  fuente: string;
  lineaServicio: string;
  concepto: string;
  fecha: string;
  valor: string; // BigInt serializado, con signo
  referencia: string | null;
};

export type SaldoLineaRow = {
  lineaServicio: string;
  aCargo: string;
  aFavor: string;
  neto: string;
};

export type CuentaCorriente = {
  empresa: { id: string; nombre: string; nit: string; esCliente: boolean; esProveedor: boolean };
  totalACargo: string;
  totalAFavor: string;
  neto: string;
  porLinea: SaldoLineaRow[];
  movimientos: MovimientoCuentaRow[];
  cantidad: number;
  permiteCargosManuales: boolean;
};

export type NuevoMovimiento = {
  rol: "CLIENTE" | "PROVEEDOR";
  tipo: "CARGO" | "ABONO";
  origen: "CARGO_MANUAL" | "COMISION" | "AJUSTE";
  lineaServicio: string;
  concepto: string;
  valor: string;
  fecha: string;
};

export class CuentaApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CuentaApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mensajeDeError(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  return fallback;
}

function normalizar(payload: unknown): CuentaCorriente | null {
  if (!isRecord(payload) || !isRecord(payload.cuenta)) {
    return null;
  }

  const cuenta = payload.cuenta;
  const empresa = isRecord(cuenta.empresa) ? cuenta.empresa : {};

  return {
    empresa: {
      id: String(empresa.id ?? ""),
      nombre: String(empresa.nombre ?? ""),
      nit: String(empresa.nit ?? ""),
      esCliente: empresa.esCliente !== false,
      esProveedor: empresa.esProveedor === true,
    },
    totalACargo: String(cuenta.totalACargo ?? "0"),
    totalAFavor: String(cuenta.totalAFavor ?? "0"),
    neto: String(cuenta.neto ?? "0"),
    porLinea: Array.isArray(cuenta.porLinea)
      ? cuenta.porLinea.filter(isRecord).map((linea) => ({
          lineaServicio: String(linea.lineaServicio ?? ""),
          aCargo: String(linea.aCargo ?? "0"),
          aFavor: String(linea.aFavor ?? "0"),
          neto: String(linea.neto ?? "0"),
        }))
      : [],
    movimientos: Array.isArray(cuenta.movimientos)
      ? cuenta.movimientos.filter(isRecord).map((movimiento) => ({
          id: String(movimiento.id ?? ""),
          fuente: String(movimiento.fuente ?? ""),
          lineaServicio: String(movimiento.lineaServicio ?? ""),
          concepto: String(movimiento.concepto ?? ""),
          fecha: typeof movimiento.fecha === "string" ? movimiento.fecha : "",
          valor: String(movimiento.valor ?? "0"),
          referencia:
            typeof movimiento.referencia === "string" ? movimiento.referencia : null,
        }))
      : [],
    cantidad: typeof cuenta.cantidad === "number" ? cuenta.cantidad : 0,
    permiteCargosManuales: cuenta.permiteCargosManuales === true,
  };
}

export async function fetchCuentaCorriente(
  clienteId: string,
  signal?: AbortSignal,
): Promise<CuentaCorriente | null> {
  const response = await fetch(`/api/clientes/${clienteId}/cuenta`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (response.status === 403) {
    // La cuenta corriente es de ADMIN/REVISOR: para otros roles no es un error.
    return null;
  }

  if (!response.ok) {
    throw new CuentaApiError(
      await mensajeDeError(response, "No fue posible cargar la cuenta corriente."),
      response.status,
    );
  }

  return normalizar(await response.json());
}

export async function registrarMovimiento(
  clienteId: string,
  movimiento: NuevoMovimiento,
): Promise<CuentaCorriente | null> {
  const response = await fetch(`/api/clientes/${clienteId}/cuenta`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(movimiento),
  });

  if (!response.ok) {
    throw new CuentaApiError(
      await mensajeDeError(response, "No fue posible registrar el movimiento."),
      response.status,
    );
  }

  return normalizar(await response.json());
}
