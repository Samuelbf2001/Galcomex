/**
 * Mensajes exactos de CxP v2 (diseño §B.7): las pruebas de P1/P2/P8 y los
 * `it.fails` heredados los buscan por texto.
 */
import { describe, expect, it } from "vitest";

import {
  BeneficiarioExisteError,
  BloqueConDoCerradoError,
  ComprobanteObligatorioError,
  cuerpoErrorCxp,
  CxpError,
  DoConFacturasPendientesError,
  errorDeAplicacion,
  esErrorSobreaplicacion,
  FacturaConPagosError,
  FacturaDeOtroProveedorError,
  FacturaDuplicadaError,
  FacturaProveedorNoEncontradaError,
  FacturaSinMontoError,
  FacturaSinProveedorError,
  FacturaSinSaldoError,
  FacturaYaCobradaError,
  IdempotenciaConflictoError,
  MontoExcedeSaldoError,
  NitDvInvalidoError,
  NitNoCoincideEmpresaError,
  PagoDeBloqueError,
  PagoExcedeSaldoError,
  PagoNoCuadraError,
  PagoNoEditableError,
  PosibleBeneficiarioDuplicadoError,
  PosibleDuplicadoError,
  ProveedoresMezcladosError,
  ProveedorObligatorioError,
  SinAnticipoError,
  UsdValorLejosDeTrmError,
} from "../errores";
import * as facturasService from "@/lib/facturas-proveedor/service";

