import { describe, expect, it } from "vitest";

import {
  claveSecuencia,
  filtroSecuencia,
  formatConsecutivo,
  type ConfigConsecutivo,
} from "@/lib/tramites/consecutivo";

const IMPORTACION: ConfigConsecutivo = {
  prefijoConsecutivo: "DO",
  secuenciaPor: "CIUDAD_ANIO",
  incluyeCiudadEnConsecutivo: true,
};

const CLASIFICACION: ConfigConsecutivo = {
  prefijoConsecutivo: "CLAS",
  secuenciaPor: "ANIO",
  incluyeCiudadEnConsecutivo: false,
};

const PLAN_VALLEJO: ConfigConsecutivo = {
  prefijoConsecutivo: "PV",
  secuenciaPor: "GLOBAL",
  incluyeCiudadEnConsecutivo: false,
};

describe("formatConsecutivo", () => {
  it("reproduce EXACTAMENTE el formato histórico de importación", () => {
    expect(formatConsecutivo(IMPORTACION, "BAQ", 2026, 1)).toBe("DO.BAQ26-0001");
    expect(formatConsecutivo(IMPORTACION, "CTG", 2026, 124)).toBe("DO.CTG26-0124");
    expect(formatConsecutivo(IMPORTACION, "BUN", 2026, 26)).toBe("DO.BUN26-0026");
  });

  it("numera la clasificación por año y sin ciudad", () => {
    expect(formatConsecutivo(CLASIFICACION, "BAQ", 2026, 1)).toBe("CLAS26-0001");
    expect(formatConsecutivo(CLASIFICACION, "CTG", 2026, 47)).toBe("CLAS26-0047");
  });

  it("omite año y ciudad cuando el contador es global", () => {
    expect(formatConsecutivo(PLAN_VALLEJO, "BAQ", 2026, 3)).toBe("PV-0003");
  });

  it("no trunca números de más de cuatro dígitos", () => {
    expect(formatConsecutivo(IMPORTACION, "BAQ", 2026, 12_345)).toBe("DO.BAQ26-12345");
  });

  it("usa los dos últimos dígitos del año", () => {
    expect(formatConsecutivo(IMPORTACION, "BAQ", 2027, 1)).toBe("DO.BAQ27-0001");
    expect(formatConsecutivo(CLASIFICACION, "BAQ", 2030, 1)).toBe("CLAS30-0001");
  });
});

describe("alcance del contador", () => {
  it("la clave del lock y el filtro cubren el mismo alcance", () => {
    expect(claveSecuencia(IMPORTACION, "IMPORTACION", "BAQ", 2026)).toBe(
      "tramite-do:IMPORTACION:BAQ:2026",
    );
    expect(filtroSecuencia(IMPORTACION, "IMPORTACION", "BAQ", 2026)).toEqual({
      tipoTramiteCodigo: "IMPORTACION",
      ciudad: "BAQ",
      anio: 2026,
    });

    expect(claveSecuencia(CLASIFICACION, "CLASIFICACION", "BAQ", 2026)).toBe(
      "tramite-do:CLASIFICACION:2026",
    );
    expect(filtroSecuencia(CLASIFICACION, "CLASIFICACION", "BAQ", 2026)).toEqual({
      tipoTramiteCodigo: "CLASIFICACION",
      anio: 2026,
    });

    expect(claveSecuencia(PLAN_VALLEJO, "PLAN_VALLEJO", "BAQ", 2026)).toBe(
      "tramite-do:PLAN_VALLEJO",
    );
    expect(filtroSecuencia(PLAN_VALLEJO, "PLAN_VALLEJO", "BAQ", 2026)).toEqual({
      tipoTramiteCodigo: "PLAN_VALLEJO",
    });
  });

  it("la clasificación no comparte contador con la importación", () => {
    expect(claveSecuencia(IMPORTACION, "IMPORTACION", "BAQ", 2026)).not.toBe(
      claveSecuencia(CLASIFICACION, "CLASIFICACION", "BAQ", 2026),
    );
  });

  it("dos ciudades distintas no comparten contador en importación", () => {
    expect(claveSecuencia(IMPORTACION, "IMPORTACION", "BAQ", 2026)).not.toBe(
      claveSecuencia(IMPORTACION, "IMPORTACION", "CTG", 2026),
    );
  });

  it("dos ciudades distintas SÍ comparten contador en clasificación", () => {
    expect(claveSecuencia(CLASIFICACION, "CLASIFICACION", "BAQ", 2026)).toBe(
      claveSecuencia(CLASIFICACION, "CLASIFICACION", "CTG", 2026),
    );
  });
});
