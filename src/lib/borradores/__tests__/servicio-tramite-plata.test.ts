/**
 * Servicio dentro del trámite normal — plata al peso (DISENO-NUMERACION.md
 * §2.2.7 y §8; decisión de Ernesto 30-sep-2026). Nacionalización, traslado y
 * DUTA como trámites de importación con su servicio, cada uno con SU tarifa
 * en «Trámites», y nunca la comisión por defecto en un servicio sin tarifa.
 *
 *   22  DUTA sin tarifa ni comisión escrita → 422; con comisión a mano → sale.
 *
 * Requiere PostgreSQL local con DATABASE_URL y las migraciones del 30-sep; si
 * no, skip. TEST_PREFIX único: "vitest-servicio-plata". Año de datos: 3031.
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { propuestaParaTramite } from "@/lib/tarifas/service";

import { generarBorrador, ServicioSinTarifaError } from "../service";

const TEST_PREFIX = "vitest-servicio-plata";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 3031;
const $ = (n: number) => BigInt(n);

let listo = false;
let motivo: string | null = null;
let adminId = "";
let contador = 0;

function ensureDb(ctx: { skip: (nota?: string) => void }) {
  if (!listo) ctx.skip(motivo ?? "BD local no disponible");
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({
    where: { OR: [{ clienteId: { in: clienteIds } }, { comentarios: { startsWith: TEST_PREFIX } }] },
    select: { id: true },
  });
  const tramiteIds = tramites.map((t) => t.id);
  const borradores = await prisma.borradorFactura.findMany({ where: { tramiteId: { in: tramiteIds } }, select: { id: true } });
  const borradorIds = borradores.map((b) => b.id);
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { tramiteId: { in: tramiteIds } },
        { entidadId: { in: [...tramiteIds, ...borradorIds, ...clienteIds] } },
        { usuario: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  });
  await prisma.lineaRevision.deleteMany({ where: { borradorId: { in: borradorIds } } });
  await prisma.borradorFactura.deleteMany({ where: { id: { in: borradorIds } } });
  await prisma.tramiteEvento.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.checklistItem.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  await prisma.tarifario.deleteMany({ where: { empresaId: { in: clienteIds } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
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
  await limpiar();
  adminId = (
    await prisma.user.create({
      data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest servicio plata", rol: Rol.ADMIN },
    })
  ).id;
  listo = true;
});

afterAll(async () => {
  if (listo) await limpiar();
});

let empresas = 0;
/** Empresa con tarifario propio y factura CONCEPTOS_IVA (ReteIVA 15 % de fábrica), como Polyrec ZF. */
async function empresaConceptos(nombre: string, extra: { codigo: string; habilitado: boolean }[] = []) {
  empresas += 1;
  const empresa = await prisma.cliente.create({
    data: { nombre: `${nombre} ${empresas}`, nit: `${RUN_ID}-${empresas}`, tipo: TipoCliente.PROPIO },
  });
  await setCapacidadesEmpresa({
    empresaId: empresa.id,
    cambios: [
      { codigo: "tarifario_propio", habilitado: true },
      { codigo: "factura_conceptos_iva", habilitado: true },
      ...extra,
    ],
    usuarioId: adminId,
  });
  return empresa;
}

/** DO de importación ya en «Enviado a facturar», con el servicio y la base de cálculo dados. */
async function doImportacion(
  empresaId: string,
  o: {
    servicio: string | null;
    ciudad?: Ciudad;
    tipo?: string;
    cif?: bigint;
    suelta?: boolean;
    contenedores?: number;
    declaraciones?: number;
    documentos?: number;
    agencia?: AgenciaAduanas | null;
    valorServicio?: bigint;
  },
) {
  contador += 1;
  const tipo = o.tipo ?? "IMPORTACION";
  const ciudad = o.ciudad ?? Ciudad.BAQ;
  return prisma.tramiteDO.create({
    data: {
      consecutivo: `VT-${tipo}-${ciudad}-${ANIO}-${contador}-${RUN_ID}`,
      tipoTramiteCodigo: tipo,
      ciudad,
      anio: ANIO,
      numero: contador,
      clienteId: empresaId,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
      conceptoServicioCodigo: o.servicio,
      valorServicio: o.valorServicio ?? null,
      valorCif: o.cif ?? null,
      tipoCarga: o.suelta ? "SUELTA" : o.contenedores ? "CONTENEDOR_40" : null,
      numContenedores: o.suelta ? 0 : (o.contenedores ?? null),
      numDeclaraciones: o.declaraciones ?? null,
      numDocumentos: o.documentos ?? null,
      agenciaAduanas: o.agencia === undefined ? AgenciaAduanas.COLDEX : o.agencia,
    },
  });
}

describe("caso 22 — nunca la comisión por defecto en un servicio sin tarifa (§2.2.7)", () => {
  it("DUTA sin tarifa ni comisión → 422 SERVICIO_SIN_TARIFA; con la comisión a mano → 380.000 + IVA − ReteIVA = 441.370", async (ctx) => {
    ensureDb(ctx);
    const empresa = await empresaConceptos("POLYREC ZF VITEST SIN TARIFA");
    const t = await doImportacion(empresa.id, { servicio: "DUTA", ciudad: Ciudad.CTG });

    const p = await propuestaParaTramite(t.id);
    expect(p.tarifario).toBeNull();
    expect(p.servicio).toEqual({ codigo: "DUTA", nombre: "DUTA (tránsito aduanero)", claveTarifa: "DUTA" });
    expect(p.motivo).toContain("(servicio DUTA (tránsito aduanero))");

    await expect(generarBorrador({ tramiteId: t.id, usuarioId: adminId })).rejects.toBeInstanceOf(ServicioSinTarifaError);
    await expect(generarBorrador({ tramiteId: t.id, usuarioId: adminId })).rejects.toMatchObject({
      status: 422,
      codigo: "SERVICIO_SIN_TARIFA",
      message:
        "El DO es de servicio DUTA (tránsito aduanero) y la empresa no tiene tarifa para ese servicio: escribe la comisión a mano o carga la tarifa.",
    });
    expect(await prisma.borradorFactura.count({ where: { tramiteId: t.id } })).toBe(0);

    const b = await generarBorrador({ tramiteId: t.id, usuarioId: adminId, comision: $(380_000) });
    expect(b.comision).toBe($(380_000));
    expect(b.retenciones).toBe($(10_830));
    expect(b.totalFacturaLineas).toBe($(441_370));
  });

  it("sin la función de tarifario propio tampoco cae a la comisión por defecto en un servicio con tarifa propia", async (ctx) => {
    ensureDb(ctx);
    empresas += 1;
    const empresa = await prisma.cliente.create({
      data: { nombre: `EMPRESA VITEST SIN FUNCION ${empresas}`, nit: `${RUN_ID}-${empresas}`, tipo: TipoCliente.PROPIO },
    });
    const t = await doImportacion(empresa.id, { servicio: "NACIONALIZACION_ZF" });
    await expect(generarBorrador({ tramiteId: t.id, usuarioId: adminId })).rejects.toBeInstanceOf(ServicioSinTarifaError);
    // La importación general de esa misma empresa sigue como siempre (comisión por defecto).
    const general = await doImportacion(empresa.id, { servicio: null });
    const b = await generarBorrador({ tramiteId: general.id, usuarioId: adminId });
    expect(b.comision).toBeGreaterThan(0n);
  });
});