describe("mensajes §B.7", () => {
  const casos: [CxpError, number, string, string][] = [
    [
      new FacturaSinSaldoError("FE 12481", "ALMACARGA"),
      409,
      "FACTURA_SIN_SALDO",
      "La factura FE 12481 de ALMACARGA ya está pagada; no se puede volver a pagar.",
    ],
    [
      new MontoExcedeSaldoError("FE 12602", 200_000n, 300_000n),
      409,
      "MONTO_EXCEDE_SALDO",
      "A la factura FE 12602 solo le faltan $200.000 por pagar; no se le pueden aplicar $300.000.",
    ],
    [
      new PagoExcedeSaldoError(928_154n, 464_077n),
      422,
      "PAGO_EXCEDE_SALDO",
      "El pago ($928.154) es mayor que lo que falta por pagar de las facturas escogidas ($464.077). No se puede pagar de más.",
    ],
    [
      new PagoNoCuadraError(500_000n, 464_077n),
      422,
      "PAGO_NO_CUADRA",
      "El valor del pago ($500.000) debe ser igual a lo aplicado a las facturas ($464.077).",
    ],
    [
      new FacturaDeOtroProveedorError("FE-11298", "ALMACARGA", "TAMPA CARGO"),
      422,
      "FACTURA_DE_OTRO_PROVEEDOR",
      "La factura FE-11298 es de ALMACARGA, no de TAMPA CARGO.",
    ],
    [
      new ProveedoresMezcladosError(["FE 12481", "FE 6353"]),
      422,
      "PROVEEDORES_MEZCLADOS",
      "Un pago va a un solo proveedor: FE 12481 y FE 6353 son de proveedores distintos.",
    ],
    [
      new FacturaSinProveedorError("FE-1"),
      422,
      "FACTURA_SIN_PROVEEDOR",
      "La factura FE-1 no tiene proveedor: edítala y escoge el proveedor antes de pagarla.",
    ],
    [
      new PagoDeBloqueError(3),
      409,
      "PAGO_DE_BLOQUE",
      "Este pago es parte de un pago en bloque (3 DOs); para quitarlo, anula el bloque completo desde la ficha del proveedor.",
    ],
    [
      new PagoNoEditableError(),
      409,
      "PAGO_NO_EDITABLE",
      "Este pago cubre facturas o es parte de un pago en bloque: para cambiar el valor o el canal, anula y registra de nuevo.",
    ],
    [
      new BloqueConDoCerradoError(["DO.BAQ26-0238"]),
      409,
      "BLOQUE_CON_DO_CERRADO",
      "No se puede anular: DO.BAQ26-0238 está cerrado. Un administrador debe reabrirlo primero.",
    ],
    [
      new SinAnticipoError("DO.BAQ26-0255", "LITOPLAS SA"),
      422,
      "SIN_ANTICIPO",
      "El DO DO.BAQ26-0255 no tiene anticipo aplicado y LITOPLAS SA tiene encendida la función «Sin anticipo no hay pago». Aplica un anticipo o apaga la función en la ficha de LITOPLAS SA.",
    ],
    [new ComprobanteObligatorioError(), 422, "COMPROBANTE_OBLIGATORIO", "Adjunta el comprobante del banco."],
    [new ProveedorObligatorioError(), 422, "PROVEEDOR_OBLIGATORIO", "El proveedor es obligatorio."],
    [
      new FacturaDuplicadaError({
        numFactura: "FE 12481",
        proveedor: "ALMACARGA",
        doCorto: "26-0238",
        consecutivo: "DO.BAQ26-0238",
      }),
      409,
      "FACTURA_DUPLICADA",
      "La factura FE 12481 de ALMACARGA ya está registrada en el DO 26-0238 (DO.BAQ26-0238).",
    ],
    [
      new PosibleDuplicadoError("ALMACARGA", [
        { facturaId: "f1", numFactura: "FE-12481", doCorto: "26-0238", consecutivo: "DO.BAQ26-0238", valor: 464_077n },
      ]),
      409,
      "POSIBLE_DUPLICADO",
      "¿Es la misma factura? ALMACARGA ya tiene FE-12481 en el DO 26-0238 por $464.077.",
    ],
    [
      new FacturaYaCobradaError("LITOPLAS SA", "BAQ-18742"),
      409,
      "FACTURA_YA_COBRADA",
      "Esta factura ya se le cobró a LITOPLAS SA en BAQ-18742: primero corrige la factura de venta.",
    ],
    [
      new FacturaConPagosError(100_000n),
      409,
      "FACTURA_CON_PAGOS",
      "Esta factura ya tiene pagos por $100.000: no se puede cambiar el valor, el proveedor ni el número. Si llegó una nota crédito, avísale a administración.",
    ],
    [
      new FacturaSinMontoError(300_000n, ["FE 12334", "FE 12481"], ["f3"]),
      422,
      "FACTURA_SIN_MONTO",
      "El valor ($300.000) solo alcanza para FE 12334 y FE 12481; quita las demás facturas o indica el monto de cada una.",
    ],
    [
      new IdempotenciaConflictoError("OTRO_CONTENIDO"),
      409,
      "IDEMPOTENCIA_CONFLICTO",
      "Este pago ya se registró con otros datos (o se anuló). Cierra la ventana y vuelve a abrirla para registrar uno nuevo.",
    ],
    [
      new NitDvInvalidoError(5, "800154017", 8),
      422,
      "NIT_DV_INVALIDO",
      "El dígito de verificación 5 no corresponde al NIT 800154017 (debería ser 8).",
    ],
    [
      new NitNoCoincideEmpresaError("80015401", "ALMACARGA", "800154017-8"),
      422,
      "NIT_NO_COINCIDE_EMPRESA",
      "El NIT 80015401 no es el de la empresa ALMACARGA (800154017-8).",
    ],
    [
      new PosibleBeneficiarioDuplicadoError([
        { id: "b1", nombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S', nit: "800154017-8" },
      ]),
      409,
      "POSIBLE_BENEFICIARIO_DUPLICADO",
      '¿Es la misma empresa? Ya existe ALMACENADORA DE CARGA "ALMACARGA" S.A.S con NIT 800154017-8.',
    ],
    [
      new UsdValorLejosDeTrmError({
        valorOrigenCentavos: 13_100n,
        trmCentavos: 371_050n,
        sugerido: 486_076n,
        valor: 4_860_760n,
        diferenciaPorcentaje: 900n,
      }),
      409,
      "USD_VALOR_LEJOS_DE_TRM",
      "USD 131,00 × TRM 3.710,50 = $486.076; escribiste $4.860.760 (900 % de diferencia). ¿Está bien?",
    ],
    [
      new DoConFacturasPendientesError("DO.BAQ26-0238", [{ numFactura: "FE-12481", saldo: 464_077n }]),
      422,
      "DO_CON_FACTURAS_PENDIENTES",
      "No se puede cerrar DO.BAQ26-0238: tiene 1 factura de proveedor sin pagar (FE-12481 $464.077).",
    ],
    [
      new BeneficiarioExisteError({ id: "b1", nombre: 'ALMACENADORA DE CARGA "ALMACARGA" S.A.S', nit: "800154017-8" }),
      409,
      "BENEFICIARIO_EXISTE",
      'Ya existe: ALMACENADORA DE CARGA "ALMACARGA" S.A.S (NIT 800154017-8). Usa esa ficha.',
    ],
  ];

  it.each(casos)("%#: status, código y mensaje exactos", (error, status, codigo, mensaje) => {
    expect(error).toBeInstanceOf(CxpError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(status);
    expect(error.codigo).toBe(codigo);
    expect(error.message).toBe(mensaje);
  });

  it("plurales: varios DOs cerrados, varias facturas pendientes, 1 DO en el bloque", () => {
    expect(new BloqueConDoCerradoError(["DO.BAQ26-0238", "DO.BAQ26-0255"]).message).toBe(
      "No se puede anular: DO.BAQ26-0238 y DO.BAQ26-0255 están cerrados. Un administrador debe reabrirlos primero.",
    );
    expect(
      new DoConFacturasPendientesError("DO.BAQ26-0238", [
        { numFactura: "FE-12481", saldo: 464_077n },
        { numFactura: "FE-12539", saldo: 261_377n },
      ]).message,
    ).toBe(
      "No se puede cerrar DO.BAQ26-0238: tiene 2 facturas de proveedor sin pagar (FE-12481 $464.077, FE-12539 $261.377).",
    );
    expect(new PagoDeBloqueError(1).message).toContain("(1 DO)");
  });

  it("los regex de los it.fails heredados siguen coincidiendo", () => {
    expect(new FacturaSinSaldoError("FE 1", "ALMACARGA").message).toMatch(/ya está pagada/);
    expect(new FacturaDeOtroProveedorError("FE 1", "ALMACARGA", "TAMPA CARGO").message).toMatch(/es de ALMACARGA/);
    expect(new PagoDeBloqueError(2).message).toMatch(/pago en bloque/);
    expect(new PagoNoEditableError().message).toMatch(/anula y registra de nuevo/);
    expect(new DoConFacturasPendientesError("DO.X", [{ numFactura: "FE 1", saldo: 1n }]).message).toMatch(
      /factura de proveedor sin pagar/,
    );
    expect(
      new FacturaDuplicadaError({ numFactura: "FE 1", proveedor: "A", doCorto: "26-0001", consecutivo: "DO.X" }).message,
    ).toMatch(/ya está registrada/);
    expect(new FacturaYaCobradaError("Litoplas SA", "BAQ-1").message).toMatch(/ya se le cobró a Litoplas/i);
  });
});

describe("errorDeAplicacion", () => {
  it("traduce el primer error y adjunta todos en detalles", () => {
    const e = errorDeAplicacion([
      { codigo: "FACTURA_SIN_SALDO", numFactura: "FE 12481", proveedor: "ALMACARGA" },
      { codigo: "MONTO_EXCEDE_SALDO", numFactura: "FE 12539", monto: 2n, saldo: 1n },
    ]);
    expect(e.codigo).toBe("FACTURA_SIN_SALDO");
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/ya está pagada/);
    expect(cuerpoErrorCxp(e)).toEqual({
      error: e.message,
      codigo: "FACTURA_SIN_SALDO",
      detalles: {
        numFactura: "FE 12481",
        proveedor: "ALMACARGA",
        errores: [
          { codigo: "FACTURA_SIN_SALDO", numFactura: "FE 12481", proveedor: "ALMACARGA" },
          { codigo: "MONTO_EXCEDE_SALDO", numFactura: "FE 12539", monto: "2", saldo: "1" },
        ],
      },
    });
  });

  it("un solo error → la clase específica", () => {
    expect(errorDeAplicacion([{ codigo: "MONTO_EXCEDE_SALDO", numFactura: "FE 1", monto: 3n, saldo: 2n }])).toBeInstanceOf(
      MontoExcedeSaldoError,
    );
    expect(() => errorDeAplicacion([])).toThrow();
  });
});

describe("utilidades", () => {
  it("cuerpoErrorCxp serializa BigInt y omite detalles vacíos", () => {
    expect(cuerpoErrorCxp(new ComprobanteObligatorioError())).toEqual({
      error: "Adjunta el comprobante del banco.",
      codigo: "COMPROBANTE_OBLIGATORIO",
    });
    expect(cuerpoErrorCxp(new MontoExcedeSaldoError("FE 1", 2n, 3n)).detalles).toEqual({
      numFactura: "FE 1",
      saldo: "2",
      monto: "3",
    });
  });

  it("esErrorSobreaplicacion reconoce el RAISE del guardián de BD", () => {
    expect(esErrorSobreaplicacion(new Error("CXP_SOBREAPLICACION: factura x valor 1"))).toBe(true);
    expect(esErrorSobreaplicacion(new Error("otra cosa"))).toBe(false);
    expect(esErrorSobreaplicacion(null)).toBe(false);
  });

  it("las clases heredadas siguen siendo las mismas al importarlas desde facturas-proveedor/service", () => {
    expect(facturasService.FacturaProveedorNoEncontradaError).toBe(FacturaProveedorNoEncontradaError);
    const e = new facturasService.FacturaProveedorNoEncontradaError("x");
    expect(e).toBeInstanceOf(FacturaProveedorNoEncontradaError);
    expect(e.status).toBe(404);
    expect(e.message).toBe("Factura de proveedor x no encontrada");
  });
});
