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
    // Fichas de pago (CxP v2): la de la empresa, una suelta con su mismo NIT y
    // una de OTRA empresa con la misma base (no debe contar para emp-1).
    beneficiarios: [
      { id: "ben-1", nombre: "COLDEX", nit: "900111222", nitBase: "900111222", nombreCorto: null, conciliacionPendiente: false, empresaId: "emp-1" as string | null },
      { id: "ben-suelta", nombre: "COLDEX CUENTA 2", nit: "900111222-1", nitBase: "900111222", nombreCorto: null, conciliacionPendiente: false, empresaId: null as string | null },
      { id: "ben-otra", nombre: "OTRA EMPRESA", nit: "900111222-5", nitBase: "900111222", nombreCorto: null, conciliacionPendiente: false, empresaId: "emp-2" as string | null },
    ],
    facturasProveedor: [] as Array<{
      id: string;
      beneficiarioId: string;
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
          return db.facturas.map((f) => ({
            ...f,
            borrador: { tramite },
            pagos: f.pagos.map((p) => ({ ...p })),
          }));
        },
      },
      beneficiario: {
        // Filtra como Prisma las dos consultas de `fichasDeEmpresa`: por empresa
        // y por NIT base (solo sueltas o de la misma empresa).
        findMany: async ({
          where,
        }: {
          where: { empresaId?: string; nitBase?: { in: string[] }; OR?: { empresaId: string | null }[] };
        }) => {
          await tick();
          return db.beneficiarios
            .filter(
              (b) =>
                (where.empresaId === undefined || b.empresaId === where.empresaId) &&
                (where.nitBase === undefined || where.nitBase.in.includes(b.nitBase)) &&
                (where.OR === undefined || where.OR.some((c) => c.empresaId === b.empresaId)),
            )
            .map((b) => ({ ...b }));
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
          where: {
            estado?: string | { in: string[] };
            repercutible?: boolean;
            beneficiarioId?: { in: string[] };
            compensacionId?: string | null;
          };
        }) => {
          await tick();
          const estados =
            where.estado === undefined ? null : typeof where.estado === "string" ? [where.estado] : where.estado.in;
          return db.facturasProveedor
            .filter(
              (f) =>
                (estados === null || estados.includes(f.estado)) &&
                (where.repercutible === undefined || f.repercutible === where.repercutible) &&
                (where.beneficiarioId === undefined || where.beneficiarioId.in.includes(f.beneficiarioId)) &&
                (where.compensacionId === undefined || f.compensacionId === where.compensacionId),
            )
            .map((f) => ({ ...f, tramiteId: tramite.id, pagos: f.pagado > 0n ? [{ monto: f.pagado }] : [], ajustes: [], tramite }));
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
            .map((m) => ({ ...m, tramite: null }));
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

  const revertirSaldo = vi.fn(async () => [] as string[]);

  return { db, locks, ordenLocks, $transaction, registrarPagoFacturaAbono, bloquearFacturas, aplicarSaldo, revertirSaldo };
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
  revertirSaldo: h.revertirSaldo,
}));
vi.mock("@/lib/cxp/bloqueos", () => ({
  bloquearTramites: vi.fn(async (_tx: unknown, ids: string[]) => {
    for (const id of ids) h.ordenLocks.push(`DO:${id}`);
    return ids;
  }),
}));

const { registrarCompensacion, eliminarCompensacion, CompensacionInvalidaError, CompensacionNoEncontradaError } = await import(
  "../service"
);

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
  h.bloquearFacturas.mockClear();
  h.aplicarSaldo.mockClear();
  h.revertirSaldo.mockClear();
});

function facturaProveedor(repercutible: boolean, beneficiarioId = "ben-1") {
  return {
    id: "fp-1",
    beneficiarioId,
    numFactura: "FE-11298",
    valor: 300_000n,
    fecha: FECHA,
    repercutible,
    estado: "REGISTRADA",
    compensacionId: null,
    pagado: 0n,
    montoCompensado: 0n,
  };
}

