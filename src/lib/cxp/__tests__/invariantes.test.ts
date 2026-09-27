/**
 * CxP v2 — Invariantes I1–I7 (diseño §C R20, P7b).
 * Puro: cada invariante detecta su violación con datos armados a mano.
 * Integración: sobre una base real, un bloque y un pago suelto cumplen todo;
 * al romper a propósito el estado, el total o el costo de un bloque, el
 * verificador lo encuentra (y se restaura).
 */
import "dotenv/config";

import { CanalPago, CategoriaDocumento } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import {
  type DatosInvariantes,
  evaluarInvariantes,
  type FacturaInv,
  type GrupoInv,
  informeInvariantesTexto,
  type PagoInv,
  verificarInvariantes,
} from "@/lib/cxp/invariantes";
import { prisma } from "@/lib/db/prisma";
import { crearPago, crearPagoMultiDO } from "@/lib/pagos/service";

const CORTE = new Date("2026-09-25T10:00:00Z");
const DESPUES = new Date("2026-10-01T00:00:00Z");
const ANTES = new Date("2026-09-01T00:00:00Z");

function factura(p: Partial<FacturaInv> & Pick<FacturaInv, "id">): FacturaInv {
  return {
    numFactura: `FE-${p.id}`,
    consecutivo: "DO.BAQ26-0001",
    clave: "NIT:800154017",
    nombreProveedor: "ALMACARGA",
    valor: 100_000n,
    aplicado: 0n,
    ajustes: 0n,
    compensado: 0n,
    parteNegativa: false,
    estado: "REGISTRADA",
    ...p,
  };
}

function pago(p: Partial<PagoInv> & Pick<PagoInv, "id">): PagoInv {
  return {
    consecutivo: "DO.BAQ26-0001",
    valor: 100_000n,
    costoBancario: 0n,
    grupoPagoId: null,
    createdAt: DESPUES,
    clavesFichas: ["NIT:800154017"],
    puentes: [],
    ...p,
  };
}

function grupo(p: Partial<GrupoInv> & Pick<GrupoInv, "id">): GrupoInv {
  return { estado: "ACTIVO", costoBancario: 3_900n, costoAsumidoPor: "GALCOMEX", totalAplicado: 100_000n, ...p };
}

function datos(p: Partial<DatosInvariantes>): DatosInvariantes {
  return { facturas: [], pagos: [], grupos: [], corteV2: CORTE, guardianes: [], ...p };
}

