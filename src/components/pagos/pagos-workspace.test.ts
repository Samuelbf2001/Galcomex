import { describe, expect, it } from "vitest";

import { formatCOP } from "./pagos-global-api";
import {
  esDineroSoloLectura,
  normalizeAplicacion,
  normalizeGrupo,
  normalizeGrupoOtrosDOs,
  normalizePagoRow,
  textoCostosBancariosDetalle,
  textoFacturasEnDOs,
  totalCostosBancarios,
} from "./pagos-workspace";

// ---------------------------------------------------------------------------
// Estas pruebas son el motivo real de escribirlas: `normalizePagoRow` y sus
// hermanas leen la respuesta REAL de `GET /api/pagos` (nombres de campo tal
// como los serializa `listarPagosGlobal`, src/lib/pagos/service.ts, P1) — no
// la del `normalizePago` de `pagos-global-api.ts` (P4), que manda mal el
// filtro de proveedor y lee campos que el servidor no envía (`facturas` en
// vez de `aplicaciones`, `costosBancariosGalcomex` en vez de
// `costosAsumidosGalcomex`). Si el contrato de la ruta cambia de nombre, esta
// prueba debe fallar aquí, no en producción.
// ---------------------------------------------------------------------------

describe("normalizePagoRow (contrato real de GET /api/pagos)", () => {
  const filaCruda = {
    id: "pago-1",
    tramiteId: "tramite-1",
    tramite: {
      id: "tramite-1",
      consecutivo: "DO.BAQ26-0238",
      estado: "EN_TRAMITE",
      cliente: { id: "cliente-1", nombre: "Litoplas", nit: "9001" },
    },
    concepto: "Almacenaje Almacarga",
    beneficiarios: [{ beneficiario: { id: "ben-1", nombre: "ALMACARGA", nit: "800154017-8" } }],
    numSoporte: null,
    documentoId: "doc-1",
    faltaComprobante: false,
    grupoPagoId: "grupo-1",
    grupoOtrosDOs: [
      { tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" },
      { tramiteId: "tramite-3", consecutivo: "DO.BAQ26-0255" },
    ],
    // Nombre de campo real del backend: `aplicaciones`, NO `facturas`.
    aplicaciones: [
      { facturaId: "fact-1", numFactura: "FE-12481", numFacturaVisible: "FE 12481", monto: "464077" },
    ],
    tieneFacturas: true,
    esBloque: true,
    editableDinero: false,
    grupo: {
      estado: "ACTIVO",
      costoBancario: "3900",
      costoAsumidoPor: "PRIMER_DO",
      esHistorico: false,
      otrosDOs: [{ tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" }],
    },
    valor: "464077",
    canalPago: "TRANSF_BANCOLOMBIA",
    costoBancario: "0",
    orden: 1,
    fechaRealPago: "2026-09-23T00:00:00.000Z",
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
  };

  it("lee `aplicaciones` (no `facturas`) con el monto de cada factura cubierta", () => {
    const fila = normalizePagoRow(filaCruda);
    expect(fila?.aplicaciones).toEqual([
      { facturaId: "fact-1", numFactura: "FE-12481", numFacturaVisible: "FE 12481", monto: "464077" },
    ]);
  });

  it("lee tieneFacturas, esBloque, editableDinero y el detalle de `grupo`", () => {
    const fila = normalizePagoRow(filaCruda);
    expect(fila?.tieneFacturas).toBe(true);
    expect(fila?.esBloque).toBe(true);
    expect(fila?.editableDinero).toBe(false);
    expect(fila?.grupo).toEqual({
      estado: "ACTIVO",
      costoBancario: "3900",
      costoAsumidoPor: "PRIMER_DO",
      esHistorico: false,
      otrosDOs: [{ tramiteId: "tramite-2", consecutivo: "DO.BAQ26-0226" }],
    });
  });

  it("arma el nombre del cliente y del DO desde `tramite`", () => {
    const fila = normalizePagoRow(filaCruda);
    expect(fila?.consecutivo).toBe("DO.BAQ26-0238");
    expect(fila?.clienteNombre).toBe("Litoplas");
  });

  it("une los nombres de los beneficiarios con coma", () => {
    const fila = normalizePagoRow({
      ...filaCruda,
      beneficiarios: [
        { beneficiario: { nombre: "ALMACARGA" } },
        { beneficiario: { nombre: "EXPRESS" } },
      ],
    });
    expect(fila?.beneficiarios).toBe("ALMACARGA, EXPRESS");
  });

  it("no revienta con una fila mínima: valores por defecto seguros", () => {
    const fila = normalizePagoRow({ id: "pago-2" });
    expect(fila).not.toBeNull();
    expect(fila?.aplicaciones).toEqual([]);
    expect(fila?.tieneFacturas).toBe(false);
    expect(fila?.esBloque).toBe(false);
    // Sin backend nuevo, `editableDinero` no debe bloquear la edición por defecto.
    expect(fila?.editableDinero).toBe(true);
    expect(fila?.grupo).toBeNull();
    expect(fila?.valor).toBe("0");
  });

  it("devuelve null para una entrada que no es un objeto", () => {
    expect(normalizePagoRow(null)).toBeNull();
    expect(normalizePagoRow("pago-1")).toBeNull();
  });
});

describe("normalizeAplicacion / normalizeGrupo / normalizeGrupoOtrosDOs", () => {
  it("usa numFactura como respaldo si falta numFacturaVisible", () => {
    expect(normalizeAplicacion({ facturaId: "f1", numFactura: "REG-50151039", monto: "83800" })).toEqual({
      facturaId: "f1",
      numFactura: "REG-50151039",
      numFacturaVisible: "REG-50151039",
      monto: "83800",
    });
  });

  it("normalizeGrupo: ACTIVO por defecto y GALCOMEX se conserva tal cual", () => {
    expect(
      normalizeGrupo({ estado: "ANULADO", costoBancario: "3900", costoAsumidoPor: "GALCOMEX", esHistorico: true, otrosDOs: [] }),
    ).toEqual({ estado: "ANULADO", costoBancario: "3900", costoAsumidoPor: "GALCOMEX", esHistorico: true, otrosDOs: [] });
    expect(normalizeGrupo(null)).toBeNull();
  });

  it("normalizeGrupoOtrosDOs ignora entradas que no son objetos", () => {
    expect(normalizeGrupoOtrosDOs([{ tramiteId: "t1", consecutivo: "DO.BAQ26-0069" }, "basura", null])).toEqual([
      { tramiteId: "t1", consecutivo: "DO.BAQ26-0069" },
    ]);
  });
});

describe("esDineroSoloLectura (§D.4/§D.5: no se edita a mano un pago con facturas o de bloque)", () => {
  it("de solo lectura si tiene facturas aplicadas, aunque el rol pueda editar", () => {
    expect(esDineroSoloLectura({ tieneFacturas: true, esBloque: false }, false)).toBe(true);
  });

  it("de solo lectura si es un pago de bloque", () => {
    expect(esDineroSoloLectura({ tieneFacturas: false, esBloque: true }, false)).toBe(true);
  });

  it("editable para un pago suelto sin facturas cuando el rol puede editar", () => {
    expect(esDineroSoloLectura({ tieneFacturas: false, esBloque: false }, false)).toBe(false);
  });

  it("siempre de solo lectura para REVISOR (readOnly=true), tenga o no facturas", () => {
    expect(esDineroSoloLectura({ tieneFacturas: false, esBloque: false }, true)).toBe(true);
  });
});

describe("textoFacturasEnDOs (franja del proveedor, §D.5)", () => {
  it("plural: '3 facturas en 3 DOs'", () => {
    expect(textoFacturasEnDOs(3, 3)).toBe("3 facturas en 3 DOs");
  });

  it("singular: '1 factura en 1 DO'", () => {
    expect(textoFacturasEnDOs(1, 1)).toBe("1 factura en 1 DO");
  });

  it("mixto: '2 facturas en 1 DO'", () => {
    expect(textoFacturasEnDOs(2, 1)).toBe("2 facturas en 1 DO");
  });

  it("cero: '0 facturas en 0 DOs' (proveedor sin saldo pendiente)", () => {
    expect(textoFacturasEnDOs(0, 0)).toBe("0 facturas en 0 DOs");
  });
});

describe("textoCostosBancariosDetalle (tarjeta 'Costos bancarios', R8)", () => {
  it("null cuando Galcomex no asumió ningún costo", () => {
    expect(textoCostosBancariosDetalle("0")).toBeNull();
  });

  it("frase con el monto formateado (formatCOP) cuando Galcomex sí asumió costos", () => {
    expect(textoCostosBancariosDetalle("3900")).toBe(`de ellos ${formatCOP("3900")} asumidos por Galcomex`);
  });

  it("null ante un valor no numérico (defensivo)", () => {
    expect(textoCostosBancariosDetalle("no-es-un-numero")).toBeNull();
  });
});

describe("totalCostosBancarios — la tarjeta no pierde lo que asumió Galcomex al editar en línea", () => {
  it("bloque de Litoplas por PSE con $3.900 asumidos por Galcomex: sigue en 3.900 tras recalcular", () => {
    expect(totalCostosBancarios(["0", "0"], "3900")).toBe(3_900n);
  });
  it("suma los costos de cada pago más lo asumido; valores vacíos o raros cuentan 0", () => {
    expect(totalCostosBancarios(["11290", "3900", ""], "7300")).toBe(22_490n);
    expect(totalCostosBancarios(["x"], "")).toBe(0n);
  });
});
