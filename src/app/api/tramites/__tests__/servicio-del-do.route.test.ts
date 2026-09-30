/**
 * Servicio del DO por HTTP (DISENO-NUMERACION.md §2.2.4–§2.2.5, §2.5; casos
 * 20, 21, 23, 25, 26, 27 y 28 del §8; decisión de Ernesto 30-sep-2026):
 *
 *   POST  /api/tramites              — D1 por servicio, SERVICIO_RESERVADO, SERVICIO_NO_PERMITIDO,
 *                                      año distinto del actual solo ADMIN
 *   GET   /api/tramites/requisitos   — servicio, documentos y número que tomará
 *   GET   /api/tramites/consecutivos — estado de los contadores (ADMIN, REVISOR)
 *   GET   /api/tipos-tramite         — cada tipo con su catálogo de servicios
 *   PATCH /api/tramites/[id]         — cambiar el servicio (409 con borrador o desde
 *                                      «Enviado a facturar», 422 fuera del catálogo)
 *   POST  /api/tramites/[id]/estado  — D2 y checklist sin lo que no aplica al servicio
 *
 * Se omite si no hay BD o si faltan las migraciones del 30-sep.
 */
import "dotenv/config";

import { EstadoTarifario, EstadoTramite, Prisma, Rol } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

import { POST as estadoPOST } from "@/app/api/tramites/[id]/estado/route";
import { PATCH as tramitePATCH } from "@/app/api/tramites/[id]/route";
import { GET as consecutivosGET } from "@/app/api/tramites/consecutivos/route";
import { GET as requisitosGET } from "@/app/api/tramites/requisitos/route";
import { POST as tramitesPOST } from "@/app/api/tramites/route";
import { GET as tiposGET } from "@/app/api/tipos-tramite/route";
import { auth } from "@/lib/auth/auth";
import { definicionDe } from "@/lib/capacidades/catalogo";
import { prisma } from "@/lib/db/prisma";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";

const TEST_PREFIX = "vitest-servicio-do-api";
const ANIO_ACTUAL = fechaCalendarioBogota().getUTCFullYear();
const YY = String(ANIO_ACTUAL).slice(-2);
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DIA = 86_400_000;

let listo = false;
let motivo: string | null = null;
let usuarioId = "";
let empresas = 0;

function ensureDb(ctx: { skip: (nota?: string) => void }) {
  if (!listo) ctx.skip(motivo ?? "BD no disponible");
}

