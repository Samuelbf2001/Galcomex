/**
 * CxP v2 (P8, CA-39) — funciones SQL, triggers de llaves y guardianes de saldo
 * contra Postgres real. Requiere DATABASE_URL de una base de pruebas desechable
 * migrada con M1–M5; sin BD los tests se omiten.
 *
 * Cubre:
 *  - espejo SQL ↔ TS: `cxp_nit_base` = `nitBaseDe` (NIT SIN adivinar el DV),
 *    `cxp_dv_nit` = `dvNit`, `cxp_normalizar_num` = `normalizarNumeroFactura`;
 *  - triggers de llaves: `nitBase` de la ficha, número normalizado y clave de
 *    proveedor de la factura, índice único (proveedor, número), re-clave al
 *    cambiar el NIT, y que editar el concepto de un duplicado heredado (clave
 *    NULL) NO le devuelve la clave;
 *  - guardianes M5 encendidos: ninguna escritura directa (puente, ajuste, baja
 *    de valor, cruce) deja aplicado + ajustes + compensado > valor, tampoco dos
 *    transacciones simultáneas; CHECKs de montos.
 *
 * Las filas se escriben directo con Prisma (sin el dominio) a propósito: el
 * guardián existe justamente para lo que no pasa por `aplicarSaldo`.
 */
import "dotenv/config";

import { CanalPago, Ciudad, Rol, TipoAjusteFacturaProveedor, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { esErrorSobreaplicacion } from "@/lib/cxp/errores";
import { dvNit, nitBaseDe, normalizarNumeroFactura } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";

const PREFIJO = "vitest-cxp-triggers";
const runId = `${PREFIJO}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3021;

let disponible = false;
let motivoOmision = "BD local Postgres no disponible para las pruebas de triggers CxP";
let userId = "";
let clienteId = "";
let numeroDo = 0;
/** Fichas con NIT numérico (no llevan el prefijo): se borran por id. */
const beneficiariosCreados: string[] = [];

/** Base de NIT de 9 dígitos que no existe en la base (empieza por 97). */
function nitBaseAleatorio(): string {
  return `97${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
}

async function limpiar() {
  const tramites = await prisma.tramiteDO.findMany({
    where: { comentarios: { startsWith: PREFIJO } },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  const facturas = await prisma.facturaProveedor.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const facturaIds = facturas.map((f) => f.id);
  await prisma.ajusteFacturaProveedor.deleteMany({ where: { facturaId: { in: facturaIds } } });
  await prisma.pagoTramiteFactura.deleteMany({ where: { facturaId: { in: facturaIds } } });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { id: { in: facturaIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.beneficiario.deleteMany({
    where: { OR: [{ id: { in: beneficiariosCreados } }, { nombre: { startsWith: PREFIJO } }] },
  });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: PREFIJO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIJO } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivoOmision = "DATABASE_URL no está definida; se omiten las pruebas de triggers CxP";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    await limpiar();
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, name: "Vitest triggers CxP", rol: Rol.ADMIN, emailVerified: true },
    });
    userId = user.id;
    const cliente = await prisma.cliente.create({
      data: { nombre: "CLIENTE TRIGGERS CXP", nit: `${PREFIJO}-${runId}`, tipo: TipoCliente.PROPIO },
    });
    clienteId = cliente.id;
    disponible = true;
  } catch (error) {
    motivoOmision = `BD local Postgres no disponible: ${error instanceof Error ? error.message : String(error)}`;
  }
});

afterAll(async () => {
  if (disponible) await limpiar();
  await prisma.$disconnect();
});

function exigirBd(ctx: { skip: (nota?: string) => void }) {
  if (!disponible) {
    ctx.skip(motivoOmision);
    throw new Error("omitido");
  }
}

async function crearDo(): Promise<string> {
  numeroDo += 1;
  const t = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ21-${String(numeroDo).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BAQ,
      anio: ANIO,
      numero: 800_000 + Math.floor(Math.random() * 100_000) + numeroDo,
      clienteId,
      creadoPorId: userId,
      comentarios: `${PREFIJO}:${runId}`,
    },
  });
  return t.id;
}

