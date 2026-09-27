/**
 * CxP v2 (P8) — concurrencia de los caminos que bajan o devuelven el saldo de
 * una factura de proveedor, contra Postgres real (CA-08, CA-43, R10, §B.5).
 *
 * Lo que se prueba aquí (todo con operaciones simultáneas de verdad):
 *  - CA-08: pago suelto, pago en bloque, "Generar pago", la entrada heredada
 *    (`facturaProveedorIds`) y el cruce de cuenta corriente sobre la MISMA
 *    factura a la vez → entra uno solo y el total aplicado nunca pasa del valor;
 *  - abonos simultáneos: si caben juntos, entran todos; si no, el que llega
 *    tarde recibe "solo le faltan" y nada queda a medias;
 *  - dos bloques que piden las mismas facturas en orden opuesto: sin deadlock
 *    (orden único DO → factura por id);
 *  - CA-43: doble (triple) clic con la misma clave → un solo bloque / pago y las
 *    repeticiones responden `repetido: true`, nunca 409 "ya está pagada";
 *  - R10: anular un bloque o borrar un pago suelto EN PARALELO con cerrar el DO
 *    → nunca queda un DO cerrado con una factura reabierta;
 *  - I1–I7 (verificador de P7b) sin violaciones sobre todo lo creado aquí.
 *
 * Requiere DATABASE_URL de una base desechable migrada con M1–M5 (+ seed).
 * Sin BD las pruebas se omiten, igual que el resto de pruebas de integración.
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  CanalPago,
  EstadoFacturaProveedor,
  EstadoPagoGrupo,
  EstadoTramite,
  OrigenMovimientoCuenta,
  Rol,
  RolCuenta,
  TipoCliente,
  TipoMovimientoCuenta,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearDocumentoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  type Fixture,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { MontoExcedeSaldoError } from "@/lib/cxp/errores";
import { verificarInvariantes } from "@/lib/cxp/invariantes";
import { estadoDe } from "@/lib/cxp/saldos";
import { registrarCompensacion } from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedor } from "@/lib/facturas-proveedor/service";
import { transitionTramite } from "@/lib/tramites/service";

import { generarPagoDesdeFactura } from "../generar-desde-factura";
import { anularPagoGrupo, crearPago, crearPagoMultiDO, eliminarPago } from "../service";

// ─── Utilidades ──────────────────────────────────────────────────────────────

/** Números de factura con dígitos únicos (el aviso POSIBLE_DUPLICADO compara dígitos). */
let consecutivoFactura = 0;
function numFactura(): string {
  consecutivoFactura += 1;
  return `FE-66${String(consecutivoFactura).padStart(4, "0")}`;
}

/** Facturas, pagos y bloques que crea este archivo (para revisar I1–I7 solo sobre ellos). */
const facturasCreadas = new Set<string>();

async function factura(db: Fixture, tramiteId: string, valor: bigint): Promise<string> {
  const id = await crearFacturaAlmacargaTest(db, tramiteId, numFactura(), valor);
  facturasCreadas.add(id);
  return id;
}

/** DO de Litoplas con anticipo suficiente (la función «Sin anticipo no hay pago» no estorba). */
async function doConAnticipo(db: Fixture, estado?: EstadoTramite): Promise<string> {
  const tramiteId = await crearTramiteTest(db, estado ? { estado } : {});
  await aplicarAnticipoTest(db, tramiteId, 5_000_000n);
  return tramiteId;
}

async function partes(facturaId: string) {
  const f = await prisma.facturaProveedor.findUniqueOrThrow({
    where: { id: facturaId },
    include: { pagos: { select: { monto: true } }, ajustes: { select: { monto: true } } },
  });
  const aplicado = f.pagos.reduce((s, p) => s + p.monto, 0n);
  const ajustes = f.ajustes.reduce((s, a) => s + a.monto, 0n);
  return {
    estado: f.estado,
    valor: f.valor,
    aplicado,
    ajustes,
    compensado: f.montoCompensado,
    saldo: f.valor - aplicado - ajustes - f.montoCompensado,
    esperado: estadoDe({ valor: f.valor, aplicado, ajustes, compensado: f.montoCompensado }),
  };
}

