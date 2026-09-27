/**
 * Una sola llave de factura para los dos caminos por los que puede entrar la
 * deuda con un proveedor (revisión 26-sep):
 *   1. "Registrar factura" en la cuenta corriente de la empresa
 *      (`MovimientoCuenta` CARGO_MANUAL rol PROVEEDOR) — para facturas que no
 *      son de ningún trámite (caso Coldex).
 *   2. Factura de proveedor dentro de un DO (`FacturaProveedor`, CxP v2).
 * Antes ninguno de los dos caminos veía al otro: se podía contar la misma
 * factura dos veces. Cubre además la normalización única (CxP v2) que ahora
 * comparten `registrarMovimientoCuenta` y `crearFacturaProveedor`.
 *
 * Requiere DATABASE_URL de una base desechable migrada (+ seed).
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  type Fixture,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { FacturaEnCuentaCorrienteError } from "@/lib/cxp/errores";
import { normalizarNumeroFactura as normalizarCxp } from "@/lib/cxp/saldos";
import {
  eliminarMovimientoCuenta,
  FacturaYaRegistradaEnTramiteError,
  getCuentaCorriente,
  MovimientoCuentaEsCruceError,
  MovimientoCuentaSostieneAjusteError,
  normalizarNumeroFactura as normalizarCuentaCorriente,
  registrarMovimientoCuenta,
} from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import {
  actualizarFacturaProveedor,
  crearFacturaProveedor,
  eliminarFacturaProveedor,
} from "@/lib/facturas-proveedor/service";

const sello = String(Date.now()).slice(-8);
const nitEmpresas = Array.from({ length: 6 }, (_, i) => `${9 - i}${sello}`);
const [nitE1, nitE2, nitE3, nitE4, nitE5, nitE6] = nitEmpresas;
const FECHA = new Date(Date.UTC(3003, 3, 1));

/** Cualquier NIT (de empresa o de ficha) nacido de una de las 6 semillas de esta corrida. */
function filtroNits() {
  return { OR: nitEmpresas.map((n) => ({ nit: { startsWith: n } })) };
}

async function borrarPropios() {
  const empresas = await prisma.cliente.findMany({ where: filtroNits(), select: { id: true } });
  const ids = empresas.map((e) => e.id);
  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
}

async function borrarFichasYEmpresas() {
  await prisma.beneficiario.deleteMany({ where: filtroNits() });
  await prisma.cliente.deleteMany({ where: filtroNits() });
}

/** Empresa con `cargos_manuales_contraparte` (para "Registrar factura"). */
async function crearEmpresa(nombre: string, nit: string) {
  const empresa = await prisma.cliente.create({
    data: { nombre, nit, tipo: "PROPIO", esCliente: true, esProveedor: true },
  });
  await prisma.empresaCapacidad.create({
    data: { empresaId: empresa.id, codigo: "cargos_manuales_contraparte", habilitado: true },
  });
  return empresa;
}

async function crearFichaPropia(nombre: string, nit: string, empresaId: string) {
  return prisma.beneficiario.create({ data: { nombre, nit, empresaId } });
}

async function crearFichaSuelta(nombre: string, nit: string) {
  return prisma.beneficiario.create({ data: { nombre, nit } });
}

async function crearFacturaDeProveedor(
  db: Fixture,
  beneficiarioId: string,
  numFactura: string,
  valor = 100_000n,
) {
  const tramiteId = await crearTramiteTest(db);
  await aplicarAnticipoTest(db, tramiteId, valor);
  return crearFacturaProveedor({
    tramiteId,
    beneficiarioId,
    numFactura,
    valor,
    fecha: FECHA,
    repercutible: true,
    confirmarPosibleDuplicado: true,
    subidaPorId: db.userId,
  });
}

beforeAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarPropios();
    } catch {
      // Sin BD: prepararBdAlmacarga deja el motivo del skip.
    }
  }
  await prepararBdAlmacarga();
});

afterAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarPropios();
    } catch {
      // Sin BD no hay nada que limpiar.
    }
  }
  await liberarBdAlmacarga();
  if (process.env.DATABASE_URL) {
    try {
      await borrarFichasYEmpresas();
    } catch {
      // Sin BD no hay nada que limpiar.
    } finally {
      await prisma.$disconnect();
    }
  }
});

describe("normalización única (CxP v2)", () => {
  it("cuenta corriente reexporta EXACTAMENTE la función de CxP v2 (misma referencia)", () => {
    expect(normalizarCuentaCorriente).toBe(normalizarCxp);
  });

  it("'FE-1234', 'fe 1234' y 'FE1234' coinciden", () => {
    expect(normalizarCuentaCorriente("FE-1234")).toBe("FE1234");
    expect(normalizarCuentaCorriente("fe 1234")).toBe("FE1234");
    expect(normalizarCuentaCorriente("FE1234")).toBe("FE1234");
  });

  it("un carácter que la normalización vieja de cuenta corriente NO quitaba ('/') también se limpia ahora", () => {
    // La normalización vieja de `cuenta-corriente/service.ts` solo quitaba
    // espacios, puntos y guiones; la de CxP v2 (que ahora es la única) quita
    // cualquier carácter que no sea A-Z0-9.
    expect(normalizarCuentaCorriente("FE/1234")).toBe("FE1234");
  });
});

describe("A · FacturaProveedor (DO) primero → 'Registrar factura' con el mismo número choca", () => {
  it("409 FacturaYaRegistradaEnTramiteError, con el DO y la fecha de la factura", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E1 DOBLE CAMINO", nitE1);
    const ficha = await crearFichaPropia("E1 (ficha)", `${nitE1}-1`, empresa.id);
    const f = await crearFacturaDeProveedor(db, ficha.id, "FE-1234");
    const tramite = await prisma.tramiteDO.findUniqueOrThrow({
      where: { id: f.tramiteId },
      select: { consecutivo: true },
    });

    const error = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Duplicado con el DO",
      valor: 100_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      // Formato distinto: debe normalizar igual que el de la factura del DO.
      numeroFactura: "fe.1234",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaYaRegistradaEnTramiteError);
    expect((error as InstanceType<typeof FacturaYaRegistradaEnTramiteError>).status).toBe(409);
    expect((error as Error).message).toContain("FE-1234");
    expect((error as Error).message).toContain(tramite.consecutivo);
    expect((error as Error).message).toContain("No la registres también aquí");

    // No escribió nada.
    expect(
      await prisma.movimientoCuenta.count({ where: { empresaId: empresa.id, numeroFacturaNorm: "FE1234" } }),
    ).toBe(0);
  }, 30_000);
});

describe("B · 'Registrar factura' primero → FacturaProveedor (crear o editar) con el mismo número choca", () => {
  it("409 FacturaEnCuentaCorrienteError al CREAR la factura del DO", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E2 DOBLE CAMINO", nitE2);
    const ficha = await crearFichaPropia("E2 (ficha)", `${nitE2}-1`, empresa.id);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros",
      valor: 500_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-5678",
    });

    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 500_000n);
    const error = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: ficha.id,
      // Formato distinto: debe normalizar igual.
      numFactura: "fe 5678",
      valor: 500_000n,
      fecha: FECHA,
      repercutible: true,
      confirmarPosibleDuplicado: true,
      subidaPorId: db.userId,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaEnCuentaCorrienteError);
    expect((error as InstanceType<typeof FacturaEnCuentaCorrienteError>).status).toBe(409);
    expect((error as Error).message).toContain("FE-5678");
    expect((error as Error).message).toContain("Registrar factura");
    // No le pide a quien ve el mensaje que la elimine él mismo: casi nunca
    // puede (solo ADMIN ve Cuenta corriente y su botón «Eliminar»).
    expect((error as Error).message).toContain("Pide a un ADMIN que la elimine");

    expect(await prisma.facturaProveedor.count({ where: { tramiteId, numFacturaNormalizado: "FE5678" } })).toBe(0);
  }, 30_000);

  it("409 FacturaEnCuentaCorrienteError al EDITAR el número o el proveedor de una factura del DO", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E3 DOBLE CAMINO", nitE3);
    const ficha = await crearFichaPropia("E3 (ficha)", `${nitE3}-1`, empresa.id);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Quincenas",
      valor: 300_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-9001",
    });

    // Factura del DO con OTRO número (no choca al crearla)...
    const f = await crearFacturaDeProveedor(db, ficha.id, "FE-9002", 300_000n);

    // ...pero editarla al número que ya está en la cuenta corriente sí choca.
    const error = await actualizarFacturaProveedor(
      f.id,
      { numFactura: "fe-9001" },
      db.userId,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaEnCuentaCorrienteError);
    expect((error as Error).message).toContain("FE-9001");

    // No se editó: sigue con su número original.
    const sinCambios = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: f.id } });
    expect(sinCambios.numFactura).toBe("FE-9002");
  }, 30_000);
});

