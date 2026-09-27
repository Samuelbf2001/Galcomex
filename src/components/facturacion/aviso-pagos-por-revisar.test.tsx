import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOTIVOS_REVISION_PAGO } from "@/lib/calculations/pagos-cobrables";

import {
  AvisoPagosPorRevisar,
  conservarPagosPorRevisar,
  explicacionPagoPorRevisar,
  normalizarPagosPorRevisar,
  type PagoPorRevisarRow,
} from "./aviso-pagos-por-revisar";

const SOBRANTE: PagoPorRevisarRow = {
  pagoId: "p-1",
  concepto: "Pago Ascinter",
  numSoporte: "FE-77",
  valor: "1200000",
  sumaFacturas: "200000",
  cobrable: "0",
  noCobrable: "1200000",
  motivo: "SOBRANTE_NO_COBRADO",
};
const ABONO: PagoPorRevisarRow = {
  pagoId: "p-2",
  concepto: "Bloque Ascinter",
  numSoporte: null,
  valor: "800000",
  sumaFacturas: "1300000",
  cobrable: "500000",
  noCobrable: "300000",
  motivo: "ABONO_PARCIAL",
};
const SOBRANTE_COBRADO: PagoPorRevisarRow = {
  pagoId: "p-3",
  concepto: "Transferencia transporte",
  numSoporte: null,
  valor: "650000",
  sumaFacturas: "1000000",
  cobrable: "650000",
  noCobrable: "0",
  motivo: "SOBRANTE_COBRADO",
};
const SIN_FACTURAS: PagoPorRevisarRow = {
  pagoId: "p-4",
  concepto: "Pago suelto",
  numSoporte: null,
  valor: "2000000",
  sumaFacturas: "0",
  cobrable: "2000000",
  noCobrable: "0",
  motivo: "PAGO_SIN_FACTURAS",
};
const BLOQUE: PagoPorRevisarRow = {
  pagoId: "p-5",
  concepto: "Bloque rehecho",
  numSoporte: null,
  valor: "1300000",
  sumaFacturas: "1357000",
  cobrable: "943000",
  noCobrable: "357000",
  motivo: "BLOQUE_SIN_MONTOS",
};
const VIEJO: PagoPorRevisarRow = { ...ABONO, pagoId: "p-6", motivo: null };

/** Quita el espacio (normal o no separable) entre "$" y el número. */
const plano = (s: string) => s.replace(/\$\s/g, "$");

describe("normalizarPagosPorRevisar", () => {
  it("toma la lista del API con su motivo y descarta lo mal formado", () => {
    expect(
      normalizarPagosPorRevisar([
        { ...SOBRANTE },
        { ...ABONO, numSoporte: undefined },
        { ...ABONO, pagoId: 7 },
        { ...ABONO, valor: "1.5" },
        null,
      ]),
    ).toEqual([SOBRANTE, ABONO]);
  });

  it("un motivo ausente o desconocido queda en null; cada motivo conocido se conserva", () => {
    expect(
      normalizarPagosPorRevisar([
        { ...ABONO, motivo: undefined },
        { ...ABONO, motivo: "OTRO_MOTIVO" },
        ...MOTIVOS_REVISION_PAGO.map((motivo) => ({ ...ABONO, motivo })),
      ])?.map((p) => p.motivo),
    ).toEqual([null, null, ...MOTIVOS_REVISION_PAGO]);
  });

  it("sin lista en la respuesta → null (no se sabe), distinto de [] (no hay pagos por revisar)", () => {
    expect(normalizarPagosPorRevisar([])).toEqual([]);
    expect(normalizarPagosPorRevisar(undefined)).toBeNull();
    expect(normalizarPagosPorRevisar(null)).toBeNull();
    expect(normalizarPagosPorRevisar({})).toBeNull();
  });
});

describe("conservarPagosPorRevisar", () => {
  const base = { id: "b-1", estado: "BORRADOR", pagosPorRevisar: [ABONO] as PagoPorRevisarRow[] | null };

  it("una respuesta sin la lista (PATCH/POST) conserva la del borrador anterior", () => {
    const actualizado = { ...base, estado: "EN_REVISION", pagosPorRevisar: null };
    expect(conservarPagosPorRevisar(actualizado, base)).toEqual({
      id: "b-1",
      estado: "EN_REVISION",
      pagosPorRevisar: [ABONO],
    });
  });

  it("una respuesta con la lista (aunque vacía) manda; otro borrador no hereda nada", () => {
    const conLista = { ...base, pagosPorRevisar: [] };
    expect(conservarPagosPorRevisar(conLista, base)).toBe(conLista);
    const otro = { ...base, id: "b-2", pagosPorRevisar: null };
    expect(conservarPagosPorRevisar(otro, base)).toBe(otro);
    expect(conservarPagosPorRevisar(otro, null)).toBe(otro);
  });
});

