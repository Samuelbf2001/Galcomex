/**
 * CxP v2 — estado de cuenta con el proveedor (diseño §D.1, §D.5). Integración
 * con Postgres local (base desechable).
 *
 * Cubre: vista COMPLETA (ADMIN/REVISOR: facturas de todos los estados,
 * registro de pagos por transferencia —bloque, suelto y anulado—, totales que
 * cuadran I1) y SOLO_PENDIENTES (OPERATIVO, D-6); etiquetas y columna PAGO /
 * ABONOS del Excel; `pagadoSinFactura`; fichas que comparten NIT base; y que
 * `/pagos` filtrado por proveedor dé la misma cifra que la ficha.
 */
import "dotenv/config";

import { CanalPago } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearDocumentoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { fichasDeEmpresa, getEstadoCuentaProveedor, resumenPorProveedor } from "@/lib/cxp/estado-cuenta";
import { prisma } from "@/lib/db/prisma";
import {
  anularPagoGrupo,
  crearPago,
  crearPagoMultiDO,
  listarFacturasElegiblesMultiDO,
  listarPagosGlobal,
} from "@/lib/pagos/service";

const nitHermanas = `9${String(Date.now()).slice(-8)}`;
/** Base compartida por dos empresas (fichasDeEmpresa no debe mezclar sus fichas). */
const nitCompartido = `8${String(Date.now()).slice(-8)}`;

