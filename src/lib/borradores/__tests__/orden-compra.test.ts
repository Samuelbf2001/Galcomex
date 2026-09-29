/**
 * B4 (Diseño B, 29-sep-2026) — la factura debe cuadrar con la orden de compra
 * del cliente. Casos dorados O1, O2, O5, O6, O7 y O8 de
 * `simulacion-camila-27sep/DISENO-B.md` §2.4, al peso. Puros (sin BD).
 */
import { describe, expect, it } from "vitest";

import { transicionBorradorPayloadSchema } from "@/lib/validations/borradores";

import {
  CONFIG_OC_DEFECTO,
  configOrdenCompraDe,
  desgloseParaOc,
  evaluarOrdenCompra,
  explicacionBaseOc,
  mensajeFrenoOc,
  type ConfigOrdenCompra,
  type DesgloseOc,
} from "../orden-compra";

const $ = (n: number) => BigInt(n);

const desglose = (servicio: number, terceros = 0, cuatroXMil = 0): DesgloseOc => ({
  servicio: $(servicio),
  terceros: $(terceros),
  cuatroXMil: $(cuatroXMil),
});

const SOLO_SERVICIO: ConfigOrdenCompra = { ...CONFIG_OC_DEFECTO, base: "SOLO_SERVICIO" };

describe("evaluarOrdenCompra — casos dorados", () => {
  it("O1 — DO.26-0171 / OC11374 = 407.000: servicio 407.000, sin terceros → CUADRA", () => {
    const ev = evaluarOrdenCompra({ numero: "OC11374", valorOc: $(407_000), desglose: desglose(407_000), config: CONFIG_OC_DEFECTO });
    expect(ev.estado).toBe("CUADRA");
    if (ev.estado !== "CUADRA") return;
    expect(ev.base).toBe($(407_000));
    expect(ev.diferencia).toBe(0n);
    expect(mensajeFrenoOc(ev)).toBeNull();
  });

  it("O2 — DO.26-0130, factura de 427.000 contra OC11104 = 539.000 → NO_CUADRA, faltan 112.000", () => {
    const ev = evaluarOrdenCompra({ numero: "OC11104", valorOc: $(539_000), desglose: desglose(427_000), config: CONFIG_OC_DEFECTO });
    expect(ev.estado).toBe("NO_CUADRA");
    if (ev.estado !== "NO_CUADRA") return;
    expect(ev.diferencia).toBe($(-112_000));
    const mensaje = mensajeFrenoOc(ev)!;
    expect(mensaje).toContain("La factura suma $427.000 sin impuestos");
    expect(mensaje).toContain("la orden de compra OC11104 es de $539.000");
    expect(mensaje).toContain("faltan $112.000");
    expect(mensaje).toContain("Corrígela, devuélvela o pide una OC nueva");
  });

  it("O5 — DO.26-0130 corregido (539.000) → CUADRA", () => {
    const ev = evaluarOrdenCompra({ numero: "OC11104", valorOc: $(539_000), desglose: desglose(539_000), config: CONFIG_OC_DEFECTO });
    expect(ev.estado).toBe("CUADRA");
  });

  it("O6 — DO.26-0079 / OC10944 (parte 910.800): servicio 827.000 + VUCE 83.800 cuadra; el 4x1000 (335) NO entra", () => {
    const ev = evaluarOrdenCompra({
      numero: "OC10944",
      valorOc: $(910_800),
      desglose: desglose(827_000, 83_800, 335),
      config: CONFIG_OC_DEFECTO,
    });
    expect(ev.estado).toBe("CUADRA");
    if (ev.estado !== "CUADRA") return;
    expect(ev.base).toBe($(910_800));
    expect(ev.desglose.cuatroXMil).toBe($(335));
    // Las tres partes de la OC compartida suman lo que dice el PDF: 1.901.939.
    expect($(910_800) + $(439_000) + $(552_139)).toBe($(1_901_939));
  });

  it("O6b — con incluye4x1000 el mismo DO frena por 335 (la lectura «factura completa»)", () => {
    const ev = evaluarOrdenCompra({
      numero: "OC10944",
      valorOc: $(910_800),
      desglose: desglose(827_000, 83_800, 335),
      config: { ...CONFIG_OC_DEFECTO, incluye4x1000: true },
    });
    expect(ev.estado).toBe("NO_CUADRA");
    if (ev.estado === "NO_CUADRA") expect(ev.diferencia).toBe($(335));
  });

  it("O7 — DUTA con uso de puerto 50.000 / OC 380.000: NO_CUADRA +50.000 con la regla por defecto", () => {
    const ev = evaluarOrdenCompra({ numero: "OC-DUTA", valorOc: $(380_000), desglose: desglose(380_000, 50_000), config: CONFIG_OC_DEFECTO });
    expect(ev.estado).toBe("NO_CUADRA");
    if (ev.estado !== "NO_CUADRA") return;
    expect(ev.base).toBe($(430_000));
    expect(ev.diferencia).toBe($(50_000));
    expect(mensajeFrenoOc(ev)).toContain("sobran $50.000");
  });

  it("O7b — el mismo caso con base SOLO_SERVICIO → CUADRA", () => {
    const ev = evaluarOrdenCompra({ numero: "OC-DUTA", valorOc: $(380_000), desglose: desglose(380_000, 50_000), config: SOLO_SERVICIO });
    expect(ev.estado).toBe("CUADRA");
  });

  it("O8 — Polyrec S.A.S. con OC4369 de EREMA y sin valor → SIN_VALOR", () => {
    const ev = evaluarOrdenCompra({ numero: "OC4369", valorOc: null, desglose: desglose(500_000), config: CONFIG_OC_DEFECTO });
    expect(ev).toEqual({ estado: "SIN_VALOR", numero: "OC4369" });
    expect(mensajeFrenoOc(ev)).toBe(
      "El DO tiene la orden de compra OC4369 sin valor: escribe su valor en el DO o quita el número.",
    );
  });

  it("sin número de OC (nulo, vacío o solo espacios) no hay nada que contrastar → SIN_OC", () => {
    for (const numero of [null, "", "   "]) {
      expect(evaluarOrdenCompra({ numero, valorOc: $(1), desglose: desglose(1), config: CONFIG_OC_DEFECTO })).toEqual({ estado: "SIN_OC" });
    }
  });

  it("tolerancia 0: un peso de diferencia ya no cuadra", () => {
    const ev = evaluarOrdenCompra({ numero: "OC1", valorOc: $(100_000), desglose: desglose(100_001), config: CONFIG_OC_DEFECTO });
    expect(ev.estado).toBe("NO_CUADRA");
    if (ev.estado === "NO_CUADRA") expect(ev.diferencia).toBe($(1));
  });
});