describe("explicacionPagoPorRevisar", () => {
  /** Un pago ya registrado no se vuelve a enlazar: se elimina y se registra de nuevo. */
  const REMEDIO =
    "Si era asesoría, pide a quien registra pagos que elimine este pago y lo registre de nuevo seleccionando su factura NO SE COBRA; después vuelve a generar el borrador.";

  it("SOBRANTE_COBRADO: dice cuánto se le está cobrando al cliente y cómo corregirlo", () => {
    const texto = plano(explicacionPagoPorRevisar(SOBRANTE_COBRADO));
    expect(texto).toMatch(
      /^Este pago \(solo o junto con otros pagos de sus facturas\) pagó más de lo que valen esas facturas\./,
    );
    expect(texto).toContain("Al cliente se le está cobrando $650.000 de este pago.");
    expect(texto).toContain(REMEDIO);
    // Nunca dice lo contrario de lo que pasa, ni pide algo que no se puede hacer.
    expect(texto).not.toMatch(/asume Galcomex/);
    expect(texto).not.toMatch(/enlaza su factura/);
    expect(texto).toContain("Si no era asesoría, revisa si ese gasto se pagó dos veces");
  });

  it("SOBRANTE_COBRADO en un pago mixto (ya descuenta asesoría): señala el otro pago, no pide rehacer este", () => {
    const texto = plano(
      explicacionPagoPorRevisar({
        ...SOBRANTE_COBRADO,
        pagoId: "p-bloque",
        concepto: "Bloque Ascinter",
        valor: "1300000",
        sumaFacturas: "1300000",
        cobrable: "1000000",
        noCobrable: "300000",
      }),
    );
    expect(texto).toContain("ya descuenta la asesoría ($300.000, no se cobra)");
    expect(texto).toContain("al cliente se le cobran $1.000.000");
    expect(texto).toContain("el cobro de más viene del otro pago");
    expect(texto).not.toContain(REMEDIO);
  });

  it("PAGO_SIN_FACTURAS: se le cobra completo al cliente, hay asesoría sin cubrir y cómo corregirlo", () => {
    const texto = plano(explicacionPagoPorRevisar(SIN_FACTURAS));
    expect(texto).toContain("no tiene facturas enlazadas");
    expect(texto).toContain("hay asesoría que sus pagos enlazados no cubren");
    expect(texto).toContain("Al cliente se le está cobrando $2.000.000 de este pago.");
    expect(texto).toContain(REMEDIO);
    expect(texto).not.toMatch(/asume Galcomex/);
    expect(texto).not.toMatch(/enlaza su factura/);
  });

  it("SOBRANTE_NO_COBRADO: el sobrante lo asume Galcomex (con su monto)", () => {
    const texto = plano(explicacionPagoPorRevisar(SOBRANTE));
    expect(texto).toContain("Se pagó $1.000.000 más de lo que suman sus facturas.");
    expect(texto).toContain("Ese sobrante lo asume Galcomex");
    expect(texto).toContain("no se le cobran $1.200.000 al cliente");
    expect(texto).toContain(
      "pide a quien registra pagos que elimine este pago y lo registre de nuevo seleccionando también la factura de ese gasto; después vuelve a generar el borrador.",
    );
    expect(texto).not.toMatch(/se le está cobrando/);
    expect(texto).not.toMatch(/enlaza su factura/);
  });

  it("ABONO_PARCIAL: abono parcial, el error puede ir en los dos sentidos; revisar cuánto fue a cada factura", () => {
    const texto = plano(explicacionPagoPorRevisar(ABONO));
    expect(texto).toMatch(/^Abono parcial/);
    expect(texto).toContain("asesoría ($300.000, no se cobra)");
    expect(texto).toContain("se le cobra el resto ($500.000)");
    expect(texto).toContain("cuánto fue a cada factura");
    expect(texto).toContain(
      "si la asesoría no se pagó completa con este pago, al cliente se le está cobrando de menos",
    );
    expect(texto).toContain(
      "si a la asesoría se le pagó más de lo que dice su factura (por ejemplo, con IVA), al cliente se le está cobrando de más",
    );
  });

  it("BLOQUE_SIN_MONTOS: sin detalle confiable, se tomó lo más seguro para el cliente", () => {
    const texto = plano(explicacionPagoPorRevisar(BLOQUE));
    expect(texto).toContain("sin un detalle confiable de cuánto fue a cada factura");
    expect(texto).toContain("lo más seguro para el cliente");
    // Lo no cobrado incluye la asesoría por lo más alto registrado y el sobrante.
    expect(texto).toContain(
      "no se cobran $357.000 de este pago (la asesoría por lo más alto registrado y, si lo hay, el sobrante)",
    );
    expect(texto).toContain("se le cobra $943.000");
    expect(texto).toContain("Revisa el detalle del bloque");
  });

  it("sin motivo (borradores viejos): texto neutro, sin suponer hacia dónde va el error", () => {
    const texto = plano(explicacionPagoPorRevisar(VIEJO));
    expect(texto).toContain("Al cliente se le cobra $500.000 de este pago y no se le cobran $300.000.");
    expect(texto).not.toMatch(/asume Galcomex|se le está cobrando|Abono parcial|sobrante/i);
  });

  it("cada motivo tiene su propio texto", () => {
    const textos = MOTIVOS_REVISION_PAGO.map((motivo) =>
      explicacionPagoPorRevisar({ ...ABONO, motivo }),
    );
    expect(new Set([...textos, explicacionPagoPorRevisar(VIEJO)]).size).toBe(
      MOTIVOS_REVISION_PAGO.length + 1,
    );
  });
});

