/**
 * Requisitos del DO contra Postgres local (revisión de Ernesto, 22-sep-2026):
 *
 *   D1 · `do_exige_tarifa_vigente` — sin tarifa VIGENTE hoy para la línea de
 *        servicio no se crea el DO; la solicitud pública entra pero no se abre.
 *   D2 · `docs_bl_factura_obligatorios` — APERTURA → EN_TRAMITE exige BL y
 *        factura comercial (documentos no eliminados); el ADMIN puede forzarlo
 *        y queda un AuditLog `OMITIR_REQUISITOS`.
 *
 * Se omite solo si no hay BD (mismo patrón que el resto de integración).
 */

import "dotenv/config";

import {
  AgenciaAduanas,
  CategoriaDocumento,
  Ciudad,
  EstadoTarifario,
  EstadoTramite,
  Prisma,
  Rol,
  TipoCliente,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { definicionDe } from "@/lib/capacidades/catalogo";
import { prisma } from "@/lib/db/prisma";
import {
  createTramite,
  TarifaVigenteRequeridaError,
  transitionTramite,
} from "@/lib/tramites/service";

const TEST_PREFIX = "vitest-requisitos-do";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 2096;
const DIA = 86_400_000;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let usuarioId = "";
let empresasCreadas = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
  }
}

type OverrideFixture = {
  codigo: string;
  habilitado: boolean;
  config?: Prisma.InputJsonValue;
};

const TARIFA_OFF: OverrideFixture = { codigo: "do_exige_tarifa_vigente", habilitado: false };
const DOCS_OFF: OverrideFixture = { codigo: "docs_bl_factura_obligatorios", habilitado: false };

async function crearEmpresa(
  capacidades: OverrideFixture[] = [],
  tipo: TipoCliente = TipoCliente.PROPIO,
) {
  empresasCreadas += 1;
  return prisma.cliente.create({
    data: {
      nombre: `EMPRESA VITEST REQUISITOS ${empresasCreadas}`,
      nit: `${RUN_ID}-${empresasCreadas}`,
      tipo,
      capacidades: { create: capacidades },
    },
  });
}

async function crearTarifario(
  empresaId: string,
  opciones: {
    alcance?: string;
    estado?: EstadoTarifario;
    desde?: Date;
    hasta?: Date;
    version?: number;
  } = {},
) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: `Tarifa vitest ${opciones.alcance ?? "TRAMITE"}`,
      alcance: opciones.alcance ?? "TRAMITE",
      estado: opciones.estado ?? EstadoTarifario.VIGENTE,
      vigenteDesde: opciones.desde ?? new Date(Date.now() - 30 * DIA),
      vigenteHasta: opciones.hasta ?? new Date(Date.now() + 30 * DIA),
      version: opciones.version ?? 1,
      creadoPorId: usuarioId,
    },
  });
}

function datosDo(clienteId: string, tipoTramiteCodigo = "IMPORTACION") {
  return {
    ciudad: Ciudad.BAQ,
    anio: ANIO,
    clienteId,
    tipoTramiteCodigo,
    agenciaAduanas: tipoTramiteCodigo === "IMPORTACION" ? AgenciaAduanas.COLDEX : undefined,
    creadoPorId: usuarioId,
    comentarios: `${TEST_PREFIX}:${RUN_ID}`,
  };
}

/** DO en APERTURA con el checklist completo: solo queda la regla de documentos. */
async function doEnApertura(clienteId: string, tipoTramiteCodigo = "IMPORTACION") {
  const tramite = await createTramite(datosDo(clienteId, tipoTramiteCodigo));
  await prisma.checklistItem.updateMany({
    where: { tramiteId: tramite.id },
    data: { recibido: true },
  });
  await prisma.tramiteDO.update({
    where: { id: tramite.id },
    data: { estado: EstadoTramite.APERTURA },
  });
  return tramite;
}

async function adjuntar(tramiteId: string, categoria: CategoriaDocumento, eliminado = false) {
  return prisma.documento.create({
    data: {
      tramiteId,
      categoria,
      nombreArchivo: `${categoria.toLowerCase()}.pdf`,
      storageKey: `tramites/${RUN_ID}/${categoria}/${Math.random().toString(36).slice(2)}.pdf`,
      mimeType: "application/pdf",
      tamanoBytes: 1024,
      eliminado,
      subidoPorId: usuarioId,
    },
  });
}

