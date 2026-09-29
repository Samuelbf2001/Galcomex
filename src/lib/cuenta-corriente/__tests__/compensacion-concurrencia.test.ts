// @vitest-environment node
/**
 * Cruce de saldos bajo concurrencia (revisión de seguridad, hallazgo MEDIO).
 *
 * La validación del cruce (máximo compensable, pendientes de cada factura) se
 * hace dentro de la transacción y bajo advisory lock por empresa; la factura de
 * proveedor se bloquea y `aplicarSaldo` (CxP v2) revalida su saldo al aplicar.
 *
 * Sin BD: Prisma es un doble en memoria cuyas consultas ceden el turno
 * (setTimeout 0), así dos cruces sin lock SÍ se intercalarían. El advisory
 * lock se simula con un mutex por clave, reentrante dentro de la misma
 * transacción (como `pg_advisory_xact_lock`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pesos } from "@/lib/dinero";

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
      /** CxP v2: Σ pagado por el libro (puente) y lo cruzado. */
      pagado: bigint;
      montoCompensado: bigint;
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
          // Fase centavos: el doble devuelve las columnas `…Centavos` de Prisma.
          return db.facturas.map((f) => ({
            ...f,
            saldoAFavorClienteCentavos: f.saldoAFavorCliente,
            saldoACargoClienteCentavos: f.saldoACargoCliente,
            borrador: { tramite },
            pagos: f.pagos.map((p) => ({ ...p, montoCentavos: p.monto })),
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
        findUnique: async ({ where }: { where: { id: string } }) => {
          await tick();
          return db.facturasProveedor.some((f) => f.id === where.id) ? { tramiteId: tramite.id } : null;
        },
        findMany: async ({
          where,
        }: {
          where: { estado?: string | { in: string[] }; repercutible?: boolean };
        }) => {
          await tick();
          const estados =
            where.estado === undefined ? null : typeof where.estado === "string" ? [where.estado] : where.estado.in;
          return db.facturasProveedor
            .filter(
              (f) =>
                (estados === null || estados.includes(f.estado)) &&
                (where.repercutible === undefined || f.repercutible === where.repercutible),
            )
            .map((f) => ({
              ...f,
              valorCentavos: f.valor,
              montoCompensadoCentavos: f.montoCompensado,
              tramiteId: tramite.id,
              pagos: f.pagado > 0n ? [{ montoCentavos: f.pagado }] : [],
              ajustes: [],
              tramite,
            }));
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
      pagoFactura: {
        findMany: async ({ where }: { where: { compensacionId?: string } }) => {
          await tick();
          return db.facturas.flatMap((f) =>
            f.pagos
              .filter((p) => where.compensacionId === undefined || p.compensacionId === where.compensacionId)
              .map((p) => ({ id: p.id, facturaId: f.id })),
          );
        },
      },
      tramiteDO: {
        findMany: async () => {
          await tick();
          return [{ id: tramite.id, consecutivo: tramite.consecutivo, estado: "ABIERTO" }];
        },
      },
      movimientoCuenta: {
        findMany: async ({ where }: { where?: { compensacionId?: string } } = {}) => {
          await tick();
          return db.movimientos
            .filter((m) => where?.compensacionId === undefined || m.compensacionId === where.compensacionId)
            .map((m) => ({ ...m, valor: m.valorCentavos, tramite: null }));
        },
        delete: async () => {
          await tick();
          return {};
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

  /**
   * CxP v2: dobles de `bloquearFacturas` / `aplicarSaldo` (src/lib/cxp/aplicar.ts)
   * sobre el mismo estado en memoria. `aplicarSaldo` revalida el saldo en el
   * momento de aplicar (como el real con la fila bloqueada + el guardián).
   */
  const bloquearFacturas = vi.fn(async (_tx: unknown, ids: string[]) => {
    await tick();
    return new Map(
      ids.map((id) => {
        const f = db.facturasProveedor.find((x) => x.id === id);
        return [
          id,
          { id, numFactura: f?.numFactura ?? id, compensacionId: f?.compensacionId ?? null, compensado: f?.montoCompensado ?? 0n },
        ];
      }),
    );
  });
  const aplicarSaldo = vi.fn(
    async (
      _tx: unknown,
      input: {
        origen: { tipo: string; compensacionId?: string };
        aplicaciones: { facturaProveedorId: string; monto: bigint }[];
      },
    ) => {
      await tick();
      const cambios = [];
      for (const a of input.aplicaciones) {
        const f = db.facturasProveedor.find((x) => x.id === a.facturaProveedorId)!;
        const saldo = f.valor - f.pagado - f.montoCompensado;
        if (saldo === 0n) {
          throw new Error(`La factura ${f.numFactura} de Coldex ya está pagada; no se puede volver a pagar.`);
        }
        if (a.monto > saldo) throw new Error(`A la factura ${f.numFactura} solo le faltan ${saldo} por pagar`);
        const estadoAntes = f.estado;
        f.montoCompensado += a.monto;
        f.compensacionId = input.origen.compensacionId ?? null;
        f.estado = saldo - a.monto === 0n ? "PAGADA" : "PARCIAL";
        cambios.push({ facturaId: f.id, monto: a.monto, saldoAntes: saldo, saldoDespues: saldo - a.monto, estadoAntes, estadoDespues: f.estado });
      }
      return { cambios };
    },
  );

  return { db, locks, ordenLocks, $transaction, registrarPagoFacturaAbono, bloquearFacturas, aplicarSaldo };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: h.$transaction } }));
vi.mock("@/lib/capacidades/service", () => ({
  capacidadesDeEmpresa: vi.fn(async () => new Map([["cuenta_corriente", { habilitado: true }]])),
}));
vi.mock("@/lib/cartera/service", () => ({
  registrarPagoFacturaAbono: h.registrarPagoFacturaAbono,
  eliminarPagoFactura: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/cxp/aplicar", () => ({
  bloquearFacturas: h.bloquearFacturas,
  aplicarSaldo: h.aplicarSaldo,
  revertirSaldo: vi.fn(),
}));
vi.mock("@/lib/cxp/bloqueos", () => ({
  bloquearTramites: vi.fn(async (_tx: unknown, ids: string[]) => {
    for (const id of ids) h.ordenLocks.push(`DO:${id}`);
    return ids;
  }),
}));

const { registrarCompensacion, eliminarCompensacion, CompensacionInvalidaError } = await import("../service");

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
      saldoACargoCliente: pesos(500_000),
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
  h.bloquearFacturas.mockClear();
  h.aplicarSaldo.mockClear();
});