function mensaje(r: PromiseSettledResult<unknown>): string {
  if (r.status !== "rejected") return "";
  return r.reason instanceof Error ? r.reason.message : String(r.reason);
}

const RECHAZO_POR_SALDO = /ya está pagada|solo le faltan|no está pendiente|es mayor que lo que falta/;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

/** Movimientos de cuenta corriente de las empresas de prueba (FK Restrict: antes del fixture). */
async function borrarMovimientosDePrueba() {
  const empresas = await prisma.cliente.findMany({
    where: { nit: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  await prisma.movimientoCuenta.deleteMany({ where: { empresaId: { in: empresas.map((e) => e.id) } } });
}

beforeAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosDePrueba();
    } catch {
      // Sin BD: prepararBdAlmacarga deja el motivo del skip.
    }
  }
  await prepararBdAlmacarga();
});

afterAll(async () => {
  if (process.env.DATABASE_URL) {
    try {
      await borrarMovimientosDePrueba();
    } catch {
      // Sin BD no hay nada que limpiar.
    }
  }
  await liberarBdAlmacarga();
});

// ─── CA-08: todos los caminos a la vez sobre la misma factura ───────────────

describe("CA-08 — pagos simultáneos sobre la misma factura: entra uno solo", () => {
  it("pago suelto + pago en bloque + 'Generar pago' + entrada heredada, 4 rondas: una sola escritura gana, Σ aplicado = valor y la factura queda Pagada", async (ctx) => {
    const db = ensureDb(ctx);
    for (let ronda = 0; ronda < 4; ronda++) {
      const tramiteId = await doConAnticipo(db);
      const valor = 464_077n + BigInt(ronda);
      const facturaId = await factura(db, tramiteId, valor);
      const documentoId = await crearDocumentoTest(db, tramiteId);

      const caminos: Promise<unknown>[] = [
        crearPago({
          tramiteId,
          concepto: "Pago suelto concurrente",
          valor,
          canalPago: CanalPago.PSE,
          aplicaciones: [{ facturaProveedorId: facturaId, monto: valor }],
          usuarioId: db.userId,
        }),
        crearPagoMultiDO({
          beneficiarioId: db.almacargaBeneficiarioId,
          facturas: [{ facturaProveedorId: facturaId, monto: valor }],
          canalPago: CanalPago.PSE,
          documentoId,
          usuarioId: db.userId,
        }),
        generarPagoDesdeFactura({
          facturaProveedorId: facturaId,
          canalPago: CanalPago.PSE,
          viaSocio: false,
          usuarioId: db.userId,
        }),
        crearPago({
          tramiteId,
          concepto: "Pago heredado (MCP) concurrente",
          valor,
          canalPago: CanalPago.PSE,
          facturaProveedorIds: [facturaId],
          usuarioId: db.userId,
        }),
      ];
      // Rotar el orden de arranque para no favorecer siempre al mismo camino.
      const ordenados = caminos.slice(ronda).concat(caminos.slice(0, ronda));
      const resultados = await Promise.allSettled(ordenados);

      const ganadores = resultados.filter((r) => r.status === "fulfilled");
      expect(ganadores, `ronda ${ronda}`).toHaveLength(1);
      for (const r of resultados) {
        if (r.status === "rejected") expect(mensaje(r), `ronda ${ronda}`).toMatch(RECHAZO_POR_SALDO);
      }

      const p = await partes(facturaId);
      expect(p.aplicado).toBe(valor);
      expect(p.saldo).toBe(0n);
      expect(p.estado).toBe(EstadoFacturaProveedor.PAGADA);
      expect(p.estado).toBe(p.esperado);
      // Un solo pago en el DO (el perdedor no dejó pago huérfano ni cabecera de bloque).
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
      const grupos = await prisma.pagoTramite.findMany({
        where: { tramiteId, grupoPagoId: { not: null } },
        select: { grupoPagoId: true },
      });
      const gruposHuerfanos = await prisma.pagoGrupo.count({
        where: {
          beneficiarioId: db.almacargaBeneficiarioId,
          estado: EstadoPagoGrupo.ACTIVO,
          pagos: { none: {} },
        },
      });
      expect(grupos.length).toBeLessThanOrEqual(1);
      expect(gruposHuerfanos).toBe(0);
    }
  }, 60_000);

  it("cruce de cuenta corriente contra pago suelto en paralelo (factura no repercutible): uno solo salda la factura", async (ctx) => {
    const db = ensureDb(ctx);
    // Empresa que es cliente y proveedor a la vez (tipo Coldex), con cuenta corriente.
    const empresa = await prisma.cliente.create({
      data: {
        nombre: "COLDEX CONCURRENCIA",
        nit: `${TEST_PREFIX}-coldex-${runId}`,
        tipo: TipoCliente.PROPIO,
        esCliente: true,
        esProveedor: true,
      },
    });
    await prisma.empresaCapacidad.create({
      data: { empresaId: empresa.id, codigo: "cuenta_corriente", habilitado: true },
    });
    const ficha = await prisma.beneficiario.create({
      data: { nombre: "COLDEX", nit: `${TEST_PREFIX}-ben-coldex-${runId}`, empresaId: empresa.id },
    });
    // Coldex nos debe 1.000.000 (cargo manual como cliente): hay de dónde cruzar.
    await prisma.movimientoCuenta.create({
      data: {
        empresaId: empresa.id,
        rol: RolCuenta.CLIENTE,
        tipo: TipoMovimientoCuenta.CARGO,
        origen: OrigenMovimientoCuenta.CARGO_MANUAL,
        concepto: "Mensualidad de prueba",
        valor: 1_000_000n,
        fecha: new Date(Date.UTC(3003, 0, 15)),
        registradoPorId: db.userId,
      },
    });

    for (let ronda = 0; ronda < 3; ronda++) {
      const tramiteId = await doConAnticipo(db);
      const valor = 150_000n + BigInt(ronda);
      const creada = await crearFacturaProveedor({
        tramiteId,
        beneficiarioId: ficha.id,
        numFactura: numFactura(),
        valor,
        fecha: new Date(Date.UTC(3003, 1, 1)),
        repercutible: false,
        subidaPorId: db.userId,
      });
      facturasCreadas.add(creada.id);

      const cruce = registrarCompensacion({
        empresaId: empresa.id,
        fecha: new Date(Date.UTC(3003, 2, 1)),
        concepto: "Cruce concurrente",
        facturaProveedorId: creada.id,
        usuarioId: db.userId,
      });
      const pago = crearPago({
        tramiteId,
        concepto: "Pago suelto vs cruce",
        valor,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: creada.id, monto: valor }],
        usuarioId: db.userId,
      });
      const resultados = await Promise.allSettled(ronda % 2 === 0 ? [cruce, pago] : [pago, cruce]);

      expect(resultados.filter((r) => r.status === "fulfilled"), `ronda ${ronda}`).toHaveLength(1);
      for (const r of resultados) {
        if (r.status === "rejected") expect(mensaje(r), `ronda ${ronda}`).toMatch(RECHAZO_POR_SALDO);
      }
      const p = await partes(creada.id);
      expect(p.aplicado + p.compensado).toBe(valor);
      expect(p.aplicado === 0n || p.compensado === 0n).toBe(true);
      expect(p.estado).toBe(EstadoFacturaProveedor.PAGADA);
    }
  }, 60_000);
});

