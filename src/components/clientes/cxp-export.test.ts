import { describe, expect, it } from "vitest";

import * as XLSX from "xlsx";

import {
  ENCABEZADOS_CARTERA,
  ENCABEZADOS_PAGOS,
  FORMATO_FECHA_EXCEL,
  fechaParaExcel,
  filaCartera,
  filaPago,
  filaTituloCartera,
  filasHojaCartera,
  filasHojaPagos,
} from "@/components/clientes/cxp-export";
import type { FilaEstadoCuentaJson, PagoRealizadoJson } from "@/lib/cxp/contratos-api";

// ─── Fixtures mínimas (caso real §H: FE-12481 Almacarga, 464.077) ────────────

function facturaBase(overrides: Partial<FilaEstadoCuentaJson> = {}): FilaEstadoCuentaJson {
  return {
    id: "fac-1",
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

function pagoBase(overrides: Partial<PagoRealizadoJson> = {}): PagoRealizadoJson {
  return {
    tipo: "BLOQUE",
    id: "grupo-1",
    fecha: "2026-09-15",
    concepto: "Pago ALMACARGA 15/09/2026",
    valor: "1358815",
    aplicadoAFacturas: "1358815",
    sinFactura: "0",
    canalPago: "TRANSF_BANCOLOMBIA",
    costoBancario: "3900",
    costoAsumidoPor: "GALCOMEX",
    estado: "ACTIVO",
    esHistorico: false,
    comprobante: { documentoId: "doc-1", tramiteId: "tramite-1" },
    dos: [{ tramiteId: "tramite-1", consecutivo: "DO.BAQ26-0238", valor: "464077" }],
    facturas: [{ facturaId: "fac-1", numFactura: "FE 12481", monto: "464077" }],
    anulacion: null,
    ...overrides,
  };
}

// ─── CARTERA ──────────────────────────────────────────────────────────────

describe("filaTituloCartera", () => {
  it("arma CARTERA | proveedor | ... | C X P | saldo", () => {
    expect(filaTituloCartera("ALMACARGA", "1358815")).toEqual([
      "CARTERA",
      "ALMACARGA",
      "",
      "",
      "",
      "C X P",
      1358815,
    ]);
  });
});

describe("filaCartera", () => {
  it("factura Pendiente: PAGO vacío, ABONOS vacío, ESTADO = Pendiente", () => {
    const fila = filaCartera(facturaBase());
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    expect(fila[idx("FACTURA")]).toBe("FE 12481");
    expect(fila[idx("PAGO")]).toBe("");
    expect(fila[idx("ABONOS")]).toBe("");
    expect(fila[idx("ESTADO")]).toBe("Pendiente");
    expect(fila[idx("SALDO")]).toBe(464077);
  });

  it("factura Abonada (saldo > 0): PAGO sigue vacío (nunca se pone fecha con saldo > 0), ABONOS trae fecha y monto", () => {
    const fila = filaCartera(
      facturaBase({
        estado: "PARCIAL",
        etiqueta: "Abonada",
        aplicado: "200000",
        saldo: "264077",
        fechaPago: null,
        abonos: [{ fecha: "2026-09-16", monto: "200000" }],
      }),
    );
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    expect(fila[idx("PAGO")]).toBe("");
    expect(fila[idx("ABONOS")]).toContain("16/09/2026");
    expect(fila[idx("ABONOS")]).toContain("200.000"); // formatCOP: símbolo de moneda puede variar, el monto no
    expect(fila[idx("ESTADO")]).toBe("Abonada");
    expect(fila[idx("SALDO")]).toBe(264077);
  });

  it("factura Pagada (saldo = 0): PAGO trae la fecha que la dejó en saldo 0", () => {
    const fila = filaCartera(
      facturaBase({
        estado: "PAGADA",
        etiqueta: "Pagada",
        aplicado: "464077",
        saldo: "0",
        fechaPago: "2026-09-15",
        abonos: [],
      }),
    );
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    expect(fila[idx("PAGO")]).toBe("15/09/2026");
    expect(fila[idx("ABONOS")]).toBe("");
    expect(fila[idx("SALDO")]).toBe(0);
  });

  it("usa la fecha de la factura como fecha-calendario: el mismo día a medianoche local (sin corrimiento)", () => {
    const fila = filaCartera(facturaBase({ fecha: "2026-07-15" }));
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    const fecha = fila[idx("FECHA")] as Date;
    expect(fecha).toBeInstanceOf(Date);
    expect([fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), fecha.getHours()]).toEqual([2026, 6, 15, 0]);
  });

  it("la celda FECHA del Excel es el día exacto (serial entero) con formato dd/mm/yyyy — antes salía el día anterior a las 19:00 en Bogotá", () => {
    const hoja = XLSX.utils.aoa_to_sheet([[fechaParaExcel("2026-09-15T00:00:00.000Z")]], { dateNF: FORMATO_FECHA_EXCEL });
    const celda = hoja.A1 as XLSX.CellObject;
    expect(celda.t).toBe("n");
    expect(Number.isInteger(celda.v)).toBe(true);
    // 15/09/2026 = serial 46280 (1900 date system).
    expect(celda.v).toBe(46280);
    expect(celda.z).toBe(FORMATO_FECHA_EXCEL);
    expect(XLSX.SSF.format(FORMATO_FECHA_EXCEL, celda.v as number)).toBe("15/09/2026");
  });

  it("marca null se exporta como celda vacía, no 'null'", () => {
    const fila = filaCartera(facturaBase({ marca: null }));
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    expect(fila[idx("PROVEEDOR")]).toBe("");
  });

  it("COMPROBANTE: 'Sí' si algún pago trae comprobante, 'No' si ninguno", () => {
    const conComprobante = facturaBase({
      pagos: [
        {
          pagoId: "pago-1",
          grupoPagoId: null,
          fechaRealPago: "2026-09-15",
          monto: "464077",
          esHistorico: false,
          comprobante: { documentoId: "doc-1", tramiteId: "tramite-1" },
        },
      ],
    });
    const sinComprobante = facturaBase({
      pagos: [
        {
          pagoId: "pago-2",
          grupoPagoId: null,
          fechaRealPago: "2026-09-15",
          monto: "464077",
          esHistorico: true,
          comprobante: null,
        },
      ],
    });
    const idx = (col: (typeof ENCABEZADOS_CARTERA)[number]) => ENCABEZADOS_CARTERA.indexOf(col);
    expect(filaCartera(conComprobante)[idx("COMPROBANTE")]).toBe("Sí");
    expect(filaCartera(sinComprobante)[idx("COMPROBANTE")]).toBe("No");
  });
});

describe("filasHojaCartera", () => {
  it("fila 1 = título, fila 2 = blanco, fila 3 = encabezados, luego una fila por factura", () => {
    const filas = filasHojaCartera("ALMACARGA", { pendiente: "1358815" }, [facturaBase()]);
    expect(filas).toHaveLength(4);
    expect(filas[0][0]).toBe("CARTERA");
    expect(filas[1]).toEqual([]);
    expect(filas[2]).toEqual([...ENCABEZADOS_CARTERA]);
    expect(filas[3][0]).toBe("FE 12481");
  });
});

// ─── PAGOS ────────────────────────────────────────────────────────────────

describe("filaPago", () => {
  it("bloque activo: DOs y facturas en columnas separadas por coma, ESTADO Activo", () => {
    const fila = filaPago(pagoBase());
    const idx = (col: (typeof ENCABEZADOS_PAGOS)[number]) => ENCABEZADOS_PAGOS.indexOf(col);
    expect(fila[idx("VALOR")]).toBe(1358815);
    expect(fila[idx("DOs")]).toBe("DO.BAQ26-0238");
    expect(fila[idx("FACTURAS")]).toBe("FE 12481");
    expect(fila[idx("COMPROBANTE")]).toBe("Sí");
    expect(fila[idx("ESTADO")]).toBe("Activo");
    expect(fila[idx("LO ASUME")]).toBe("Galcomex");
  });

  it("bloque anulado: ESTADO trae fecha, quién y motivo", () => {
    const fila = filaPago(
      pagoBase({
        estado: "ANULADO",
        anulacion: { motivo: "Duplicado por error de digitación", por: "Camila", en: "2026-09-20T14:00:00.000Z" },
      }),
    );
    const idx = (col: (typeof ENCABEZADOS_PAGOS)[number]) => ENCABEZADOS_PAGOS.indexOf(col);
    expect(fila[idx("ESTADO")]).toContain("Anulado el 20/09/2026");
    expect(fila[idx("ESTADO")]).toContain("Camila");
    expect(fila[idx("ESTADO")]).toContain("Duplicado por error de digitación");
  });

  it("registro histórico: ESTADO = 'Registro histórico (Excel)'", () => {
    const fila = filaPago(pagoBase({ esHistorico: true, costoBancario: "0", costoAsumidoPor: "GALCOMEX" }));
    const idx = (col: (typeof ENCABEZADOS_PAGOS)[number]) => ENCABEZADOS_PAGOS.indexOf(col);
    expect(fila[idx("ESTADO")]).toBe("Registro histórico (Excel)");
  });

  it("pago suelto sin costoAsumidoPor: LO ASUME queda vacío", () => {
    const fila = filaPago(pagoBase({ tipo: "SUELTO", costoAsumidoPor: null }));
    const idx = (col: (typeof ENCABEZADOS_PAGOS)[number]) => ENCABEZADOS_PAGOS.indexOf(col);
    expect(fila[idx("LO ASUME")]).toBe("");
  });
});

describe("filasHojaPagos", () => {
  it("fila 1 = encabezados, luego una fila por pago", () => {
    const filas = filasHojaPagos([pagoBase()]);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toEqual([...ENCABEZADOS_PAGOS]);
  });

  it("sin pagos: solo la fila de encabezados", () => {
    expect(filasHojaPagos([])).toHaveLength(1);
  });
});
