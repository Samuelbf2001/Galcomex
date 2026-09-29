/**
 * Diseño A (27-sep-2026) — B8: el anticipo del DO no se descuenta dos veces
 * entre facturas del mismo trámite (`anticipo-disponible.ts`). Escenarios
 * B8-1 a B8-6 y concurrencia de `simulacion-camila-27sep/DISENO-A.md` §6.2,
 * con números redondos de prueba (la reproducción al peso de los casos
 * reales de Polyrec va en `verificar-disenoA.mjs`, paso 9). Formato COMISION
 * intacto (fuera de alcance de B8): se prueba que sigue contando el anticipo
 * completo en cada borrador, tal como hoy.
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida.
 * TEST_PREFIX único: "vitest-diseno-a-b8"
 */
import "dotenv/config";

import { AgenciaAduanas, Ciudad, EstadoBorrador, EstadoTramite, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anticipoDelTramite } from "@/lib/borradores/anticipo-disponible";
import { devolverBorrador } from "@/lib/borradores/devolver";
import { asignarAnticipoBorrador, generarBorrador, transicionarBorrador } from "@/lib/borradores/service";
import { setCapacidadesEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";

const TEST_PREFIX = "vitest-diseno-a-b8";
const RUN_ID = `${TEST_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const ANIO = 2098;

let dbConnected = false;
let dbUnavailableReason: string | null = null;
let adminId = "";
let clienteConceptosId = "";
let clienteComisionId = "";
let contador = 0;

function ensureDb(ctx: { skip: (note?: string) => void }) {
  if (!dbConnected) {
    ctx.skip(dbUnavailableReason ?? "BD local Postgres no disponible");
  }
}

async function crearTramite(clienteId: string) {
  contador += 1;
  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: `DO.CTG${String(ANIO).slice(-2)}-${String(contador).padStart(4, "0")}-${RUN_ID.slice(-6)}`,
      ciudad: Ciudad.CTG,
      anio: ANIO,
      numero: contador,
      clienteId,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: adminId,
      comentarios: `${TEST_PREFIX}:${RUN_ID}`,
      estado: EstadoTramite.ENVIADO_A_FACTURAR,
    },
  });
  return tramite.id;
}

async function aplicarAnticipo(clienteId: string, tramiteId: string, monto: bigint) {
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId,
      monto,
      fecha: new Date(`${ANIO}-01-10`),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 1_950n,
      verificadoBanco: true,
    },
  });
  await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId, montoAplicado: monto },
  });
}

async function aprobar(borradorId: string) {
  const rev = await transicionarBorrador({ borradorId, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
  if (!rev.ok) throw new Error(`No se pudo mover a EN_REVISION: ${rev.message}`);
  return transicionarBorrador({ borradorId, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
}

async function limpiar() {
  const clientes = await prisma.cliente.findMany({ where: { nit: { startsWith: TEST_PREFIX } }, select: { id: true } });
  const clienteIds = clientes.map((c) => c.id);
  const tramites = await prisma.tramiteDO.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  const tramiteIds = tramites.map((t) => t.id);

  await prisma.auditLog.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.factura.deleteMany({ where: { borrador: { tramiteId: { in: tramiteIds } } } });
  await prisma.borradorFactura.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId: { in: tramiteIds } } });
  await prisma.tramiteDO.deleteMany({ where: { id: { in: tramiteIds } } });
  const anticipos = await prisma.anticipo.findMany({ where: { clienteId: { in: clienteIds } }, select: { id: true } });
  await prisma.aplicacionAnticipo.deleteMany({ where: { anticipoId: { in: anticipos.map((a) => a.id) } } });
  await prisma.anticipo.deleteMany({ where: { id: { in: anticipos.map((a) => a.id) } } });
  await prisma.cliente.deleteMany({ where: { id: { in: clienteIds } } });
  await prisma.auditLog.deleteMany({ where: { usuario: { email: { startsWith: TEST_PREFIX } } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    dbUnavailableReason = "DATABASE_URL no definida; se omiten los tests de Diseño A (B8)";
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    dbUnavailableReason = `BD local Postgres no disponible: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  dbConnected = true;
  await limpiar();

  const admin = await prisma.user.create({
    data: { email: `${RUN_ID}@example.test`, emailVerified: true, name: "Vitest Diseño A B8", rol: Rol.ADMIN },
  });
  adminId = admin.id;

  const clienteConceptos = await prisma.cliente.create({
    data: { nombre: "Cliente vitest B8 conceptos", nit: `${TEST_PREFIX}-conceptos-${RUN_ID}`, tipo: TipoCliente.PROPIO },
  });
  clienteConceptosId = clienteConceptos.id;
  await setCapacidadesEmpresa({
    empresaId: clienteConceptosId,
    cambios: [{ codigo: "factura_conceptos_iva", habilitado: true }],
    usuarioId: adminId,
  });

  const clienteComision = await prisma.cliente.create({
    data: { nombre: "Cliente vitest B8 comisión", nit: `${TEST_PREFIX}-comision-${RUN_ID}`, tipo: TipoCliente.PROPIO },
  });
  clienteComisionId = clienteComision.id;
});

