/**
 * Reglas puras del estado del envío a SIIGO (las usan servidor y UI).
 */
import { describe, expect, it } from "vitest";

import {
  detalleEnvioBloqueado,
  estadoEnvioEfectivo,
  MENSAJE_ENVIO_BLOQUEADO,
  puedeEnviarASiigo,
} from "../estado-envio";

const AHORA = new Date("2026-09-25T15:00:00Z");
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000);

describe("estadoEnvioEfectivo", () => {
  it("ENVIANDO de menos de 10 min sigue ENVIANDO", () => {
    expect(
      estadoEnvioEfectivo({ siigoEnvioEstado: "ENVIANDO", siigoEnvioIniciadoAt: hace(9) }, AHORA),
    ).toBe("ENVIANDO");
  });

  it("ENVIANDO de más de 10 min (o sin fecha) se presenta como INCIERTO", () => {
    expect(
      estadoEnvioEfectivo({ siigoEnvioEstado: "ENVIANDO", siigoEnvioIniciadoAt: hace(11) }, AHORA),
    ).toBe("INCIERTO");
    expect(
      estadoEnvioEfectivo({ siigoEnvioEstado: "ENVIANDO", siigoEnvioIniciadoAt: null }, AHORA),
    ).toBe("INCIERTO");
    expect(
      estadoEnvioEfectivo(
        { siigoEnvioEstado: "ENVIANDO", siigoEnvioIniciadoAt: hace(11).toISOString() },
        AHORA,
      ),
    ).toBe("INCIERTO");
  });

  it("los demás estados no cambian", () => {
    for (const e of ["ENVIADO", "INCIERTO", "ERROR", null] as const) {
      expect(estadoEnvioEfectivo({ siigoEnvioEstado: e, siigoEnvioIniciadoAt: hace(60) }, AHORA)).toBe(e);
    }
  });
});

describe("puedeEnviarASiigo", () => {
  const base = { siigoEnvioIniciadoAt: null, siigoDraftId: null };

  it("solo sin envío previo o tras un rechazo (ERROR)", () => {
    expect(puedeEnviarASiigo({ ...base, siigoEnvioEstado: null })).toBe(true);
    expect(puedeEnviarASiigo({ ...base, siigoEnvioEstado: "ERROR" })).toBe(true);
    expect(puedeEnviarASiigo({ ...base, siigoEnvioEstado: "ENVIANDO" })).toBe(false);
    expect(puedeEnviarASiigo({ ...base, siigoEnvioEstado: "ENVIADO" })).toBe(false);
    expect(puedeEnviarASiigo({ ...base, siigoEnvioEstado: "INCIERTO" })).toBe(false);
  });

  it("nunca con id de SIIGO, aunque el estado diga otra cosa", () => {
    expect(puedeEnviarASiigo({ ...base, siigoDraftId: "sg-1", siigoEnvioEstado: null })).toBe(false);
    expect(puedeEnviarASiigo({ ...base, siigoDraftId: "sg-1", siigoEnvioEstado: "ERROR" })).toBe(false);
  });
});

describe("detalleEnvioBloqueado", () => {
  it("siempre empieza con el mensaje base y explica el motivo", () => {
    const conId = detalleEnvioBloqueado(
      { siigoDraftId: "sg-1", siigoEnvioEstado: "ENVIADO", siigoEnvioIniciadoAt: null },
      AHORA,
    );
    const incierto = detalleEnvioBloqueado(
      { siigoDraftId: null, siigoEnvioEstado: "INCIERTO", siigoEnvioIniciadoAt: null },
      AHORA,
    );
    expect(conId.startsWith(MENSAJE_ENVIO_BLOQUEADO)).toBe(true);
    expect(conId).toContain("sg-1");
    expect(incierto).toContain("Revisar en SIIGO");
  });
});