/** «Registrar factura de <proveedor>»: lo que le debemos registrado a mano. */
function movimientoManualProveedor(valor: bigint) {
  return {
    id: "mov-manual",
    rol: "PROVEEDOR",
    tipo: "ABONO",
    origen: "CARGO_MANUAL",
    lineaServicio: "TRAMITE",
    concepto: "Factura de contraparte FE-9001",
    valor,
    fecha: FECHA,
    compensacionId: null,
    numeroFactura: "FE-9001",
    soporteKey: null,
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
    // Nos deben 500.000 (factura de venta) y les debemos 300.000 registrados a
    // mano (factura de contraparte sin DO): lo único que se cruza sin factura.
    h.db.movimientos = [movimientoManualProveedor(300_000n)];

    const resultados = await Promise.allSettled([
      registrarCompensacion({ ...base, valor: 300_000n }),
      registrarCompensacion({ ...base, valor: 300_000n }),
    ]);

    const fallidos = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect(String(fallidos[0]!.reason.message)).toMatch(/Solo se pueden cruzar hasta 0/);
    // Una sola pareja ABONO (cliente) + CARGO (proveedor).
    expect(h.db.movimientos.filter((m) => m.origen === "COMPENSACION")).toHaveLength(2);
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
      h.db.facturasProveedor[0]!.pagado = 300_000n;
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
    h.db.facturasProveedor = [{ ...facturaProveedor(false), estado: "PARCIAL", pagado: 100_000n }];

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1", valor: 300_000n }),
    ).rejects.toThrow(/lo que le falta por pagar: 200000/);

    const r = await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });
    expect(r.valor).toBe(200_000n);
    expect(h.aplicarSaldo).toHaveBeenCalledTimes(1);
    expect(h.aplicarSaldo.mock.calls[0]![1].aplicaciones).toEqual([{ facturaProveedorId: "fp-1", monto: 200_000n }]);
    expect(h.db.facturasProveedor[0]!.estado).toBe("PAGADA");
    expect(h.db.facturasProveedor[0]!.montoCompensado).toBe(200_000n);
  });
});

