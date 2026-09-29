/**
 * Fixtures del caso Almacarga (CxP proveedor) — extraídos TAL CUAL de
 * `src/lib/pagos/__tests__/cxp-proveedor-almacarga.test.ts` (CxP v2, P0) para
 * compartirlos con `src/lib/facturas-proveedor/__tests__/cxp-facturas-almacarga.test.ts`.
 *
 * CONGELADO después de P0: si P1/P2 necesitan otro helper, lo escriben en su
 * propio archivo de prueba (diseño §G). Único cambio de comportamiento frente
 * al original: `cleanupTestData` también borra las cabeceras `PagoGrupo`
 * (tabla nueva de CxP v2) que crean los pagos en bloque de prueba.
 *
 * Uso en un archivo de prueba:
 *   beforeAll(prepararBdAlmacarga); afterAll(liberarBdAlmacarga);
 *   const db = ensureDb(ctx);
 * Vitest aísla los módulos por archivo: cada archivo tiene su propio `runId`
 * y su propio estado.
 */
import {
  AgenciaAduanas,
  CategoriaDocumento,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Rol,
  TipoCliente,
  TipoRecaudo,
} from "@prisma/client";

import { crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";
import { listarFacturasElegiblesMultiDO } from "@/lib/pagos/service";

// ─── Constantes del test ─────────────────────────────────────────────────────

export const TEST_PREFIX = "vitest-cxp-almacarga";
export const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const stateYear = 3003;

// ─── Fixture ─────────────────────────────────────────────────────────────────

export type Fixture = {
  userId: string;
  litoplasId: string;
  almacargaClienteId: string;
  almacargaBeneficiarioId: string;
  expressClienteId: string;
  expressBeneficiarioId: string;
  tampaBeneficiarioId: string;
  vuceBeneficiarioId: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let numeroDo = 0;

export function siguienteNumero(): number {
  numeroDo += 1;
  return numeroDo;
}

export function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanupTestData() {
  const testUsers = await prisma.user.findMany({
    where: { email: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const testClients = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });

  const userIds = testUsers.map((u) => u.id);
  const clienteIds = testClients.map((c) => c.id);

  const testTramites = await prisma.tramiteDO.findMany({
    where: {
      OR: [
        { creadoPorId: { in: userIds } },
        { clienteId: { in: clienteIds } },
        { comentarios: { startsWith: TEST_PREFIX } },
      ],
    },
    select: { id: true },
  });
  const tramiteIds = testTramites.map((t) => t.id);

  // Orden respetando FK constraints (mismo patrón que pagos/__tests__/service.test.ts,
  // extendido con BorradorFactura/LineaRevision para CA-11/CA-28).
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
      ],
    },
  });

  // BorradorFactura → cascada LineaRevision → cascada LineaRevisionFactura.
  // Debe ir ANTES de borrar FacturaProveedor (LineaRevisionFactura.facturaId
  // es Restrict).
  await prisma.borradorFactura.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });

  await prisma.aplicacionAnticipo.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoTramiteFactura.deleteMany({
    where: { pago: { tramiteId: { in: tramiteIds } } },
  });
  await prisma.facturaProveedor.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  // CxP v2 (P0): los bloques de prueba crean cabecera PagoGrupo; se borra
  // después de sus PagoTramite (FK pago_tramite.grupoPagoId → pago_grupo).
  const gruposDePrueba = await prisma.pagoTramite.findMany({
    where: { tramiteId: { in: tramiteIds }, grupoPagoId: { not: null } },
    select: { grupoPagoId: true },
  });
  await prisma.pagoTramite.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.pagoGrupo.deleteMany({
    where: {
      OR: [
        { id: { in: gruposDePrueba.flatMap((g) => (g.grupoPagoId ? [g.grupoPagoId] : [])) } },
        { creadoPorId: { in: userIds } },
      ],
    },
  });

  const testAnticipos = await prisma.anticipo.findMany({
    where: { clienteId: { in: clienteIds } },
    select: { id: true },
  });
  const anticipoIds = testAnticipos.map((a) => a.id);
  await prisma.aplicacionAnticipo.deleteMany({
    where: { anticipoId: { in: anticipoIds } },
  });
  await prisma.anticipo.deleteMany({
    where: { id: { in: anticipoIds } },
  });

  await prisma.empresaCapacidad.deleteMany({
    where: { empresaId: { in: clienteIds } },
  });
  await prisma.checklistItem.deleteMany({
    where: { tramiteId: { in: tramiteIds } },
  });
  await prisma.tramiteDO.deleteMany({
    where: { id: { in: tramiteIds } },
  });
  // Beneficiarios de prueba (ficha de pago de Almacarga/Express/Tampa/VUCE) —
  // el pivot pago_tramite_beneficiario ya se borró en cascada arriba. Fase 3:
  // la FK ficha → empresa es Restrict, así que las fichas se borran ANTES que
  // los clientes (también las que cuelgan de una empresa de prueba aunque su
  // NIT no lleve el prefijo).
  await prisma.beneficiario.deleteMany({
    where: {
      OR: [{ nit: { startsWith: TEST_PREFIX } }, { empresaId: { in: clienteIds } }],
    },
  });
  await prisma.cliente.deleteMany({
    where: { id: { in: clienteIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: userIds } },
  });
}