function facturaProveedor(repercutible: boolean) {
  return {
    id: "fp-1",
    numFactura: "FE-11298",
    valor: pesos(300_000),
    fecha: FECHA,
    repercutible,
    estado: "REGISTRADA",
    compensacionId: null,
    pagado: 0n,
    montoCompensado: 0n,
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
      registrarCompensacion({ ...base, valor: pesos(300_000) }),
      registrarCompensacion({ ...base, valor: pesos(300_000) }),
    ]);

    const fallidos = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect(String(fallidos[0]!.reason.message)).toMatch(/Solo se pueden cruzar hasta \$\u00a00:/);
    // Una sola pareja ABONO (cliente) + CARGO (proveedor).
    expect(h.db.movimientos).toHaveLength(2);
  });

  it("toma el lock de la empresa y el de abonos de la factura de venta antes de validar", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];

    await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });

    expect(h.ordenLocks.slice(0, 2)).toEqual(["cuenta_corriente:emp-1", "pago_factura:fv-1:CLIENTE"]);
  });

  it("si la factura de proveedor se salda por otro camino en medio, aplicarSaldo lo detecta y el cruce se deshace (CxP v2)", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];
    // Simula que el libro de pagos la pagó justo después de validar (con la
    // fila bloqueada no puede pasar; el doble lo fuerza para probar la revalidación).
    h.registrarPagoFacturaAbono.mockImplementationOnce(async () => {
      h.db.facturasProveedor[0]!.pagado = pesos(300_000);
      h.db.facturasProveedor[0]!.estado = "PAGADA";
      return { ok: true as const };
    });

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" }),
    ).rejects.toThrow(/FE-11298 de Coldex ya está pagada/);
    // No se le colgó este cruce ni quedó auditoría de cruce.
    expect(h.db.facturasProveedor[0]!.compensacionId).toBeNull();
    expect(h.db.facturasProveedor[0]!.montoCompensado).toBe(0n);
    expect(h.db.auditorias.some((a) => a.accion === "PAGADA_POR_COMPENSACION")).toBe(false);
  });

  it("una factura Abonada se cruza por su SALDO (no por su total) y queda Pagada", async () => {
    h.db.facturasProveedor = [{ ...facturaProveedor(false), estado: "PARCIAL", pagado: pesos(100_000) }];

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1", valor: pesos(300_000) }),
    ).rejects.toThrow(/lo que le falta por pagar: \$\u00a0200\.000/);

    const r = await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });
    expect(r.valor).toBe(pesos(200_000));
    expect(h.aplicarSaldo).toHaveBeenCalledTimes(1);
    expect(h.aplicarSaldo.mock.calls[0]![1].aplicaciones).toEqual([{ facturaProveedorId: "fp-1", monto: pesos(200_000) }]);
    expect(h.db.facturasProveedor[0]!.estado).toBe("PAGADA");
    expect(h.db.facturasProveedor[0]!.montoCompensado).toBe(pesos(200_000));
  });
});