// ─── Abonos simultáneos ──────────────────────────────────────────────────────

describe("Abonos simultáneos (R3): nunca más que el saldo, y los que caben entran todos", () => {
  it("dos abonos que juntos pasan del saldo (300.000 + 300.000 sobre 464.077): uno entra, el otro recibe 'solo le faltan'", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    const facturaId = await factura(db, tramiteId, 464_077n);

    const resultados = await Promise.allSettled([
      generarPagoDesdeFactura({
        facturaProveedorId: facturaId,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        monto: 300_000n,
        usuarioId: db.userId,
      }),
      crearPago({
        tramiteId,
        concepto: "Abono simultáneo",
        valor: 300_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaId, monto: 300_000n }],
        usuarioId: db.userId,
      }),
    ]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === "rejected");
    expect(rechazo && rechazo.status === "rejected" ? rechazo.reason : null).toBeInstanceOf(MontoExcedeSaldoError);
    expect(mensaje(rechazo!)).toMatch(
      /^A la factura .+ solo le faltan \$164\.077 por pagar; no se le pueden aplicar \$300\.000\.$/,
    );

    const p = await partes(facturaId);
    expect(p.aplicado).toBe(300_000n);
    expect(p.saldo).toBe(164_077n);
    expect(p.estado).toBe(EstadoFacturaProveedor.PARCIAL);
    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
  });

  it("tres abonos simultáneos que caben (100.000 + 150.000 + 200.000 sobre 464.077): entran los tres y la factura queda Abonada con saldo 14.077", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    const facturaId = await factura(db, tramiteId, 464_077n);

    const resultados = await Promise.allSettled(
      [100_000n, 150_000n, 200_000n].map((monto) =>
        generarPagoDesdeFactura({
          facturaProveedorId: facturaId,
          canalPago: CanalPago.PSE,
          viaSocio: false,
          monto,
          usuarioId: db.userId,
        }),
      ),
    );
    expect(resultados.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const p = await partes(facturaId);
    expect(p.aplicado).toBe(450_000n);
    expect(p.saldo).toBe(14_077n);
    expect(p.estado).toBe(EstadoFacturaProveedor.PARCIAL);

    // El saldo exacto la cierra; un peso más, no.
    await expect(
      generarPagoDesdeFactura({
        facturaProveedorId: facturaId,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        monto: 14_078n,
        usuarioId: db.userId,
      }),
    ).rejects.toThrow("solo le faltan $14.077 por pagar; no se le pueden aplicar $14.078.");
    await generarPagoDesdeFactura({
      facturaProveedorId: facturaId,
      canalPago: CanalPago.PSE,
      viaSocio: false,
      usuarioId: db.userId,
    });
    const final = await partes(facturaId);
    expect(final.saldo).toBe(0n);
    expect(final.estado).toBe(EstadoFacturaProveedor.PAGADA);
  });
});

