/**
 * Pruebas de aceptación — facturas de proveedor del caso Almacarga (CxP v2, P2).
 *
 * CA-02, CA-15, CA-18 y CA-28 vinieron TAL CUAL (P0) desde
 * `src/lib/pagos/__tests__/cxp-proveedor-almacarga.test.ts` como `it.fails`;
 * P2 las volteó a `it` al implementar R7 (ficha obligatoria), R10 (no cerrar
 * un DO con deuda), R12 (llave única por proveedor) y R11 (no editar una
 * factura ya cobrada o con pagos). Se agregan los casos del diseño §G/P2:
 * cierre con abonos y con excepción de ADMIN, R11 sobre cambios reales, editar
 * el concepto de un "duplicado heredado" (trigger `IS DISTINCT FROM`), posible
 * duplicado por dígitos, USD y re-expresión.
 *
 * Fixtures compartidos (congelados): src/lib/cxp/__tests__/fixtures/almacarga.ts.
 * Para no mezclar la llave anti-duplicado entre casos, cada prueba crea su
 * PROPIA ficha de pago (`nuevaFicha`) y se la pasa a `crearFacturaAlmacargaTest`.
 * Requiere DATABASE_URL de una base de pruebas desechable.
 */
import "dotenv/config";

import { CanalPago, EstadoFacturaProveedor, EstadoTramite, Rol } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarAnticipoTest,
  crearBorradorFacturadoConLinea,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  stateYear,
  TEST_PREFIX,
  type Fixture,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { borrarFichasYEmpresasTest, crearFichaConEmpresaTest } from "@/lib/beneficiarios/__tests__/fixtures";
import {
  DoConFacturasPendientesError,
  FacturaConPagosError,
  FacturaDuplicadaError,
  FacturaYaCobradaError,
  PosibleDuplicadoError,
  ProveedorObligatorioError,
  UsdValorLejosDeTrmError,
} from "@/lib/cxp/errores";
import { estadoDe } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import {
  actualizarFacturaProveedor,
  crearFacturaProveedor,
  eliminarFacturaProveedor,
  FacturaProveedorConPagosError,
  FacturaProveedorNoEliminableError,
  listarPorTramite,
  reexpresarFacturaUsd,
  ReexpresionUsdInvalidaError,
  traducirChoqueUnico,
} from "@/lib/facturas-proveedor/service";
import { crearPago } from "@/lib/pagos/service";
import { transitionTramite } from "@/lib/tramites/service";

// ─── Helpers propios (el fixture compartido está congelado) ──────────────────

let fichas = 0;

/** Ficha de pago nueva (NIT con letras → llave `BEN:<id>`, aislada de las demás pruebas). */
async function nuevaFicha(nombre = "ALMACARGA", extra: { nombreCorto?: string; numFacturaConEspacio?: boolean } = {}) {
  fichas += 1;
  // Fase 3: la ficha lleva su empresa (mismo NIT con prefijo de prueba, que borra `cleanupTestData`).
  const ficha = await crearFichaConEmpresaTest({
    nombre,
    nit: `${TEST_PREFIX}-ben-p2-${fichas}-${runId}`,
    nombreCorto: extra.nombreCorto ?? null,
    numFacturaConEspacio: extra.numFacturaConEspacio ?? false,
  });
  return ficha.id;
}

/**
 * Registra un pago ya ocurrido enlazado a la factura, directo en BD (sin pasar
 * por el dominio de pagos, que es de P1): el puente con su monto y el estado
 * derivado del saldo (lo mismo que haría `recalcularEstadoFactura`).
 */
async function pagarDirecto(tramiteId: string, facturaId: string, monto: bigint): Promise<string> {
  const pago = await prisma.pagoTramite.create({
    data: {
      tramiteId,
      concepto: `${TEST_PREFIX} pago directo`,
      valor: monto,
      canalPago: CanalPago.PSE,
      costoBancario: 0n,
      fechaRealPago: new Date(`${stateYear}-02-15`),
      facturasProveedor: { create: [{ facturaId, monto }] },
    },
  });
  const f = await prisma.facturaProveedor.findUniqueOrThrow({
    where: { id: facturaId },
    include: { pagos: { select: { monto: true } }, ajustes: { select: { monto: true } } },
  });
  const estado = estadoDe({
    valor: f.valor,
    aplicado: f.pagos.reduce((s, p) => s + p.monto, 0n),
    ajustes: f.ajustes.reduce((s, a) => s + a.monto, 0n),
    compensado: f.montoCompensado,
  });
  await prisma.facturaProveedor.update({ where: { id: facturaId }, data: { estado } });
  return pago.id;
}

