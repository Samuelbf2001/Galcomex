/**
 * Helpers de API para el módulo de Pagos (libro de pagos del DO).
 * Patrón idéntico a tramites-api.ts.
 * Dinero: pesos como texto con 2 decimales desde el backend (fase CENTAVOS,
 * diseño §A.2) — parsear con `centavosDeTextoApi` de `@/lib/dinero`.
 */

import { centavosDeTexto, centavosDeTextoApi, formatoPesos, textoDeCentavos } from "@/lib/dinero";

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

/** Otro DO del mismo grupoPagoId (pago multi-DO) — para el badge "Pago multi-DO". */
export type GrupoPagoDOInfo = { tramiteId: string; consecutivo: string };

/** Mismos valores que el enum Prisma `CostoBancarioAsumidoPor` (CxP v2). */
export type CostoAsumidoPor = "GALCOMEX" | "PRIMER_DO" | "PRORRATEADO";

/** Una factura cubierta por el pago, con el monto aplicado (CxP v2, §D.4). */
export type AplicacionDePagoRow = {
  facturaId: string;
  numFactura: string;
  /** "FE 12481" según la ficha del proveedor. */
  numFacturaVisible: string;
  monto: string; // BigInt serializado
};

/** Cabecera del pago en bloque, vista desde una de sus filas (CxP v2, §D.4). */
export type GrupoDePagoRow = {
  estado: "ACTIVO" | "ANULADO";
  costoBancario: string; // BigInt serializado
  costoAsumidoPor: CostoAsumidoPor;
  esHistorico: boolean;
  otrosDOs: GrupoPagoDOInfo[];
};

