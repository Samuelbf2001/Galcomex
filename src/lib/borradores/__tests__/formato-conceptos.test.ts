/**
 * Línea de terceros de la factura de venta (CxP v2, R15; CA-27).
 *
 * Texto como en Siigo y en los documentos reales: `{concepto} {nombre corto de
 * la ficha} FACT. {número}`; el número sale "FE 11298" solo para las fichas
 * marcadas «Numerar como FE 11298» (Almacarga, Express) y tal cual se digitó
 * para las demás (BAQ-18385 y `query_output4.txt` R1).
 *
 * La parte de BD (`lineasTercerosDesdeFacturas`) requiere DATABASE_URL de una
 * base desechable; sin BD esos casos se omiten.
 */
import "dotenv/config";

import { EstadoBorrador, EstadoFacturaProveedor } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  crearBorradorFacturadoConLinea,
  crearFacturaAlmacargaTest,
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
  runId,
  TEST_PREFIX,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { conceptoLineaTercero, lineasTercerosDesdeFacturas } from "@/lib/borradores/formato-conceptos";
import { prisma } from "@/lib/db/prisma";

describe("conceptoLineaTercero (R15) — texto de la línea de terceros", () => {
  it("ALMACENAJE ALMACARGA FACT. FE 11298 (BAQ-18385): nombre corto + FE con espacio", () => {
    expect(
      conceptoLineaTercero({
        concepto: "Almacenaje",
        proveedorNombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S',
        numFactura: "FE-11298",
        siigoProducto: null,
        beneficiario: { nombreCorto: "ALMACARGA", numFacturaConEspacio: true },
      }),
    ).toBe("ALMACENAJE ALMACARGA FACT. FE 11298");
  });

  it("SERV. REEMPAQUE Y EMBALAJE EXPRESS FACT. FE 6353 (sin guion en lo digitado)", () => {
    expect(
      conceptoLineaTercero({
        concepto: "SERV. REEMPAQUE Y EMBALAJE",
        proveedorNombre: "CW EXPRESS LOGISTICA",
        numFactura: "fe6353",
        siigoProducto: null,
        beneficiario: { nombreCorto: "EXPRESS", numFacturaConEspacio: true },
      }),
    ).toBe("SERV. REEMPAQUE Y EMBALAJE EXPRESS FACT. FE 6353");
  });

  it("PAGO VUCE FACT. REG-50151039: ficha sin la marca → número tal cual", () => {
    expect(
      conceptoLineaTercero({
        concepto: "PAGO",
        proveedorNombre: "VUCE",
        numFactura: "REG-50151039",
        siigoProducto: null,
        beneficiario: { nombreCorto: null, numFacturaConEspacio: false },
      }),
    ).toBe("PAGO VUCE FACT. REG-50151039");
  });

  it("LIBERACION TAMPA CARGO FACT. 71388844: nombre corto de la ficha, número sin prefijo", () => {
    expect(
      conceptoLineaTercero({
        concepto: "LIBERACION",
        proveedorNombre: "TAMPA CARGO S.A.S.",
        numFactura: "71388844",
        siigoProducto: null,
        beneficiario: { nombreCorto: "TAMPA CARGO", numFacturaConEspacio: false },
      }),
    ).toBe("LIBERACION TAMPA CARGO FACT. 71388844");
  });

  it("factura heredada sin ficha: igual que antes (nombre y número digitados)", () => {
    expect(
      conceptoLineaTercero({
        concepto: null,
        proveedorNombre: "ALMACARGA",
        numFactura: "FE-11298",
        siigoProducto: { nombre: "Almacenaje" },
      }),
    ).toBe("ALMACENAJE ALMACARGA FACT. FE-11298");
    expect(
      conceptoLineaTercero({
        concepto: "  ",
        proveedorNombre: "  PROVEEDOR   X ",
        numFactura: " 123 ",
        siigoProducto: null,
        beneficiario: null,
      }),
    ).toBe("PAGO A TERCEROS PROVEEDOR X FACT. 123");
  });
});

describe("lineasTercerosDesdeFacturas (BD) — CA-27 y R13", () => {
  const fichas: string[] = [];

  beforeAll(prepararBdAlmacarga);

  afterAll(async () => {
    if (process.env.DATABASE_URL) {
      await prisma.beneficiario.deleteMany({ where: { id: { in: fichas } } }).catch(() => undefined);
    }
    await liberarBdAlmacarga();
  });

  async function fichaAlmacarga(): Promise<string> {
    const b = await prisma.beneficiario.create({
      data: {
        nombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S',
        nit: `${TEST_PREFIX}-ben-fc-${fichas.length}-${runId}`,
        nombreCorto: "ALMACARGA",
        numFacturaConEspacio: true,
      },
    });
    fichas.push(b.id);
    return b.id;
  }

  it("CA-27: DO nuevo con FE-99999 de Almacarga por 100.000 → 'ALMACENAJE ALMACARGA FACT. FE 99999'", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    const ficha = await fichaAlmacarga();
    const facturaId = await crearFacturaAlmacargaTest(db, tramiteId, "FE-99999", 100_000n, ficha);
    await prisma.facturaProveedor.update({ where: { id: facturaId }, data: { concepto: "ALMACENAJE" } });

    const lineas = await prisma.$transaction((tx) => lineasTercerosDesdeFacturas(tx, tramiteId));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toMatchObject({
      concepto: "ALMACENAJE ALMACARGA FACT. FE 99999",
      numSoporte: "FE-99999",
      valor: 100_000n,
      seccion: "TERCEROS",
      aplicaIva: false,
    });
  });

  it("R13: pagada al proveedor no impide cobrarla; la ya cobrada (borrador FACTURADO) y la no repercutible no salen", async (ctx) => {
    const db = ensureDb(ctx);
    const tramiteId = await crearTramiteTest(db);
    const ficha = await fichaAlmacarga();
    const pagada = await crearFacturaAlmacargaTest(db, tramiteId, "FE-99901", 10_000n, ficha);
    await prisma.facturaProveedor.update({
      where: { id: pagada },
      data: { estado: EstadoFacturaProveedor.PAGADA },
    });
    const cobrada = await crearFacturaAlmacargaTest(db, tramiteId, "FE-99902", 20_000n, ficha);
    await crearBorradorFacturadoConLinea(tramiteId, cobrada, 20_000n, `BAQ-FC-${runId.slice(-6)}`);
    const propia = await crearFacturaAlmacargaTest(db, tramiteId, "FE-99903", 30_000n, ficha);
    await prisma.facturaProveedor.update({ where: { id: propia }, data: { repercutible: false } });

    const lineas = await prisma.$transaction((tx) => lineasTercerosDesdeFacturas(tx, tramiteId));
    expect(lineas.map((l) => l.numSoporte)).toEqual(["FE-99901"]);
    expect(lineas[0]?.concepto).toBe("PAGO A TERCEROS ALMACARGA FACT. FE 99901");

    // Si la factura de venta vuelve a borrador, la factura cobrada vuelve a salir.
    await prisma.borradorFactura.updateMany({
      where: { tramiteId },
      data: { estado: EstadoBorrador.EN_REVISION },
    });
    const otraVez = await prisma.$transaction((tx) => lineasTercerosDesdeFacturas(tx, tramiteId));
    expect(otraVez.map((l) => l.numSoporte).sort()).toEqual(["FE-99901", "FE-99902"]);
  });
});