// ─── Bloques cruzados: orden de bloqueo único ───────────────────────────────

describe("Pagos en bloque con las mismas facturas en orden opuesto (§B.5)", () => {
  it("bloques [A,B] y [B,A] por el total a la vez: sin deadlock, uno gana y el otro recibe 'ya está pagada'", async (ctx) => {
    const db = ensureDb(ctx);
    const doA = await doConAnticipo(db);
    const doB = await doConAnticipo(db);
    const fa = await factura(db, doA, 433_361n);
    const fb = await factura(db, doB, 464_077n);
    const docA = await crearDocumentoTest(db, doA);
    const docB = await crearDocumentoTest(db, doB);

    const resultados = await Promise.allSettled([
      crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fa, monto: 433_361n },
          { facturaProveedorId: fb, monto: 464_077n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: docA,
        usuarioId: db.userId,
      }),
      crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fb, monto: 464_077n },
          { facturaProveedorId: fa, monto: 433_361n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: docB,
        usuarioId: db.userId,
      }),
    ]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const perdedor = resultados.find((r) => r.status === "rejected");
    expect(mensaje(perdedor!)).toMatch(/ya está pagada/);
    expect(mensaje(perdedor!)).not.toMatch(/deadlock/i);

    for (const [id, valor] of [
      [fa, 433_361n],
      [fb, 464_077n],
    ] as const) {
      const p = await partes(id);
      expect(p.aplicado).toBe(valor);
      expect(p.estado).toBe(EstadoFacturaProveedor.PAGADA);
    }
  }, 30_000);

  it("bloques [A,B] y [B,A] con abonos que caben juntos: entran los dos, sin deadlock, y ambas facturas quedan Abonadas con el saldo exacto", async (ctx) => {
    const db = ensureDb(ctx);
    const doA = await doConAnticipo(db);
    const doB = await doConAnticipo(db);
    const fa = await factura(db, doA, 400_000n);
    const fb = await factura(db, doB, 500_000n);
    const docA = await crearDocumentoTest(db, doA);
    const docB = await crearDocumentoTest(db, doB);

    const resultados = await Promise.allSettled([
      crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fa, monto: 100_000n },
          { facturaProveedorId: fb, monto: 200_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: docA,
        usuarioId: db.userId,
      }),
      crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fb, monto: 250_000n },
          { facturaProveedorId: fa, monto: 150_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: docB,
        usuarioId: db.userId,
      }),
    ]);
    expect(resultados.map((r) => [r.status, mensaje(r)])).toEqual([
      ["fulfilled", ""],
      ["fulfilled", ""],
    ]);
    const pa = await partes(fa);
    const pb = await partes(fb);
    expect([pa.saldo, pa.estado]).toEqual([150_000n, EstadoFacturaProveedor.PARCIAL]);
    expect([pb.saldo, pb.estado]).toEqual([50_000n, EstadoFacturaProveedor.PARCIAL]);
  }, 30_000);
});