export type PagoRow = {
  id: string;
  tramiteId: string;
  concepto: string;
  /** Lista de beneficiarios vinculados (N↔N). */
  beneficiarios: BeneficiarioMinimo[];
  numSoporte: string | null;
  /** Comprobante bancario — el que vale ante reclamos. null = sin comprobante (no bloquea). */
  documentoId: string | null;
  /** true cuando falta el comprobante bancario — dispara el distintivo "Falta comprobante". Derivado por el backend. */
  faltaComprobante: boolean;
  /** Comprobante de la página del comercio (puerto/PSE) — opcional. */
  comprobanteComercioId: string | null;
  /** Id del grupo de pago multi-DO (null = pago normal de un solo DO). */
  grupoPagoId: string | null;
  /** Otros DOs del mismo grupoPagoId (vacío si no es un pago multi-DO). */
  grupoOtrosDOs: GrupoPagoDOInfo[];
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
  /** Banco usado como tercero del 4x1000 (null = sin banco asignado). */
  bancoBeneficiario: BeneficiarioMinimo | null;
  /** true si el puente pago↔factura tiene al menos una aplicación (CxP v2). */
  tieneFacturas: boolean;
  /** true si el pago es parte de un bloque (`grupoPagoId` no nulo). */
  esBloque: boolean;
  /** false = valor y canal de solo lectura (pago con facturas o de un bloque): anula y registra de nuevo. */
  editableDinero: boolean;
  /** Facturas cubiertas por este pago, con el monto aplicado a cada una. */
  aplicaciones: AplicacionDePagoRow[];
  /** Cabecera del bloque si `esBloque`; null en un pago suelto. */
  grupo: GrupoDePagoRow | null;
  /**
   * Solo en el libro del DO: parte del valor que asume Galcomex porque pagó
   * facturas NO SE COBRA (asesoría). "0" en pagos sueltos o 100 % cobrables.
   * Ausente = la respuesta no lo trae (se trata como "0").
   */
  noCobrable?: string;
  /** Solo en el libro del DO: costo bancario que se le cobra al cliente. */
  costoBancarioCobrable?: string;
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

/**
 * Cruce real con el cliente, derivado del borrador APROBADO/FACTURADO más
 * reciente. El cruce siempre se calcula contra el TOTAL de la factura de venta
 * (Σ líneas + comisión + IVA − retenciones), nunca contra Σ pagos.
 * Ver memoria `project_cruce_factura.md`.
 */
export type CruceFacturaRow = {
  estado: "APROBADO" | "FACTURADO";
  numSiigo: string | null;
  totalFactura: string; // BigInt as string
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
};

export type LibroPagosData = {
  pagos: PagoRow[];
  aplicaciones: AplicacionRow[];
  /** Σ valor de todos los pagos (lo que salió del banco). */
  totalPagos: string;
  costosBancarios: string;
  /** Σ lo que se le cobra al cliente (sin la asesoría NO SE COBRA). */
  totalPagosCobrables: string;
  /** Σ lo que asume Galcomex (asesoría NO SE COBRA). */
  totalNoCobrable: string;
  /** Σ costo bancario que se le cobra al cliente. */
  costosBancariosCobrables: string;
  costosBancariosAnticipo: string;
  totalAnticipoAplicado: string;
  saldos: string[];
  saldoFinal: string;
  cruceFactura: CruceFacturaRow | null;
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

/** Cuánto de este pago va a una factura (CxP v2, §D.4; Σ = valor). */
export type AplicacionPagoInput = { facturaProveedorId: string; monto: string };

export type CreatePagoInput = {
  concepto: string;
  /** IDs de beneficiarios (N↔N). */
  beneficiarioIds?: string[];
  numSoporte?: string | null;
  /** Comprobante bancario — opcional, no bloquea el pago. */
  documentoId?: string | null;
  /** Comprobante de la página del comercio (puerto/PSE) — opcional. */
  comprobanteComercioId?: string | null;
  valor: string; // BigInt as string
  canalPago: CanalPago;
  fechaRealPago?: string | null;
  /** CxP v2: cuánto de este pago va a cada factura (Σ = valor). Preferida sobre `facturaProveedorIds`. */
  aplicaciones?: AplicacionPagoInput[];
  /** Entrada heredada (reparto FIFO): no se combina con `aplicaciones`. */
  facturaProveedorIds?: string[];
  /** Banco (Beneficiario) usado como tercero del 4x1000. null/omitido = auto. */
  bancoBeneficiarioId?: string | null;
  /** Pago en efectivo del socio. */
  viaSocio?: boolean;
  /** Idempotencia: UUID que genera la pantalla al abrir el formulario. */
  claveIdempotencia?: string | null;
};

/**
 * Factura de proveedor con su saldo, para el selector del pago simple
 * (`NuevoPagoModal`, CxP v2 §D.4): solo se pueden marcar las que tienen saldo.
 */
export type FacturaProveedorOpcion = {
  id: string;
  numFactura: string;
  /** "FE 12481" según la ficha del proveedor. */
  numFacturaVisible: string;
  proveedorNombre: string;
  valor: string; // BigInt serializado
  saldo: string; // BigInt serializado
  etiqueta: "Pendiente" | "Abonada" | "Pagada" | "Cruzada" | "Pagada con ajuste";
  estado: string; // "REGISTRADA" | "PARCIAL" | "PAGADA" | "FACTURADA_CLIENTE"
  beneficiarioId: string | null;
  beneficiarioNit: string | null;
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
    (f): FacturaProveedorOpcion => {
      const ben = isRecord(f.beneficiario) ? f.beneficiario : null;
      return {
        id: String(f.id ?? ""),
        numFactura: String(f.numFactura ?? ""),
        numFacturaVisible: String(f.numFacturaVisible ?? f.numFactura ?? ""),
        proveedorNombre: String(f.proveedorNombre ?? ""),
        valor: String(f.valor ?? "0"),
        saldo: String(f.saldo ?? f.valor ?? "0"),
        etiqueta: (f.etiqueta as FacturaProveedorOpcion["etiqueta"]) ?? "Pendiente",
        estado: String(f.estado ?? ""),
        beneficiarioId: ben && typeof ben.id === "string" ? ben.id : (typeof f.beneficiarioId === "string" ? f.beneficiarioId : null),
        beneficiarioNit: ben && typeof ben.nit === "string" ? ben.nit : null,
      };
    },
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
  /** Banco para 4x1000. null limpia, undefined deja como está. */
  bancoBeneficiarioId?: string | null;
  /** Comprobante bancario. null limpia, undefined deja como está. */
  documentoId?: string | null;
  /** Comprobante de comercio (puerto/PSE), opcional. null limpia, undefined deja como está. */
  comprobanteComercioId?: string | null;
};

export class PagosApiError extends Error {
  status?: number;
  /** Código del error de CxP (§B.7), p. ej. "FACTURA_SIN_SALDO", "IDEMPOTENCIA_CONFLICTO". */
  codigo?: string;
  detalles?: unknown;

  constructor(message: string, status?: number, codigo?: string, detalles?: unknown) {
    super(message);
    this.name = "PagosApiError";
    this.status = status;
    this.codigo = codigo;
    this.detalles = detalles;
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

export function parsePagoRow(p: Record<string, unknown>): PagoRow {
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
    documentoId: typeof p.documentoId === "string" ? p.documentoId : null,
    // Preferir el booleano derivado del backend; si no viaja (respuesta vieja
    // en caché), deducirlo de documentoId como respaldo.
    faltaComprobante:
      typeof p.faltaComprobante === "boolean"
        ? p.faltaComprobante
        : !(typeof p.documentoId === "string"),
    comprobanteComercioId:
      typeof p.comprobanteComercioId === "string" ? p.comprobanteComercioId : null,
    grupoPagoId: typeof p.grupoPagoId === "string" ? p.grupoPagoId : null,
    grupoOtrosDOs: (() => {
      const raw = Array.isArray(p.grupoOtrosDOs) ? p.grupoOtrosDOs : [];
      return raw.filter(isRecord).map((g) => ({
        tramiteId: String(g.tramiteId ?? ""),
        consecutivo: String(g.consecutivo ?? ""),
      }));
    })(),
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
    bancoBeneficiario: (() => {
      if (!isRecord(p.bancoBeneficiario)) return null;
      const b = p.bancoBeneficiario;
      return {
        id: String(b.id ?? ""),
        nombre: String(b.nombre ?? ""),
        nit: typeof b.nit === "string" ? b.nit : null,
      };
    })(),
    tieneFacturas: p.tieneFacturas === true,
    esBloque: p.esBloque === true,
    // Sin el campo (respuesta vieja en caché): editable solo si de verdad no
    // tiene ni facturas ni bloque (el lado seguro para no permitir romper R2).
    editableDinero:
      typeof p.editableDinero === "boolean" ? p.editableDinero : p.tieneFacturas !== true && p.esBloque !== true,
    aplicaciones: (() => {
      const raw = Array.isArray(p.aplicaciones) ? p.aplicaciones : [];
      return raw.filter(isRecord).map(
        (a): AplicacionDePagoRow => ({
          facturaId: String(a.facturaId ?? ""),
          numFactura: String(a.numFactura ?? ""),
          numFacturaVisible: String(a.numFacturaVisible ?? a.numFactura ?? ""),
          monto: String(a.monto ?? "0"),
        }),
      );
    })(),
    grupo: (() => {
      if (!isRecord(p.grupo)) return null;
      const g = p.grupo;
      const otros = Array.isArray(g.otrosDOs) ? g.otrosDOs : [];
      return {
        estado: g.estado === "ANULADO" ? "ANULADO" : "ACTIVO",
        costoBancario: String(g.costoBancario ?? "0"),
        costoAsumidoPor: (g.costoAsumidoPor as CostoAsumidoPor) ?? "PRIMER_DO",
        esHistorico: g.esHistorico === true,
        otrosDOs: otros.filter(isRecord).map((o) => ({
          tramiteId: String(o.tramiteId ?? ""),
          consecutivo: String(o.consecutivo ?? ""),
        })),
      };
    })(),
    ...(p.noCobrable !== undefined ? { noCobrable: String(p.noCobrable) } : {}),
    ...(p.costoBancarioCobrable !== undefined
      ? { costoBancarioCobrable: String(p.costoBancarioCobrable) }
      : {}),
    createdAt: String(p.createdAt ?? ""),
    updatedAt: String(p.updatedAt ?? ""),
  };
}

/**
 * Lo que el pago le descuenta al saldo del CLIENTE: su valor menos lo que
 * asume Galcomex (asesoría NO SE COBRA). Igual que el borrador. `valor` es el
 * de la fila (puede venir editado); lo no cobrable solo existe en pagos con
 * facturas, cuyo valor no se edita.
 * Entrada: pesos-texto TOLERANTE (API "650000.00" o canónico de `CampoMoneda`
 * "650000.45"); salida: pesos-texto de la API (2 decimales), lista para
 * `calcularSaldosCliente`.
 */
export function valorParaSaldoCliente(valor: string, noCobrable: string | undefined): string {
  return textoDeCentavos(centavosDeTexto(valor) - centavosDeTexto(noCobrable ?? "0"));
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

  const cruceRaw = payload.cruceFactura;
  const cruceFactura: CruceFacturaRow | null = isRecord(cruceRaw)
    ? {
        estado: cruceRaw.estado === "FACTURADO" ? "FACTURADO" : "APROBADO",
        numSiigo: typeof cruceRaw.numSiigo === "string" ? cruceRaw.numSiigo : null,
        totalFactura: String(cruceRaw.totalFactura ?? "0"),
        saldoAFavorCliente: String(cruceRaw.saldoAFavorCliente ?? "0"),
        saldoACargoCliente: String(cruceRaw.saldoACargoCliente ?? "0"),
      }
    : null;

  return {
    pagos,
    aplicaciones,
    totalPagos: String(payload.totalPagos ?? "0"),
    costosBancarios: String(payload.costosBancarios ?? "0"),
    // Respuesta sin los campos (vieja en caché): todo se cobra.
    totalPagosCobrables: String(payload.totalPagosCobrables ?? payload.totalPagos ?? "0.00"),
    totalNoCobrable: String(payload.totalNoCobrable ?? "0.00"),
    costosBancariosCobrables: String(payload.costosBancariosCobrables ?? payload.costosBancarios ?? "0.00"),
    costosBancariosAnticipo: String(payload.costosBancariosAnticipo ?? "0"),
    totalAnticipoAplicado: String(payload.totalAnticipoAplicado ?? "0"),
    saldos: Array.isArray(payload.saldos) ? payload.saldos.map(String) : [],
    saldoFinal: String(payload.saldoFinal ?? "0"),
    cruceFactura,
  };
}

export async function createPago(
  tramiteId: string,
  input: CreatePagoInput,
): Promise<PagoRow & { repetido: boolean }> {
  const response = await fetch(`/api/tramites/${tramiteId}/pagos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const codigo = isRecord(payload) && typeof payload.codigo === "string" ? payload.codigo : undefined;
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el pago (${response.status}).`;
    throw new PagosApiError(message, response.status, codigo, isRecord(payload) ? payload.detalles : undefined);
  }

  if (!isRecord(payload) || !isRecord(payload.pago)) {
    throw new PagosApiError("Respuesta de creación no válida.");
  }

  return { ...parsePagoRow(payload.pago), repetido: payload.repetido === true };
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

// ─────────────────────────────────────────────────────────────────────────────
// Subida de comprobantes (doble comprobante: bancario + comercio)
// ─────────────────────────────────────────────────────────────────────────────

export type PagoComprobanteCategoria = "COMPROBANTE_BANCARIO" | "COMPROBANTE_COMERCIO";

export type ComprobanteSubido = {
  id: string;
  nombreArchivo: string;
};

/**
 * Sube un archivo de comprobante (bancario o de comercio) y registra el
 * Documento correspondiente en el trámite, reutilizando el endpoint genérico
 * /api/tramites/[id]/documentos (uploadUrl → PUT con enlace firmado → register).
 *
 * NOTA: reimplementa el flujo de 2 pasos localmente en vez de importar
 * src/components/documentos/documentos-api.ts (fuera de este scope) porque
 * su tipo `CategoriaDocumento` todavía no incluye "COMPROBANTE_COMERCIO".
 * El backend (enum Prisma CategoriaDocumento) sí la acepta sin cambios.
 */
export async function subirComprobante(
  tramiteId: string,
  categoria: PagoComprobanteCategoria,
  file: File,
): Promise<ComprobanteSubido> {
  const uploadUrlResp = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      action: "uploadUrl",
      categoria,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });
  const uploadUrlPayload: unknown = await uploadUrlResp.json().catch(() => null);
  if (!uploadUrlResp.ok) {
    const message =
      isRecord(uploadUrlPayload) && typeof uploadUrlPayload.error === "string"
        ? uploadUrlPayload.error
        : `No fue posible solicitar la URL de subida (${uploadUrlResp.status}).`;
    throw new PagosApiError(message, uploadUrlResp.status);
  }
  if (!isRecord(uploadUrlPayload) || !isRecord(uploadUrlPayload.uploadUrl)) {
    throw new PagosApiError("Respuesta de URL de subida no válida.");
  }
  const u = uploadUrlPayload.uploadUrl;
  const storageKey = String(u.storageKey ?? "");
  const putUrl = String(u.uploadUrl ?? "");

  const putResp = await fetch(putUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type },
  });
  if (!putResp.ok) {
    throw new PagosApiError("Error al subir el archivo del comprobante.");
  }

  const registerResp = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      action: "register",
      categoria,
      nombreArchivo: file.name,
      storageKey,
      mimeType: file.type,
      tamanoBytes: file.size,
    }),
  });
  const registerPayload: unknown = await registerResp.json().catch(() => null);
  if (!registerResp.ok) {
    const message =
      isRecord(registerPayload) && typeof registerPayload.error === "string"
        ? registerPayload.error
        : `No fue posible registrar el comprobante (${registerResp.status}).`;
    throw new PagosApiError(message, registerResp.status);
  }
  if (!isRecord(registerPayload) || !isRecord(registerPayload.documento)) {
    throw new PagosApiError("Respuesta de registro de comprobante no válida.");
  }
  const doc = registerPayload.documento;
  return {
    id: String(doc.id ?? ""),
    nombreArchivo: String(doc.nombreArchivo ?? file.name),
  };
}

/** Formatea pesos-texto de la API ("45226000.00") como "$ 45.226.000" (D-5: centavos solo si existen). */
export function formatCOP(value: string): string {
  try {
    return formatoPesos(centavosDeTextoApi(value));
  } catch {
    return value;
  }
}

/**
 * Recalcula los saldos intermedios del libro de pagos en el cliente.
 * saldo[i] = totalAnticipoAplicado − Σ(valores[0..i])
 * Exactamente la misma lógica que calcularSaldosIntermedios() del motor.
 * Entrada: pesos-texto TOLERANTE (mezcla de respuestas de la API y texto
 * canónico editado sin confirmar todavía); salida: pesos-texto de la API
 * (2 decimales), lista para `formatCOP`.
 */
export function calcularSaldosCliente(
  totalAnticipoAplicado: string,
  valores: string[],
): string[] {
  let saldo = centavosDeTexto(totalAnticipoAplicado);
  return valores.map((v) => {
    saldo -= centavosDeTexto(v);
    return textoDeCentavos(saldo);
  });
}
