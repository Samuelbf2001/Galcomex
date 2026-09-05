import { describe, expect, it } from "vitest";

import { CAPACIDADES, esCodigoCapacidad } from "@/lib/capacidades/catalogo";
import {
  capacidadesActivas,
  configDe,
  resolverCapacidades,
  tiene,
  type DefinicionResoluble,
} from "@/lib/capacidades/resolver";

const DEFS: DefinicionResoluble[] = [
  { codigo: "anticipos_cliente", porDefecto: true, configPorDefecto: null },
  { codigo: "tarifario_propio", porDefecto: false, configPorDefecto: null },
  {
    codigo: "comision_por_evento",
    porDefecto: false,
    configPorDefecto: { unidad: "CONTENEDOR", valor: "0" },
  },
];

describe("resolverCapacidades — cascada", () => {
  it("sin overrides devuelve los valores por defecto del catálogo", () => {
    const mapa = resolverCapacidades(DEFS);

    expect(tiene(mapa, "anticipos_cliente")).toBe(true);
    expect(tiene(mapa, "tarifario_propio")).toBe(false);
    expect(mapa.get("anticipos_cliente")?.origenHabilitado).toBe("DEFECTO");
  });

  it("el grupo económico gana sobre el defecto", () => {
    const mapa = resolverCapacidades(DEFS, [
      { codigo: "tarifario_propio", habilitado: true },
    ]);

    expect(tiene(mapa, "tarifario_propio")).toBe(true);
    expect(mapa.get("tarifario_propio")?.origenHabilitado).toBe("GRUPO");
  });

  it("la empresa gana sobre el grupo", () => {
    const mapa = resolverCapacidades(
      DEFS,
      [{ codigo: "tarifario_propio", habilitado: true }],
      [{ codigo: "tarifario_propio", habilitado: false }],
    );

    expect(tiene(mapa, "tarifario_propio")).toBe(false);
    expect(mapa.get("tarifario_propio")?.origenHabilitado).toBe("EMPRESA");
  });

  it("la empresa puede apagar una capacidad encendida por defecto", () => {
    const mapa = resolverCapacidades(DEFS, [], [
      { codigo: "anticipos_cliente", habilitado: false },
    ]);

    expect(tiene(mapa, "anticipos_cliente")).toBe(false);
  });
});

describe("resolverCapacidades — habilitado y config son independientes", () => {
  it("la empresa enciende y hereda la config del grupo", () => {
    const mapa = resolverCapacidades(
      DEFS,
      [{ codigo: "comision_por_evento", config: { unidad: "CONTENEDOR", valor: "45000" } }],
      [{ codigo: "comision_por_evento", habilitado: true }],
    );

    const resuelta = mapa.get("comision_por_evento");

    expect(resuelta?.habilitado).toBe(true);
    expect(resuelta?.origenHabilitado).toBe("EMPRESA");
    expect(resuelta?.config).toEqual({ unidad: "CONTENEDOR", valor: "45000" });
    expect(resuelta?.origenConfig).toBe("GRUPO");
  });

  it("la config de la empresa gana sobre la del grupo", () => {
    const mapa = resolverCapacidades(
      DEFS,
      [{ codigo: "comision_por_evento", habilitado: true, config: { valor: "45000" } }],
      [{ codigo: "comision_por_evento", config: { valor: "60000" } }],
    );

    expect(configDe(mapa, "comision_por_evento")).toEqual({ valor: "60000" });
    expect(mapa.get("comision_por_evento")?.origenConfig).toBe("EMPRESA");
  });

  it("un override que no opina sobre la config conserva la del catálogo", () => {
    const mapa = resolverCapacidades(DEFS, [], [
      { codigo: "comision_por_evento", habilitado: true },
    ]);

    expect(configDe(mapa, "comision_por_evento")).toEqual({
      unidad: "CONTENEDOR",
      valor: "0",
    });
  });
});

describe("configDe", () => {
  it("devuelve null si la capacidad está apagada, aunque tenga config", () => {
    const mapa = resolverCapacidades(DEFS, [], [
      { codigo: "comision_por_evento", habilitado: false, config: { valor: "60000" } },
    ]);

    expect(configDe(mapa, "comision_por_evento")).toBeNull();
  });

  it("devuelve null para un código desconocido", () => {
    const mapa = resolverCapacidades(DEFS);

    expect(configDe(mapa, "no_existe")).toBeNull();
    expect(tiene(mapa, "no_existe")).toBe(false);
  });
});

describe("resolverCapacidades — bordes", () => {
  it("ignora overrides de capacidades que no están en el catálogo", () => {
    const mapa = resolverCapacidades(DEFS, [], [
      { codigo: "capacidad_retirada", habilitado: true },
    ]);

    expect(mapa.has("capacidad_retirada")).toBe(false);
    expect(mapa.size).toBe(DEFS.length);
  });

  it("activa:false apaga la capacidad pese a los overrides", () => {
    const mapa = resolverCapacidades(
      [{ codigo: "tarifario_propio", porDefecto: true, activa: false }],
      [{ codigo: "tarifario_propio", habilitado: true }],
      [{ codigo: "tarifario_propio", habilitado: true }],
    );

    expect(tiene(mapa, "tarifario_propio")).toBe(false);
    expect(mapa.get("tarifario_propio")?.origenHabilitado).toBe("CATALOGO");
  });

  it("capacidadesActivas lista solo lo encendido, ordenado", () => {
    const mapa = resolverCapacidades(DEFS, [], [
      { codigo: "comision_por_evento", habilitado: true },
    ]);

    expect(capacidadesActivas(mapa)).toEqual([
      "anticipos_cliente",
      "comision_por_evento",
    ]);
  });
});

describe("catálogo", () => {
  it("no tiene códigos duplicados", () => {
    const codigos = CAPACIDADES.map((capacidad) => capacidad.codigo);

    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it("resuelve el catálogo real sin overrides", () => {
    const mapa = resolverCapacidades(CAPACIDADES);

    expect(mapa.size).toBe(CAPACIDADES.length);
    // Único encendido por defecto hoy: los anticipos (equivale al viejo
    // Cliente.manejaAnticipo, que venía con default true).
    expect(capacidadesActivas(mapa)).toEqual(["anticipos_cliente"]);
  });

  it("esCodigoCapacidad discrimina códigos del catálogo", () => {
    expect(esCodigoCapacidad("base_cif")).toBe(true);
    expect(esCodigoCapacidad("cualquier_cosa")).toBe(false);
  });
});
