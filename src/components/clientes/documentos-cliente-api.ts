/**
 * Cliente de API para GET /api/clientes/[id]/documentos — repositorio
 * documental agregado por cliente ("carpetica virtual", reunión 2026-07-01).
 *
 * Reutiliza los tipos/formatos del módulo de documentos por trámite
 * (src/components/documentos/documentos-api.ts) donde tiene sentido, pero
 * no lo importa/edita: este endpoint devuelve una forma distinta (lista
 * plana paginada con el trámite de origen embebido en cada fila).
 */

export type CategoriaDocumento =
  | "FACTURA_COMERCIAL"
  | "BL"
  | "PACKING_LIST"
  | "DECLARACION_DIAN"
  | "SOPORTE_FACTURACION"
  | "FOTO_RECONOCIMIENTO"
  | "COMPROBANTE_BANCARIO"
  | "FACTURA_PROVEEDOR"
  | "OTRO";

export const CATEGORIAS_DOCUMENTO_CLIENTE: { value: CategoriaDocumento; label: string }[] = [
  { value: "FACTURA_COMERCIAL", label: "Factura Comercial" },
  { value: "BL", label: "Bill of Lading (BL)" },
  { value: "PACKING_LIST", label: "Packing List" },
  { value: "DECLARACION_DIAN", label: "Declaración DIAN" },
  { value: "SOPORTE_FACTURACION", label: "Soporte de Facturación" },
  { value: "FOTO_RECONOCIMIENTO", label: "Foto de Reconocimiento" },
  { value: "COMPROBANTE_BANCARIO", label: "Comprobante Bancario" },
  { value: "FACTURA_PROVEEDOR", label: "Factura Proveedor" },
  { value: "OTRO", label: "Otro" },
];

export type DocumentoClienteRow = {
  id: string;
  categoria: CategoriaDocumento;
  nombreArchivo: string;
  mimeType: string;
  tamanoBytes: number;
  createdAt: string;
  downloadUrl: string;
  subidoPor: { id: string; name: string };
  tramite: { id: string; consecutivo: string; ciudad: string };
};

export type DocumentosClienteFiltros = {
  categoria?: CategoriaDocumento;
  desde?: string; // ISO, ej. "2026-01-31"
  hasta?: string;
  take?: number;
  skip?: number;
};

export type DocumentosClienteResult = {
  documentos: DocumentoClienteRow[];
  total: number;
};

export class DocumentosClienteApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DocumentosClienteApiError";
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

function parseDocumentoClienteRow(raw: Record<string, unknown>): DocumentoClienteRow | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;

  const subidoPor = isRecord(raw.subidoPor) ? raw.subidoPor : {};
  const tramite = isRecord(raw.tramite) ? raw.tramite : {};

  return {
    id,
    categoria: (raw.categoria as CategoriaDocumento) ?? "OTRO",
    nombreArchivo: String(raw.nombreArchivo ?? ""),
    mimeType: String(raw.mimeType ?? ""),
    tamanoBytes: typeof raw.tamanoBytes === "number" ? raw.tamanoBytes : 0,
    createdAt: String(raw.createdAt ?? ""),
    downloadUrl: String(raw.downloadUrl ?? ""),
    subidoPor: {
      id: String(subidoPor.id ?? ""),
      name: String(subidoPor.name ?? ""),
    },
    tramite: {
      id: String(tramite.id ?? ""),
      consecutivo: String(tramite.consecutivo ?? ""),
      ciudad: String(tramite.ciudad ?? ""),
    },
  };
}

export async function fetchDocumentosCliente(
  clienteId: string,
  filtros: DocumentosClienteFiltros = {},
  signal?: AbortSignal,
): Promise<DocumentosClienteResult> {
  const params = new URLSearchParams();
  if (filtros.categoria) params.set("categoria", filtros.categoria);
  if (filtros.desde) params.set("desde", filtros.desde);
  if (filtros.hasta) params.set("hasta", filtros.hasta);
  if (filtros.take !== undefined) params.set("take", String(filtros.take));
  if (filtros.skip !== undefined) params.set("skip", String(filtros.skip));

  const qs = params.toString();
  const url = `/api/clientes/${clienteId}/documentos${qs ? `?${qs}` : ""}`;

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DocumentosClienteApiError("No fue posible conectar con la API de documentos.");
  }

  if (!response.ok) {
    const msg = await parseErrorMessage(response);
    throw new DocumentosClienteApiError(msg, response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.documentos)) {
    throw new DocumentosClienteApiError("Respuesta de documentos no válida.");
  }

  const documentos = payload.documentos
    .filter(isRecord)
    .map(parseDocumentoClienteRow)
    .filter((d): d is DocumentoClienteRow => d !== null);

  const total = typeof payload.total === "number" ? payload.total : documentos.length;

  return { documentos, total };
}