describe("Revisión adversarial (FIX) — una factura, un cruce y orden de bloqueo al deshacer", () => {
  it("rechaza cruzar una factura que ya tiene un cruce (aunque le quede saldo): deshacer uno no puede descuadrar el otro", async () => {
    // Pagada 400 por el libro y cruzada 600 (C1); luego se borró el pago: saldo 400.
    h.db.facturasProveedor = [
      { ...facturaProveedor(false), valor: 1_000n, estado: "PARCIAL", pagado: 0n, montoCompensado: 600n, compensacionId: "C1" },
    ];

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" }),
    ).rejects.toThrow(/ya tiene un cruce de cuenta/);
    expect(h.aplicarSaldo).not.toHaveBeenCalled();
    expect(h.registrarPagoFacturaAbono).not.toHaveBeenCalled();
    expect(h.db.facturasProveedor[0]!.compensacionId).toBe("C1");
    expect(h.db.facturasProveedor[0]!.montoCompensado).toBe(600n);
  });

  it("también rechaza una factura con montoCompensado > 0 sin compensacionId (dato heredado)", async () => {
    h.db.facturasProveedor = [
      { ...facturaProveedor(false), estado: "PARCIAL", montoCompensado: 100_000n, compensacionId: null },
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

describe("Cruce sin factura de proveedor — solo lo registrado a mano (hallazgo B)", () => {
  beforeEach(() => {
    // Coldex nos debe 10.080.187 y le debemos una factura que SÍ se cobra al
    // cliente (repercutible) con saldo 2.000.000; nada registrado a mano.
    h.db.facturas[0]!.saldoACargoCliente = 10_080_187n;
    h.db.facturasProveedor = [{ ...facturaProveedor(true), valor: 2_000_000n }];
  });

  it("sin factura por el saldo de una factura repercutible: 422 y no escribe nada", async () => {
    const error = await registrarCompensacion({ ...base, valor: 2_000_000n }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CompensacionInvalidaError);
    expect((error as InstanceType<typeof CompensacionInvalidaError>).status).toBe(422);
    expect((error as Error).message).toBe(
      "Sin factura de proveedor solo se cruza lo registrado a mano ($0). Lo demás que le debemos está en facturas: las que no se cobran al cliente elígelas en la lista; las demás se pagan por el libro de pagos o en Pagar en bloque.",
    );
    expect(h.db.movimientos).toHaveLength(0);
    expect(h.db.auditorias).toHaveLength(0);
    expect(h.registrarPagoFacturaAbono).not.toHaveBeenCalled();
    expect(h.aplicarSaldo).not.toHaveBeenCalled();
    expect(h.db.facturasProveedor[0]).toMatchObject({ estado: "REGISTRADA", montoCompensado: 0n, compensacionId: null });
  });

  it("con una factura de contraparte a mano de 1.000.000: sin factura cruza hasta 1.000.000, ni un peso más", async () => {
    h.db.movimientos = [movimientoManualProveedor(1_000_000n)];

    await expect(registrarCompensacion({ ...base, valor: 1_000_001n })).rejects.toThrow(
      /Sin factura de proveedor solo se cruza lo registrado a mano \(\$1\.000\.000\)/,
    );
    expect(h.db.movimientos).toHaveLength(1);

    const r = await registrarCompensacion({ ...base, valor: 1_000_000n });
    expect(r.valor).toBe(1_000_000n);
    const cargo = h.db.movimientos.find((m) => m.origen === "COMPENSACION" && m.rol === "PROVEEDOR");
    expect(cargo).toMatchObject({ tipo: "CARGO", valor: 1_000_000n, compensacionId: r.compensacionId });
    // La factura repercutible no se tocó: sigue pendiente por el libro de pagos.
    expect(h.db.facturasProveedor[0]).toMatchObject({ estado: "REGISTRADA", montoCompensado: 0n, compensacionId: null });

    // Lo registrado a mano ya se cruzó: otro cruce sin factura no cabe.
    await expect(registrarCompensacion({ ...base, valor: 1n })).rejects.toThrow(/registrado a mano \(\$0\)/);
  });

  it("la factura de proveedor elegida no pasa por ese tope (se valida contra lo cruzable)", async () => {
    h.db.facturasProveedor = [
      { ...facturaProveedor(true), valor: 2_000_000n },
      { ...facturaProveedor(false), id: "fp-2", numFactura: "FE-20001", valor: 500_000n },
    ];

    const r = await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-2" });
    expect(r.valor).toBe(500_000n);
    expect(h.db.facturasProveedor.find((f) => f.id === "fp-2")).toMatchObject({ estado: "PAGADA" });
  });
});

describe("Fichas del proveedor — la misma lista que el estado de cuenta CxP v2 (hallazgo A)", () => {
  it("una factura no repercutible de una ficha suelta con el mismo NIT se cruza y se deshace completa", async () => {
    h.db.facturasProveedor = [facturaProveedor(false, "ben-suelta")];

    const { compensacionId } = await registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" });
    expect(h.db.facturasProveedor[0]).toMatchObject({ estado: "PAGADA", compensacionId });

    h.ordenLocks.length = 0;
    await eliminarCompensacion("emp-1", compensacionId, "usr-1");
    // La punta proveedor se encontró: su DO se bloqueó y su saldo se devolvió.
    expect(h.ordenLocks).toContain("DO:tra-1");
    expect(h.revertirSaldo).toHaveBeenCalledWith(
      expect.anything(),
      { tipo: "COMPENSACION", compensacionId },
      "usr-1",
      "Cruce deshecho",
    );
  });

  it("una factura de la ficha de OTRA empresa con la misma base no es cruzable ni cuenta en el máximo", async () => {
    h.db.facturasProveedor = [facturaProveedor(false, "ben-otra")];

    await expect(
      registrarCompensacion({ ...base, facturaId: "fv-1", facturaProveedorId: "fp-1" }),
    ).rejects.toThrow(/no es de esta empresa/);
    // Sin esa factura no le debemos nada: sin factura tampoco hay qué cruzar.
    await expect(registrarCompensacion({ ...base, valor: 1n })).rejects.toThrow(/Solo se pueden cruzar hasta 0/);
    expect(h.aplicarSaldo).not.toHaveBeenCalled();
  });

  it("el id de un cruce sobre la ficha de otra empresa no se deshace desde esta", async () => {
    h.db.facturasProveedor = [
      { ...facturaProveedor(false, "ben-otra"), estado: "PAGADA", montoCompensado: 300_000n, compensacionId: "C-ajeno" },
    ];

    await expect(eliminarCompensacion("emp-1", "C-ajeno", "usr-1")).rejects.toBeInstanceOf(
      CompensacionNoEncontradaError,
    );
    expect(h.revertirSaldo).not.toHaveBeenCalled();
  });
});