describe("C · una empresa distinta con el mismo número NO choca", () => {
  it("misma factura (mismo texto) en dos proveedores sin relación: las dos se registran", async (ctx) => {
    const db = ensureDb(ctx);
    const empresaA = await crearEmpresa("E4 SIN RELACION", nitE4);
    const empresaB = await crearEmpresa("E5 SIN RELACION", nitE5);
    const fichaA = await crearFichaPropia("E4 (ficha)", `${nitE4}-1`, empresaA.id);

    await crearFacturaDeProveedor(db, fichaA.id, "FE-0001", 200_000n);

    // Otra empresa, sin ninguna ficha en común: el mismo número no choca.
    await expect(
      registrarMovimientoCuenta({
        empresaId: empresaB.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Factura sin relación con E4",
        valor: 200_000n,
        fecha: FECHA,
        usuarioId: db.userId,
        numeroFactura: "FE-0001",
      }),
    ).resolves.toBeDefined();
  }, 30_000);
});

describe("D · ficha suelta con el mismo NIT base SÍ choca (coherente con fichasDeEmpresa)", () => {
  it("'Registrar factura' en la empresa choca con una FacturaProveedor de su ficha SUELTA hermana", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E6 FICHA SUELTA", nitE6);
    // Ficha suelta (sin empresaId) con el MISMO nit que la empresa: comparte
    // NIT base, así que `fichasDeEmpresa(empresa)` la incluye.
    const suelta = await crearFichaSuelta("E6 (otra cuenta)", nitE6);

    await crearFacturaDeProveedor(db, suelta.id, "FE-7777", 150_000n);

    const error = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Debería chocar con la ficha suelta hermana",
      valor: 150_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "fe-7777",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaYaRegistradaEnTramiteError);
  }, 30_000);

  it("crear una FacturaProveedor con una ficha SUELTA choca con lo ya registrado a mano en la empresa hermana (mismo NIT)", async (ctx) => {
    const db = ensureDb(ctx);
    // Prefijo de nitE6 (cubierto por la limpieza de esta corrida) pero NIT
    // propio y solo dígitos (para que `nitBaseDe` lo reconozca), para no
    // chocar con el caso anterior.
    const nitCompartido = `${nitE6}1`;
    const empresa = await crearEmpresa("E7 FICHA SUELTA REVERSO", nitCompartido);
    const suelta = await crearFichaSuelta("E7 (otra cuenta)", nitCompartido);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Registrado a mano en la empresa",
      valor: 80_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-8080",
    });

    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 80_000n);
    const error = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: suelta.id,
      numFactura: "fe-8080",
      valor: 80_000n,
      fecha: FECHA,
      repercutible: true,
      confirmarPosibleDuplicado: true,
      subidaPorId: db.userId,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaEnCuentaCorrienteError);
  }, 30_000);

  it("ficha PROPIA con guion (base de 9 dígitos) y una suelta con el NIT completo (base de 10) SÍ choca — antes `empresasDeFicha` no la encontraba", async (ctx) => {
    const db = ensureDb(ctx);
    // NIT de la empresa CON guion: base = nitE1 (todo lo que hay antes del
    // guion). El prefijo `nitE1` es el que usa `filtroNits()` para la
    // limpieza — cualquier NIT que empiece por él se borra en `afterAll`.
    const nitEmpresaConGuion = `${nitE1}-1`;
    const empresa = await crearEmpresa("E8 BASES DISTINTAS", nitEmpresaConGuion);
    // Ficha PROPIA con el NIT completo SIN guion → base de 11 dígitos, DISTINTA
    // de la de la empresa (9 dígitos): `fichasDeEmpresa` la suma igual, porque
    // junta la base de la empresa CON la de sus fichas propias.
    const nitFichaSinGuion = `${nitE1}15`;
    await crearFichaPropia("E8 (ficha propia)", nitFichaSinGuion, empresa.id);
    // Ficha SUELTA con la MISMA base de 10 dígitos que la ficha propia (no con
    // la de la empresa): la vieja `empresasDeFicha` solo miraba `Cliente.nit`
    // y no la encontraba.
    const suelta = await crearFichaSuelta("E8 (otra cuenta)", nitFichaSinGuion);

    await crearFacturaDeProveedor(db, suelta.id, "FE-9191", 90_000n);

    const error = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Debería chocar con la ficha suelta hermana de la ficha propia",
      valor: 90_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "fe-9191",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaYaRegistradaEnTramiteError);
  }, 30_000);

  it("en reversa: crear la FacturaProveedor con la ficha suelta choca con lo ya registrado a mano (mismo caso, orden invertido)", async (ctx) => {
    const db = ensureDb(ctx);
    const nitEmpresaConGuion = `${nitE2}-1`;
    const empresa = await crearEmpresa("E9 BASES DISTINTAS REVERSO", nitEmpresaConGuion);
    const nitFichaSinGuion = `${nitE2}15`;
    await crearFichaPropia("E9 (ficha propia)", nitFichaSinGuion, empresa.id);
    const suelta = await crearFichaSuelta("E9 (otra cuenta)", nitFichaSinGuion);

    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Registrado a mano en la empresa",
      valor: 45_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-9292",
    });

    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 45_000n);
    const error = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: suelta.id,
      numFactura: "fe-9292",
      valor: 45_000n,
      fecha: FECHA,
      repercutible: true,
      confirmarPosibleDuplicado: true,
      subidaPorId: db.userId,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaEnCuentaCorrienteError);
  }, 30_000);
});