async function estadoDe(tramiteId: string) {
  const tramite = await prisma.tramiteDO.findUniqueOrThrow({
    where: { id: tramiteId },
    select: { estado: true },
  });
  return tramite.estado;
}

async function limpiar() {
  const empresas = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const empresaIds = empresas.map((e) => e.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { clienteId: { in: empresaIds } },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);

  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: empresaIds } } });
  // empresa_capacidad cae por ON DELETE CASCADE.
  await prisma.cliente.deleteMany({ where: { id: { in: empresaIds } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de requisitos del DO";
    return;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    dbUnavailableReason = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }

  const catalogo = await prisma.capacidad.count({
    where: { codigo: { in: ["do_exige_tarifa_vigente", "docs_bl_factura_obligatorios"] } },
  });
  if (catalogo < 2) {
    dbUnavailableReason =
      "Faltan las capacidades de requisitos: aplica la migración 20260923092000_capacidades_requisitos_do";
    return;
  }

  // Igual que el seed en cada arranque: el catálogo de BD refleja el del
  // código (un contenedor viejo podría haber pisado los valores por defecto).
  for (const codigo of ["do_exige_tarifa_vigente", "docs_bl_factura_obligatorios"] as const) {
    const definicion = definicionDe(codigo);
    await prisma.capacidad.update({
      where: { codigo },
      data: {
        porDefecto: definicion.porDefecto,
        configPorDefecto:
          definicion.configPorDefecto === null
            ? Prisma.DbNull
            : (definicion.configPorDefecto as Prisma.InputJsonValue),
        activa: true,
      },
    });
  }

  dbConnected = true;
  await limpiar();

  const usuario = await prisma.user.create({
    data: {
      email: `${RUN_ID}@example.test`,
      emailVerified: true,
      name: "Vitest Requisitos DO",
      rol: Rol.ADMIN,
    },
  });
  usuarioId = usuario.id;
});

afterAll(async () => {
  if (dbConnected) {
    await limpiar();
  }
  await prisma.$disconnect();
});

// ─── D1 · Crear el DO ─────────────────────────────────────────────────────────

