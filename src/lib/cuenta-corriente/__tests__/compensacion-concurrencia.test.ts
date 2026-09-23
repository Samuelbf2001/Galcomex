// @vitest-environment node
/**
 * Cruce de saldos bajo concurrencia (revisión de seguridad, hallazgo MEDIO).
 *
 * La validación del cruce (máximo compensable, pendientes de cada factura) se
 * hace dentro de la transacción y bajo advisory lock por empresa; la factura de
 * proveedor se marca con un update condicionado a REGISTRADA.
 *
 * Sin BD: Prisma es un doble en memoria cuyas consultas ceden el turno
 * (setTimeout 0), así dos cruces sin lock SÍ se intercalarían. El advisory
 * lock se simula con un mutex por clave, reentrante dentro de la misma
 * transacción (como `pg_advisory_xact_lock`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type PagoFake = {
  id: string;
  tipo: "ABONO" | "DEVOLUCION";
  monto: bigint;
  fecha: Date;
  compensacionId: string | null;
};

const h = vi.hoisted(() => {
  const db = {
    empresa: { id: "emp-1", nombre: "Coldex", nit: "900111222", esCliente: true, esProveedor: true },
    facturas: [] as Array<{
      id: string;
      borradorId: string;
      numSiigo: string;
      fecha: Date;
      saldoAFavorCliente: bigint;
      saldoACargoCliente: bigint;
      pagos: PagoFake[];
    }>,
    beneficiarios: [{ id: "ben-1" }],
    facturasProveedor: [] as Array<{
      id: string;
      numFactura: string;
      valor: bigint;
      fecha: Date;
      repercutible: boolean;
      estado: string;
      compensacionId: string | null;
    }>,
    movimientos: [] as Array<Record<string, unknown>>,
    auditorias: [] as Array<{ accion: string }>,
  };

  const locks = new Map<string, { promise: Promise<void>; release: () => void }>();
  const ordenLocks: string[] = [];
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const tramite = { id: "tra-1", consecutivo: "DO.BAQ26-0001", tipoTramite: { lineaServicio: "TRAMITE" } };

  function crearTx(held: Set<string>) {
    return {
      $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
        const key = String(values[0]);
        if (!held.has(key)) {
          while (locks.has(key)) await locks.get(key)!.promise;
          let release: () => void = () => {};
          const promise = new Promise<void>((r) => (release = r));
          locks.set(key, { promise, release });
          held.add(key);
        }
        ordenLocks.push(key);
        return 1;
      },
      cliente: {
        findUnique: async () => {
          await tick();
          return db.empresa;
        },
      },
      factura: {
        findMany: async () => {
          await tick();
          return db.facturas.map((f) => ({
            ...f,
            borrador: { tramite },
            pagos: f.pagos.map((p) => ({ ...p })),
          }));
        },
      },
      beneficiario: {
        findMany: async () => {
          await tick();
          return db.beneficiarios.map((b) => ({ ...b }));
        },
      },
      facturaProveedor: {
        findMany: async ({ where }: { where: { estado?: string; repercutible?: boolean } }) => {
          await tick();
          return db.facturasProveedor
            .filter(
              (f) =>
                (where.estado === undefined || f.estado === where.estado) &&
                (where.repercutible === undefined || f.repercutible === where.repercutible),
            )
            .map((f) => ({ ...f, tramite }));
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; estado: string };
          data: Record<string, unknown>;
        }) => {
          await tick();
          const f = db.facturasProveedor.find((x) => x.id === where.id && x.estado === where.estado);
          if (!f) return { count: 0 };
          Object.assign(f, data);
          return { count: 1 };
        },
      },
      movimientoCuenta: {
        findMany: async () => {
          await tick();
          return db.movimientos.map((m) => ({ ...m, tramite: null }));
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          await tick();
          db.movimientos.push({ id: `mov-${db.movimientos.length + 1}`, ...data });
          return {};
        },
      },
      auditLog: {
        create: async ({ data }: { data: { accion: string } }) => {
          db.auditorias.push(data);
          return { id: `aud-${db.auditorias.length}` };
        },
      },
    };
  }

  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const held = new Set<string>();
    try {
      return await fn(crearTx(held));
    } finally {
      for (const key of held) {
        const lock = locks.get(key);
        locks.delete(key);
        lock?.release();
      }
    }
  });

  const registrarPagoFacturaAbono = vi.fn(
    async (input: { facturaId: string; monto: bigint; fecha: Date; compensacionId: string }) => {
      await tick();
      const factura = db.facturas.find((f) => f.id === input.facturaId)!;
      factura.pagos.push({
        id: `pf-${factura.pagos.length + 1}`,
        tipo: "ABONO",
        monto: input.monto,
        fecha: input.fecha,
        compensacionId: input.compensacionId,
      });
      return { ok: true as const };
    },
  );

  return { db, locks, ordenLocks, $transaction, registrarPagoFacturaAbono };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: h.$transaction } }));
vi.mock("@/lib/capacidades/service", () => ({
  capacidadesDeEmpresa: vi.fn(async () => new Map([["cuenta_corriente", { habilitado: true }]])),
}));
vi.mock("@/lib/cartera/service", () => ({
  registrarPagoFacturaAbono: h.registrarPagoFacturaAbono,
  eliminarPagoFactura: vi.fn(),
}));

const { registrarCompensacion, CompensacionInvalidaError } = await import("../service");

const FECHA = new Date("2026-09-22T12:00:00Z");
const base = { empresaId: "emp-1", fecha: FECHA, concepto: "Cruce Coldex", usuarioId: "usr-1" };

beforeEach(() => {
  h.db.facturas = [
    {
      id: "fv-1",
      borradorId: "bor-1",
      numSiigo: "BAQ-18500",
      fecha: FECHA,
      saldoAFavorCliente: 0n,
      saldoACargoCliente: 500_000n,
      pagos: [],
    },
  ];
  h.db.facturasProveedor = [];
  h.db.movimientos = [];
  h.db.auditorias = [];
  h.locks.clear();
  h.ordenLocks.length = 0;
  h.$transaction.mockClear();
  h.registrarPagoFacturaAbono.mockClear();
});

function facturaProveedor(repercutible: boolean) {
  return {
    id: "fp-1",
    numFactura: "FE-11298",
    valor: 300_000n,
    fecha: FECHA,
    repercutible,
    estado: "REGISTRADA",
    compensacionId: null,
  };
}

describe("registrarCompensacion — concurrencia", () => {
  it("dos cruces simultáneos de la misma factura de proveedor: solo uno se aplica", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];
    const input = { ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" };

    const resultados = await Promise.allSettled([
      registrarCompensacion(input),
      registrarCompensacion(input),
    ]);

    const ok = resultados.filter((r) => r.status === "fulfilled");
    const fallidos = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect(fallidos[0]!.reason).toBeInstanceOf(CompensacionInvalidaError);

    expect(h.registrarPagoFacturaAbono).toHaveBeenCalledTimes(1);
    expect(h.db.facturas[0]!.pagos).toHaveLength(1);
    expect(h.db.facturasProveedor[0]!.estado).toBe("PAGADA");
  });

  it("dos cruces manuales simultáneos no pasan del máximo compensable", async () => {
    // Nos deben 500.000 (factura de venta) y les debemos 300.000 (factura que
    // se repercute: cuenta en el saldo, pero no es cruzable como documento).
    h.db.facturasProveedor = [facturaProveedor(true)];

    const resultados = await Promise.allSettled([
      registrarCompensacion({ ...base, valor: 300_000n }),
      registrarCompensacion({ ...base, valor: 300_000n }),
    ]);

    const fallidos = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect(String(fallidos[0]!.reason.message)).toMatch(/Solo se pueden cruzar hasta 0/);
    // Una sola pareja ABONO (cliente) + CARGO (proveedor).
    expect(h.db.movimientos).toHaveLength(2);
  });

  it("toma el lock de la empresa y el de abonos de la factura de venta antes de validar", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];

    await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });

    expect(h.ordenLocks.slice(0, 2)).toEqual(["cuenta_corriente:emp-1", "pago_factura:fv-1:CLIENTE"]);
  });

  it("si la factura de proveedor se salda por otro camino en medio, el cruce falla (update condicionado)", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];
    // Simula que el libro de pagos la marcó PAGADA justo después de validar.
    h.registrarPagoFacturaAbono.mockImplementationOnce(async () => {
      h.db.facturasProveedor[0]!.estado = "PAGADA";
      return { ok: true as const };
    });

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" }),
    ).rejects.toThrow(/FE-11298 ya no está pendiente/);
    // No se le pisó el estado ni se le colgó este cruce.
    expect(h.db.facturasProveedor[0]!.compensacionId).toBeNull();
    expect(h.db.auditorias.some((a) => a.accion === "PAGADA_POR_COMPENSACION")).toBe(false);
  });
});
