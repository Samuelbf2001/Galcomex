/**
 * Fase 3 del plan «Empresa + Datos de pago» (PLAN-EMPRESA-DATOS-DE-PAGO.md):
 * toda ficha de pago pertenece a una empresa (salvo la del socio), no se crean
 * proveedores repetidos por un NIT escrito distinto y una empresa con pagos
 * no se borra.
 *
 * NIT ficticios por corrida (base aleatoria 6xx.xxx.xxx); requiere
 * DATABASE_URL de una base desechable con las migraciones aplicadas.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import {
  EmpresaConPagosError,
  EmpresaMismoNitError,
  EmpresasRepetidasPorNitError,
  FichaSinEmpresaError,
  FichaSinNitError,
  FichaSocioConEmpresaError,
  NitDelSocioError,
  NitDeOtraEmpresaError,
  PosibleEmpresaDuplicadaError,
} from "@/lib/beneficiarios/errores";
import {
  actualizarBeneficiario,
  asegurarBeneficiarioDeEmpresa,
  crearBeneficiario,
  eliminarFichasSinUsoDeEmpresa,
  listarBeneficiarios,
} from "@/lib/beneficiarios/service";
import { fichasDeEmpresa, fichasHermanas } from "@/lib/cxp/estado-cuenta";
import { BeneficiarioExisteError, PosibleBeneficiarioDuplicadoError } from "@/lib/cxp/errores";
import { dvNit } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { buscarEmpresaPorNit, esNitProvisional, esNitUtil, verificarNitEmpresaLibre } from "@/lib/empresas/nit";

const P = "vitest-fase3";

function baseAleatoria(): string {
  return String(600_000_000 + Math.floor(Math.random() * 99_999_999));
}

async function empresaDirecta(nombre: string, nit: string, esCliente = false) {
  return prisma.cliente.create({
    data: { nombre: `${P} ${nombre}`, nit, esCliente, esProveedor: !esCliente, manejaAnticipo: false },
  });
}

describe("esNitProvisional", () => {
  it("reconoce los marcadores que se ponen mientras llega el NIT real", () => {
    expect(esNitProvisional("PENDIENTE-NIT-ASCINTER")).toBe(true);
    expect(esNitProvisional("SIN-NIT-CEVA")).toBe(true);
    expect(esNitProvisional("sin nit")).toBe(true);
    expect(esNitProvisional("PROVISIONAL 1")).toBe(true);
    expect(esNitProvisional("800154017-8")).toBe(false);
    expect(esNitProvisional("US-EIN 12-3456789")).toBe(false);
    expect(esNitProvisional("PRUEBA-003")).toBe(false);
    expect(esNitProvisional(null)).toBe(false);
    expect(esNitProvisional("N/A")).toBe(true);
    expect(esNitProvisional("XIAMEN-12345")).toBe(false);
  });

  it("esNitUtil: al menos un dígito distinto de cero y 5 letras o números", () => {
    expect(esNitUtil("800154017-8")).toBe(true);
    expect(esNitUtil("72282542")).toBe(true);
    expect(esNitUtil("US-EIN 12-3456789")).toBe(true);
    expect(esNitUtil("PRUEBA-INLINE-001")).toBe(true);
    for (const basura of ["N/A", "NA", "0", ".", "00000", "1234", "SIN-NIT-X", ""]) {
      expect(esNitUtil(basura)).toBe(false);
    }
  });
});

describe("fase 3 — toda ficha de pago con empresa", () => {
  beforeAll(prepararBdAlmacarga);

  afterAll(async () => {
    if (process.env.DATABASE_URL) {
      const fichas = await prisma.beneficiario.findMany({
        where: { OR: [{ nombre: { startsWith: P } }, { empresa: { nombre: { startsWith: P } } }] },
        select: { id: true },
      });
      const ids = fichas.map((f) => f.id);
      await prisma.facturaProveedor.deleteMany({ where: { beneficiarioId: { in: ids } } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { entidadId: { in: ids } } }).catch(() => undefined);
      await prisma.beneficiario.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
      const empresas = await prisma.cliente.findMany({ where: { nombre: { startsWith: P } }, select: { id: true } });
      await prisma.auditLog
        .deleteMany({ where: { entidadId: { in: empresas.map((e) => e.id) } } })
        .catch(() => undefined);
      await prisma.cliente.deleteMany({ where: { nombre: { startsWith: P } } }).catch(() => undefined);
    }
    await liberarBdAlmacarga();
  });

  // ── Alta ──────────────────────────────────────────────────────────────────

  it("alta sin empresa y NIT nuevo → crea la empresa solo-proveedora y la enlaza", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const ficha = await crearBeneficiario({ nombre: `${P} TRANSPORTES NUEVOS`, nit: base, dv }, db.userId);

    expect(ficha.empresaCreada).toBe(true);
    expect(ficha.empresaId).not.toBeNull();
    const empresa = await prisma.cliente.findUniqueOrThrow({ where: { id: ficha.empresaId! } });
    expect(empresa).toMatchObject({
      nombre: `${P} TRANSPORTES NUEVOS`,
      nit: `${base}-${dv}`,
      esCliente: false,
      esProveedor: true,
      manejaAnticipo: false,
    });
    const auditoria = await prisma.auditLog.count({
      where: { entidadId: empresa.id, accion: "CREATE_EMPRESA_PROVEEDORA_DESDE_FICHA" },
    });
    expect(auditoria).toBe(1);

    const lista = await listarBeneficiarios(undefined, empresa.id);
    expect(lista.map((b) => b.empresa?.nombre)).toEqual([`${P} TRANSPORTES NUEVOS`]);
  });

  it("alta sin empresa y sin NIT (o con NIT provisional) → FICHA_SIN_NIT y no se crea nada", async (ctx) => {
    const db = ensureDb(ctx);
    const antes = await prisma.beneficiario.count();
    await expect(crearBeneficiario({ nombre: `${P} SIN NIT` }, db.userId)).rejects.toBeInstanceOf(FichaSinNitError);
    await expect(
      crearBeneficiario({ nombre: `${P} PROVISIONAL`, nit: "PENDIENTE-NIT-X" }, db.userId),
    ).rejects.toBeInstanceOf(FichaSinNitError);
    expect(await prisma.beneficiario.count()).toBe(antes);
    expect(await prisma.cliente.count({ where: { nombre: { in: [`${P} SIN NIT`, `${P} PROVISIONAL`] } } })).toBe(0);
  });

  it("alta sin empresa con el NIT de una empresa CLIENTE existente → se enlaza a ella y la marca proveedora", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const cliente = await empresaDirecta("CLIENTE QUE TAMBIEN COBRA", `${base}-${dv}`, true);

    const ficha = await crearBeneficiario({ nombre: `${P} FICHA DEL CLIENTE`, nit: base }, db.userId);
    expect(ficha.empresaCreada).toBe(false);
    expect(ficha.empresaId).toBe(cliente.id);
    const despues = await prisma.cliente.findUniqueOrThrow({ where: { id: cliente.id } });
    expect(despues.esProveedor).toBe(true);
    expect(despues.esCliente).toBe(true);
  });

  it("alta con NIT sin sentido («N/A», «0») → FICHA_SIN_NIT: no junta proveedores distintos en una empresa «N/A»", async (ctx) => {
    const db = ensureDb(ctx);
    for (const basura of ["N/A", "NA", "0", ".", "00000"]) {
      await expect(crearBeneficiario({ nombre: `${P} BASURA ${basura}`, nit: basura }, db.userId)).rejects.toBeInstanceOf(
        FichaSinNitError,
      );
    }
  });

  it("una empresa = una ficha: la empresa encontrada por NIT ya tiene una ficha sin NIT (caso CEVA) → BENEFICIARIO_EXISTE", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const empresa = await empresaDirecta("TIPO CEVA", `${base}-${dvNit(base)}`);
    const sinNit = await prisma.beneficiario.create({ data: { nombre: `${P} TIPO CEVA`, empresaId: empresa.id } });

    const error = await crearBeneficiario({ nombre: `${P} TIPO CEVA 2`, nit: base }, db.userId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BeneficiarioExisteError);
    expect((error as BeneficiarioExisteError).existente.id).toBe(sinNit.id);
    // ADMIN «otra cuenta del mismo proveedor»: sí.
    const otra = await crearBeneficiario({ nombre: `${P} TIPO CEVA CTA 2`, nit: base }, db.userId, {
      permitirMismoNit: true,
    });
    expect(otra.empresaId).toBe(empresa.id);
  });

  it("empresa con el mismo nombre y NIT provisional (caso ASCINTER) → aviso antes de crear otra empresa", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await empresaDirecta("ASESORIAS ZETA S.A.S.", `PENDIENTE-NIT-${baseAleatoria()}`);
    const ficha = await prisma.beneficiario.create({ data: { nombre: `${P} ASESORIAS ZETA`, empresaId: empresa.id } });

    const error = await crearBeneficiario({ nombre: `${P} Asesorías Zeta SAS`, nit: baseAleatoria() }, db.userId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PosibleBeneficiarioDuplicadoError);
    expect((error as PosibleBeneficiarioDuplicadoError).existentes.map((e) => e.id)).toEqual([ficha.id]);

    // Sin fichas: aviso de empresa repetida.
    await empresaDirecta("SOLO NOMBRE", `PENDIENTE-NIT-${baseAleatoria()}`);
    await expect(
      crearBeneficiario({ nombre: `${P} SOLO NOMBRE`, nit: baseAleatoria() }, db.userId),
    ).rejects.toBeInstanceOf(PosibleEmpresaDuplicadaError);
    // Confirmado que es otra: se crea.
    const confirmada = await crearBeneficiario(
      { nombre: `${P} SOLO NOMBRE`, nit: baseAleatoria(), confirmarOtraFicha: true },
      db.userId,
    );
    expect(confirmada.empresaCreada).toBe(true);
  });

  it("dos empresas con el mismo NIT base ya repetidas → EMPRESA_MISMO_NIT, no se escoge una a ciegas", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    await empresaDirecta("REPE 1", base);
    await empresaDirecta("REPE 2", `${base}-${dvNit(base)}`);
    await expect(crearBeneficiario({ nombre: `${P} REPE FICHA`, nit: base }, db.userId)).rejects.toBeInstanceOf(
      EmpresasRepetidasPorNitError,
    );
  });

  // ── Edición ───────────────────────────────────────────────────────────────

  it("editar: quitarle la empresa a una ficha → FICHA_SIN_EMPRESA", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const ficha = await crearBeneficiario({ nombre: `${P} QUITAR EMPRESA`, nit: base }, db.userId);
    await expect(actualizarBeneficiario(ficha.id, { empresaId: null }, db.userId)).rejects.toBeInstanceOf(
      FichaSinEmpresaError,
    );
    // Editar otra cosa sigue funcionando.
    const editada = await actualizarBeneficiario(ficha.id, { banco: "Banco X" }, db.userId);
    expect(editada.banco).toBe("Banco X");
    expect(editada.empresaId).toBe(ficha.empresaId);
  });

  it("ficha del socio: vive sin empresa, no se enlaza y solo puede haber una", async (ctx) => {
    const db = ensureDb(ctx);
    const yaHay = await prisma.beneficiario.findFirst({ where: { esFichaSocio: true } });
    if (yaHay) ctx.skip("La BD ya tiene la ficha del socio; esta prueba necesita crearla");
    const socio = await prisma.beneficiario.create({
      data: { nombre: `${P} SOCIO`, nit: baseAleatoria(), esFichaSocio: true },
    });
    const empresa = await empresaDirecta("EMPRESA CUALQUIERA", baseAleatoria());

    await expect(actualizarBeneficiario(socio.id, { empresaId: empresa.id }, db.userId)).rejects.toBeInstanceOf(
      FichaSocioConEmpresaError,
    );
    // Se puede editar sin empresa.
    const editada = await actualizarBeneficiario(socio.id, { banco: "Bancolombia" }, db.userId);
    expect(editada.empresaId).toBeNull();

    await expect(
      prisma.beneficiario.create({ data: { nombre: `${P} SOCIO 2`, esFichaSocio: true } }),
    ).rejects.toThrow();

    // Su NIT no se repite, ni con «otra cuenta» de ADMIN, ni al asegurar la ficha de una empresa.
    await expect(
      crearBeneficiario({ nombre: `${P} SOCIO COMO EMPRESA`, nit: socio.nit }, db.userId, { permitirMismoNit: true }),
    ).rejects.toBeInstanceOf(NitDelSocioError);
    const conNitDelSocio = await empresaDirecta("CON NIT DEL SOCIO", socio.nit!);
    await expect(
      prisma.$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, conNitDelSocio)),
    ).rejects.toBeInstanceOf(NitDelSocioError);

    await prisma.beneficiario.delete({ where: { id: socio.id } });
  });

  it("la BD rechaza una ficha suelta nueva aunque se escriba por fuera del servicio", async (ctx) => {
    ensureDb(ctx);
    await expect(prisma.beneficiario.create({ data: { nombre: `${P} SUELTA` } })).rejects.toThrow(
      /beneficiario_empresa_o_socio/,
    );
    // Ni ficha del socio CON empresa.
    const empresa = await empresaDirecta("EMPRESA SOCIO NO", baseAleatoria());
    await expect(
      prisma.beneficiario.create({ data: { nombre: `${P} SOCIO CON EMPRESA`, esFichaSocio: true, empresaId: empresa.id } }),
    ).rejects.toThrow(/beneficiario_empresa_o_socio/);
  });

  // ── asegurarBeneficiarioDeEmpresa (hallazgo 1 de «ascinter») ─────────────

  it("asegurar: el NIT ya es de un proveedor de OTRA empresa → NIT_DE_OTRA_EMPRESA, no crea otra ficha", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const ficha = await crearBeneficiario({ nombre: `${P} DUEÑA`, nit: base, dv }, db.userId);
    // Misma base escrita distinto (sin DV): el NIT único exacto de `cliente` no lo ve.
    const repetida = await empresaDirecta("REPETIDA", base);

    const error = await prisma
      .$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, repetida))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NitDeOtraEmpresaError);
    expect((error as NitDeOtraEmpresaError).detalles).toMatchObject({ fichaId: ficha.id, empresaId: ficha.empresaId });
    expect(await prisma.beneficiario.count({ where: { nitBase: base } })).toBe(1);
  });

  it("asegurar: NIT con el DV pegado sin guion → POSIBLE_BENEFICIARIO_DUPLICADO; confirmado, crea", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    await crearBeneficiario({ nombre: `${P} ORIGINAL`, nit: base, dv }, db.userId);
    const pegada = await empresaDirecta("PEGADA", `${base}${dv}`);

    await expect(
      prisma.$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, pegada)),
    ).rejects.toBeInstanceOf(PosibleBeneficiarioDuplicadoError);
    const creada = await prisma.$transaction((tx) =>
      asegurarBeneficiarioDeEmpresa(tx, pegada, { confirmarOtraFicha: true }),
    );
    expect(creada.empresaId).toBe(pegada.id);
    expect(creada.nitBase).toBe(`${base}${dv}`);
  });

  it("asegurar: NIT provisional → ficha SIN NIT (no va a Siigo un NIT inventado)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await empresaDirecta("PROVISIONAL", `PENDIENTE-NIT-${baseAleatoria()}`);
    const ficha = await prisma.$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, empresa));
    expect(ficha.empresaId).toBe(empresa.id);
    expect(ficha.nit).toBeNull();
    // Idempotente.
    const otraVez = await prisma.$transaction((tx) => asegurarBeneficiarioDeEmpresa(tx, empresa));
    expect(otraVez.id).toBe(ficha.id);
  });

  // ── NIT de empresa único por NIT base (hallazgo 2 de «ascinter») ─────────

  it("verificarNitEmpresaLibre: el mismo NIT con o sin DV es la misma empresa → EMPRESA_MISMO_NIT", async (ctx) => {
    ensureDb(ctx);
    const base = baseAleatoria();
    const dv = dvNit(base);
    const empresa = await empresaDirecta("UNICA", `${base}-${dv}`);

    await expect(prisma.$transaction((tx) => verificarNitEmpresaLibre(tx, base))).rejects.toBeInstanceOf(
      EmpresaMismoNitError,
    );
    await expect(
      prisma.$transaction((tx) => verificarNitEmpresaLibre(tx, `${base.slice(0, 3)}.${base.slice(3, 6)}.${base.slice(6)}-${dv}`)),
    ).rejects.toBeInstanceOf(EmpresaMismoNitError);
    // La misma empresa editándose a sí misma: libre.
    await prisma.$transaction((tx) => verificarNitEmpresaLibre(tx, base, empresa.id));
    // Provisionales no se comparan entre sí.
    expect(await prisma.$transaction((tx) => buscarEmpresaPorNit(tx, "PENDIENTE-NIT-X"))).toBeNull();
  });

  // ── Borrar empresa ───────────────────────────────────────────────────────

  it("borrar empresa: sus fichas sin uso se van con ella; con facturas de proveedor → EMPRESA_CON_PAGOS", async (ctx) => {
    const db = ensureDb(ctx);
    const libre = await crearBeneficiario({ nombre: `${P} SIN USO`, nit: baseAleatoria() }, db.userId);
    await prisma.$transaction(async (tx) => {
      await eliminarFichasSinUsoDeEmpresa(tx, libre.empresaId!, db.userId);
      await tx.cliente.delete({ where: { id: libre.empresaId! } });
    });
    expect(await prisma.beneficiario.findUnique({ where: { id: libre.id } })).toBeNull();

    const usada = await crearBeneficiario({ nombre: `${P} CON FACTURA`, nit: baseAleatoria() }, db.userId);
    const tramiteId = await crearTramiteTest(db);
    await crearFacturaAlmacargaTest(db, tramiteId, `F3-${Date.now()}`, 100_000n, usada.id);
    await expect(
      prisma.$transaction((tx) => eliminarFichasSinUsoDeEmpresa(tx, usada.empresaId!, db.userId)),
    ).rejects.toBeInstanceOf(EmpresaConPagosError);
    expect(await prisma.beneficiario.findUnique({ where: { id: usada.id } })).not.toBeNull();
  });

  // ── Juntar fichas del mismo proveedor (hallazgo 2) ───────────────────────

  it("fichasHermanas no junta fichas de dos empresas distintas con el mismo NIT base", async (ctx) => {
    const db = ensureDb(ctx);
    const base = baseAleatoria();
    const a = await crearBeneficiario({ nombre: `${P} HERMANA A`, nit: base }, db.userId);
    // Otra cuenta de la MISMA empresa (ADMIN).
    const a2 = await crearBeneficiario(
      { nombre: `${P} HERMANA A CTA 2`, nit: base, empresaId: a.empresaId, numCuenta: "2" },
      db.userId,
      { permitirMismoNit: true },
    );
    // Dato viejo: otra empresa con la misma base (escrito por fuera de las reglas).
    const otra = await empresaDirecta("OTRA MISMA BASE", `${base}-${dvNit(base)}`);
    const b = await prisma.beneficiario.create({ data: { nombre: `${P} HERMANA B`, nit: base, empresaId: otra.id } });

    const deA = (await fichasHermanas(prisma, a.id)).map((f) => f.id).sort();
    expect(deA).toEqual([a.id, a2.id].sort());
    const deB = (await fichasHermanas(prisma, b.id)).map((f) => f.id);
    expect(deB).toEqual([b.id]);
    // Y cada empresa suma solo lo suyo.
    const empresaA = await prisma.cliente.findUniqueOrThrow({ where: { id: a.empresaId! } });
    expect((await fichasDeEmpresa(prisma, empresaA.id, empresaA.nit)).map((f) => f.id).sort()).toEqual(
      [a.id, a2.id].sort(),
    );
  });
});
