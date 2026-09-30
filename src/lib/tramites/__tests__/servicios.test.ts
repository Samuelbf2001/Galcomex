/**
 * Servicio dentro del trámite normal (DISENO-NUMERACION.md §2.2, decisión de
 * Ernesto 30-sep-2026). Casos 10–11 del §8. Puro, sin BD.
 */
import { describe, expect, it } from "vitest";

import {
  conceptosReservados,
  reglaServicioDeAlcance,
  resolverServicio,
  ServicioFlujoCortoNoPermitidoError,
  ServicioNoPermitidoError,
  ServicioReservadoError,
  serviciosDeTipo,
  validarCatalogoServicios,
  type ServicioCatalogo,
  type TipoParaServicio,
} from "@/lib/tramites/servicios";

const IMPORTACION: TipoParaServicio = {
  codigo: "IMPORTACION",
  nombre: "Trámite de importación",
  lineaServicio: "TRAMITE",
  flujoCorto: false,
};
const EXPORTACION: TipoParaServicio = {
  codigo: "EXPORTACION",
  nombre: "Exportación",
  lineaServicio: "EXPORTACION",
  flujoCorto: true,
};
const OTRO: TipoParaServicio = { codigo: "OTRO", nombre: "Otros servicios", lineaServicio: "OTROS", flujoCorto: true };
const CLASIFICACION: TipoParaServicio = {
  codigo: "CLASIFICACION",
  nombre: "Clasificación arancelaria",
  lineaServicio: "CLASIFICACION",
  flujoCorto: false,
};
const TIPOS = [IMPORTACION, EXPORTACION, OTRO, CLASIFICACION];

/** El catálogo que siembran las migraciones 20260930100100 y 20260930100200. */
const CATALOGO: ServicioCatalogo[] = [
  {
    id: "servicio-importacion-general",
    tipoTramiteCodigo: "IMPORTACION",
    conceptoCodigo: null,
    nombre: "Importación (tarifa general de la empresa)",
    tarifaGeneral: true,
    documentosNoAplican: [],
    orden: 10,
  },
  {
    id: "servicio-importacion-traslado-zf",
    tipoTramiteCodigo: "IMPORTACION",
    conceptoCodigo: "TRASLADO_ZF",
    nombre: "Traslado de zona franca",
    tarifaGeneral: false,
    documentosNoAplican: [],
    orden: 20,
  },
  {
    id: "servicio-importacion-nacionalizacion-zf",
    tipoTramiteCodigo: "IMPORTACION",
    conceptoCodigo: "NACIONALIZACION_ZF",
    nombre: "Nacionalización desde zona franca",
    tarifaGeneral: false,
    documentosNoAplican: ["BL"],
    orden: 30,
  },
  {
    id: "servicio-importacion-duta",
    tipoTramiteCodigo: "IMPORTACION",
    conceptoCodigo: "DUTA",
    nombre: "DUTA (tránsito aduanero)",
    tarifaGeneral: false,
    documentosNoAplican: [],
    orden: 40,
  },
  {
    id: "servicio-exportacion-general",
    tipoTramiteCodigo: "EXPORTACION",
    conceptoCodigo: "EXPORTACION",
    nombre: "Exportación",
    tarifaGeneral: true,
    documentosNoAplican: [],
    orden: 10,
  },
];

describe("caso 10 — resolverServicio (tabla §2.2.2)", () => {
  it("IMPORTACION sin concepto → guarda null, tarifa general", () => {
    const r = resolverServicio(IMPORTACION, CATALOGO, null, TIPOS);
    expect(r).toMatchObject({ conceptoGuardado: null, claveTarifa: null, faltaServicio: false, documentosNoAplican: [] });
    expect(r.servicio?.id).toBe("servicio-importacion-general");
    expect(resolverServicio(IMPORTACION, CATALOGO, "  ", TIPOS).conceptoGuardado).toBeNull();
  });

  it.each([
    ["TRASLADO_ZF", []],
    ["NACIONALIZACION_ZF", ["BL"]],
    ["DUTA", []],
  ])("IMPORTACION + %s → guarda y busca la tarifa de ese servicio", (concepto, noAplican) => {
    const r = resolverServicio(IMPORTACION, CATALOGO, concepto, TIPOS);
    expect(r.conceptoGuardado).toBe(concepto);
    expect(r.claveTarifa).toBe(concepto);
    expect(r.documentosNoAplican).toEqual(noAplican);
  });

  it("IMPORTACION + PLAN_VALLEJO → 422 SERVICIO_NO_PERMITIDO con la lista de servicios", () => {
    let error: unknown;
    try {
      resolverServicio(IMPORTACION, CATALOGO, "PLAN_VALLEJO", TIPOS);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServicioNoPermitidoError);
    expect(error).toMatchObject({ status: 422, codigo: "SERVICIO_NO_PERMITIDO" });
    expect((error as Error).message).toBe(
      "Los servicios de Trámite de importación son: Importación, Traslado de zona franca, Nacionalización desde zona franca y DUTA.",
    );
  });

  it("EXPORTACION vacío o EXPORTACION → guarda EXPORTACION, tarifa general; otro → 422", () => {
    for (const concepto of [null, "EXPORTACION"]) {
      const r = resolverServicio(EXPORTACION, CATALOGO, concepto, TIPOS);
      expect(r).toMatchObject({ conceptoGuardado: "EXPORTACION", claveTarifa: null, faltaServicio: false });
    }
    expect(() => resolverServicio(EXPORTACION, CATALOGO, "DUTA", TIPOS)).toThrow(ServicioNoPermitidoError);
  });

  it("OTRO (sin catálogo, flujo corto): el concepto es la clave (B2); vacío = falta el servicio", () => {
    expect(resolverServicio(OTRO, CATALOGO, "PLAN_VALLEJO", TIPOS)).toMatchObject({
      conceptoGuardado: "PLAN_VALLEJO",
      claveTarifa: "PLAN_VALLEJO",
      faltaServicio: false,
      servicio: null,
    });
    expect(resolverServicio(OTRO, CATALOGO, "COMISION_CONTENEDOR", TIPOS).claveTarifa).toBe("COMISION_CONTENEDOR");
    expect(resolverServicio(OTRO, CATALOGO, null, TIPOS)).toMatchObject({
      conceptoGuardado: null,
      claveTarifa: null,
      faltaServicio: true,
    });
  });

  it.each(["TRASLADO_ZF", "NACIONALIZACION_ZF", "DUTA", "EXPORTACION"])(
    "OTRO + %s → 422 SERVICIO_RESERVADO",
    (concepto) => {
      expect(() => resolverServicio(OTRO, CATALOGO, concepto, TIPOS)).toThrow(ServicioReservadoError);
      try {
        resolverServicio(OTRO, CATALOGO, concepto, TIPOS);
      } catch (e) {
        expect(e).toMatchObject({ status: 422, codigo: "SERVICIO_RESERVADO" });
        expect((e as Error).message).toMatch(/se crea como (Trámite de importación|Exportación) con ese servicio, no como Otros servicios/);
      }
    },
  );

  it("CLASIFICACION: vacío = sin servicio; cualquiera → el error de siempre", () => {
    expect(resolverServicio(CLASIFICACION, CATALOGO, null, TIPOS)).toMatchObject({
      conceptoGuardado: null,
      claveTarifa: null,
      faltaServicio: false,
    });
    expect(() => resolverServicio(CLASIFICACION, CATALOGO, "PLAN_VALLEJO", TIPOS)).toThrow(
      ServicioFlujoCortoNoPermitidoError,
    );
  });

  it("un servicio inactivo no se puede escoger", () => {
    const sinDuta = CATALOGO.map((s) => (s.conceptoCodigo === "DUTA" ? { ...s, activo: false } : s));
    expect(() => resolverServicio(IMPORTACION, sinDuta, "DUTA", TIPOS)).toThrow(ServicioNoPermitidoError);
  });
});

