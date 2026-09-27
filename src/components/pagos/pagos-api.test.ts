import { describe, expect, it } from "vitest";

import { formatCOP, parsePagoRow } from "./pagos-api";

// ---------------------------------------------------------------------------
// `parsePagoRow` lee la respuesta REAL de `getLibroPagos`
// (src/lib/pagos/service.ts, P1): `tieneFacturas`, `esBloque`,
// `editableDinero`, `aplicaciones` (con `numFacturaVisible`) y `grupo`
// (con `otrosDOs`). Si el contrato de la ruta cambia de nombre, esta
// prueba debe fallar aquí, no en el libro de pagos del DO (§D.4).
// ---------------------------------------------------------------------------

describe("parsePagoRow (contrato real de GET /api/tramites/[id]/pagos)", () => {
  const pagoBloqueCrudo = {
    id: "pago-1",
    tramiteId: "tramite-1",
    concepto: "Pago ALMACARGA 15/09/2026",
    beneficiarios: [{ beneficiario: { id: "ben-1", nombre: "ALMACARGA", nit: "800154017-8" } }],
    numSoporte: null,
    documentoId: "doc-1",
    faltaComprobante: false,
    comprobanteComercioId: null,
    grupoPagoId: "grupo-1",
    grupoOtrosDOs: [
      { tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" },
      { tramiteId: "tramite-3", consecutivo: "DO.BAQ26-0255" },
    ],
    valor: "464077",
    canalPago: "TRANSF_BANCOLOMBIA",
    costoBancario: "0",
    orden: 1,
    fechaRealPago: "2026-09-15",
    estado: "REALIZADO",
    facturasProveedor: [],
    viaSocio: false,
    bancoBeneficiario: null,
    tieneFacturas: true,
    esBloque: true,
    editableDinero: false,
    aplicaciones: [
      { facturaId: "fact-1", numFactura: "FE-12481", numFacturaVisible: "FE 12481", monto: "464077" },
    ],
    grupo: {
      estado: "ACTIVO",
      costoBancario: "3900",
      costoAsumidoPor: "PRIMER_DO",
      esHistorico: false,
      otrosDOs: [{ tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" }],
    },
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };

  it("mapea tieneFacturas, esBloque y editableDinero", () => {
    const fila = parsePagoRow(pagoBloqueCrudo);
    expect(fila.tieneFacturas).toBe(true);
    expect(fila.esBloque).toBe(true);
    expect(fila.editableDinero).toBe(false);
  });

  it("mapea cada aplicación con su numFacturaVisible y su monto", () => {
    const fila = parsePagoRow(pagoBloqueCrudo);
    expect(fila.aplicaciones).toEqual([
      { facturaId: "fact-1", numFactura: "FE-12481", numFacturaVisible: "FE 12481", monto: "464077" },
    ]);
  });

  it("mapea la cabecera del bloque con su costo y quién lo asume", () => {
    const fila = parsePagoRow(pagoBloqueCrudo);
    expect(fila.grupo).toEqual({
      estado: "ACTIVO",
      costoBancario: "3900",
      costoAsumidoPor: "PRIMER_DO",
      esHistorico: false,
      otrosDOs: [{ tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" }],
    });
  });

  it("un pago suelto sin facturas y sin bloque queda editable", () => {
    const fila = parsePagoRow({
      ...pagoBloqueCrudo,
      grupoPagoId: null,
      grupoOtrosDOs: [],
      tieneFacturas: false,
      esBloque: false,
      editableDinero: true,
      aplicaciones: [],
      grupo: null,
    });
    expect(fila.tieneFacturas).toBe(false);
    expect(fila.esBloque).toBe(false);
    expect(fila.editableDinero).toBe(true);
    expect(fila.grupo).toBeNull();
    expect(fila.aplicaciones).toEqual([]);
  });

  it("respuesta vieja sin editableDinero: el lado seguro deriva de tieneFacturas/esBloque", () => {
    const { editableDinero: _omit, ...sinCampo } = pagoBloqueCrudo;
    void _omit;
    const fila = parsePagoRow(sinCampo);
    // tieneFacturas true → nunca editable aunque el campo nuevo no viaje.
    expect(fila.editableDinero).toBe(false);
  });

  it("no explota con campos ausentes (defensivo)", () => {
    const fila = parsePagoRow({ id: "pago-2" });
    expect(fila.id).toBe("pago-2");
    expect(fila.aplicaciones).toEqual([]);
    expect(fila.grupo).toBeNull();
    expect(fila.tieneFacturas).toBe(false);
    expect(fila.esBloque).toBe(false);
  });
});

describe("formatCOP", () => {
  it("formatea BigInt serializado como COP sin decimales", () => {
    expect(formatCOP("45226000")).toContain("45.226.000");
  });
});