describe("AvisoPagosPorRevisar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("no pinta nada sin pagos por revisar ni sin la lista (SOCIO)", async () => {
    await act(async () => root.render(<AvisoPagosPorRevisar pagos={[]} />));
    expect(container.innerHTML).toBe("");
    await act(async () => root.render(<AvisoPagosPorRevisar pagos={null} />));
    expect(container.innerHTML).toBe("");
  });

  it("lista cada pago con lo pagado y el texto de su motivo; el encabezado no dice quién asume", async () => {
    await act(async () =>
      root.render(<AvisoPagosPorRevisar pagos={[SOBRANTE, ABONO, SOBRANTE_COBRADO]} />),
    );
    const texto = plano(container.textContent ?? "");
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    const encabezado = plano(container.querySelector("p.font-semibold")?.parentElement?.textContent ?? "");
    expect(texto).toContain("Revisa 3 pagos antes de aprobar");
    expect(texto).toContain("Este trámite tiene facturas marcadas NO SE COBRA (asesoría).");
    expect(texto).toContain("En estos pagos el sistema no pudo confirmar");
    expect(texto).toContain("Pago Ascinter · soporte FE-77: pagado $1.200.000; sus facturas suman $200.000.");
    expect(texto).toContain("Ese sobrante lo asume Galcomex");
    expect(texto).toContain("Transferencia transporte: pagado $650.000; sus facturas suman $1.000.000.");
    expect(texto).toContain("Al cliente se le está cobrando $650.000 de este pago.");
    // El genérico «la asume Galcomex» ya no va en el encabezado.
    const [primerParrafo, segundoParrafo] = Array.from(container.querySelectorAll("p")).map(
      (p) => p.textContent ?? "",
    );
    expect(`${primerParrafo} ${segundoParrafo}`).not.toMatch(/asume Galcomex/);
    expect(encabezado.length).toBeGreaterThan(0);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("singular, pago sin facturas y bloque sin montos: sin «sus facturas suman»", async () => {
    await act(async () => root.render(<AvisoPagosPorRevisar pagos={[SIN_FACTURAS]} />));
    let texto = plano(container.textContent ?? "");
    expect(texto).toContain("Revisa 1 pago antes de aprobar");
    expect(texto).toContain("En este pago el sistema");
    expect(texto).toContain("Pago suelto: pagado $2.000.000. Este pago no tiene facturas enlazadas");
    expect(texto).not.toContain("sus facturas suman");

    await act(async () => root.render(<AvisoPagosPorRevisar pagos={[BLOQUE]} />));
    texto = plano(container.textContent ?? "");
    expect(texto).toContain("Bloque rehecho: pagado $1.300.000. Pago en bloque");
    expect(texto).not.toContain("sus facturas suman");
  });
});
