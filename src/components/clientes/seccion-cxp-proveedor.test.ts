import { describe, expect, it } from "vitest";

import { desgloseResumenCxp, filtrarFacturasCxp } from "@/components/clientes/seccion-cxp-proveedor";
import type { FilaEstadoCuentaJson } from "@/lib/cxp/contratos-api";

function factura(overrides: Partial<FilaEstadoCuentaJson>): FilaEstadoCuentaJson {
  return {
    id: "id",
    numFactura: "FE-12481",
    numFacturaVisible: "FE 12481",
    valor: "464077",
    aplicado: "0",
    montoAjustes: "0",
    compensado: "0",
    saldo: "464077",
    estado: "REGISTRADA",
    etiqueta: "Pendiente",
    fecha: "2026-07-15",
    moneda: "COP",
    valorOrigen: null,
    trm: null,
    tramiteId: "tramite-1",
    tramiteConsecutivo: "DO.BAQ26-0238",
    doCorto: "26-0238",
    tramiteEstado: "EN_TRAMITE",
    marca: "IM054-26 SRF",
    clienteId: "cliente-1",
    clienteNombre: "LITOPLAS SA",
    beneficiarioId: "ben-1",
    beneficiarioNombre: "ALMACARGA",
    repercutible: true,
    saldoTramite: "1000000",
    pagable: true,
    motivoNoPagable: null,
    advertencias: [],
    puedeAbsorberCosto: true,
    conciliacionPendiente: false,
    tieneAnticipoAplicado: true,
    facturadaAlCliente: null,
    pagos: [],
    ajustes: [],
    fechaPago: null,
    abonos: [],
    ...overrides,
  };
}

describe("filtrarFacturasCxp", () => {
  const pendiente = factura({
    id: "p1",
    estado: "REGISTRADA",
    numFactura: "FE-12481",
    numFacturaVisible: "FE 12481",
    doCorto: "26-0238",
    marca: "IM054-26 SRF",
  });
  const abonada = factura({
    id: "p2",
    estado: "PARCIAL",
    etiqueta: "Abonada",
    numFactura: "FE-12334",
    numFacturaVisible: "FE 12334",
    doCorto: "26-0069",
    tramiteConsecutivo: "DO.BAQ26-0069",
    marca: "IM054-26 SRF",
  });
  const pagada = factura({
    id: "p3",
    estado: "PAGADA",
    etiqueta: "Pagada",
    numFactura: "FE-12539",
    numFacturaVisible: "FE 12539",
    saldo: "0",
    doCorto: "26-0301",
    tramiteConsecutivo: "DO.BAQ26-0301",
    marca: "OTRA MARCA",
  });
  const todas = [pendiente, abonada, pagada];

  it("PENDIENTES: solo REGISTRADA y PARCIAL", () => {
    const r = filtrarFacturasCxp(todas, "PENDIENTES", "");
    expect(r.map((f) => f.id)).toEqual(["p1", "p2"]);
  });

  it("PAGADAS: solo PAGADA", () => {
    const r = filtrarFacturasCxp(todas, "PAGADAS", "");
    expect(r.map((f) => f.id)).toEqual(["p3"]);
  });

  it("TODAS: no filtra por estado", () => {
    const r = filtrarFacturasCxp(todas, "TODAS", "");
    expect(r).toHaveLength(3);
  });

  it("busca por número de factura visible, sin importar mayúsculas", () => {
    const r = filtrarFacturasCxp(todas, "TODAS", "fe 12481");
    expect(r.map((f) => f.id)).toEqual(["p1"]);
  });

  it("busca por DO corto (26-0238)", () => {
    const r = filtrarFacturasCxp(todas, "TODAS", "26-0238");
    expect(r.map((f) => f.id)).toEqual(["p1"]);
  });

  it("busca por marca", () => {
    const r = filtrarFacturasCxp(todas, "TODAS", "IM054-26 SRF");
    expect(r.map((f) => f.id)).toEqual(["p1", "p2"]);
  });

  it("combina filtro de estado y búsqueda", () => {
    const r = filtrarFacturasCxp(todas, "PAGADAS", "26-0301");
    expect(r.map((f) => f.id)).toEqual(["p3"]);
  });

  it("sin coincidencias devuelve vacío", () => {
    expect(filtrarFacturasCxp(todas, "TODAS", "no-existe")).toEqual([]);
  });
});

describe("desgloseResumenCxp — que las tarjetas cuadren (Total = Pagado + cruzado + ajustes + Le debemos)", () => {
  it("Almacarga tras M3: ajuste LEGADO de 102.801 aparece como Ajustes de migración", () => {
    expect(desgloseResumenCxp({ cruzado: "0", ajustado: "102801" })).toEqual([
      { etiqueta: "Ajustes de migración", valor: "102801" },
    ]);
  });

  it("con cruce y ajuste salen los dos; en 0 no sale nada", () => {
    expect(desgloseResumenCxp({ cruzado: "50000", ajustado: "1" }).map((d) => d.etiqueta)).toEqual([
      "Cruzado en cuenta corriente",
      "Ajustes de migración",
    ]);
    expect(desgloseResumenCxp({ cruzado: "0", ajustado: "0" })).toEqual([]);
    expect(desgloseResumenCxp({ cruzado: "", ajustado: "x" })).toEqual([]);
  });
});
