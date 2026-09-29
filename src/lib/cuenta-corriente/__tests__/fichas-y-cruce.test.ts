/**
 * Cuenta corriente ↔ estado de cuenta CxP v2 (revisión adversarial antes del
 * despliegue, 26-sep). Integración con Postgres local (base desechable).
 *
 *  A. Las dos pantallas suman las MISMAS fichas del proveedor
 *     (`fichasDeEmpresa`): la ficha suelta con el NIT de la empresa (p. ej. la
 *     «otra ficha» que crea el ADMIN, nace sin empresa) sale en las dos con el
 *     mismo saldo, y la ficha de OTRA empresa con la misma base no sale en
 *     ninguna de las dos. Un cruce contra la factura de una ficha suelta se
 *     deshace completo.
 *  B. El cruce «sin factura» de proveedor solo baja lo registrado a mano: lo
 *     que se debe en facturas (caso Coldex: una factura que se cobra al
 *     cliente) sigue Pendiente en el estado de cuenta y se paga por el libro;
 *     cruzarlo sin factura lo descontaba dos veces.
 *
 * Requiere DATABASE_URL de una base desechable migrada (+ seed).
 */
import "dotenv/config";

import { EstadoFacturaProveedor, OrigenMovimientoCuenta, RolCuenta, TipoCliente, TipoMovimientoCuenta } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearTramiteTest,
  ensureDb,
  type Fixture,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import { getEstadoCuentaProveedor } from "@/lib/cxp/estado-cuenta";
import {
  CompensacionInvalidaError,
  eliminarCompensacion,
  getCuentaCorriente,
  registrarCompensacion,
  registrarMovimientoCuenta,
} from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";

/** NIT numéricos propios de esta corrida: la base de las fichas hermanas, una por caso. */
const sello = String(Date.now()).slice(-8);
const nitColdex = `7${sello}`;
const nitAscinter = `6${sello}`;
const nitsNumericos = [{ nit: { startsWith: nitColdex } }, { nit: { startsWith: nitAscinter } }];
const FECHA = new Date(Date.UTC(3003, 3, 1));

/**
 * movimiento_cuenta → cliente es Restrict: los movimientos y capacidades de
 * las empresas de prueba se borran ANTES de la limpieza común (que borra las
 * empresas con el prefijo de prueba).
 */
async function borrarMovimientosPropios() {
  const empresas = await prisma.cliente.findMany({
    where: { OR: [{ nit: { startsWith: `${TEST_PREFIX}-cc-` } }, ...nitsNumericos] },
    select: { id: true },
  });
  const ids = empresas.map((e) => e.id);
  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: ids } } });
  await prisma.empresaCapacidad.deleteMany({ where: { empresaId: { in: ids } } });
}

/** Fichas y empresas de NIT numérico: la limpieza común no las ve (no llevan el prefijo). */
async function borrarFichasYEmpresasNumericas() {
  await prisma.beneficiario.deleteMany({ where: { OR: nitsNumericos } });
  await prisma.cliente.deleteMany({ where: { OR: nitsNumericos } });
}

async function crearEmpresa(nombre: string, nit: string, capacidades: string[]) {
  const empresa = await prisma.cliente.create({
    data: { nombre, nit, tipo: TipoCliente.PROPIO, esCliente: true, esProveedor: true },
  });
  for (const codigo of capacidades) {
    await prisma.empresaCapacidad.create({ data: { empresaId: empresa.id, codigo, habilitado: true } });
  }
  return empresa;
}

/** «Nos debe» como cliente, sin armar una factura de venta completa. */
async function nosDebe(db: Fixture, empresaId: string, valor: bigint) {
  await prisma.movimientoCuenta.create({
    data: {
      empresaId,
      rol: RolCuenta.CLIENTE,
      tipo: TipoMovimientoCuenta.CARGO,
      origen: OrigenMovimientoCuenta.CARGO_MANUAL,
      concepto: "Mensualidad de prueba",
      valor,
      fecha: FECHA,
      registradoPorId: db.userId,
    },
  });
}

async function factura(
  db: Fixture,
  beneficiarioId: string,
  numFactura: string,
  valor: bigint,
  repercutible: boolean,
): Promise<string> {
  const tramiteId = await crearTramiteTest(db);
  await aplicarAnticipoTest(db, tramiteId, valor);
  const f = await crearFacturaProveedor({
    tramiteId,
    beneficiarioId,
    numFactura,
    valor,
    fecha: FECHA,
    repercutible,
    confirmarPosibleDuplicado: true,
    subidaPorId: db.userId,
  });
  return f.id;
}

/** Lo que la cuenta corriente suma en facturas de proveedor (sin lo registrado a mano). */
function facturasProveedorEnCuenta(cuenta: Awaited<ReturnType<typeof getCuentaCorriente>>): bigint {
  return cuenta.movimientos.filter((a) => a.fuente === "FACTURA_PROVEEDOR").reduce((s, a) => s - a.valor, 0n);
}

async function estadoFactura(id: string) {
  const f = await prisma.facturaProveedor.findUniqueOrThrow({
    where: { id },
    select: { estado: true, montoCompensado: true, compensacionId: true },
  });
  return f;
}

beforeAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosPropios();
    } catch {
      // Sin BD: prepararBdAlmacarga deja el motivo del skip.
    }
  }
  await prepararBdAlmacarga();
});

afterAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosPropios();
    } catch {
      // Sin BD no hay nada que limpiar.
    }
  }
  await liberarBdAlmacarga();
  // La limpieza común ya borró las facturas y los DOs: ahora se pueden quitar
  // las fichas y empresas de NIT numérico.
  if (process.env.DATABASE_URL) {
    try {
      await borrarFichasYEmpresasNumericas();
    } catch {
      // Sin BD no hay nada que limpiar.
    } finally {
      await prisma.$disconnect();
    }
  }
});

describe("A · cuenta corriente y estado de cuenta suman las mismas fichas", () => {
  it("la ficha suelta con el NIT de la empresa sale en las dos con el mismo saldo; la de OTRA empresa con la misma base, en ninguna", async (ctx) => {
    const db = ensureDb(ctx);
    const coldex = await crearEmpresa("COLDEX FICHAS", nitColdex, ["cuenta_corriente"]);
    const otra = await crearEmpresa("OTRA CON LA MISMA BASE", `${nitColdex}-5`, ["cuenta_corriente"]);

    const propia = await prisma.beneficiario.create({
      data: { nombre: "COLDEX (cuenta principal)", nit: `${nitColdex}-1`, empresaId: coldex.id },
    });
    // «Otra ficha» creada por el ADMIN con el mismo NIT, sin indicar empresa
    // (fase 3: la ayuda la enlaza a la empresa que tenga ese NIT exacto).
    const suelta = await crearFichaConEmpresaTest({ nombre: "COLDEX (otra cuenta)", nit: nitColdex });
    const deOtra = await prisma.beneficiario.create({
      data: { nombre: "OTRA (su cuenta)", nit: `${nitColdex}-2`, empresaId: otra.id },
    });

    const fPropia = await factura(db, propia.id, "FE-810001", 100_000n, true);
    const fSuelta = await factura(db, suelta.id, "FE-820002", 50_000n, true);
    const fOtra = await factura(db, deOtra.id, "FE-830003", 70_000n, true);

    const cuenta = await getCuentaCorriente(coldex.id);
    const estado = await getEstadoCuentaProveedor(coldex.id, "ADMIN");

    // Mismo saldo en las dos pantallas: propia + suelta, sin la de la otra empresa.
    expect(facturasProveedorEnCuenta(cuenta)).toBe(150_000n);
    expect(cuenta.pendienteProveedor).toBe(150_000n);
    expect(estado.resumen?.pendiente).toBe("150000");

    const idsCuenta = cuenta.movimientos.map((a) => a.id);
    expect(idsCuenta).toContain(`factura-proveedor:${fPropia}`);
    expect(idsCuenta).toContain(`factura-proveedor:${fSuelta}`);
    expect(idsCuenta).not.toContain(`factura-proveedor:${fOtra}`);

    expect(estado.fichas.map((f) => f.id).sort()).toEqual([propia.id, suelta.id].sort());
    expect(estado.facturas.map((f) => f.id).sort()).toEqual([fPropia, fSuelta].sort());

    // La otra empresa no ve las fichas ni las facturas de Coldex.
    const estadoOtra = await getEstadoCuentaProveedor(otra.id, "ADMIN");
    expect(estadoOtra.fichas.map((f) => f.id)).not.toContain(propia.id);
    expect(estadoOtra.facturas.map((f) => f.id)).not.toContain(fPropia);
  }, 30_000);

  it("un cruce contra la factura (no repercutible) de la ficha suelta se registra y se deshace completo", async (ctx) => {
    const db = ensureDb(ctx);
    const empresa = await crearEmpresa("ASCINTER FICHAS", nitAscinter, ["cuenta_corriente"]);
    await nosDebe(db, empresa.id, 1_000_000n);
    // Fase 3: la «otra cuenta» es de la MISMA empresa (dos empresas con el mismo
    // NIT base ya no se suman en la cuenta del proveedor).
    const suelta = await crearFichaConEmpresaTest({
      nombre: "ASCINTER (otra cuenta)",
      nit: `${nitAscinter}-3`,
      empresaId: empresa.id,
    });
    const f = await factura(db, suelta.id, "AS-840004", 300_000n, false);

    const antes = await getCuentaCorriente(empresa.id);
    expect(antes.compensables.facturasProveedor.map((x) => x.id)).toContain(f);

    const { compensacionId, valor } = await registrarCompensacion({
      empresaId: empresa.id,
      fecha: FECHA,
      concepto: "Asesoría contra mensualidad",
      facturaProveedorId: f,
      usuarioId: db.userId,
    });
    expect(valor).toBe(300_000n);
    expect(await estadoFactura(f)).toMatchObject({ estado: EstadoFacturaProveedor.PAGADA, compensacionId });

    await eliminarCompensacion(empresa.id, compensacionId, db.userId);
    expect(await estadoFactura(f)).toMatchObject({
      estado: EstadoFacturaProveedor.REGISTRADA,
      montoCompensado: 0n,
      compensacionId: null,
    });
    const despues = await getCuentaCorriente(empresa.id);
    expect(despues.pendienteCliente).toBe(1_000_000n);
    expect(despues.pendienteProveedor).toBe(300_000n);
  }, 30_000);
});

