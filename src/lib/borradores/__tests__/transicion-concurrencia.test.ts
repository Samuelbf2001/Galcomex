// @vitest-environment node
/**
 * Aprobar un borrador bajo concurrencia (revisión de seguridad, hallazgo BAJO).
 *
 * `transicionarBorrador` toma el mismo advisory lock que la edición de líneas
 * (`borrador_lineas:<id>`) y cambia el estado con un update condicionado al
 * estado leído (count = 1 o 409).
 *
 * Sin BD: Prisma es un doble en memoria; el advisory lock se simula con un
 * mutex por clave, reentrante dentro de la misma transacción.
 */
import { EstadoBorrador } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const db = { estado: "EN_REVISION" as string, aprobadoPorId: null as string | null };
  const auditorias: Array<{ accion: string }> = [];
  const locks = new Map<string, { promise: Promise<void>; release: () => void }>();
  const ordenLlamadas: string[] = [];
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  const findUnique = vi.fn(async () => {
    ordenLlamadas.push("findUnique");
    await tick();
    return {
      id: "bor-1",
      tramiteId: "tra-1",
      estado: db.estado,
      comision: 150_000n,
      ivaComision: 28_500n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: 0n,
      totalPagos: 0n,
      totalFactura: 178_500n,
      saldoAFavorCliente: 0n,
      saldoACargoCliente: 178_500n,
      saldoAFavorLM: 0n,
      saldoACargoLM: 0n,
      retenciones: 0n,
      conceptosOperacionales: null,
      tramite: { id: "tra-1", clienteId: "cli-1", consecutivo: "DO.BAQ26-0001", estado: "ENVIADO_A_FACTURAR" },
    };
  });

  const updateMany = vi.fn(
    async ({ where, data }: { where: { id: string; estado: string }; data: Record<string, unknown> }) => {
      ordenLlamadas.push("updateMany");
      await tick();
      if (db.estado !== where.estado) return { count: 0 };
      Object.assign(db, data);
      return { count: 1 };
    },
  );

  const findUniqueOrThrow = vi.fn(async () => ({
    id: "bor-1",
    ...db,
    lineasRevision: [],
    formaPago: null,
    factura: null,
  }));

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
        ordenLlamadas.push(`lock:${key}`);
        return 1;
      },
      borradorFactura: { findUnique, updateMany, findUniqueOrThrow },
      auditLog: {
        create: vi.fn(async ({ data }: { data: { accion: string } }) => {
          auditorias.push(data);
          return {};
        }),
      },
    };
  }

  const $transaction = vi.fn(async (fn: (tx: ReturnType<typeof crearTx>) => Promise<unknown>) => {
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

  return { db, auditorias, locks, ordenLlamadas, findUnique, updateMany, findUniqueOrThrow, $transaction, tick };
});

vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: h.$transaction } }));
vi.mock("@/lib/tramites/guard", () => ({ assertTramiteModificable: vi.fn(async () => {}) }));

const { transicionarBorrador } = await import("../service");

const aprobar = () =>
  transicionarBorrador({ borradorId: "bor-1", nuevoEstado: EstadoBorrador.APROBADO, usuarioId: "rev-1" });

beforeEach(() => {
  h.db.estado = "EN_REVISION";
  h.db.aprobadoPorId = null;
  h.auditorias.length = 0;
  h.locks.clear();
  h.ordenLlamadas.length = 0;
  h.findUnique.mockClear();
  h.updateMany.mockClear();
  h.findUniqueOrThrow.mockClear();
});

describe("transicionarBorrador — aprobación bajo lock y condicionada al estado", () => {
  it("toma el lock de líneas antes de leer y aprueba con update condicionado a EN_REVISION", async () => {
    const r = await aprobar();

    expect(r.ok).toBe(true);
    expect(h.ordenLlamadas.slice(0, 2)).toEqual(["lock:borrador_lineas:bor-1", "findUnique"]);
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bor-1", estado: "EN_REVISION" } }),
    );
    expect(h.db).toMatchObject({ estado: "APROBADO", aprobadoPorId: "rev-1" });
    expect(h.auditorias.map((a) => a.accion)).toEqual(["APPROVE"]);
  });

  it("si el estado cambió entre la lectura y el update: 409, sin auditoría", async () => {
    h.updateMany.mockImplementationOnce(async () => ({ count: 0 }));

    const r = await aprobar();

    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(h.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(h.auditorias).toHaveLength(0);
  });

  it("dos aprobaciones simultáneas: una aprueba y la otra ve la transición inválida", async () => {
    const [a, b] = await Promise.all([aprobar(), aprobar()]);

    const oks = [a, b].filter((r) => r.ok);
    const fallos = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fallos[0]).toMatchObject({ ok: false, status: 422 });
    expect(h.auditorias.filter((x) => x.accion === "APPROVE")).toHaveLength(1);
  });

  it("espera a que termine una edición de líneas en curso antes de tomar el snapshot", async () => {
    let soltar: () => void = () => {};
    const edicion = h.$transaction(async (tx) => {
      const clave = "borrador_lineas:bor-1";
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${clave}))`;
      await new Promise<void>((r) => (soltar = r));
    });
    await vi.waitFor(() => expect(h.locks.has("borrador_lineas:bor-1")).toBe(true));

    const aprobacion = aprobar();
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.findUnique).not.toHaveBeenCalled();

    soltar();
    await edicion;
    await expect(aprobacion).resolves.toMatchObject({ ok: true });
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });
});