function sesion(rol: Rol) {
  return {
    user: {
      id: usuarioId,
      rol,
      email: `${RUN_ID}@example.test`,
      name: "Vitest Servicio DO",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-servicio-do",
      userId: usuarioId,
      expiresAt: new Date(Date.now() + DIA),
      token: "token-servicio-do",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function comoRol(rol: Rol) {
  vi.mocked(auth.api.getSession).mockResolvedValue(sesion(rol));
}

function request(url: string, method: "POST" | "PATCH", body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function crearEmpresa(
  nombre: string,
  capacidades: { codigo: string; habilitado: boolean; config?: Prisma.InputJsonValue }[] = [],
) {
  empresas += 1;
  return prisma.cliente.create({
    data: { nombre: `${nombre} ${empresas}`, nit: `${RUN_ID}-${empresas}`, capacidades: { create: capacidades } },
  });
}

async function tarifaVigente(empresaId: string, servicio: string | null, valor = 300_000) {
  return prisma.tarifario.create({
    data: {
      empresaId,
      nombre: servicio ? `Tarifa ${servicio}` : "Tarifa general de importación",
      alcance: "TRAMITE",
      conceptoServicioCodigo: servicio,
      estado: EstadoTarifario.VIGENTE,
      version: (await prisma.tarifario.count({ where: { empresaId, alcance: "TRAMITE" } })) + 1,
      vigenteDesde: new Date(Date.now() - 30 * DIA),
      vigenteHasta: new Date(Date.now() + 300 * DIA),
      creadoPorId: usuarioId,
      items: {
        create: [
          {
            concepto: "SERVICIO_TRASLADO",
            nombrePublico: "Servicio",
            tipoCalculo: "FIJO",
            disparador: "SIEMPRE",
            unidad: "TRAMITE",
            valor: BigInt(valor),
            orden: 10,
          },
        ],
      },
    },
  });
}

async function crearDo(body: Record<string, unknown>) {
  const res = await tramitesPOST(
    request("http://localhost/api/tramites", "POST", { ciudad: "BAQ", agenciaAduanas: "COLDEX", ...body }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({ where: { tramiteId: { in: tramiteIds } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.estadoLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.documento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradores.map((b) => b.id) } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.auditLog.deleteMany({ where: { entidadId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    motivo = "DATABASE_URL no definida";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    if ((await prisma.servicioTramite.count()) === 0) {
      motivo = "La BD no tiene las migraciones del 30-sep-2026";
      return;
    }
  } catch (error) {
    motivo = `BD no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  // Igual que el seed en cada arranque: D1 y D2 con su config de fábrica.
  for (const codigo of ["do_exige_tarifa_vigente", "docs_bl_factura_obligatorios"] as const) {
    const definicion = definicionDe(codigo);
    await prisma.capacidad.update({
      where: { codigo },
      data: {
        porDefecto: definicion.porDefecto,
        configPorDefecto:
          definicion.configPorDefecto === null ? Prisma.DbNull : (definicion.configPorDefecto as Prisma.InputJsonValue),
        activa: true,
      },
    });
  }
  await limpiar();
  usuarioId = (
    await prisma.user.create({
      data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Servicio DO", rol: Rol.ADMIN },
    })
  ).id;
  listo = true;
});

afterAll(async () => {
  if (listo) await limpiar();
  await prisma.$disconnect();
});

const TARIFARIO_PROPIO = [{ codigo: "tarifario_propio", habilitado: true }];

describe("D1 por servicio al crear (casos 20, 21)", () => {
  it("caso 20 — Polyrec ZF, Importación general, con su tarifa general vencida → 422 de D1", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const polyrec = await crearEmpresa("POLYREC ZONA FRANCA VITEST", TARIFARIO_PROPIO);
    const general = await tarifaVigente(polyrec.id, null);
    await tarifaVigente(polyrec.id, "TRASLADO_ZF");

    expect((await crearDo({ clienteId: polyrec.id })).status).toBe(201);
    await prisma.tarifario.update({ where: { id: general.id }, data: { estado: EstadoTarifario.VENCIDO } });

    const sinGeneral = await crearDo({ clienteId: polyrec.id });
    expect(sinGeneral.status).toBe(422);
    expect(sinGeneral.json).toMatchObject({ codigo: "TARIFA_VIGENTE_REQUERIDA" });
    // La importación general conserva el mensaje de siempre (sin nombre de servicio).
    expect(sinGeneral.json.error).toBe(
      `${polyrec.nombre} no tiene una tarifa vigente de importación. Publica la tarifa de la empresa antes de crear el DO.`,
    );
    // El traslado sí tiene su tarifa: se crea.
    expect((await crearDo({ clienteId: polyrec.id, conceptoServicioCodigo: "TRASLADO_ZF" })).status).toBe(201);
  });

  it("caso 21 — CW Asia con Nacionalización sin tarifa de ese servicio → 422 «…escoge otro servicio»; con Importación → su tarifa general", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const cwAsia = await crearEmpresa("CW ASIA VITEST", TARIFARIO_PROPIO);
    await tarifaVigente(cwAsia.id, null);

    const nac = await crearDo({ clienteId: cwAsia.id, conceptoServicioCodigo: "NACIONALIZACION_ZF" });
    expect(nac.status).toBe(422);
    expect(nac.json).toMatchObject({
      codigo: "TARIFA_VIGENTE_REQUERIDA",
      error: `${cwAsia.nombre} no tiene una tarifa vigente de importación para el servicio «Nacionalización desde zona franca». Publica la tarifa de ese servicio o escoge otro servicio.`,
      detalles: { servicio: "NACIONALIZACION_ZF" },
    });

    const imp = await crearDo({ clienteId: cwAsia.id });
    expect(imp.status).toBe(201);
    expect((imp.json.tramite as { conceptoServicioCodigo: string | null }).conceptoServicioCodigo).toBeNull();
  });
});

describe("servicios reservados y fuera del catálogo (caso 23, 26)", () => {
  it("caso 23 — «Otros» con NACIONALIZACION_ZF → 422 SERVICIO_RESERVADO; Importación con PLAN_VALLEJO → 422 SERVICIO_NO_PERMITIDO", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("EMPRESA VITEST RESERVADO");

    const otros = await crearDo({
      clienteId: empresa.id,
      tipoTramiteCodigo: "OTRO",
      agenciaAduanas: undefined,
      conceptoServicioCodigo: "NACIONALIZACION_ZF",
    });
    expect(otros.status).toBe(422);
    expect(otros.json).toMatchObject({ codigo: "SERVICIO_RESERVADO" });
    expect(otros.json.error).toMatch(/se crea como Trámite de importación con ese servicio, no como Otros servicios/);

    const imp = await crearDo({ clienteId: empresa.id, conceptoServicioCodigo: "PLAN_VALLEJO" });
    expect(imp.status).toBe(422);
    expect(imp.json).toMatchObject({
      codigo: "SERVICIO_NO_PERMITIDO",
      error:
        "Los servicios de Trámite de importación son: Importación, Traslado de zona franca, Nacionalización desde zona franca y DUTA.",
    });
  });

  it("caso 26 — PATCH del servicio: entre servicios del catálogo antes de facturar → ok; a PLAN_VALLEJO → 422; con borrador o desde «Enviado a facturar» → 409", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("EMPRESA VITEST PATCH", [
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
    ]);
    const creado = await crearDo({ clienteId: empresa.id, conceptoServicioCodigo: "NACIONALIZACION_ZF" });
    expect(creado.status).toBe(201);
    const t = creado.json.tramite as { id: string; consecutivo: string; numero: number };
    const url = `http://localhost/api/tramites/${t.id}`;
    const contexto = { params: Promise.resolve({ id: t.id }) };

    const aTraslado = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "TRASLADO_ZF" }), contexto);
    expect(aTraslado.status).toBe(200);
    const cuerpo = (await aTraslado.json()) as { tramite: { conceptoServicioCodigo: string; consecutivo: string; numero: number } };
    expect(cuerpo.tramite).toMatchObject({ conceptoServicioCodigo: "TRASLADO_ZF", consecutivo: t.consecutivo, numero: t.numero });

    const aGeneral = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: null }), contexto);
    expect(aGeneral.status).toBe(200);
    expect(((await aGeneral.json()) as { tramite: { conceptoServicioCodigo: string | null } }).tramite.conceptoServicioCodigo).toBeNull();

    const aVallejo = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "PLAN_VALLEJO" }), contexto);
    expect(aVallejo.status).toBe(422);
    expect(await aVallejo.json()).toMatchObject({ codigo: "SERVICIO_NO_PERMITIDO" });

    // El valor a mano sigue siendo solo de flujo corto.
    const conValor = await tramitePATCH(request(url, "PATCH", { valorServicio: "500000" }), contexto);
    expect(conValor.status).toBe(422);

    await prisma.tramiteDO.update({ where: { id: t.id }, data: { estado: EstadoTramite.ENVIADO_A_FACTURAR } });
    const tarde = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "DUTA" }), contexto);
    expect(tarde.status).toBe(409);
    // Reenviar el MISMO servicio (p. ej. el formulario completo) no se frena.
    const igual = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: null, comentarios: `${TEST_PREFIX}` }), contexto);
    expect(igual.status).toBe(200);

    await prisma.tramiteDO.update({ where: { id: t.id }, data: { estado: EstadoTramite.DESPACHADO } });
    await prisma.borradorFactura.create({
      data: {
        tramiteId: t.id,
        comision: 0n,
        ivaComision: 0n,
        impuesto4x1000: 0n,
        costosBancarios: 0n,
        totalAnticipo: 0n,
        totalPagos: 0n,
        totalFactura: 0n,
      },
    });
    const conBorrador = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "DUTA" }), contexto);
    expect(conBorrador.status).toBe(409);
  });

  it("PATCH con D1 encendida: no se pasa a un servicio sin tarifa vigente", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("EMPRESA VITEST PATCH D1", TARIFARIO_PROPIO);
    await tarifaVigente(empresa.id, null);
    await tarifaVigente(empresa.id, "TRASLADO_ZF");
    const creado = await crearDo({ clienteId: empresa.id });
    const t = creado.json.tramite as { id: string };
    const url = `http://localhost/api/tramites/${t.id}`;
    const contexto = { params: Promise.resolve({ id: t.id }) };

    const aDuta = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "DUTA" }), contexto);
    expect(aDuta.status).toBe(422);
    expect(await aDuta.json()).toMatchObject({ codigo: "TARIFA_VIGENTE_REQUERIDA" });
    const aTraslado = await tramitePATCH(request(url, "PATCH", { conceptoServicioCodigo: "TRASLADO_ZF" }), contexto);
    expect(aTraslado.status).toBe(200);
  });
});

