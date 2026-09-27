import { describe, it, expect } from "vitest";

import { calcularBorrador } from "../motor-factura";
import {
  asesoriasSinCubrir,
  desglosarPago,
  enlacesAplicadosEnV2,
  esBloqueConAsesoria,
  esPagoMixto,
  llaveEnlace,
  montoPagadoEnGrupoDeAuditoria,
  montosSonEstimados,
  montosDeBloquesAuditados,
  motivoRevisionPago,
  necesitaMontosDeAuditoria,
  parteCobrableDePago,
  pagosCobrablesParaMotor,
  prepararPagosParaCobro,
  sobranteCobradoPorGrupo,
  tieneMontosPorEnlace,
  type AbonoBloqueAuditado,
  type AsesoriaDelTramite,
  type EnlaceFacturaCobro,
  type PagoConEnlaces,
  type PagoConParteNoCobrable,
  type PagoDelLibro,
  type PagoParaCobro,
} from "../pagos-cobrables";

// Parámetros del sistema (igual que el seed)
const TASA_IVA = 19n;
const TASA_4X1000 = 400n; // 400 / 100_000 = 0.004

const rep = (valorFactura: bigint, monto?: bigint | null): EnlaceFacturaCobro => ({
  valorFactura,
  repercutible: true,
  ...(monto !== undefined ? { monto } : {}),
});
const noRep = (valorFactura: bigint, monto?: bigint | null): EnlaceFacturaCobro => ({
  valorFactura,
  repercutible: false,
  ...(monto !== undefined ? { monto } : {}),
});