afterAll(async () => {
  if (dbConnected) await limpiar();
});

describe("B8-1 — regla estándar: la 2.ª factura no repite el anticipo de la 1.ª", () => {
  it("F1 usa todo el anticipo; F2 (aprobada F1) no ve nada disponible y sale a cargo", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 200_000n });
    expect(f1.totalAnticipo).toBe(1_000_000n);

    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 100_000n });
    expect(f2.totalAnticipo).toBe(0n);
    expect(f2.saldoACargoCliente).toBeGreaterThan(0n);
    expect(f2.saldoAFavorCliente).toBe(0n);
  });
});

describe("B8-2 — reparto a mano (multi-factura legítimo)", () => {
  it("ADMIN repone anticipo de F1 antes de aprobarla; F2 recibe el resto", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 200_000n });
    expect(f1.totalAnticipo).toBe(1_000_000n);

    const asignacion = await asignarAnticipoBorrador(
      f1.id,
      { modo: "MANUAL", anticipo: 700_000n, motivo: "Reparto con la 2.ª factura (motivo de prueba)" },
      adminId,
    );
    expect(asignacion.ok).toBe(true);
    if (asignacion.ok) {
      expect(asignacion.borrador?.totalAnticipo).toBe(700_000n);
      expect(asignacion.borrador?.anticipoManual).toBe(true);
    }

    // anticipoManual = true → la re-verificación al aprobar NO lo toca.
    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);
    if (aprobacionF1.ok) expect(aprobacionF1.borrador?.totalAnticipo).toBe(700_000n);

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 100_000n });
    expect(f2.totalAnticipo).toBe(300_000n);
  });
});

describe("B8-3 — dos borradores generados en paralelo, se aprueban en serie", () => {
  it("aprobar el segundo da 409 ANTICIPO_ACTUALIZADO y lo deja en 0; reintentar aprueba", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    const f1b = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    expect(f1.totalAnticipo).toBe(1_000_000n);
    expect(f1b.totalAnticipo).toBe(1_000_000n);

    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);

    const aprobacionF1b = await aprobar(f1b.id);
    expect(aprobacionF1b.ok).toBe(false);
    if (!aprobacionF1b.ok) {
      expect(aprobacionF1b.status).toBe(409);
      expect(aprobacionF1b.codigo).toBe("ANTICIPO_ACTUALIZADO");
    }

    const f1bActualizado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: f1b.id } });
    expect(f1bActualizado.totalAnticipo).toBe(0n);
    expect(f1bActualizado.estado).toBe(EstadoBorrador.EN_REVISION);

    const reintento = await transicionarBorrador({
      borradorId: f1b.id,
      nuevoEstado: EstadoBorrador.APROBADO,
      usuarioId: adminId,
    });
    expect(reintento.ok).toBe(true);
  });
});

describe("B8-4 — devolver un APROBADO libera su reserva", () => {
  it("F1 devuelto a BORRADOR ya no reserva; F2 recibe todo el anticipo", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);

    await devolverBorrador({
      borradorId: f1.id,
      usuarioId: adminId,
      rol: "ADMIN",
      observacion: "Devuelvo para revisar un dato (prueba B8-4)",
    });

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    expect(f2.totalAnticipo).toBe(1_000_000n);
  });
});