describe("requisitos por servicio: nacionalización sin BL (caso 25)", () => {
  async function documento(tramiteId: string, categoria: "FACTURA_COMERCIAL" | "BL") {
    await prisma.documento.create({
      data: {
        tramiteId,
        categoria,
        nombreArchivo: `${categoria}.pdf`,
        storageKey: `tramites/vitest/${categoria}/${RUN_ID}.pdf`,
        mimeType: "application/pdf",
        tamanoBytes: 10,
        subidoPorId: usuarioId,
      },
    });
  }

  it("caso 25 — la nacionalización no pide BL (checklist ni D2); pasada a Traslado en APERTURA, D2 vuelve a pedirlo", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("POLYREC ZF VITEST NAC", [
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
    ]);

    // DO 1: nacionalización. Checklist sin BL; con la factura comercial pasa a En trámite.
    const nac = (await crearDo({ clienteId: empresa.id, conceptoServicioCodigo: "NACIONALIZACION_ZF" })).json
      .tramite as { id: string; checklistItems: { descripcion: string; categoriaDocumento: string | null }[] };
    expect(nac.checklistItems.map((i) => i.categoriaDocumento)).not.toContain("BL");
    expect(nac.checklistItems.map((i) => i.categoriaDocumento)).toContain("FACTURA_COMERCIAL");
    await prisma.checklistItem.updateMany({ where: { tramiteId: nac.id }, data: { recibido: true } });
    await prisma.tramiteDO.update({ where: { id: nac.id }, data: { estado: EstadoTramite.APERTURA } });
    await documento(nac.id, "FACTURA_COMERCIAL");
    const pasa = await estadoPOST(
      request(`http://localhost/api/tramites/${nac.id}/estado`, "POST", { estado: "EN_TRAMITE" }),
      { params: Promise.resolve({ id: nac.id }) },
    );
    expect(pasa.status).toBe(200);

    // DO 2: nacionalización que se cambia a Traslado en APERTURA → D2 pide el BL.
    const otro = (await crearDo({ clienteId: empresa.id, conceptoServicioCodigo: "NACIONALIZACION_ZF" })).json
      .tramite as { id: string; consecutivo: string };
    await prisma.checklistItem.updateMany({ where: { tramiteId: otro.id }, data: { recibido: true } });
    await prisma.tramiteDO.update({ where: { id: otro.id }, data: { estado: EstadoTramite.APERTURA } });
    const cambio = await tramitePATCH(
      request(`http://localhost/api/tramites/${otro.id}`, "PATCH", { conceptoServicioCodigo: "TRASLADO_ZF" }),
      { params: Promise.resolve({ id: otro.id }) },
    );
    expect(cambio.status).toBe(200);
    await documento(otro.id, "FACTURA_COMERCIAL");
    const frena = await estadoPOST(
      request(`http://localhost/api/tramites/${otro.id}/estado`, "POST", { estado: "EN_TRAMITE" }),
      { params: Promise.resolve({ id: otro.id }) },
    );
    expect(frena.status).toBe(422);
    expect(await frena.json()).toMatchObject({
      codigo: "DOCUMENTOS_OBLIGATORIOS_FALTANTES",
      error: `Falta el BL del ${otro.consecutivo}.`,
    });
  });

  it("un ítem de checklist pendiente que no aplica al servicio actual no frena", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("EMPRESA VITEST CHECKLIST", [
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
      { codigo: "docs_bl_factura_obligatorios", habilitado: false },
    ]);
    // Creado como importación general (con ítem BL) y pasado a nacionalización.
    const t = (await crearDo({ clienteId: empresa.id })).json.tramite as { id: string };
    await prisma.checklistItem.updateMany({
      where: { tramiteId: t.id, NOT: { categoriaDocumento: "BL" } },
      data: { recibido: true },
    });
    await prisma.tramiteDO.update({ where: { id: t.id }, data: { estado: EstadoTramite.APERTURA } });
    const contexto = { params: Promise.resolve({ id: t.id }) };
    const url = `http://localhost/api/tramites/${t.id}/estado`;

    const frena = await estadoPOST(request(url, "POST", { estado: "EN_TRAMITE" }), contexto);
    expect(frena.status).toBe(422);

    await tramitePATCH(
      request(`http://localhost/api/tramites/${t.id}`, "PATCH", { conceptoServicioCodigo: "NACIONALIZACION_ZF" }),
      contexto,
    );
    const pasa = await estadoPOST(request(url, "POST", { estado: "EN_TRAMITE" }), contexto);
    expect(pasa.status).toBe(200);
  });
});

