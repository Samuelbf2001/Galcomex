/**
 * CxP v2 — `aplicar.ts`: la única puerta del saldo (diseño §B.2). Integración
 * con Postgres local (base desechable), guardián de BD encendido (M5).
 *
 * Cubre: `bloquearFacturas` (saldos frescos y número visible), `aplicarSaldo`
 * (validación, DO cerrado, anticipo, histórico, cruce, traducción del
 * guardián), `revertirSaldo` (pagos y cruce), `recalcularEstadoFactura`,
 * `eliminarAjusteLegado` y `enlazarPagoExistente` (conciliación).
 */
import "dotenv/config";

import { CanalPago, EstadoFacturaProveedor } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AjusteNoEliminableError,
  aplicarSaldo,
  bloquearFacturas,
  eliminarAjusteLegado,
  recalcularEstadoFactura,
  revertirSaldo,
} from "@/lib/cxp/aplicar";
import {
  aplicarAnticipoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import {
  FacturaDeOtroDoError,
  MontoExcedeSaldoError,
  SinAnticipoError,
} from "@/lib/cxp/errores";
import { prisma } from "@/lib/db/prisma";
import { crearPago, enlazarPagoExistente } from "@/lib/pagos/service";
import { TramiteCerradoError } from "@/lib/tramites/guard";

/** Números con dígitos únicos (el aviso de posible duplicado compara dígitos). */
let n = 770_100;
const num = () => `FE-${++n}`;

async function pagoSinFactura(tramiteId: string, valor: bigint, usuarioId: string) {
  return crearPago({ tramiteId, concepto: "Pago sin factura", valor, canalPago: CanalPago.PSE, usuarioId });
}

describe("cxp/aplicar — única puerta del saldo", () => {
  beforeAll(prepararBdAlmacarga);
  afterAll(async () => {
    // Ajustes LEGADO de prueba (FK Restrict hacia la factura) antes de la limpieza común.
    await prisma.ajusteFacturaProveedor.deleteMany({
      where: { factura: { tramite: { comentarios: { startsWith: TEST_PREFIX } } } },
    });
    await liberarBdAlmacarga();
  });

  it("bloquearFacturas trae saldos frescos (puente + ajustes + cruce) y el número visible de la ficha", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, "fe- 770001", 500_000n);
    await prisma.beneficiario.update({
      where: { id: db.almacargaBeneficiarioId },
      data: { numFacturaConEspacio: true, nombreCorto: "ALMACARGA" },
    });
    try {
      await crearPago({
        tramiteId,
        concepto: "Abono",
        valor: 120_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaId, monto: 120_000n }],
        usuarioId: db.userId,
      });
      await prisma.ajusteFacturaProveedor.create({
        data: { facturaId, tipo: "LEGADO", monto: 30_000n, motivo: "Prueba LEGADO" },
      });
      await prisma.facturaProveedor.update({ where: { id: facturaId }, data: { montoCompensado: 50_000n } });

      const mapa = await prisma.$transaction((tx) => bloquearFacturas(tx, [facturaId, facturaId, "no-existe"]));
      expect(mapa.size).toBe(1);
      const f = mapa.get(facturaId)!;
      expect(f.numFactura).toBe("FE 770001");
      expect(f.numFacturaOriginal).toBe("fe- 770001");
      expect([f.valor, f.aplicado, f.ajustes, f.compensado]).toEqual([500_000n, 120_000n, 30_000n, 50_000n]);
      expect(f.tieneAjusteLegado).toBe(true);
      expect(f.nombreProveedor).toBe("ALMACARGA");
      expect(f.tramite.id).toBe(tramiteId);

      const r = await prisma.$transaction((tx) =>
        recalcularEstadoFactura(tx, facturaId, { usuarioId: db.userId, motivo: "prueba" }),
      );
      expect(r.saldo).toBe(300_000n);
      expect(r.estadoDespues).toBe("PARCIAL");
    } finally {
      await prisma.beneficiario.update({
        where: { id: db.almacargaBeneficiarioId },
        data: { numFacturaConEspacio: false, nombreCorto: null },
      });
    }
  });

  it("aplicarSaldo: factura de otro DO, DO cerrado y sin anticipo se rechazan; el histórico no exige anticipo", async (ctx) => {
    const db = ensureDb(ctx);
    const tA = await crearTramiteTest(db);
    const tB = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tA, 1_000_000n);
    const fA = await crearFacturaAlmacargaTest(db, tA, num(), 100_000n);
    const fB = await crearFacturaAlmacargaTest(db, tB, num(), 100_000n);
    const pagoA = await pagoSinFactura(tA, 100_000n, db.userId);
    const pagoB = await crearPago({
      tramiteId: tB,
      concepto: "Costo propio sin anticipo",
      valor: 1n,
      canalPago: CanalPago.PSE,
      facturaProveedorIds: [],
      usuarioId: db.userId,
    }).catch(() => null);
    expect(pagoB).toBeNull(); // tB no tiene anticipo: ni siquiera un pago suelto entra

    // Factura de otro DO en un pago de tA.
    await expect(
      prisma.$transaction(async (tx) => {
        const facturas = await bloquearFacturas(tx, [fB]);
        return aplicarSaldo(tx, {
          origen: { tipo: "PAGO", pagoId: pagoA.id, tramiteId: tA, esHistorico: false },
          aplicaciones: [{ facturaProveedorId: fB, monto: 1n }],
          facturas,
          modo: "PAGO_SIMPLE",
          usuarioId: db.userId,
        });
      }),
    ).rejects.toThrow(FacturaDeOtroDoError);

    // Sin anticipo (tB, repercutible) → SIN_ANTICIPO; como histórico, entra.
    const pagoHistorico = await prisma.pagoTramite.create({
      data: { tramiteId: tB, concepto: "Pago histórico", valor: 100_000n, canalPago: CanalPago.PSE, orden: 1 },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const facturas = await bloquearFacturas(tx, [fB]);
        return aplicarSaldo(tx, {
          origen: { tipo: "PAGO", pagoId: pagoHistorico.id, tramiteId: tB, esHistorico: false },
          aplicaciones: [{ facturaProveedorId: fB, monto: 100_000n }],
          facturas,
          modo: "PAGO_SIMPLE",
          usuarioId: db.userId,
        });
      }),
    ).rejects.toThrow(SinAnticipoError);
    const historico = await prisma.$transaction(async (tx) => {
      const facturas = await bloquearFacturas(tx, [fB]);
      return aplicarSaldo(tx, {
        origen: { tipo: "PAGO", pagoId: pagoHistorico.id, tramiteId: tB, esHistorico: true },
        aplicaciones: [{ facturaProveedorId: fB, monto: 100_000n }],
        facturas,
        modo: "CONCILIACION",
        usuarioId: db.userId,
      });
    });
    expect(historico.cambios[0]).toMatchObject({ saldoAntes: 100_000n, saldoDespues: 0n, estadoDespues: "PAGADA" });

    // DO cerrado → TramiteCerradoError.
    await prisma.tramiteDO.update({ where: { id: tA }, data: { estado: "CERRADO" } });
    await expect(
      prisma.$transaction(async (tx) => {
        const facturas = await bloquearFacturas(tx, [fA]);
        return aplicarSaldo(tx, {
          origen: { tipo: "PAGO", pagoId: pagoA.id, tramiteId: tA, esHistorico: false },
          aplicaciones: [{ facturaProveedorId: fA, monto: 100_000n }],
          facturas,
          modo: "PAGO_SIMPLE",
          usuarioId: db.userId,
        });
      }),
    ).rejects.toThrow(TramiteCerradoError);
    await prisma.tramiteDO.update({ where: { id: tA }, data: { estado: "EN_TRAMITE" } });
  });

  it("si el mapa está viejo y la BD ya no tiene saldo, el guardián (M5) responde y se traduce a MONTO_EXCEDE_SALDO", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, num(), 100_000n);
    const p1 = await pagoSinFactura(tramiteId, 100_000n, db.userId);
    const p2 = await pagoSinFactura(tramiteId, 100_000n, db.userId);

    await expect(
      prisma.$transaction(async (tx) => {
        const viejo = await bloquearFacturas(tx, [facturaId]);
        // Alguien escribe el puente por fuera del dominio (script): la factura queda sin saldo.
        await tx.pagoTramiteFactura.create({ data: { pagoId: p1.id, facturaId, monto: 100_000n } });
        return aplicarSaldo(tx, {
          origen: { tipo: "PAGO", pagoId: p2.id, tramiteId, esHistorico: false },
          aplicaciones: [{ facturaProveedorId: facturaId, monto: 100_000n }],
          facturas: viejo,
          modo: "PAGO_SIMPLE",
          usuarioId: db.userId,
        });
      }),
    ).rejects.toThrow(MontoExcedeSaldoError);
    expect(await prisma.pagoTramiteFactura.count({ where: { facturaId } })).toBe(0);
  });

  it("cruce: aplicarSaldo(COMPENSACION) sube montoCompensado; revertirSaldo(COMPENSACION) lo devuelve", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, num(), 80_000n);
    await prisma.facturaProveedor.update({ where: { id: facturaId }, data: { repercutible: false } });

    await prisma.$transaction(async (tx) => {
      const facturas = await bloquearFacturas(tx, [facturaId]);
      return aplicarSaldo(tx, {
        origen: { tipo: "COMPENSACION", compensacionId: "cruce-prueba-1" },
        aplicaciones: [{ facturaProveedorId: facturaId, monto: 80_000n }],
        facturas,
        modo: "COMPENSACION",
        usuarioId: db.userId,
      });
    });
    let f = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } });
    expect(f.montoCompensado).toBe(80_000n);
    expect(f.compensacionId).toBe("cruce-prueba-1");
    expect(f.estado).toBe(EstadoFacturaProveedor.PAGADA);

    const afectadas = await prisma.$transaction((tx) =>
      revertirSaldo(tx, { tipo: "COMPENSACION", compensacionId: "cruce-prueba-1" }, db.userId, "Cruce deshecho"),
    );
    expect(afectadas).toEqual([facturaId]);
    f = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } });
    expect(f.montoCompensado).toBe(0n);
    expect(f.compensacionId).toBeNull();
    expect(f.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
  });

  it("revertirSaldo(PAGOS) borra solo el puente de esos pagos y recalcula: dos abonos, se revierte uno → Abonada", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, num(), 300_000n);
    const a = await crearPago({
      tramiteId,
      concepto: "Abono 1",
      valor: 100_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: facturaId, monto: 100_000n }],
      usuarioId: db.userId,
    });
    await crearPago({
      tramiteId,
      concepto: "Abono 2",
      valor: 200_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: facturaId, monto: 200_000n }],
      usuarioId: db.userId,
    });
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe("PAGADA");

    await prisma.$transaction((tx) => revertirSaldo(tx, { tipo: "PAGOS", pagoIds: [a.id] }, db.userId, "prueba"));
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe("PARCIAL");
    expect(await prisma.pagoTramiteFactura.count({ where: { facturaId } })).toBe(1);
    const auditoria = await prisma.auditLog.findFirst({
      where: { entidad: "FacturaProveedor", entidadId: facturaId, accion: "UPDATE_ESTADO" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(auditoria?.despues)).toContain("REVERSION");
  });

  it("eliminarAjusteLegado: solo LEGADO; quitarlo reabre la factura (Pagada con ajuste → Abonada)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, num(), 300_000n);
    await crearPago({
      tramiteId,
      concepto: "Abono real (heredado)",
      valor: 100_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: facturaId, monto: 100_000n }],
      usuarioId: db.userId,
    });
    // Lo que dejó la migración para una factura que estaba "PAGADA" con un pago menor.
    const legado = await prisma.ajusteFacturaProveedor.create({
      data: { facturaId, tipo: "LEGADO", monto: 200_000n, motivo: "Migración CxP v2 (prueba)" },
    });
    await prisma.$transaction((tx) => recalcularEstadoFactura(tx, facturaId, { usuarioId: db.userId, motivo: "prueba" }));
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe("PAGADA");

    // Un ajuste que no es LEGADO no se quita por aquí (v2 no crea ajustes manuales, D-8).
    const otro = await crearFacturaAlmacargaTest(db, tramiteId, num(), 10_000n);
    const noLegado = await prisma.ajusteFacturaProveedor.create({
      data: { facturaId: otro, tipo: "REDONDEO", monto: 1n, motivo: "Prueba" },
    });
    await expect(eliminarAjusteLegado(noLegado.id, "No debería poder", db.userId)).rejects.toThrow(AjusteNoEliminableError);

    const r = await eliminarAjusteLegado(legado.id, "Revisado con el extracto: fue un abono", db.userId);
    expect(r).toEqual({ facturaId, estado: "PARCIAL", saldo: 200_000n });
    expect(await prisma.ajusteFacturaProveedor.count({ where: { id: legado.id } })).toBe(0);
  });

  it("enlazarPagoExistente (conciliación): enlaza un pago previo sin crear plata; no más de lo que el pago tiene sin aplicar", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, num(), 502_801n);
    const previo = await crearPago({
      tramiteId,
      concepto: "ALMACENAJE ALMACARGA FACT. FE 11298 (pagado antes del sistema)",
      valor: 502_801n,
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      beneficiarioIds: [db.almacargaBeneficiarioId],
      usuarioId: db.userId,
    });
    const saldoDoAntes = (await prisma.pagoTramite.count({ where: { tramiteId } }));

    await expect(
      enlazarPagoExistente({
        pagoId: previo.id,
        aplicaciones: [{ facturaProveedorId: facturaId, monto: 502_802n }],
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/solo tiene \$502\.801 sin aplicar/);

    const r = await enlazarPagoExistente({
      pagoId: previo.id,
      aplicaciones: [{ facturaProveedorId: facturaId, monto: 502_801n }],
      usuarioId: db.userId,
    });
    expect(r.aplicado).toBe(502_801n);
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe("PAGADA");
    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(saldoDoAntes); // no creó pago
  });
});