describe("B8-5 — anticipo nuevo aplicado después de generar", () => {
  it("aprobar recalcula con el anticipo nuevo y corta con 409 la primera vez", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    expect(f1.totalAnticipo).toBe(1_000_000n);
    const rev = await transicionarBorrador({ borradorId: f1.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    expect(rev.ok).toBe(true);

    // Anticipo nuevo aplicado al DO después de generar el borrador.
    await aplicarAnticipo(clienteConceptosId, tramiteId, 98_000n);

    const primerIntento = await transicionarBorrador({ borradorId: f1.id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(primerIntento.ok).toBe(false);
    if (!primerIntento.ok) expect(primerIntento.codigo).toBe("ANTICIPO_ACTUALIZADO");

    const actualizado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: f1.id } });
    expect(actualizado.totalAnticipo).toBe(1_098_000n);

    const segundoIntento = await transicionarBorrador({ borradorId: f1.id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(segundoIntento.ok).toBe(true);
  });
});

describe("B8-6 — reemisión tras nota crédito (excepción ADMIN con aviso)", () => {
  it("ADMIN puede asignar más de lo 'asignable' con motivo, y la respuesta trae el aviso", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);
    const facturado = await transicionarBorrador({
      borradorId: f1.id,
      nuevoEstado: EstadoBorrador.FACTURADO,
      usuarioId: adminId,
      numFacturaSiigo: `BAQ-VITEST-${RUN_ID.slice(-6)}`,
      fechaFactura: new Date(`${ANIO}-02-01`),
    });
    expect(facturado.ok).toBe(true);

    // El cliente pagó de más tras la nota crédito: llega un anticipo nuevo.
    await aplicarAnticipo(clienteConceptosId, tramiteId, 200_000n);

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 50_000n });
    expect(f2.totalAnticipo).toBe(200_000n); // asignable automático: 1.200.000 − 1.000.000

    const reemision = await asignarAnticipoBorrador(
      f2.id,
      { modo: "MANUAL", anticipo: 1_200_000n, motivo: "Reemplaza factura anulada con NC (prueba B8-6)" },
      adminId,
    );
    expect(reemision.ok).toBe(true);
    if (reemision.ok) {
      expect(reemision.borrador?.totalAnticipo).toBe(1_200_000n);
      expect(reemision.aviso).toBeTruthy();
    }
  });

  it("fuera de rango (> aplicadoDo) → 422 ANTICIPO_FUERA_DE_RANGO", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 500_000n);
    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 100_000n });

    const result = await asignarAnticipoBorrador(
      f1.id,
      { modo: "MANUAL", anticipo: 999_999_999n, motivo: "Motivo de prueba suficientemente largo" },
      adminId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.codigo).toBe("ANTICIPO_FUERA_DE_RANGO");
    }
  });

  it("modo AUTOMATICO vuelve a la regla estándar y limpia el motivo", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 500_000n);
    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 100_000n });

    await asignarAnticipoBorrador(f1.id, { modo: "MANUAL", anticipo: 100_000n, motivo: "Motivo de prueba, bien largo" }, adminId);
    const vuelta = await asignarAnticipoBorrador(f1.id, { modo: "AUTOMATICO" }, adminId);
    expect(vuelta.ok).toBe(true);
    if (vuelta.ok) {
      expect(vuelta.borrador?.totalAnticipo).toBe(500_000n);
      expect(vuelta.borrador?.anticipoManual).toBe(false);
      expect(vuelta.borrador?.anticipoMotivo).toBeNull();
    }
  });
});