describe("el año lo pone el servidor (caso 27)", () => {
  it("caso 27 — POST /api/tramites con otro año: OPERATIVO → 422; ADMIN → ok; el año actual lo puede mandar cualquiera", async (ctx) => {
    ensureDb(ctx);
    const empresa = await crearEmpresa("EMPRESA VITEST AÑO", [{ codigo: "do_exige_tarifa_vigente", habilitado: false }]);

    comoRol(Rol.OPERATIVO);
    const operativo = await crearDo({ clienteId: empresa.id, ciudad: "SMR", anio: 2079 });
    expect(operativo.status).toBe(422);
    expect(operativo.json).toMatchObject({
      codigo: "ANIO_SOLO_ADMIN",
      error: "Solo la administradora puede crear un DO de otro año.",
    });

    comoRol(Rol.REVISOR);
    expect((await crearDo({ clienteId: empresa.id, ciudad: "SMR", anio: 2079 })).status).toBe(422);
    expect((await crearDo({ clienteId: empresa.id, ciudad: "SMR", anio: ANIO_ACTUAL })).status).toBe(201);

    comoRol(Rol.ADMIN);
    const admin = await crearDo({ clienteId: empresa.id, ciudad: "SMR", anio: 2079 });
    expect(admin.status).toBe(201);
    expect((admin.json.tramite as { consecutivo: string }).consecutivo).toMatch(/^DO\.SMR79-\d{4}$/);
  });
});

