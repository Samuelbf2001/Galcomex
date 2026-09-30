/**
 * Exportación por ciudad (decisión de Ernesto confirmada por María Camila,
 * 30-sep-2026). Los cinco contadores de Camila:
 *   1. Importación Barranquilla + Bogotá + Buenaventura juntos
 *   2. Exportación Barranquilla (+ Bogotá y Buenaventura: supuesto nuestro)
 *   3. Importación Cartagena aparte
 *   4. Exportación Cartagena aparte (prefijo provisional DO.EXP.CTG)
 *   5. Importación Santa Marta aparte
 *   (+ Exportación Santa Marta aparte: supuesto nuestro, DO.EXP.SMR)
 * y la validación que impide que dos contadores impriman el mismo número.
 * Puro, sin BD.
 */
import { describe, expect, it } from "vitest";

import {
  alcanceContador,
  choquesDeNumeracion,
  claveSecuencia,
  contadorSinAnio,
  etiquetaContador,
  filtroSecuencia,
  formatConsecutivo,
  patronesDeNumeracion,
  prefijoDeCiudad,
  prefijosPorCiudad,
  problemasDelContador,
  problemasDeNumeracion,
  raizConsecutivo,
  validarConfigContador,
  type ConfigConsecutivo,
} from "@/lib/tramites/consecutivo";

const CIUDADES = ["BAQ", "CTG", "BUN", "SMR", "BGT"] as const;

const IMPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO",
  secuenciaPor: "CIUDAD_ANIO",
  incluyeCiudadEnConsecutivo: true,
  ciudadesContadorComun: ["BAQ", "BGT", "BUN"],
  prefijoConsecutivoPorCiudad: {},
};

const EXPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO.EXP",
  secuenciaPor: "CIUDAD_ANIO",
  incluyeCiudadEnConsecutivo: false,
  ciudadesContadorComun: ["BAQ", "BGT", "BUN"],
  prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CTG", SMR: "DO.EXP.SMR" },
};

const CLASIFICACION: ConfigConsecutivo = {
  prefijoConsecutivo: "CLAS",
  secuenciaPor: "ANIO",
  incluyeCiudadEnConsecutivo: false,
};

const OTRO: ConfigConsecutivo = {
  prefijoConsecutivo: "OTR",
  secuenciaPor: "ANIO",
  incluyeCiudadEnConsecutivo: false,
};

const CATALOGO = [
  { codigo: "IMPORTACION", ...IMPORTACION },
  { codigo: "EXPORTACION", ...EXPORTACION },
  { codigo: "CLASIFICACION", ...CLASIFICACION },
  { codigo: "OTRO", ...OTRO },
];

const NOMBRE_CIUDAD: Record<string, string> = {
  BAQ: "Barranquilla",
  BGT: "Bogotá",
  BUN: "Buenaventura",
  CTG: "Cartagena",
  SMR: "Santa Marta",
};
const nombre = (c: string) => NOMBRE_CIUDAD[c] ?? c;