describe("D1 · sin tarifa vigente no se crea el DO", () => {
  it("encendida por defecto: bloquea con 422, mensaje claro y detalles para la UI", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);

    const error = await createTramite(datosDo(empresa.id)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TarifaVigenteRequeridaError);
    const tarifaError = error as TarifaVigenteRequeridaError;
    expect(tarifaError.status).toBe(422);
    expect(tarifaError.codigo).toBe("TARIFA_VIGENTE_REQUERIDA");
    expect(tarifaError.message).toBe(
      `${empresa.nombre} no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.`,
    );
    expect(tarifaError.detalles).toEqual({
      clienteId: empresa.id,
      lineaServicio: "TRAMITE",
      tipoTramiteCodigo: "IMPORTACION",
    });
    expect(await prisma.tramiteDO.count({ where: { clienteId: empresa.id } })).toBe(0);
  });

  it("con tarifa VIGENTE en fecha para la línea del tipo, se crea", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    await crearTarifario(empresa.id);

    const tramite = await createTramite(datosDo(empresa.id));

    expect(tramite.estado).toBe(EstadoTramite.SOLICITUD);
  });

  it("BORRADOR y VENCIDO no cuentan como tarifa vigente", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifario(empresa.id, { estado: EstadoTarifario.BORRADOR, version: 1 });
    await crearTarifario(empresa.id, { estado: EstadoTarifario.VENCIDO, version: 2 });

    await expect(createTramite(datosDo(empresa.id))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });

  it("una tarifa VIGENTE fuera de fecha no cuenta y el mensaje dice cuándo venció o empieza", async (ctx) => {
    ensureDb(ctx);
    const vencida = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    await crearTarifario(vencida.id, {
      desde: new Date(Date.now() - 400 * DIA),
      hasta: new Date(Date.now() - 2 * DIA),
    });
    const futura = await crearEmpresa([{ codigo: "tarifario_propio", habilitado: true }]);
    await crearTarifario(futura.id, {
      desde: new Date(Date.now() + 5 * DIA),
      hasta: new Date(Date.now() + 400 * DIA),
    });

    await expect(createTramite(datosDo(vencida.id))).rejects.toThrow(/la publicada venció el \d{2}\/\d{2}\/\d{4}/);
    await expect(createTramite(datosDo(futura.id))).rejects.toThrow(
      /la publicada empieza a regir el \d{2}\/\d{2}\/\d{4}/,
    );
  });

  it("la tarifa de otra línea de servicio no sirve", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifario(empresa.id, { alcance: "CLASIFICACION" });

    await expect(createTramite(datosDo(empresa.id))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });

  it("un tipo que no está en la config de la empresa no exige tarifa", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([
      DOCS_OFF,
      {
        codigo: "do_exige_tarifa_vigente",
        habilitado: true,
        config: { tiposTramite: ["CLASIFICACION"] },
      },
    ]);

    const tramite = await createTramite(datosDo(empresa.id));

    expect(tramite.tipoTramiteCodigo).toBe("IMPORTACION");
  });

  it("empresa del socio con la función apagada (como la deja la migración): se crea sin tarifa", async (ctx) => {
    ensureDb(ctx);
    const socio = await crearEmpresa([TARIFA_OFF], TipoCliente.SOCIO_LM);

    const tramite = await createTramite(datosDo(socio.id));

    expect(tramite.clienteId).toBe(socio.id);
  });

  it("invariante 7: ser SOCIO_LM no apaga la regla; solo la capacidad decide", async (ctx) => {
    ensureDb(ctx);
    const socioSinAjuste = await crearEmpresa([], TipoCliente.SOCIO_LM);

    await expect(createTramite(datosDo(socioSinAjuste.id))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });

  it("sin tarifario propio, el mensaje pide activarlo primero", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();

    await expect(createTramite(datosDo(empresa.id))).rejects.toThrow(
      /Activa «Tarifario propio versionado» en la pestaña Funciones/,
    );
  });
});

// ─── D1 · Solicitud pública y SOLICITUD → APERTURA ────────────────────────────

describe("D1 · la solicitud pública entra, pero no se abre sin tarifa", () => {
  it("se crea en SOLICITUD y SOLICITUD → APERTURA queda bloqueado, también para el ADMIN", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);

    const solicitud = await createTramite(datosDo(empresa.id), { origen: "SOLICITUD_PUBLICA" });
    expect(solicitud.estado).toBe(EstadoTramite.SOLICITUD);

    const operativo = await transitionTramite(solicitud.id, EstadoTramite.APERTURA, usuarioId);
    expect(operativo).toMatchObject({
      ok: false,
      status: 422,
      codigo: "TARIFA_VIGENTE_REQUERIDA",
      detalles: { clienteId: empresa.id, lineaServicio: "TRAMITE", tipoTramiteCodigo: "IMPORTACION" },
    });
    if (!operativo.ok) {
      expect(operativo.message).toContain(`antes de abrir el ${solicitud.consecutivo}`);
    }

    // La excepción del ADMIN (checklist) no aplica a la tarifa: se apaga la
    // función en la ficha si de verdad hay que saltársela.
    const admin = await transitionTramite(
      solicitud.id,
      EstadoTramite.APERTURA,
      usuarioId,
      true,
      Rol.ADMIN,
    );
    expect(admin).toMatchObject({ ok: false, status: 422, codigo: "TARIFA_VIGENTE_REQUERIDA" });
    // Tampoco sirve saltar estados.
    const salto = await transitionTramite(
      solicitud.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      true,
      Rol.ADMIN,
    );
    expect(salto).toMatchObject({ ok: false, codigo: "TARIFA_VIGENTE_REQUERIDA" });
    expect(await estadoDe(solicitud.id)).toBe(EstadoTramite.SOLICITUD);

    // Publicada la tarifa, se abre.
    await crearTarifario(empresa.id);
    const abierta = await transitionTramite(solicitud.id, EstadoTramite.APERTURA, usuarioId);
    expect(abierta).toMatchObject({ ok: true, advertencias: [] });
    expect(await estadoDe(solicitud.id)).toBe(EstadoTramite.APERTURA);
  });

  it("descartar (cerrar) una solicitud sin tarifa sí se puede", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    const solicitud = await createTramite(datosDo(empresa.id), { origen: "SOLICITUD_PUBLICA" });

    const cerrada = await transitionTramite(
      solicitud.id,
      EstadoTramite.CERRADO,
      usuarioId,
      true,
      Rol.ADMIN,
    );

    expect(cerrada.ok).toBe(true);
  });
});

