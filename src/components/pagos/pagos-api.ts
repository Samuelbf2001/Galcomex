/**
 * Helpers de API para el módulo de Pagos (libro de pagos del DO).
 * Patrón idéntico a tramites-api.ts.
 * BigInt serializado como string desde el backend — parsear con BigInt().
 */

export type CanalPago =
  | "TRANSF_BANCOLOMBIA"
  | "PSE"
  | "TRANSF_OTROS_BANCOS";

export const CANALES_PAGO: { value: CanalPago; label: string }[] = [
  { value: "TRANSF_BANCOLOMBIA",  label: "Transf. Bancolombia" },
  { value: "PSE",                 label: "PSE" },
  { value: "TRANSF_OTROS_BANCOS", label: "Transf. Otros Bancos" },
];

export type BeneficiarioMinimo = {
  id: string;
  nombre: string;
  nit: string | null;
};

export type EstadoMovimiento = "BORRADOR" | "REALIZADO" | "VERIFICADO";

export type FacturaPagoLink = {
  facturaId: string;
  numFactura: string;
  proveedorNombre: string;
};

export type PagoRow = {
  id: string;
  tramiteId: string;
  concepto: string;
  /** Lista de beneficiarios vinculados (N↔N). */
  beneficiarios: BeneficiarioMinimo[];
  numSoporte: string | null;
  valor: string; // BigInt serializado
  canalPago: CanalPago;
  costoBancario: string; // BigInt serializado
  orden: number;
  fechaRealPago: string | null; // ISO string
  estado: EstadoMovimiento;
  /** Facturas de proveedor vinculadas (N↔N) */
  facturasProveedor: FacturaPagoLink[];
  /** Si true, el pago fue hecho en efectivo a través del socio Lucho/LM */
  viaSocio: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AplicacionRow = {
  id: string;
  montoAplicado: string; // BigInt serializado
  anticipo: {
    id: string;
    monto: string;
    fecha: string;
    tipoRecaudo: string;
    costoRecaudo: string;
    verificadoBanco: boolean;
    costoBancario: string; // alias de costoRecaudo para compatibilidad UI
  };
};

export type LibroPagosData = {
  pagos: PagoRow[];
  aplicaciones: AplicacionRow[];
  totalPagos: string;
  costosBancarios: string;
  costosBancariosAnticipo: string;
  totalAnticipoAplicado: string;
  saldos: string[];
  saldoFinal: string;
};

export type TramiteDetail = {
  id: string;
  consecutivo: string;
  estado: string;
  eta: string | null;
  cliente: {
    id: string;
    nombre: string;
    nit: string;
  };
};

export type CreatePagoInput = {
  concepto: string;
  /** IDs de beneficiarios (N↔N). */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  valor: string; // BigInt as string
  canalPago: CanalPago;
  fechaRealPago?: string | null;
  /** IDs de facturas de proveedor a vincular (N↔N). */
  facturaProveedorIds?: string[];
};

/**
 * Tipo mínimo de factura de proveedor necesario para el selector en NuevoPagoModal.
 * Refleja los campos que usa el componente; el tipo completo vive en facturas-proveedor-api.ts.
 */
export type FacturaProveedorOpcion = {
  id: string;
  numFactura: string;
  proveedorNombre: string;
  valor: string;  // BigInt serializado
  estado: string; // "REGISTRADA" | "PAGADA" | "FACTURADA_CLIENTE"
};

/**
 * Obtiene las facturas de proveedor de un trámite.
 * Usa el mismo endpoint GET /api/tramites/{id}/facturas-proveedor que el módulo de FPs.
 */
export async function fetchFacturasProveedorTramite(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<FacturaProveedorOpcion[]> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites/${tramiteId}/facturas-proveedor`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con la API de facturas de proveedor.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.facturas)) {
    throw new PagosApiError("Respuesta de facturas de proveedor no válida.");
  }

  return (payload.facturas as unknown[]).filter(isRecord).map(
    (f): FacturaProveedorOpcion => ({
      id: String(f.id ?? ""),
      numFactura: String(f.numFactura ?? ""),
      proveedorNombre: String(f.proveedorNombre ?? ""),
      valor: String(f.valor ?? "0"),
      estado: String(f.estado ?? ""),
    }),
  );
}

export type UpdatePagoInput = {
  concepto?: string;
  /** Si se provee, reemplaza todos los beneficiarios vinculados. */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  valor?: string; // BigInt as string
  canalPago?: CanalPago;
  fechaRealPago?: string | null;
};

export class PagosApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "PagosApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // ignore
  }
  return `Error ${response.status}`;
}

export async function fetchTramiteDetail(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<TramiteDetail> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites/${tramiteId}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con /api/tramites.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new PagosApiError("Respuesta de tramite no válida.");
  }

  const t = payload.tramite;
  const cliente = isRecord(t.cliente) ? t.cliente : {};

  return {
    id: String(t.id ?? ""),
    consecutivo: String(t.consecutivo ?? ""),
    estado: String(t.estado ?? ""),
    eta: typeof t.eta === "string" ? t.eta : null,
    cliente: {
      id: String(cliente.id ?? ""),
      nombre: String(cliente.nombre ?? ""),
      nit: String(cliente.nit ?? ""),
    },
  };
}

function parsePagoRow(p: Record<string, unknown>): PagoRow {
  return {
    id: String(p.id ?? ""),
    tramiteId: String(p.tramiteId ?? ""),
    concepto: String(p.concepto ?? ""),
    beneficiarios: (() => {
      const raw = Array.isArray(p.beneficiarios) ? p.beneficiarios : [];
      return raw.filter(isRecord).map((link) => {
        const b = isRecord(link.beneficiario) ? link.beneficiario : link;
        return {
          id: String(b.id ?? ""),
          nombre: String(b.nombre ?? ""),
          nit: typeof b.nit === "string" ? b.nit : null,
        };
      });
    })(),
    numSoporte: typeof p.numSoporte === "string" ? p.numSoporte : null,
    valor: String(p.valor ?? "0"),
    canalPago: (p.canalPago as CanalPago) ?? "TRANSF_BANCOLOMBIA",
    costoBancario: String(p.costoBancario ?? "0"),
    orden: typeof p.orden === "number" ? p.orden : 0,
    fechaRealPago: typeof p.fechaRealPago === "string" ? p.fechaRealPago : null,
    estado: (p.estado as EstadoMovimiento) ?? "REALIZADO",
    facturasProveedor: (() => {
      const raw = Array.isArray(p.facturasProveedor) ? p.facturasProveedor : [];
      return raw.filter(isRecord).map((link) => {
        const factura = isRecord(link.factura) ? link.factura : link;
        return {
          facturaId: String(link.facturaId ?? factura.id ?? ""),
          numFactura: String(factura.numFactura ?? ""),
          proveedorNombre: String(
            isRecord(factura.beneficiario)
              ? (factura.beneficiario.nombre ?? factura.proveedorNombre ?? "")
              : (factura.proveedorNombre ?? ""),
          ),
        };
      });
    })(),
    viaSocio: p.viaSocio === true,
    createdAt: String(p.createdAt ?? ""),
    updatedAt: String(p.updatedAt ?? ""),
  };
}

export async function fetchLibroPagos(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<LibroPagosData> {
  let response: Response;

  try {
    response = await fetch(`/api/tramites/${tramiteId}/pagos`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PagosApiError("No fue posible conectar con la API de pagos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new PagosApiError("Respuesta de pagos no válida.");
  }

  const rawPagos = Array.isArray(payload.pagos) ? payload.pagos : [];
  const rawAplicaciones = Array.isArray(payload.aplicaciones) ? payload.aplicaciones : [];

  const pagos: PagoRow[] = rawPagos.filter(isRecord).map(parsePagoRow);

  const aplicaciones: AplicacionRow[] = rawAplicaciones.filter(isRecord).map(
    (a): AplicacionRow => {
      const ant = isRecord(a.anticipo) ? a.anticipo : {};
      const costoRecaudo = String(ant.costoRecaudo ?? ant.costoBancario ?? "0");
      return {
        id: String(a.id ?? ""),
        montoAplicado: String(a.montoAplicado ?? "0"),
        anticipo: {
          id: String(ant.id ?? ""),
          monto: String(ant.monto ?? "0"),
          fecha: typeof ant.fecha === "string" ? ant.fecha : "",
          tipoRecaudo: String(ant.tipoRecaudo ?? ""),
          costoRecaudo,
          verificadoBanco: ant.verificadoBanco === true,
          costoBancario: costoRecaudo,
        },
      };
    },
  );

  return {
    pagos,
    aplicaciones,
    totalPagos: String(payload.totalPagos ?? "0"),
    costosBancarios: String(payload.costosBancarios ?? "0"),
    costosBancariosAnticipo: String(payload.costosBancariosAnticipo ?? "0"),
    totalAnticipoAplicado: String(payload.totalAnticipoAplicado ?? "0"),
    saldos: Array.isArray(payload.saldos) ? payload.saldos.map(String) : [],
    saldoFinal: String(payload.saldoFinal ?? "0"),
  };
}

export async function createPago(
  tramiteId: string,
  input: CreatePagoInput,
): Promise<PagoRow> {
  const response = await fetch(`/api/tramites/${tramiteId}/pagos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el pago (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.pago)) {
    throw new PagosApiError("Respuesta de creación no válida.");
  }

  return parsePagoRow(payload.pago);
}

