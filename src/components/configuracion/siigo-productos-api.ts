export type SiigoImpuestoRow = {
  id: number;
  nombre: string;
  tipo: string;
  porcentaje: string;
  activo: boolean;
};

export type SiigoProductoRow = {
  id: string;
  codigo: string;
  nombre: string;
  tipo: string;
  activo: boolean;
  grupoContableId: number;
  grupoContableNombre: string;
  clasificacionIva: string;
  sincronizadoEn: string;
  impuestos: SiigoImpuestoRow[];
};

export type SiigoProductosPayload = {
  productos: SiigoProductoRow[];
  total: number;
  ultimaSync: string | null;
};

export type SiigoImpuestosPayload = {
  impuestos: SiigoImpuestoRow[];
  total: number;
  ultimaSync: string | null;
};

export type SiigoFormaPagoRow = {
  id: number;
  nombre: string;
  tipo: string | null;
  activo: boolean;
};

export type SiigoFormasPagoPayload = {
  formasPago: SiigoFormaPagoRow[];
  total: number;
  ultimaSync: string | null;
};

export type SiigoTipoComprobanteRow = {
  id: number;
  code: string;
  nombre: string;
  tipo: string | null;
  activo: boolean;
};

export type SiigoTiposComprobantePayload = {
  tiposComprobante: SiigoTipoComprobanteRow[];
  total: number;
  ultimaSync: string | null;
};

export type SiigoVendedorRow = {
  id: number;
  username: string | null;
  nombre: string | null;
  email: string | null;
  activo: boolean;
};

export type SiigoVendedoresPayload = {
  vendedores: SiigoVendedorRow[];
  total: number;
  ultimaSync: string | null;
};

export type SyncTipo = "config" | "api" | "db";

export type SyncResult =
  | { ok: true; total: number }
  | { ok: false; error: string; tipo: SyncTipo };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeImpuesto(row: unknown): SiigoImpuestoRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "number" ? row.id : null;
  if (id === null) return null;
  return {
    id,
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    tipo: typeof row.tipo === "string" ? row.tipo : "",
    porcentaje: typeof row.porcentaje === "string" ? row.porcentaje : "0",
    activo: row.activo === true,
  };
}

function normalizeProducto(row: unknown): SiigoProductoRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : "";
  const codigo = typeof row.codigo === "string" ? row.codigo : "";
  if (!id || !codigo) return null;

  // El backend devuelve impuestos como pivot: { impuesto: {...} }
  const impuestos: SiigoImpuestoRow[] = Array.isArray(row.impuestos)
    ? row.impuestos
        .map((p) => {
          if (!isRecord(p)) return null;
          return normalizeImpuesto(p.impuesto);
        })
        .filter((i): i is SiigoImpuestoRow => i !== null)
    : [];

  return {
    id,
    codigo,
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    tipo: typeof row.tipo === "string" ? row.tipo : "",
    activo: row.activo === true,
    grupoContableId: typeof row.grupoContableId === "number" ? row.grupoContableId : 0,
    grupoContableNombre:
      typeof row.grupoContableNombre === "string" ? row.grupoContableNombre : "",
    clasificacionIva: typeof row.clasificacionIva === "string" ? row.clasificacionIva : "",
    sincronizadoEn: typeof row.sincronizadoEn === "string" ? row.sincronizadoEn : "",
    impuestos,
  };
}

export async function fetchSiigoProductos(
  signal?: AbortSignal,
): Promise<SiigoProductosPayload> {
  const response = await fetch("/api/configuracion/siigo/productos", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("No fue posible cargar los productos de Siigo.");
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) return { productos: [], total: 0, ultimaSync: null };

  const productos = Array.isArray(payload.productos)
    ? payload.productos
        .map(normalizeProducto)
        .filter((p): p is SiigoProductoRow => p !== null)
    : [];

  return {
    productos,
    total: typeof payload.total === "number" ? payload.total : productos.length,
    ultimaSync:
      typeof payload.ultimaSync === "string" ? payload.ultimaSync : null,
  };
}

export async function triggerSync(): Promise<SyncResult> {
  return triggerSyncEndpoint("/api/configuracion/siigo/sync", "productos");
}

export async function triggerSyncImpuestos(): Promise<SyncResult> {
  return triggerSyncEndpoint(
    "/api/configuracion/siigo/impuestos/sync",
    "impuestos",
  );
}

export async function triggerSyncFormasPago(): Promise<SyncResult> {
  return triggerSyncEndpoint(
    "/api/configuracion/siigo/formas-pago/sync",
    "formas de pago",
  );
}

export async function triggerSyncTiposComprobante(): Promise<SyncResult> {
  return triggerSyncEndpoint(
    "/api/configuracion/siigo/tipos-comprobante/sync",
    "tipos de comprobante",
  );
}

export async function triggerSyncVendedores(): Promise<SyncResult> {
  return triggerSyncEndpoint(
    "/api/configuracion/siigo/vendedores/sync",
    "vendedores",
  );
}