// ─── CA-43: idempotencia bajo doble / triple clic ───────────────────────────

describe("CA-43 — doble clic simultáneo con la misma clave", () => {
  it("tres envíos simultáneos del mismo bloque: un solo bloque, los otros dos `repetido: true` (nunca 409 'ya está pagada')", async (ctx) => {
    const db = ensureDb(ctx);
    const doA = await doConAnticipo(db);
    const doB = await doConAnticipo(db);
    const fa = await factura(db, doA, 433_361n);
    const fb = await factura(db, doB, 464_077n);
    const documentoId = await crearDocumentoTest(db, doA);
    const clave = randomUUID();
    const entrada = {
      beneficiarioId: db.almacargaBeneficiarioId,
      facturas: [
        { facturaProveedorId: fa, monto: 433_361n },
        { facturaProveedorId: fb, monto: 200_000n },
      ],
      canalPago: CanalPago.PSE,
      documentoId,
      claveIdempotencia: clave,
      usuarioId: db.userId,
    };

    const resultados = await Promise.allSettled([
      crearPagoMultiDO(entrada),
      crearPagoMultiDO(entrada),
      crearPagoMultiDO(entrada),
    ]);
    expect(resultados.map((r) => [r.status, mensaje(r)])).toEqual([
      ["fulfilled", ""],
      ["fulfilled", ""],
      ["fulfilled", ""],
    ]);
    const valores = resultados.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(new Set(valores.map((v) => v.grupoPagoId)).size).toBe(1);
    expect(valores.map((v) => v.repetido).sort()).toEqual([false, true, true]);
    expect(await prisma.pagoGrupo.count({ where: { claveIdempotencia: clave } })).toBe(1);
    expect(await prisma.pagoTramite.count({ where: { tramiteId: { in: [doA, doB] } } })).toBe(2);
    expect((await partes(fa)).aplicado).toBe(433_361n);
    expect((await partes(fb)).aplicado).toBe(200_000n);
    expect((await partes(fb)).estado).toBe(EstadoFacturaProveedor.PARCIAL);
  }, 30_000);

  it("tres envíos simultáneos del mismo pago suelto: un solo pago, mismo id en las tres respuestas", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await doConAnticipo(db);
    const facturaId = await factura(db, tramiteId, 300_000n);
    const clave = randomUUID();
    const entrada = {
      tramiteId,
      concepto: "Pago suelto con doble clic",
      valor: 300_000n,
      canalPago: CanalPago.PSE,
      aplicaciones: [{ facturaProveedorId: facturaId, monto: 300_000n }],
      claveIdempotencia: clave,
      usuarioId: db.userId,
    };
    const resultados = await Promise.allSettled([crearPago(entrada), crearPago(entrada), crearPago(entrada)]);
    expect(resultados.map((r) => [r.status, mensaje(r)])).toEqual([
      ["fulfilled", ""],
      ["fulfilled", ""],
      ["fulfilled", ""],
    ]);
    const pagos = resultados.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(new Set(pagos.map((p) => p.id)).size).toBe(1);
    expect(pagos.map((p) => p.repetido).sort()).toEqual([false, true, true]);
    expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
    expect((await partes(facturaId)).aplicado).toBe(300_000n);
  }, 30_000);
});