describe("B · cruce sin factura de proveedor: solo lo registrado a mano", () => {
  it("caso Coldex: nos debe 10.080.187 y le debemos una factura que se cobra al cliente (saldo 2.000.000) → sin factura da 422 y no escribe nada; con 1.000.000 a mano, cruza hasta 1.000.000", async (ctx) => {
    const db = ensureDb(ctx);
    const coldex = await crearEmpresa("COLDEX CRUCE", `${TEST_PREFIX}-cc-coldex-${runId}`, [
      "cuenta_corriente",
      "cargos_manuales_contraparte",
    ]);
    const ficha = await prisma.beneficiario.create({
      data: { nombre: "COLDEX CRUCE", nit: `${TEST_PREFIX}-cc-ben-coldex-${runId}`, empresaId: coldex.id },
    });
    await nosDebe(db, coldex.id, 10_080_187n);
    const repercutible = await factura(db, ficha.id, "CX-850005", 2_000_000n, true);

    const cuenta = await getCuentaCorriente(coldex.id);
    expect(cuenta.pendienteCliente).toBe(10_080_187n);
    expect(cuenta.pendienteProveedor).toBe(2_000_000n);
    expect(cuenta.maximoCompensable).toBe(2_000_000n);
    expect(cuenta.maximoSinFacturaProveedor).toBe(0n);
    // La repercutible no se ofrece como documento cruzable.
    expect(cuenta.compensables.facturasProveedor).toEqual([]);

    const error = await registrarCompensacion({
      empresaId: coldex.id,
      valor: 2_000_000n,
      fecha: FECHA,
      concepto: "Cruce sin factura",
      usuarioId: db.userId,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompensacionInvalidaError);
    expect((error as InstanceType<typeof CompensacionInvalidaError>).status).toBe(422);
    expect((error as Error).message).toMatch(/^Sin factura de proveedor solo se cruza lo registrado a mano \(\$0\)\./);

    // No escribió nada: ni movimientos del cruce, ni auditoría, ni la factura.
    expect(await prisma.movimientoCuenta.count({ where: { empresaId: coldex.id, origen: "COMPENSACION" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entidadId: coldex.id, accion: "COMPENSACION" } })).toBe(0);
    expect(await estadoFactura(repercutible)).toMatchObject({
      estado: EstadoFacturaProveedor.REGISTRADA,
      montoCompensado: 0n,
      compensacionId: null,
    });
    const estado = await getEstadoCuentaProveedor(coldex.id, "ADMIN");
    expect(estado.facturas.find((f) => f.id === repercutible)).toMatchObject({ etiqueta: "Pendiente", saldo: "2000000" });

    // Factura de contraparte registrada a mano por 1.000.000.
    await registrarMovimientoCuenta({
      empresaId: coldex.id,
      rol: "PROVEEDOR",
      tipo: "ABONO",
      origen: "CARGO_MANUAL",
      lineaServicio: "TRAMITE",
      concepto: "Servicios aduaneros septiembre",
      valor: 1_000_000n,
      fecha: FECHA,
      usuarioId: db.userId,
      numeroFactura: "CX-MANUAL-1",
    });
    const conManual = await getCuentaCorriente(coldex.id);
    expect(conManual.maximoSinFacturaProveedor).toBe(1_000_000n);
    expect(conManual.maximoCompensable).toBe(3_000_000n);

    await expect(
      registrarCompensacion({
        empresaId: coldex.id,
        valor: 1_000_001n,
        fecha: FECHA,
        concepto: "Cruce de más",
        usuarioId: db.userId,
      }),
    ).rejects.toThrow(/registrado a mano \(\$1\.000\.000\)/);

    const cruce = await registrarCompensacion({
      empresaId: coldex.id,
      valor: 1_000_000n,
      fecha: FECHA,
      concepto: "Cruce contra la factura a mano",
      usuarioId: db.userId,
    });
    expect(cruce.valor).toBe(1_000_000n);

    const despues = await getCuentaCorriente(coldex.id);
    expect(despues.pendienteCliente).toBe(9_080_187n);
    expect(despues.pendienteProveedor).toBe(2_000_000n);
    expect(despues.maximoSinFacturaProveedor).toBe(0n);
    // La factura que se cobra al cliente sigue Pendiente: se paga por el libro.
    expect(await estadoFactura(repercutible)).toMatchObject({ estado: EstadoFacturaProveedor.REGISTRADA });

    // Deshacer el cruce devuelve el cupo sin factura.
    await eliminarCompensacion(coldex.id, cruce.compensacionId, db.userId);
    const deshecho = await getCuentaCorriente(coldex.id);
    expect(deshecho.maximoSinFacturaProveedor).toBe(1_000_000n);
    expect(deshecho.pendienteCliente).toBe(10_080_187n);
  }, 30_000);
});