async function triggerSyncEndpoint(
  url: string,
  recurso: string,
): Promise<SyncResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const tipo: SyncTipo =
      response.status === 503 ? "config" : response.status === 502 ? "api" : "db";
    const error =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible sincronizar los ${recurso} de Siigo.`;
    return { ok: false, error, tipo };
  }

  if (isRecord(payload) && typeof payload.total === "number") {
    return { ok: true, total: payload.total };
  }

  return { ok: false, error: "Respuesta inesperada del servidor.", tipo: "db" };
}

export async function fetchSiigoImpuestos(
  signal?: AbortSignal,
): Promise<SiigoImpuestosPayload> {
  const response = await fetch("/api/configuracion/siigo/impuestos", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("No fue posible cargar los impuestos de Siigo.");
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) return { impuestos: [], total: 0, ultimaSync: null };

  const impuestos = Array.isArray(payload.impuestos)
    ? payload.impuestos
        .map(normalizeImpuesto)
        .filter((i): i is SiigoImpuestoRow => i !== null)
    : [];

  return {
    impuestos,
    total: typeof payload.total === "number" ? payload.total : impuestos.length,
    ultimaSync:
      typeof payload.ultimaSync === "string" ? payload.ultimaSync : null,
  };
}

function normalizeFormaPago(row: unknown): SiigoFormaPagoRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "number" ? row.id : null;
  if (id === null) return null;
  return {
    id,
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    tipo: typeof row.tipo === "string" ? row.tipo : null,
    activo: row.activo !== false,
  };
}

function normalizeTipoComprobante(row: unknown): SiigoTipoComprobanteRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "number" ? row.id : null;
  if (id === null) return null;
  return {
    id,
    code: typeof row.code === "string" ? row.code : "",
    nombre: typeof row.nombre === "string" ? row.nombre : "",
    tipo: typeof row.tipo === "string" ? row.tipo : null,
    activo: row.activo !== false,
  };
}

function normalizeVendedor(row: unknown): SiigoVendedorRow | null {
  if (!isRecord(row)) return null;
  const id = typeof row.id === "number" ? row.id : null;
  if (id === null) return null;
  return {
    id,
    username: typeof row.username === "string" ? row.username : null,
    nombre: typeof row.nombre === "string" ? row.nombre : null,
    email: typeof row.email === "string" ? row.email : null,
    activo: row.activo !== false,
  };
}

export async function fetchSiigoTiposComprobante(
  signal?: AbortSignal,
): Promise<SiigoTiposComprobantePayload> {
  const response = await fetch("/api/configuracion/siigo/tipos-comprobante", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("No fue posible cargar los tipos de comprobante de Siigo.");
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    return { tiposComprobante: [], total: 0, ultimaSync: null };
  }

  const tiposComprobante = Array.isArray(payload.tiposComprobante)
    ? payload.tiposComprobante
        .map(normalizeTipoComprobante)
        .filter((t): t is SiigoTipoComprobanteRow => t !== null)
    : [];

  return {
    tiposComprobante,
    total: typeof payload.total === "number" ? payload.total : tiposComprobante.length,
    ultimaSync: typeof payload.ultimaSync === "string" ? payload.ultimaSync : null,
  };
}

export async function fetchSiigoVendedores(
  signal?: AbortSignal,
): Promise<SiigoVendedoresPayload> {
  const response = await fetch("/api/configuracion/siigo/vendedores", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("No fue posible cargar los vendedores de Siigo.");
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    return { vendedores: [], total: 0, ultimaSync: null };
  }

  const vendedores = Array.isArray(payload.vendedores)
    ? payload.vendedores
        .map(normalizeVendedor)
        .filter((v): v is SiigoVendedorRow => v !== null)
    : [];

  return {
    vendedores,
    total: typeof payload.total === "number" ? payload.total : vendedores.length,
    ultimaSync: typeof payload.ultimaSync === "string" ? payload.ultimaSync : null,
  };
}

export async function fetchSiigoFormasPago(
  signal?: AbortSignal,
): Promise<SiigoFormasPagoPayload> {
  const response = await fetch("/api/configuracion/siigo/formas-pago", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("No fue posible cargar las formas de pago de Siigo.");
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) return { formasPago: [], total: 0, ultimaSync: null };

  const formasPago = Array.isArray(payload.formasPago)
    ? payload.formasPago
        .map(normalizeFormaPago)
        .filter((f): f is SiigoFormaPagoRow => f !== null)
    : [];

  return {
    formasPago,
    total: typeof payload.total === "number" ? payload.total : formasPago.length,
    ultimaSync:
      typeof payload.ultimaSync === "string" ? payload.ultimaSync : null,
  };
}

export async function setImpuestosProducto(
  productoId: string,
  impuestoIds: number[],
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(
    `/api/configuracion/siigo/productos/${productoId}/impuestos`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ impuestoIds }),
    },
  );

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "No fue posible actualizar los impuestos del producto.";
    return { ok: false, error };
  }

  return { ok: true };
}
