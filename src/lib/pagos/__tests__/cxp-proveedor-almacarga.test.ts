/**
 * Pruebas de aceptación — Cartera de proveedor Almacarga/Express (CxP proveedor)
 *
 * Referencia: PRD-ALMACARGA-CXP-PROVEEDOR.md (v1.1, 2026-09-23), §9 criterios
 * de aceptación (CA-01..CA-30). Nació contra `e5cd35b` documentando las
 * brechas con `it.fails`; con CxP v2 (P1: saldo por montos, `aplicarSaldo`
 * como única puerta, guardián de BD M5, bloque con cabecera) las brechas de
 * pagos quedaron cerradas y sus pruebas son `it` normales (0 `it.fails`).
 *
 * Requiere PostgreSQL local en :5433 con DATABASE_URL definida (base de
 * pruebas desechable, nunca la de simulación ni producción). Si la BD no está
 * disponible, todos los tests se omiten (skip) — mismo patrón que
 * src/lib/pagos/__tests__/service.test.ts.
 *
 * Convención de este archivo:
 *  - `describe` normal + `it` normal  → el criterio YA funciona hoy: debe
 *    pasar en verde. Si falla de verdad, es un hallazgo nuevo, no un motivo
 *    para convertirlo en `it.fails` sin más.
 *  - `describe("CA-xx (v2) …")` → criterio que era brecha en e5cd35b y que
 *    CxP v2 cerró; afirma el comportamiento del PRD con el mensaje exacto.
 *
 * TEST_PREFIX único: "vitest-cxp-almacarga"
 * Año de datos de prueba: 3003 (no colisiona con datos reales ni con otros
 * archivos de test, que usan 3002).
 */
import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  CanalPago,
  EstadoFacturaProveedor,
  TipoCliente,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FacturaSinSaldoError,
  IdempotenciaConflictoError,
  MontoExcedeSaldoError,
  PagoNoEditableError,
} from "@/lib/cxp/errores";
import { estadoDe } from "@/lib/cxp/saldos";