describe("desgloseParaOc — mismo filtro que sincronizarLineasDerivadas", () => {
  it("separa servicio, terceros y 4x1000; el IVA y las demás líneas fijas nunca entran", () => {
    const d = desgloseParaOc([
      { valor: $(255_000), seccion: "OPERACIONAL", tipoFija: null },
      { valor: $(20_000), seccion: "OPERACIONAL", tipoFija: null },
      { valor: $(83_800), seccion: "TERCEROS", tipoFija: null },
      { valor: $(335), seccion: "TERCEROS", tipoFija: "IMPUESTO_4X1000" },
      { valor: $(15_922), seccion: "OPERACIONAL", tipoFija: "IVA_COMISION" },
      { valor: $(7), seccion: "OPERACIONAL", tipoFija: "COSTOS_BANCARIOS" },
    ]);
    expect(d).toEqual({ servicio: $(275_000), terceros: $(83_800), cuatroXMil: $(335) });
  });

  it("sin líneas: todo en cero", () => {
    expect(desgloseParaOc([])).toEqual({ servicio: 0n, terceros: 0n, cuatroXMil: 0n });
  });
});

describe("configOrdenCompraDe", () => {
  it("sin config (null/undefined) usa la de defecto: servicio + reembolsos, sin 4x1000, frena", () => {
    expect(configOrdenCompraDe(null)).toEqual(CONFIG_OC_DEFECTO);
    expect(configOrdenCompraDe(undefined)).toEqual(CONFIG_OC_DEFECTO);
    expect(CONFIG_OC_DEFECTO).toEqual({ base: "SERVICIO_Y_TERCEROS", incluye4x1000: false, bloqueaAprobacion: true });
  });

  it("una config parcial completa lo que falta con el defecto", () => {
    expect(configOrdenCompraDe({ base: "SOLO_SERVICIO" })).toEqual({ ...CONFIG_OC_DEFECTO, base: "SOLO_SERVICIO" });
    expect(configOrdenCompraDe({ bloqueaAprobacion: false })).toEqual({ ...CONFIG_OC_DEFECTO, bloqueaAprobacion: false });
    expect(configOrdenCompraDe({})).toEqual(CONFIG_OC_DEFECTO);
  });

  it("una config rota nunca apaga el freno: vuelve entera al defecto", () => {
    expect(configOrdenCompraDe({ base: "TODO", bloqueaAprobacion: false })).toEqual(CONFIG_OC_DEFECTO);
    expect(configOrdenCompraDe("nada")).toEqual(CONFIG_OC_DEFECTO);
    expect(configOrdenCompraDe({ incluye4x1000: "si" })).toEqual(CONFIG_OC_DEFECTO);
  });

  it("explicacionBaseOc dice en palabras qué entra", () => {
    expect(explicacionBaseOc(CONFIG_OC_DEFECTO)).toBe("servicio + reembolsos, sin IVA ni ReteIVA ni 4x1000");
    expect(explicacionBaseOc(SOLO_SERVICIO)).toBe("solo el servicio, sin IVA ni ReteIVA ni 4x1000");
    expect(explicacionBaseOc({ ...CONFIG_OC_DEFECTO, incluye4x1000: true })).toBe("servicio + reembolsos, sin IVA ni ReteIVA, con el 4x1000");
  });
});

describe("PATCH /api/borradores/[id] — motivoExcepcionOc (Zod)", () => {
  it("acepta un motivo de 10 a 500 caracteres y lo recorta; sin motivo también vale", () => {
    const ok = transicionBorradorPayloadSchema.safeParse({ nuevoEstado: "APROBADO", motivoExcepcionOc: "  Cliente aceptó la diferencia por correo  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.motivoExcepcionOc).toBe("Cliente aceptó la diferencia por correo");
    expect(transicionBorradorPayloadSchema.safeParse({ nuevoEstado: "APROBADO" }).success).toBe(true);
  });

  it("rechaza un motivo de menos de 10 o de más de 500 caracteres", () => {
    expect(transicionBorradorPayloadSchema.safeParse({ nuevoEstado: "APROBADO", motivoExcepcionOc: "muy corto" }).success).toBe(false);
    expect(transicionBorradorPayloadSchema.safeParse({ nuevoEstado: "APROBADO", motivoExcepcionOc: "x".repeat(501) }).success).toBe(false);
  });
});