describe("caso 11 — reglaServicioDeAlcance (§2.2.3)", () => {
  it("OTROS: obligatorio, sin los reservados", () => {
    const regla = reglaServicioDeAlcance("OTROS", TIPOS, CATALOGO);
    expect(regla.modo).toBe("OBLIGATORIO");
    if (regla.modo === "OBLIGATORIO") {
      expect(regla.reservados.sort()).toEqual(["DUTA", "EXPORTACION", "NACIONALIZACION_ZF", "TRASLADO_ZF"]);
    }
  });

  it("TRAMITE: opcional, con traslado, nacionalización y DUTA (vacío = tarifa general)", () => {
    const regla = reglaServicioDeAlcance("TRAMITE", TIPOS, CATALOGO);
    expect(regla.modo).toBe("OPCIONAL");
    if (regla.modo === "OPCIONAL") {
      expect(regla.permitidos.map((s) => s.conceptoCodigo)).toEqual(["TRASLADO_ZF", "NACIONALIZACION_ZF", "DUTA"]);
    }
  });

  it("EXPORTACION, CLASIFICACION, PLAN_VALLEJO: sin servicio", () => {
    expect(reglaServicioDeAlcance("EXPORTACION", TIPOS, CATALOGO).modo).toBe("NINGUNO");
    expect(reglaServicioDeAlcance("CLASIFICACION", TIPOS, CATALOGO).modo).toBe("NINGUNO");
    expect(reglaServicioDeAlcance("PLAN_VALLEJO", TIPOS, CATALOGO).modo).toBe("NINGUNO");
  });

  it("sin catálogo (antes del 30-sep) la regla es la de B2: TRAMITE sin servicio, OTROS obligatorio", () => {
    expect(reglaServicioDeAlcance("TRAMITE", TIPOS, []).modo).toBe("NINGUNO");
    expect(reglaServicioDeAlcance("OTROS", TIPOS, [])).toEqual({ modo: "OBLIGATORIO", reservados: [] });
  });
});

describe("catálogo", () => {
  it("el catálogo sembrado es válido y ordenado", () => {
    expect(validarCatalogoServicios(CATALOGO)).toEqual([]);
    expect(serviciosDeTipo(CATALOGO, "IMPORTACION").map((s) => s.orden)).toEqual([10, 20, 30, 40]);
    expect(serviciosDeTipo(CATALOGO, "OTRO")).toEqual([]);
    expect([...conceptosReservados(CATALOGO).keys()].sort()).toEqual([
      "DUTA",
      "EXPORTACION",
      "NACIONALIZACION_ZF",
      "TRASLADO_ZF",
    ]);
  });

  it("detecta dos tarifas generales, un servicio sin concepto que no es general y conceptos repetidos", () => {
    const malo: ServicioCatalogo[] = [
      ...CATALOGO,
      { ...CATALOGO[0], id: "otro-general" },
      { ...CATALOGO[1], id: "sin-concepto", conceptoCodigo: null },
      { ...CATALOGO[3], id: "duta-exportacion", tipoTramiteCodigo: "EXPORTACION", tarifaGeneral: false },
    ];
    const errores = validarCatalogoServicios(malo);
    expect(errores.some((e) => e.includes("más de un servicio de tarifa general"))).toBe(true);
    expect(errores.some((e) => e.includes("sin-concepto"))).toBe(true);
    expect(errores.some((e) => e.includes("DUTA está en dos servicios"))).toBe(true);
  });
});
