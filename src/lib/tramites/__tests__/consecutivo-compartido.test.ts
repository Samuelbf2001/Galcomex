/**
 * Numeración como Camila (DISENO-NUMERACION.md §2.1, decisión de Ernesto
 * 30-sep-2026): Barranquilla, Bogotá y Buenaventura comparten UN contador;
 * Cartagena y Santa Marta llevan cada una el suyo; Exportación tiene su serie
 * DO.EXP26 sin ciudad. Casos 1–3 del §8. Puro, sin BD.
 */
import { describe, expect, it } from "vitest";

import {
  alcanceContador,
  claveSecuencia,
  etiquetaContador,
  filtroDeAlcance,
  filtroSecuencia,
  formatConsecutivo,
  siguienteNumero,
  validarConfigContador,
  type ConfigConsecutivo,
} from "@/lib/tramites/consecutivo";

const IMPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO",
  secuenciaPor: "CIUDAD_ANIO",
  incluyeCiudadEnConsecutivo: true,
  ciudadesContadorComun: ["BAQ", "BGT", "BUN"],
};

const OTRO: ConfigConsecutivo = {
  prefijoConsecutivo: "OTR",
  secuenciaPor: "ANIO",
  incluyeCiudadEnConsecutivo: false,
};

const EXPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO.EXP",
  secuenciaPor: "ANIO",
  incluyeCiudadEnConsecutivo: false,
  ciudadesContadorComun: [],
};

const PLAN_VALLEJO: ConfigConsecutivo = {
  prefijoConsecutivo: "PV",
  secuenciaPor: "GLOBAL",
  incluyeCiudadEnConsecutivo: false,
};

describe("caso 1 — clave del contador", () => {
  it("BAQ, BGT y BUN dan la MISMA clave (ciudades en orden alfabético)", () => {
    for (const ciudad of ["BAQ", "BGT", "BUN"]) {
      expect(alcanceContador(IMPORTACION, "IMPORTACION", ciudad, 2026).clave).toBe(
        "IMPORTACION:BAQ+BGT+BUN:2026",
      );
      expect(claveSecuencia(IMPORTACION, "IMPORTACION", ciudad, 2026)).toBe(
        "tramite-do:IMPORTACION:BAQ+BGT+BUN:2026",
      );
    }
  });

  it("el orden de la lista no cambia la clave", () => {
    const desordenada: ConfigConsecutivo = { ...IMPORTACION, ciudadesContadorComun: ["BUN", "BAQ", "BGT"] };
    expect(alcanceContador(desordenada, "IMPORTACION", "BGT", 2026).clave).toBe("IMPORTACION:BAQ+BGT+BUN:2026");
  });

  it("CTG y SMR llevan cada una el suyo, con el MISMO candado de antes", () => {
    expect(alcanceContador(IMPORTACION, "IMPORTACION", "CTG", 2026).clave).toBe("IMPORTACION:CTG:2026");
    expect(claveSecuencia(IMPORTACION, "IMPORTACION", "CTG", 2026)).toBe("tramite-do:IMPORTACION:CTG:2026");
    expect(alcanceContador(IMPORTACION, "IMPORTACION", "SMR", 2026).clave).toBe("IMPORTACION:SMR:2026");
  });

  it("OTRO, EXPORTACION y GLOBAL: clave y candado de siempre", () => {
    expect(alcanceContador(OTRO, "OTRO", "BAQ", 2026).clave).toBe("OTRO:2026");
    expect(claveSecuencia(OTRO, "OTRO", "BAQ", 2026)).toBe("tramite-do:OTRO:2026");
    expect(alcanceContador(EXPORTACION, "EXPORTACION", "BAQ", 2026).clave).toBe("EXPORTACION:2026");
    expect(alcanceContador(PLAN_VALLEJO, "PLAN_VALLEJO", "BAQ", 2026).clave).toBe("PLAN_VALLEJO");
    expect(claveSecuencia(PLAN_VALLEJO, "PLAN_VALLEJO", "BAQ", 2026)).toBe("tramite-do:PLAN_VALLEJO");
  });

  it("el filtro del grupo busca en las tres ciudades; el de CTG solo en CTG", () => {
    expect(filtroSecuencia(IMPORTACION, "IMPORTACION", "BGT", 2026)).toEqual({
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: { in: ["BAQ", "BGT", "BUN"] },
      anio: 2026,
    });
    expect(filtroSecuencia(IMPORTACION, "IMPORTACION", "CTG", 2026)).toEqual({
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: "CTG",
      anio: 2026,
    });
    expect(filtroDeAlcance("EXPORTACION", alcanceContador(EXPORTACION, "EXPORTACION", "BAQ", 2026))).toEqual({
      tipoTramiteCodigo: "EXPORTACION",
      anio: 2026,
    });
  });
});

describe("caso 2 — siguienteNumero = max(último, piso) + 1", () => {
  it.each([
    [281, null, 282],
    [null, 12, 13],
    [300, 12, 301],
    [null, null, 1],
    [5, 300, 301],
  ])("(%s, %s) → %s", (ultimo, piso, esperado) => {
    expect(siguienteNumero(ultimo, piso)).toBe(esperado);
  });
});

describe("caso 3 — formato", () => {
  it("EXPORTACION con 13 → DO.EXP26-0013", () => {
    expect(formatConsecutivo(EXPORTACION, "BAQ", 2026, 13)).toBe("DO.EXP26-0013");
  });

  it("el número del grupo se sigue imprimiendo con la ciudad del DO", () => {
    expect(formatConsecutivo(IMPORTACION, "BGT", 2026, 282)).toBe("DO.BGT26-0282");
    expect(formatConsecutivo(IMPORTACION, "BUN", 2026, 283)).toBe("DO.BUN26-0283");
    expect(formatConsecutivo(IMPORTACION, "BAQ", 2026, 284)).toBe("DO.BAQ26-0284");
  });
});

describe("validarConfigContador y etiqueta", () => {
  it("ciudades comunes solo con CIUDAD_ANIO y sin repetidas", () => {
    expect(validarConfigContador(IMPORTACION)).toBeNull();
    expect(validarConfigContador(OTRO)).toBeNull();
    expect(validarConfigContador({ ...OTRO, ciudadesContadorComun: ["BAQ"] })).toMatch(/ciudad y año/);
    expect(validarConfigContador({ ...IMPORTACION, ciudadesContadorComun: ["BAQ", "BAQ"] })).toMatch(/repetidas/);
  });

  it("etiqueta del contador para la pantalla", () => {
    const nombre = (c: string) => ({ BAQ: "Barranquilla", BGT: "Bogotá", BUN: "Buenaventura", CTG: "Cartagena" })[c] ?? c;
    expect(etiquetaContador(alcanceContador(IMPORTACION, "IMPORTACION", "BGT", 2026), nombre, "Exportación")).toBe(
      "contador compartido Barranquilla, Bogotá y Buenaventura",
    );
    expect(etiquetaContador(alcanceContador(IMPORTACION, "IMPORTACION", "CTG", 2026), nombre, "Importación")).toBe(
      "contador de Cartagena",
    );
    expect(etiquetaContador(alcanceContador(EXPORTACION, "EXPORTACION", "BAQ", 2026), nombre, "Exportaciones")).toBe(
      "contador de exportaciones",
    );
  });
});