describe("C1 (revisión de código, 28-sep-2026) — la manual abierta aparta su anticipo apenas se guarda", () => {
  /**
   * Reproduce P1 (Polyrec 26-0180) con los números reales: anticipo 1.098.000;
   * F1 "servicio principal" repartida a mano en 1.094.133 (su total exacto);
   * F2 "servicio adicional" automática. Escenario B: F2 se genera DESPUÉS de
   * que F1 ya quedó manual — con el arreglo nace viendo la reserva de F1.
   */
  async function prepararEscenarioP1TrasManual() {
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_098_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 200_000n });
    expect(f1.totalAnticipo).toBe(1_098_000n); // nadie lo ha repartido todavía

    const asignacion = await asignarAnticipoBorrador(
      f1.id,
      { modo: "MANUAL", anticipo: 1_094_133n, motivo: "Reparto a mano F1 = su total exacto (prueba C1 / P1)" },
      adminId,
    );
    expect(asignacion.ok).toBe(true);

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 50_000n });
    // Antes del arreglo esto nacía en 1.098.000 (F1 abierta no se contaba).
    expect(f2.totalAnticipo).toBe(3_867n);

    return { tramiteId, f1Id: f1.id, f2Id: f2.id };
  }

  async function sumaReservada(tramiteId: string) {
    const r = await prisma.borradorFactura.aggregate({
      where: { tramiteId, estado: { in: [EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] } },
      _sum: { totalAnticipo: true },
    });
    return r._sum.totalAnticipo ?? 0n;
  }

  it("orden A — aprobar primero F2 (automática) y luego F1 (manual): la suma reservada nunca pasa de lo aplicado", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, f1Id, f2Id } = await prepararEscenarioP1TrasManual();

    const aprobacionF2 = await aprobar(f2Id);
    expect(aprobacionF2.ok).toBe(true);
    if (aprobacionF2.ok) expect(aprobacionF2.borrador?.totalAnticipo).toBe(3_867n);

    const aprobacionF1 = await aprobar(f1Id);
    expect(aprobacionF1.ok).toBe(true);
    if (aprobacionF1.ok) expect(aprobacionF1.borrador?.totalAnticipo).toBe(1_094_133n); // no se toca: es manual

    expect(await sumaReservada(tramiteId)).toBe(1_098_000n); // == aplicado, nunca más
  });

  it("orden B — aprobar primero F1 (manual) y luego F2 (automática): la suma reservada nunca pasa de lo aplicado", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, f1Id, f2Id } = await prepararEscenarioP1TrasManual();

    const aprobacionF1 = await aprobar(f1Id);
    expect(aprobacionF1.ok).toBe(true);
    if (aprobacionF1.ok) expect(aprobacionF1.borrador?.totalAnticipo).toBe(1_094_133n);

    const aprobacionF2 = await aprobar(f2Id);
    expect(aprobacionF2.ok).toBe(true);
    if (aprobacionF2.ok) expect(aprobacionF2.borrador?.totalAnticipo).toBe(3_867n);

    expect(await sumaReservada(tramiteId)).toBe(1_098_000n);
  });

  it("dos aprobaciones simultáneas (manual + automática): nunca se reserva más de lo aplicado", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, f1Id, f2Id } = await prepararEscenarioP1TrasManual();

    await transicionarBorrador({ borradorId: f1Id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });

    const [r1, r2] = await Promise.all([
      transicionarBorrador({ borradorId: f1Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId }),
      transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId }),
    ]);

    // Las dos nacieron ya con el valor correcto (F2 vio la reserva de F1 al
    // generarse): el candado del DO las serializa sin que ninguna choque.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(await sumaReservada(tramiteId)).toBeLessThanOrEqual(1_098_000n);
    expect(await sumaReservada(tramiteId)).toBe(1_098_000n);
  });

  /**
   * Escenario tal cual lo describe la revisión: F2 nace ANTES de que ADMIN
   * reparta F1 a mano (las dos automáticas, con todo el anticipo); la
   * corrección llega al aprobar F2 (409 `ANTICIPO_ACTUALIZADO`), nunca antes
   * ni en silencio. Sin el arreglo, F2 se aprobaba con 1.098.000 completos y
   * F1 (manual) se aprobaba después sin ninguna revisión: 2.192.133
   * reservados sobre 1.098.000 reales.
   */
  async function prepararEscenarioP1AntesDeManual() {
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_098_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 200_000n });
    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 50_000n });
    expect(f1.totalAnticipo).toBe(1_098_000n);
    expect(f2.totalAnticipo).toBe(1_098_000n); // ninguna aprobada todavía: las dos ven todo

    const asignacion = await asignarAnticipoBorrador(
      f1.id,
      { modo: "MANUAL", anticipo: 1_094_133n, motivo: "Reparto a mano F1 = su total exacto (prueba C1 / P1)" },
      adminId,
    );
    expect(asignacion.ok).toBe(true);
    // F2 queda con el valor viejo (1.098.000) hasta que se re-verifique al aprobar.

    return { tramiteId, f1Id: f1.id, f2Id: f2.id };
  }

  it("F2 nació antes del reparto manual: al aprobarla primero recibe 409 y se corrige; nunca se reserva de más", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, f1Id, f2Id } = await prepararEscenarioP1AntesDeManual();

    const rev2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    expect(rev2.ok).toBe(true);

    const primerIntentoF2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(primerIntentoF2.ok).toBe(false);
    if (!primerIntentoF2.ok) expect(primerIntentoF2.codigo).toBe("ANTICIPO_ACTUALIZADO");

    const f2Actualizado = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: f2Id } });
    expect(f2Actualizado.totalAnticipo).toBe(3_867n); // corregido: 1.098.000 − 1.094.133

    const segundoIntentoF2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(segundoIntentoF2.ok).toBe(true);

    const aprobacionF1 = await aprobar(f1Id);
    expect(aprobacionF1.ok).toBe(true);
    if (aprobacionF1.ok) expect(aprobacionF1.borrador?.totalAnticipo).toBe(1_094_133n); // no se toca

    expect(await sumaReservada(tramiteId)).toBe(1_098_000n); // antes del arreglo: 2.192.133
  });

  it("F2 nació antes del reparto manual, pero se aprueba F1 (manual) primero: F2 igual recibe 409 al aprobarse después", async (ctx) => {
    ensureDb(ctx);
    const { tramiteId, f1Id, f2Id } = await prepararEscenarioP1AntesDeManual();

    const aprobacionF1 = await aprobar(f1Id);
    expect(aprobacionF1.ok).toBe(true);
    if (aprobacionF1.ok) expect(aprobacionF1.borrador?.totalAnticipo).toBe(1_094_133n);

    const rev2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    expect(rev2.ok).toBe(true);
    const primerIntentoF2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(primerIntentoF2.ok).toBe(false);
    if (!primerIntentoF2.ok) expect(primerIntentoF2.codigo).toBe("ANTICIPO_ACTUALIZADO");

    const segundoIntentoF2 = await transicionarBorrador({ borradorId: f2Id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId });
    expect(segundoIntentoF2.ok).toBe(true);

    expect(await sumaReservada(tramiteId)).toBe(1_098_000n);
  });
});

