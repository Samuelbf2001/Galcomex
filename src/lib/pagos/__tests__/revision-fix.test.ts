/**
 * CxP v2 — revisión adversarial (paquete FIX), contra Postgres real.
 *
 *  - Una factura, un cruce: no se puede cruzar dos veces la misma factura de
 *    proveedor; deshacer el único cruce deja la factura exacta.
 *  - "Generar pago" idempotente: el reintento con la misma clave (seguido o
 *    simultáneo) devuelve el pago original con `repetido: true`, nunca 409
 *    "ya está pagada" / "solo le faltan"; otra factura u otro monto con la
 *    misma clave → IDEMPOTENCIA_CONFLICTO.
 *  - Editar un pago de un bloque mientras otro lo anula: sin deadlock.
 *  - GET /api/pagos filtrado por proveedor: OPERATIVO no recibe los totales.
 *
 * Requiere DATABASE_URL de una base desechable migrada con M1–M5 (+ seed).
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  CanalPago,
  EstadoFacturaProveedor,
  OrigenMovimientoCuenta,
  RolCuenta,
  TipoCliente,
  TipoMovimientoCuenta,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearDocumentoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  type Fixture,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { IdempotenciaConflictoError } from "@/lib/cxp/errores";
import { eliminarCompensacion, registrarCompensacion } from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";

import { generarPagoDesdeFactura } from "../generar-desde-factura";
import {
  actualizarPago,
  anularPagoGrupo,
  crearPago,
  crearPagoMultiDO,
  eliminarPago,
  listarPagosGlobal,
} from "../service";

let consecutivoFactura = 0;
function numFactura(): string {
  consecutivoFactura += 1;
  return `FE-77${String(consecutivoFactura).padStart(4, "0")}`;
}

async function doConAnticipo(db: Fixture): Promise<string> {
  const tramiteId = await crearTramiteTest(db);
  await aplicarAnticipoTest(db, tramiteId, 5_000_000n);
  return tramiteId;
}

async function partes(facturaId: string) {
  const f = await prisma.facturaProveedor.findUniqueOrThrow({
    where: { id: facturaId },
    include: { pagos: { select: { monto: true } }, ajustes: { select: { monto: true } } },
  });
  const aplicado = f.pagos.reduce((s, p) => s + p.monto, 0n);
  const ajustes = f.ajustes.reduce((s, a) => s + a.monto, 0n);
  return {
    estado: f.estado,
    aplicado,
    compensado: f.montoCompensado,
    compensacionId: f.compensacionId,
    saldo: f.valor - aplicado - ajustes - f.montoCompensado,
  };
}

function mensaje(r: PromiseSettledResult<unknown>): string {
  if (r.status !== "rejected") return "";
  return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

async function borrarMovimientosDePrueba() {
  const empresas = await prisma.cliente.findMany({
    where: { nit: { startsWith: `${TEST_PREFIX}-fix-` } },
    select: { id: true },
  });
  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: empresas.map((e) => e.id) } } });
}

beforeAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosDePrueba();
    } catch {
      // Sin BD: prepararBdAlmacarga deja el motivo del skip.
    }
  }
  await prepararBdAlmacarga();
});

afterAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosDePrueba();
    } catch {
      // Sin BD no hay nada que limpiar.
    }
  }
  await liberarBdAlmacarga();
});

// ─── Una factura, un cruce ───────────────────────────────────────────────────

describe("Cruce de cuenta corriente — una factura, un cruce", () => {
  it("pago 400 + cruce 600 + borrar el pago: no admite un segundo cruce, y deshacer el único deja la factura exacta", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await prisma.cliente.create({
      data: {
        nombre: "COLDEX FIX",
        nit: `${TEST_PREFIX}-fix-coldex-${runId}`,
        tipo: TipoCliente.PROPIO,
        esCliente: true,
        esProveedor: true,
      },
    });
    await prisma.empresaCapacidad.create({
      data: { empresaId: empresa.id, codigo: "cuenta_corriente", habilitado: true },
    });
    const ficha = await prisma.beneficiario.create({
      data: { nombre: "COLDEX FIX", nit: `${TEST_PREFIX}-fix-ben-coldex-${runId}`, empresaId: empresa.id },
    });
    await prisma.movimientoCuenta.create({
      data: {
        empresaId: empresa.id,
        rol: RolCuenta.CLIENTE,
        tipo: TipoMovimientoCuenta.CARGO,
        origen: OrigenMovimientoCuenta.CARGO_MANUAL,
        concepto: "Mensualidad de prueba",
        valor: 5_000n,
        fecha: new Date(Date.UTC(3003, 0, 15)),
        registradoPorId: db.userId,
      },
    });

    const tramiteId = await doConAnticipo(db);
    const f = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: ficha.id,
      numFactura: numFactura(),
      valor: 1_000n,
      fecha: new Date(Date.UTC(3003, 1, 1)),
      repercutible: false,
      subidaPorId: db.userId,
    });

    const pago = await crearPago({
      tramiteId,
      concepto: "Abono 400",
      valor: 400n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: f.id, monto: 400n }],
      usuarioId: db.userId,
    });
    const c1 = await registrarCompensacion({
      empresaId: empresa.id,
      fecha: new Date(Date.UTC(3003, 2, 1)),
      concepto: "Cruce 1",
      facturaProveedorId: f.id,
      usuarioId: db.userId,
    });
    expect(c1.valor).toBe(600n);
    expect((await partes(f.id)).estado).toBe(EstadoFacturaProveedor.PAGADA);

    await eliminarPago(pago.id, db.userId);
    expect(await partes(f.id)).toMatchObject({ saldo: 400n, compensado: 600n, estado: EstadoFacturaProveedor.PARCIAL });

    // Segundo cruce sobre la misma factura: rechazado sin tocar nada.
    await expect(
      registrarCompensacion({
        empresaId: empresa.id,
        fecha: new Date(Date.UTC(3003, 2, 2)),
        concepto: "Cruce 2",
        facturaProveedorId: f.id,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/ya tiene un cruce de cuenta/);
    expect(await partes(f.id)).toMatchObject({ saldo: 400n, compensado: 600n, compensacionId: c1.compensacionId });
    expect(await prisma.movimientoCuenta.count({ where: { empresaId: empresa.id, origen: "COMPENSACION" } })).toBe(1);

    // Deshacer el único cruce: la factura vuelve a deber su total.
    await eliminarCompensacion(empresa.id, c1.compensacionId, db.userId);
    expect(await partes(f.id)).toMatchObject({
      saldo: 1_000n,
      compensado: 0n,
      compensacionId: null,
      estado: EstadoFacturaProveedor.REGISTRADA,
    });

    // Y se puede volver a cruzar por el total.
    const c3 = await registrarCompensacion({
      empresaId: empresa.id,
      fecha: new Date(Date.UTC(3003, 2, 3)),
      concepto: "Cruce por el total",
      facturaProveedorId: f.id,
      usuarioId: db.userId,
    });
    expect(c3.valor).toBe(1_000n);
    expect(await partes(f.id)).toMatchObject({ saldo: 0n, estado: EstadoFacturaProveedor.PAGADA });
  }, 30_000);
});

// ─── "Generar pago" idempotente ──────────────────────────────────────────────

describe("Generar pago — idempotencia (CA-43, §B.5)", () => {
  it("reintento seguido con la misma clave y sin monto (saldo completo): devuelve el pago original con repetido:true", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), 464_077n);
    const clave = randomUUID();
    const entrada = {
      facturaProveedorId: facturaId,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      claveIdempotencia: clave,
      usuarioId: db.userId,
    };

    const primero = await generarPagoDesdeFactura(entrada);
    expect(primero.pago.repetido).toBe(false);
    const segundo = await generarPagoDesdeFactura(entrada);
    expect(segundo.pago.repetido).toBe(true);
    expect(segundo.pago.id).toBe(primero.pago.id);
    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
    expect(await partes(facturaId)).toMatchObject({ aplicado: 464_077n, estado: EstadoFacturaProveedor.PAGADA });
  }, 30_000);

  it("reintento de un abono (600 sobre 1.000) con la misma clave: repetido, no 'solo le faltan'", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), 1_000n);
    const entrada = {
      facturaProveedorId: facturaId,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      monto: 600n,
      claveIdempotencia: randomUUID(),
      usuarioId: db.userId,
    };
    const primero = await generarPagoDesdeFactura(entrada);
    const segundo = await generarPagoDesdeFactura(entrada);
    expect(segundo.pago).toMatchObject({ id: primero.pago.id, repetido: true });
    expect(await partes(facturaId)).toMatchObject({ aplicado: 600n, saldo: 400n });

    // Misma clave, otro monto → conflicto (no un segundo abono).
    await expect(generarPagoDesdeFactura({ ...entrada, monto: 300n })).rejects.toBeInstanceOf(IdempotenciaConflictoError);
    // Misma clave, otra factura → conflicto.
    const otra = await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), 2_000n);
    await expect(
      generarPagoDesdeFactura({ ...entrada, facturaProveedorId: otra }),
    ).rejects.toBeInstanceOf(IdempotenciaConflictoError);
    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
  }, 30_000);

  it("tres envíos simultáneos de «Generar pago» con la misma clave: un solo pago, los tres responden bien", async (ctx) => {
    const db = ensureDb(ctx);
    for (let ronda = 0; ronda < 3; ronda++) {
      const tramiteId = await doConAnticipo(db);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), 300_000n + BigInt(ronda));
      const entrada = {
        facturaProveedorId: facturaId,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        claveIdempotencia: randomUUID(),
        usuarioId: db.userId,
      };
      const resultados = await Promise.allSettled([
        generarPagoDesdeFactura(entrada),
        generarPagoDesdeFactura(entrada),
        generarPagoDesdeFactura(entrada),
      ]);
      expect(resultados.map(mensaje), `ronda ${ronda}`).toEqual(["", "", ""]);
      const pagos = resultados.flatMap((r) => (r.status === "fulfilled" ? [r.value.pago] : []));
      expect(new Set(pagos.map((p) => p.id)).size).toBe(1);
      expect(pagos.map((p) => p.repetido).sort()).toEqual([false, true, true]);
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
    }
  }, 60_000);
});

// ─── Orden de bloqueo: editar un pago de bloque ∥ anular el bloque ──────────

describe("actualizarPago de un pago de bloque ∥ anularPagoGrupo: sin deadlock", () => {
  it("4 rondas: ninguna operación muere por deadlock", async (ctx) => {
    const db = ensureDb(ctx);
    for (let ronda = 0; ronda < 4; ronda++) {
      const doA = await doConAnticipo(db);
      const doB = await doConAnticipo(db);
      const fa = await crearFacturaAlmacargaTest(db, doA, numFactura(), 100_000n);
      const fb = await crearFacturaAlmacargaTest(db, doB, numFactura(), 200_000n);
      const documentoId = await crearDocumentoTest(db, doA);
      const bloque = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fa, monto: 100_000n },
          { facturaProveedorId: fb, monto: 200_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      });
      const pagoB = await prisma.pagoTramite.findFirstOrThrow({
        where: { grupoPagoId: bloque.grupoPagoId, tramiteId: doB },
        select: { id: true },
      });

      const editar = actualizarPago(pagoB.id, { concepto: `Concepto editado ${ronda}` }, db.userId);
      const anular = anularPagoGrupo(bloque.grupoPagoId, "Anulación concurrente con una edición", db.userId);
      const resultados = await Promise.allSettled(ronda % 2 === 0 ? [editar, anular] : [anular, editar]);
      for (const r of resultados) {
        expect(mensaje(r), `ronda ${ronda}`).not.toMatch(/deadlock|40P01|P2034/i);
      }
      // La anulación siempre gana o entra después: el bloque termina anulado.
      const anulacion = resultados[ronda % 2 === 0 ? 1 : 0];
      expect(anulacion.status, `ronda ${ronda}: ${mensaje(anulacion)}`).toBe("fulfilled");
      expect(await partes(fa)).toMatchObject({ aplicado: 0n, estado: EstadoFacturaProveedor.REGISTRADA });
      expect(await partes(fb)).toMatchObject({ aplicado: 0n, estado: EstadoFacturaProveedor.REGISTRADA });
    }
  }, 90_000);
});

// ─── GET /api/pagos por proveedor: OPERATIVO sin totales (D-6 / R16) ────────

describe("listarPagosGlobal por proveedor — totales según el rol", () => {
  it("ADMIN y REVISOR reciben resumenProveedor; OPERATIVO no (sí el nombre y el conteo)", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), 50_000n);
    const filtro = { proveedorEmpresaId: db.almacargaClienteId };

    const admin = await listarPagosGlobal(filtro, { rol: "ADMIN" });
    const revisor = await listarPagosGlobal(filtro, { rol: "REVISOR" });
    const operativo = await listarPagosGlobal(filtro, { rol: "OPERATIVO" });

    expect(admin.resumenProveedor).toBeDefined();
    expect(revisor.resumenProveedor).toEqual(admin.resumenProveedor);
    expect(operativo.resumenProveedor).toBeUndefined();
    expect(operativo.proveedor?.facturasConSaldo).toBe(admin.proveedor?.facturasConSaldo);
  }, 30_000);
});