// ─── D2 · BL y factura comercial ──────────────────────────────────────────────

describe("D2 · APERTURA → EN_TRAMITE exige BL y factura comercial", () => {
  it("sin ninguno de los dos: 422 con la lista de lo que falta y el consecutivo", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);

    const resultado = await transitionTramite(tramite.id, EstadoTramite.EN_TRAMITE, usuarioId);

    expect(resultado).toEqual({
      ok: false,
      status: 422,
      message: `Falta el BL y la factura comercial del ${tramite.consecutivo}.`,
      codigo: "DOCUMENTOS_OBLIGATORIOS_FALTANTES",
      detalles: {
        tramiteId: tramite.id,
        consecutivo: tramite.consecutivo,
        documentosFaltantes: ["BL", "FACTURA_COMERCIAL"],
      },
    });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.APERTURA);
  });

  it("con solo el BL falta la factura; un documento eliminado no cuenta; con los dos pasa", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);

    await adjuntar(tramite.id, CategoriaDocumento.BL);
    await adjuntar(tramite.id, CategoriaDocumento.FACTURA_COMERCIAL, true);
    await adjuntar(tramite.id, CategoriaDocumento.PACKING_LIST);

    const faltaFactura = await transitionTramite(tramite.id, EstadoTramite.EN_TRAMITE, usuarioId);
    expect(faltaFactura).toMatchObject({
      ok: false,
      message: `Falta la factura comercial del ${tramite.consecutivo}.`,
      detalles: { documentosFaltantes: ["FACTURA_COMERCIAL"] },
    });

    await adjuntar(tramite.id, CategoriaDocumento.FACTURA_COMERCIAL);

    const pasa = await transitionTramite(tramite.id, EstadoTramite.EN_TRAMITE, usuarioId);
    expect(pasa).toMatchObject({ ok: true, advertencias: [] });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.EN_TRAMITE);
  });

  it("apagada en la empresa: pasa sin documentos", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF, DOCS_OFF]);
    const tramite = await doEnApertura(empresa.id);

    const resultado = await transitionTramite(tramite.id, EstadoTramite.EN_TRAMITE, usuarioId);

    expect(resultado.ok).toBe(true);
  });

  it("se configura por tipo de trámite", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([
      TARIFA_OFF,
      { codigo: "docs_bl_factura_obligatorios", habilitado: true, config: { tiposTramite: ["OTRO"] } },
    ]);

    const importacion = await doEnApertura(empresa.id, "IMPORTACION");
    const otro = await doEnApertura(empresa.id, "OTRO");

    const importacionPasa = await transitionTramite(importacion.id, EstadoTramite.EN_TRAMITE, usuarioId);
    const otroBloqueado = await transitionTramite(otro.id, EstadoTramite.EN_TRAMITE, usuarioId);

    expect(importacionPasa.ok).toBe(true);
    expect(otroBloqueado).toMatchObject({
      ok: false,
      message: `Falta el BL y la factura comercial del trámite ${otro.consecutivo}.`,
    });
  });

  it("por defecto la clasificación no pide BL (no tiene)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([
      TARIFA_OFF,
      { codigo: "clasificacion_arancelaria", habilitado: true },
    ]);
    const clasificacion = await doEnApertura(empresa.id, "CLASIFICACION");

    const resultado = await transitionTramite(clasificacion.id, EstadoTramite.EN_TRAMITE, usuarioId);

    expect(resultado.ok).toBe(true);
  });

  it("excepción del ADMIN: pasa, avisa y deja un AuditLog OMITIR_REQUISITOS", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await createTramite(datosDo(empresa.id));
    await prisma.tramiteDO.update({
      where: { id: tramite.id },
      data: { estado: EstadoTramite.APERTURA },
    });
    // El checklist queda como venga de la plantilla (normalmente incompleto).
    const checklistPendiente = (
      await prisma.checklistItem.findMany({
        where: { tramiteId: tramite.id, requerido: true, recibido: false },
        select: { descripcion: true },
      })
    ).map((item) => item.descripcion);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      true,
      Rol.ADMIN,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.advertencias[0]).toBe(
      `Falta el BL y la factura comercial del ${tramite.consecutivo}. Pasó por excepción de ADMIN y quedó registrado en el historial.`,
    );
    expect(resultado.advertencias).toHaveLength(checklistPendiente.length > 0 ? 2 : 1);

    const auditoria = await prisma.auditLog.findFirst({
      where: { tramiteId: tramite.id, accion: "OMITIR_REQUISITOS" },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria?.usuarioId).toBe(usuarioId);
    const antes = auditoria?.antes as {
      estado: string;
      checklistPendiente: string[];
      documentosFaltantes: string[];
    };
    expect(antes.estado).toBe("APERTURA");
    expect(antes.documentosFaltantes).toEqual(["BL", "FACTURA_COMERCIAL"]);
    expect([...antes.checklistPendiente].sort()).toEqual([...checklistPendiente].sort());
    expect(auditoria?.despues).toEqual({ estado: "EN_TRAMITE" });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.EN_TRAMITE);
  });

  it("el salto de estados del ADMIN también queda auditado", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.DESPACHADO,
      usuarioId,
      true,
      Rol.ADMIN,
    );

    expect(resultado.ok).toBe(true);
    const auditoria = await prisma.auditLog.findFirst({
      where: { tramiteId: tramite.id, accion: "OMITIR_REQUISITOS" },
    });
    expect(auditoria?.antes).toMatchObject({ documentosFaltantes: ["BL", "FACTURA_COMERCIAL"] });
  });

  it("sin requisitos pendientes el ADMIN no genera AuditLog de excepción", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);
    await adjuntar(tramite.id, CategoriaDocumento.BL);
    await adjuntar(tramite.id, CategoriaDocumento.FACTURA_COMERCIAL);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      true,
      Rol.ADMIN,
    );

    expect(resultado).toMatchObject({ ok: true, advertencias: [] });
    expect(
      await prisma.auditLog.count({ where: { tramiteId: tramite.id, accion: "OMITIR_REQUISITOS" } }),
    ).toBe(0);
  });
});