describe("F · 'Registrar factura' con origen AJUSTE (no solo CARGO_MANUAL) también choca contra el DO", () => {
  it("un movimiento AJUSTE con numeroFactura bloquea crear la misma factura como FacturaProveedor", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E10 AJUSTE CON NUMERO", `${nitE1}-ajuste`);
    // `cuenta_corriente` habilitada además de `cargos_manuales_contraparte`:
    // AJUSTE la exige.
    await prisma.empresaCapacidad.create({
      data: { empresaId: empresa.id, codigo: "cuenta_corriente", habilitado: true },
    });
    const ficha = await crearFichaPropia("E10 (ficha)", `${nitE1}-ajuste-1`, empresa.id);

    // Antes de esta corrección, `verificarNoRegistradaEnCuentaCorriente` solo
    // miraba origen CARGO_MANUAL y este AJUSTE se colaba sin chocar.
    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Ajuste con número de factura",
      valor: 70_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-AJ-01",
    });

    const tramiteId = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, tramiteId, 70_000n);
    const error = await crearFacturaProveedor({
      tramiteId,
      beneficiarioId: ficha.id,
      numFactura: "fe-aj-01",
      valor: 70_000n,
      fecha: FECHA,
      repercutible: true,
      confirmarPosibleDuplicado: true,
      subidaPorId: db.userId,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FacturaEnCuentaCorrienteError);
    expect((error as Error).message).toContain("FE-AJ-01");
  }, 30_000);
});

