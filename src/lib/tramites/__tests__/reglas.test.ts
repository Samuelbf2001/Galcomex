/**
 * Tests de `validateReglaAgenciaFija` — función pura, sin BD.
 *
 * Esta regla era, hasta la migración a capacidades, un `if` contra el nombre
 * de la empresa (`clienteNombre.includes("litoplas")`). Los dos primeros tests
 * fijan que el comportamiento para Litoplas es EXACTAMENTE el de antes.
 */
import { describe, expect, it } from "vitest";

import {
  aplicarReglaAgenciaAlCrear,
  reglaAgenciaDe,
  validateReglaAgenciaFija,
  type ConfigReglaAgencia,
} from "@/lib/tramites/reglas";

const CONFIG_LITOPLAS: ConfigReglaAgencia = {
  agencia: "MOVIADUANAS",
  formatoDoAgencia: "^I\\d{8}$",
  mensajeAgencia: "Litoplas debe operar con Moviaduanas",
  mensajeFormato: "Litoplas requiere DO de agencia con formato I########",
};

const litoplas = (agencia: string | null, doAgencia: string | null) => ({
  cliente: { nombre: "LITOPLAS SA" },
  agenciaAduanas: agencia as never,
  doAgencia,
});

describe("validateReglaAgenciaFija — paridad con la regla vieja de Litoplas", () => {
  it("acepta Moviaduanas con DO de agencia I########", () => {
    expect(
      validateReglaAgenciaFija(litoplas("MOVIADUANAS", "I12345678"), CONFIG_LITOPLAS),
    ).toBeNull();
  });

  it("rechaza otra agencia con el mismo mensaje de antes", () => {
    expect(validateReglaAgenciaFija(litoplas("COLDEX", "I12345678"), CONFIG_LITOPLAS)).toBe(
      "Litoplas debe operar con Moviaduanas",
    );
  });

  it("rechaza un DO de agencia con formato inválido", () => {
    expect(
      validateReglaAgenciaFija(litoplas("MOVIADUANAS", "X12345678"), CONFIG_LITOPLAS),
    ).toBe("Litoplas requiere DO de agencia con formato I########");
    expect(
      validateReglaAgenciaFija(litoplas("MOVIADUANAS", "I1234"), CONFIG_LITOPLAS),
    ).toBe("Litoplas requiere DO de agencia con formato I########");
  });

  it("rechaza el DO de agencia vacío", () => {
    expect(validateReglaAgenciaFija(litoplas("MOVIADUANAS", null), CONFIG_LITOPLAS)).toBe(
      "Litoplas requiere DO de agencia con formato I########",
    );
  });
});

describe("validateReglaAgenciaFija — es general, no específica de una empresa", () => {
  it("sin la capacidad encendida no valida nada", () => {
    expect(validateReglaAgenciaFija(litoplas("COLDEX", null), null)).toBeNull();
  });

  it("sirve para cualquier empresa y cualquier agencia", () => {
    const config: ConfigReglaAgencia = { agencia: "COLDEX" };
    const tramite = {
      cliente: { nombre: "POLIRED SAS" },
      agenciaAduanas: "MOVIADUANAS" as never,
      doAgencia: null,
    };

    expect(validateReglaAgenciaFija(tramite, config)).toBe(
      "POLIRED SAS debe operar con COLDEX",
    );
  });

  it("una config solo con agencia no exige formato de DO", () => {
    const config: ConfigReglaAgencia = { agencia: "MOVIADUANAS" };

    expect(validateReglaAgenciaFija(litoplas("MOVIADUANAS", null), config)).toBeNull();
  });

  it("una config solo con formato no exige agencia", () => {
    const config: ConfigReglaAgencia = { formatoDoAgencia: "^I\\d{8}$" };

    expect(validateReglaAgenciaFija(litoplas("COLDEX", "I99999999"), config)).toBeNull();
  });

  it("una expresión regular inválida no bloquea la operación", () => {
    const config: ConfigReglaAgencia = { formatoDoAgencia: "[sin-cerrar" };

    expect(validateReglaAgenciaFija(litoplas("MOVIADUANAS", "loquesea"), config)).toBeNull();
  });

  it("ignora valores de config que no son texto", () => {
    const config = { agencia: 42, formatoDoAgencia: null } as ConfigReglaAgencia;

    expect(validateReglaAgenciaFija(litoplas("COLDEX", null), config)).toBeNull();
  });
});

describe("aplicarReglaAgenciaAlCrear — la agencia fija manda desde la creación", () => {
  const LITOPLAS = {
    agencia: "MOVIADUANAS",
    formatoDoAgencia: "^I\\d{8}$",
    mensajeAgencia: "Litoplas debe operar con Moviaduanas",
    mensajeFormato: "Litoplas requiere DO de agencia con formato I########",
  };

  it("sin agencia en el formulario, queda la fija", () => {
    expect(aplicarReglaAgenciaAlCrear(LITOPLAS, {}, "LITOPLAS")).toEqual({ ok: true, agenciaAduanas: "MOVIADUANAS" });
  });

  it("otra agencia se rechaza con el mensaje de la config", () => {
    expect(aplicarReglaAgenciaAlCrear(LITOPLAS, { agenciaAduanas: "COLDEX" }, "LITOPLAS")).toEqual({
      ok: false,
      mensaje: "Litoplas debe operar con Moviaduanas",
    });
  });

  it("el DO de agencia solo se valida si viene, y con el formato de la config", () => {
    expect(aplicarReglaAgenciaAlCrear(LITOPLAS, { doAgencia: "I12345678" }, "LITOPLAS").ok).toBe(true);
    expect(aplicarReglaAgenciaAlCrear(LITOPLAS, { doAgencia: "123" }, "LITOPLAS")).toEqual({
      ok: false,
      mensaje: "Litoplas requiere DO de agencia con formato I########",
    });
  });

  it("sin regla, la agencia es la que venga", () => {
    expect(aplicarReglaAgenciaAlCrear(null, { agenciaAduanas: "COLDEX" }, "OTRA")).toEqual({ ok: true, agenciaAduanas: "COLDEX" });
    expect(reglaAgenciaDe({ agencia: "  " })).toBeNull();
  });
});