describe("formato de los cinco contadores (y Santa Marta exportación)", () => {
  it.each([
    ["1 · Importación BAQ", IMPORTACION, "BAQ", 282, "DO.BAQ26-0282"],
    ["1 · Importación BGT (mismo contador)", IMPORTACION, "BGT", 283, "DO.BGT26-0283"],
    ["1 · Importación BUN (mismo contador)", IMPORTACION, "BUN", 284, "DO.BUN26-0284"],
    ["2 · Exportación BAQ", EXPORTACION, "BAQ", 13, "DO.EXP26-0013"],
    ["2 · Exportación BGT (con Barranquilla)", EXPORTACION, "BGT", 14, "DO.EXP26-0014"],
    ["2 · Exportación BUN (con Barranquilla)", EXPORTACION, "BUN", 15, "DO.EXP26-0015"],
    ["3 · Importación CTG", IMPORTACION, "CTG", 249, "DO.CTG26-0249"],
    ["4 · Exportación CTG", EXPORTACION, "CTG", 1, "DO.EXP.CTG26-0001"],
    ["5 · Importación SMR", IMPORTACION, "SMR", 2, "DO.SMR26-0002"],
    ["+ · Exportación SMR", EXPORTACION, "SMR", 1, "DO.EXP.SMR26-0001"],
  ] as const)("%s → %s", (_caso, config, ciudad, numero, esperado) => {
    expect(formatConsecutivo(config, ciudad, 2026, numero)).toBe(esperado);
  });

  it("Exportación de Barranquilla sale EXACTAMENTE como las carpetas de Camila", () => {
    for (let n = 1; n <= 12; n += 1) {
      expect(formatConsecutivo(EXPORTACION, "BAQ", 2026, n)).toBe(`DO.EXP26-${String(n).padStart(4, "0")}`);
    }
  });

  it("el prefijo por ciudad no se trunca ni cambia el año ni el relleno", () => {
    expect(formatConsecutivo(EXPORTACION, "CTG", 2027, 12_345)).toBe("DO.EXP.CTG27-12345");
  });

  it("el prefijo por ciudad solo cuenta en un contador por ciudad y año", () => {
    const porAnio: ConfigConsecutivo = { ...OTRO, prefijoConsecutivoPorCiudad: { CTG: "OTR.CTG" } };
    expect(prefijoDeCiudad(porAnio, "CTG")).toBe("OTR");
    expect(formatConsecutivo(porAnio, "CTG", 2026, 1)).toBe("OTR26-0001");
  });

  it("raíz del consecutivo (lo que va antes del año)", () => {
    expect(raizConsecutivo(IMPORTACION, "CTG")).toBe("DO.CTG");
    expect(raizConsecutivo(EXPORTACION, "BGT")).toBe("DO.EXP");
    expect(raizConsecutivo(EXPORTACION, "CTG")).toBe("DO.EXP.CTG");
    expect(raizConsecutivo(CLASIFICACION, "CTG")).toBe("CLAS");
  });
});

describe("alcance: cinco contadores + Santa Marta exportación, sin mezclarse", () => {
  const claves = (config: ConfigConsecutivo, tipo: string) =>
    Object.fromEntries(CIUDADES.map((c) => [c, alcanceContador(config, tipo, c, 2026).clave]));

  it("Exportación BGT y BUN comparten el contador de Barranquilla; CTG y SMR, cada una el suyo", () => {
    expect(claves(EXPORTACION, "EXPORTACION")).toEqual({
      BAQ: "EXPORTACION:BAQ+BGT+BUN:2026",
      BGT: "EXPORTACION:BAQ+BGT+BUN:2026",
      BUN: "EXPORTACION:BAQ+BGT+BUN:2026",
      CTG: "EXPORTACION:CTG:2026",
      SMR: "EXPORTACION:SMR:2026",
    });
    expect(claveSecuencia(EXPORTACION, "EXPORTACION", "BGT", 2026)).toBe("tramite-do:EXPORTACION:BAQ+BGT+BUN:2026");
    expect(filtroSecuencia(EXPORTACION, "EXPORTACION", "BUN", 2026)).toEqual({
      tipoTramiteCodigo: "EXPORTACION",
      ciudad: { in: ["BAQ", "BGT", "BUN"] },
      anio: 2026,
    });
    expect(filtroSecuencia(EXPORTACION, "EXPORTACION", "CTG", 2026)).toEqual({
      tipoTramiteCodigo: "EXPORTACION",
      ciudad: "CTG",
      anio: 2026,
    });
  });

  it("ningún contador de exportación comparte candado con uno de importación", () => {
    const exportacion = new Set(Object.values(claves(EXPORTACION, "EXPORTACION")));
    for (const clave of Object.values(claves(IMPORTACION, "IMPORTACION"))) {
      expect(exportacion.has(clave)).toBe(false);
    }
    // 3 de importación + 3 de exportación = 6 contadores distintos.
    expect(new Set([...exportacion, ...Object.values(claves(IMPORTACION, "IMPORTACION"))]).size).toBe(6);
  });

  it("etiquetas en español: la exportación nombra el tipo (su número no dice la ciudad)", () => {
    const etiqueta = (config: ConfigConsecutivo, tipo: string, nombreTipo: string, ciudad: string) =>
      etiquetaContador(alcanceContador(config, tipo, ciudad, 2026), nombre, nombreTipo, !config.incluyeCiudadEnConsecutivo);
    expect(etiqueta(EXPORTACION, "EXPORTACION", "Exportación", "BGT")).toBe(
      "contador de exportación Barranquilla, Bogotá y Buenaventura",
    );
    expect(etiqueta(EXPORTACION, "EXPORTACION", "Exportación", "CTG")).toBe("contador de exportación de Cartagena");
    expect(etiqueta(EXPORTACION, "EXPORTACION", "Exportación", "SMR")).toBe("contador de exportación de Santa Marta");
    // La importación, como siempre.
    expect(etiqueta(IMPORTACION, "IMPORTACION", "Trámite de importación", "BUN")).toBe(
      "contador compartido Barranquilla, Bogotá y Buenaventura",
    );
    expect(etiqueta(IMPORTACION, "IMPORTACION", "Trámite de importación", "CTG")).toBe("contador de Cartagena");
  });
});