describe("invariantes — evaluación pura", () => {
  it("datos coherentes (pendiente, abonada, pagada, bloque GALCOMEX y PRIMER_DO) → 0 violaciones", () => {
    const inf = evaluarInvariantes(
      datos({
        facturas: [
          factura({ id: "a" }),
          factura({ id: "b", aplicado: 40_000n, estado: "PARCIAL" }),
          factura({ id: "c", aplicado: 60_000n, ajustes: 40_000n, estado: "PAGADA" }),
          factura({ id: "d", compensado: 100_000n, estado: "PAGADA", clave: "NIT:1", nombreProveedor: "OTRO" }),
        ],
        pagos: [
          pago({ id: "p1", valor: 40_000n, puentes: [{ facturaId: "b", monto: 40_000n }], grupoPagoId: "g1" }),
          pago({ id: "p2", valor: 60_000n, puentes: [{ facturaId: "c", monto: 60_000n }], grupoPagoId: "g2", costoBancario: 3_900n }),
        ],
        grupos: [
          grupo({ id: "g1", totalAplicado: 40_000n }),
          grupo({ id: "g2", totalAplicado: 60_000n, costoAsumidoPor: "PRIMER_DO" }),
          grupo({ id: "g3", estado: "ANULADO", totalAplicado: 999n }),
        ],
        guardianes: [{ nombre: "trg_pago_factura_saldo", encendido: true }],
      }),
    );
    expect(inf.violaciones).toEqual([]);
    expect(inf.avisos).toEqual([]);
    expect(inf.totales).toEqual({ facturas: 4, pagos: 2, grupos: 3, proveedores: 2 });
    expect(Object.values(inf.violacionesPor).every((n) => n === 0)).toBe(true);
  });

  it("I2 sobre-aplicada y I4 estado distinto del saldo (I1 cuenta la deuda escondida por proveedor)", () => {
    const inf = evaluarInvariantes(
      datos({
        facturas: [
          factura({ id: "sobre", aplicado: 120_000n, estado: "PAGADA" }),
          factura({ id: "escondida", aplicado: 30_000n, estado: "PAGADA" }),
          factura({ id: "negativa", parteNegativa: true }),
        ],
      }),
    );
    expect(inf.violacionesPor.I2).toBe(2);
    expect(inf.violacionesPor.I4).toBe(1);
    expect(inf.violaciones.find((h) => h.invariante === "I4")?.id).toBe("escondida");
    // Proveedor: 300.000 facturado; lo "mostrado" no incluye el saldo de la PAGADA con 70.000 pendientes.
    expect(inf.violacionesPor.I1).toBe(1);
    expect(inf.violaciones.find((h) => h.invariante === "I1")?.mensaje).toMatch(/ALMACARGA/);
  });

  it("I3: puente mayor que el pago = violación; pago v2 con parte sin factura = aviso; heredado = nada", () => {
    const inf = evaluarInvariantes(
      datos({
        facturas: [factura({ id: "f", valor: 500_000n, aplicado: 0n })],
        pagos: [
          pago({ id: "mayor", valor: 50_000n, puentes: [{ facturaId: "f", monto: 60_000n }] }),
          pago({ id: "menor", valor: 80_000n, puentes: [{ facturaId: "f", monto: 60_000n }] }),
          pago({ id: "viejo", valor: 80_000n, createdAt: ANTES, puentes: [{ facturaId: "f", monto: 0n }] }),
        ],
      }),
    );
    expect(inf.violaciones.filter((h) => h.invariante === "I3").map((h) => h.id)).toEqual(["mayor"]);
    expect(inf.avisos.filter((h) => h.invariante === "I3").map((h) => h.id)).toEqual(["menor"]);
  });

  it("I5 costo del bloque mal repartido e I6 total ≠ Σ pagos, bloque anulado con pagos y pagos sin cabecera", () => {
    const inf = evaluarInvariantes(
      datos({
        pagos: [
          pago({ id: "p1", valor: 60_000n, costoBancario: 3_900n, grupoPagoId: "galcomex" }),
          pago({ id: "p2", valor: 60_000n, costoBancario: 1_000n, grupoPagoId: "primer" }),
          pago({ id: "p3", valor: 10_000n, grupoPagoId: "anulado" }),
          pago({ id: "p4", valor: 10_000n, grupoPagoId: "fantasma" }),
        ],
        grupos: [
          grupo({ id: "galcomex", totalAplicado: 60_000n }),
          grupo({ id: "primer", costoAsumidoPor: "PRIMER_DO", totalAplicado: 70_000n }),
          grupo({ id: "anulado", estado: "ANULADO", totalAplicado: 10_000n }),
        ],
      }),
    );
    expect(inf.violaciones.filter((h) => h.invariante === "I5").map((h) => h.id).sort()).toEqual(["galcomex", "primer"]);
    expect(inf.violaciones.filter((h) => h.invariante === "I6").map((h) => h.id).sort()).toEqual(["anulado", "fantasma", "primer"]);
  });

  it("I7: pago sin ficha o con factura de otro proveedor; heredado → aviso", () => {
    const inf = evaluarInvariantes(
      datos({
        facturas: [factura({ id: "alma", valor: 100_000n, aplicado: 100_000n, estado: "PAGADA" }), factura({ id: "tampa", clave: "BEN:tampa", aplicado: 50_000n, estado: "PARCIAL" })],
        pagos: [
          pago({ id: "sin-ficha", clavesFichas: [], puentes: [{ facturaId: "alma", monto: 50_000n }] }),
          pago({ id: "otro", clavesFichas: ["BEN:tampa"], valor: 50_000n, puentes: [{ facturaId: "alma", monto: 50_000n }] }),
          pago({ id: "viejo", clavesFichas: ["NIT:800154017"], valor: 50_000n, createdAt: ANTES, puentes: [{ facturaId: "tampa", monto: 50_000n }] }),
        ],
      }),
    );
    expect(inf.violaciones.filter((h) => h.invariante === "I7").map((h) => h.id).sort()).toEqual(["otro", "sin-ficha"]);
    expect(inf.avisos.filter((h) => h.invariante === "I7").map((h) => h.id)).toEqual(["viejo"]);
  });

  it("guardián apagado → aviso (no violación) y el texto lo dice", () => {
    const inf = evaluarInvariantes(datos({ guardianes: [{ nombre: "trg_pago_factura_saldo", encendido: false }] }));
    expect(inf.violaciones).toEqual([]);
    expect(inf.avisos.map((h) => h.invariante)).toEqual(["GUARDIAN"]);
    const texto = informeInvariantesTexto(inf);
    expect(texto).toMatch(/I1: 0 · I2: 0 · I3: 0 · I4: 0 · I5: 0 · I6: 0 · I7: 0/);
    expect(texto).toMatch(/apagado/);
  });
});