describe("cxp/estado-cuenta — ficha del proveedor", () => {
  let tA: string;
  let tB: string;
  let fPagada: string;
  let fAbonada: string;
  let fPendiente: string;

  beforeAll(prepararBdAlmacarga);
  afterAll(async () => {
    // La limpieza común borra DOs, facturas y pagos de prueba; las fichas con NIT
    // numérico (sin el prefijo de prueba) se borran después (FK Restrict desde el pago).
    await liberarBdAlmacarga();
    await prisma.beneficiario.deleteMany({ where: { nit: { startsWith: nitHermanas } } });
    await prisma.beneficiario.deleteMany({ where: { nit: { startsWith: nitCompartido } } });
    await prisma.cliente.deleteMany({ where: { nit: { startsWith: nitCompartido } } });
    await prisma.$disconnect();
  });

  it("arma el caso: una Pagada por bloque, una Abonada por pago suelto, una Pendiente y un bloque anulado", async (ctx) => {
    const db = ensureDb(ctx);
    tA = await crearTramiteTest(db);
    tB = await crearTramiteTest(db);
    await prisma.tramiteDO.update({ where: { id: tA }, data: { doCliente: "IM054-26", proveedorCliente: "SRF" } });
    await aplicarAnticipoTest(db, tA, 1_000_000n);
    await aplicarAnticipoTest(db, tB, 1_000_000n);
    fPagada = await crearFacturaAlmacargaTest(db, tA, "FE-660101", 433_361n);
    fAbonada = await crearFacturaAlmacargaTest(db, tB, "FE-660102", 300_000n);
    fPendiente = await crearFacturaAlmacargaTest(db, tB, "FE-660103", 461_377n);
    const documentoId = await crearDocumentoTest(db, tA);

    await crearPagoMultiDO({
      beneficiarioId: db.almacargaBeneficiarioId,
      facturas: [{ facturaProveedorId: fPagada, monto: 433_361n }],
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      fechaRealPago: new Date("3003-09-15T00:00:00.000Z"),
      documentoId,
      usuarioId: db.userId,
    });
    await crearPago({
      tramiteId: tB,
      concepto: "Abono FE 660102",
      valor: 100_000n,
      canalPago: CanalPago.PSE,
      fechaRealPago: new Date("3003-09-16T00:00:00.000Z"),
      aplicaciones: [{ facturaProveedorId: fAbonada, monto: 100_000n }],
      usuarioId: db.userId,
    });
    // Pago a Almacarga que no cubre ninguna factura (p. ej. pago de más heredado).
    await crearPago({
      tramiteId: tB,
      concepto: "Pago a Almacarga sin factura",
      valor: 7_000n,
      canalPago: CanalPago.PSE,
      beneficiarioIds: [db.almacargaBeneficiarioId],
      usuarioId: db.userId,
    });
    // Bloque que luego se anula (queda en el registro, tachado).
    const anulado = await crearPagoMultiDO({
      beneficiarioId: db.almacargaBeneficiarioId,
      facturas: [{ facturaProveedorId: fPendiente, monto: 461_377n }],
      canalPago: CanalPago.PSE,
      documentoId,
      usuarioId: db.userId,
    });
    await anularPagoGrupo(anulado.grupoPagoId, "Se registró por error en la prueba", db.userId);
  });

  it("ADMIN: vista COMPLETA con etiquetas, columna PAGO/ABONOS, registro por transferencia y totales que cuadran", async (ctx) => {
    const db = ensureDb(ctx);
    const e = await getEstadoCuentaProveedor(db.almacargaClienteId, "ADMIN");
    expect(e.vista).toBe("COMPLETA");
    expect(e.empresa.esProveedor).toBe(true);
    expect(e.fichas.map((f) => f.id)).toContain(db.almacargaBeneficiarioId);

    const porId = new Map(e.facturas.map((f) => [f.id, f]));
    const pagada = porId.get(fPagada)!;
    expect(pagada.etiqueta).toBe("Pagada");
    expect(pagada.saldo).toBe("0");
    expect(pagada.fechaPago).toBe("3003-09-15");
    expect(pagada.abonos).toEqual([]);
    expect(pagada.marca).toBe("IM054-26 SRF");
    expect(pagada.pagos[0]?.comprobante?.tramiteId).toBe(tA);

    const abonada = porId.get(fAbonada)!;
    expect(abonada.etiqueta).toBe("Abonada");
    expect(abonada.saldo).toBe("200000");
    expect(abonada.fechaPago).toBeNull(); // PAGO vacío mientras haya saldo (el SUMIFS del Excel)
    expect(abonada.abonos).toEqual([{ fecha: "3003-09-16", monto: "100000" }]);

    const pendiente = porId.get(fPendiente)!;
    expect(pendiente.etiqueta).toBe("Pendiente");
    expect(pendiente.pagable).toBe(true);

    // Resumen del proveedor (I1): facturado = pagado + ajustado + cruzado + pendiente.
    const r = e.resumen!;
    const [facturado, pagado, ajustado, cruzado, pend] = [r.facturado, r.pagado, r.ajustado, r.cruzado, r.pendiente].map(BigInt);
    expect(facturado).toBe(pagado + ajustado + cruzado + pend);
    const soloEstas = e.facturas.filter((f) => [fPagada, fAbonada, fPendiente].includes(f.id));
    expect(soloEstas.reduce((s, f) => s + BigInt(f.saldo), 0n)).toBe(661_377n);
    expect(BigInt(r.pagadoSinFactura) >= 7_000n).toBe(true);

    // Registro de pagos: el bloque activo es UNA fila; el anulado sigue ahí con su motivo.
    const bloques = e.pagos.filter((p) => p.tipo === "BLOQUE");
    const activo = bloques.find((p) => p.facturas.some((f) => f.facturaId === fPagada))!;
    expect(activo.estado).toBe("ACTIVO");
    expect(activo.valor).toBe("433361");
    expect(activo.costoBancario).toBe("3900");
    expect(activo.fecha).toBe("3003-09-15");
    const anulado = bloques.find((p) => p.facturas.some((f) => f.facturaId === fPendiente))!;
    expect(anulado.estado).toBe("ANULADO");
    expect(anulado.anulacion?.motivo).toBe("Se registró por error en la prueba");
    expect(anulado.valor).toBe("461377");
    const sueltoSinFactura = e.pagos.find((p) => p.tipo === "SUELTO" && p.concepto === "Pago a Almacarga sin factura")!;
    expect(sueltoSinFactura.sinFactura).toBe("7000");
  });

  it("REVISOR ve lo mismo que ADMIN (solo lectura); OPERATIVO solo las facturas con saldo, sin totales ni registro (D-6)", async (ctx) => {
    const db = ensureDb(ctx);
    const admin = await getEstadoCuentaProveedor(db.almacargaClienteId, "ADMIN");
    const revisor = await getEstadoCuentaProveedor(db.almacargaClienteId, "REVISOR");
    expect(revisor).toEqual(admin);

    const operativo = await getEstadoCuentaProveedor(db.almacargaClienteId, "OPERATIVO");
    expect(operativo.vista).toBe("SOLO_PENDIENTES");
    expect(operativo.resumen).toBeNull();
    expect(operativo.pagos).toEqual([]);
    expect(operativo.facturas.every((f) => BigInt(f.saldo) > 0n)).toBe(true);
    expect(operativo.facturas.some((f) => f.id === fPagada)).toBe(false);
    expect(operativo.facturas.some((f) => f.id === fAbonada)).toBe(true);
  });

  it("/pagos filtrado por proveedor da la misma cifra que la ficha y lista los pagos por unión (ficha ∪ puente)", async (ctx) => {
    const db = ensureDb(ctx);
    const ficha = await getEstadoCuentaProveedor(db.almacargaClienteId, "ADMIN");
    const global = await listarPagosGlobal({ proveedorEmpresaId: db.almacargaClienteId });
    expect(global.resumenProveedor?.pendiente.toString()).toBe(ficha.resumen?.pendiente);
    expect(global.resumenProveedor?.facturado.toString()).toBe(ficha.resumen?.facturado);
    expect(global.pagos.some((p) => p.tramiteId === tA && p.esBloque)).toBe(true);
    expect(global.pagos.every((p) => p.tieneFacturas || p.beneficiarios.length > 0)).toBe(true);

    const r = await resumenPorProveedor({ beneficiarioId: db.almacargaBeneficiarioId });
    expect(r?.resumen.pendiente.toString()).toBe(ficha.resumen?.pendiente);
  });

  it("fichas con el mismo NIT base son el mismo proveedor: el bloque de una paga la factura de la otra", async (ctx) => {
    const db = ensureDb(ctx);
    const cuentaA = await prisma.beneficiario.create({ data: { nombre: "PROVEEDOR NIT (cuenta A)", nit: `${nitHermanas}-1` } });
    const cuentaB = await prisma.beneficiario.create({ data: { nombre: "PROVEEDOR NIT (cuenta B)", nit: nitHermanas } });
    const t = await crearTramiteTest(db);
    await aplicarAnticipoTest(db, t, 500_000n);
    const factura = await crearFacturaAlmacargaTest(db, t, "FE-660201", 90_000n, cuentaB.id);

    const elegiblesA = await listarFacturasElegiblesMultiDO(cuentaA.id);
    expect(elegiblesA.map((f) => f.id)).toEqual([factura]);

    await crearPagoMultiDO({
      beneficiarioId: cuentaA.id,
      facturas: [{ facturaProveedorId: factura, monto: 90_000n }],
      canalPago: CanalPago.PSE,
      documentoId: await crearDocumentoTest(db, t),
      usuarioId: db.userId,
    });
    expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: factura } })).estado).toBe("PAGADA");
  });

  it("fichasDeEmpresa: suma la ficha suelta con su NIT base, pero nunca la de OTRA empresa con la misma base", async (ctx) => {
    ensureDb(ctx);
    const empresaA = await prisma.cliente.create({
      data: { nombre: "EMPRESA A (base compartida)", nit: nitCompartido, tipo: "PROPIO", esCliente: false, esProveedor: true },
    });
    const empresaB = await prisma.cliente.create({
      data: { nombre: "EMPRESA B (base compartida)", nit: `${nitCompartido}-4`, tipo: "PROPIO", esCliente: false, esProveedor: true },
    });
    const deA = await prisma.beneficiario.create({ data: { nombre: "A cuenta 1", nit: `${nitCompartido}-1`, empresaId: empresaA.id } });
    const suelta = await prisma.beneficiario.create({ data: { nombre: "Ficha suelta", nit: nitCompartido } });
    const deB = await prisma.beneficiario.create({ data: { nombre: "B cuenta 1", nit: `${nitCompartido}-2`, empresaId: empresaB.id } });

    const fichasA = (await fichasDeEmpresa(prisma, empresaA.id, empresaA.nit)).map((f) => f.id);
    expect(fichasA.sort()).toEqual([deA.id, suelta.id].sort());
    const fichasB = (await fichasDeEmpresa(prisma, empresaB.id, empresaB.nit)).map((f) => f.id);
    expect(fichasB).toContain(deB.id);
    expect(fichasB).not.toContain(deA.id);

    // El estado de cuenta de A lista las mismas fichas.
    const e = await getEstadoCuentaProveedor(empresaA.id, "ADMIN");
    expect(e.fichas.map((f) => f.id).sort()).toEqual([deA.id, suelta.id].sort());
  });
});