describe("prefijosPorCiudad (columna Json)", () => {
  it("lee el mapa e ignora lo que no es texto", () => {
    expect(prefijosPorCiudad(EXPORTACION)).toEqual({ CTG: "DO.EXP.CTG", SMR: "DO.EXP.SMR" });
    expect(prefijosPorCiudad({ prefijoConsecutivoPorCiudad: null })).toEqual({});
    expect(prefijosPorCiudad({ prefijoConsecutivoPorCiudad: ["CTG"] })).toEqual({});
    expect(prefijosPorCiudad({ prefijoConsecutivoPorCiudad: { CTG: 5, SMR: "", BUN: "X" } })).toEqual({ BUN: "X" });
    expect(prefijosPorCiudad({})).toEqual({});
  });
});

describe("validarConfigContador: dos contadores nunca imprimen el mismo número", () => {
  it("la configuración de Exportación de producción es válida", () => {
    expect(validarConfigContador(EXPORTACION, CIUDADES)).toBeNull();
    expect(validarConfigContador(IMPORTACION, CIUDADES)).toBeNull();
  });

  it("número sin ciudad y un contador por ciudad con el MISMO prefijo → rechazada", () => {
    const sinPrefijos: ConfigConsecutivo = { ...EXPORTACION, prefijoConsecutivoPorCiudad: {} };
    expect(validarConfigContador(sinPrefijos, CIUDADES)).toMatch(/imprimirían el mismo número.*«DO\.EXP» \+ año/);
  });

  it("falta el prefijo de una sola ciudad (Santa Marta) → rechazada, nombrando las ciudades", () => {
    const sinSantaMarta: ConfigConsecutivo = { ...EXPORTACION, prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CTG" } };
    const error = validarConfigContador(sinSantaMarta, CIUDADES);
    expect(error).toMatch(/SMR/);
    expect(error).toMatch(/BAQ|BGT|BUN/);
  });

  it("dos ciudades con contador propio y el mismo prefijo → rechazada", () => {
    const repetido: ConfigConsecutivo = {
      ...EXPORTACION,
      prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CAR", SMR: "DO.EXP.CAR" },
    };
    expect(validarConfigContador(repetido, CIUDADES)).toMatch(/CTG.*SMR|SMR.*CTG/);
  });

  it("una ciudad con prefijo igual al del grupo → rechazada", () => {
    const igualAlGrupo: ConfigConsecutivo = {
      ...EXPORTACION,
      prefijoConsecutivoPorCiudad: { CTG: "DO.EXP", SMR: "DO.EXP.SMR" },
    };
    expect(validarConfigContador(igualAlGrupo, CIUDADES)).toMatch(/imprimirían el mismo número/);
  });

  it("con la ciudad en el número, contadores por ciudad no chocan aunque compartan prefijo", () => {
    const porCiudad: ConfigConsecutivo = { ...IMPORTACION, ciudadesContadorComun: [] };
    expect(validarConfigContador(porCiudad, CIUDADES)).toBeNull();
  });

  it("dentro de un mismo contador, ciudades con el mismo prefijo son válidas (no hay dos contadores)", () => {
    expect(validarConfigContador({ ...EXPORTACION, ciudadesContadorComun: [...CIUDADES] }, CIUDADES)).toBeNull();
    // Y un contador por año sin ciudad tampoco choca consigo mismo.
    expect(validarConfigContador(OTRO, CIUDADES)).toBeNull();
  });

  it("Bogotá aparte de Barranquilla (supuesto que Camila puede cambiar): válido solo con prefijo propio", () => {
    const bgtAparte: ConfigConsecutivo = { ...EXPORTACION, ciudadesContadorComun: ["BAQ", "BUN"] };
    expect(validarConfigContador(bgtAparte, CIUDADES)).toMatch(/BGT/);
    const conPrefijo: ConfigConsecutivo = {
      ...bgtAparte,
      prefijoConsecutivoPorCiudad: { CTG: "DO.EXP.CTG", SMR: "DO.EXP.SMR", BGT: "DO.EXP.BGT" },
    };
    expect(validarConfigContador(conPrefijo, CIUDADES)).toBeNull();
    expect(formatConsecutivo(conPrefijo, "BGT", 2026, 1)).toBe("DO.EXP.BGT26-0001");
    expect(alcanceContador(conPrefijo, "EXPORTACION", "BGT", 2026).clave).toBe("EXPORTACION:BGT:2026");
  });

  it("Cartagena exporta con Barranquilla (si Camila lo dijera): un solo contador de cuatro ciudades", () => {
    const juntas: ConfigConsecutivo = {
      ...EXPORTACION,
      ciudadesContadorComun: ["BAQ", "BGT", "BUN", "CTG"],
      prefijoConsecutivoPorCiudad: { SMR: "DO.EXP.SMR" },
    };
    expect(validarConfigContador(juntas, CIUDADES)).toBeNull();
    expect(alcanceContador(juntas, "EXPORTACION", "CTG", 2026).clave).toBe("EXPORTACION:BAQ+BGT+BUN+CTG:2026");
  });

  it("mapa de prefijos mal formado → rechazado con un mensaje claro", () => {
    expect(validarConfigContador({ ...EXPORTACION, prefijoConsecutivoPorCiudad: ["DO.EXP.CTG"] }, CIUDADES)).toMatch(
      /mapa ciudad → prefijo/,
    );
    expect(validarConfigContador({ ...EXPORTACION, prefijoConsecutivoPorCiudad: { CTG: "" } }, CIUDADES)).toMatch(
      /prefijo de CTG/,
    );
    expect(
      validarConfigContador({ ...EXPORTACION, prefijoConsecutivoPorCiudad: { CTG: "DO EXP CTG" } }, CIUDADES),
    ).toMatch(/sin espacios/);
    expect(validarConfigContador({ ...EXPORTACION, prefijoConsecutivoPorCiudad: { CTG: 7 } }, CIUDADES)).toMatch(
      /prefijo de CTG/,
    );
    expect(
      validarConfigContador({ ...EXPORTACION, prefijoConsecutivoPorCiudad: { CTGX: "DO.EXP.CTG" } }, CIUDADES),
    ).toMatch(/no existe: CTGX/);
    expect(validarConfigContador({ ...OTRO, prefijoConsecutivoPorCiudad: { CTG: "OTR.CTG" } }, CIUDADES)).toMatch(
      /ciudad y año/,
    );
    expect(validarConfigContador({ ...OTRO, prefijoConsecutivoPorCiudad: {} }, CIUDADES)).toBeNull();
    expect(validarConfigContador({ ...OTRO, prefijoConsecutivoPorCiudad: null }, CIUDADES)).toBeNull();
    expect(validarConfigContador({ ...OTRO, prefijoConsecutivo: "" }, CIUDADES)).toMatch(/no puede estar vacío/);
  });
});

describe("problemasDeNumeracion: choques entre tipos", () => {
  it("el catálogo de producción no tiene problemas", () => {
    expect(problemasDeNumeracion(CATALOGO, CIUDADES)).toEqual([]);
  });

  it("una Exportación de Cartagena con prefijo DO.CTG imprimiría los números de la importación de Cartagena", () => {
    const malo = CATALOGO.map((t) =>
      t.codigo === "EXPORTACION" ? { ...t, prefijoConsecutivoPorCiudad: { CTG: "DO.CTG", SMR: "DO.EXP.SMR" } } : t,
    );
    const problemas = problemasDeNumeracion(malo, CIUDADES);
    expect(problemas).toHaveLength(1);
    expect(problemas[0].tipos.sort()).toEqual(["EXPORTACION", "IMPORTACION"]);
    expect(problemas[0].contadores.sort()).toEqual(["EXPORTACION:CTG", "IMPORTACION:CTG"]);
    expect(problemas[0].mensaje).toMatch(/IMPORTACION CTG.*EXPORTACION CTG|EXPORTACION CTG.*IMPORTACION CTG/);
    expect(problemas[0].mensaje).toMatch(/«DO\.CTG» \+ año/);

    // Solo se frenan los dos contadores que chocan: Barranquilla sigue.
    const de = (tipo: string, ciudad: string) =>
      problemasDelContador(problemas, tipo, contadorSinAnio(tipo === "IMPORTACION" ? IMPORTACION : EXPORTACION, tipo, ciudad));
    expect(de("IMPORTACION", "CTG")).toHaveLength(1);
    expect(de("EXPORTACION", "CTG")).toHaveLength(1);
    expect(de("IMPORTACION", "BAQ")).toEqual([]);
    expect(de("EXPORTACION", "BGT")).toEqual([]);
    expect(de("EXPORTACION", "SMR")).toEqual([]);
  });

  it("dos tipos por año con el mismo prefijo chocan", () => {
    const malo = [...CATALOGO, { codigo: "OTRO_BIS", ...OTRO }];
    const problemas = problemasDeNumeracion(malo, CIUDADES);
    expect(problemas).toHaveLength(1);
    expect(problemas[0].tipos.sort()).toEqual(["OTRO", "OTRO_BIS"]);
  });

  it("un contador global cuyo prefijo termina en dos dígitos choca con uno por año (PV26-0001 = PV + 26 + 0001)", () => {
    const global = { codigo: "PLAN_VALLEJO", prefijoConsecutivo: "OTR26", secuenciaPor: "GLOBAL" as const, incluyeCiudadEnConsecutivo: false };
    expect(problemasDeNumeracion([...CATALOGO, global], CIUDADES).map((p) => p.tipos.sort())).toEqual([
      ["OTRO", "PLAN_VALLEJO"],
    ]);
    const sinChoque = { ...global, prefijoConsecutivo: "PV" };
    expect(problemasDeNumeracion([...CATALOGO, sinChoque], CIUDADES)).toEqual([]);
  });

  it("un tipo mal configurado se reporta solo a él y no tapa los demás", () => {
    const malo = CATALOGO.map((t) =>
      t.codigo === "EXPORTACION" ? { ...t, prefijoConsecutivoPorCiudad: {} } : t,
    );
    const problemas = problemasDeNumeracion(malo, CIUDADES);
    expect(problemas).toHaveLength(1);
    expect(problemas[0].tipos).toEqual(["EXPORTACION"]);
    // Vacío = todo el tipo: su propia configuración está mal.
    expect(problemas[0].contadores).toEqual([]);
    expect(problemas[0].mensaje).toMatch(/^EXPORTACION: /);
    expect(problemasDelContador(problemas, "EXPORTACION", "EXPORTACION:BAQ+BGT+BUN")).toHaveLength(1);
    expect(problemasDelContador(problemas, "IMPORTACION", "IMPORTACION:BAQ+BGT+BUN")).toEqual([]);
  });

  it("contadorSinAnio: la clave del contador sin el año", () => {
    expect(contadorSinAnio(EXPORTACION, "EXPORTACION", "BUN")).toBe("EXPORTACION:BAQ+BGT+BUN");
    expect(contadorSinAnio(EXPORTACION, "EXPORTACION", "SMR")).toBe("EXPORTACION:SMR");
    expect(contadorSinAnio(OTRO, "OTRO", "CTG")).toBe("OTRO");
  });

  it("patrones y choques: la base de la validación", () => {
    const patrones = patronesDeNumeracion(EXPORTACION, "EXPORTACION", CIUDADES);
    expect(patrones.map((p) => [p.ciudad, p.contador, p.raiz])).toEqual([
      ["BAQ", "EXPORTACION:BAQ+BGT+BUN", "DO.EXP"],
      ["CTG", "EXPORTACION:CTG", "DO.EXP.CTG"],
      ["BUN", "EXPORTACION:BAQ+BGT+BUN", "DO.EXP"],
      ["SMR", "EXPORTACION:SMR", "DO.EXP.SMR"],
      ["BGT", "EXPORTACION:BAQ+BGT+BUN", "DO.EXP"],
    ]);
    expect(choquesDeNumeracion(patrones)).toEqual([]);
  });
});