async function crearFicha(nombre: string, nit: string | null) {
  const b = await prisma.beneficiario.create({ data: { nombre: `${PREFIJO} ${nombre}`, nit } });
  beneficiariosCreados.push(b.id);
  return b;
}

/** Factura escrita directo (sin dominio): los triggers llenan número normalizado y clave. */
async function crearFacturaDirecta(tramiteId: string, beneficiarioId: string | null, numFactura: string, valor: bigint) {
  return prisma.facturaProveedor.create({
    data: {
      tramiteId,
      proveedorNombre: "PROVEEDOR TRIGGERS",
      beneficiarioId,
      numFactura,
      valor,
      fecha: new Date(Date.UTC(ANIO, 1, 1)),
      subidaPorId: userId,
    },
  });
}

async function crearPagoDirecto(tramiteId: string, valor: bigint) {
  return prisma.pagoTramite.create({
    data: { tramiteId, concepto: `${PREFIJO} pago directo`, valor, canalPago: CanalPago.PSE },
  });
}

async function mensajeDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("se esperaba un error y la operación pasó");
}

// ─── 1. Espejo SQL ↔ TS ──────────────────────────────────────────────────────

describe("CA-39 — funciones SQL = espejos TS (llave del proveedor sin adivinar el DV)", () => {
  const NITS: (string | null)[] = [
    "800154017", // Almacarga sin DV → base completa (no se come el último dígito)
    "802011826", // Express sin DV
    "800.154.017-8", // con DV separado por guion → base
    "8001540178", // base + DV pegado: se toma completo (el aviso de parecido lo atrapa)
    "1045678923", // cédula de 10 dígitos: no pierde dígitos
    "800154017-8",
    "800154017 - 8",
    "NIT 890.912.462-2",
    "nit: 890912462",
    "  800154017  ",
    "0800154017",
    "890 912 462",
    "900-12",
    "US-123456",
    "ABC123",
    "",
    "   ",
    "0000",
    null,
  ];

  it("cxp_nit_base(nit) = nitBaseDe(nit) para NIT con y sin DV, cédulas y textos no colombianos", async (ctx) => {
    exigirBd(ctx);
    for (const nit of NITS) {
      const [fila] = await prisma.$queryRaw<{ base: string | null }[]>`SELECT cxp_nit_base(${nit}::text) AS base`;
      expect({ nit, base: fila.base }).toEqual({ nit, base: nitBaseDe(nit) });
    }
    // Los casos que el diseño fija literalmente.
    expect(nitBaseDe("800154017")).toBe("800154017");
    expect(nitBaseDe("802011826")).toBe("802011826");
    expect(nitBaseDe("800.154.017-8")).toBe("800154017");
    expect(nitBaseDe("8001540178")).toBe("8001540178");
    expect(nitBaseDe("1045678923")).toBe("1045678923");
  });

  it("cxp_dv_nit(base) = dvNit(base); 800154017 → 8, 802011826 → 3, 890912462 → 2", async (ctx) => {
    exigirBd(ctx);
    const bases = ["800154017", "802011826", "890912462", "1045678923", "8001540178", "9", "10", "123456789012345"];
    for (const base of bases) {
      const [fila] = await prisma.$queryRaw<{ dv: number | null }[]>`SELECT cxp_dv_nit(${base}::text) AS dv`;
      expect({ base, dv: fila.dv }).toEqual({ base, dv: dvNit(base) });
    }
    const [inv] = await prisma.$queryRaw<{ dv: number | null }[]>`SELECT cxp_dv_nit('80015401X') AS dv`;
    expect(inv.dv).toBeNull();
    expect(() => dvNit("80015401X")).toThrow(RangeError);
    expect([dvNit("800154017"), dvNit("802011826"), dvNit("890912462")]).toEqual([8, 3, 2]);
  });

  it("cxp_normalizar_num(n) = normalizarNumeroFactura(n) (SQL da NULL donde TS da cadena vacía)", async (ctx) => {
    exigirBd(ctx);
    const numeros = ["FE- 12481", "fe12481", "FE 012481", "FE-12481", "REG-50151039", "71388844", " fe_11.298 ", "Ñ-12", "---", ""];
    for (const n of numeros) {
      const [fila] = await prisma.$queryRaw<{ norm: string | null }[]>`SELECT cxp_normalizar_num(${n}::text) AS norm`;
      expect({ n, norm: fila.norm ?? "" }).toEqual({ n, norm: normalizarNumeroFactura(n) });
    }
  });
});

