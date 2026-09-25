// @vitest-environment node
/**
 * Envío a SIIGO sin duplicados (auditoría 25-sep-2026).
 *
 * Cada POST a Siigo crea un documento que, estampado, es una factura legal:
 * un error aquí le factura dos veces al cliente. Sin BD ni red: Prisma es un
 * fake en memoria (helpers/fake-prisma-envio.ts) cuyo `updateMany` es atómico
 * como un UPDATE de Postgres, y el cliente Siigo está mockeado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as fake from "./helpers/fake-prisma-envio";

vi.mock("@/lib/db/prisma", async () => {
  const m = await import("./helpers/fake-prisma-envio");
  return { prisma: m.prismaFake };
});

vi.mock("@/lib/borradores/lineas-fijas", () => ({ ensureLineasFijas: vi.fn(async () => {}) }));
vi.mock("@/lib/borradores/recalculo", () => ({ recalcularTotalBorrador: vi.fn(async () => {}) }));
vi.mock("@/lib/borradores/devolver", () => ({ esObservacionDevolucion: () => false }));
vi.mock("@/lib/borradores/formato-conceptos", () => ({ FORMATO_CONCEPTOS_IVA: "CONCEPTOS_IVA" }));
vi.mock("@/lib/parametros/service", () => ({ getParametrosSistema: vi.fn() }));

const siigo = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token-prueba"),
  postFactura: vi.fn(),
}));

vi.mock("@/lib/siigo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siigo/client")>()),
  getToken: siigo.getToken,
  postFactura: siigo.postFactura,
}));

const { enviarBorradorASiigo, clasificarFalloEnvioSiigo } = await import(
  "../envio-factura-service"
);
const { SiigoApiError, SiigoConfigError, SiigoRespuestaInvalidaError } = await import("../client");
const { EnvioSiigoBloqueadoError } = await import("../errores-envio");
const { MENSAJE_ENVIO_BLOQUEADO } = await import("../estado-envio");

function respuestaSiigo(id: string) {
  return { id, name: `FV-2-${id}`, date: "2026-09-25" };
}

function timeout() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

async function esperarRechazo409(promesa: Promise<unknown>): Promise<Error> {
  const err = await promesa.then(
    () => {
      throw new Error("se esperaba un 409");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EnvioSiigoBloqueadoError);
  expect((err as { status: number }).status).toBe(409);
  expect((err as Error).message).toContain(MENSAJE_ENVIO_BLOQUEADO);
  return err as Error;
}

const acciones = () => fake.estado.auditorias.map((a) => a.accion);

beforeEach(() => {
  fake.reiniciar();
  siigo.getToken.mockReset();
  siigo.getToken.mockImplementation(async () => "token-prueba");
  siigo.postFactura.mockReset();
});

// ─── Regla pura ───────────────────────────────────────────────────────────────

describe("clasificarFalloEnvioSiigo", () => {
  it.each([400, 401, 403, 404, 422, 429])("HTTP %i del POST → ERROR (Siigo no la creó)", (status) => {
    expect(clasificarFalloEnvioSiigo(new SiigoApiError("x", status), true)).toBe("ERROR");
  });

  it.each([408, 409, 500, 502, 503, 504])("HTTP %i del POST → INCIERTO", (status) => {
    expect(clasificarFalloEnvioSiigo(new SiigoApiError("x", status), true)).toBe("INCIERTO");
  });

  it("timeout, red y 2xx inválido → INCIERTO", () => {
    expect(clasificarFalloEnvioSiigo(timeout(), true)).toBe("INCIERTO");
    expect(clasificarFalloEnvioSiigo(new TypeError("fetch failed"), true)).toBe("INCIERTO");
    expect(clasificarFalloEnvioSiigo(new SiigoRespuestaInvalidaError("x", null), true)).toBe(
      "INCIERTO",
    );
  });

  it("si el POST nunca salió (token, credenciales) → ERROR aunque sea timeout o 5xx", () => {
    expect(clasificarFalloEnvioSiigo(timeout(), false)).toBe("ERROR");
    expect(clasificarFalloEnvioSiigo(new SiigoApiError("auth", 500), false)).toBe("ERROR");
    expect(clasificarFalloEnvioSiigo(new SiigoConfigError("SIIGO_API_USERNAME"), true)).toBe("ERROR");
  });
});

// ─── Reclamo atómico ──────────────────────────────────────────────────────────

describe("enviarBorradorASiigo — reclamo antes de tocar Siigo", () => {
  it("primer envío: reclama (ENVIANDO) antes del token, un POST, queda ENVIADO y audita", async () => {
    let estadoAlPedirToken: string | null = "sin-llamar";
    siigo.getToken.mockImplementationOnce(async () => {
      estadoAlPedirToken = fake.estado.fila.siigoEnvioEstado;
      return "token-prueba";
    });
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: true, siigoDraftId: "sg-1", siigoEnvioEstado: "ENVIADO" });
    expect(estadoAlPedirToken).toBe("ENVIANDO");
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(fake.estado.fila).toMatchObject({
      siigoDraftId: "sg-1",
      siigoEnvioEstado: "ENVIADO",
      ultimoErrorSiigo: null,
    });
    expect(fake.estado.fila.siigoEnvioIntentoId).toEqual(expect.any(String));
    expect(acciones()).toEqual(["SIIGO_ENVIAR_OK"]);
  });

  it("dos envíos simultáneos (Promise.all): exactamente un POST; el otro recibe 409", async () => {
    siigo.postFactura.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return respuestaSiigo("sg-1");
    });

    const resultados = await Promise.allSettled([
      enviarBorradorASiigo("bor-1", "usr-1"),
      enviarBorradorASiigo("bor-1", "usr-2"),
    ]);

    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    const cumplidos = resultados.filter((r) => r.status === "fulfilled");
    const rechazados = resultados.filter((r) => r.status === "rejected");
    expect(cumplidos).toHaveLength(1);
    expect(cumplidos[0]).toMatchObject({ value: { ok: true, siigoDraftId: "sg-1" } });
    expect(rechazados).toHaveLength(1);
    await esperarRechazo409(Promise.reject((rechazados[0] as PromiseRejectedResult).reason));
    expect(acciones()).toEqual(["SIIGO_ENVIAR_OK"]);
  });

  it("cinco clics simultáneos: un solo POST", async () => {
    siigo.postFactura.mockImplementation(async () => respuestaSiigo("sg-1"));

    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () => enviarBorradorASiigo("bor-1", "usr-1")),
    );

    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(4);
  });

  it("segundo envío tras un éxito: 409 sin tocar Siigo", async () => {
    siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));
    await enviarBorradorASiigo("bor-1", "usr-1");

    const err = await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));

    expect(err.message).toContain("sg-1");
    expect(siigo.getToken).toHaveBeenCalledTimes(1);
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
    expect(fake.estado.fila.siigoDraftId).toBe("sg-1");
  });

  it("lo que cuenta es el reclamo: si otro envío reclamó entre la lectura y el UPDATE → 409 sin POST", async () => {
    // La lectura inicial ve el borrador libre; justo antes del reclamo otro
    // proceso lo deja en ENVIANDO.
    const original = fake.prismaFake.borradorFactura.findUnique;
    const espia = vi
      .spyOn(fake.prismaFake.borradorFactura, "findUnique")
      .mockImplementationOnce(async (args) => {
        const leido = await original(args);
        fake.estado.fila = {
          ...fake.estado.fila,
          siigoEnvioEstado: "ENVIANDO",
          siigoEnvioIniciadoAt: new Date(),
          siigoEnvioIntentoId: "otro",
        };
        return leido;
      });

    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.getToken).not.toHaveBeenCalled();
    expect(siigo.postFactura).not.toHaveBeenCalled();
    espia.mockRestore();
  });

  it("borrador que no está APROBADO: rechazado sin reclamar ni llamar a Siigo", async () => {
    fake.estado.fila.estado = "EN_REVISION";

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "estado" });
    expect(fake.estado.fila.siigoEnvioEstado).toBeNull();
    expect(siigo.postFactura).not.toHaveBeenCalled();
  });

  it("ENVIANDO reciente: 409 «envío en curso»; ENVIANDO de más de 10 min: 409 «sin confirmar», nunca se reintenta solo", async () => {
    fake.estado.fila.siigoEnvioEstado = "ENVIANDO";
    fake.estado.fila.siigoEnvioIniciadoAt = new Date(Date.now() - 60_000);
    const enCurso = await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(enCurso.message).toMatch(/envío en curso/);

    fake.estado.fila.siigoEnvioIniciadoAt = new Date(Date.now() - 11 * 60_000);
    const colgado = await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(colgado.message).toMatch(/sin confirmar/);
    expect(colgado.message).toMatch(/Revisar en SIIGO/);

    expect(siigo.postFactura).not.toHaveBeenCalled();
    expect(fake.estado.fila.siigoEnvioEstado).toBe("ENVIANDO");
  });
});

// ─── Clasificación del resultado ─────────────────────────────────────────────

describe("enviarBorradorASiigo — resultado de Siigo", () => {
  it.each([400, 422, 429])(
    "rechazo definitivo (HTTP %i): ERROR, se guarda el error y se puede reintentar",
    async (status) => {
      siigo.postFactura.mockRejectedValueOnce(
        new SiigoApiError(`Siigo POST /v1/invoices falló con HTTP ${status}`, status),
      );

      const fallo = await enviarBorradorASiigo("bor-1", "usr-1");
      expect(fallo).toMatchObject({ ok: false, tipo: "api", siigoEnvioEstado: "ERROR" });
      expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "ERROR", siigoDraftId: null });
      expect(fake.estado.fila.ultimoErrorSiigo).toMatch(new RegExp(`HTTP ${status}`));
      expect(acciones()).toEqual(["SIIGO_ENVIAR_ERROR"]);

      siigo.postFactura.mockResolvedValueOnce(respuestaSiigo("sg-1"));
      await expect(enviarBorradorASiigo("bor-1", "usr-1")).resolves.toMatchObject({ ok: true });
      expect(siigo.postFactura).toHaveBeenCalledTimes(2);
      expect(fake.estado.fila.siigoEnvioEstado).toBe("ENVIADO");
    },
  );

  it("falla el token (el POST no salió): ERROR, reintentable", async () => {
    siigo.getToken.mockRejectedValueOnce(new SiigoApiError("Siigo auth falló con HTTP 500", 500));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, siigoEnvioEstado: "ERROR" });
    expect(siigo.postFactura).not.toHaveBeenCalled();
    expect(fake.estado.fila.siigoEnvioEstado).toBe("ERROR");
  });

  it("timeout del POST: INCIERTO, mensaje en español y reintento BLOQUEADO", async () => {
    siigo.postFactura.mockRejectedValueOnce(timeout());

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto", siigoEnvioEstado: "INCIERTO" });
    expect(r.ok ? "" : r.error).toMatch(/no respondió en 20 s/);
    expect(r.ok ? "" : r.error).toMatch(/Revisar en SIIGO/);
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
    expect(acciones()).toEqual(["SIIGO_ENVIAR_INCIERTO"]);

    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("error de red en el POST: INCIERTO", async () => {
    siigo.postFactura.mockRejectedValueOnce(new TypeError("fetch failed"));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto" });
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
  });

  it.each([500, 502, 503, 408])("HTTP %i del POST: INCIERTO y bloqueado", async (status) => {
    siigo.postFactura.mockRejectedValueOnce(new SiigoApiError(`HTTP ${status}`, status));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto", siigoEnvioEstado: "INCIERTO" });
    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("2xx inválido que sí trae id: INCIERTO y el id queda guardado (nunca se pierde)", async () => {
    siigo.postFactura.mockRejectedValueOnce(
      new SiigoRespuestaInvalidaError("Siigo aceptó la factura pero no devolvió consecutivo", "sg-7"),
    );

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto", siigoDraftId: "sg-7" });
    expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "INCIERTO", siigoDraftId: "sg-7" });
    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("2xx ilegible sin id: INCIERTO sin id", async () => {
    siigo.postFactura.mockRejectedValueOnce(new SiigoRespuestaInvalidaError("JSON roto", null));

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto", siigoDraftId: null });
    expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "INCIERTO", siigoDraftId: null });
  });

  it("2xx y la BD falla una vez al guardar: se reintenta el guardado y queda ENVIADO", async () => {
    siigo.postFactura.mockImplementationOnce(async () => {
      fake.estado.transaccionesQueFallan = 1;
      return respuestaSiigo("sg-1");
    });

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: true, siigoDraftId: "sg-1" });
    expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "ENVIADO", siigoDraftId: "sg-1" });
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("2xx y el AuditLog falla siempre: se guarda el id como INCIERTO y no se reenvía", async () => {
    siigo.postFactura.mockImplementationOnce(async () => {
      fake.estado.auditoriasQueFallan = 3;
      return respuestaSiigo("sg-1");
    });

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "db", siigoEnvioEstado: "INCIERTO", siigoDraftId: "sg-1" });
    expect(r.ok ? "" : r.error).toMatch(/No lo reenvíes/);
    expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "INCIERTO", siigoDraftId: "sg-1" });
    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("2xx y la BD cae del todo: la fila sigue reclamada (ENVIANDO) y no se reenvía", async () => {
    siigo.postFactura.mockImplementationOnce(async () => {
      fake.estado.transaccionesQueFallan = 2;
      fake.estado.updatesQueFallan = 1;
      fake.estado.auditoriasQueFallan = 1;
      return respuestaSiigo("sg-1");
    });

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "db", siigoDraftId: null });
    expect(r.ok ? "" : r.error).toMatch(/sg-1/);
    expect(fake.estado.fila.siigoEnvioEstado).toBe("ENVIANDO");
    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
    expect(siigo.postFactura).toHaveBeenCalledTimes(1);
  });

  it("rechazo definitivo pero la BD no deja registrarlo: queda bloqueado (conservador), no libre", async () => {
    siigo.postFactura.mockImplementationOnce(async () => {
      fake.estado.transaccionesQueFallan = 1;
      throw new SiigoApiError("HTTP 400", 400);
    });

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "db", siigoEnvioEstado: "ENVIANDO" });
    expect(fake.estado.fila.siigoEnvioEstado).toBe("ENVIANDO");
    await esperarRechazo409(enviarBorradorASiigo("bor-1", "usr-1"));
  });

  it("respuesta tardía de un intento ya liberado: no pisa el envío vigente y deja rastro", async () => {
    siigo.postFactura.mockImplementationOnce(async () => {
      // Mientras Siigo tarda, un ADMIN liberó y otro envío reclamó el borrador.
      fake.estado.fila = { ...fake.estado.fila, siigoEnvioIntentoId: "otro-intento" };
      return respuestaSiigo("sg-tarde");
    });

    const r = await enviarBorradorASiigo("bor-1", "usr-1");

    expect(r).toMatchObject({ ok: false, tipo: "incierto" });
    expect(fake.estado.fila.siigoDraftId).toBeNull();
    expect(fake.estado.auditorias[0]).toMatchObject({
      accion: "SIIGO_ENVIAR_INCIERTO",
      despues: { siigoDraftIdHuerfano: "sg-tarde" },
    });
  });
});
