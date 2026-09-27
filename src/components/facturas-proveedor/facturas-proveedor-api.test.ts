import { describe, expect, it } from "vitest";

import { formatCOP, normalizeFactura, parseBigIntInput } from "./facturas-proveedor-api";

// ---------------------------------------------------------------------------
// `normalizeFactura` lee la respuesta REAL de `listarPorTramite`
// (src/lib/facturas-proveedor/service.ts, P2): saldo, etiqueta,
// numFacturaVisible, bloqueoEdicion, facturadaAlCliente, ajustes, pagos con
// el pago anidado (pagoId/monto/pago.valor/pago.canalPago/pago.grupoPagoId).
// Si el contrato de la ruta cambia de nombre, esta prueba debe fallar aquí,
// no en producción (§D.3).
// ---------------------------------------------------------------------------

describe("normalizeFactura (contrato real de GET /api/tramites/[id]/facturas-proveedor)", () => {
  const filaCruda = {
    id: "fact-1",
    tramiteId: "tramite-1",
    proveedorNombre: "ALMACENADORA DE CARGA \"ALMACARGA\" S.A.S",
    proveedorNit: "800154017-8",
    beneficiarioId: "ben-1",
    beneficiario: {
      id: "ben-1",
      nombre: "ALMACENADORA DE CARGA \"ALMACARGA\" S.A.S",
      nit: "800154017-8",
      nombreCorto: "ALMACARGA",
      nitBase: "800154017",
      numFacturaConEspacio: true,
    },
    concepto: "Almacenaje",
    siigoProductoId: null,
    numFactura: "FE-12481",
    numFacturaVisible: "FE 12481",
    valor: "464077",
    fecha: "2026-09-12",
    documento: { id: "doc-1", nombreArchivo: "fe12481.pdf", storageKey: "k" },
    documentoId: "doc-1",
    repercutible: true,
    subidaPorId: "user-1",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    estado: "PARCIAL",
    moneda: "COP",
    valorOrigen: null,
    trm: null,
    fechaTrm: null,
    aplicado: "200000",
    ajustado: "0",
    compensado: "0",
    saldo: "264077",
    estadoCalculado: "PARCIAL",
    etiqueta: "Abonada",
    facturadaAlCliente: { numSiigo: "BAQ-18742", estado: "FACTURADO", clienteNombre: "LITOPLAS SA" },
    bloqueoEdicion: { codigo: "FACTURA_CON_PAGOS", mensaje: "Esta factura ya tiene pagos por $200.000: …" },
    puedeEliminar: false,
    pagos: [
      {
        pagoId: "pago-1",
        facturaId: "fact-1",
        monto: "200000",
        createdAt: "2026-09-15T00:00:00.000Z",
        pago: { id: "pago-1", valor: "200000", canalPago: "TRANSF_BANCOLOMBIA", fechaRealPago: "2026-09-15", grupoPagoId: null },
      },
    ],
    ajustes: [],
  };

  it("mapea saldo, etiqueta y numFacturaVisible desde el JSON del servidor", () => {
    const fila = normalizeFactura(filaCruda);
    expect(fila.saldo).toBe("264077");
    expect(fila.aplicado).toBe("200000");
    expect(fila.etiqueta).toBe("Abonada");
    expect(fila.numFacturaVisible).toBe("FE 12481");
    expect(fila.moneda).toBe("COP");
  });

  it("mapea el nombre corto y el NIT base de la ficha (beneficiario)", () => {
    const fila = normalizeFactura(filaCruda);
    expect(fila.beneficiario?.nombreCorto).toBe("ALMACARGA");
    expect(fila.beneficiario?.nitBase).toBe("800154017");
    expect(fila.beneficiario?.numFacturaConEspacio).toBe(true);
  });

  it("mapea facturadaAlCliente (R13: independiente de si ya se pagó al proveedor)", () => {
    const fila = normalizeFactura(filaCruda);
    expect(fila.facturadaAlCliente).toEqual({
      numSiigo: "BAQ-18742",
      estado: "FACTURADO",
      clienteNombre: "LITOPLAS SA",
    });
  });

  it("null cuando la factura no se le ha cobrado al cliente", () => {
    const fila = normalizeFactura({ ...filaCruda, facturadaAlCliente: null });
    expect(fila.facturadaAlCliente).toBeNull();
  });

  it("mapea bloqueoEdicion (R11) con su código y mensaje", () => {
    const fila = normalizeFactura(filaCruda);
    expect(fila.bloqueoEdicion).toEqual({
      codigo: "FACTURA_CON_PAGOS",
      mensaje: "Esta factura ya tiene pagos por $200.000: …",
    });
    expect(fila.puedeEliminar).toBe(false);
  });

  it("null en bloqueoEdicion y true en puedeEliminar para una factura editable", () => {
    const fila = normalizeFactura({ ...filaCruda, bloqueoEdicion: null, puedeEliminar: true });
    expect(fila.bloqueoEdicion).toBeNull();
    expect(fila.puedeEliminar).toBe(true);
  });

  it("mapea cada pago del puente con su monto y los datos del pago anidado", () => {
    const fila = normalizeFactura(filaCruda);
    expect(fila.pagos).toHaveLength(1);
    expect(fila.pagos[0]).toEqual({
      pagoId: "pago-1",
      monto: "200000",
      createdAt: "2026-09-15T00:00:00.000Z",
      valor: "200000",
      canalPago: "TRANSF_BANCOLOMBIA",
      fechaRealPago: "2026-09-15",
      grupoPagoId: null,
    });
  });

  it("mapea una factura USD con valorOrigen y trm en centavos", () => {
    const fila = normalizeFactura({
      ...filaCruda,
      moneda: "USD",
      valorOrigen: "13100",
      trm: "371050",
      fechaTrm: "2026-09-10",
      valor: "486076",
    });
    expect(fila.moneda).toBe("USD");
    expect(fila.valorOrigen).toBe("13100");
    expect(fila.trm).toBe("371050");
    expect(fila.fechaTrm).toBe("2026-09-10");
  });

  it("mapea los ajustes (LEGADO de la migración)", () => {
    const fila = normalizeFactura({
      ...filaCruda,
      etiqueta: "Pagada con ajuste",
      ajustes: [{ id: "aj-1", tipo: "LEGADO", monto: "50000", motivo: "Migración v2", createdAt: "2026-09-01T00:00:00.000Z" }],
    });
    expect(fila.ajustes).toHaveLength(1);
    expect(fila.ajustes[0]).toMatchObject({ tipo: "LEGADO", monto: "50000" });
  });

  it("no explota con campos ausentes (defensivo)", () => {
    const fila = normalizeFactura({ id: "fact-2" });
    expect(fila.id).toBe("fact-2");
    expect(fila.saldo).toBe("0");
    expect(fila.etiqueta).toBe("Pendiente");
    expect(fila.pagos).toEqual([]);
    expect(fila.ajustes).toEqual([]);
    expect(fila.beneficiario).toBeNull();
  });
});

describe("formatCOP / parseBigIntInput (dinero, sin flotantes)", () => {
  it("formatCOP formatea con separador de miles y sin decimales", () => {
    expect(formatCOP("464077")).toContain("464.077");
    expect(formatCOP("464077")).not.toContain(",");
  });

  it("parseBigIntInput limpia puntos y símbolo de pesos", () => {
    expect(parseBigIntInput("1.000.000")).toBe("1000000");
    expect(parseBigIntInput("$ 464.077")).toBe("464077");
  });

  it("parseBigIntInput rechaza cero, negativos y texto no numérico", () => {
    expect(parseBigIntInput("0")).toBeNull();
    expect(parseBigIntInput("-100")).toBeNull();
    expect(parseBigIntInput("abc")).toBeNull();
    expect(parseBigIntInput("")).toBeNull();
  });
});