describe("Concurrencia — dos aprobaciones simultáneas del mismo DO", () => {
  it("una aprueba, la otra recibe 409 (candado del DO)", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    const f1b = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    await transicionarBorrador({ borradorId: f1.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });
    await transicionarBorrador({ borradorId: f1b.id, nuevoEstado: EstadoBorrador.EN_REVISION, usuarioId: adminId });

    const [r1, r2] = await Promise.all([
      transicionarBorrador({ borradorId: f1.id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId }),
      transicionarBorrador({ borradorId: f1b.id, nuevoEstado: EstadoBorrador.APROBADO, usuarioId: adminId }),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    expect(okCount).toBe(1);
  });
});

describe("Formato COMISION — sin cambio (fuera de alcance de B8)", () => {
  it("dos borradores del mismo DO en COMISION siguen contando el anticipo completo cada uno", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteComisionId);
    await aplicarAnticipo(clienteComisionId, tramiteId, 1_000_000n);

    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    const aprobacionF1 = await aprobar(f1.id);
    expect(aprobacionF1.ok).toBe(true);

    const f2 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 150_000n });
    // Comportamiento previo a B8, sin arreglar aquí a propósito.
    expect(f2.totalAnticipo).toBe(1_000_000n);
  });
});

describe("anticipoDelTramite (función de BD)", () => {
  it("aplicadoDo, reservadoPorOtras y asignable cuadran con lo esperado", async (ctx) => {
    ensureDb(ctx);
    const tramiteId = await crearTramite(clienteConceptosId);
    await aplicarAnticipo(clienteConceptosId, tramiteId, 900_000n);
    const f1 = await generarBorrador({ tramiteId, usuarioId: adminId, comision: 100_000n });
    await aprobar(f1.id);

    const info = await anticipoDelTramite(prisma, tramiteId);
    expect(info).toEqual({ aplicadoDo: 900_000n, reservadoPorOtras: 900_000n, asignable: 0n });

    const infoExcluyendoF1 = await anticipoDelTramite(prisma, tramiteId, { excluirBorradorId: f1.id });
    expect(infoExcluyendoF1).toEqual({ aplicadoDo: 900_000n, reservadoPorOtras: 0n, asignable: 900_000n });
  });
});