// ─── F4 · Reabrir un CERRADO respeta D1 y D2 ──────────────────────────────────

async function cerrar(tramiteId: string): Promise<void> {
  await prisma.tramiteDO.update({ where: { id: tramiteId }, data: { estado: EstadoTramite.CERRADO } });
}

describe("F4 · reabrir un trámite CERRADO respeta D1 y D2 igual que la transición normal", () => {
  it("D1 — sin tarifa vigente, reabrir a APERTURA (o más allá) queda bloqueado incluso con la excepción de ADMIN", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    const solicitud = await createTramite(datosDo(empresa.id), { origen: "SOLICITUD_PUBLICA" });
    await cerrar(solicitud.id);

    const resultado = await transitionTramite(
      solicitud.id,
      EstadoTramite.APERTURA,
      usuarioId,
      true, // bypassChecklist no debe ayudar: D1 no tiene excepción de ADMIN
      Rol.ADMIN,
    );

    expect(resultado).toMatchObject({
      ok: false,
      status: 422,
      codigo: "TARIFA_VIGENTE_REQUERIDA",
      detalles: { clienteId: empresa.id, lineaServicio: "TRAMITE", tipoTramiteCodigo: "IMPORTACION" },
    });
    expect(await estadoDe(solicitud.id)).toBe(EstadoTramite.CERRADO);
  });

  it("reabrir de vuelta a SOLICITUD no exige tarifa vigente (D1 no aplica a ese destino)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    const solicitud = await createTramite(datosDo(empresa.id), { origen: "SOLICITUD_PUBLICA" });
    await cerrar(solicitud.id);

    const resultado = await transitionTramite(
      solicitud.id,
      EstadoTramite.SOLICITUD,
      usuarioId,
      false,
      Rol.ADMIN,
    );

    expect(resultado.ok).toBe(true);
    expect(await estadoDe(solicitud.id)).toBe(EstadoTramite.SOLICITUD);
  });

  it("D2 — sin BL/factura, reabrir a EN_TRAMITE queda bloqueado sin la excepción de ADMIN", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);
    await cerrar(tramite.id);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      false,
      Rol.ADMIN,
    );

    expect(resultado).toMatchObject({
      ok: false,
      status: 422,
      codigo: "DOCUMENTOS_OBLIGATORIOS_FALTANTES",
      detalles: { documentosFaltantes: ["BL", "FACTURA_COMERCIAL"] },
    });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.CERRADO);
  });

  it("D2 — con la excepción de ADMIN, reabrir a EN_TRAMITE sin documentos pasa con advertencia y AuditLog OMITIR_REQUISITOS", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([TARIFA_OFF]);
    const tramite = await doEnApertura(empresa.id);
    await cerrar(tramite.id);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      true,
      Rol.ADMIN,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.advertencias).toContain(
      `Falta el BL y la factura comercial del ${tramite.consecutivo}. Pasó por excepción de ADMIN y quedó registrado en el historial.`,
    );
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.EN_TRAMITE);

    const reapertura = await prisma.auditLog.findFirst({
      where: { tramiteId: tramite.id, accion: "REAPERTURA" },
    });
    expect(reapertura).not.toBeNull();

    const omision = await prisma.auditLog.findFirst({
      where: { tramiteId: tramite.id, accion: "OMITIR_REQUISITOS" },
    });
    expect(omision).not.toBeNull();
    expect(omision?.antes).toMatchObject({ documentosFaltantes: ["BL", "FACTURA_COMERCIAL"] });
  });

  it("con tarifa vigente y documentos completos, reabrir a EN_TRAMITE pasa sin advertencias", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa();
    await crearTarifario(empresa.id);
    const tramite = await doEnApertura(empresa.id);
    await adjuntar(tramite.id, CategoriaDocumento.BL);
    await adjuntar(tramite.id, CategoriaDocumento.FACTURA_COMERCIAL);
    await cerrar(tramite.id);

    const resultado = await transitionTramite(
      tramite.id,
      EstadoTramite.EN_TRAMITE,
      usuarioId,
      false,
      Rol.ADMIN,
    );

    expect(resultado).toMatchObject({ ok: true, advertencias: [] });
    expect(await estadoDe(tramite.id)).toBe(EstadoTramite.EN_TRAMITE);
  });
});