export async function createFixture(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: {
      email: `${runId}@example.test`,
      emailVerified: true,
      name: "Vitest CxP Almacarga",
      rol: Rol.ADMIN,
    },
  });

  const litoplas = await prisma.cliente.create({
    data: {
      nombre: "LITOPLAS SA",
      nit: `${TEST_PREFIX}-litoplas-${runId}`,
      tipo: TipoCliente.PROPIO,
      esCliente: true,
      esProveedor: false,
    },
  });

  const almacarga = await prisma.cliente.create({
    data: {
      nombre: `ALMACENADORA DE CARGA "ALMACARGA" S.A.S`,
      nit: `${TEST_PREFIX}-almacarga-${runId}`,
      tipo: TipoCliente.PROPIO,
      esCliente: false,
      esProveedor: true,
    },
  });
  const almacargaBeneficiario = await prisma.beneficiario.create({
    data: {
      nombre: "ALMACARGA",
      nit: `${TEST_PREFIX}-ben-almacarga-${runId}`,
      empresaId: almacarga.id,
    },
  });

  const express = await prisma.cliente.create({
    data: {
      nombre: "CW EXPRESS LOGISTICA",
      nit: `${TEST_PREFIX}-express-${runId}`,
      tipo: TipoCliente.PROPIO,
      esCliente: false,
      esProveedor: true,
    },
  });
  const expressBeneficiario = await prisma.beneficiario.create({
    data: {
      nombre: "EXPRESS LOGISTICA",
      nit: `${TEST_PREFIX}-ben-express-${runId}`,
      empresaId: express.id,
    },
  });

  // Tampa Cargo y VUCE: fichas de OTRAS empresas proveedoras (una empresa
  // solo-proveedora propia cada una; fase 3: toda ficha tiene empresa) — son
  // quienes reciben los pagos reales de flete/trámite en DO.BAQ26-0069/0226,
  // ajenos a Almacarga (usados en CA-10 y en el caso real para bajar el saldo
  // del DO sin tocar la cartera de Almacarga). El NIT de la empresa lleva el
  // prefijo de prueba: `cleanupTestData` la borra con el resto.
  const tampa = await crearFichaConEmpresaTest({ nombre: "TAMPA CARGO", nit: `${TEST_PREFIX}-ben-tampa-${runId}` });
  const vuce = await crearFichaConEmpresaTest({ nombre: "VUCE", nit: `${TEST_PREFIX}-ben-vuce-${runId}` });

  return {
    userId: user.id,
    litoplasId: litoplas.id,
    almacargaClienteId: almacarga.id,
    almacargaBeneficiarioId: almacargaBeneficiario.id,
    expressClienteId: express.id,
    expressBeneficiarioId: expressBeneficiario.id,
    tampaBeneficiarioId: tampa.id,
    vuceBeneficiarioId: vuce.id,
  };
}

export function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(
      dbUnavailableReason ??
        "BD local Postgres no disponible para tests de CxP proveedor Almacarga",
    );
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

/** Crea un TramiteDO directo en BD para Litoplas (o el cliente que se pase). */
export async function crearTramiteTest(
  db: Fixture,
  opts: { clienteId?: string; estado?: EstadoTramite } = {},
): Promise<string> {
  const numero = siguienteNumero();
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BAQ${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BAQ,
      anio: stateYear,
      numero,
      clienteId: opts.clienteId ?? fixture!.litoplasId,
      agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
      creadoPorId: db.userId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: opts.estado ?? EstadoTramite.EN_TRAMITE,
    },
  });
  return tramite.id;
}