// ---------------------------------------------------------------------------
// Reglas R1–R3 de parteCobrableDePago (tolerancia 0 pesos)
// ---------------------------------------------------------------------------
describe("parteCobrableDePago", () => {
  it("(a) R1 pago suelto (sin facturas): completo, como hoy", () => {
    expect(
      parteCobrableDePago({ valor: 2_000_000n, costoBancario: 3_900n, facturas: [] }),
    ).toEqual({ valor: 2_000_000n, costoBancario: 3_900n });
  });

  it("(b) R3 solo asesoría (pago ≤ asesoría): ni valor ni costo bancario", () => {
    expect(
      parteCobrableDePago({ valor: 500_000n, costoBancario: 3_900n, facturas: [noRep(500_000n)] }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
    expect(
      parteCobrableDePago({
        valor: 800_000n,
        costoBancario: 3_900n,
        facturas: [noRep(500_000n), noRep(300_000n)],
      }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
    // Abono parcial de la asesoría: sigue siendo 100 % asesoría.
    expect(
      parteCobrableDePago({ valor: 150_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
  });

  it("(b2) R3 solo asesoría con pago MAYOR que la asesoría: nada se cobra, el sobrante lo asume Galcomex", () => {
    // Asesoría registrada en 300.000 y pagada en 357.000 (con IVA): ni un peso
    // ni el costo bancario van al cliente.
    expect(
      parteCobrableDePago({ valor: 357_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
    // Una transferencia de 1.300.000 enlazada solo a la asesoría (300.000): si
    // el resto era transporte, hay que enlazar su factura (queda por revisar).
    const d = desglosarPago({ valor: 1_300_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] });
    expect(d.cobrable).toEqual({ valor: 0n, costoBancario: 0n });
    expect(d.noCobrable).toBe(1_300_000n);
    expect(d.porRevisar).toBe(true);
  });

  it("(c) R2 solo repercutibles: identidad, sin prorrateo", () => {
    expect(
      parteCobrableDePago({
        valor: 1_300_000n,
        costoBancario: 3_900n,
        facturas: [rep(1_000_000n), rep(300_000n)],
      }),
    ).toEqual({ valor: 1_300_000n, costoBancario: 3_900n });
    // Pago mayor que su factura: se cobra completo igual que hoy.
    expect(
      parteCobrableDePago({ valor: 1_200_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n)] }),
    ).toEqual({ valor: 1_200_000n, costoBancario: 3_900n });
  });

  it("(d) R3 mixto exacto: transporte 1.000.000 + asesoría 300.000 → 1.000.000 y costo completo", () => {
    expect(
      parteCobrableDePago({
        valor: 1_300_000n,
        costoBancario: 3_900n,
        facturas: [rep(1_000_000n), noRep(300_000n)],
      }),
    ).toEqual({ valor: 1_000_000n, costoBancario: 3_900n });
  });

  it("(e) R3 abono parcial del transporte en el bloque: la asesoría se descuenta completa y el resto es transporte", () => {
    // Abono de 500.000 al transporte (factura 1.000.000) + asesoría completa
    // 300.000 → pago 800.000. Lo cobrable son 500.000, ni un peso de asesoría.
    const abono = parteCobrableDePago({
      valor: 800_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n), noRep(300_000n)],
    });
    expect(abono).toEqual({ valor: 500_000n, costoBancario: 3_900n });
    // El resto del transporte se paga después, enlazado solo al transporte.
    const resto = parteCobrableDePago({
      valor: 500_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n)],
    });
    expect(abono.valor + resto.valor).toBe(1_000_000n);

    // Dos abonos mixtos (500k T + 100k S y 400k T + 200k S) → 900.000 exactos.
    const a = parteCobrableDePago({
      valor: 600_000n,
      costoBancario: 0n,
      facturas: [rep(1_000_000n), noRep(100_000n)],
    });
    const b = parteCobrableDePago({
      valor: 600_000n,
      costoBancario: 0n,
      facturas: [rep(1_000_000n), noRep(200_000n)],
    });
    expect(a.valor + b.valor).toBe(900_000n);
  });

  it("(f) R3 pago mayor que sus facturas: se cobra como máximo lo que suman las que se cobran", () => {
    const d = desglosarPago({
      valor: 1_000_000n,
      costoBancario: 3_900n,
      facturas: [rep(600_000n), noRep(300_000n)],
    });
    // El sobrante (100.000) no se le cobra al cliente: lo asume Galcomex y el
    // pago queda por revisar.
    expect(d.cobrable).toEqual({ valor: 600_000n, costoBancario: 3_900n });
    expect(d.noCobrable).toBe(400_000n);
    expect(d.porRevisar).toBe(true);
  });

  it("(f2) R3 mixto que cuadra con la suma pero con la asesoría pagada de más: sin montos se supone completo; con montos es exacto", () => {
    // Transporte 1.000.000 pagado en 900.000 + asesoría 300.000 pagada en
    // 400.000 = 1.300.000 (igual a la suma de las facturas). Sin saber cuánto
    // se abonó a cada una, el sistema supone que cada factura se pagó completa.
    const sinMontos = desglosarPago({
      valor: 1_300_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n), noRep(300_000n)],
    });
    expect(sinMontos.cobrable.valor).toBe(1_000_000n);
    // Con lo que el bloque abonó a cada factura (auditoría o CxP v2): exacto.
    const conMontos = desglosarPago({
      valor: 1_300_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n, 900_000n), noRep(300_000n, 400_000n)],
    });
    expect(conMontos.cobrable).toEqual({ valor: 900_000n, costoBancario: 3_900n });
    expect(conMontos.noCobrable).toBe(400_000n);
    expect(conMontos.porRevisar).toBe(false);
  });

  it("(f3) asesoría neta de retención en el mismo bloque: sin montos Galcomex cobra de menos (marcado); con montos es exacto", () => {
    // Transporte 1.000.000 completo + asesoría 300.000 pagada en 288.000.
    const sinMontos = desglosarPago({
      valor: 1_288_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n), noRep(300_000n)],
    });
    expect(sinMontos.cobrable.valor).toBe(988_000n);
    expect(sinMontos.porRevisar).toBe(true);
    const conMontos = desglosarPago({
      valor: 1_288_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n, 1_000_000n), noRep(300_000n, 288_000n)],
    });
    expect(conMontos.cobrable).toEqual({ valor: 1_000_000n, costoBancario: 3_900n });
    expect(conMontos.porRevisar).toBe(false);
  });

  it("(g) con monto de CxP v2: pesa el monto si todos lo traen, ≥ 0 y Σ > 0", () => {
    const pago = (facturas: EnlaceFacturaCobro[], valor = 1_000_000n): PagoParaCobro => ({
      valor,
      costoBancario: 3_900n,
      facturas,
    });
    // Todos con monto válido → pesa el monto.
    expect(
      parteCobrableDePago(pago([rep(1_000_000n, 400_000n), noRep(500_000n, 600_000n)])).valor,
    ).toBe(400_000n);
    // Un monto 0 en la asesoría (válido en v2): este pago no le abona nada.
    expect(
      parteCobrableDePago(pago([rep(1_000_000n, 1_000_000n), noRep(500_000n, 0n)])).valor,
    ).toBe(1_000_000n);
    // Abono parcial de la asesoría con v2: exacto (antes Galcomex absorbía de más).
    expect(
      parteCobrableDePago(pago([rep(1_000_000n, 900_000n), noRep(300_000n, 100_000n)])).valor,
    ).toBe(900_000n);
    // Un monto null → pesa el valor de la factura.
    expect(
      parteCobrableDePago(pago([rep(1_000_000n, 400_000n), noRep(500_000n, null)])).valor,
    ).toBe(500_000n);
    // Un monto ausente → pesa el valor de la factura.
    expect(parteCobrableDePago(pago([rep(1_000_000n, 400_000n), noRep(500_000n)])).valor).toBe(
      500_000n,
    );
    // Montos todos en 0 → pesa el valor de la factura.
    expect(parteCobrableDePago(pago([rep(1_000_000n, 0n), noRep(500_000n, 0n)])).valor).toBe(
      500_000n,
    );
    // Un monto negativo → pesa el valor de la factura.
    expect(
      parteCobrableDePago(pago([rep(1_000_000n, -1n), noRep(500_000n, 600_000n)])).valor,
    ).toBe(500_000n);
  });

  it("(h) facturas con valor ≤ 0 (imposible por zod): la asesoría sin peso absorbe el pago", () => {
    // Asesoría sin valor conocido → todo el pago es no cobrable (contra Galcomex).
    expect(
      parteCobrableDePago({ valor: 101n, costoBancario: 3_900n, facturas: [rep(0n), noRep(0n)] }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
    expect(
      parteCobrableDePago({ valor: 101n, costoBancario: 3_900n, facturas: [rep(-5n), noRep(-1n)] }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
    // Transporte con valor ≤ 0 pesa 0 y no sube el tope de lo cobrable: nada
    // se cobra (el error va contra Galcomex, nunca contra el cliente).
    expect(
      parteCobrableDePago({
        valor: 800_000n,
        costoBancario: 3_900n,
        facturas: [rep(-5n), noRep(300_000n)],
      }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
  });

  it("(i) pago de valor 0 → 0 cobrable y sin costo bancario", () => {
    expect(
      parteCobrableDePago({
        valor: 0n,
        costoBancario: 3_900n,
        facturas: [rep(1_000_000n), noRep(300_000n)],
      }),
    ).toEqual({ valor: 0n, costoBancario: 0n });
  });

  it("(j) 600 casos pseudoaleatorios (con abonos parciales y mayores que la factura): nunca se cobra asesoría y el caso normal es exacto", () => {
    // LCG determinista (semilla fija) para que el caso sea reproducible.
    let semilla = 20_260_924n;
    const siguiente = (tope: bigint): bigint => {
      semilla = (semilla * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return (semilla >> 16n) % tope;
    };

    let casosConSobrante = 0;
    for (let caso = 0; caso < 600; caso++) {
      const costoBancario = siguiente(2n) === 0n ? 0n : 3_900n;
      const n = 1 + Number(siguiente(3n)); // 1..3 facturas
      // Lo que el pago REALMENTE abona a cada factura:
      // 0 = bloque normal (abono = factura), 1 = abono parcial (≤ factura),
      // 2 = abono libre hasta el doble de la factura (sobrantes).
      const modo = siguiente(3n);
      const facturas: EnlaceFacturaCobro[] = [];
      const abonos: bigint[] = [];
      for (let k = 0; k < n; k++) {
        const valorFactura = 1n + siguiente(20_000_000n);
        facturas.push({ valorFactura, repercutible: siguiente(2n) === 0n });
        abonos.push(
          modo === 0n
            ? valorFactura
            : modo === 1n
              ? siguiente(valorFactura + 1n)
              : siguiente(2n * valorFactura + 1n),
        );
      }
      const valor = abonos.reduce((s, a) => s + a, 0n);
      const sumaValores = facturas.reduce((s, f) => s + f.valorFactura, 0n);
      const cobrableReal = abonos
        .filter((_, i) => facturas[i].repercutible)
        .reduce((s, a) => s + a, 0n);
      const topeCobrable = facturas
        .filter((f) => f.repercutible)
        .reduce((s, f) => s + f.valorFactura, 0n);
      const asesoriaPagadaDeMas =
        abonos.filter((_, i) => !facturas[i].repercutible).reduce((s, a) => s + a, 0n) >
        facturas.filter((f) => !f.repercutible).reduce((s, f) => s + f.valorFactura, 0n);
      const hayNoRep = facturas.some((f) => !f.repercutible);
      const hayRep = facturas.some((f) => f.repercutible);
      if (valor > sumaValores) casosConSobrante++;

      const d = desglosarPago({ valor, costoBancario, facturas });
      const r = d.cobrable;

      expect(r.valor + d.noCobrable, `caso ${caso}: cobrable + noCobrable = valor`).toBe(valor);
      expect(r.valor >= 0n && r.valor <= valor, `caso ${caso}: 0 ≤ cobrable ≤ valor`).toBe(true);
      if (hayNoRep) {
        // Con asesoría: nunca más de lo que suman las facturas que se cobran, y
        // un pago de solo asesoría no cobra nada aunque traiga sobrante.
        expect(r.valor <= topeCobrable, `caso ${caso}: tope de lo cobrable`).toBe(true);
        if (!hayRep) expect(r.valor, `caso ${caso}: solo asesoría → 0`).toBe(0n);
        // Un sobrante (pago mayor que sus facturas) siempre queda por revisar.
        if (valor > sumaValores) expect(d.porRevisar, `caso ${caso}: sobrante marcado`).toBe(true);
        // Nunca contra el cliente: si la asesoría no se pagó de más, lo cobrado
        // no pasa de lo que de verdad se abonó a lo que se cobra (la única
        // ambigüedad indetectable sin montos es asesoría pagada de más).
        if (!asesoriaPagadaDeMas) {
          expect(r.valor <= cobrableReal, `caso ${caso}: no cobra asesoría`).toBe(true);
        }
      }
      // Caso normal (pago = suma de sus facturas): exacto y sin marca.
      if (modo === 0n) {
        expect(r.valor, `caso ${caso}: exacto en el bloque normal`).toBe(cobrableReal);
        expect(d.porRevisar, `caso ${caso}: sin marca`).toBe(false);
      }
      // Costo bancario: completo salvo que no quede nada cobrable con asesoría.
      expect(r.costoBancario).toBe(hayNoRep && r.valor === 0n ? 0n : costoBancario);

      // Con el monto por enlace de CxP v2 el reparto es exacto siempre.
      if (valor > 0n) {
        const conMonto = desglosarPago({
          valor,
          costoBancario,
          facturas: facturas.map((f, i) => ({ ...f, monto: abonos[i] })),
        });
        expect(conMonto.cobrable.valor, `caso ${caso}: exacto con v2`).toBe(cobrableReal);
        expect(conMonto.porRevisar, `caso ${caso}: v2 sin marca`).toBe(false);
      }
    }
    // El generador sí produce pagos mayores que sus facturas.
    expect(casosConSobrante).toBeGreaterThan(50);
  });
});

describe("desglosarPago", () => {
  it("marca por revisar los pagos con asesoría que no cuadran con sus facturas", () => {
    // Bloque normal (valor = suma): exacto, sin marca.
    expect(
      desglosarPago({
        valor: 1_300_000n,
        costoBancario: 3_900n,
        facturas: [rep(1_000_000n), noRep(300_000n)],
      }),
    ).toEqual({
      cobrable: { valor: 1_000_000n, costoBancario: 3_900n },
      noCobrable: 300_000n,
      sumaFacturas: 1_300_000n,
      porRevisar: false,
    });
    // Mixto con abono parcial: marcado.
    expect(
      desglosarPago({
        valor: 800_000n,
        costoBancario: 3_900n,
        facturas: [rep(1_000_000n), noRep(300_000n)],
      }),
    ).toEqual({
      cobrable: { valor: 500_000n, costoBancario: 3_900n },
      noCobrable: 300_000n,
      sumaFacturas: 1_300_000n,
      porRevisar: true,
    });
    // Solo asesoría con sobrante: nada cobrable y marcado (el sobrante lo
    // asume Galcomex; si era transporte, falta enlazar su factura).
    expect(
      desglosarPago({ valor: 1_300_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] }),
    ).toEqual({
      cobrable: { valor: 0n, costoBancario: 0n },
      noCobrable: 1_300_000n,
      sumaFacturas: 300_000n,
      porRevisar: true,
    });
    // Solo asesoría con abono parcial: exacto (0 cobrable), sin marca.
    expect(
      desglosarPago({ valor: 150_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] }),
    ).toEqual({
      cobrable: { valor: 0n, costoBancario: 0n },
      noCobrable: 150_000n,
      sumaFacturas: 300_000n,
      porRevisar: false,
    });
    // Pagos sin asesoría nunca se marcan.
    expect(
      desglosarPago({ valor: 900_000n, costoBancario: 0n, facturas: [rep(1_000_000n)] }).porRevisar,
    ).toBe(false);
    expect(desglosarPago({ valor: 900_000n, costoBancario: 0n, facturas: [] })).toEqual({
      cobrable: { valor: 900_000n, costoBancario: 0n },
      noCobrable: 0n,
      sumaFacturas: 0n,
      porRevisar: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Montos del pago en bloque recuperados de la auditoría (puente hasta CxP v2)
// ---------------------------------------------------------------------------
describe("montoPagadoEnGrupoDeAuditoria", () => {
  it("lee el monto del bloque (texto o número entero positivo) y descarta lo demás", () => {
    expect(montoPagadoEnGrupoDeAuditoria({ estado: "REGISTRADA", montoPagadoEnGrupo: "288000" })).toBe(
      288_000n,
    );
    expect(montoPagadoEnGrupoDeAuditoria({ montoPagadoEnGrupo: 288_000 })).toBe(288_000n);
    // Filas UPDATE_ESTADO del pago manual o de eliminar un pago: sin monto.
    expect(montoPagadoEnGrupoDeAuditoria({ estado: "REGISTRADA" })).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria({ montoPagadoEnGrupo: "0" })).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria({ montoPagadoEnGrupo: "-5" })).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria({ montoPagadoEnGrupo: "12.5" })).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria({ montoPagadoEnGrupo: 12.5 })).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria(null)).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria("288000")).toBeNull();
    expect(montoPagadoEnGrupoDeAuditoria([{ montoPagadoEnGrupo: "1" }])).toBeNull();
  });
});

describe("montosDeBloquesAuditados", () => {
  const bloque = (
    id: string,
    valor: bigint,
    facturaIds: string[],
    grupoPagoId: string | null = `g-${id}`,
  ): PagoConEnlaces => ({ id, valor, grupoPagoId, facturaIds });

  it("asigna los montos de un bloque inequívoco (asesoría neta de retención) y el reparto queda exacto", () => {
    const montos = montosDeBloquesAuditados(
      [bloque("P1", 1_288_000n, ["T", "S"])],
      [
        { facturaId: "T", monto: 1_000_000n },
        { facturaId: "S", monto: 288_000n },
      ],
    );
    expect(montos.get("P1")).toEqual(
      new Map([
        ["T", 1_000_000n],
        ["S", 288_000n],
      ]),
    );
    const d = desglosarPago({
      valor: 1_288_000n,
      costoBancario: 3_900n,
      facturas: [rep(1_000_000n, montos.get("P1")!.get("T")), noRep(300_000n, montos.get("P1")!.get("S"))],
    });
    expect(d.cobrable).toEqual({ valor: 1_000_000n, costoBancario: 3_900n });
    expect(d.porRevisar).toBe(false);
  });

  it("dos bloques que abonan lo mismo a las mismas facturas: da igual cuál fila es de cuál → exacto", () => {
    const pagos = [bloque("P1", 650_000n, ["T", "S"]), bloque("P2", 650_000n, ["T", "S"])];
    const montos = montosDeBloquesAuditados(pagos, [
      { facturaId: "T", monto: 500_000n },
      { facturaId: "S", monto: 150_000n },
      { facturaId: "T", monto: 500_000n },
      { facturaId: "S", monto: 150_000n },
    ]);
    const cobrado = pagos
      .map((p) =>
        desglosarPago({
          valor: p.valor,
          costoBancario: 0n,
          facturas: [rep(1_000_000n, montos.get(p.id)?.get("T")), noRep(300_000n, montos.get(p.id)?.get("S"))],
        }).cobrable.valor,
      )
      .reduce((s, v) => s + v, 0n);
    // Sin montos serían 350.000 + 350.000 = 700.000 (Galcomex perdía 300.000).
    expect(cobrado).toBe(1_000_000n);
  });

  it("descarta lo ambiguo o inconsistente (se reparte por el valor de las facturas)", () => {
    // Montos distintos para la misma factura en dos bloques: no se sabe cuál es cuál.
    expect(
      montosDeBloquesAuditados(
        [bloque("P1", 900_000n, ["T", "S"]), bloque("P2", 400_000n, ["T", "S"])],
        [
          { facturaId: "T", monto: 600_000n },
          { facturaId: "T", monto: 300_000n },
          { facturaId: "S", monto: 300_000n },
          { facturaId: "S", monto: 100_000n },
        ],
      ).size,
    ).toBe(0);
    // Una fila de más (bloque eliminado) para la asesoría.
    expect(
      montosDeBloquesAuditados(
        [bloque("P1", 1_288_000n, ["T", "S"])],
        [
          { facturaId: "T", monto: 1_000_000n },
          { facturaId: "S", monto: 288_000n },
          { facturaId: "S", monto: 300_000n },
        ],
      ).size,
    ).toBe(0);
    // Falta la fila de una factura.
    expect(
      montosDeBloquesAuditados([bloque("P1", 1_288_000n, ["T", "S"])], [{ facturaId: "T", monto: 1_000_000n }])
        .size,
    ).toBe(0);
    // Σ montos ≠ valor del pago (alguien editó el valor).
    expect(
      montosDeBloquesAuditados(
        [bloque("P1", 1_300_000n, ["T", "S"])],
        [
          { facturaId: "T", monto: 1_000_000n },
          { facturaId: "S", monto: 288_000n },
        ],
      ).size,
    ).toBe(0);
  });

  it("ignora los pagos que no son de un bloque, sin contarlos como enlaces de bloque", () => {
    const montos = montosDeBloquesAuditados(
      [
        bloque("P1", 1_288_000n, ["T", "S"]),
        // Pago manual enlazado a la misma asesoría: no deja monto en la auditoría.
        bloque("P3", 12_000n, ["S"], null),
        // Bloque sin facturas (defensivo).
        bloque("P4", 5_000n, []),
      ],
      [
        { facturaId: "T", monto: 1_000_000n },
        { facturaId: "S", monto: 288_000n },
      ],
    );
    expect([...montos.keys()]).toEqual(["P1"]);
  });
});

describe("pagosCobrablesParaMotor", () => {
  it("(k) conserva el orden y la longitud (1 a 1)", () => {
    const pagos: PagoParaCobro[] = [
      { valor: 500_000n, costoBancario: 3_900n, facturas: [noRep(500_000n)] },
      { valor: 2_000_000n, costoBancario: 3_900n, facturas: [] },
      { valor: 1_300_000n, costoBancario: 0n, facturas: [rep(1_000_000n), noRep(300_000n)] },
    ];
    expect(pagosCobrablesParaMotor(pagos)).toEqual([
      { valor: 0n, costoBancario: 0n },
      { valor: 2_000_000n, costoBancario: 3_900n },
      { valor: 1_000_000n, costoBancario: 0n },
    ]);
    expect(pagosCobrablesParaMotor([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Motor con asesoría: los pagos de facturas no repercutibles no suman en
// totalPagos, costos bancarios ni en la base del 4x1000.
// ---------------------------------------------------------------------------
describe("motor con asesoría", () => {
  const PAGOS: PagoParaCobro[] = [
    // A: pago suelto (histórico) → completo.
    { valor: 2_000_000n, costoBancario: 3_900n, facturas: [] },
    // B: solo asesoría Ascinter → fuera.
    { valor: 500_000n, costoBancario: 3_900n, facturas: [noRep(500_000n)] },
    // C: transporte 1.000.000 (se cobra) + asesoría 300.000 (no) en un solo pago.
    { valor: 1_300_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n), noRep(300_000n)] },
  ];
  const BASE = {
    totalAnticipoAplicado: 3_000_000n,
    costoRecaudoAnticipo: 1_950n,
    comision: 200_000n,
    tasaIva: TASA_IVA,
    tasa4x1000: TASA_4X1000,
  };

  it("solo cuenta lo cobrable: totalPagos 3.000.000, costos 9.750, 4x1000 12.991", () => {
    const r = calcularBorrador({ ...BASE, pagos: pagosCobrablesParaMotor(PAGOS) });
    expect(r.totalPagos).toBe(3_000_000n);
    // 1.950 recaudo + 3.900 (A) + 3.900 (C); el de B lo asume Galcomex.
    expect(r.costosBancarios).toBe(9_750n);
    expect(r.ivaComision).toBe(38_000n);
    // saldo antes del 4x1000 = 0 − 200.000 − 38.000 − 9.750 = −247.750 (a cargo)
    expect(r.aplica4x1000).toBe(false);
    // base = 3.000.000 + 247.750 = 3.247.750 → × 0,004 = 12.991
    expect(r.impuesto4x1000).toBe(12_991n);
    expect(r.saldoFinal).toBe(-260_741n);
    expect(r.saldoACargoCliente).toBe(260_741n);
  });

  it("documental: sin el filtro, la asesoría inflaba totalPagos, costos y 4x1000", () => {
    const r = calcularBorrador({
      ...BASE,
      pagos: PAGOS.map((p) => ({ valor: p.valor, costoBancario: p.costoBancario })),
    });
    expect(r.totalPagos).toBe(3_800_000n);
    expect(r.costosBancarios).toBe(13_650n);
    expect(r.impuesto4x1000).toBe(16_206n);
  });

  it("asesoría pagada de más (300.000 registrada, 357.000 pagada): el borrador da lo mismo que sin asesoría", () => {
    const conAsesoria = calcularBorrador({
      ...BASE,
      pagos: pagosCobrablesParaMotor([
        { valor: 2_000_000n, costoBancario: 3_900n, facturas: [] },
        { valor: 357_000n, costoBancario: 3_900n, facturas: [noRep(300_000n)] },
      ]),
    });
    const sinAsesoria = calcularBorrador({
      ...BASE,
      pagos: [{ valor: 2_000_000n, costoBancario: 3_900n }],
    });
    expect(conAsesoria).toEqual(sinAsesoria);
    expect(conAsesoria.totalPagos).toBe(2_000_000n);
    expect(conAsesoria.costosBancarios).toBe(5_850n);
    expect(conAsesoria.saldoFinal).toBe(744_150n);
  });

  it("abono parcial en bloque: el borrador da lo mismo que si la asesoría nunca hubiera existido", () => {
    const BASE_ABONO = {
      totalAnticipoAplicado: 3_000_000n,
      costoRecaudoAnticipo: 1_950n,
      comision: 200_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
    };
    // Bloque a Ascinter: 500.000 al transporte (factura 1.000.000) + asesoría
    // 300.000 = 800.000; luego el resto del transporte (500.000) va suelto.
    const conAsesoria = calcularBorrador({
      ...BASE_ABONO,
      pagos: pagosCobrablesParaMotor([
        { valor: 800_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n), noRep(300_000n)] },
        { valor: 500_000n, costoBancario: 3_900n, facturas: [] },
      ]),
    });
    const sinAsesoria = calcularBorrador({
      ...BASE_ABONO,
      pagos: [
        { valor: 500_000n, costoBancario: 3_900n },
        { valor: 500_000n, costoBancario: 3_900n },
      ],
    });
    expect(conAsesoria).toEqual(sinAsesoria);
    expect(conAsesoria.totalPagos).toBe(1_000_000n);
    expect(conAsesoria.saldoAFavorCliente).toBe(1_740_250n);
  });

  it("dorado BUN26-0026: pagos sin facturas enlazadas dan el mismo resultado exacto", () => {
    const PAGOS_DORADO = [
      { valor: 1_000_000n, costoBancario: 3_900n },
      { valor: 2_011_341n, costoBancario: 0n },
      { valor: 30_854_000n, costoBancario: 0n },
      { valor: 2_216_233n, costoBancario: 0n },
      { valor: 760_283n, costoBancario: 3_900n },
      { valor: 175_787n, costoBancario: 3_900n },
      { valor: 3_500_000n, costoBancario: 3_900n },
    ];
    const INPUT_DORADO = {
      totalAnticipoAplicado: 45_226_000n,
      costoRecaudoAnticipo: 1_950n,
      pagos: PAGOS_DORADO,
      comision: 200_000n,
      ivaComision: 76_000n,
      tasaIva: TASA_IVA,
      tasa4x1000: TASA_4X1000,
      montoLM: 875_944n,
    };

    const original = calcularBorrador(INPUT_DORADO);
    const conFiltro = calcularBorrador({
      ...INPUT_DORADO,
      pagos: pagosCobrablesParaMotor(PAGOS_DORADO.map((p) => ({ ...p, facturas: [] }))),
    });

    expect(conFiltro).toEqual(original);
    expect(conFiltro.impuesto4x1000).toBe(180_904n);
    expect(conFiltro.costosBancarios).toBe(17_550n);
    expect(conFiltro.saldoFinal).toBe(4_233_902n);
    expect(conFiltro.totalFactura).toBe(41_868_042n);
    expect(conFiltro.saldoAFavorCliente).toBe(3_357_958n);
    expect(conFiltro.saldoAFavorLM).toBe(875_944n);
  });
});

// ---------------------------------------------------------------------------
// Pagos del libro listos para desglosar: bloque con auditoría ambigua
// ---------------------------------------------------------------------------
describe("prepararPagosParaCobro", () => {
  const T = { facturaId: "T", valorFactura: 1_000_000n, repercutible: true };
  const S = { facturaId: "S", valorFactura: 300_000n, repercutible: false };
  const pagoLibro = (
    id: string,
    valor: bigint,
    facturas: PagoDelLibro["facturas"],
    grupoPagoId: string | null = `g-${id}`,
    costoBancario = 0n,
  ): PagoDelLibro => ({ id, valor, costoBancario, grupoPagoId, facturas });

  it("hallazgo: bloque (T 943.000 + S 357.000) eliminado y rehecho igual → cobra 943.000, nunca asesoría, y queda por revisar", () => {
    // Auditoría: las filas del bloque eliminado P1 siguen ahí, así que para
    // cada factura hay 2 filas y 1 solo enlace de bloque (P2) → ambigua.
    const abonos: AbonoBloqueAuditado[] = [
      { facturaId: "T", monto: 943_000n },
      { facturaId: "S", monto: 357_000n },
      { facturaId: "T", monto: 943_000n },
      { facturaId: "S", monto: 357_000n },
    ];
    const P2 = pagoLibro("P2", 1_300_000n, [T, S]);

    // Antes del arreglo: sin montos se repartía por valor de factura y el pago
    // cuadraba con la suma (1.300.000) → 57.000 de asesoría al cliente, sin marca.
    const antes = desglosarPago({
      valor: P2.valor,
      costoBancario: 0n,
      facturas: [rep(1_000_000n), noRep(300_000n)],
    });
    expect(antes.cobrable.valor).toBe(1_000_000n);
    expect(antes.porRevisar).toBe(false);

    const [preparado] = prepararPagosParaCobro([P2], abonos);
    expect(preparado.bloqueSinMontos).toBe(true);
    // La asesoría pesa lo mayor entre su factura (300.000) y lo que la
    // auditoría le registra (357.000); el transporte conserva su valor.
    expect(preparado.paraCobro.facturas).toEqual([
      { valorFactura: 1_000_000n, repercutible: true },
      { valorFactura: 357_000n, repercutible: false },
    ]);

    const d = desglosarPago(preparado.paraCobro);
    expect(d.cobrable.valor).toBe(943_000n);
    expect(d.noCobrable).toBe(357_000n);
    expect(
      motivoRevisionPago(preparado.paraCobro, d, {
        bloqueSinMontos: preparado.bloqueSinMontos,
        tramiteConAsesoria: true,
        asesoriaSinCubrir: true,
        sobranteCobradoEnGrupo: false,
      }),
    ).toBe("BLOQUE_SIN_MONTOS");
  });

  it("bloque con montos inequívocos: exacto y sin marca (la asesoría pagada de más no se cobra)", () => {
    const [p] = prepararPagosParaCobro(
      [pagoLibro("P1", 1_300_000n, [T, S])],
      [
        { facturaId: "T", monto: 943_000n },
        { facturaId: "S", monto: 357_000n },
      ],
    );
    expect(p.bloqueSinMontos).toBe(false);
    expect(p.paraCobro.facturas).toEqual([
      { valorFactura: 1_000_000n, repercutible: true, monto: 943_000n },
      { valorFactura: 300_000n, repercutible: false, monto: 357_000n },
    ]);
    const d = desglosarPago(p.paraCobro);
    expect(d.cobrable.valor).toBe(943_000n);
    expect(d.porRevisar).toBe(false);
  });

  it("bloque con asesoría sin filas de auditoría (histórico) o con el valor editado: por revisar", () => {
    // Sin filas: la asesoría pesa su factura, pero el reparto es una suposición.
    const [sinFilas] = prepararPagosParaCobro([pagoLibro("P1", 1_300_000n, [T, S])], []);
    expect(sinFilas.bloqueSinMontos).toBe(true);
    expect(sinFilas.paraCobro.facturas).toEqual([
      { valorFactura: 1_000_000n, repercutible: true },
      { valorFactura: 300_000n, repercutible: false },
    ]);
    // Valor editado a mano (Σ montos 1.300.000 ≠ 1.250.000): se descarta y la
    // asesoría pesa lo que la auditoría le registra.
    const [editado] = prepararPagosParaCobro(
      [pagoLibro("P1", 1_250_000n, [T, S])],
      [
        { facturaId: "T", monto: 943_000n },
        { facturaId: "S", monto: 357_000n },
      ],
    );
    expect(editado.bloqueSinMontos).toBe(true);
    expect(desglosarPago(editado.paraCobro).cobrable.valor).toBe(893_000n);
  });

  it("la factura que se cobra nunca sube de peso aunque la auditoría le registre más", () => {
    const [p] = prepararPagosParaCobro(
      [pagoLibro("P2", 1_500_000n, [T, S])],
      [
        { facturaId: "T", monto: 1_200_000n },
        { facturaId: "S", monto: 300_000n },
        { facturaId: "T", monto: 1_200_000n },
        { facturaId: "S", monto: 300_000n },
      ],
    );
    expect(p.bloqueSinMontos).toBe(true);
    expect(p.paraCobro.facturas[0]).toEqual({ valorFactura: 1_000_000n, repercutible: true });
    // Lo cobrable no pasa del valor de la factura del transporte (contra Galcomex).
    expect(desglosarPago(p.paraCobro).cobrable.valor).toBe(1_000_000n);
  });

  it("no toca pagos sueltos, pagos manuales ni bloques 100 % repercutibles", () => {
    const abonos: AbonoBloqueAuditado[] = [
      { facturaId: "S", monto: 357_000n },
      { facturaId: "S", monto: 357_000n },
    ];
    const pagos = [
      pagoLibro("suelto", 2_000_000n, [], null, 3_900n),
      // Pago manual (sin bloque) de la asesoría: sin auditoría de montos, su
      // factura conserva el valor y no se marca como bloque.
      pagoLibro("manual", 357_000n, [S], null, 3_900n),
      // Bloque 100 % repercutible sin filas: identidad (R2), sin marca.
      pagoLibro("bloque-t", 1_000_000n, [T]),
    ];
    const preparados = prepararPagosParaCobro(pagos, abonos);
    expect(preparados.map((p) => p.bloqueSinMontos)).toEqual([false, false, false]);
    expect(preparados.map((p) => p.paraCobro)).toEqual([
      { valor: 2_000_000n, costoBancario: 3_900n, facturas: [] },
      {
        valor: 357_000n,
        costoBancario: 3_900n,
        facturas: [{ valorFactura: 300_000n, repercutible: false }],
      },
      {
        valor: 1_000_000n,
        costoBancario: 0n,
        facturas: [{ valorFactura: 1_000_000n, repercutible: true }],
      },
    ]);
    expect(pagos.map((p) => esBloqueConAsesoria(p))).toEqual([false, false, false]);
    expect(esBloqueConAsesoria(pagoLibro("b", 1n, [T, S]))).toBe(true);
  });

  it("400 trámites pseudoaleatorios con bloques rehechos: un bloque con asesoría nunca cobra asesoría; exacto si la auditoría es inequívoca, marcado si no", () => {
    let semilla = 202_609_244n;
    const siguiente = (tope: bigint): bigint => {
      semilla = (semilla * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return (semilla >> 16n) % tope;
    };
    const POOL = [
      { facturaId: "T1", valorFactura: 1_000_000n, repercutible: true },
      { facturaId: "T2", valorFactura: 2_500_000n, repercutible: true },
      { facturaId: "S1", valorFactura: 300_000n, repercutible: false },
      { facturaId: "S2", valorFactura: 120_000n, repercutible: false },
    ];

    let ambiguos = 0;
    let exactos = 0;
    for (let caso = 0; caso < 400; caso++) {
      const nBloques = 1 + Number(siguiente(3n));
      // Mitad de los trámites: todos los bloques abonan lo mismo (repetición exacta).
      const repetido = siguiente(2n) === 0n;
      const abonos: AbonoBloqueAuditado[] = [];
      const vivos: Array<{ pago: PagoDelLibro; real: Map<string, bigint> }> = [];
      let plantilla: Array<{ facturaId: string; monto: bigint }> | null = null;
      for (let b = 0; b < nBloques; b++) {
        let lineas: Array<{ facturaId: string; monto: bigint }>;
        if (repetido && plantilla) {
          lineas = plantilla;
        } else {
          lineas = POOL.filter(() => siguiente(2n) === 0n).map((f) => ({
            facturaId: f.facturaId,
            monto: 1n + siguiente(2n * f.valorFactura),
          }));
          if (lineas.length === 0) lineas = [{ facturaId: "S1", monto: 1n + siguiente(600_000n) }];
          plantilla = lineas;
        }
        // El bloque siempre deja su fila por factura, aunque luego se elimine.
        for (const l of lineas) abonos.push({ ...l });
        const eliminado = b < nBloques - 1 && siguiente(3n) === 0n;
        if (eliminado) continue;
        vivos.push({
          pago: {
            id: `c${caso}-b${b}`,
            valor: lineas.reduce((s, l) => s + l.monto, 0n),
            costoBancario: 3_900n,
            grupoPagoId: `g${caso}-${b}`,
            facturas: lineas.map((l) => POOL.find((f) => f.facturaId === l.facturaId)!),
          },
          real: new Map(lineas.map((l) => [l.facturaId, l.monto])),
        });
      }

      const preparados = prepararPagosParaCobro(
        vivos.map((v) => v.pago),
        abonos,
      );
      preparados.forEach((prep, i) => {
        const { pago, real } = vivos[i];
        const d = desglosarPago(prep.paraCobro);
        const cobrableReal = pago.facturas
          .filter((f) => f.repercutible)
          .reduce((s, f) => s + real.get(f.facturaId)!, 0n);
        const tieneAsesoria = pago.facturas.some((f) => !f.repercutible);

        expect(d.cobrable.valor + d.noCobrable, `caso ${caso}: suma`).toBe(pago.valor);
        if (!tieneAsesoria) {
          expect(prep.bloqueSinMontos).toBe(false);
          expect(d.cobrable.valor, `caso ${caso}: R2 identidad`).toBe(pago.valor);
          return;
        }
        // Nunca un peso de asesoría al cliente, con o sin montos.
        expect(d.cobrable.valor <= cobrableReal, `caso ${caso}: no cobra asesoría`).toBe(true);
        const motivo = motivoRevisionPago(prep.paraCobro, d, {
          bloqueSinMontos: prep.bloqueSinMontos,
          tramiteConAsesoria: true,
          asesoriaSinCubrir: true,
          sobranteCobradoEnGrupo: false,
        });
        if (prep.bloqueSinMontos) {
          ambiguos++;
          expect(motivo, `caso ${caso}: ambiguo marcado`).toBe("BLOQUE_SIN_MONTOS");
        } else {
          exactos++;
          expect(d.cobrable.valor, `caso ${caso}: exacto con montos`).toBe(cobrableReal);
          expect(motivo, `caso ${caso}: exacto sin marca`).toBeNull();
        }
      });
    }
    // El generador sí produce los dos caminos.
    expect(ambiguos).toBeGreaterThan(30);
    expect(exactos).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// Por qué un pago queda por revisar (solo marca: ningún total cambia)
// ---------------------------------------------------------------------------
describe("motivoRevisionPago", () => {
  const motivo = (
    pago: PagoParaCobro,
    contexto: {
      bloqueSinMontos?: boolean;
      tramiteConAsesoria?: boolean;
      asesoriaSinCubrir?: boolean;
      sobranteCobradoEnGrupo?: boolean;
    } = {},
  ) =>
    motivoRevisionPago(pago, desglosarPago(pago), {
      bloqueSinMontos: contexto.bloqueSinMontos ?? false,
      tramiteConAsesoria: contexto.tramiteConAsesoria ?? false,
      asesoriaSinCubrir: contexto.asesoriaSinCubrir ?? false,
      sobranteCobradoEnGrupo: contexto.sobranteCobradoEnGrupo ?? false,
    });
  const pago = (valor: bigint, facturas: EnlaceFacturaCobro[]): PagoParaCobro => ({
    valor,
    costoBancario: 3_900n,
    facturas,
  });

  it("bloque sin montos manda sobre todo lo demás", () => {
    expect(
      motivo(pago(1_300_000n, [rep(1_000_000n), noRep(357_000n)]), { bloqueSinMontos: true }),
    ).toBe("BLOQUE_SIN_MONTOS");
    // Aunque el pago cuadre con la suma (desglose sin marca).
    expect(
      motivo(pago(1_300_000n, [rep(1_000_000n), noRep(300_000n)]), { bloqueSinMontos: true }),
    ).toBe("BLOQUE_SIN_MONTOS");
  });

  it("combina el porRevisar del desglose: sobrante no cobrado o abono parcial", () => {
    expect(motivo(pago(1_200_000n, [noRep(200_000n)]))).toBe("SOBRANTE_NO_COBRADO");
    expect(motivo(pago(1_000_000n, [rep(600_000n), noRep(300_000n)]))).toBe("SOBRANTE_NO_COBRADO");
    expect(motivo(pago(800_000n, [rep(1_000_000n), noRep(300_000n)]))).toBe("ABONO_PARCIAL");
    // Cuadra con la suma o es solo asesoría menor: sin marca.
    expect(motivo(pago(1_300_000n, [rep(1_000_000n), noRep(300_000n)]))).toBeNull();
    expect(motivo(pago(150_000n, [noRep(300_000n)]))).toBeNull();
  });

  it("trámite SIN asesoría: pagos sueltos y 100 % repercutibles nunca se marcan (casos dorados)", () => {
    expect(motivo(pago(2_000_000n, []))).toBeNull();
    expect(motivo(pago(1_200_000n, [rep(1_000_000n)]))).toBeNull();
  });

  it("trámite con asesoría SIN CUBRIR: se marcan el pago suelto y el que paga de más facturas que se cobran", () => {
    const conAsesoria = { tramiteConAsesoria: true, asesoriaSinCubrir: true };
    expect(motivo(pago(2_000_000n, []), conAsesoria)).toBe("PAGO_SIN_FACTURAS");
    // Un pago suelto de 0 no le cobra nada al cliente.
    expect(motivo(pago(0n, []), conAsesoria)).toBeNull();
    expect(motivo(pago(1_300_000n, [rep(1_000_000n)]), conAsesoria)).toBe("SOBRANTE_COBRADO");
    expect(motivo(pago(1_300_000n, [rep(1_000_000n), rep(200_000n)]), conAsesoria)).toBe(
      "SOBRANTE_COBRADO",
    );
    // Igual o menor que sus facturas: sin marca.
    expect(motivo(pago(1_000_000n, [rep(1_000_000n)]), conAsesoria)).toBeNull();
    expect(motivo(pago(500_000n, [rep(1_000_000n)]), conAsesoria)).toBeNull();
    // Mixto que cuadra: sin marca.
    expect(motivo(pago(1_300_000n, [rep(1_000_000n), noRep(300_000n)]), conAsesoria)).toBeNull();
  });

  it("trámite con TODA la asesoría cubierta por sus pagos enlazados: el pago suelto ya no se marca; el sobrante cobrado sí", () => {
    const cubierta = { tramiteConAsesoria: true, asesoriaSinCubrir: false };
    // Antes bastaba con que el trámite tuviera una factura NO SE COBRA: cada
    // pago suelto (naviera, puerto, impuestos) salía como PAGO_SIN_FACTURAS.
    expect(motivo(pago(2_000_000n, []), cubierta)).toBeNull();
    // SOBRANTE_COBRADO sigue exigiendo solo que el trámite tenga asesoría.
    expect(motivo(pago(1_300_000n, [rep(1_000_000n)]), cubierta)).toBe("SOBRANTE_COBRADO");
    expect(
      motivo(pago(650_000n, [rep(1_000_000n)]), { ...cubierta, sobranteCobradoEnGrupo: true }),
    ).toBe("SOBRANTE_COBRADO");
  });

  it("la marca no cambia ningún total: dorado BUN26-0026 en un trámite con asesoría", () => {
    const PAGOS_DORADO: PagoParaCobro[] = [
      1_000_000n,
      2_011_341n,
      30_854_000n,
      2_216_233n,
      760_283n,
      175_787n,
      3_500_000n,
    ].map((valor, i) => ({ valor, costoBancario: i >= 3 ? 3_900n : 0n, facturas: [] }));
    const motivos = (asesoriaSinCubrir: boolean) =>
      PAGOS_DORADO.map((p) =>
        motivoRevisionPago(p, desglosarPago(p), {
          bloqueSinMontos: false,
          tramiteConAsesoria: true,
          asesoriaSinCubrir,
          sobranteCobradoEnGrupo: false,
        }),
      );
    expect(motivos(true)).toEqual(Array(7).fill("PAGO_SIN_FACTURAS"));
    // Con la asesoría cubierta por sus pagos enlazados, ninguno se marca.
    expect(motivos(false)).toEqual(Array(7).fill(null));
    expect(pagosCobrablesParaMotor(PAGOS_DORADO)).toEqual(
      PAGOS_DORADO.map((p) => ({ valor: p.valor, costoBancario: p.costoBancario })),
    );
  });
});

// ---------------------------------------------------------------------------
// Pagos que, sumados, le cobran de más al cliente por sus facturas (solo marca)
// ---------------------------------------------------------------------------
describe("sobranteCobradoPorGrupo", () => {
  const fac = (facturaId: string, valorFactura: bigint, repercutible = true) => ({
    facturaId,
    valorFactura,
    repercutible,
  });
  const T1 = fac("T1", 1_000_000n);
  const T2 = fac("T2", 1_000_000n);
  const T3 = fac("T3", 1_000_000n);
  const S = fac("S", 300_000n, false);
  /** Pago del libro con lo que se le cobra al cliente según su reparto (sin montos por enlace). */
  const pago = (valor: bigint, facturas: PagoDelLibro["facturas"]) => ({
    cobrable: desglosarPago({
      valor,
      costoBancario: 0n,
      facturas: facturas.map((f) => ({ valorFactura: f.valorFactura, repercutible: f.repercutible })),
    }).cobrable.valor,
    facturas,
  });

  it("transporte 1.000.000 pagado con dos transferencias de 650.000: las dos quedan marcadas", () => {
    // Ninguna supera sola su factura, pero juntas le cobran 1.300.000 al cliente.
    expect(sobranteCobradoPorGrupo([pago(650_000n, [T1]), pago(650_000n, [T1])])).toEqual([
      true,
      true,
    ]);
  });

  it("pagos que cuadran o quedan por debajo de sus facturas: sin marca", () => {
    expect(sobranteCobradoPorGrupo([pago(500_000n, [T1]), pago(500_000n, [T1])])).toEqual([
      false,
      false,
    ]);
    expect(sobranteCobradoPorGrupo([pago(400_000n, [T1])])).toEqual([false]);
    expect(sobranteCobradoPorGrupo([pago(1_500_000n, [T1, T2]), pago(500_000n, [T2])])).toEqual([
      false,
      false,
    ]);
  });

  it("un pago solo mayor que sus facturas también se marca (igual que la marca individual)", () => {
    expect(sobranteCobradoPorGrupo([pago(1_300_000n, [T1])])).toEqual([true]);
  });

  it("un pago enlazado a una parte de las facturas de otro entra en su grupo", () => {
    // T1 + T2 valen 2.000.000; los pagos que solo tocan esas facturas suman 2.200.000.
    // Mirando solo pagos con exactamente las mismas facturas, ninguno se marcaría.
    expect(sobranteCobradoPorGrupo([pago(1_000_000n, [T1]), pago(1_200_000n, [T1, T2])])).toEqual([
      true,
      true,
    ]);
  });

  it("cadena de pagos que comparten facturas: se compara con todas las facturas de la cadena", () => {
    // {T1, T2} y {T2, T3}: 3.100.000 pagados por facturas que valen 3.000.000.
    expect(
      sobranteCobradoPorGrupo([pago(1_500_000n, [T1, T2]), pago(1_600_000n, [T2, T3])]),
    ).toEqual([true, true]);
    expect(
      sobranteCobradoPorGrupo([pago(1_500_000n, [T1, T2]), pago(1_500_000n, [T2, T3])]),
    ).toEqual([false, false]);
  });

  it("grupos independientes no se mezclan", () => {
    expect(
      sobranteCobradoPorGrupo([pago(650_000n, [T1]), pago(400_000n, [T2]), pago(650_000n, [T1])]),
    ).toEqual([true, false, true]);
  });

  it("no entran pagos sueltos, pagos de solo asesoría ni pagos sin nada cobrable", () => {
    expect(
      sobranteCobradoPorGrupo([
        pago(5_000_000n, []),
        // Solo asesoría (aunque pague de más): no se le cobra nada al cliente.
        pago(1_200_000n, [S]),
        pago(0n, [T1]),
        pago(600_000n, [T1]),
      ]),
    ).toEqual([false, false, false, false]);
    // El pago de 0 no le cobra nada al cliente: aunque su grupo pague de más, no se marca.
    expect(
      sobranteCobradoPorGrupo([pago(0n, [T1]), pago(650_000n, [T1]), pago(650_000n, [T1])]),
    ).toEqual([false, true, true]);
    // Mixto que no alcanza ni para la asesoría: nada cobrable, no entra.
    const todoAsesoria = pago(300_000n, [T1, S]);
    expect(todoAsesoria.cobrable).toBe(0n);
    expect(sobranteCobradoPorGrupo([todoAsesoria, pago(1_000_000n, [T1])])).toEqual([
      false,
      false,
    ]);
  });

  it("hallazgo: bloque mixto que ya pagó transporte 1.000.000 + asesoría 300.000 y otra transferencia de 650.000 al transporte → las dos quedan marcadas", () => {
    // Antes solo contaban los pagos enlazados únicamente a facturas que se
    // cobran: la transferencia (650.000 < 1.000.000) quedaba sin marca, aunque
    // al cliente se le cobran 1.000.000 del bloque + 650.000 por un
    // transporte de 1.000.000.
    const bloque = pago(1_300_000n, [T1, S]);
    expect(bloque.cobrable).toBe(1_000_000n);
    expect(sobranteCobradoPorGrupo([bloque, pago(650_000n, [T1])])).toEqual([true, true]);
    // En el otro orden del libro, igual.
    expect(sobranteCobradoPorGrupo([pago(650_000n, [T1]), bloque])).toEqual([true, true]);
  });

  it("del pago mixto cuenta su parte cobrable (no su valor) contra sus facturas que se cobran", () => {
    // Abono parcial en bloque (500.000 al transporte + 300.000 de asesoría) y el
    // resto del transporte en otra transferencia: 500.000 + 500.000 = 1.000.000.
    expect(sobranteCobradoPorGrupo([pago(800_000n, [T1, S]), pago(500_000n, [T1])])).toEqual([
      false,
      false,
    ]);
    // Con 600.000 en la segunda, al cliente se le cobran 1.100.000 por el transporte.
    expect(sobranteCobradoPorGrupo([pago(800_000n, [T1, S]), pago(600_000n, [T1])])).toEqual([
      true,
      true,
    ]);
    // El mixto solo, que cuadra: sin marca.
    expect(sobranteCobradoPorGrupo([pago(1_300_000n, [T1, S])])).toEqual([false]);
    // Sus facturas que se cobran se encadenan con las de otros pagos:
    // 1.000.000 + 1.100.000 cobrados por T1 + T2 = 2.000.000.
    expect(
      sobranteCobradoPorGrupo([pago(1_300_000n, [T1, S]), pago(1_100_000n, [T1, T2])]),
    ).toEqual([true, true]);
  });

  it("con montos del bloque: usa el cobrable exacto del reparto, no el valor de la factura", () => {
    // Bloque: 943.000 al transporte + 357.000 a la asesoría (montos de la auditoría).
    const bloque = {
      cobrable: desglosarPago({
        valor: 1_300_000n,
        costoBancario: 0n,
        facturas: [rep(1_000_000n, 943_000n), noRep(300_000n, 357_000n)],
      }).cobrable.valor,
      facturas: [T1, S],
    };
    expect(bloque.cobrable).toBe(943_000n);
    // 943.000 + 57.000 = 1.000.000: el transporte completo, sin marca.
    expect(sobranteCobradoPorGrupo([bloque, pago(57_000n, [T1])])).toEqual([false, false]);
    // 943.000 + 100.000 = 1.043.000 > 1.000.000.
    expect(sobranteCobradoPorGrupo([bloque, pago(100_000n, [T1])])).toEqual([true, true]);
  });

  it("una factura con valor ≤ 0 (imposible por zod) cuenta como 0", () => {
    expect(sobranteCobradoPorGrupo([pago(100n, [fac("T0", 0n)])])).toEqual([true]);
    expect(sobranteCobradoPorGrupo([pago(100n, [fac("T0", -5n), T1])])).toEqual([false]);
  });

  it("con motivoRevisionPago: SOBRANTE_COBRADO solo en un trámite con asesoría y sin cambiar ningún total", () => {
    const paraCobro: PagoParaCobro[] = [
      { valor: 650_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n)] },
      { valor: 650_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n)] },
    ];
    const marcas = sobranteCobradoPorGrupo([pago(650_000n, [T1]), pago(650_000n, [T1])]);
    const motivos = (tramiteConAsesoria: boolean) =>
      paraCobro.map((p, i) =>
        motivoRevisionPago(p, desglosarPago(p), {
          bloqueSinMontos: false,
          tramiteConAsesoria,
          asesoriaSinCubrir: false,
          sobranteCobradoEnGrupo: marcas[i],
        }),
      );
    expect(motivos(true)).toEqual(["SOBRANTE_COBRADO", "SOBRANTE_COBRADO"]);
    // Sin asesoría en el trámite, nada que revisar (casos dorados intactos).
    expect(motivos(false)).toEqual([null, null]);
    // Solo marca: los dos pagos se siguen cobrando completos.
    expect(pagosCobrablesParaMotor(paraCobro)).toEqual([
      { valor: 650_000n, costoBancario: 3_900n },
      { valor: 650_000n, costoBancario: 3_900n },
    ]);
  });

  it("hallazgo con motivoRevisionPago: el bloque mixto y la transferencia salen como SOBRANTE_COBRADO, sin cambiar ningún total", () => {
    const paraCobro: PagoParaCobro[] = [
      { valor: 1_300_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n), noRep(300_000n)] },
      { valor: 650_000n, costoBancario: 3_900n, facturas: [rep(1_000_000n)] },
    ];
    const marcas = sobranteCobradoPorGrupo([pago(1_300_000n, [T1, S]), pago(650_000n, [T1])]);
    const motivos = paraCobro.map((p, i) =>
      motivoRevisionPago(p, desglosarPago(p), {
        bloqueSinMontos: false,
        tramiteConAsesoria: true,
        // La asesoría está cubierta por el bloque: solo cuenta la marca de grupo.
        asesoriaSinCubrir: false,
        sobranteCobradoEnGrupo: marcas[i],
      }),
    );
    expect(motivos).toEqual(["SOBRANTE_COBRADO", "SOBRANTE_COBRADO"]);
    // Solo marca: se cobran 1.000.000 del bloque y 650.000 de la transferencia, como antes.
    expect(pagosCobrablesParaMotor(paraCobro)).toEqual([
      { valor: 1_000_000n, costoBancario: 3_900n },
      { valor: 650_000n, costoBancario: 3_900n },
    ]);
  });

  it("la marca de grupo aplica también al pago mixto, pero no a pagos de solo asesoría ni de valor 0", () => {
    const conMarca = (p: PagoParaCobro) =>
      motivoRevisionPago(p, desglosarPago(p), {
        bloqueSinMontos: false,
        tramiteConAsesoria: true,
        asesoriaSinCubrir: false,
        sobranteCobradoEnGrupo: true,
      });
    expect(
      conMarca({ valor: 1_300_000n, costoBancario: 0n, facturas: [rep(1_000_000n), noRep(300_000n)] }),
    ).toBe("SOBRANTE_COBRADO");
    expect(conMarca({ valor: 300_000n, costoBancario: 0n, facturas: [noRep(300_000n)] })).toBeNull();
    expect(conMarca({ valor: 0n, costoBancario: 0n, facturas: [rep(1_000_000n)] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ¿Queda asesoría sin cubrir por sus pagos enlazados? (habilita PAGO_SIN_FACTURAS)
// ---------------------------------------------------------------------------
describe("asesoriasSinCubrir", () => {
  const asesoria = (facturaId: string, valor: bigint, compensada = false): AsesoriaDelTramite => ({
    facturaId,
    valor,
    compensada,
  });
  /** Pago del libro con su reparto: [id de la factura, enlace] por cada factura enlazada. */
  const pagoCon = (
    valor: bigint,
    enlaces: Array<[string, EnlaceFacturaCobro]>,
  ): PagoConParteNoCobrable => {
    const paraCobro: PagoParaCobro = {
      valor,
      costoBancario: 0n,
      facturas: enlaces.map(([, f]) => f),
    };
    return {
      facturaIds: enlaces.map(([id]) => id),
      paraCobro,
      noCobrable: desglosarPago(paraCobro).noCobrable,
    };
  };
  const S = asesoria("S", 300_000n);
  const S2 = asesoria("S2", 300_000n);

  it("asesoría pagada exacta por un pago enlazado: cubierta", () => {
    expect(asesoriasSinCubrir([S], [pagoCon(300_000n, [["S", noRep(300_000n)]])])).toEqual([]);
  });

  it("sin pago enlazado, pagada solo en parte o con pagos enlazados solo a lo que se cobra: sin cubrir", () => {
    expect(asesoriasSinCubrir([S], [])).toEqual(["S"]);
    expect(asesoriasSinCubrir([S], [pagoCon(200_000n, [["S", noRep(300_000n)]])])).toEqual(["S"]);
    expect(
      asesoriasSinCubrir([S], [pagoCon(1_000_000n, [["T", rep(1_000_000n)]]), pagoCon(2_000_000n, [])]),
    ).toEqual(["S"]);
  });

  it("se suman los pagos enlazados a la misma asesoría", () => {
    const abono = pagoCon(150_000n, [["S", noRep(300_000n)]]);
    expect(asesoriasSinCubrir([S], [abono])).toEqual(["S"]);
    expect(asesoriasSinCubrir([S], [abono, abono])).toEqual([]);
  });

  it("pago mixto que cuadra, con sobrante o con abono parcial del transporte: cubre la asesoría", () => {
    const mixto = (valor: bigint) =>
      pagoCon(valor, [
        ["T", rep(1_000_000n)],
        ["S", noRep(300_000n)],
      ]);
    expect(asesoriasSinCubrir([S], [mixto(1_300_000n)])).toEqual([]);
    expect(asesoriasSinCubrir([S], [mixto(1_400_000n)])).toEqual([]);
    expect(asesoriasSinCubrir([S], [mixto(800_000n)])).toEqual([]);
    // Pago menor que la asesoría: todo es asesoría, pero no alcanza.
    expect(asesoriasSinCubrir([S], [mixto(200_000n)])).toEqual(["S"]);
  });

  it("con montos por enlace cuenta lo que el pago le abonó: una asesoría neta de retención queda sin cubrir por lo retenido", () => {
    // Bloque: transporte 1.000.000 + asesoría (factura 300.000) pagada en 288.000.
    const bloque = pagoCon(1_288_000n, [
      ["T", rep(1_000_000n, 1_000_000n)],
      ["S", noRep(300_000n, 288_000n)],
    ]);
    expect(bloque.noCobrable).toBe(288_000n);
    expect(asesoriasSinCubrir([S], [bloque])).toEqual(["S"]);
    // Pagada de más (357.000): cubierta.
    const deMas = pagoCon(1_300_000n, [
      ["T", rep(1_000_000n, 943_000n)],
      ["S", noRep(300_000n, 357_000n)],
    ]);
    expect(asesoriasSinCubrir([S], [deMas])).toEqual([]);
  });

  it("compensada por cruce de saldos: cubierta aunque ningún pago la toque", () => {
    expect(asesoriasSinCubrir([asesoria("S", 300_000n, true)], [])).toEqual([]);
    expect(asesoriasSinCubrir([asesoria("S", 300_000n, true), S2], [])).toEqual(["S2"]);
  });

  it("el sobrante de un pago no cubre otra asesoría", () => {
    // 600.000 enlazados solo a S (300.000): S cubierta; S2 sin pago.
    expect(asesoriasSinCubrir([S, S2], [pagoCon(600_000n, [["S", noRep(300_000n)]])])).toEqual([
      "S2",
    ]);
  });

  it("varias asesorías en un pago: a cada una lo que le falta, primero los pagos de una sola asesoría (el orden del libro no cambia el resultado)", () => {
    const ambas = pagoCon(300_000n, [
      ["S", noRep(300_000n)],
      ["S2", noRep(300_000n)],
    ]);
    const soloS = pagoCon(300_000n, [["S", noRep(300_000n)]]);
    // S la paga `soloS`; los 300.000 de `ambas` van a S2.
    expect(asesoriasSinCubrir([S, S2], [ambas, soloS])).toEqual([]);
    expect(asesoriasSinCubrir([S, S2], [soloS, ambas])).toEqual([]);
    // Un solo pago de 300.000 para dos asesorías de 300.000: una queda sin cubrir.
    expect(asesoriasSinCubrir([S, S2], [ambas])).toEqual(["S2"]);
    // 600.000 para las dos: cubiertas, en cualquier orden de enlaces.
    expect(
      asesoriasSinCubrir(
        [S, S2],
        [
          pagoCon(600_000n, [
            ["S2", noRep(300_000n)],
            ["S", noRep(300_000n)],
          ]),
        ],
      ),
    ).toEqual([]);
  });

  it("bloque sin montos: la asesoría pesa lo mayor entre su factura y la auditoría, y con eso queda cubierta", () => {
    const [preparado] = prepararPagosParaCobro(
      [
        {
          id: "P2",
          valor: 1_300_000n,
          costoBancario: 0n,
          grupoPagoId: "g-P2",
          facturas: [
            { facturaId: "T", valorFactura: 1_000_000n, repercutible: true },
            { facturaId: "S", valorFactura: 300_000n, repercutible: false },
          ],
        },
      ],
      // Auditoría ambigua (bloque eliminado y rehecho igual).
      [
        { facturaId: "T", monto: 943_000n },
        { facturaId: "S", monto: 357_000n },
        { facturaId: "T", monto: 943_000n },
        { facturaId: "S", monto: 357_000n },
      ],
    );
    expect(preparado.bloqueSinMontos).toBe(true);
    const d = desglosarPago(preparado.paraCobro);
    expect(
      asesoriasSinCubrir(
        [S],
        [{ facturaIds: ["T", "S"], paraCobro: preparado.paraCobro, noCobrable: d.noCobrable }],
      ),
    ).toEqual([]);
  });

  it("devuelve los ids en el orden de entrada y nunca cuenta asesorías de valor ≤ 0", () => {
    const S3 = asesoria("S3", 100_000n);
    expect(asesoriasSinCubrir([S3, asesoria("S0", 0n), S], [])).toEqual(["S3", "S"]);
  });
});

// ---------------------------------------------------------------------------
// CxP v2: PagoTramiteFactura.monto manda sobre la auditoría del bloque
// ---------------------------------------------------------------------------

describe("montos por enlace de CxP v2", () => {
  const conMonto = (facturaId: string, valorFactura: bigint, repercutible: boolean, monto: bigint) => ({
    facturaId,
    valorFactura,
    repercutible,
    monto,
  });

  it("tieneMontosPorEnlace: todos con monto ≥ 0 y suma > 0; los heredados en 0 no cuentan", () => {
    expect(tieneMontosPorEnlace({ facturas: [conMonto("T", 1_000_000n, true, 900_000n)] })).toBe(true);
    // Un enlace en 0 junto a otro con monto: este pago no le abonó nada a esa factura.
    expect(
      tieneMontosPorEnlace({
        facturas: [conMonto("T", 1_000_000n, true, 900_000n), conMonto("S", 400_000n, false, 0n)],
      }),
    ).toBe(true);
    // Todos en 0 = heredado que la migración no pudo repartir.
    expect(
      tieneMontosPorEnlace({
        facturas: [conMonto("T", 1_000_000n, true, 0n), conMonto("S", 400_000n, false, 0n)],
      }),
    ).toBe(false);
    // Sin monto (datos sin v2) o sin facturas.
    expect(tieneMontosPorEnlace({ facturas: [{ facturaId: "T", valorFactura: 1n, repercutible: true }] })).toBe(false);
    expect(tieneMontosPorEnlace({ facturas: [] })).toBe(false);
  });

  it("necesitaMontosDeAuditoria: solo un bloque con asesoría sin montos v2", () => {
    const S0 = conMonto("S", 300_000n, false, 0n);
    const S3 = conMonto("S", 300_000n, false, 300_000n);
    expect(necesitaMontosDeAuditoria({ grupoPagoId: "g", facturas: [S0] })).toBe(true);
    expect(necesitaMontosDeAuditoria({ grupoPagoId: "g", facturas: [S3] })).toBe(false);
    expect(necesitaMontosDeAuditoria({ grupoPagoId: null, facturas: [S0] })).toBe(false);
    expect(
      necesitaMontosDeAuditoria({ grupoPagoId: "g", facturas: [conMonto("T", 1n, true, 0n)] }),
    ).toBe(false);
  });

  it("bloque editado v2 (T 900.000 / S 400.000, mismo total 1.300.000): manda el monto aunque la auditoría diga T 1.000.000 / S 300.000", () => {
    const P = {
      id: "P",
      valor: 1_300_000n,
      costoBancario: 3_900n,
      grupoPagoId: "g-P",
      facturas: [conMonto("T", 1_000_000n, true, 900_000n), conMonto("S", 400_000n, false, 400_000n)],
    };
    // La auditoría vieja es inequívoca y cuadra con el total: sin v2 la
    // heurística la tomaría y cobraría 1.000.000.
    const abonos: AbonoBloqueAuditado[] = [
      { facturaId: "T", monto: 1_000_000n },
      { facturaId: "S", monto: 300_000n },
    ];
    const sinV2 = prepararPagosParaCobro(
      [{ ...P, facturas: P.facturas.map((f) => ({ facturaId: f.facturaId, valorFactura: f.valorFactura, repercutible: f.repercutible })) }],
      abonos,
    );
    expect(desglosarPago(sinV2[0].paraCobro).cobrable.valor).toBe(1_000_000n);

    const [preparado] = prepararPagosParaCobro([P], abonos);
    expect(preparado.bloqueSinMontos).toBe(false);
    expect(preparado.paraCobro.facturas).toEqual([
      { valorFactura: 1_000_000n, repercutible: true, monto: 900_000n },
      { valorFactura: 400_000n, repercutible: false, monto: 400_000n },
    ]);
    const d = desglosarPago(preparado.paraCobro);
    expect(d.cobrable).toEqual({ valor: 900_000n, costoBancario: 3_900n });
    expect(d.noCobrable).toBe(400_000n);
    expect(d.porRevisar).toBe(false);
    expect(
      motivoRevisionPago(preparado.paraCobro, d, {
        bloqueSinMontos: false,
        tramiteConAsesoria: true,
        asesoriaSinCubrir: false,
        sobranteCobradoEnGrupo: false,
      }),
    ).toBeNull();
  });

  it("pago simple v2 con abono parcial del transporte y la asesoría completa: exacto, sin marca", () => {
    // 500.000 al transporte (factura 1.000.000) y 300.000 a la asesoría.
    const [preparado] = prepararPagosParaCobro(
      [
        {
          id: "P",
          valor: 800_000n,
          costoBancario: 0n,
          grupoPagoId: null,
          facturas: [conMonto("T", 1_000_000n, true, 500_000n), conMonto("S", 300_000n, false, 300_000n)],
        },
      ],
      [],
    );
    const d = desglosarPago(preparado.paraCobro);
    expect(d.cobrable.valor).toBe(500_000n);
    expect(d.noCobrable).toBe(300_000n);
    // Sin montos se marcaba ABONO_PARCIAL (800.000 < 1.300.000); con v2 es exacto.
    expect(d.porRevisar).toBe(false);
  });

  it("asesoriasSinCubrir: un cruce parcial (v2) solo cubre lo cruzado", () => {
    const parcial: AsesoriaDelTramite = {
      facturaId: "S",
      valor: 300_000n,
      compensada: true,
      montoCompensado: 100_000n,
    };
    expect(asesoriasSinCubrir([parcial], [])).toEqual(["S"]);
    // El resto (200.000) lo cubre un pago enlazado con su monto.
    const paraCobro: PagoParaCobro = { valor: 200_000n, costoBancario: 0n, facturas: [noRep(300_000n, 200_000n)] };
    expect(
      asesoriasSinCubrir(
        [parcial],
        [{ facturaIds: ["S"], paraCobro, noCobrable: desglosarPago(paraCobro).noCobrable }],
      ),
    ).toEqual([]);
    // Cruce total: cubierta sin pagos.
    expect(asesoriasSinCubrir([{ ...parcial, montoCompensado: 300_000n }], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Montos de un pago MIXTO heredado: los estimó la migración, no mandan
// (hallazgo crítico de la revisión final del 25-sep)
// ---------------------------------------------------------------------------

describe("montos estimados por la migración en un pago mixto heredado", () => {
  const T = { facturaId: "T", valorFactura: 1_000_000n, repercutible: true };
  const A = { facturaId: "A", valorFactura: 300_000n, repercutible: false };
  const contexto = {
    bloqueSinMontos: false,
    tramiteConAsesoria: true,
    asesoriaSinCubrir: false,
    sobranteCobradoEnGrupo: false,
  };

  it("enlacesAplicadosEnV2 lee despues.origen de aplicarSaldo e ignora lo demás", () => {
    const v2 = enlacesAplicadosEnV2([
      { entidadId: "T", despues: { estado: "PARCIAL", monto: "500000", origen: { tipo: "PAGO", pagoId: "P" } } },
      { entidadId: "A", despues: { estado: "PAGADA", origen: { tipo: "COMPENSACION", compensacionId: "c" } } },
      { entidadId: "A", despues: { estado: "PAGADA" } },
      { entidadId: "A", despues: null },
      { entidadId: "A", despues: [] },
      { entidadId: "A", despues: { origen: "PAGO" } },
    ]);
    expect([...v2]).toEqual([llaveEnlace("P", "T")]);
  });

  it("montosSonEstimados: solo un pago mixto con algún enlace que no aplicó v2", () => {
    const mixto = { id: "P", facturas: [T, A] };
    expect(esPagoMixto(mixto)).toBe(true);
    expect(montosSonEstimados(mixto, new Set())).toBe(true);
    expect(montosSonEstimados(mixto, new Set([llaveEnlace("P", "T")]))).toBe(true);
    expect(montosSonEstimados(mixto, new Set([llaveEnlace("P", "T"), llaveEnlace("P", "A")]))).toBe(false);
    // El enlace v2 de OTRO pago no cuenta.
    expect(montosSonEstimados(mixto, new Set([llaveEnlace("Q", "T"), llaveEnlace("Q", "A")]))).toBe(true);
    // No mixtos: los montos no cambian lo cobrable (todo o nada).
    expect(montosSonEstimados({ id: "P", facturas: [T] }, new Set())).toBe(false);
    expect(montosSonEstimados({ id: "P", facturas: [A] }, new Set())).toBe(false);
  });

  it("pago de 800.000 con los montos de la migración vieja (T 800.000 / A 0): estimados → cobra 500.000 y marca ABONO_PARCIAL; si mandaran cobraría 800.000 sin marca", () => {
    const base: PagoDelLibro = {
      id: "P",
      valor: 800_000n,
      costoBancario: 3_900n,
      grupoPagoId: null,
      facturas: [
        { ...T, monto: 800_000n },
        { ...A, monto: 0n },
      ],
    };

    // Lo que pasaba antes: los montos mandan y la asesoría se cobra en silencio.
    const [mandan] = prepararPagosParaCobro([base], []);
    const dMandan = desglosarPago(mandan.paraCobro);
    expect(dMandan.cobrable).toEqual({ valor: 800_000n, costoBancario: 3_900n });
    expect(motivoRevisionPago(mandan.paraCobro, dMandan, { ...contexto, bloqueSinMontos: mandan.bloqueSinMontos })).toBeNull();

    // Estimados: heurística de Ascinter, como si no tuviera montos.
    const [estimado] = prepararPagosParaCobro([{ ...base, montosEstimados: true }], []);
    expect(estimado.bloqueSinMontos).toBe(false);
    const d = desglosarPago(estimado.paraCobro);
    expect(d.cobrable).toEqual({ valor: 500_000n, costoBancario: 3_900n });
    expect(d.noCobrable).toBe(300_000n);
    expect(d.sumaFacturas).toBe(1_300_000n);
    expect(motivoRevisionPago(estimado.paraCobro, d, { ...contexto, bloqueSinMontos: estimado.bloqueSinMontos })).toBe(
      "ABONO_PARCIAL",
    );
  });

  it("con la migración corregida (asesoría primero: T 500.000 / A 300.000) el estimado da lo mismo que la heurística y sigue marcado", () => {
    const pago: PagoDelLibro = {
      id: "P",
      valor: 800_000n,
      costoBancario: 3_900n,
      grupoPagoId: null,
      montosEstimados: true,
      facturas: [
        { ...T, monto: 500_000n },
        { ...A, monto: 300_000n },
      ],
    };
    const [p] = prepararPagosParaCobro([pago], []);
    const d = desglosarPago(p.paraCobro);
    expect(d.cobrable.valor).toBe(500_000n);
    expect(motivoRevisionPago(p.paraCobro, d, { ...contexto, bloqueSinMontos: false })).toBe("ABONO_PARCIAL");
  });

  it("bloque mixto con montos estimados y auditoría ambigua → BLOQUE_SIN_MONTOS (ya no queda muerto)", () => {
    const pago: PagoDelLibro = {
      id: "B",
      valor: 800_000n,
      costoBancario: 0n,
      grupoPagoId: "g",
      montosEstimados: true,
      facturas: [
        { ...T, monto: 800_000n },
        { ...A, monto: 0n },
      ],
    };
    expect(necesitaMontosDeAuditoria(pago)).toBe(true);
    expect(necesitaMontosDeAuditoria({ ...pago, montosEstimados: false })).toBe(false);
    const [p] = prepararPagosParaCobro([pago], []);
    expect(p.bloqueSinMontos).toBe(true);
    const d = desglosarPago(p.paraCobro);
    expect(d.cobrable.valor).toBe(500_000n);
    expect(motivoRevisionPago(p.paraCobro, d, { ...contexto, bloqueSinMontos: p.bloqueSinMontos })).toBe(
      "BLOQUE_SIN_MONTOS",
    );
  });

  it("un pago mixto aplicado en v2 (montos exactos) no cambia: manda el monto y no se marca", () => {
    const pago: PagoDelLibro = {
      id: "P",
      valor: 800_000n,
      costoBancario: 3_900n,
      grupoPagoId: null,
      montosEstimados: false,
      facturas: [
        { ...T, monto: 700_000n },
        { ...A, monto: 100_000n },
      ],
    };
    const [p] = prepararPagosParaCobro([pago], []);
    const d = desglosarPago(p.paraCobro);
    expect(d.cobrable.valor).toBe(700_000n);
    expect(motivoRevisionPago(p.paraCobro, d, { ...contexto, bloqueSinMontos: false })).toBeNull();
  });
});