// ─── F5 · D1 usa el día calendario en Bogotá, no el instante UTC ──────────────

describe("F5 · D1 (verificarTarifaVigente) decide con el día calendario en Bogotá", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("una tarifa con vigenteHasta 2027-01-31 todavía sirve para crear el DO a las 23:30 Bogotá (2027-02-01 04:30Z) y ya no a las 00:30 Bogotá del día siguiente (2027-02-01 05:30Z)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    await crearTarifario(empresa.id, {
      desde: new Date("2026-01-01T00:00:00.000Z"),
      hasta: new Date("2027-01-31T00:00:00.000Z"),
    });

    // Solo se congela `Date`: las consultas a Postgres siguen su curso normal.
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(new Date("2027-02-01T04:30:00.000Z"));
    const tramite = await createTramite(datosDo(empresa.id));
    expect(tramite.estado).toBe(EstadoTramite.SOLICITUD);

    vi.setSystemTime(new Date("2027-02-01T05:30:00.000Z"));
    await expect(createTramite(datosDo(empresa.id))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });

  it("una tarifa con vigenteDesde 2026-09-22 aún no sirve a las 20:00 Bogotá del día anterior (2026-09-22 01:00Z)", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa([DOCS_OFF]);
    await crearTarifario(empresa.id, {
      desde: new Date("2026-09-22T00:00:00.000Z"),
      hasta: new Date("2027-09-22T00:00:00.000Z"),
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T01:00:00.000Z"));

    await expect(createTramite(datosDo(empresa.id))).rejects.toBeInstanceOf(
      TarifaVigenteRequeridaError,
    );
  });
});