describe("Revisión adversarial (FIX) — una factura, un cruce y orden de bloqueo al deshacer", () => {
  it("rechaza cruzar una factura que ya tiene un cruce (aunque le quede saldo): deshacer uno no puede descuadrar el otro", async () => {
    // Pagada 400 por el libro y cruzada 600 (C1); luego se borró el pago: saldo 400.
    h.db.facturasProveedor = [
      { ...facturaProveedor(false), valor: pesos(1_000), estado: "PARCIAL", pagado: 0n, montoCompensado: pesos(600), compensacionId: "C1" },
    ];

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" }),
    ).rejects.toThrow(/ya tiene un cruce de cuenta/);
    expect(h.aplicarSaldo).not.toHaveBeenCalled();
    expect(h.registrarPagoFacturaAbono).not.toHaveBeenCalled();
    expect(h.db.facturasProveedor[0]!.compensacionId).toBe("C1");
    expect(h.db.facturasProveedor[0]!.montoCompensado).toBe(pesos(600));
  });

  it("también rechaza una factura con montoCompensado > 0 sin compensacionId (dato heredado)", async () => {
    h.db.facturasProveedor = [
      { ...facturaProveedor(false), estado: "PARCIAL", montoCompensado: pesos(100_000), compensacionId: null },
    ];
    await expect(
      registrarCompensacion({ ...base, facturaProveedorId: "fp-1" }),
    ).rejects.toBeInstanceOf(CompensacionInvalidaError);
  });

  it("eliminarCompensacion bloquea en el mismo orden que registrarCompensacion: cuenta → abonos de la factura de venta → DO", async () => {
    h.db.facturasProveedor = [facturaProveedor(false)];
    const { compensacionId } = await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });
    expect(h.ordenLocks).toEqual(["cuenta_corriente:emp-1", "pago_factura:fv-1:CLIENTE", "DO:tra-1"]);

    h.ordenLocks.length = 0;
    await eliminarCompensacion("emp-1", compensacionId, "usr-1");
    expect(h.ordenLocks).toEqual(["cuenta_corriente:emp-1", "pago_factura:fv-1:CLIENTE", "DO:tra-1"]);
  });
});