export async function aplicarAnticipoTest(
  db: Fixture,
  tramiteId: string,
  monto: bigint,
): Promise<void> {
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: fixture!.litoplasId,
      monto,
      fecha: new Date(`${stateYear}-01-10`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 1_950n,
      verificadoBanco: true,
    },
  });
  await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId, montoAplicado: monto },
  });
}

export async function crearFacturaAlmacargaTest(
  db: Fixture,
  tramiteId: string,
  numFactura: string,
  valor: bigint,
  beneficiarioId: string = fixture!.almacargaBeneficiarioId,
): Promise<string> {
  const factura = await crearFacturaProveedor({
    tramiteId,
    proveedorNombre: "ALMACARGA",
    beneficiarioId,
    numFactura,
    valor,
    fecha: new Date(`${stateYear}-02-01`),
    repercutible: true,
    subidaPorId: db.userId,
  });
  return factura.id;
}

export async function crearDocumentoTest(
  db: Fixture,
  tramiteId: string,
  categoria: CategoriaDocumento = CategoriaDocumento.COMPROBANTE_BANCARIO,
): Promise<string> {
  const doc = await prisma.documento.create({
    data: {
      tramiteId,
      categoria,
      nombreArchivo: "comprobante-vitest-cxp.pdf",
      storageKey: `vitest/${runId}/${Math.random().toString(36).slice(2)}.pdf`,
      mimeType: "application/pdf",
      tamanoBytes: 1024,
      subidoPorId: db.userId,
    },
  });
  return doc.id;
}

/**
 * Simula "la factura ya salió en la factura de venta de Litoplas": crea un
 * BorradorFactura FACTURADO con una LineaRevision TERCEROS enlazada a la
 * factura de proveedor vía LineaRevisionFactura — el mecanismo real que usa
 * `formato-conceptos.ts` (lineasTercerosDesdeFacturas), sin pasar por
 * `generarBorrador` completo (fuera de alcance de este archivo).
 */
export async function crearBorradorFacturadoConLinea(
  tramiteId: string,
  facturaId: string,
  valor: bigint,
  numSiigo: string,
): Promise<string> {
  const borrador = await prisma.borradorFactura.create({
    data: {
      tramiteId,
      comision: 0n,
      ivaComision: 0n,
      impuesto4x1000: 0n,
      costosBancarios: 0n,
      totalAnticipo: valor,
      totalPagos: 0n,
      totalFactura: valor,
      estado: EstadoBorrador.FACTURADO,
      numFacturaSiigo: numSiigo,
      fechaFactura: new Date(`${stateYear}-03-01`),
    },
  });
  const linea = await prisma.lineaRevision.create({
    data: {
      borradorId: borrador.id,
      concepto: `ALMACENAJE ALMACARGA FACT. ${numSiigo}`,
      valor,
      seccion: "TERCEROS",
      origen: "AUTO",
      aprobada: true,
    },
  });
  await prisma.lineaRevisionFactura.create({
    data: { lineaId: linea.id, facturaId },
  });
  return borrador.id;
}

export async function pendienteAlmacarga(): Promise<bigint> {
  const facturas = await listarFacturasElegiblesMultiDO(
    fixture!.almacargaBeneficiarioId,
  );
  return facturas.reduce((sum, f) => sum + f.valor, 0n);
}

// ─── Setup / Teardown compartidos ────────────────────────────────────────────

/** Cuerpo del `beforeAll` original: limpia restos y crea el fixture (o deja el motivo del skip). */
export async function prepararBdAlmacarga(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason =
      "DATABASE_URL no está definida; se omiten los tests de CxP proveedor Almacarga";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
    await cleanupTestData();
    fixture = await createFixture();
  } catch (error) {
    dbUnavailableReason = `BD local Postgres no disponible: ${unavailableMessage(error)}`;
  }
}

/** Cuerpo del `afterAll` original. */
export async function liberarBdAlmacarga(): Promise<void> {
  if (dbConnected) {
    await cleanupTestData();
  }
  await prisma.$disconnect();
}
