/**
 * Tests de "Devolver borrador con observación".
 *
 * La parte pura (mapa de transiciones, armado de textos) corre siempre.
 * La parte de integración requiere PostgreSQL local en :5433 con DATABASE_URL
 * definida; si la BD no está, esos tests se omiten (skip).
 *
 * TEST_PREFIX único: "vitest-devolver". Año de datos de prueba: 3011.
 */
import "dotenv/config";

import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Rol,
  SiigoEnvioEstado,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { ENTIDAD_AUDIT_NOTIFICACION } from "@/lib/notificaciones/whatsapp";

import { generarBorrador, transicionarBorrador, TRANSICIONES_DEVOLUCION } from "../service";
import {
  BorradorNoDevolvibleError,
  BorradorYaEnSiigoError,
  ObservacionInvalidaError,
  PREFIJO_DEVOLUCION,
  RolNoPuedeDevolverError,
  construirMensajeDevolucion,
  construirObservacionDevolucion,
  devolverBorrador,
  esObservacionDevolucion,
} from "../devolver";

const TEST_PREFIX = "vitest-devolver";
const runId = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const stateYear = 3011;

type Fixture = {
  clienteId: string;
  adminId: string;
  revisorId: string;
};

let fixture: Fixture | null = null;
let dbUnavailableReason: string | null = null;
let dbConnected = false;
let tramiteCounter = 0;

function unavailableMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupTestData() {
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

  const borradores = await prisma.borradorFactura.findMany({
    where: { tramiteId: { in: tramiteIds } },
    select: { id: true },
  });
  const borradorIds = borradores.map((b) => b.id);

  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { usuarioId: { in: userIds } },
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: tramiteIds } },
        { entidadId: { in: borradorIds } },
      ],
    },
  });
  await prisma.factura.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.pagoTramite.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.facturaProveedor.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createFixture(): Promise<Fixture> {
  const admin = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin-${runId}@example.test`,
      emailVerified: true,
      name: "Vitest Devolver Admin",
      rol: Rol.ADMIN,
    },
  });
  const revisor = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-revisor-${runId}@example.test`,
      emailVerified: true,
      name: "Guillermo Revisor",
      rol: Rol.REVISOR,
    },
  });
  const cliente = await prisma.cliente.create({
    data: {
      nombre: "Cliente Devolución",
      nit: `${TEST_PREFIX}-cli-${runId}`,
      tipo: TipoCliente.PROPIO,
    },
  });
  return { clienteId: cliente.id, adminId: admin.id, revisorId: revisor.id };
}

async function crearTramite(db: Fixture): Promise<{ id: string; consecutivo: string }> {
  tramiteCounter++;
  const numero = tramiteCounter;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.BUN${String(stateYear).slice(-2)}-${String(numero).padStart(4, "0")}-${runId}`,
      ciudad: Ciudad.BUN,
      anio: stateYear,
      numero,
      clienteId: db.clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: db.adminId,
      comentarios: `${TEST_PREFIX}:${runId}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
    },
  });
  return { id: tramite.id, consecutivo: tramite.consecutivo };
}

/** Borrador nuevo llevado hasta `estado` por el camino normal. */
async function crearBorradorEn(
  db: Fixture,
  estado: EstadoBorrador,
): Promise<{ borradorId: string; tramiteId: string; consecutivo: string }> {
  const tramite = await crearTramite(db);
  const borrador = await generarBorrador({
    tramiteId: tramite.id,
    comision: 150_000n,
    ivaComision: 28_500n,
    usuarioId: db.adminId,
  });
  const borradorId = borrador!.id;

  if (estado === EstadoBorrador.BORRADOR) {
    return { borradorId, tramiteId: tramite.id, consecutivo: tramite.consecutivo };
  }

  await transicionarBorrador({
    borradorId,
    nuevoEstado: EstadoBorrador.EN_REVISION,
    usuarioId: db.adminId,
  });

  if (estado !== EstadoBorrador.EN_REVISION) {
    await transicionarBorrador({
      borradorId,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: db.revisorId,
    });
  }

  if (estado === EstadoBorrador.FACTURADO) {
    await transicionarBorrador({
      borradorId,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: db.adminId,
      numFacturaSiigo: `BAQ-${String(tramiteCounter).padStart(5, "0")}`,
      fechaFactura: new Date(`${stateYear}-03-01`),
    });
  }

  return { borradorId, tramiteId: tramite.id, consecutivo: tramite.consecutivo };
}

