/**
 * Cliente del navegador para la comisión por contenedor (caso LTRANS).
 * Dinero como string de dígitos (COP enteros), igual que el resto de la UI.
 */

export class ComisionesApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ComisionesApiError";
    this.status = status;
  }
}

export type EmpresaQuePagaRow = {
  empresaId: string;
  nombre: string;
  /** Valor por contenedor ("0" = sin configurar). */
  valorUnitario: string;
};

export type ComisionDoRow = {
  empresaId: string;
  nombre: string;
  unidades: number;
  valorUnitario: string;
  subtotal: string;
};

export type ComisionesTramiteRow = {
  aplica: boolean;
  consecutivo: string;
  numContenedores: number | null;
  tipoCarga: string | null;
  /** Contenedores que pueden llevar comisión (carga suelta = 1); null = falta el dato. */
  unidadesDisponibles: number | null;
  empresas: EmpresaQuePagaRow[];
  comisiones: ComisionDoRow[];
};

export type FilaComisionEmpresaRow = {
  tramiteId: string;
  consecutivo: string;
  empresaDo: string;
  referencia: string | null;
  fecha: string;
  numContenedores: number | null;
  unidades: number;
  subtotal: string;
};

export type ComisionesEmpresaRow = {
  habilitada: boolean;
  valorUnitario: string;
  tasaIva: string;
  filas: FilaComisionEmpresaRow[];
  totales: { unidades: number; subtotal: string; iva: string; total: string };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown, fb = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fb;
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...init?.headers },
    });
  } catch {
    throw new ComisionesApiError("No fue posible conectar con el servidor.");
  }
  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.error === "string") message = body.error;
      else if (isRecord(body) && Array.isArray(body.details)) {
        message = body.details
          .filter(isRecord)
          .map((d) => str(d.mensaje ?? d.message))
          .join(" · ");
      }
    } catch {
      /* sin cuerpo */
    }
    throw new ComisionesApiError(message, res.status);
  }
  return res.json();
}

function normalizarEmpresa(v: unknown): EmpresaQuePagaRow | null {
  if (!isRecord(v) || typeof v.empresaId !== "string") return null;
  return { empresaId: v.empresaId, nombre: str(v.nombre), valorUnitario: str(v.valorUnitario, "0") };
}

function normalizarComision(v: unknown): ComisionDoRow | null {
  if (!isRecord(v) || typeof v.empresaId !== "string") return null;
  return {
    empresaId: v.empresaId,
    nombre: str(v.nombre),
    unidades: num(v.unidades),
    valorUnitario: str(v.valorUnitario, "0"),
    subtotal: str(v.subtotal, "0"),
  };
}

function normalizarTramite(v: unknown): ComisionesTramiteRow {
  const b = isRecord(v) ? v : {};
  return {
    aplica: b.aplica === true,
    consecutivo: str(b.consecutivo),
    numContenedores: numOrNull(b.numContenedores),
    tipoCarga: typeof b.tipoCarga === "string" ? b.tipoCarga : null,
    unidadesDisponibles: numOrNull(b.unidadesDisponibles),
    empresas: Array.isArray(b.empresas)
      ? b.empresas.map(normalizarEmpresa).filter((e): e is EmpresaQuePagaRow => e !== null)
      : [],
    comisiones: Array.isArray(b.comisiones)
      ? b.comisiones.map(normalizarComision).filter((c): c is ComisionDoRow => c !== null)
      : [],
  };
}

export async function fetchComisionesTramite(
  tramiteId: string,
  signal?: AbortSignal,
): Promise<ComisionesTramiteRow> {
  return normalizarTramite(
    await request(`/api/tramites/${encodeURIComponent(tramiteId)}/comisiones`, { signal }),
  );
}

/** `unidades = 0` quita la comisión de esa empresa en el DO. */
export async function guardarComisionTramite(
  tramiteId: string,
  empresaId: string,
  unidades: number,
): Promise<ComisionesTramiteRow> {
  return normalizarTramite(
    await request(`/api/tramites/${encodeURIComponent(tramiteId)}/comisiones`, {
      method: "PUT",
      body: JSON.stringify({ empresaId, unidades }),
    }),
  );
}

export async function fetchComisionesEmpresa(
  empresaId: string,
  signal?: AbortSignal,
): Promise<ComisionesEmpresaRow> {
  const b = await request(`/api/clientes/${encodeURIComponent(empresaId)}/comisiones`, { signal });
  const r = isRecord(b) ? b : {};
  const t = isRecord(r.totales) ? r.totales : {};
  return {
    habilitada: r.habilitada === true,
    valorUnitario: str(r.valorUnitario, "0"),
    tasaIva: str(r.tasaIva, "0"),
    filas: Array.isArray(r.filas)
      ? r.filas.filter(isRecord).map((f) => ({
          tramiteId: str(f.tramiteId),
          consecutivo: str(f.consecutivo),
          empresaDo: str(f.empresaDo),
          referencia: typeof f.referencia === "string" ? f.referencia : null,
          fecha: str(f.fecha),
          numContenedores: numOrNull(f.numContenedores),
          unidades: num(f.unidades),
          subtotal: str(f.subtotal, "0"),
        }))
      : [],
    totales: {
      unidades: num(t.unidades),
      subtotal: str(t.subtotal, "0"),
      iva: str(t.iva, "0"),
      total: str(t.total, "0"),
    },
  };
}