// ─── 2. Triggers de llaves ───────────────────────────────────────────────────

describe("CA-39 — triggers de llaves (ficha, factura, índice único, re-clave)", () => {
  it("la ficha guarda nitBase derivado del NIT (con DV → base; sin DV → completo; cédula de 10 dígitos intacta; letras → NULL)", async (ctx) => {
    exigirBd(ctx);
    const base = nitBaseAleatorio();
    const conDv = await crearFicha("con DV", `${base.slice(0, 3)}.${base.slice(3, 6)}.${base.slice(6)}-${dvNit(base)}`);
    const sinDv = await crearFicha("sin DV", base);
    const cedula = await crearFicha("cedula", "1045678923");
    const exterior = await crearFicha("exterior", "US-99-123");
    const sinNit = await crearFicha("sin NIT", null);

    const leidas = await prisma.beneficiario.findMany({
      where: { id: { in: [conDv.id, sinDv.id, cedula.id, exterior.id, sinNit.id] } },
      select: { id: true, nitBase: true },
    });
    const porId = new Map(leidas.map((b) => [b.id, b.nitBase]));
    expect(porId.get(conDv.id)).toBe(base);
    expect(porId.get(sinDv.id)).toBe(base);
    expect(porId.get(cedula.id)).toBe("1045678923");
    expect(porId.get(exterior.id)).toBeNull();
    expect(porId.get(sinNit.id)).toBeNull();

    // Cambiar el NIT recalcula nitBase (UPDATE OF nit).
    await prisma.beneficiario.update({ where: { id: sinDv.id }, data: { nit: `${base}${dvNit(base)}` } });
    const cambiado = await prisma.beneficiario.findUniqueOrThrow({ where: { id: sinDv.id } });
    expect(cambiado.nitBase).toBe(`${base}${dvNit(base)}`);
  });

  it("la factura recibe número normalizado y clave de proveedor; mismo proveedor + mismo número (con otro formato, otra ficha del mismo NIT, otro DO) choca con el índice único", async (ctx) => {
    exigirBd(ctx);
    const base = nitBaseAleatorio();
    const ficha = await crearFicha("ALMACARGA A", base);
    const fichaHermana = await crearFicha("ALMACARGA B", `${base}-${dvNit(base)}`);
    const sinNit = await crearFicha("SIN NIT", null);
    const doA = await crearDo();
    const doB = await crearDo();

    const f1 = await crearFacturaDirecta(doA, ficha.id, "FE-12481", 464_077n);
    expect(f1.numFacturaNormalizado).toBe("FE12481");
    expect(f1.proveedorClave).toBe(`NIT:${base}`);

    // Otro proveedor (ficha sin NIT → clave BEN:<id>) con el mismo número, en otro DO: entra.
    const f2 = await crearFacturaDirecta(doB, sinNit.id, "FE-12481", 1_000n);
    expect(f2.proveedorClave).toBe(`BEN:${sinNit.id}`);

    const sinFicha = await crearFacturaDirecta(doA, null, "SIN-FICHA-1", 1_000n);
    expect(sinFicha.proveedorClave).toBeNull();
    expect(sinFicha.numFacturaNormalizado).toBe("SINFICHA1");

    await expect(crearFacturaDirecta(doB, fichaHermana.id, "fe 12481", 464_077n)).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(crearFacturaDirecta(doB, ficha.id, "FE12481", 464_077n)).rejects.toMatchObject({ code: "P2002" });
    // Otro número del mismo proveedor sí entra.
    const f3 = await crearFacturaDirecta(doB, fichaHermana.id, "FE 12482", 10_000n);
    expect(f3.proveedorClave).toBe(`NIT:${base}`);
  });

  it("editar el concepto de un duplicado heredado (clave NULL) no le devuelve la clave, aunque el PATCH mande número y ficha iguales; cambiar el número sí la recalcula", async (ctx) => {
    exigirBd(ctx);
    const base = nitBaseAleatorio();
    const ficha = await crearFicha("PROVEEDOR HEREDADO", base);
    const doA = await crearDo();
    const doB = await crearDo();
    const original = await crearFacturaDirecta(doA, ficha.id, "FE-5001", 100_000n);

    // Duplicado heredado como lo deja M3: mismo proveedor y número, clave NULL.
    // Se inserta con el trigger de llaves apagado DENTRO de una transacción (el
    // DDL de Postgres es transaccional: ninguna otra sesión lo ve apagado).
    const duplicadoId = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "factura_proveedor" DISABLE TRIGGER trg_factura_proveedor_claves`;
      const dup = await tx.facturaProveedor.create({
        data: {
          tramiteId: doB,
          proveedorNombre: "PROVEEDOR HEREDADO",
          beneficiarioId: ficha.id,
          numFactura: "FE 5001",
          numFacturaNormalizado: "FE5001",
          proveedorClave: null,
          valor: 100_000n,
          fecha: new Date(Date.UTC(ANIO, 1, 2)),
          subidaPorId: userId,
        },
      });
      await tx.$executeRaw`ALTER TABLE "factura_proveedor" ENABLE TRIGGER trg_factura_proveedor_claves`;
      return dup.id;
    });

    // Lo que manda la pantalla al editar el concepto: todos los campos, iguales.
    const editado = await prisma.facturaProveedor.update({
      where: { id: duplicadoId },
      data: { concepto: "ALMACENAJE corregido", numFactura: "FE 5001", beneficiarioId: ficha.id },
    });
    expect(editado.proveedorClave).toBeNull();
    expect(editado.concepto).toBe("ALMACENAJE corregido");

    // Si cambia el número a uno que choca con la original, el índice lo frena.
    await expect(
      prisma.facturaProveedor.update({ where: { id: duplicadoId }, data: { numFactura: "fe-5001" } }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Con un número distinto recupera la clave.
    const renumerado = await prisma.facturaProveedor.update({
      where: { id: duplicadoId },
      data: { numFactura: "FE 5002" },
    });
    expect(renumerado.proveedorClave).toBe(`NIT:${base}`);
    expect(renumerado.numFacturaNormalizado).toBe("FE5002");

    // El trigger quedó encendido para todos.
    const [trg] = await prisma.$queryRaw<{ tgenabled: string }[]>`
      SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname = 'trg_factura_proveedor_claves'`;
    expect(trg.tgenabled).toBe("O");
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: original.id } })).proveedorClave).toBe(
      `NIT:${base}`,
    );
  });

  it("cambiar el NIT de la ficha re-clava sus facturas (salvo el duplicado heredado, que sigue en NULL)", async (ctx) => {
    exigirBd(ctx);
    const base = nitBaseAleatorio();
    const nuevaBase = nitBaseAleatorio();
    const ficha = await crearFicha("RECLAVE", base);
    const doA = await crearDo();
    const f = await crearFacturaDirecta(doA, ficha.id, "RC-1", 50_000n);
    const heredada = await crearFacturaDirecta(doA, ficha.id, "RC-2", 50_000n);
    await prisma.$executeRaw`UPDATE "factura_proveedor" SET "proveedorClave" = NULL WHERE id = ${heredada.id}`;

    await prisma.beneficiario.update({ where: { id: ficha.id }, data: { nit: `${nuevaBase}-${dvNit(nuevaBase)}` } });

    const [fDespues, hDespues] = await Promise.all([
      prisma.facturaProveedor.findUniqueOrThrow({ where: { id: f.id } }),
      prisma.facturaProveedor.findUniqueOrThrow({ where: { id: heredada.id } }),
    ]);
    expect(fDespues.proveedorClave).toBe(`NIT:${nuevaBase}`);
    expect(hDespues.proveedorClave).toBeNull();
  });
});

// ─── 3. Guardianes de saldo (M5) ─────────────────────────────────────────────

describe("CA-39 — guardianes de saldo encendidos (M5) y CHECKs", () => {
  it("los tres guardianes existen y están ENCENDIDOS", async (ctx) => {
    exigirBd(ctx);
    const filas = await prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger
      WHERE tgname IN ('trg_pago_factura_saldo', 'trg_ajuste_saldo', 'trg_factura_valor_saldo',
                       'trg_factura_proveedor_claves', 'trg_beneficiario_nit_base', 'trg_beneficiario_reclave')
      ORDER BY tgname`;
    expect(filas).toEqual([
      { tgname: "trg_ajuste_saldo", tgenabled: "O" },
      { tgname: "trg_beneficiario_nit_base", tgenabled: "O" },
      { tgname: "trg_beneficiario_reclave", tgenabled: "O" },
      { tgname: "trg_factura_proveedor_claves", tgenabled: "O" },
      { tgname: "trg_factura_valor_saldo", tgenabled: "O" },
      { tgname: "trg_pago_factura_saldo", tgenabled: "O" },
    ]);
  });

  it("puente: hasta el valor exacto entra; un peso más se rechaza (CXP_SOBREAPLICACION) y no queda nada escrito", async (ctx) => {
    exigirBd(ctx);
    const ficha = await crearFicha("GUARDIAN PUENTE", nitBaseAleatorio());
    const doA = await crearDo();
    const f = await crearFacturaDirecta(doA, ficha.id, "GP-1", 461_377n);
    const p1 = await crearPagoDirecto(doA, 200_000n);
    const p2 = await crearPagoDirecto(doA, 261_377n);
    const p3 = await crearPagoDirecto(doA, 1n);

    await prisma.pagoTramiteFactura.create({ data: { pagoId: p1.id, facturaId: f.id, monto: 200_000n } });
    await prisma.pagoTramiteFactura.create({ data: { pagoId: p2.id, facturaId: f.id, monto: 261_377n } });
    const msg = await mensajeDe(prisma.pagoTramiteFactura.create({ data: { pagoId: p3.id, facturaId: f.id, monto: 1n } }));
    expect(msg).toMatch(/CXP_SOBREAPLICACION/);
    expect(esErrorSobreaplicacion(new Error(msg))).toBe(true);

    // Subir el monto de un enlace existente también pasa por el guardián.
    const msgUpd = await mensajeDe(
      prisma.pagoTramiteFactura.update({
        where: { pagoId_facturaId: { pagoId: p1.id, facturaId: f.id } },
        data: { monto: 200_001n },
      }),
    );
    expect(msgUpd).toMatch(/CXP_SOBREAPLICACION/);

    const suma = await prisma.pagoTramiteFactura.aggregate({ where: { facturaId: f.id }, _sum: { monto: true } });
    expect(suma._sum.monto).toBe(461_377n);
  });

  it("ajuste, baja de valor y cruce: ninguno deja aplicado + ajustes + compensado por encima del valor", async (ctx) => {
    exigirBd(ctx);
    const ficha = await crearFicha("GUARDIAN MIXTO", nitBaseAleatorio());
    const doA = await crearDo();
    const f = await crearFacturaDirecta(doA, ficha.id, "GM-1", 300_000n);
    const pago = await crearPagoDirecto(doA, 100_000n);
    await prisma.pagoTramiteFactura.create({ data: { pagoId: pago.id, facturaId: f.id, monto: 100_000n } });

    // Ajuste: 150.000 entra (100.000 + 150.000 = 250.000 ≤ 300.000); otro de 50.001 no.
    await prisma.ajusteFacturaProveedor.create({
      data: { facturaId: f.id, tipo: TipoAjusteFacturaProveedor.LEGADO, monto: 150_000n, motivo: "prueba guardián" },
    });
    expect(
      await mensajeDe(
        prisma.ajusteFacturaProveedor.create({
          data: { facturaId: f.id, tipo: TipoAjusteFacturaProveedor.LEGADO, monto: 50_001n, motivo: "prueba guardián" },
        }),
      ),
    ).toMatch(/CXP_SOBREAPLICACION/);

    // Cruce: 50.000 cuadra exacto; 50.001 no.
    expect(
      await mensajeDe(prisma.facturaProveedor.update({ where: { id: f.id }, data: { montoCompensado: 50_001n } })),
    ).toMatch(/CXP_SOBREAPLICACION/);
    await prisma.facturaProveedor.update({ where: { id: f.id }, data: { montoCompensado: 50_000n } });

    // Bajar el valor por debajo de lo ya aplicado (nota crédito mal digitada).
    expect(await mensajeDe(prisma.facturaProveedor.update({ where: { id: f.id }, data: { valor: 299_999n } }))).toMatch(
      /CXP_SOBREAPLICACION/,
    );
    // Subirlo sí se puede (la re-expresión USD sube o baja respetando lo aplicado).
    await prisma.facturaProveedor.update({ where: { id: f.id }, data: { valor: 300_001n } });

    const final = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: f.id } });
    expect(final.valor).toBe(300_001n);
    expect(final.montoCompensado).toBe(50_000n);
  });

  it("CHECKs: monto del puente ≥ 0, ajuste > 0 y compensado ≥ 0", async (ctx) => {
    exigirBd(ctx);
    const ficha = await crearFicha("GUARDIAN CHECK", nitBaseAleatorio());
    const doA = await crearDo();
    const f = await crearFacturaDirecta(doA, ficha.id, "GC-1", 10_000n);
    const pago = await crearPagoDirecto(doA, 10_000n);

    expect(
      await mensajeDe(prisma.pagoTramiteFactura.create({ data: { pagoId: pago.id, facturaId: f.id, monto: -1n } })),
    ).toMatch(/pago_tramite_factura_monto_ck|check constraint/i);
    expect(
      await mensajeDe(
        prisma.ajusteFacturaProveedor.create({
          data: { facturaId: f.id, tipo: TipoAjusteFacturaProveedor.LEGADO, monto: 0n, motivo: "prueba check" },
        }),
      ),
    ).toMatch(/ajuste_factura_proveedor_monto_ck|check constraint/i);
    expect(
      await mensajeDe(prisma.facturaProveedor.update({ where: { id: f.id }, data: { montoCompensado: -1n } })),
    ).toMatch(/factura_proveedor_montoCompensado_ck|check constraint/i);
  });

  it("dos transacciones simultáneas que escriben el puente directo (cada una cabe sola, juntas no): el guardián deja entrar solo una", async (ctx) => {
    exigirBd(ctx);
    const ficha = await crearFicha("GUARDIAN CONCURRENTE", nitBaseAleatorio());
    const doA = await crearDo();
    const f = await crearFacturaDirecta(doA, ficha.id, "GCC-1", 464_077n);
    const pA = await crearPagoDirecto(doA, 300_000n);
    const pB = await crearPagoDirecto(doA, 300_000n);

    let liberarA: () => void = () => undefined;
    const aEscribio = new Promise<void>((resolve) => {
      liberarA = resolve;
    });
    const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // A escribe y retiene el bloqueo de la factura (FOR UPDATE del guardián)
    // hasta que B ya esté esperando; luego confirma.
    const txA = prisma.$transaction(
      async (tx) => {
        await tx.pagoTramiteFactura.create({ data: { pagoId: pA.id, facturaId: f.id, monto: 300_000n } });
        liberarA();
        await esperar(400);
      },
      { timeout: 10_000 },
    );
    const txB = (async () => {
      await aEscribio;
      return prisma.$transaction(
        async (tx) => {
          await tx.pagoTramiteFactura.create({ data: { pagoId: pB.id, facturaId: f.id, monto: 300_000n } });
        },
        { timeout: 10_000 },
      );
    })();

    const [ra, rb] = await Promise.allSettled([txA, txB]);
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("rejected");
    if (rb.status === "rejected") expect(esErrorSobreaplicacion(rb.reason)).toBe(true);

    const puentes = await prisma.pagoTramiteFactura.findMany({ where: { facturaId: f.id } });
    expect(puentes.map((p) => [p.pagoId, p.monto])).toEqual([[pA.id, 300_000n]]);
  });
});