describe("G · eliminarMovimientoCuenta cuando una factura de CxP sostiene la punta proveedor pero lo MANUAL solo queda negativo", () => {
  it("un ajuste PROVEEDOR CARGO que se apoya en la factura manual borrada da MovimientoCuentaSostieneAjusteError (no 'es parte de un cruce')", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E12 AJUSTE APOYADO", `${nitE1}-apoyado`);
    await prisma.empresaCapacidad.create({
      data: { empresaId: empresa.id, codigo: "cuenta_corriente", habilitado: true },
    });
    const ficha = await crearFichaPropia("E12 (ficha)", `${nitE1}-apoyado-1`, empresa.id);

    // Una factura de CxP real (2.000.000) sostiene casi toda la punta
    // proveedor: sin ella, borrar la factura manual sí cruzaría a negativo (lo
    // que ya prueba la suite de arriba); CON ella, la punta COMPLETA se queda
    // en positivo y el chequeo general no debe bloquear.
    await crearFacturaDeProveedor(db, ficha.id, "FE-CXP-SOSTIENE", 2_000_000n);

    const facturaManual = await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros (fuera de trámite)",
      valor: 1_000_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "FE-MANUAL-APOYADO",
    });
    // El ajuste "gasta" 700.000 de lo que la factura manual sostiene en la
    // parte SOLO manual (maximoSinFacturaProveedor): borrar la factura manual
    // dejaría esa parte en negativo, aunque la punta completa siga en positivo
    // gracias a la factura de CxP.
    await registrarMovimientoCuenta({
      empresaId: empresa.id,
      rol: "PROVEEDOR",
      tipo: "CARGO",
      origen: "AJUSTE",
      lineaServicio: "TRAMITE",
      concepto: "Descuento del proveedor",
      valor: 700_000n,
      fecha: FECHA,
      usuarioId: db.userId,
    });

    const cuentaAntes = await getCuentaCorriente(empresa.id);
    expect(cuentaAntes.pendienteProveedor).toBe(2_300_000n); // 2.000.000 + 1.000.000 - 700.000
    expect(cuentaAntes.maximoSinFacturaProveedor).toBe(0n); // pendienteCliente = 0 en esta empresa

    const error = await eliminarMovimientoCuenta(empresa.id, facturaManual.id, db.userId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MovimientoCuentaSostieneAjusteError);
    expect(error).not.toBeInstanceOf(MovimientoCuentaEsCruceError);
    // El mensaje no manda a buscar un cruce que no existe.
    expect((error as Error).message).not.toMatch(/deshaz el cruce primero/);
    expect((error as Error).message).toMatch(/ajuste/i);

    // No se borró nada y la cuenta no cambió.
    const enBd = await prisma.movimientoCuenta.findUnique({ where: { id: facturaManual.id } });
    expect(enBd).not.toBeNull();
    const cuentaDespues = await getCuentaCorriente(empresa.id);
    expect(cuentaDespues.pendienteProveedor).toBe(2_300_000n);
  }, 30_000);
});

describe("E · factura de proveedor eliminada no choca", () => {
  it("borrar la FacturaProveedor libera el número para 'Registrar factura'", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("E1B ELIMINADA", `${nitE1}-elim`);
    const ficha = await crearFichaPropia("E1B (ficha)", `${nitE1}-elim-1`, empresa.id);
    const f = await crearFacturaDeProveedor(db, ficha.id, "FE-6060", 60_000n);

    await eliminarFacturaProveedor(f.id, db.userId);

    await expect(
      registrarMovimientoCuenta({
        empresaId: empresa.id,
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: "Ya no debería chocar: la factura del DO se borró",
        valor: 60_000n,
        fecha: FECHA,
        usuarioId: db.userId,
        numeroFactura: "fe.6060",
      }),
    ).resolves.toBeDefined();
  }, 30_000);
});