import {
  aplicarAnticipoTest,
  crearBorradorFacturadoConLinea,
  crearDocumentoTest,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  pendienteAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { getCuentaCorriente } from "@/lib/cuenta-corriente/service";
import { prisma } from "@/lib/db/prisma";
import { generarPagoDesdeFactura } from "../generar-desde-factura";
import {
  actualizarPago,
  anularPagoGrupo,
  crearPago,
  crearPagoMultiDO,
  eliminarPago,
  getLibroPagos,
  listarFacturasElegiblesMultiDO,
} from "../service";

// Fixtures (constantes, createFixture, crearTramiteTest, …): extraídos tal cual a
// src/lib/cxp/__tests__/fixtures/almacarga.ts (CxP v2, P0). CA-02, CA-15, CA-18 y
// CA-28 se movieron tal cual a
// src/lib/facturas-proveedor/__tests__/cxp-facturas-almacarga.test.ts (dueño P2).

// ─── Setup / Teardown ────────────────────────────────────────────────────────

describe("CxP proveedor Almacarga/Express — PRD-ALMACARGA-CXP-PROVEEDOR §9", () => {
  beforeAll(prepararBdAlmacarga);

  afterAll(liberarBdAlmacarga);

  // ═══════════════════════════════════════════════════════════════════════
  // CA-01 (RF-01, RF-02) — la factura viaja sola a la ficha del proveedor
  // ═══════════════════════════════════════════════════════════════════════
  describe("CA-01 — la factura viaja a la ficha de Almacarga y el pendiente sube exacto", () => {
    it("registrar FE-99999 (100.000) en un DO de Litoplas la hace aparecer en la ficha de Almacarga; pendiente sube exactamente 100.000", async (ctx) => {
      const db = ensureDb(ctx);

      // Empresa + beneficiario aislados (no los del "Caso real" más abajo,
      // que comparten `db.almacargaClienteId`) para que este total sea
      // exacto y no dependa del orden de ejecución de los demás describes.
      const empresaCa01 = await prisma.cliente.create({
        data: {
          nombre: `ALMACENADORA DE CARGA "ALMACARGA" S.A.S`,
          nit: `${TEST_PREFIX}-almacarga-ca01-${runId}`,
          tipo: TipoCliente.PROPIO,
          esCliente: false,
          esProveedor: true,
        },
      });
      const almacargaCa01 = await prisma.beneficiario.create({
        data: {
          nombre: "ALMACARGA (CA-01)",
          nit: `${TEST_PREFIX}-ben-almacarga-ca01-${runId}`,
          empresaId: empresaCa01.id,
        },
      });

      const pendienteAntes = await listarFacturasElegiblesMultiDO(almacargaCa01.id);
      expect(pendienteAntes).toHaveLength(0);

      const tramiteId = await crearTramiteTest(db);
      const facturaId = await crearFacturaAlmacargaTest(
        db,
        tramiteId,
        "FE-99999",
        100_000n,
        almacargaCa01.id,
      );

      const elegibles = await listarFacturasElegiblesMultiDO(almacargaCa01.id);
      expect(elegibles).toHaveLength(1);
      const fila = elegibles.find((f) => f.id === facturaId);
      expect(fila).toBeDefined();
      expect(fila?.numFactura).toBe("FE-99999");
      expect(fila?.clienteNombre).toBe("LITOPLAS SA");
      expect(fila?.tramiteId).toBe(tramiteId);

      const pendienteDespues = elegibles.reduce((s, f) => s + f.valor, 0n);
      expect(pendienteDespues).toBe(100_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Caso real: los 4 DOs de Litoplas + Almacarga + Express, tal como están
  // sembrados en producción (23-sep-2026), sin la conciliación de arranque
  // (fuera de alcance de esta pasada — RF-23/B0 no está en la lista pedida).
  // ═══════════════════════════════════════════════════════════════════════
  describe("Caso real Litoplas–Almacarga–Express (DO.BAQ26-0069/0226/0238/0255)", () => {
    let tramite0069: string;
    let tramite0226: string;
    let tramite0238: string;
    let tramite0255: string;
    let fe11298: string;
    let fe12334: string;
    let fe12481: string;
    let fe12539: string;
    let fe6353: string;
    let grupoPagoBloque: string;
    let pago0226: string;
    let pago0238: string;
    let pago0255: string;

    it("CA-03 — foto de hoy: la ficha de Almacarga muestra 4 facturas por 1.861.616; FE-6353 de Express no aparece", async (ctx) => {
      const db = ensureDb(ctx);

      tramite0069 = await crearTramiteTest(db);
      tramite0226 = await crearTramiteTest(db);
      tramite0238 = await crearTramiteTest(db);
      tramite0255 = await crearTramiteTest(db);

      await aplicarAnticipoTest(db, tramite0069, 1_418_000n);
      await aplicarAnticipoTest(db, tramite0226, 1_204_000n);
      await aplicarAnticipoTest(db, tramite0238, 855_000n);
      await aplicarAnticipoTest(db, tramite0255, 869_000n);

      fe11298 = await crearFacturaAlmacargaTest(db, tramite0069, "FE-11298", 502_801n);
      fe12334 = await crearFacturaAlmacargaTest(db, tramite0226, "FE-12334", 433_361n);
      fe12481 = await crearFacturaAlmacargaTest(db, tramite0238, "FE-12481", 464_077n);
      fe12539 = await crearFacturaAlmacargaTest(db, tramite0255, "FE-12539", 461_377n);
      fe6353 = await crearFacturaAlmacargaTest(
        db,
        tramite0069,
        "FE-6353",
        99_484n,
        db.expressBeneficiarioId,
      );

      const almacargaElegibles = await listarFacturasElegiblesMultiDO(
        db.almacargaBeneficiarioId,
      );
      expect(almacargaElegibles).toHaveLength(4);
      const totalAlmacarga = almacargaElegibles.reduce((s, f) => s + f.valor, 0n);
      expect(totalAlmacarga).toBe(1_861_616n);
      expect(almacargaElegibles.map((f) => f.numFactura).sort()).toEqual(
        ["FE-11298", "FE-12334", "FE-12481", "FE-12539"].sort(),
      );
      expect(almacargaElegibles.some((f) => f.numFactura === "FE-6353")).toBe(false);

      const expressElegibles = await listarFacturasElegiblesMultiDO(
        db.expressBeneficiarioId,
      );
      expect(expressElegibles).toHaveLength(1);
      expect(expressElegibles[0].numFactura).toBe("FE-6353");
      expect(expressElegibles[0].id).toBe(fe6353);
      expect(expressElegibles[0].valor).toBe(99_484n);

      // Vía cuenta corriente (§7.2): pendienteProveedor solo suma REGISTRADA
      // (RF-03 🟡, así es hoy) — debe coincidir con el mismo total.
      const cuentaAlmacarga = await getCuentaCorriente(db.almacargaClienteId);
      expect(cuentaAlmacarga.pendienteProveedor).toBe(1_861_616n);
    });

    it("pagos reales Tampa (486.075 en 0069) y VUCE (83.800 en 0226) bajan el saldo del DO sin tocar la cartera de Almacarga", async (ctx) => {
      const db = ensureDb(ctx);

      await crearPago({
        tramiteId: tramite0069,
        concepto: "Flete Tampa Cargo",
        valor: 486_075n,
        canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        beneficiarioIds: [db.tampaBeneficiarioId],
        usuarioId: db.userId,
      });
      await crearPago({
        tramiteId: tramite0226,
        concepto: "VUCE",
        valor: 83_800n,
        canalPago: CanalPago.PSE,
        beneficiarioIds: [db.vuceBeneficiarioId],
        usuarioId: db.userId,
      });

      // Estos pagos NO están vinculados a ninguna FacturaProveedor de
      // Almacarga: el pendiente de Almacarga no cambia.
      expect(await pendienteAlmacarga()).toBe(1_861_616n);

      const libro0069 = await getLibroPagos(tramite0069);
      expect(libro0069.saldoFinal).toBe(1_418_000n - 486_075n); // 931.925

      const libro0226 = await getLibroPagos(tramite0226);
      expect(libro0226.saldoFinal).toBe(1_204_000n - 83_800n); // 1.120.200
    });

    it("reparto del pago en bloque (FE-12334+FE-12481+FE-12539): 3 pagos con el mismo grupoPagoId, costo bancario solo en uno, pendiente baja a 502.801 (FE-11298 queda)", async (ctx) => {
      const db = ensureDb(ctx);

      const documentoId = await crearDocumentoTest(db, tramite0226);

      const resultado = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fe12334, monto: 433_361n },
          { facturaProveedorId: fe12481, monto: 464_077n },
          { facturaProveedorId: fe12539, monto: 461_377n },
        ],
        canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        concepto: "Pago almacenajes sep-2026",
        documentoId,
        usuarioId: db.userId,
      });

      grupoPagoBloque = resultado.grupoPagoId;
      expect(resultado.pagos).toHaveLength(3);
      for (const p of resultado.pagos) {
        expect(p.grupoPagoId).toBe(grupoPagoBloque);
        expect(p.documentoId).toBe(documentoId);
      }

      const total = resultado.pagos.reduce((s, p) => s + p.valor, 0n);
      expect(total).toBe(1_358_815n);

      pago0226 = resultado.pagos.find((p) => p.tramiteId === tramite0226)!.id;
      pago0238 = resultado.pagos.find((p) => p.tramiteId === tramite0238)!.id;
      pago0255 = resultado.pagos.find((p) => p.tramiteId === tramite0255)!.id;
      expect(pago0226).toBeTruthy();
      expect(pago0238).toBeTruthy();
      expect(pago0255).toBeTruthy();

      expect(resultado.pagos.find((p) => p.id === pago0226)!.valor).toBe(433_361n);
      expect(resultado.pagos.find((p) => p.id === pago0238)!.valor).toBe(464_077n);
      expect(resultado.pagos.find((p) => p.id === pago0255)!.valor).toBe(461_377n);

      // Costo bancario (canal TRANSF_BANCOLOMBIA = 3.900) solo en el primer
      // pago del grupo (orden de iteración = orden en que aparecen las
      // facturas: FE-12334 es de tramite0226, así que 0226 se lo lleva).
      expect(resultado.pagos.find((p) => p.id === pago0226)!.costoBancario).toBe(3_900n);
      expect(resultado.pagos.find((p) => p.id === pago0238)!.costoBancario).toBe(0n);
      expect(resultado.pagos.find((p) => p.id === pago0255)!.costoBancario).toBe(0n);

      // Las 3 facturas quedan PAGADA; FE-11298 sigue REGISTRADA.
      for (const fpId of [fe12334, fe12481, fe12539]) {
        const fp = await prisma.facturaProveedor.findUnique({ where: { id: fpId } });
        expect(fp?.estado).toBe(EstadoFacturaProveedor.PAGADA);
      }
      const fe11298Actual = await prisma.facturaProveedor.findUnique({ where: { id: fe11298 } });
      expect(fe11298Actual?.estado).toBe(EstadoFacturaProveedor.REGISTRADA);

      // Pendiente de Almacarga: solo FE-11298 (502.801).
      const elegibles = await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId);
      expect(elegibles).toHaveLength(1);
      expect(elegibles[0].numFactura).toBe("FE-11298");
      expect(elegibles[0].valor).toBe(502_801n);
      expect(await pendienteAlmacarga()).toBe(502_801n);

      // Saldos de cada DO = anticipo − Σ pagos (el costo bancario no se resta).
      const libro0226 = await getLibroPagos(tramite0226);
      expect(libro0226.saldoFinal).toBe(686_839n); // 1.204.000 − 83.800 − 433.361

      const libro0238 = await getLibroPagos(tramite0238);
      expect(libro0238.saldoFinal).toBe(390_923n); // 855.000 − 464.077

      const libro0255 = await getLibroPagos(tramite0255);
      expect(libro0255.saldoFinal).toBe(407_623n); // 869.000 − 461.377
    });

    it("CA-22 — cada DO del bloque muestra su pago con el mismo comprobante y los otros DOs del grupo", async (ctx) => {
      ensureDb(ctx);

      const libro0226 = await getLibroPagos(tramite0226);
      const fila0226 = libro0226.pagos.find((p) => p.id === pago0226)!;
      expect(fila0226.grupoOtrosDOs.map((d) => d.tramiteId).sort()).toEqual(
        [tramite0238, tramite0255].sort(),
      );

      const libro0238 = await getLibroPagos(tramite0238);
      const fila0238 = libro0238.pagos.find((p) => p.id === pago0238)!;
      expect(fila0238.grupoOtrosDOs.map((d) => d.tramiteId).sort()).toEqual(
        [tramite0226, tramite0255].sort(),
      );
      // Mismo comprobante en todo el grupo.
      expect(fila0238.documentoId).toBe(fila0226.documentoId);

      const libro0255 = await getLibroPagos(tramite0255);
      const fila0255 = libro0255.pagos.find((p) => p.id === pago0255)!;
      expect(fila0255.grupoOtrosDOs.map((d) => d.tramiteId).sort()).toEqual(
        [tramite0226, tramite0238].sort(),
      );
      expect(fila0255.documentoId).toBe(fila0226.documentoId);
    });

    it("CA-11 — factura ya en un borrador FACTURADO se puede pagar; no sale del pendiente por estar facturada", async (ctx) => {
      const db = ensureDb(ctx);

      const tramiteX = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteX, 500_000n);
      const facturaX = await crearFacturaAlmacargaTest(db, tramiteX, "FE-BAQ11", 300_000n);

      // La factura ya salió en la factura de venta de Litoplas (borrador
      // FACTURADO) ANTES de pagarse — RF-12: son eventos independientes.
      await crearBorradorFacturadoConLinea(tramiteX, facturaX, 300_000n, "BAQ-99001");

      // Sigue pendiente para Almacarga aunque ya esté facturada al cliente.
      const antesDePagar = await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId);
      expect(antesDePagar.some((f) => f.id === facturaX)).toBe(true);

      // Se puede pagar sin ningún bloqueo.
      const pago = await crearPago({
        tramiteId: tramiteX,
        concepto: "Pago FE-BAQ11 (ya facturada a Litoplas)",
        valor: 300_000n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [facturaX],
        usuarioId: db.userId,
      });
      expect(pago.id).toBeTruthy();

      const facturaActualizada = await prisma.facturaProveedor.findUnique({
        where: { id: facturaX },
      });
      expect(facturaActualizada?.estado).toBe(EstadoFacturaProveedor.PAGADA);

      // Ya pagada: sale del listado de pendientes (que solo trae REGISTRADA).
      const despuesDePagar = await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId);
      expect(despuesDePagar.some((f) => f.id === facturaX)).toBe(false);
    });

    it("CA-24 — dos facturas en el mismo DO: pagar una deja la otra pendiente", async (ctx) => {
      const db = ensureDb(ctx);

      const tramite0141 = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramite0141, 200_000n);
      const fe90001 = await crearFacturaAlmacargaTest(db, tramite0141, "FE-90001", 100_000n);
      const fe90002 = await crearFacturaAlmacargaTest(db, tramite0141, "FE-90002", 26_180n);

      const resultado = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: fe90001, monto: 100_000n }],
        canalPago: CanalPago.PSE,
        documentoId: await crearDocumentoTest(db, tramite0141),
        usuarioId: db.userId,
      });

      expect(resultado.pagos).toHaveLength(1);
      expect(resultado.pagos[0].valor).toBe(100_000n);
      const vinculos = await prisma.pagoTramiteFactura.findMany({
        where: { pagoId: resultado.pagos[0].id },
      });
      expect(vinculos.map((v) => v.facturaId)).toEqual([fe90001]);

      const fe90001Final = await prisma.facturaProveedor.findUnique({ where: { id: fe90001 } });
      expect(fe90001Final?.estado).toBe(EstadoFacturaProveedor.PAGADA);

      const fe90002Final = await prisma.facturaProveedor.findUnique({ where: { id: fe90002 } });
      expect(fe90002Final?.estado).toBe(EstadoFacturaProveedor.REGISTRADA);

      const elegibles = await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId);
      const filaFe90002 = elegibles.find((f) => f.id === fe90002);
      expect(filaFe90002).toBeDefined();
      expect(filaFe90002?.valor).toBe(26_180n);
    });

    it("CA-13 (v2) — borrar un pago del bloque se rechaza: hay que anular el bloque completo", async (ctx) => {
      const db = ensureDb(ctx);
      await expect(eliminarPago(pago0238, db.userId)).rejects.toThrow(
        "Este pago es parte de un pago en bloque (3 DOs); para quitarlo, anula el bloque completo desde la ficha del proveedor.",
      );
      expect(await prisma.pagoTramite.findUnique({ where: { id: pago0238 } })).not.toBeNull();
    });

    it("CA-12 — anular el bloque completo (ADMIN, motivo) devuelve las 3 facturas y los saldos de los DOs: 1.120.200 / 855.000 / 869.000", async (ctx) => {
      const db = ensureDb(ctx);

      await expect(anularPagoGrupo(grupoPagoBloque, "corto", db.userId)).rejects.toThrow(/al menos 10 caracteres/);

      const r = await anularPagoGrupo(grupoPagoBloque, "Se registró con el comprobante equivocado", db.userId);
      expect(r.facturasReabiertas.sort()).toEqual([fe12334, fe12481, fe12539].sort());

      for (const fpId of [fe12334, fe12481, fe12539]) {
        const fp = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fpId } });
        expect(fp.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
        expect(await prisma.pagoTramiteFactura.count({ where: { facturaId: fpId } })).toBe(0);
      }
      // Pendiente de las 4 facturas del caso real otra vez completo.
      const elegibles = await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId);
      const delCaso = elegibles.filter((f) => [fe11298, fe12334, fe12481, fe12539].includes(f.id));
      expect(delCaso.reduce((s, f) => s + f.saldo, 0n)).toBe(1_861_616n);

      expect((await getLibroPagos(tramite0226)).saldoFinal).toBe(1_120_200n);
      expect((await getLibroPagos(tramite0238)).saldoFinal).toBe(855_000n);
      expect((await getLibroPagos(tramite0255)).saldoFinal).toBe(869_000n);

      const grupo = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: grupoPagoBloque } });
      expect(grupo.estado).toBe("ANULADO");
      expect(grupo.motivoAnulacion).toBe("Se registró con el comprobante equivocado");
      expect(grupo.totalAplicado).toBe(1_358_815n); // se conserva para el historial
      expect(await prisma.pagoTramite.count({ where: { grupoPagoId: grupoPagoBloque } })).toBe(0);

      // Anular dos veces no hace nada más.
      await expect(
        anularPagoGrupo(grupoPagoBloque, "Segundo intento de anulación", db.userId),
      ).rejects.toThrow(/ya está anulado/);

      // Y las facturas se pueden volver a pagar (una vez).
      const nuevo = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fe12334, monto: 433_361n },
          { facturaProveedorId: fe12481, monto: 464_077n },
          { facturaProveedorId: fe12539, monto: 461_377n },
        ],
        canalPago: CanalPago.TRANSF_BANCOLOMBIA,
        documentoId: await crearDocumentoTest(db, tramite0226),
        usuarioId: db.userId,
      });
      expect(nuevo.pagos.reduce((s, p) => s + p.valor, 0n)).toBe(1_358_815n);
    });

    it("CA-12 (DO cerrado) — un bloque que toca un DO CERRADO no se anula y no cambia nada", async (ctx) => {
      const db = ensureDb(ctx);
      const tA = await crearTramiteTest(db);
      const tB = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tA, 500_000n);
      await aplicarAnticipoTest(db, tB, 500_000n);
      const fA = await crearFacturaAlmacargaTest(db, tA, `FE-880101`, 100_000n);
      const fB = await crearFacturaAlmacargaTest(db, tB, `FE-880102`, 200_000n);
      const r = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: fA, monto: 100_000n },
          { facturaProveedorId: fB, monto: 200_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: await crearDocumentoTest(db, tA),
        usuarioId: db.userId,
      });
      const consecutivoB = (await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tB } })).consecutivo;
      await prisma.tramiteDO.update({ where: { id: tB }, data: { estado: "CERRADO" } });

      await expect(anularPagoGrupo(r.grupoPagoId, "Anulación de prueba con DO cerrado", db.userId)).rejects.toThrow(
        `No se puede anular: ${consecutivoB} está cerrado. Un administrador debe reabrirlo primero.`,
      );
      expect((await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: r.grupoPagoId } })).estado).toBe("ACTIVO");
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: fB } })).estado).toBe(
        EstadoFacturaProveedor.PAGADA,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CxP v2 (P1) — las brechas del PRD quedaron cerradas: cada criterio que
  // antes era `it.fails` ahora es un `it` normal y afirma el comportamiento
  // del PRD con los mensajes exactos de §B.7.
  // ═══════════════════════════════════════════════════════════════════════

  describe("CA-07 (v2) — abono: un pago menor deja saldo; nunca más que el saldo", () => {
    it("461.378 sobre una factura de 461.377 se rechaza; un abono de 200.000 la deja Abonada con saldo 261.377", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, "FE-12539-CA07", 461_377n);
      const documentoId = await crearDocumentoTest(db, tramiteId);

      await expect(
        crearPagoMultiDO({
          beneficiarioId: db.almacargaBeneficiarioId,
          facturas: [{ facturaProveedorId: facturaId, monto: 461_378n }],
          canalPago: CanalPago.PSE,
          documentoId,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow("A la factura FE-12539-CA07 solo le faltan $461.377 por pagar; no se le pueden aplicar $461.378.");
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe(
        EstadoFacturaProveedor.REGISTRADA,
      );

      await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: facturaId, monto: 200_000n }],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      });

      const fila = (await listarFacturasElegiblesMultiDO(db.almacargaBeneficiarioId)).find((f) => f.id === facturaId);
      expect(fila?.estado).toBe("PARCIAL");
      expect(fila?.etiqueta).toBe("Abonada");
      expect(fila?.saldo).toBe(261_377n);
      expect(fila?.aplicado).toBe(200_000n);
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe(
        EstadoFacturaProveedor.PARCIAL,
      );
    });
  });

  describe("CA-09 (v2) — una factura pagada no se vuelve a pagar por NINGÚN camino", () => {
    it("pagada por el bloque: crearPago (heredado y con aplicaciones), generarPago y otro bloque se rechazan con FACTURA_SIN_SALDO", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880103`, 464_077n);
      const documentoId = await crearDocumentoTest(db, tramiteId);

      await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: facturaId, monto: 464_077n }],
        canalPago: CanalPago.PSE,
        documentoId,
        usuarioId: db.userId,
      });
      const trasBloque = await prisma.facturaProveedor.findUnique({ where: { id: facturaId } });
      expect(trasBloque?.estado).toBe(EstadoFacturaProveedor.PAGADA);

      const mensaje = `La factura FE-880103 de ALMACARGA ya está pagada; no se puede volver a pagar.`;

      // 1. Pago suelto con la entrada heredada (libro de pagos viejo / MCP).
      await expect(
        crearPago({
          tramiteId,
          concepto: "Segundo pago (doble pago)",
          valor: 464_077n,
          canalPago: CanalPago.PSE,
          facturaProveedorIds: [facturaId],
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(mensaje);

      // 2. Pago suelto con aplicaciones (botón "Pagar $saldo").
      await expect(
        crearPago({
          tramiteId,
          concepto: "Tercer intento",
          valor: 1n,
          canalPago: CanalPago.PSE,
          aplicaciones: [{ facturaProveedorId: facturaId, monto: 1n }],
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(FacturaSinSaldoError);

      // 3. "Generar pago" (API/MCP).
      await expect(
        generarPagoDesdeFactura({
          facturaProveedorId: facturaId,
          canalPago: CanalPago.PSE,
          viaSocio: false,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(mensaje);

      // 4. Otro pago en bloque.
      await expect(
        crearPagoMultiDO({
          beneficiarioId: db.almacargaBeneficiarioId,
          facturas: [{ facturaProveedorId: facturaId, monto: 464_077n }],
          canalPago: CanalPago.PSE,
          documentoId,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(mensaje);

      const pagos = await prisma.pagoTramiteFactura.findMany({
        where: { facturaId },
      });
      expect(pagos).toHaveLength(1);
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
    });

    it("el guardián de BD (M5) rechaza un enlace directo que sobre-aplica, aunque no pase por el dominio", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880104`, 100_000n);
      const pago = await crearPago({
        tramiteId,
        concepto: "Pago sin factura",
        valor: 150_000n,
        canalPago: CanalPago.PSE,
        usuarioId: db.userId,
      });
      await expect(
        prisma.pagoTramiteFactura.create({ data: { pagoId: pago.id, facturaId, monto: 100_001n } }),
      ).rejects.toThrow(/CXP_SOBREAPLICACION/);
      expect(await prisma.pagoTramiteFactura.count({ where: { facturaId } })).toBe(0);
    });
  });

  describe("CA-10 (v2) — un pago no puede enlazar una factura de otro proveedor", () => {
    it("crearPago 'a Tampa Cargo' con una factura de Almacarga se rechaza con el mensaje exacto", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaAlmacarga = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880105`, 502_801n);

      await expect(
        crearPago({
          tramiteId,
          concepto: "Pago a Tampa Cargo",
          valor: 502_801n,
          canalPago: CanalPago.PSE,
          beneficiarioIds: [db.tampaBeneficiarioId],
          facturaProveedorIds: [facturaAlmacarga],
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(`La factura FE-880105 es de ALMACARGA, no de TAMPA CARGO.`);

      const facturaTrasIntento = await prisma.facturaProveedor.findUnique({
        where: { id: facturaAlmacarga },
      });
      expect(facturaTrasIntento?.estado).toBe(EstadoFacturaProveedor.REGISTRADA);
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(0);
    });

    it("un bloque a Almacarga no puede incluir una factura de Express; un pago suelto no mezcla proveedores", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const almacarga = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880106`, 100_000n);
      const express = await crearFacturaAlmacargaTest(
        db,
        tramiteId,
        `FE-880107`,
        99_484n,
        db.expressBeneficiarioId,
      );

      await expect(
        crearPagoMultiDO({
          beneficiarioId: db.almacargaBeneficiarioId,
          facturas: [
            { facturaProveedorId: almacarga, monto: 100_000n },
            { facturaProveedorId: express, monto: 99_484n },
          ],
          canalPago: CanalPago.PSE,
          documentoId: await crearDocumentoTest(db, tramiteId),
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(`La factura FE-880107 es de EXPRESS LOGISTICA, no de ALMACARGA.`);

      await expect(
        crearPago({
          tramiteId,
          concepto: "Pago mezclado",
          valor: 199_484n,
          canalPago: CanalPago.PSE,
          aplicaciones: [
            { facturaProveedorId: almacarga, monto: 100_000n },
            { facturaProveedorId: express, monto: 99_484n },
          ],
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(`Un pago va a un solo proveedor: FE-880106 y FE-880107 son de proveedores distintos.`);

      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(0);
    });
  });

  describe("CA-13 (v2) — no se puede borrar un solo pago de un bloque", () => {
    it("eliminarPago sobre un pago del bloque se rechaza; un pago suelto sí se borra y devuelve el saldo", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteA, 1_000_000n);
      await aplicarAnticipoTest(db, tramiteB, 1_000_000n);
      const facturaA = await crearFacturaAlmacargaTest(db, tramiteA, `FE-880108`, 300_000n);
      const facturaB = await crearFacturaAlmacargaTest(db, tramiteB, `FE-880109`, 200_000n);

      const resultado = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: facturaA, monto: 300_000n },
          { facturaProveedorId: facturaB, monto: 200_000n },
        ],
        canalPago: CanalPago.PSE,
        documentoId: await crearDocumentoTest(db, tramiteA),
        usuarioId: db.userId,
      });
      const pagoA = resultado.pagos.find((p) => p.tramiteId === tramiteA)!;

      await expect(eliminarPago(pagoA.id, db.userId)).rejects.toThrow(/pago en bloque/i);

      const pagoSigueExistiendo = await prisma.pagoTramite.findUnique({
        where: { id: pagoA.id },
      });
      expect(pagoSigueExistiendo).not.toBeNull();

      // Pago suelto (abono) sí se borra y la factura vuelve a Pendiente.
      const tramiteC = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteC, 1_000_000n);
      const facturaC = await crearFacturaAlmacargaTest(db, tramiteC, `FE-880110`, 300_000n);
      const suelto = await crearPago({
        tramiteId: tramiteC,
        concepto: "Abono suelto",
        valor: 120_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaC, monto: 120_000n }],
        usuarioId: db.userId,
      });
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaC } })).estado).toBe(
        EstadoFacturaProveedor.PARCIAL,
      );
      await eliminarPago(suelto.id, db.userId);
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaC } })).estado).toBe(
        EstadoFacturaProveedor.REGISTRADA,
      );
    });
  });

  describe("CA-14 (v2) — no se edita valor/canal de un pago con facturas o de un bloque", () => {
    it("actualizarPago(canal) sobre un pago del bloque se rechaza y no cambia el costo; el concepto sí se propaga a todo el bloque", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteA, 1_000_000n);
      await aplicarAnticipoTest(db, tramiteB, 1_000_000n);
      const facturaA = await crearFacturaAlmacargaTest(db, tramiteA, `FE-880111`, 300_000n);
      const facturaB = await crearFacturaAlmacargaTest(db, tramiteB, `FE-880112`, 200_000n);

      const resultado = await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [
          { facturaProveedorId: facturaA, monto: 300_000n },
          { facturaProveedorId: facturaB, monto: 200_000n },
        ],
        canalPago: CanalPago.PSE, // costo 0 — el segundo pago arranca con costoBancario 0
        documentoId: await crearDocumentoTest(db, tramiteA),
        usuarioId: db.userId,
      });
      const pagoB = resultado.pagos.find((p) => p.tramiteId === tramiteB)!;
      expect(pagoB.costoBancario).toBe(0n);

      await expect(
        actualizarPago(pagoB.id, { canalPago: CanalPago.TRANSF_BANCOLOMBIA }, db.userId),
      ).rejects.toThrow(
        "Este pago cubre facturas o es parte de un pago en bloque: para cambiar el valor o el canal, anula y registra de nuevo.",
      );
      await expect(actualizarPago(pagoB.id, { valor: 199_999n }, db.userId)).rejects.toThrow(/anula y registra de nuevo/);

      const pagoBTrasIntento = await prisma.pagoTramite.findUnique({ where: { id: pagoB.id } });
      expect(pagoBTrasIntento?.costoBancario).toBe(0n);
      expect(pagoBTrasIntento?.valor).toBe(200_000n);

      // La pantalla manda todos los campos en cada guardado: mismo valor y canal no es un cambio.
      await actualizarPago(
        pagoB.id,
        { valor: 200_000n, canalPago: CanalPago.PSE, concepto: "Pago almacenajes (corregido)" },
        db.userId,
      );
      const delBloque = await prisma.pagoTramite.findMany({ where: { grupoPagoId: resultado.grupoPagoId } });
      expect(delBloque.map((p) => p.concepto)).toEqual(["Pago almacenajes (corregido)", "Pago almacenajes (corregido)"]);
      const cabecera = await prisma.pagoGrupo.findUniqueOrThrow({ where: { id: resultado.grupoPagoId } });
      expect(cabecera.concepto).toBe("Pago almacenajes (corregido)");

      // Pago suelto con facturas: tampoco se cambia el valor.
      const tramiteC = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteC, 1_000_000n);
      const facturaC = await crearFacturaAlmacargaTest(db, tramiteC, `FE-880113`, 50_000n);
      const suelto = await crearPago({
        tramiteId: tramiteC,
        concepto: "Pago suelto",
        valor: 50_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaC, monto: 50_000n }],
        usuarioId: db.userId,
      });
      await expect(actualizarPago(suelto.id, { valor: 60_000n }, db.userId)).rejects.toThrow(PagoNoEditableError);
    });
  });

  describe("CA-30 (v2) — invariantes después de intentar un doble pago", () => {
    it("0 facturas con más de un pago tras el intento; aplicado + ajustes + cruzado ≤ valor y estado = estadoDe(partes) para todo Almacarga", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880114`, 500_000n);

      await crearPagoMultiDO({
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: facturaId, monto: 500_000n }],
        canalPago: CanalPago.PSE,
        documentoId: await crearDocumentoTest(db, tramiteId),
        usuarioId: db.userId,
      });

      await expect(
        crearPago({
          tramiteId,
          concepto: "Doble pago (no debería ser posible)",
          valor: 500_000n,
          canalPago: CanalPago.PSE,
          facturaProveedorIds: [facturaId],
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(/ya está pagada/);

      const conteos = await prisma.pagoTramiteFactura.groupBy({
        by: ["facturaId"],
        where: { facturaId },
        _count: { pagoId: true },
      });
      expect(conteos.filter((c) => c._count.pagoId > 1)).toHaveLength(0);

      // I2 e I4 sobre todas las facturas de Almacarga de este archivo.
      const facturas = await prisma.facturaProveedor.findMany({
        where: { beneficiarioId: db.almacargaBeneficiarioId },
        select: {
          id: true,
          valor: true,
          estado: true,
          montoCompensado: true,
          pagos: { select: { monto: true } },
          ajustes: { select: { monto: true } },
        },
      });
      for (const f of facturas) {
        const partes = {
          valor: f.valor,
          aplicado: f.pagos.reduce((s, p) => s + p.monto, 0n),
          ajustes: f.ajustes.reduce((s, a) => s + a.monto, 0n),
          compensado: f.montoCompensado,
        };
        expect(partes.aplicado + partes.ajustes + partes.compensado <= partes.valor).toBe(true);
        expect(f.estado).toBe(estadoDe(partes));
      }
    });
  });

  describe("Concurrencia básica e idempotencia (CA-08 parcial, CA-43)", () => {
    it("pago suelto + bloque + generar pago a la vez sobre la misma factura: solo uno entra y la factura queda pagada una vez", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 2_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880115`, 464_077n);
      const documentoId = await crearDocumentoTest(db, tramiteId);

      const resultados = await Promise.allSettled([
        crearPago({
          tramiteId,
          concepto: "Pagar $464.077",
          valor: 464_077n,
          canalPago: CanalPago.PSE,
          aplicaciones: [{ facturaProveedorId: facturaId, monto: 464_077n }],
          usuarioId: db.userId,
        }),
        crearPagoMultiDO({
          beneficiarioId: db.almacargaBeneficiarioId,
          facturas: [{ facturaProveedorId: facturaId, monto: 464_077n }],
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
      ]);

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of resultados) {
        if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/ya está pagada|solo le faltan/);
      }
      const puentes = await prisma.pagoTramiteFactura.findMany({ where: { facturaId } });
      expect(puentes.reduce((s, p) => s + p.monto, 0n)).toBe(464_077n);
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe(
        EstadoFacturaProveedor.PAGADA,
      );
    });

    it("doble clic con la misma clave: un solo bloque y la segunda respuesta `repetido: true` (nunca 'ya está pagada'); otra clave con otros montos → IDEMPOTENCIA_CONFLICTO", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 2_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880116`, 300_000n);
      const documentoId = await crearDocumentoTest(db, tramiteId);
      const clave = randomUUID();
      const entrada = {
        beneficiarioId: db.almacargaBeneficiarioId,
        facturas: [{ facturaProveedorId: facturaId, monto: 300_000n }],
        canalPago: CanalPago.PSE,
        documentoId,
        claveIdempotencia: clave,
        usuarioId: db.userId,
      };

      const [uno, dos] = await Promise.all([crearPagoMultiDO(entrada), crearPagoMultiDO(entrada)]);
      expect(uno.grupoPagoId).toBe(dos.grupoPagoId);
      expect([uno.repetido, dos.repetido].sort()).toEqual([false, true]);
      expect(await prisma.pagoGrupo.count({ where: { claveIdempotencia: clave } })).toBe(1);
      expect(await prisma.pagoTramite.count({ where: { tramiteId } })).toBe(1);

      await expect(
        crearPagoMultiDO({ ...entrada, facturas: [{ facturaProveedorId: facturaId, monto: 100_000n }] }),
      ).rejects.toThrow(
        "Este pago ya se registró con otros datos (o se anuló). Cierra la ventana y vuelve a abrirla para registrar uno nuevo.",
      );

      // Anulado el bloque, la misma clave ya no sirve.
      await anularPagoGrupo(uno.grupoPagoId, "Prueba de idempotencia tras anular", db.userId);
      await expect(crearPagoMultiDO(entrada)).rejects.toThrow(IdempotenciaConflictoError);

      // Pago suelto: misma regla.
      const claveSimple = randomUUID();
      const simple = {
        tramiteId,
        concepto: "Pago suelto idempotente",
        valor: 300_000n,
        canalPago: CanalPago.PSE,
        aplicaciones: [{ facturaProveedorId: facturaId, monto: 300_000n }],
        claveIdempotencia: claveSimple,
        usuarioId: db.userId,
      };
      const p1 = await crearPago(simple);
      const p2 = await crearPago(simple);
      expect(p1.repetido).toBe(false);
      expect(p2.repetido).toBe(true);
      expect(p2.id).toBe(p1.id);
    });
  });

  describe("Otro camino: 'Generar pago' paga el saldo, admite abono y hereda las reglas", () => {
    it("genera un abono de 100.000 (factura Abonada) y luego el saldo exacto (Pagada); vincula la ficha del proveedor", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 1_000_000n);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880118`, 300_000n);

      const abono = await generarPagoDesdeFactura({
        facturaProveedorId: facturaId,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        monto: 100_000n,
        usuarioId: db.userId,
      });
      expect(abono.pago.valor).toBe(100_000n);
      expect(abono.factura.estado).toBe(EstadoFacturaProveedor.PARCIAL);
      const benef = await prisma.pagoTramiteBeneficiario.findMany({ where: { pagoId: abono.pago.id } });
      expect(benef.map((b) => b.beneficiarioId)).toEqual([db.almacargaBeneficiarioId]);

      await expect(
        generarPagoDesdeFactura({
          facturaProveedorId: facturaId,
          canalPago: CanalPago.PSE,
          viaSocio: false,
          monto: 200_001n,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(MontoExcedeSaldoError);

      const resto = await generarPagoDesdeFactura({
        facturaProveedorId: facturaId,
        canalPago: CanalPago.PSE,
        viaSocio: false,
        usuarioId: db.userId,
      });
      expect(resto.pago.valor).toBe(200_000n);
      expect(resto.factura.estado).toBe(EstadoFacturaProveedor.PAGADA);
    });

    it("sin anticipo aplicado (función encendida) generarPago se rechaza con SIN_ANTICIPO", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `FE-880117`, 50_000n);
      await expect(
        generarPagoDesdeFactura({
          facturaProveedorId: facturaId,
          canalPago: CanalPago.PSE,
          viaSocio: false,
          usuarioId: db.userId,
        }),
      ).rejects.toThrow(/tiene encendida la función «Sin anticipo no hay pago»/);
    });
  });
});
