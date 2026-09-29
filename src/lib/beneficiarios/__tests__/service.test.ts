/**
 * Fichas de pago (beneficiarios) — CxP v2 (P2): NIT + DV, llave de proveedor
 * sin adivinar el DV, fichas repetidas o parecidas (CA-19, CA-41).
 *
 * La parte pura (`resolverNitFicha`) usa los NIT reales verificados en el
 * diseño (Almacarga 800154017-8, Express 802011826-3, Tampa 890912462-2). La
 * parte de BD usa NIT ficticios por corrida (base aleatoria de 9 dígitos) para
 * no chocar con otras pruebas; requiere DATABASE_URL de una base desechable.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import {
  actualizarBeneficiario,
  asegurarBeneficiarioDeEmpresa,
  BeneficiarioDatosInvalidosError,
  crearBeneficiario,
  listarBeneficiarios,
  resolverNitFicha,
} from "@/lib/beneficiarios/service";
import {
  BeneficiarioExisteError,
  FacturaDuplicadaError,
  NitDvInvalidoError,
  NitNoCoincideEmpresaError,
  PosibleBeneficiarioDuplicadoError,
} from "@/lib/cxp/errores";
import { dvNit } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { pesos } from "@/lib/dinero";

// ─── Puro ─────────────────────────────────────────────────────────────────────

describe("resolverNitFicha — NIT y DV en campos separados, sin adivinar el DV", () => {
  it("Almacarga: 800154017 + DV 8 → se guarda '800154017-8', llave 800154017", () => {
    expect(resolverNitFicha("800154017", 8)).toEqual({ nit: "800154017-8", nitBase: "800154017" });
    expect(resolverNitFicha("802011826", 3)).toEqual({ nit: "802011826-3", nitBase: "802011826" });
    expect(resolverNitFicha("890912462", 2)).toEqual({ nit: "890912462-2", nitBase: "890912462" });
  });

  it("DV que no cuadra → NIT_DV_INVALIDO con el DV correcto", () => {
    expect(() => resolverNitFicha("800154017", 5)).toThrow(NitDvInvalidoError);
    expect(() => resolverNitFicha("800154017", 5)).toThrow(
      "El dígito de verificación 5 no corresponde al NIT 800154017 (debería ser 8).",
    );
  });

  it("DV pegado con guion (MCP, datos viejos): se valida igual", () => {
    expect(resolverNitFicha("800.154.017-8", undefined)).toEqual({ nit: "800154017-8", nitBase: "800154017" });
    expect(resolverNitFicha("NIT 800154017 - 8", null)).toEqual({ nit: "800154017-8", nitBase: "800154017" });
    expect(() => resolverNitFicha("800154017-5", null)).toThrow(NitDvInvalidoError);
    expect(() => resolverNitFicha("800154017-8", 5)).toThrow(NitDvInvalidoError);
  });

  it("sin DV el número se toma COMPLETO (no se adivina): 800154017 → 800154017; 10 dígitos intactos", () => {
    expect(resolverNitFicha("800154017", null)).toEqual({ nit: "800154017", nitBase: "800154017" });
    expect(resolverNitFicha("800.154.017", undefined)).toEqual({ nit: "800154017", nitBase: "800154017" });
    expect(resolverNitFicha("8001540178", null)).toEqual({ nit: "8001540178", nitBase: "8001540178" });
    // Cédula de 10 dígitos: no pierde ninguno.
    expect(resolverNitFicha("1045678901", null)).toEqual({ nit: "1045678901", nitBase: "1045678901" });
  });

  it("NIT con letras (exterior): tal cual, sin llave NIT y sin DV", () => {
    expect(resolverNitFicha("US-EIN 12-3456789", null)).toEqual({ nit: "US-EIN 12-3456789", nitBase: null });
    expect(() => resolverNitFicha("US-EIN 12-3456789", 4)).toThrow(BeneficiarioDatosInvalidosError);
  });

  it("vacío → sin NIT; DV sin NIT → error", () => {
    expect(resolverNitFicha("  ", null)).toEqual({ nit: null, nitBase: null });
    expect(resolverNitFicha(null, undefined)).toEqual({ nit: null, nitBase: null });
    expect(() => resolverNitFicha("", 3)).toThrow(BeneficiarioDatosInvalidosError);
  });
});

// ─── BD ───────────────────────────────────────────────────────────────────────

const NOMBRE = `${TEST_PREFIX} BEN P2`;

/** Base de 9 dígitos por corrida (7xx.xxx.xxx: fuera del rango de los NIT de prueba reales). */
function baseAleatoria(): string {
  return String(700_000_000 + Math.floor(Math.random() * 99_999_999));
}

