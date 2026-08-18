/**
 * Tests de reglas puras de trámites — Sprint (pendientes reunión 2026-07-01).
 *
 * - puedeModificarDocumentos: B2 — inmutabilidad de documentos en CERRADO.
 * - construirFiltroFacturado: B1 — filtro "¿ya está facturado?" del listado.
 * - faltanDocumentosObligatorios: B4 — BL + Factura Comercial obligatorios
 *   server-side para clientes SOCIO_LM.
 *
 * Sin BD — funciones puras.
 */

import { CategoriaDocumento, EstadoBorrador, EstadoTramite, TipoCliente } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  construirFiltroFacturado,
  faltanDocumentosObligatorios,
  puedeModificarDocumentos,
} from "../service";

describe("puedeModificarDocumentos", () => {
  it("CERRADO → false (inmutable)", () => {
    expect(puedeModificarDocumentos(EstadoTramite.CERRADO)).toBe(false);
  });

  it.each([
    EstadoTramite.SOLICITUD,
    EstadoTramite.APERTURA,
    EstadoTramite.EN_TRAMITE,
    EstadoTramite.EN_PUERTO,
    EstadoTramite.DESPACHADO,
    EstadoTramite.ENVIADO_A_FACTURAR,
    EstadoTramite.FACTURADO,
    EstadoTramite.PAGADO,
  ])("%s → true (modificable)", (estado) => {
    expect(puedeModificarDocumentos(estado)).toBe(true);
  });
});

describe("construirFiltroFacturado", () => {
  it("undefined → sin filtro (no agrega criterio)", () => {
    expect(construirFiltroFacturado(undefined)).toBeUndefined();
  });

  it("true → { some: { estado: FACTURADO } }", () => {
    expect(construirFiltroFacturado(true)).toEqual({
      some: { estado: EstadoBorrador.FACTURADO },
    });
  });

  it("false → { none: { estado: FACTURADO } } (mismo criterio que el dashboard)", () => {
    expect(construirFiltroFacturado(false)).toEqual({
      none: { estado: EstadoBorrador.FACTURADO },
    });
  });
});

describe("faltanDocumentosObligatorios", () => {
  it("cliente PROPIO → nunca exige documentos, aunque no haya ninguno", () => {
    expect(faltanDocumentosObligatorios(TipoCliente.PROPIO, [])).toEqual([]);
  });

  it("SOCIO_LM sin documentos → faltan BL y FACTURA_COMERCIAL", () => {
    expect(faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [])).toEqual([
      CategoriaDocumento.BL,
      CategoriaDocumento.FACTURA_COMERCIAL,
    ]);
  });

  it("SOCIO_LM con solo BL → falta FACTURA_COMERCIAL", () => {
    expect(
      faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [CategoriaDocumento.BL]),
    ).toEqual([CategoriaDocumento.FACTURA_COMERCIAL]);
  });

  it("SOCIO_LM con solo FACTURA_COMERCIAL → falta BL", () => {
    expect(
      faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [
        CategoriaDocumento.FACTURA_COMERCIAL,
      ]),
    ).toEqual([CategoriaDocumento.BL]);
  });

  it("SOCIO_LM con ambos documentos → no falta nada", () => {
    expect(
      faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [
        CategoriaDocumento.BL,
        CategoriaDocumento.FACTURA_COMERCIAL,
        CategoriaDocumento.PACKING_LIST,
      ]),
    ).toEqual([]);
  });

  it("otras categorías presentes no sustituyen a BL/FACTURA_COMERCIAL", () => {
    expect(
      faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [
        CategoriaDocumento.PACKING_LIST,
        CategoriaDocumento.DECLARACION_DIAN,
      ]),
    ).toEqual([CategoriaDocumento.BL, CategoriaDocumento.FACTURA_COMERCIAL]);
  });
});

/**
 * G6 — alcance configurable (parámetro DOCUMENTOS_OBLIGATORIOS_ALCANCE).
 * Guillermo pidió en la reunión del 1-jul extender la exigencia a todos los
 * clientes ("Sí, para todos"). Se implementó como interruptor para que Galcomex
 * lo active cuando decida, sin frenar de golpe el trabajo de Camila.
 */
describe("faltanDocumentosObligatorios — alcance TODOS los clientes", () => {
  it("con el alcance ampliado, un cliente PROPIO sin documentos sí los exige", () => {
    expect(faltanDocumentosObligatorios(TipoCliente.PROPIO, [], true)).toEqual([
      CategoriaDocumento.BL,
      CategoriaDocumento.FACTURA_COMERCIAL,
    ]);
  });

  it("con el alcance ampliado, un cliente PROPIO completo no exige nada", () => {
    expect(
      faltanDocumentosObligatorios(
        TipoCliente.PROPIO,
        [CategoriaDocumento.BL, CategoriaDocumento.FACTURA_COMERCIAL],
        true,
      ),
    ).toEqual([]);
  });

  it("el alcance ampliado no relaja lo que ya se exigía a SOCIO_LM", () => {
    expect(faltanDocumentosObligatorios(TipoCliente.SOCIO_LM, [], true)).toEqual([
      CategoriaDocumento.BL,
      CategoriaDocumento.FACTURA_COMERCIAL,
    ]);
  });

  it("el default (sin tercer argumento) deja fuera a los clientes PROPIO", () => {
    // Este es el comportamiento vigente hoy: omitir el parámetro NO debe
    // endurecer la regla por accidente.
    expect(faltanDocumentosObligatorios(TipoCliente.PROPIO, [])).toEqual([]);
  });
});
