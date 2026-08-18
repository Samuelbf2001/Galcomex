/**
 * Tests de la firma HMAC-SHA256 de webhooks — src/lib/webhooks/signature.ts.
 *
 * Todo puro: sin red, sin BD. Cubre el round-trip firmar/verificar, firma
 * inválida, timestamp fuera de ventana, y que verificarFirma no filtre por
 * comparación temprana (variable-time).
 */
import { describe, expect, it } from "vitest";

import {
  firmarPayload,
  verificarFirma,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT,
} from "../signature";

const SECRETO = "un-secreto-de-prueba-no-usar-en-produccion";
const BODY = JSON.stringify({ evento: "do.creado", data: { consecutivo: "DO.CTG26-0124" } });

describe("constantes de cabecera", () => {
  it("expone los nombres de cabecera esperados", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-Galcomex-Signature");
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe("X-Galcomex-Timestamp");
  });
});

describe("firmarPayload", () => {
  it("produce una firma con el esquema sha256=<hex>", () => {
    const { firma } = firmarPayload(BODY, SECRETO, new Date("2026-08-18T12:00:00Z"));
    expect(firma).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("es determinística para el mismo body/secreto/timestamp", () => {
    const ts = new Date("2026-08-18T12:00:00Z");
    const a = firmarPayload(BODY, SECRETO, ts);
    const b = firmarPayload(BODY, SECRETO, ts);
    expect(a.firma).toBe(b.firma);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it("cambia la firma si cambia el body (aunque sea un byte)", () => {
    const ts = new Date("2026-08-18T12:00:00Z");
    const a = firmarPayload(BODY, SECRETO, ts);
    const b = firmarPayload(BODY + " ", SECRETO, ts);
    expect(a.firma).not.toBe(b.firma);
  });

  it("cambia la firma si cambia el timestamp (mismo body/secreto)", () => {
    const a = firmarPayload(BODY, SECRETO, new Date("2026-08-18T12:00:00Z"));
    const b = firmarPayload(BODY, SECRETO, new Date("2026-08-18T12:00:01Z"));
    expect(a.firma).not.toBe(b.firma);
    expect(a.timestamp).not.toBe(b.timestamp);
  });

  it("lanza si el secreto viene vacío — es un bug de configuración de quien firma", () => {
    expect(() => firmarPayload(BODY, "")).toThrow();
  });
});

describe("verificarFirma — round-trip", () => {
  it("acepta una firma recién generada para el mismo body", () => {
    const ahora = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, ahora);

    const valido = verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora });
    expect(valido).toBe(true);
  });

  it("acepta dentro de la ventana de tolerancia (justo en el borde)", () => {
    const emitido = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, emitido);
    const ahora = new Date(emitido.getTime() + WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT * 1000);

    expect(verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora })).toBe(true);
  });
});

describe("verificarFirma — firma inválida rechazada", () => {
  const ahora = new Date("2026-08-18T12:00:00Z");
  const { timestamp } = firmarPayload(BODY, SECRETO, ahora);

  it("rechaza si el body fue alterado (mismo timestamp/firma)", () => {
    const { firma } = firmarPayload(BODY, SECRETO, ahora);
    const valido = verificarFirma({ body: BODY + "x", timestamp, firma, secreto: SECRETO, ahora });
    expect(valido).toBe(false);
  });

  it("rechaza con el secreto equivocado", () => {
    const { firma } = firmarPayload(BODY, SECRETO, ahora);
    const valido = verificarFirma({
      body: BODY,
      timestamp,
      firma,
      secreto: "otro-secreto-distinto",
      ahora,
    });
    expect(valido).toBe(false);
  });

  it("rechaza una firma con el hex trocado (mismo largo)", () => {
    const { firma } = firmarPayload(BODY, SECRETO, ahora);
    const firmaAlterada = firma.slice(0, -1) + (firma.endsWith("0") ? "1" : "0");
    const valido = verificarFirma({ body: BODY, timestamp, firma: firmaAlterada, secreto: SECRETO, ahora });
    expect(valido).toBe(false);
  });

  it("rechaza una firma de largo distinto (esquema/hex incompletos) sin lanzar", () => {
    expect(() =>
      verificarFirma({ body: BODY, timestamp, firma: "sha256=deadbeef", secreto: SECRETO, ahora }),
    ).not.toThrow();
    expect(
      verificarFirma({ body: BODY, timestamp, firma: "sha256=deadbeef", secreto: SECRETO, ahora }),
    ).toBe(false);
  });

  it("rechaza firma vacía o con formato arbitrario, sin lanzar", () => {
    for (const firmaInvalida of ["", "no-es-una-firma", "sha512=" + "a".repeat(64)]) {
      expect(() =>
        verificarFirma({ body: BODY, timestamp, firma: firmaInvalida, secreto: SECRETO, ahora }),
      ).not.toThrow();
      expect(
        verificarFirma({ body: BODY, timestamp, firma: firmaInvalida, secreto: SECRETO, ahora }),
      ).toBe(false);
    }
  });
});

