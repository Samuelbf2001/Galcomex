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
  /** Id del DO al que pertenece el asiento (si aplica), para enlazarlo. */
  tramiteId: string | null;
  /** Factura de venta y borrador del asiento (si aplica), para enlazarla con `EnlaceFacturaVenta`. */
  facturaId: string | null;
  borradorId: string | null;
  /** Cruce de saldos al que pertenece (las dos puntas comparten id). */
  compensacionId: string | null;
  /** N° de factura del movimiento manual ("Registrar factura de <proveedor>"). */
  numeroFactura: string | null;
  /** `true` si el movimiento manual tiene un PDF de soporte adjunto. */
  tieneSoporte: boolean;
};

export type CompensablesRow = {
  facturasVenta: { id: string; numSiigo: string; referencia: string | null; pendiente: string }[];
  facturasProveedor: { id: string; numFactura: string; referencia: string; valor: string }[];
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
  /** Pendientes netos por punta: lo que de verdad se puede cruzar. */
  pendienteCliente: string;
  pendienteProveedor: string;
  porLinea: SaldoLineaRow[];
  movimientos: MovimientoCuentaRow[];
  cantidad: number;
  /** Función `cuenta_corriente` encendida para la empresa; apagada, la ficha no muestra la sección. */
  habilitada: boolean;
  permiteCargosManuales: boolean;
  /** Cuánto se puede cruzar hoy (la punta menor). */
  maximoCompensable: string;
  compensables: CompensablesRow;
};

export type NuevaCompensacion = {
  valor?: string;
  fecha: string;
  concepto: string;
  lineaServicio: string;
  facturaId?: string | null;
  facturaProveedorId?: string | null;
};

export type NuevoMovimiento = {
  rol: "CLIENTE" | "PROVEEDOR";
  tipo: "CARGO" | "ABONO";
  origen: "CARGO_MANUAL" | "COMISION" | "AJUSTE";
  lineaServicio: string;
  concepto: string;
  valor: string;
  fecha: string;
  /** N° de la factura del proveedor ("Registrar factura de <proveedor>"). */
  numeroFactura?: string;
  /** PDF de soporte ya subido a la bodega (`POST …/cuenta/soporte`). */
  soporte?: { key: string; nombre: string; mime: string };
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
    pendienteCliente: String(cuenta.pendienteCliente ?? "0"),
    pendienteProveedor: String(cuenta.pendienteProveedor ?? "0"),
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
          tramiteId:
            typeof movimiento.tramiteId === "string" ? movimiento.tramiteId : null,
          facturaId:
            typeof movimiento.facturaId === "string" ? movimiento.facturaId : null,
          borradorId:
            typeof movimiento.borradorId === "string" ? movimiento.borradorId : null,
          compensacionId:
            typeof movimiento.compensacionId === "string" ? movimiento.compensacionId : null,
          numeroFactura:
            typeof movimiento.numeroFactura === "string" ? movimiento.numeroFactura : null,
          tieneSoporte: movimiento.tieneSoporte === true,
        }))
      : [],
    cantidad: typeof cuenta.cantidad === "number" ? cuenta.cantidad : 0,
    habilitada: cuenta.habilitada === true,
    permiteCargosManuales: cuenta.permiteCargosManuales === true,
    maximoCompensable: String(cuenta.maximoCompensable ?? "0"),
    compensables: normalizarCompensables(cuenta.compensables),
  };
}

function normalizarCompensables(value: unknown): CompensablesRow {
  const c = isRecord(value) ? value : {};
  return {
    facturasVenta: Array.isArray(c.facturasVenta)
      ? c.facturasVenta.filter(isRecord).map((f) => ({
          id: String(f.id ?? ""),
          numSiigo: String(f.numSiigo ?? ""),
          referencia: typeof f.referencia === "string" ? f.referencia : null,
          pendiente: String(f.pendiente ?? "0"),
        }))
      : [],
    facturasProveedor: Array.isArray(c.facturasProveedor)
      ? c.facturasProveedor.filter(isRecord).map((f) => ({
          id: String(f.id ?? ""),
          numFactura: String(f.numFactura ?? ""),
          referencia: String(f.referencia ?? ""),
          valor: String(f.valor ?? "0"),
        }))
      : [],
  };
}

export async function registrarCompensacion(
  clienteId: string,
  compensacion: NuevaCompensacion,
): Promise<CuentaCorriente | null> {
  const response = await fetch(`/api/clientes/${clienteId}/cuenta/compensaciones`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(compensacion),
  });

  if (!response.ok) {
    throw new CuentaApiError(
      await mensajeDeError(response, "No fue posible registrar el cruce."),
      response.status,
    );
  }

  return normalizar(await response.json());
}

export async function eliminarCompensacion(
  clienteId: string,
  compensacionId: string,
): Promise<CuentaCorriente | null> {
  const response = await fetch(
    `/api/clientes/${clienteId}/cuenta/compensaciones/${encodeURIComponent(compensacionId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );

  if (!response.ok) {
    throw new CuentaApiError(
      await mensajeDeError(response, "No fue posible deshacer el cruce."),
      response.status,
    );
  }

  return normalizar(await response.json());
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