function crearUsd(
  db: Fixture,
  tramiteId: string,
  beneficiarioId: string,
  numFactura: string,
  valor: bigint,
  extra: { confirmarValorUsd?: boolean } = {},
) {
  return crearFacturaProveedor({
    tramiteId,
    beneficiarioId,
    numFactura,
    valor,
    fecha: new Date(`${stateYear}-02-01`),
    moneda: "USD",
    valorOrigenCentavos: 13_100n, // USD 131,00
    trmCentavos: 371_050n, // 3.710,50 → sugerido 486.076
    fechaTrm: new Date(`${stateYear}-02-01`),
    repercutible: true,
    subidaPorId: db.userId,
    ...extra,
  });
}

describe("CxP facturas de proveedor Almacarga — PRD-ALMACARGA-CXP-PROVEEDOR §9", () => {
  beforeAll(prepararBdAlmacarga);

  afterAll(liberarBdAlmacarga);

  describe("CA-02 — RF-02: el servidor exige ficha de pago", () => {
    it("crearFacturaProveedor sin beneficiarioId se rechaza con 'El proveedor es obligatorio' y no guarda nada", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);

      await expect(
        crearFacturaProveedor({
          tramiteId,
          proveedorNombre: "ALMACARGA",
          // @ts-expect-error — el tipo ya lo impide; se prueba que el servidor también (MCP, scripts).
          beneficiarioId: null,
          numFactura: `${runId}-SIN-BENEF`,
          valor: 50_000n,
          fecha: new Date(`${stateYear}-02-01`),
          subidaPorId: db.userId,
        }),
      ).rejects.toThrow(/El proveedor es obligatorio/);

      await expect(
        crearFacturaProveedor({
          tramiteId,
          beneficiarioId: "",
          numFactura: `${runId}-SIN-BENEF-2`,
          valor: 50_000n,
          fecha: new Date(`${stateYear}-02-01`),
          subidaPorId: db.userId,
        }),
      ).rejects.toBeInstanceOf(ProveedorObligatorioError);

      expect(await prisma.facturaProveedor.count({ where: { tramiteId } })).toBe(0);
    });

    it("el nombre y el NIT guardados salen de la ficha, no de lo que mande la pantalla", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const fichaId = await nuevaFicha("ALMACENADORA DE CARGA ALMACARGA SAS");

      const factura = await crearFacturaProveedor({
        tramiteId,
        beneficiarioId: fichaId,
        proveedorNombre: "OTRO NOMBRE ESCRITO A MANO",
        proveedorNit: "999",
        numFactura: `${runId}-P2-NOMBRE`,
        valor: 10_000n,
        fecha: new Date(`${stateYear}-02-01`),
        subidaPorId: db.userId,
      });
      const ficha = await prisma.beneficiario.findUniqueOrThrow({ where: { id: fichaId } });
      expect(factura.proveedorNombre).toBe("ALMACENADORA DE CARGA ALMACARGA SAS");
      expect(factura.proveedorNit).toBe(ficha.nit);
      expect(factura.beneficiarioId).toBe(fichaId);
    });

    it("editar una factura y quitarle la ficha (beneficiarioId: null) se rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-P2-QUITAR`, 10_000n, await nuevaFicha());
      await expect(
        actualizarFacturaProveedor(facturaId, { beneficiarioId: null }, db.userId),
      ).rejects.toBeInstanceOf(ProveedorObligatorioError);
    });
  });

  describe("CA-15 — RF-19: no se cierra un DO con facturas de proveedor pendientes", () => {
    it("transitionTramite(CERRADO) con una factura de Almacarga REGISTRADA se rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db, { estado: EstadoTramite.PAGADO });
      await aplicarAnticipoTest(db, tramiteId, 500_000n);
      await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-CA15`, 464_077n, await nuevaFicha());

      const resultado = await transitionTramite(
        tramiteId,
        EstadoTramite.CERRADO,
        db.userId,
        false,
        Rol.ADMIN,
      );

      expect(resultado.ok).toBe(false);
      if (!resultado.ok) {
        expect(resultado.message).toMatch(/factura de proveedor sin pagar/i);
        expect(resultado.message).toContain("$464.077");
        expect(resultado.status).toBe(422);
        expect(resultado.codigo).toBe("DO_CON_FACTURAS_PENDIENTES");
        // Serializable (la ruta usa NextResponse.json): saldos como string.
        expect(JSON.parse(JSON.stringify(resultado.detalles))).toEqual({
          consecutivo: expect.any(String),
          facturas: [{ numFactura: `${runId}-CA15`, saldo: "464077" }],
        });
      }

      const tramiteFinal = await prisma.tramiteDO.findUnique({ where: { id: tramiteId } });
      expect(tramiteFinal?.estado).not.toBe(EstadoTramite.CERRADO);
    });

    it("tampoco con la excepción de ADMIN (bypassChecklist), y una factura Abonada también cuenta; plural con 2", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db, { estado: EstadoTramite.PAGADO });
      const ficha = await nuevaFicha("ALMACARGA", { nombreCorto: "ALMACARGA", numFacturaConEspacio: true });
      await crearFacturaAlmacargaTest(db, tramiteId, "FE-9101", 300_000n, ficha);
      const abonada = await crearFacturaAlmacargaTest(db, tramiteId, "FE-9102", 200_000n, ficha);
      await pagarDirecto(tramiteId, abonada, 150_000n);
      expect((await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: abonada } })).estado).toBe(
        EstadoFacturaProveedor.PARCIAL,
      );

      const resultado = await transitionTramite(tramiteId, EstadoTramite.CERRADO, db.userId, true, Rol.ADMIN);
      expect(resultado.ok).toBe(false);
      if (!resultado.ok) {
        expect(resultado.message).toBe(
          new DoConFacturasPendientesError(
            (await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } })).consecutivo,
            [
              { numFactura: "FE 9101", saldo: 300_000n },
              { numFactura: "FE 9102", saldo: 50_000n },
            ],
          ).message,
        );
        expect(resultado.message).toMatch(/tiene 2 facturas de proveedor sin pagar/);
      }
      expect((await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } })).estado).toBe(
        EstadoTramite.PAGADO,
      );
    });

    it("pagadas todas (saldo 0), el DO sí se cierra", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db, { estado: EstadoTramite.PAGADO });
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-CA15-OK`, 120_000n, await nuevaFicha());
      await pagarDirecto(tramiteId, facturaId, 70_000n);
      await pagarDirecto(tramiteId, facturaId, 50_000n);

      const resultado = await transitionTramite(tramiteId, EstadoTramite.CERRADO, db.userId, false, Rol.ADMIN);
      expect(resultado.ok).toBe(true);
      expect((await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } })).estado).toBe(
        EstadoTramite.CERRADO,
      );
    });
  });

  describe("CA-18 — RF-17: número de factura duplicado (normalizado) en otro DO del mismo proveedor", () => {
    it("'FE 77777' (con espacio) en otro DO se rechaza como duplicado de 'FE-77777' del mismo proveedor", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      await crearFacturaAlmacargaTest(db, tramiteA, `${runId}-FE-77777`, 464_077n, ficha);

      await expect(
        crearFacturaAlmacargaTest(db, tramiteB, `${runId}-FE 77777`, 464_077n, ficha),
      ).rejects.toThrow(/ya está registrada/i);
      expect(await prisma.facturaProveedor.count({ where: { tramiteId: tramiteB } })).toBe(0);
    });

    it("el mensaje dice número visible, proveedor y DO: 'La factura FE 12481 de ALMACARGA ya está registrada en el DO …'", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha("ALMACENADORA DE CARGA", { nombreCorto: "ALMACARGA", numFacturaConEspacio: true });
      await crearFacturaAlmacargaTest(db, tramiteA, "FE-12481", 464_077n, ficha);
      const a = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteA } });
      const corto = `${String(a.anio % 100).padStart(2, "0")}-${String(a.numero).padStart(4, "0")}`;

      const error = await crearFacturaAlmacargaTest(db, tramiteB, "fe12481", 464_077n, ficha).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FacturaDuplicadaError);
      expect((error as Error).message).toBe(
        `La factura FE 12481 de ALMACARGA ya está registrada en el DO ${corto} (${a.consecutivo}).`,
      );
    });

    it("la llave es por proveedor: el mismo número de OTRO proveedor sí se registra", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      await crearFacturaAlmacargaTest(db, tramiteA, `${runId}-FE-5555`, 10_000n, await nuevaFicha("ALMACARGA"));
      const otra = await crearFacturaAlmacargaTest(db, tramiteB, `${runId}-FE-5555`, 10_000n, await nuevaFicha("EXPRESS"));
      expect(otra).toBeTruthy();
    });

    it("dos fichas con el mismo NIT base comparten llave (otra cuenta del mismo proveedor)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      // NIT colombiano ficticio por corrida (no choca con datos reales): "base" y "base-DV".
      const base = String(700_000_000 + Math.floor(Math.random() * 99_999_999));
      // Fase 3: las dos cuentas son del mismo proveedor, o sea de la misma empresa.
      const cuenta1 = await crearFichaConEmpresaTest({ nombre: `${TEST_PREFIX} PROV NIT 1`, nit: base });
      const cuenta2 = await crearFichaConEmpresaTest({
        nombre: `${TEST_PREFIX} PROV NIT 2`,
        nit: `${base}-1`,
        empresaId: cuenta1.empresaId,
      });
      try {
        await crearFacturaAlmacargaTest(db, tramiteA, `${runId}-NIT-1`, 10_000n, cuenta1.id);
        await expect(
          crearFacturaAlmacargaTest(db, tramiteB, `${runId}-NIT-1`, 10_000n, cuenta2.id),
        ).rejects.toBeInstanceOf(FacturaDuplicadaError);
      } finally {
        await prisma.facturaProveedor.deleteMany({ where: { beneficiarioId: { in: [cuenta1.id, cuenta2.id] } } });
        await borrarFichasYEmpresasTest({ id: { in: [cuenta1.id, cuenta2.id] } });
      }
    });

    it("POSIBLE_DUPLICADO: mismos dígitos con otro texto ('12481' vs 'FE-012481') pide confirmar; confirmado, se guarda", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha("ALMACENADORA", { nombreCorto: "ALMACARGA" });
      await crearFacturaAlmacargaTest(db, tramiteA, "FE-012481", 464_077n, ficha);

      const error = await crearFacturaAlmacargaTest(db, tramiteB, "12481", 464_077n, ficha).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PosibleDuplicadoError);
      const a = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteA } });
      const corto = `${String(a.anio % 100).padStart(2, "0")}-${String(a.numero).padStart(4, "0")}`;
      expect((error as Error).message).toBe(
        `¿Es la misma factura? ALMACARGA ya tiene FE-012481 en el DO ${corto} por $464.077.`,
      );
      expect((error as PosibleDuplicadoError).coincidencias).toHaveLength(1);

      const confirmada = await crearFacturaProveedor({
        tramiteId: tramiteB,
        beneficiarioId: ficha,
        numFactura: "12481",
        valor: 464_077n,
        fecha: new Date(`${stateYear}-02-01`),
        confirmarPosibleDuplicado: true,
        subidaPorId: db.userId,
      });
      expect(confirmada.numFactura).toBe("12481");
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entidad: "FacturaProveedor", entidadId: confirmada.id, accion: "CREATE" },
      });
      expect(audit.despues).toMatchObject({ confirmoPosibleDuplicado: true });
    });

    it("dos altas simultáneas de la misma factura en DOs distintos: una entra y la otra recibe FACTURA_DUPLICADA (nunca un 500)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      const resultados = await Promise.allSettled([
        crearFacturaAlmacargaTest(db, tramiteA, `${runId}-CONC-1`, 10_000n, ficha),
        crearFacturaAlmacargaTest(db, tramiteB, `${runId}-conc 1`, 10_000n, ficha),
      ]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const fallida = resultados.find((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fallida?.reason).toBeInstanceOf(FacturaDuplicadaError);
      expect(
        await prisma.facturaProveedor.count({ where: { beneficiarioId: ficha } }),
      ).toBe(1);
    });

    it("el P2002 del índice único (escritura que se saltó la validación) se traduce a FACTURA_DUPLICADA", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha("ALMACENADORA", { nombreCorto: "ALMACARGA", numFacturaConEspacio: true });
      await crearFacturaAlmacargaTest(db, tramiteA, "FE-8181", 10_000n, ficha);
      // Escritura directa (script, fixture): el trigger calcula la llave y el índice la rechaza.
      const crudo = await prisma.facturaProveedor
        .create({
          data: {
            tramiteId: tramiteB,
            proveedorNombre: "ALMACARGA",
            beneficiarioId: ficha,
            numFactura: "FE 8181",
            valor: 10_000n,
            fecha: new Date(`${stateYear}-02-01`),
            subidaPorId: db.userId,
          },
        })
        .catch((e: unknown) => e);
      expect(crudo).toMatchObject({ code: "P2002" });

      const traducido = await traducirChoqueUnico(crudo, { beneficiarioId: ficha, numFactura: "FE 8181", tramiteId: tramiteB });
      expect(traducido).toBeInstanceOf(FacturaDuplicadaError);
      const a = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteA } });
      expect((traducido as Error).message).toContain(`La factura FE 8181 de ALMACARGA ya está registrada`);
      expect((traducido as Error).message).toContain(a.consecutivo);
    });

    it("cambiar el número al editar también respeta la llave", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      await crearFacturaAlmacargaTest(db, tramiteA, `${runId}-ED-100`, 10_000n, ficha);
      const otra = await crearFacturaAlmacargaTest(db, tramiteB, `${runId}-ED-200`, 10_000n, ficha);
      await expect(
        actualizarFacturaProveedor(otra, { numFactura: `${runId}-ed 100` }, db.userId),
      ).rejects.toBeInstanceOf(FacturaDuplicadaError);
    });
  });

  describe("CA-28 — RF-22: no se edita una factura ya facturada al cliente ni una con pagos (R11)", () => {
    it("actualizarFacturaProveedor sobre una factura REGISTRADA pero ya en un borrador FACTURADO se rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const facturaId = await crearFacturaAlmacargaTest(
        db,
        tramiteId,
        `${runId}-CA28`,
        464_077n,
        await nuevaFicha(),
      );
      await crearBorradorFacturadoConLinea(tramiteId, facturaId, 464_077n, "BAQ-18742");

      const facturaAntes = await prisma.facturaProveedor.findUnique({ where: { id: facturaId } });
      expect(facturaAntes?.estado).toBe(EstadoFacturaProveedor.REGISTRADA); // pagar y facturar son independientes (RF-12)

      await expect(
        actualizarFacturaProveedor(facturaId, { valor: 100_000n }, db.userId),
      ).rejects.toThrow(/ya se le cobró a Litoplas/i);
      await expect(
        actualizarFacturaProveedor(facturaId, { valor: 100_000n }, db.userId),
      ).rejects.toThrow("Esta factura ya se le cobró a LITOPLAS SA en BAQ-18742: primero corrige la factura de venta.");

      const facturaTrasIntento = await prisma.facturaProveedor.findUnique({
        where: { id: facturaId },
      });
      expect(facturaTrasIntento?.valor).toBe(464_077n);

      // No se puede borrar, pero el concepto sí se puede corregir.
      await expect(eliminarFacturaProveedor(facturaId, db.userId)).rejects.toBeInstanceOf(FacturaYaCobradaError);
      const conConcepto = await actualizarFacturaProveedor(facturaId, { concepto: "ALMACENAJE" }, db.userId);
      expect(conConcepto.concepto).toBe("ALMACENAJE");
    });

    it("una factura ya PAGADA rechaza la edición de su valor (FACTURA_CON_PAGOS)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      await aplicarAnticipoTest(db, tramiteId, 500_000n);
      const facturaId = await crearFacturaAlmacargaTest(
        db,
        tramiteId,
        `${runId}-CA28-pagada`,
        433_361n,
        await nuevaFicha(),
      );
      await crearPago({
        tramiteId,
        concepto: "Pago FE ya pagada",
        valor: 433_361n,
        canalPago: CanalPago.PSE,
        facturaProveedorIds: [facturaId],
        usuarioId: db.userId,
      });

      await expect(
        actualizarFacturaProveedor(facturaId, { valor: 100_000n }, db.userId),
      ).rejects.toThrow(FacturaConPagosError);
      await expect(
        actualizarFacturaProveedor(facturaId, { valor: 100_000n }, db.userId),
      ).rejects.toThrow(
        "Esta factura ya tiene pagos por $433.361: no se puede cambiar el valor, el proveedor ni el número. Si llegó una nota crédito, avísale a administración.",
      );
    });

    it("R11 sobre CAMBIOS REALES: la pantalla reenvía todo igual + concepto nuevo en una factura Abonada → se guarda", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-R11`, 300_000n, ficha);
      await pagarDirecto(tramiteId, facturaId, 100_000n);
      const actual = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: facturaId } });

      const actualizada = await actualizarFacturaProveedor(
        facturaId,
        {
          beneficiarioId: actual.beneficiarioId,
          numFactura: actual.numFactura,
          valor: actual.valor,
          repercutible: actual.repercutible,
          moneda: "COP",
          valorOrigenCentavos: null,
          trmCentavos: null,
          concepto: "ALMACENAJE CONTENEDORES",
          fecha: new Date(`${stateYear}-02-10T00:00:00.000Z`),
        },
        db.userId,
      );
      expect(actualizada.concepto).toBe("ALMACENAJE CONTENEDORES");
      expect(actualizada.fecha.toISOString()).toBe(`${stateYear}-02-10T00:00:00.000Z`);
      expect(actualizada.estado).toBe(EstadoFacturaProveedor.PARCIAL);

      // …pero cambiar el número, el proveedor o "se cobra al cliente" no.
      await expect(
        actualizarFacturaProveedor(facturaId, { numFactura: `${runId}-R11-X` }, db.userId),
      ).rejects.toBeInstanceOf(FacturaConPagosError);
      await expect(
        actualizarFacturaProveedor(facturaId, { beneficiarioId: await nuevaFicha("OTRA") }, db.userId),
      ).rejects.toBeInstanceOf(FacturaConPagosError);
      await expect(
        actualizarFacturaProveedor(facturaId, { repercutible: false }, db.userId),
      ).rejects.toBeInstanceOf(FacturaConPagosError);
      // Y no se borra.
      await expect(eliminarFacturaProveedor(facturaId, db.userId)).rejects.toBeInstanceOf(FacturaProveedorConPagosError);
    });

    it("sin pagos ni cobro, el valor y el número sí se corrigen", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-LIBRE`, 300_000n, await nuevaFicha());
      const f = await actualizarFacturaProveedor(
        facturaId,
        { valor: 310_000n, numFactura: `${runId}-LIBRE-2` },
        db.userId,
      );
      expect(f.valor).toBe(310_000n);
      expect(f.numFactura).toBe(`${runId}-LIBRE-2`);
      expect(f.numFacturaNormalizado).toBe(`${runId}-LIBRE-2`.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    });

    it("editar solo el concepto de un 'duplicado heredado' (clave NULL) funciona y no le devuelve la clave", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteA = await crearTramiteTest(db);
      const tramiteB = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      await crearFacturaAlmacargaTest(db, tramiteA, `${runId}-HER-1`, 10_000n, ficha);
      const heredada = await crearFacturaAlmacargaTest(db, tramiteB, `${runId}-HER-2`, 10_000n, ficha);
      // Así quedó en M3 un duplicado heredado: mismo número normalizado que otra
      // factura del proveedor y clave NULL. (Se escriben las columnas derivadas
      // directo: el trigger de llaves solo corre si cambia el número o la ficha.)
      const normalizadoDeLaPrimera = `${runId}-HER-1`.toUpperCase().replace(/[^A-Z0-9]/g, "");
      await prisma.$executeRaw`UPDATE "factura_proveedor" SET "numFacturaNormalizado" = ${normalizadoDeLaPrimera}, "proveedorClave" = NULL WHERE id = ${heredada}`;
      const antes = await prisma.facturaProveedor.findUniqueOrThrow({ where: { id: heredada } });
      expect(antes.proveedorClave).toBeNull();

      const f = await actualizarFacturaProveedor(
        heredada,
        { concepto: "REVISAR DUPLICADO", beneficiarioId: ficha, numFactura: antes.numFactura, valor: antes.valor },
        db.userId,
      );
      expect(f.concepto).toBe("REVISAR DUPLICADO");
      expect(f.proveedorClave).toBeNull();
    });

    it("borrar: sin pagos se borra; con línea en un borrador en curso, no (mensaje claro)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha();
      const libre = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-DEL-1`, 10_000n, ficha);
      await eliminarFacturaProveedor(libre, db.userId);
      expect(await prisma.facturaProveedor.findUnique({ where: { id: libre } })).toBeNull();

      const enBorrador = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-DEL-2`, 20_000n, ficha);
      const borradorId = await crearBorradorFacturadoConLinea(tramiteId, enBorrador, 20_000n, `BAQ-P2-${runId.slice(-6)}`);
      await prisma.borradorFactura.update({ where: { id: borradorId }, data: { estado: "EN_REVISION" } });
      await expect(eliminarFacturaProveedor(enBorrador, db.userId)).rejects.toBeInstanceOf(
        FacturaProveedorNoEliminableError,
      );
      await expect(eliminarFacturaProveedor(enBorrador, db.userId)).rejects.toThrow(/borrador de la factura de venta/);
    });
  });

  describe("USD (R14, D-4): moneda + valor en dólares + TRM; el valor en pesos manda", () => {
    it("USD 131,00 × 3.710,50 = 486.076: se guarda con moneda, centavos y TRM", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const f = await crearUsd(db, tramiteId, await nuevaFicha("TAMPA CARGO"), `${runId}-USD-1`, 486_076n);
      expect(f.moneda).toBe("USD");
      expect(f.valor).toBe(486_076n);
      expect(f.valorOrigenCentavos).toBe(13_100n);
      expect(f.trmCentavos).toBe(371_050n);
      expect(f.fechaTrm?.toISOString()).toBe(`${stateYear}-02-01T00:00:00.000Z`);
    });

    it("10 veces más (4.860.760) → USD_VALOR_LEJOS_DE_TRM; confirmado, se guarda", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha("TAMPA CARGO");
      const error = await crearUsd(db, tramiteId, ficha, `${runId}-USD-2`, 4_860_760n).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsdValorLejosDeTrmError);
      expect((error as Error).message).toBe(
        "USD 131,00 × TRM 3.710,50 = $486.076; escribiste $4.860.760 (900 % de diferencia). ¿Está bien?",
      );
      const f = await crearUsd(db, tramiteId, ficha, `${runId}-USD-2`, 4_860_760n, { confirmarValorUsd: true });
      expect(f.valor).toBe(4_860_760n);
    });

    it("dentro del 5 % no pregunta (Camila escribe el valor real del extracto)", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const f = await crearUsd(db, tramiteId, await nuevaFicha("TAMPA CARGO"), `${runId}-USD-3`, 500_000n);
      expect(f.valor).toBe(500_000n);
    });

    it("USD sin TRM → se rechaza; COP con TRM → se rechaza", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha("TAMPA CARGO");
      await expect(
        crearFacturaProveedor({
          tramiteId,
          beneficiarioId: ficha,
          numFactura: `${runId}-USD-4`,
          valor: 486_076n,
          fecha: new Date(`${stateYear}-02-01`),
          moneda: "USD",
          valorOrigenCentavos: 13_100n,
          subidaPorId: db.userId,
        }),
      ).rejects.toThrow(/valor en dólares y la TRM/);
      await expect(
        crearFacturaProveedor({
          tramiteId,
          beneficiarioId: ficha,
          numFactura: `${runId}-USD-5`,
          valor: 486_076n,
          fecha: new Date(`${stateYear}-02-01`),
          trmCentavos: 371_050n,
          subidaPorId: db.userId,
        }),
      ).rejects.toThrow(/factura en pesos no lleva/);
    });

    it("re-expresar (ADMIN): la TRM subió y ya estaba pagada → vuelve a Abonada con el faltante; auditado", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const f = await crearUsd(db, tramiteId, await nuevaFicha("TAMPA CARGO"), `${runId}-USD-RE`, 486_076n);
      await pagarDirecto(tramiteId, f.id, 486_076n);

      const re = await reexpresarFacturaUsd(
        f.id,
        { valor: 491_000n, trmCentavos: 374_809n, motivo: "TRM del día del pago 3.748,09" },
        db.userId,
      );
      expect(re.valor).toBe(491_000n);
      expect(re.trmCentavos).toBe(374_809n);
      expect(re.estado).toBe(EstadoFacturaProveedor.PARCIAL);
      const fila = (await listarPorTramite(tramiteId)).find((x) => x.id === f.id);
      expect(fila?.saldo).toBe(4_924n);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entidad: "FacturaProveedor", entidadId: f.id, accion: "REEXPRESAR_USD" },
      });
      expect(audit.despues).toMatchObject({ valor: "491000", saldo: "4924", motivo: "TRM del día del pago 3.748,09" });
      expect(audit.antes).toMatchObject({ valor: "486076", estado: "PAGADA" });
    });

    it("re-expresar nunca por debajo de lo pagado, ni una factura en pesos, ni una ya cobrada", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha("TAMPA CARGO");
      const usd = await crearUsd(db, tramiteId, ficha, `${runId}-USD-RE2`, 486_076n);
      await pagarDirecto(tramiteId, usd.id, 400_000n);
      await expect(
        reexpresarFacturaUsd(usd.id, { valor: 399_999n, trmCentavos: 305_343n, motivo: "TRM bajó muchísimo", confirmarValorUsd: true }, db.userId),
      ).rejects.toBeInstanceOf(ReexpresionUsdInvalidaError);
      // Justo lo pagado: queda Pagada (saldo 0).
      const exacta = await reexpresarFacturaUsd(
        usd.id,
        { valor: 400_000n, trmCentavos: 305_344n, motivo: "TRM bajó: vale lo pagado", confirmarValorUsd: true },
        db.userId,
      );
      expect(exacta.estado).toBe(EstadoFacturaProveedor.PAGADA);

      const cop = await crearFacturaAlmacargaTest(db, tramiteId, `${runId}-COP-RE`, 10_000n, ficha);
      await expect(
        reexpresarFacturaUsd(cop, { valor: 10_000n, trmCentavos: 371_050n, motivo: "no aplica a pesos" }, db.userId),
      ).rejects.toThrow(/Solo se puede re-expresar una factura en dólares/);

      const cobrada = await crearUsd(db, tramiteId, ficha, `${runId}-USD-RE3`, 486_076n);
      await crearBorradorFacturadoConLinea(tramiteId, cobrada.id, 486_076n, `BAQ-P2U-${runId.slice(-6)}`);
      await expect(
        reexpresarFacturaUsd(cobrada.id, { valor: 490_000n, trmCentavos: 374_000n, motivo: "TRM del día del pago" }, db.userId),
      ).rejects.toBeInstanceOf(FacturaYaCobradaError);
    });
  });

  describe("listarPorTramite: saldo, etiqueta y bloqueos para la pantalla (§D.3)", () => {
    it("Pendiente / Abonada / Pagada con aplicado, saldo, número visible y motivo de bloqueo", async (ctx) => {
      const db = ensureDb(ctx);
      const tramiteId = await crearTramiteTest(db);
      const ficha = await nuevaFicha("ALMACENADORA", { nombreCorto: "ALMACARGA", numFacturaConEspacio: true });
      const pendiente = await crearFacturaAlmacargaTest(db, tramiteId, "FE-9201", 100_000n, ficha);
      const abonada = await crearFacturaAlmacargaTest(db, tramiteId, "FE-9202", 300_000n, ficha);
      const pagada = await crearFacturaAlmacargaTest(db, tramiteId, "FE-9203", 50_000n, ficha);
      await pagarDirecto(tramiteId, abonada, 100_000n);
      await pagarDirecto(tramiteId, pagada, 50_000n);

      const filas = await listarPorTramite(tramiteId);
      const por = (id: string) => filas.find((f) => f.id === id)!;
      expect(por(pendiente)).toMatchObject({
        aplicado: 0n,
        saldo: 100_000n,
        etiqueta: "Pendiente",
        numFacturaVisible: "FE 9201",
        bloqueoEdicion: null,
        puedeEliminar: true,
        facturadaAlCliente: null,
      });
      expect(por(abonada)).toMatchObject({ aplicado: 100_000n, saldo: 200_000n, etiqueta: "Abonada", estadoCalculado: "PARCIAL" });
      expect(por(abonada).bloqueoEdicion?.codigo).toBe("FACTURA_CON_PAGOS");
      expect(por(abonada).puedeEliminar).toBe(false);
      expect(por(pagada)).toMatchObject({ saldo: 0n, etiqueta: "Pagada", estado: "PAGADA" });
      expect(por(pagada).pagos[0]?.monto).toBe(50_000n);
    });
  });
});