describe("invariantes — integración con la BD", () => {
  beforeAll(prepararBdAlmacarga);
  afterAll(liberarBdAlmacarga);

  it("un bloque (GALCOMEX) y un pago suelto cumplen I1–I7; romper estado, total y costo se detecta", async (ctx) => {
    const db = ensureDb(ctx);
    const t1 = await crearTramiteTest(db);
    const t2 = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, t1, 1_000_000n);
    await aplicarAnticipoTest(db, t2, 1_000_000n);
    const f1 = await crearFacturaAlmacargaTest(db, t1, "FE-880101", 300_000n);
    const f2 = await crearFacturaAlmacargaTest(db, t2, "FE-880202", 200_000n);
    const f3 = await crearFacturaAlmacargaTest(db, t2, "FE-880303", 100_000n);
    const doc = await prisma.documento.create({
      data: {
        tramiteId: t1,
        categoria: CategoriaDocumento.COMPROBANTE_BANCARIO,
        nombreArchivo: "comprobante.pdf",
        storageKey: `vitest/invariantes/${Date.now()}.pdf`,
        mimeType: "application/pdf",
        tamanoBytes: 10,
        subidoPorId: db.userId,
      },
    });
    const bloque = await crearPagoMultiDO({
      beneficiarioId: db.almacargaBeneficiarioId,
      facturas: [
        { facturaProveedorId: f1, monto: 300_000n },
        { facturaProveedorId: f2, monto: 150_000n },
      ],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      documentoId: doc.id,
      costoAsumidoPor: "GALCOMEX",
      usuarioId: db.userId,
    });
    const suelto = await crearPago({
      tramiteId: t2,
      concepto: "Pago FE-880303",
      valor: 100_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: f3, monto: 100_000n }],
      usuarioId: db.userId,
    });

    const mios = new Set([f1, f2, f3, bloque.grupoPagoId, suelto.id, ...bloque.pagos.map((p) => p.id)]);
    const deMios = (inf: Awaited<ReturnType<typeof verificarInvariantes>>) => inf.violaciones.filter((h) => mios.has(h.id));

    expect(deMios(await verificarInvariantes())).toEqual([]);

    // Romper a propósito (y restaurar): estado, total del bloque y costo del bloque.
    const cabecera = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: bloque.grupoPagoId } });
    expect(cabecera.costoAsumidoPor).toBe("GALCOMEX");
    try {
      await prisma.facturaProveedor.update({ where: { id: f2 }, data: { estado: "PAGADA" } });
      await prisma.pagoGrupo.update({ where: { id: bloque.grupoPagoId }, data: { totalAplicado: 1n } });
      await prisma.pagoTramite.update({ where: { id: bloque.pagos[0].id }, data: { costoBancario: 3_900n } });
      const roto = deMios(await verificarInvariantes());
      expect(roto.map((h) => `${h.invariante}:${h.id}`).sort()).toEqual(
        [`I4:${f2}`, `I5:${bloque.grupoPagoId}`, `I6:${bloque.grupoPagoId}`].sort(),
      );
    } finally {
      await prisma.facturaProveedor.update({ where: { id: f2 }, data: { estado: "PARCIAL" } });
      await prisma.pagoGrupo.update({ where: { id: bloque.grupoPagoId }, data: { totalAplicado: cabecera.totalAplicado } });
      await prisma.pagoTramite.update({ where: { id: bloque.pagos[0].id }, data: { costoBancario: 0n } });
    }
    expect(deMios(await verificarInvariantes())).toEqual([]);

    // La base de pruebas tiene M5: los guardianes están encendidos.
    expect((await verificarInvariantes()).avisos.filter((h) => h.invariante === "GUARDIAN")).toEqual([]);
  });
});
