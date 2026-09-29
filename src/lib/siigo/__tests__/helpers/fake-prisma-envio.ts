/**
 * Prisma en memoria para los tests del envío a Siigo (sin BD).
 *
 * Una sola fila `borrador_factura`. `updateMany` evalúa el WHERE y aplica el
 * cambio en el mismo tick (sin await en medio), igual que un UPDATE de
 * Postgres sobre una fila: de dos reclamos simultáneos solo uno la actualiza.
 * `$transaction` deshace los cambios si el callback lanza, y puede simular que
 * la BD se cae (`fallarProximasTransacciones`).
 */

export type FilaBorrador = {
  id: string;
  estado: string;
  siigoDraftId: string | null;
  siigoEnvioEstado: "ENVIANDO" | "ENVIADO" | "INCIERTO" | "ERROR" | null;
  siigoEnvioIniciadoAt: Date | null;
  siigoEnvioIntentoId: string | null;
  enviadoASiigoEn: Date | null;
  ultimoErrorSiigo: string | null;
  ultimoIntentoSiigo: Date | null;
};

export type Auditoria = {
  accion: string;
  entidadId: string;
  antes?: unknown;
  despues?: unknown;
};

function filaInicial(): FilaBorrador {
  return {
    id: "bor-1",
    estado: "APROBADO",
    siigoDraftId: null,
    siigoEnvioEstado: null,
    siigoEnvioIniciadoAt: null,
    siigoEnvioIntentoId: null,
    enviadoASiigoEn: null,
    ultimoErrorSiigo: null,
    ultimoIntentoSiigo: null,
  };
}

export const estado = {
  fila: filaInicial(),
  auditorias: [] as Auditoria[],
  /** Cuántas de las próximas `$transaction` fallan como si la BD se cayera. */
  transaccionesQueFallan: 0,
  /** Cuántos de los próximos `auditLog.create` fallan. */
  auditoriasQueFallan: 0,
  /** Cuántos de los próximos `updateMany` fuera de transacción fallan. */
  updatesQueFallan: 0,
};

export function reiniciar(): void {
  estado.fila = filaInicial();
  estado.auditorias = [];
  estado.transaccionesQueFallan = 0;
  estado.auditoriasQueFallan = 0;
  estado.updatesQueFallan = 0;
}

type Where = Record<string, unknown>;

function esCondicion(v: unknown): v is { lt?: Date; in?: unknown[] } {
  return typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

/** Evalúa el subconjunto de WHERE de Prisma que usa el código del envío. */
export function coincide(fila: FilaBorrador, where: Where): boolean {
  for (const [clave, valor] of Object.entries(where)) {
    if (clave === "OR") {
      if (!(valor as Where[]).some((w) => coincide(fila, w))) return false;
      continue;
    }
    if (clave === "AND") {
      if (!(valor as Where[]).every((w) => coincide(fila, w))) return false;
      continue;
    }
    const actual = (fila as Record<string, unknown>)[clave];
    if (esCondicion(valor)) {
      if (valor.lt !== undefined) {
        if (!(actual instanceof Date) || !(actual.getTime() < valor.lt.getTime())) return false;
      }
      if (valor.in !== undefined && !valor.in.includes(actual)) return false;
      continue;
    }
    if (actual instanceof Date && valor instanceof Date) {
      if (actual.getTime() !== valor.getTime()) return false;
      continue;
    }
    if (actual !== valor) return false;
  }
  return true;
}

function borradorCompleto() {
  return {
    ...estado.fila,
    tramiteId: "tra-1",
    formaPagoSiigoId: 7,
    formatoFactura: "COMISION",
    retenciones: 0n,
    reteIvaPorcentaje: null,
    comentariosCabecera: null,
    totalFactura: 1_000_000n,
    totalAnticipo: 0n,
    saldoAFavorCliente: 0n,
    saldoACargoCliente: 1_000_000n,
    tramite: {
      id: "tra-1",
      consecutivo: "DO.BAQ26-0001",
      cliente: { nit: "900123456", nombre: "Cliente Prueba" },
      pagos: [],
    },
    formaPago: null,
    lineasRevision: [],
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
}

const cliente = {
  $executeRaw: async () => 1,
  $queryRaw: async () => [],
  borradorFactura: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      await tick();
      return where.id === estado.fila.id ? borradorCompleto() : null;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<FilaBorrador> }) => {
      await tick();
      // Evaluar y aplicar en el mismo tick: atómico como un UPDATE.
      if (!coincide(estado.fila, where)) return { count: 0 };
      estado.fila = { ...estado.fila, ...data };
      return { count: 1 };
    },
    update: async ({ data }: { data: Partial<FilaBorrador> }) => {
      await tick();
      estado.fila = { ...estado.fila, ...data };
      return {};
    },
    count: async ({ where }: { where: Where }) => (coincide(estado.fila, where) ? 1 : 0),
  },
  auditLog: {
    create: async ({ data }: { data: Auditoria }) => {
      await tick();
      if (estado.auditoriasQueFallan > 0) {
        estado.auditoriasQueFallan -= 1;
        throw new Error("audit_log: fallo simulado");
      }
      estado.auditorias.push(data);
      return {};
    },
  },
};

/** updateMany fuera de transacción que puede fallar a propósito. */
const clienteRaiz = {
  ...cliente,
  borradorFactura: {
    ...cliente.borradorFactura,
    updateMany: async (args: { where: Where; data: Partial<FilaBorrador> }) => {
      if (estado.updatesQueFallan > 0) {
        estado.updatesQueFallan -= 1;
        throw new Error("Can't reach database server (simulado)");
      }
      return cliente.borradorFactura.updateMany(args);
    },
  },
  $transaction: async <T>(fn: (tx: typeof cliente) => Promise<T>): Promise<T> => {
    await tick();
    if (estado.transaccionesQueFallan > 0) {
      estado.transaccionesQueFallan -= 1;
      throw new Error("Transaction already closed (simulado)");
    }
    const filaAntes = { ...estado.fila };
    const auditoriasAntes = estado.auditorias.length;
    try {
      return await fn(cliente);
    } catch (err) {
      // ROLLBACK
      estado.fila = filaAntes;
      estado.auditorias.length = auditoriasAntes;
      throw err;
    }
  },
  parametro: {
    findMany: async () => [
      { clave: "SIIGO_TIPO_COMPROBANTE_ID", valor: "101" },
      { clave: "SIIGO_VENDEDOR_ID", valor: "202" },
    ],
  },
  siigoImpuesto: { findMany: async () => [] },
};

export const prismaFake = clienteRaiz;