describe("crearBeneficiario / actualizarBeneficiario — CA-19, CA-41", () => {
  const empresas: string[] = [];

  beforeAll(prepararBdAlmacarga);

  afterAll(async () => {
    if (process.env.DATABASE_URL) {
      await prisma.facturaProveedor
        .deleteMany({ where: { beneficiario: { nombre: { startsWith: NOMBRE } } } })
        .catch(() => undefined);
      const fichas = await prisma.beneficiario.findMany({
        where: { nombre: { startsWith: NOMBRE } },
        select: { id: true },
      });
      await prisma.auditLog
        .deleteMany({ where: { entidad: "Beneficiario", entidadId: { in: fichas.map((f) => f.id) } } })
        .catch(() => undefined);
      await prisma.beneficiario.deleteMany({ where: { nombre: { startsWith: NOMBRE } } }).catch(() => undefined);
      await prisma.cliente.deleteMany({ where: { id: { in: empresas } } }).catch(() => undefined);
    }
    await liberarBdAlmacarga();
  });

  it("CA-19: el mismo NIT base (con o sin DV) → BENEFICIARIO_EXISTE con la ficha existente", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const original = await crearBeneficiario({ nombre: `${NOMBRE} ALMACARGA`, nit: base, dv }, db.userId);
    expect(original.nit).toBe(`${base}-${dv}`);
    expect(original.nitBase).toBe(base);

    const sinDv = await crearBeneficiario({ nombre: `${NOMBRE} ALMACARGA 2`, nit: base }, db.userId).catch(
      (e: unknown) => e,
    );
    expect(sinDv).toBeInstanceOf(BeneficiarioExisteError);
    expect((sinDv as Error).message).toBe(`Ya existe: ${NOMBRE} ALMACARGA (NIT ${base}-${dv}). Usa esa ficha.`);
    expect((sinDv as BeneficiarioExisteError).existente.id).toBe(original.id);

    await expect(
      crearBeneficiario({ nombre: `${NOMBRE} ALMACARGA 3`, nit: `${base}-${dv}` }, db.userId),
    ).rejects.toBeInstanceOf(BeneficiarioExisteError);

    // ADMIN: "Es otra cuenta del mismo proveedor".
    const otraCuenta = await crearBeneficiario(
      { nombre: `${NOMBRE} ALMACARGA CTA 2`, nit: base, dv, numCuenta: "123" },
      db.userId,
      { permitirMismoNit: true },
    );
    expect(otraCuenta.nitBase).toBe(base);
  });

  it("CA-41: base + DV pegado (10 dígitos) o base sin el último dígito → POSIBLE_BENEFICIARIO_DUPLICADO; confirmado, se crea", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const original = await crearBeneficiario({ nombre: `${NOMBRE} EXPRESS`, nit: base, dv }, db.userId);

    const pegado = await crearBeneficiario({ nombre: `${NOMBRE} EXPRESS PEGADO`, nit: `${base}${dv}` }, db.userId).catch(
      (e: unknown) => e,
    );
    expect(pegado).toBeInstanceOf(PosibleBeneficiarioDuplicadoError);
    expect((pegado as Error).message).toBe(
      `¿Es la misma empresa? Ya existe ${NOMBRE} EXPRESS con NIT ${base}-${dv}.`,
    );
    expect((pegado as PosibleBeneficiarioDuplicadoError).existentes.map((e) => e.id)).toEqual([original.id]);

    // Al revés: ya existe una ficha con el DV pegado (10 dígitos) y se escribe el NIT sin DV.
    const base2 = baseAleatoria();
    const dv2 = dvNit(base2);
    const pegadaVieja = await prisma.beneficiario.create({ data: { nombre: `${NOMBRE} PEGADA VIEJA`, nit: `${base2}${dv2}` } });
    const alReves = await crearBeneficiario({ nombre: `${NOMBRE} SIN DV`, nit: base2 }, db.userId).catch((e: unknown) => e);
    expect(alReves).toBeInstanceOf(PosibleBeneficiarioDuplicadoError);
    expect((alReves as PosibleBeneficiarioDuplicadoError).existentes.map((e) => e.id)).toEqual([pegadaVieja.id]);

    const confirmada = await crearBeneficiario(
      { nombre: `${NOMBRE} EXPRESS PEGADO`, nit: `${base}${dv}`, confirmarOtraFicha: true },
      db.userId,
    );
    // El número se toma completo: 10 dígitos, no se le quita el "DV".
    expect(confirmada.nitBase).toBe(`${base}${dv}`);
  });

  it("CA-41: DV mal digitado → NIT_DV_INVALIDO y no se crea nada", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const malo = (dvNit(base) + 1) % 10;
    await expect(
      crearBeneficiario({ nombre: `${NOMBRE} DV MALO`, nit: base, dv: malo }, db.userId),
    ).rejects.toBeInstanceOf(NitDvInvalidoError);
    expect(await prisma.beneficiario.count({ where: { nitBase: base } })).toBe(0);
  });

  it("NIT_NO_COINCIDE_EMPRESA: la ficha de una empresa debe tener su NIT", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const empresa = await prisma.cliente.create({
      data: { nombre: `${NOMBRE} EMPRESA`, nit: `${base}-${dv}`, esCliente: false, esProveedor: true },
    });
    empresas.push(empresa.id);

    const otro = String(Number(base) + 1);
    await expect(
      crearBeneficiario({ nombre: `${NOMBRE} FICHA EMP`, nit: otro, empresaId: empresa.id }, db.userId),
    ).rejects.toThrow(
      new NitNoCoincideEmpresaError(otro, `${NOMBRE} EMPRESA`, `${base}-${dv}`).message,
    );
    const ok = await crearBeneficiario(
      { nombre: `${NOMBRE} FICHA EMP`, nit: base, dv, empresaId: empresa.id },
      db.userId,
    );
    expect(ok.empresaId).toBe(empresa.id);
  });

  it("nombre corto y 'Numerar como FE 11298' se guardan; la búsqueda encuentra por NIT con puntos", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const ficha = await crearBeneficiario(
      { nombre: `${NOMBRE} CORTO`, nit: base, nombreCorto: "almacarga", numFacturaConEspacio: true },
      db.userId,
    );
    expect(ficha.nombreCorto).toBe("ALMACARGA");
    expect(ficha.numFacturaConEspacio).toBe(true);

    const conPuntos = `${base.slice(0, 3)}.${base.slice(3, 6)}.${base.slice(6)}`;
    const encontradas = await listarBeneficiarios(conPuntos);
    expect(encontradas.map((b) => b.id)).toContain(ficha.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entidad: "Beneficiario", entidadId: ficha.id, accion: "CREATE_BENEFICIARIO" },
    });
    expect(audit.despues).toMatchObject({ nombreCorto: "ALMACARGA", numFacturaConEspacio: true });
  });

  it("editar: reenviar el mismo NIT (aunque su DV guardado esté mal) no bloquea cambiar el banco", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const malo = (dvNit(base) + 1) % 10;
    // Ficha vieja con DV mal digitado (escrita antes de CxP v2).
    const vieja = await prisma.beneficiario.create({ data: { nombre: `${NOMBRE} VIEJA`, nit: `${base}-${malo}` } });

    const a = await actualizarBeneficiario(vieja.id, { nit: base, dv: malo, banco: "BANCOLOMBIA" }, db.userId);
    expect(a.banco).toBe("BANCOLOMBIA");
    expect(a.nit).toBe(`${base}-${malo}`);
    const b = await actualizarBeneficiario(vieja.id, { nit: `${base}-${malo}`, numCuenta: "999" }, db.userId);
    expect(b.numCuenta).toBe("999");

    // Pero corregir el NIT sí valida el DV.
    const otroMalo = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => d !== malo && d !== dvNit(base))!;
    await expect(actualizarBeneficiario(vieja.id, { nit: base, dv: otroMalo }, db.userId)).rejects.toBeInstanceOf(
      NitDvInvalidoError,
    );
    const corregida = await actualizarBeneficiario(vieja.id, { nit: base, dv: dvNit(base) }, db.userId);
    expect(corregida.nit).toBe(`${base}-${dvNit(base)}`);
  });

  it("editar el NIT a uno que ya tiene otra ficha: BENEFICIARIO_EXISTE; forzado por ADMIN y con una factura repetida → FACTURA_DUPLICADA", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const a = await crearBeneficiario({ nombre: `${NOMBRE} RECLAVE A`, nit: base, dv }, db.userId);
    const b = await crearBeneficiario({ nombre: `${NOMBRE} RECLAVE B`, nit: `${TEST_PREFIX}-sin-nit-${runId}` }, db.userId);

    const tramite1 = await crearTramiteTest(db);
    const tramite2 = await crearTramiteTest(db);
    await crearFacturaAlmacargaTest(db, tramite1, `${runId}-RC-1`, pesos(10_000), a.id);
    await crearFacturaAlmacargaTest(db, tramite2, `${runId}-rc 1`, pesos(10_000), b.id); // otra llave (BEN:b)

    await expect(actualizarBeneficiario(b.id, { nit: base, dv }, db.userId)).rejects.toBeInstanceOf(
      BeneficiarioExisteError,
    );
    await expect(
      actualizarBeneficiario(b.id, { nit: base, dv }, db.userId, { permitirMismoNit: true }),
    ).rejects.toBeInstanceOf(FacturaDuplicadaError);

    // Nada cambió.
    const bDespues = await prisma.beneficiario.findUniqueOrThrow({ where: { id: b.id } });
    expect(bDespues.nitBase).toBeNull();
  });

  it("asegurarBeneficiarioDeEmpresa enlaza la ficha suelta con el mismo NIT base (con o sin DV)", async (ctx) => {
    ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const suelta = await prisma.beneficiario.create({ data: { nombre: `${NOMBRE} SUELTA`, nit: base } });
    const empresa = await prisma.cliente.create({
      data: { nombre: `${NOMBRE} EMP SUELTA`, nit: `${base}-${dv}`, esCliente: false, esProveedor: true },
    });
    empresas.push(empresa.id);

    const ficha = await prisma.$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, empresa));
    expect(ficha.id).toBe(suelta.id);
    expect(ficha.empresaId).toBe(empresa.id);
  });
});