/** Espera a que aparezca el AuditLog del aviso (se escribe fire-and-forget). */
async function esperarAuditNotificacion(borradorId: string, intentos = 30) {
  for (let i = 0; i < intentos; i++) {
    const log = await prisma.auditLog.findFirst({
      where: { entidad: ENTIDAD_AUDIT_NOTIFICACION, entidadId: borradorId },
    });
    if (log) return log;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function ensureDb(ctx: { skip: (note?: string) => void }): Fixture {
  if (!fixture) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible para tests de devolución");
    throw new Error("Test omitido porque la BD local no está disponible");
  }
  return fixture;
}

// ─── Parte pura (no necesita BD) ──────────────────────────────────────────────

describe("devolver — mapa de estados y textos (puro)", () => {
  it("solo EN_REVISION y APROBADO vuelven a BORRADOR", () => {
    expect(TRANSICIONES_DEVOLUCION[EstadoBorrador.EN_REVISION]).toBe(EstadoBorrador.BORRADOR);
    expect(TRANSICIONES_DEVOLUCION[EstadoBorrador.APROBADO]).toBe(EstadoBorrador.BORRADOR);
    expect(TRANSICIONES_DEVOLUCION[EstadoBorrador.BORRADOR]).toBeNull();
    expect(TRANSICIONES_DEVOLUCION[EstadoBorrador.FACTURADO]).toBeNull();
  });

  it("la observación lleva el prefijo, el nombre y la fecha", () => {
    const linea = construirObservacionDevolucion(
      "Guillermo",
      "  Falta el BL del contenedor  ",
      new Date("3011-03-05T15:00:00.000Z"),
    );
    expect(linea).toBe("DEVUELTO POR Guillermo (05/03/3011): Falta el BL del contenedor");
    expect(linea.startsWith(PREFIJO_DEVOLUCION)).toBe(true);
  });

  it("esObservacionDevolucion distingue la nota interna de un comentario de cabecera", () => {
    expect(esObservacionDevolucion("DEVUELTO POR Guillermo (05/03/3011): revisar")).toBe(true);
    expect(esObservacionDevolucion("   DEVUELTO POR Camila (05/03/3011): ojo")).toBe(true);
    expect(esObservacionDevolucion("NO PRACTICAR RETEFUENTE NI RETEICA")).toBe(false);
    expect(esObservacionDevolucion("DO.BAQ26-0001 / BL 123")).toBe(false);
  });

  it("el mensaje de WhatsApp usa el consecutivo tal cual y enlaza al trámite", () => {
    const anterior = process.env.APP_URL;
    process.env.APP_URL = "https://galcomex.example/";
    try {
      const mensaje = construirMensajeDevolucion({
        usuarioId: "u1",
        nombreUsuario: "Guillermo",
        borradorId: "b1",
        tramiteId: "t1",
        consecutivo: "DO.BAQ26-0001",
        cliente: "Litoplas S.A.",
        observacion: "Falta el BL",
      });
      expect(mensaje).toBe(
        "Galcomex: Guillermo devolvió el borrador del DO.BAQ26-0001 (Litoplas S.A.) " +
          "con observación: Falta el BL. Revísalo en https://galcomex.example/tramites/t1",
      );
    } finally {
      if (anterior === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = anterior;
    }
  });
});

// ─── Integración ──────────────────────────────────────────────────────────────

describe("devolverBorrador con Postgres local", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      dbUnavailableReason = "DATABASE_URL no está definida; se omiten tests de integración";
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
  });

  afterAll(async () => {
    if (dbConnected) {
      await cleanupTestData();
    }
    await prisma.$disconnect();
  });

  it("REVISOR devuelve desde EN_REVISION: vuelve a BORRADOR y guarda la observación", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId, consecutivo } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    const resultado = await devolverBorrador({
      borradorId,
      usuarioId: db.revisorId,
      rol: "REVISOR",
      observacion: "El almacenaje no coincide con la factura del proveedor",
    });

    expect(resultado.borrador?.estado).toBe(EstadoBorrador.BORRADOR);
    expect(resultado.consecutivo).toBe(consecutivo);
    expect(resultado.observacion).toContain(PREFIJO_DEVOLUCION);
    expect(resultado.observacion).toContain("Guillermo Revisor");
    expect(resultado.observacion).toContain(
      "El almacenaje no coincide con la factura del proveedor",
    );

    // La observación queda visible en la ficha (comentariosCabecera).
    const comentarios = resultado.borrador!.comentariosCabecera as unknown[];
    expect(Array.isArray(comentarios)).toBe(true);
    expect(comentarios.at(-1)).toBe(resultado.observacion);
  });

  it("deja AuditLog DEVOLVER con snapshot antes/después", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    await devolverBorrador({
      borradorId,
      usuarioId: db.revisorId,
      rol: "REVISOR",
      observacion: "Revisar el 4x1000",
    });

    const log = await prisma.auditLog.findFirst({
      where: { entidad: "BorradorFactura", entidadId: borradorId, accion: "DEVOLVER" },
    });
    expect(log).not.toBeNull();
    expect(log!.usuarioId).toBe(db.revisorId);

    const antes = log!.antes as Record<string, unknown>;
    const despues = log!.despues as Record<string, unknown>;
    expect(antes.estado).toBe(EstadoBorrador.EN_REVISION);
    expect(despues.estado).toBe(EstadoBorrador.BORRADOR);
    expect(String(despues.observacion)).toContain(PREFIJO_DEVOLUCION);
    expect((antes.comentariosCabecera as unknown[]).length).toBe(
      (despues.comentariosCabecera as unknown[]).length - 1,
    );
  });

  it("registra el intento de aviso por WhatsApp en AuditLog (entidad Notificacion)", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    await devolverBorrador({
      borradorId,
      usuarioId: db.revisorId,
      rol: "REVISOR",
      observacion: "Avisar a Camila por favor",
    });

    const log = await esperarAuditNotificacion(borradorId);
    expect(log).not.toBeNull();
    expect(log!.accion).toBe("NOTIFICAR_WHATSAPP");
    const despues = log!.despues as Record<string, unknown>;
    expect(despues.canal).toBe("WHATSAPP");
    expect(despues.evento).toBe("borrador_devuelto");
    expect(typeof despues.enviado).toBe("boolean");
  });

  it("ADMIN devuelve desde APROBADO: retira la aprobación", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.APROBADO);

    const antes = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borradorId },
      select: { aprobadoPorId: true, fechaAprobacion: true },
    });
    expect(antes.aprobadoPorId).toBe(db.revisorId);
    expect(antes.fechaAprobacion).not.toBeNull();

    const resultado = await devolverBorrador({
      borradorId,
      usuarioId: db.adminId,
      rol: "ADMIN",
      observacion: "Me equivoqué al aprobar, falta una línea",
    });

    expect(resultado.borrador?.estado).toBe(EstadoBorrador.BORRADOR);
    expect(resultado.borrador?.aprobadoPorId).toBeNull();
    expect(resultado.borrador?.fechaAprobacion).toBeNull();
  });

  it("un borrador FACTURADO no se puede devolver: 422 con el consecutivo del DO", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId, consecutivo } = await crearBorradorEn(db, EstadoBorrador.FACTURADO);

    let capturado: unknown = null;
    try {
      await devolverBorrador({
        borradorId,
        usuarioId: db.adminId,
        rol: "ADMIN",
        observacion: "Esto ya se facturó por error",
      });
    } catch (error) {
      capturado = error;
    }

    expect(capturado).toBeInstanceOf(BorradorNoDevolvibleError);
    const error = capturado as BorradorNoDevolvibleError;
    expect(error.status).toBe(422);
    // El mensaje habla del consecutivo del DO, nunca del id interno.
    expect(error.message).toContain(consecutivo);
    expect(error.message).not.toContain(borradorId);
  });

  it("un borrador APROBADO que ya salió a Siigo (o está sin confirmar) no se puede devolver: 409", async (ctx) => {
    const db = ensureDb(ctx);
    for (const datosSiigo of [
      { siigoDraftId: "siigo-draft-1", siigoEnvioEstado: SiigoEnvioEstado.ENVIADO },
      { siigoDraftId: null, siigoEnvioEstado: SiigoEnvioEstado.INCIERTO },
      { siigoDraftId: null, siigoEnvioEstado: SiigoEnvioEstado.ENVIANDO },
    ]) {
      const { borradorId, consecutivo } = await crearBorradorEn(db, EstadoBorrador.APROBADO);
      await prisma.borradorFactura.update({ where: { id: borradorId }, data: datosSiigo });

      const intento = devolverBorrador({
        borradorId,
        usuarioId: db.adminId,
        rol: "ADMIN",
        observacion: "Corregir el valor de la comisión",
      });
      await expect(intento).rejects.toBeInstanceOf(BorradorYaEnSiigoError);
      await expect(intento).rejects.toMatchObject({ status: 409 });

      const sinCambios = await prisma.borradorFactura.findUniqueOrThrow({
        where: { id: borradorId },
        select: { estado: true },
      });
      expect(sinCambios.estado).toBe(EstadoBorrador.APROBADO);
      expect(consecutivo).toBeTruthy();
    }
  });

  it("un borrador APROBADO que Siigo rechazó (ERROR) sí se puede devolver para corregirlo", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.APROBADO);
    await prisma.borradorFactura.update({
      where: { id: borradorId },
      data: { siigoEnvioEstado: SiigoEnvioEstado.ERROR },
    });

    const resultado = await devolverBorrador({
      borradorId,
      usuarioId: db.adminId,
      rol: "ADMIN",
      observacion: "Siigo rechazó el NIT, corregir",
    });
    expect(resultado.borrador?.estado).toBe(EstadoBorrador.BORRADOR);
  });

  it("un borrador que ya está en BORRADOR no se puede devolver", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId, consecutivo } = await crearBorradorEn(db, EstadoBorrador.BORRADOR);

    await expect(
      devolverBorrador({
        borradorId,
        usuarioId: db.revisorId,
        rol: "REVISOR",
        observacion: "Nada que devolver",
      }),
    ).rejects.toThrow(new RegExp(`${consecutivo}.*BORRADOR`));
  });

  it("OPERATIVO y SOCIO no pueden devolver (403) y no tocan el borrador", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    for (const rol of ["OPERATIVO", "SOCIO"] as const) {
      await expect(
        devolverBorrador({
          borradorId,
          usuarioId: db.adminId,
          rol,
          observacion: "Intento no autorizado",
        }),
      ).rejects.toBeInstanceOf(RolNoPuedeDevolverError);
    }

    const sinCambios = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borradorId },
      select: { estado: true },
    });
    expect(sinCambios.estado).toBe(EstadoBorrador.EN_REVISION);
  });

  it("una observación de menos de 5 caracteres se rechaza (422)", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    await expect(
      devolverBorrador({
        borradorId,
        usuarioId: db.revisorId,
        rol: "REVISOR",
        observacion: "  ojo ",
      }),
    ).rejects.toBeInstanceOf(ObservacionInvalidaError);

    const sinCambios = await prisma.borradorFactura.findUniqueOrThrow({
      where: { id: borradorId },
      select: { estado: true },
    });
    expect(sinCambios.estado).toBe(EstadoBorrador.EN_REVISION);
  });

  it("dos devoluciones seguidas acumulan las observaciones en orden", async (ctx) => {
    const db = ensureDb(ctx);
    const { borradorId } = await crearBorradorEn(db, EstadoBorrador.EN_REVISION);

    await devolverBorrador({
      borradorId,
      usuarioId: db.revisorId,
      rol: "REVISOR",
      observacion: "Primera observación del revisor",
    });

    await transicionarBorrador({
      borradorId,
      nuevoEstado: EstadoBorrador.EN_REVISION,
      usuarioId: db.adminId,
    });

    const segunda = await devolverBorrador({
      borradorId,
      usuarioId: db.revisorId,
      rol: "REVISOR",
      observacion: "Segunda observación del revisor",
    });

    const comentarios = (segunda.borrador!.comentariosCabecera as unknown[]).filter(
      (c): c is string => typeof c === "string",
    );
    const devoluciones = comentarios.filter(esObservacionDevolucion);
    expect(devoluciones).toHaveLength(2);
    expect(devoluciones[0]).toContain("Primera observación del revisor");
    expect(devoluciones[1]).toContain("Segunda observación del revisor");
  });
});