export async function updatePago(
  tramiteId: string,
  pagoId: string,
  input: UpdatePagoInput,
): Promise<PagoRow> {
  const response = await fetch(`/api/tramites/${tramiteId}/pagos/${pagoId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible actualizar el pago (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.pago)) {
    throw new PagosApiError("Respuesta de actualización no válida.");
  }

  return parsePagoRow(payload.pago);
}

export async function deletePago(
  tramiteId: string,
  pagoId: string,
): Promise<void> {
  const response = await fetch(`/api/tramites/${tramiteId}/pagos/${pagoId}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });

  if (!response.ok && response.status !== 204) {
    const msg = await parseErrorMessage(response);
    throw new PagosApiError(msg, response.status);
  }
}

export async function verificarMovimientoPago(
  tramiteId: string,
  pagoId: string,
  estado: EstadoMovimiento,
): Promise<PagoRow> {
  const response = await fetch(`/api/tramites/${tramiteId}/pagos/${pagoId}/verificar`, {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ estado }),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible verificar el pago (${response.status}).`;
    throw new PagosApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.pago)) {
    throw new PagosApiError("Respuesta de verificación no válida.");
  }

  return parsePagoRow(payload.pago);
}

/** Formatea BigInt serializado como COP: $45.226.000 */
export function formatCOP(value: string): string {
  try {
    const n = BigInt(value);
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return value;
  }
}

/**
 * Recalcula los saldos intermedios del libro de pagos en el cliente.
 * saldo[i] = totalAnticipoAplicado − Σ(valores[0..i])
 * Exactamente la misma lógica que calcularSaldosIntermedios() del motor.
 */
export function calcularSaldosCliente(
  totalAnticipoAplicado: string,
  valores: string[],
): string[] {
  let saldo = BigInt(totalAnticipoAplicado);
  return valores.map((v) => {
    saldo -= BigInt(v);
    return saldo.toString();
  });
}
