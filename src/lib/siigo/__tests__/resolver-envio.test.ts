// @vitest-environment node
/**
 * Resolver un envío a SIIGO que quedó INCIERTO: «Revisar en SIIGO» y
 * «Liberar para reenviar» (solo ADMIN). Sin BD ni red (fake en memoria +
 * cliente Siigo mockeado).
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
  getInvoiceById: vi.fn(),
}));

vi.mock("@/lib/siigo/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siigo/client")>()),
  getToken: siigo.getToken,
  postFactura: siigo.postFactura,
  getInvoiceById: siigo.getInvoiceById,
}));

const { revisarEnvioEnSiigo, liberarEnvioSiigo } = await import("../resolver-envio-service");
const { enviarBorradorASiigo } = await import("../envio-factura-service");
const { SiigoApiError } = await import("../client");
const { ConsultaSiigoError, EnvioSiigoNoResolubleError } = await import("../errores-envio");
const { puedeEnviarASiigo } = await import("../estado-envio");

function ponerIncierto(extra: Partial<fake.FilaBorrador> = {}) {
  fake.estado.fila = {
    ...fake.estado.fila,
    siigoEnvioEstado: "INCIERTO",
    siigoEnvioIniciadoAt: new Date("2026-09-25T15:00:00Z"),
    siigoEnvioIntentoId: "intento-1",
    ultimoErrorSiigo: "SIIGO no respondió en 20 s.",
    ...extra,
  };
}

function facturaSiigo(id: string) {
  return { id, consecutivo: "FV-2-18600", date: "2026-09-25", stampStatus: null, cufe: null };
}

const acciones = () => fake.estado.auditorias.map((a) => a.accion);

beforeEach(() => {
  fake.reiniciar();
  siigo.getToken.mockClear();
  siigo.postFactura.mockReset();
  siigo.getInvoiceById.mockReset();
});

describe("revisarEnvioEnSiigo", () => {
  it("con id guardado y Siigo lo encuentra: queda ENVIADO y se audita", async () => {
    ponerIncierto({ siigoDraftId: "sg-7" });
    siigo.getInvoiceById.mockResolvedValueOnce(facturaSiigo("sg-7"));

    const r = await revisarEnvioEnSiigo("bor-1", "adm-1");

    expect(r).toMatchObject({ encontrada: true, siigoEnvioEstado: "ENVIADO", consecutivo: "FV-2-18600" });
    expect(siigo.getInvoiceById).toHaveBeenCalledWith("token-prueba", "sg-7");
    expect(fake.estado.fila).toMatchObject({ siigoEnvioEstado: "ENVIADO", siigoDraftId: "sg-7", ultimoErrorSiigo: null });
    expect(fake.estado.auditorias[0]).toMatchObject({
      accion: "SIIGO_ENVIO_REVISADO",
      despues: { resultado: "ENCONTRADA" },
    });
  });

  it("con id y Siigo responde 404: sigue INCIERTO y NO se puede liberar", async () => {
    ponerIncierto({ siigoDraftId: "sg-7" });
    siigo.getInvoiceById.mockRejectedValueOnce(new SiigoApiError("HTTP 404", 404));

    const r = await revisarEnvioEnSiigo("bor-1", "adm-1");

    expect(r).toMatchObject({ encontrada: false, puedeLiberar: false, siigoEnvioEstado: "INCIERTO" });
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
    await expect(liberarEnvioSiigo("bor-1", "adm-1")).rejects.toBeInstanceOf(EnvioSiigoNoResolubleError);
    expect(fake.estado.fila.siigoDraftId).toBe("sg-7");
  });

  it("con id y Siigo falla (5xx): error 502 y nada cambia", async () => {
    ponerIncierto({ siigoDraftId: "sg-7" });
    siigo.getInvoiceById.mockRejectedValueOnce(new SiigoApiError("HTTP 500", 500));

    const err = await revisarEnvioEnSiigo("bor-1", "adm-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConsultaSiigoError);
    expect((err as { status: number }).status).toBe(502);
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
    expect(fake.estado.auditorias).toHaveLength(0);
  });

  it("sin id: no llama a Siigo, dice qué buscar en el portal y habilita liberar", async () => {
    ponerIncierto();

    const r = await revisarEnvioEnSiigo("bor-1", "adm-1");

    expect(siigo.getInvoiceById).not.toHaveBeenCalled();
    expect(r).toMatchObject({ encontrada: false, busquedaAutomatica: false, puedeLiberar: true });
    expect(r.mensaje).toContain("900123456");
    expect(r.mensaje).toContain("DO.BAQ26-0001");
    expect(acciones()).toEqual(["SIIGO_ENVIO_REVISADO"]);
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
  });

  it("ENVIANDO de más de 10 min se revisa como INCIERTO", async () => {
    ponerIncierto({
      siigoEnvioEstado: "ENVIANDO",
      siigoEnvioIniciadoAt: new Date(Date.now() - 11 * 60_000),
      siigoDraftId: "sg-8",
    });
    siigo.getInvoiceById.mockResolvedValueOnce(facturaSiigo("sg-8"));

    await expect(revisarEnvioEnSiigo("bor-1", "adm-1")).resolves.toMatchObject({ encontrada: true });
    expect(fake.estado.fila.siigoEnvioEstado).toBe("ENVIADO");
  });

  it.each([
    ["sin enviar", {}],
    ["ENVIADO", { siigoEnvioEstado: "ENVIADO" as const, siigoDraftId: "sg-1" }],
    ["ERROR", { siigoEnvioEstado: "ERROR" as const }],
    ["ENVIANDO reciente", { siigoEnvioEstado: "ENVIANDO" as const, siigoEnvioIniciadoAt: new Date() }],
  ])("%s: no hay nada que revisar (409)", async (_nombre, extra) => {
    fake.estado.fila = { ...fake.estado.fila, ...extra };

    const err = await revisarEnvioEnSiigo("bor-1", "adm-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvioSiigoNoResolubleError);
    expect((err as { status: number }).status).toBe(409);
    expect(siigo.getInvoiceById).not.toHaveBeenCalled();
  });
});

describe("liberarEnvioSiigo", () => {
  it("INCIERTO sin id → ERROR, con AuditLog; entonces se puede volver a enviar", async () => {
    ponerIncierto();

    await expect(liberarEnvioSiigo("bor-1", "adm-1")).resolves.toEqual({ siigoEnvioEstado: "ERROR" });

    expect(fake.estado.fila.siigoEnvioEstado).toBe("ERROR");
    expect(fake.estado.fila.ultimoErrorSiigo).toMatch(/Liberado por un ADMIN/);
    expect(fake.estado.auditorias[0]).toMatchObject({
      accion: "SIIGO_ENVIO_LIBERADO",
      antes: { siigoEnvioEstado: "INCIERTO", siigoEnvioIntentoId: "intento-1" },
      despues: { siigoEnvioEstado: "ERROR" },
    });
    expect(puedeEnviarASiigo(fake.estado.fila)).toBe(true);
  });

  it("ENVIANDO colgado (> 10 min) sin id también se puede liberar", async () => {
    ponerIncierto({
      siigoEnvioEstado: "ENVIANDO",
      siigoEnvioIniciadoAt: new Date(Date.now() - 11 * 60_000),
    });

    await liberarEnvioSiigo("bor-1", "adm-1");

    expect(fake.estado.fila.siigoEnvioEstado).toBe("ERROR");
  });

  it.each([
    ["ENVIANDO reciente", { siigoEnvioEstado: "ENVIANDO" as const, siigoEnvioIniciadoAt: new Date() }],
    ["INCIERTO con id de Siigo", { siigoEnvioEstado: "INCIERTO" as const, siigoDraftId: "sg-1" }],
    ["ENVIADO", { siigoEnvioEstado: "ENVIADO" as const, siigoDraftId: "sg-1" }],
    ["ERROR", { siigoEnvioEstado: "ERROR" as const }],
    ["FACTURADO", { siigoEnvioEstado: "INCIERTO" as const, estado: "FACTURADO" }],
  ])("%s: no se libera (409)", async (_nombre, extra) => {
    fake.estado.fila = { ...fake.estado.fila, ...extra };
    const antes = { ...fake.estado.fila };

    await expect(liberarEnvioSiigo("bor-1", "adm-1")).rejects.toBeInstanceOf(EnvioSiigoNoResolubleError);

    expect(fake.estado.fila).toEqual(antes);
    expect(fake.estado.auditorias).toHaveLength(0);
  });

  it("si el envío cambió entre la lectura y la liberación: 409 y no pisa nada", async () => {
    ponerIncierto();
    const original = fake.prismaFake.borradorFactura.findUnique;
    const espia = vi
      .spyOn(fake.prismaFake.borradorFactura, "findUnique")
      .mockImplementationOnce(async (args) => {
        const leido = await original(args);
        fake.estado.fila = { ...fake.estado.fila, siigoEnvioIntentoId: "intento-2" };
        return leido;
      });

    await expect(liberarEnvioSiigo("bor-1", "adm-1")).rejects.toBeInstanceOf(EnvioSiigoNoResolubleError);
    expect(fake.estado.fila.siigoEnvioEstado).toBe("INCIERTO");
    espia.mockRestore();
  });
});

describe("flujo completo", () => {
  it("timeout → INCIERTO (bloqueado) → revisar → liberar → reenviar: dos POST en total, nunca en paralelo", async () => {
    siigo.postFactura.mockRejectedValueOnce(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    await expect(enviarBorradorASiigo("bor-1", "adm-1")).resolves.toMatchObject({ tipo: "incierto" });
    await expect(enviarBorradorASiigo("bor-1", "adm-1")).rejects.toMatchObject({ status: 409 });

    await expect(revisarEnvioEnSiigo("bor-1", "adm-1")).resolves.toMatchObject({ puedeLiberar: true });
    await liberarEnvioSiigo("bor-1", "adm-1");

    siigo.postFactura.mockResolvedValueOnce({ id: "sg-2", name: "FV-2-18601", date: "2026-09-25" });
    await expect(enviarBorradorASiigo("bor-1", "adm-1")).resolves.toMatchObject({
      ok: true,
      siigoDraftId: "sg-2",
    });

    expect(siigo.postFactura).toHaveBeenCalledTimes(2);
    expect(acciones()).toEqual([
      "SIIGO_ENVIAR_INCIERTO",
      "SIIGO_ENVIO_REVISADO",
      "SIIGO_ENVIO_LIBERADO",
      "SIIGO_ENVIAR_OK",
    ]);
  });
});