describe("verificarFirma — timestamp fuera de ventana rechazado", () => {
  it("rechaza un timestamp más viejo que la tolerancia", () => {
    const emitido = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, emitido);
    const ahora = new Date(emitido.getTime() + (WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT + 1) * 1000);

    expect(verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora })).toBe(false);
  });

  it("rechaza un timestamp en el futuro más allá de la tolerancia (reloj adelantado / replay adelantado)", () => {
    const emitido = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, emitido);
    const ahora = new Date(emitido.getTime() - (WEBHOOK_TOLERANCIA_SEGUNDOS_DEFAULT + 1) * 1000);

    expect(verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora })).toBe(false);
  });

  it("respeta una tolerancia custom más estricta", () => {
    const emitido = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, emitido);
    const ahora = new Date(emitido.getTime() + 10_000); // 10s después

    expect(
      verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora, toleranciaSegundos: 5 }),
    ).toBe(false);
    expect(
      verificarFirma({ body: BODY, timestamp, firma, secreto: SECRETO, ahora, toleranciaSegundos: 15 }),
    ).toBe(true);
  });

  it("rechaza un timestamp no numérico sin lanzar (evita ataques de parsing)", () => {
    const ahora = new Date("2026-08-18T12:00:00Z");
    const { firma } = firmarPayload(BODY, SECRETO, ahora);

    for (const timestampInvalido of ["abc", "12.5", "-100", "", "1e10"]) {
      expect(() =>
        verificarFirma({ body: BODY, timestamp: timestampInvalido, firma, secreto: SECRETO, ahora }),
      ).not.toThrow();
    }
  });
});

describe("verificarFirma — no filtra por comparación temprana", () => {
  it("usa timingSafeEqual: firmas erróneas de igual largo no lanzan ni se distinguen por excepción", () => {
    const ahora = new Date("2026-08-18T12:00:00Z");
    const { timestamp } = firmarPayload(BODY, SECRETO, ahora);

    // Todas del mismo largo que una firma real (72 chars: "sha256=" + 64 hex),
    // difiriendo en distintas posiciones — ninguna debe lanzar ni comportarse
    // distinto por dónde difiere (eso sería el síntoma de una comparación
    // variable-time tipo === byte a byte con early-return).
    const firmaReal = firmarPayload(BODY, SECRETO, ahora).firma;
    const variantes = [
      "0" + firmaReal.slice(1), // difiere en el primer char
      firmaReal.slice(0, -1) + "0", // difiere en el último char
      firmaReal.slice(0, 40) + "0".repeat(firmaReal.length - 40), // difiere a mitad
    ].map((f) => (f === firmaReal ? firmaReal.slice(0, -1) + (firmaReal.endsWith("0") ? "1" : "0") : f));

    for (const firmaFalsa of variantes) {
      expect(firmaFalsa.length).toBe(firmaReal.length);
      expect(() =>
        verificarFirma({ body: BODY, timestamp, firma: firmaFalsa, secreto: SECRETO, ahora }),
      ).not.toThrow();
      expect(
        verificarFirma({ body: BODY, timestamp, firma: firmaFalsa, secreto: SECRETO, ahora }),
      ).toBe(false);
    }
  });

  it("acepta una firma reconstruida byte a byte a partir de un Buffer (no depende de identidad de string)", () => {
    // Blinda contra una regresión que compare por referencia/identidad en
    // vez de por contenido: la firma "esperada" recibida acá pasa por un
    // Buffer intermedio antes de comparar, como pasaría con un valor que
    // llegó por HTTP (siempre es un string nuevo, nunca la misma instancia
    // que generó firmarPayload).
    const ahora = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, ahora);
    const firmaViaBuffer = Buffer.from(Buffer.from(firma, "utf8")).toString("utf8");

    expect(
      verificarFirma({ body: BODY, timestamp, firma: firmaViaBuffer, secreto: SECRETO, ahora }),
    ).toBe(true);
  });
});

describe("verificarFirma — datos faltantes", () => {
  it("rechaza si falta secreto, timestamp o firma, sin lanzar", () => {
    const ahora = new Date("2026-08-18T12:00:00Z");
    const { firma, timestamp } = firmarPayload(BODY, SECRETO, ahora);

    expect(verificarFirma({ body: BODY, timestamp, firma, secreto: "", ahora })).toBe(false);
    expect(verificarFirma({ body: BODY, timestamp: "", firma, secreto: SECRETO, ahora })).toBe(false);
    expect(verificarFirma({ body: BODY, timestamp, firma: "", secreto: SECRETO, ahora })).toBe(false);
  });
});
