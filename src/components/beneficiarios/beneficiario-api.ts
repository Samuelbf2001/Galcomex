export type BeneficiarioRow = {
  id: string;
  nombre: string;
  nit: string | null;
  banco: string | null;
  numCuenta: string | null;
};

export class BeneficiarioApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BeneficiarioApiError";
    this.status = status;
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
    banco: typeof b.banco === "string" ? b.banco : null,
    numCuenta: typeof b.numCuenta === "string" ? b.numCuenta : null,
  };
}

async function parseError(response: Response): Promise<string> {
  try {
    const p: unknown = await response.json();
    if (isRecord(p) && typeof p.error === "string") return p.error;
  } catch { /* ignore */ }
  return `Error ${response.status}`;
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

  if (!response.ok) {
    throw new BeneficiarioApiError(await parseError(response), response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.beneficiarios)) {
    throw new BeneficiarioApiError("Respuesta de beneficiarios no válida.");
  }

  return (payload.beneficiarios as unknown[]).filter(isRecord).map(mapBeneficiario);
}

export async function createBeneficiario(input: {
  nombre: string;
  nit?: string | null;
}): Promise<BeneficiarioRow> {
  const response = await fetch("/api/beneficiarios", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `No fue posible crear el beneficiario (${response.status}).`;
    throw new BeneficiarioApiError(message, response.status);
  }

  if (!isRecord(payload) || !isRecord(payload.beneficiario)) {
    throw new BeneficiarioApiError("Respuesta de creación no válida.");
  }

  return mapBeneficiario(payload.beneficiario);
}