// ─── R10: anular / borrar contra cerrar el DO ────────────────────────────────

describe("R10 — anular un bloque o borrar un pago en paralelo con cerrar el DO", () => {
  it("anularPagoGrupo ∥ cerrar el DO, 4 rondas: gana exactamente uno y nunca queda un DO cerrado con una factura reabierta", async (ctx) => {
    const db = ensureDb(ctx);
    let ganoAnulacion = 0;
    let ganoCierre = 0;
    for (let ronda = 0; ronda < 4; ronda++) {
      const tramiteId = await doConAnticipo(db, EstadoTramite.PAGADO);
      const facturaId = await factura(db, tramiteId, 250_000n + BigInt(ronda));
      const documentoId = await crearDocumentoTest(db, tramiteId);
      const bloque = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: facturaId, monto: 250_000n + BigInt(ronda) }],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      });

      // Se alterna cuál arranca primero.
      const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const anular = (async () => {
        if (ronda % 2 === 1) await esperar(1);
        return anularPagoGrupo(bloque.grupoPagoId, "Anulación concurrente con el cierre", db.userId);
      })();
      const cerrar = (async () => {
        if (ronda % 2 === 0) await esperar(1);
        return transitionTramite(tramiteId, EstadoTramite.CERRADO, db.userId, false, Rol.ADMIN);
      })();
      const [ra, rc] = await Promise.allSettled([anular, cerrar] as const);

      expect(rc.status, `ronda ${ronda}`).toBe("fulfilled");
      const cierreOk = rc.status === "fulfilled" && rc.value.ok;
      const anulacionOk = ra.status === "fulfilled";
      expect(cierreOk !== anulacionOk, `ronda ${ronda}: gana exactamente uno`).toBe(true);

      const tramite = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } });
      const grupo = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: bloque.grupoPagoId } });
      const p = await partes(facturaId);
      if (cierreOk) {
        ganoCierre += 1;
        expect(mensaje(ra)).toMatch(/está cerrado/);
        expect(tramite.estado).toBe(EstadoTramite.CERRADO);
        expect(grupo.estado).toBe(EstadoPagoGrupo.ACTIVO);
        expect(p.estado).toBe(EstadoFacturaProveedor.PAGADA);
      } else {
        ganoAnulacion += 1;
        expect(rc.status === "fulfilled" && !rc.value.ok ? rc.value.message : "").toMatch(
          /factura de proveedor sin pagar/,
        );
        expect(tramite.estado).toBe(EstadoTramite.PAGADO);
        expect(grupo.estado).toBe(EstadoPagoGrupo.ANULADO);
        expect(p.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
        expect(p.saldo).toBe(p.valor);
      }
      // La regla que importa, pase lo que pase.
      expect(tramite.estado === EstadoTramite.CERRADO && p.saldo > 0n).toBe(false);
    }
    expect(ganoAnulacion + ganoCierre).toBe(4);
  }, 60_000);

  it("eliminarPago (pago suelto) ∥ cerrar el DO, 4 rondas: nunca queda un DO cerrado con la factura reabierta", async (ctx) => {
    const db = ensureDb(ctx);
    for (let ronda = 0; ronda < 4; ronda++) {
      const tramiteId = await doConAnticipo(db, EstadoTramite.PAGADO);
      const valor = 120_000n + BigInt(ronda);
      const facturaId = await factura(db, tramiteId, valor);
      const pago = await crearPago({
        tramiteId,
        concepto: "Pago suelto que se borra",
        valor,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaId, monto: valor }],
        usuarioId: db.userId,
      });

      const borrar = eliminarPago(pago.id, db.userId);
      const cerrar = transitionTramite(tramiteId, EstadoTramite.CERRADO, db.userId, false, Rol.ADMIN);
      const [rb, rc] = await Promise.allSettled([borrar, cerrar]);

      expect(rc.status, `ronda ${ronda}`).toBe("fulfilled");
      const cierreOk = rc.status === "fulfilled" && rc.value.ok;
      const borradoOk = rb.status === "fulfilled";
      expect(cierreOk !== borradoOk, `ronda ${ronda}: gana exactamente uno`).toBe(true);

      const tramite = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } });
      const p = await partes(facturaId);
      const quedaPago = (await prisma.pagoTramite.count({ where: { id: pago.id } })) === 1;
      if (cierreOk) {
        expect(tramite.estado).toBe(EstadoTramite.CERRADO);
        expect(quedaPago).toBe(true);
        expect(p.estado).toBe(EstadoFacturaProveedor.PAGADA);
      } else {
        expect(tramite.estado).toBe(EstadoTramite.PAGADO);
        expect(quedaPago).toBe(false);
        expect(p.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
      }
      expect(tramite.estado === EstadoTramite.CERRADO && p.saldo > 0n).toBe(false);
    }
  }, 60_000);
});