describe("requisitos con servicio y vista previa del número (caso 28)", () => {
  it("caso 28 — ciudad=BGT&servicio=NACIONALIZACION_ZF → número del contador compartido, solo factura comercial", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const empresa = await crearEmpresa("POLYREC ZF VITEST REQUISITOS", [
      { codigo: "do_exige_tarifa_vigente", habilitado: false },
    ]);
    // Como en producción tras el borrado del 30-sep: Barranquilla va en 0281.
    const grupo = { tipoTramiteCodigo: "IMPORTACION", anio: ANIO_ACTUAL, ciudad: { in: ["BAQ", "BGT", "BUN"] as ("BAQ" | "BGT" | "BUN")[] } };
    const maxAntes = (await prisma.tramiteDO.aggregate({ where: grupo, _max: { numero: true } }))._max.numero ?? 0;
    if (maxAntes < 281) {
      await prisma.tramiteDO.create({
        data: {
          consecutivo: `DO.BAQ${YY}-0281`,
          tipoTramiteCodigo: "IMPORTACION",
          ciudad: "BAQ",
          anio: ANIO_ACTUAL,
          numero: 281,
          clienteId: empresa.id,
          creadoPorId: usuarioId,
          comentarios: `${TEST_PREFIX}:${RUN_ID}`,
        },
      });
    }
    const maximo = (await prisma.tramiteDO.aggregate({ where: grupo, _max: { numero: true } }))._max.numero ?? 0;
    const piso =
      (await prisma.consecutivoPiso.aggregate({ where: { clave: `IMPORTACION:BAQ+BGT+BUN:${ANIO_ACTUAL}` }, _max: { ultimoNumero: true } }))
        ._max.ultimoNumero ?? 0;
    const esperado = `DO.BGT${YY}-${String(Math.max(maximo, piso) + 1).padStart(4, "0")}`;
    if (maximo === 281 && piso <= 281) expect(esperado).toBe(`DO.BGT${YY}-0282`);

    const res = await requisitosGET(
      new NextRequest(
        `http://localhost/api/tramites/requisitos?clienteId=${empresa.id}&tipoTramiteCodigo=IMPORTACION&ciudad=BGT&servicio=NACIONALIZACION_ZF`,
      ),
    );
    expect(res.status).toBe(200);
    const requisitos = (await res.json()) as {
      numeracion: { siguiente: string; contador: string };
      documentosObligatorios: { requeridos: string[] };
      servicio: { codigo: string; nombre: string; claveTarifa: string };
    };
    expect(requisitos.numeracion).toEqual({
      siguiente: esperado,
      contador: "contador compartido Barranquilla, Bogotá y Buenaventura",
    });
    expect(requisitos.documentosObligatorios.requeridos).toEqual(["FACTURA_COMERCIAL"]);
    expect(requisitos.servicio).toEqual({
      codigo: "NACIONALIZACION_ZF",
      nombre: "Nacionalización desde zona franca",
      claveTarifa: "NACIONALIZACION_ZF",
    });

    // Cartagena: su propio contador. Exportación: su serie, sin ciudad.
    const ctg = (await (
      await requisitosGET(
        new NextRequest(`http://localhost/api/tramites/requisitos?clienteId=${empresa.id}&ciudad=CTG&servicio=DUTA`),
      )
    ).json()) as { numeracion: { siguiente: string; contador: string } };
    expect(ctg.numeracion.contador).toBe("contador de Cartagena");
    expect(ctg.numeracion.siguiente).toMatch(new RegExp(`^DO\\.CTG${YY}-\\d{4}$`));
    const exp = (await (
      await requisitosGET(
        new NextRequest(`http://localhost/api/tramites/requisitos?clienteId=${empresa.id}&tipoTramiteCodigo=EXPORTACION&ciudad=BAQ`),
      )
    ).json()) as { numeracion: { siguiente: string; contador: string }; servicio: { codigo: string } };
    expect(exp.numeracion.siguiente).toMatch(new RegExp(`^DO\\.EXP${YY}-\\d{4}$`));
    expect(exp.servicio.codigo).toBe("EXPORTACION");

    // Un servicio que el tipo no admite: 422 con código.
    const malo = await requisitosGET(
      new NextRequest(`http://localhost/api/tramites/requisitos?clienteId=${empresa.id}&servicio=PLAN_VALLEJO`),
    );
    expect(malo.status).toBe(422);
    expect(await malo.json()).toMatchObject({ codigo: "SERVICIO_NO_PERMITIDO" });
  });

  it("GET /api/tramites/consecutivos (ADMIN, REVISOR): un contador compartido para BAQ-BGT-BUN, CTG y SMR aparte, Exportación por año", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    expect((await consecutivosGET(new NextRequest("http://localhost/api/tramites/consecutivos"))).status).toBe(403);

    comoRol(Rol.REVISOR);
    const res = await consecutivosGET(new NextRequest(`http://localhost/api/tramites/consecutivos?anio=${ANIO_ACTUAL}`));
    expect(res.status).toBe(200);
    const { contadores } = (await res.json()) as {
      contadores: { clave: string; contador: string; ciudades: string[] | null; siguiente: string; piso: number | null }[];
    };
    const claves = contadores.map((c) => c.clave);
    expect(claves).toContain(`IMPORTACION:BAQ+BGT+BUN:${ANIO_ACTUAL}`);
    expect(claves).toContain(`IMPORTACION:CTG:${ANIO_ACTUAL}`);
    expect(claves).toContain(`IMPORTACION:SMR:${ANIO_ACTUAL}`);
    expect(claves).toContain(`EXPORTACION:${ANIO_ACTUAL}`);
    expect(claves).not.toContain(`IMPORTACION:BGT:${ANIO_ACTUAL}`);
    const grupo = contadores.find((c) => c.clave === `IMPORTACION:BAQ+BGT+BUN:${ANIO_ACTUAL}`);
    expect(grupo?.ciudades).toEqual(["BAQ", "BGT", "BUN"]);
    expect(grupo?.contador).toBe("contador compartido Barranquilla, Bogotá y Buenaventura");
  });

  it("GET /api/tipos-tramite trae el catálogo de servicios de cada tipo", async (ctx) => {
    ensureDb(ctx);
    comoRol(Rol.OPERATIVO);
    const res = await tiposGET(new NextRequest("http://localhost/api/tipos-tramite"));
    const { tipos } = (await res.json()) as { tipos: { codigo: string; servicios: { conceptoCodigo: string | null }[] }[] };
    const importacion = tipos.find((t) => t.codigo === "IMPORTACION");
    expect(importacion?.servicios.map((s) => s.conceptoCodigo)).toEqual([null, "TRASLADO_ZF", "NACIONALIZACION_ZF", "DUTA"]);
    expect(tipos.find((t) => t.codigo === "EXPORTACION")?.servicios.map((s) => s.conceptoCodigo)).toEqual(["EXPORTACION"]);
    expect(tipos.find((t) => t.codigo === "OTRO")?.servicios).toEqual([]);
  });
});