// ─── I1–I7 sobre todo lo que creó este archivo ───────────────────────────────

describe("CA-30v2 — invariantes después de las carreras", () => {
  it("I1–I7 = 0 violaciones sobre las facturas, pagos y bloques de este archivo; estado = estadoDe(partes) en todas", async (ctx) => {
    const db = ensureDb(ctx);
    const ids = [...facturasCreadas];
    expect(ids.length).toBeGreaterThan(20);

    for (const id of ids) {
      const p = await partes(id);
      expect(p.aplicado + p.ajustes + p.compensado <= p.valor, id).toBe(true);
      expect(p.estado, id).toBe(p.esperado);
    }

    const tramites = await prisma.facturaProveedor.findMany({
      where: { id: { in: ids } },
      select: { tramiteId: true },
    });
    const pagos = await prisma.pagoTramite.findMany({
      where: { tramiteId: { in: tramites.map((t) => t.tramiteId) } },
      select: { id: true, grupoPagoId: true },
    });
    const propios = new Set<string>([
      ...ids,
      ...pagos.map((p) => p.id),
      ...pagos.flatMap((p) => (p.grupoPagoId ? [p.grupoPagoId] : [])),
      `BEN:${db.almacargaBeneficiarioId}`,
    ]);

    const informe = await verificarInvariantes();
    const violacionesPropias = informe.violaciones.filter((h) => propios.has(h.id));
    expect(violacionesPropias).toEqual([]);
    // Los guardianes de M5 deben estar encendidos en esta base.
    expect(informe.avisos.filter((h) => h.invariante === "GUARDIAN")).toEqual([]);
  }, 60_000);
});
