/**
 * GET /api/facturacion/borradores — consulta por lote de borradores.
 *
 * Harness: igual que src/app/api/__tests__/idor-regresion.test.ts — se mockean
 * next/headers, @/lib/auth/auth y @/lib/db/prisma; requireRole y
 * resolverTramiteConPermiso corren con su lógica real. Se mockea además
 * @/lib/borradores/service (ensureBorrador / listarBorradores) porque aquí se
 * prueba la orquestación del lote, no el motor.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

// ── Mocks tempranos ────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    tramiteDO: { findUnique: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

vi.mock("@/lib/borradores/service", () => ({
  ensureBorrador: vi.fn(),
  listarBorradores: vi.fn(),
  generarBorrador: vi.fn(),
  ConceptosOperacionalesInvalidosError: class extends Error {},
  TramiteNoFacturableError: class extends Error {},
}));

// La lectura de los pagos por revisar (auditoría del borrador) también se
// mockea: aquí solo importa quién la recibe y que no rompa el listado.
vi.mock("@/lib/borradores/pagos-por-revisar", async (original) => ({
  ...(await original<typeof import("@/lib/borradores/pagos-por-revisar")>()),
  leerPagosPorRevisar: vi.fn(),
}));

// ── Importaciones post-mock ────────────────────────────────────────────────────

import { auth } from "@/lib/auth/auth";
import { leerPagosPorRevisar } from "@/lib/borradores/pagos-por-revisar";
import { ensureBorrador, generarBorrador, listarBorradores } from "@/lib/borradores/service";
import { prisma } from "@/lib/db/prisma";
import { pesos } from "@/lib/dinero";
import { GET as loteGET } from "@/app/api/facturacion/borradores/route";
import {
  GET as individualGET,
  POST as individualPOST,
} from "@/app/api/tramites/[id]/borrador/route";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSession(rol: Rol) {
  return {
    user: {
      id: "user-test-id",
      rol,
      email: "test@test.com",
      name: "Test User",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-test-id",
      userId: "user-test-id",
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "mock-token",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/facturacion/borradores${query}`);
}

/** Trámites "en BD": id → tipo de cliente. Los ids ausentes no existen. */
const TRAMITES: Record<string, "PROPIO" | "SOCIO_LM"> = {
  "tr-propio": "PROPIO",
  "tr-socio": "SOCIO_LM",
  "tr-explota": "PROPIO",
};

function borradorFake(tramiteId: string) {
  return {
    id: `b-${tramiteId}`,
    tramiteId,
    estado: "BORRADOR",
    // Fila de Prisma en CENTAVOS (columnas …Centavos, fase centavos).
    comisionCentavos: 15_000_000n,
    totalFacturaCentavos: 123_456_745n,
    lineasRevision: [],
    factura: null,
  };
}

function instalarFindUnique() {
  vi.mocked(prisma.tramiteDO.findUnique).mockImplementation(((args: {
    where: { id: string };
  }) => {
    const tipo = TRAMITES[args.where.id];
    return Promise.resolve(tipo ? { id: args.where.id, cliente: { tipo } } : null);
  }) as never);
}

function instalarListar() {
  vi.mocked(listarBorradores).mockImplementation((async (tramiteId: string) => {
    if (tramiteId === "tr-explota") {
      throw new Error("detalle interno que NO debe filtrarse");
    }
    return [borradorFake(tramiteId)];
  }) as never);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/facturacion/borradores (lote)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    vi.mocked(ensureBorrador).mockResolvedValue(undefined);
    vi.mocked(leerPagosPorRevisar).mockImplementation(
      async (ids) => new Map(ids.map((id) => [id, []])),
    );
    instalarFindUnique();
    instalarListar();
  });

  it("sin sesión → 401", async () => {
    const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    expect(res.status).toBe(401);
  });

  it("OPERATIVO → 403 (mismos roles que el GET individual)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("OPERATIVO" as Rol));
    const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    expect(res.status).toBe(403);
    expect(listarBorradores).not.toHaveBeenCalled();
  });

  it("sin tramiteIds → 400 con detalle Zod", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const res = await loteGET(makeRequest(""));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("Payload invalido");
  });

  it("tramiteIds vacío o solo comas → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const res = await loteGET(makeRequest("?tramiteIds=,%20,"));
    expect(res.status).toBe(400);
  });

  it("más de 100 ids → 400", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    const ids = Array.from({ length: 101 }, (_, i) => `tr-${i}`).join(",");
    const res = await loteGET(makeRequest(`?tramiteIds=${ids}`));
    expect(res.status).toBe(400);
    expect(listarBorradores).not.toHaveBeenCalled();
  });

  it("ADMIN: cada id lleva su payload o su error, sin bloquear al resto", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await loteGET(
      makeRequest("?tramiteIds=tr-propio,no-existe,tr-explota,tr-socio"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const body = await json(res);
    const porTramite = body.porTramite as Record<string, Record<string, unknown>>;

    expect(Object.keys(porTramite).sort()).toEqual(
      ["no-existe", "tr-explota", "tr-propio", "tr-socio"].sort(),
    );

    // Payload idéntico al individual: { borradores } con BigInt → string. El
    // ADMIN recibe además los pagos con asesoría por revisar (vacío aquí).
    expect(porTramite["tr-propio"]).toEqual({
      borradores: [
        {
          id: "b-tr-propio",
          tramiteId: "tr-propio",
          estado: "BORRADOR",
          // El serializador quita el sufijo y emite PESOS con 2 decimales.
          comision: "150000.00",
          totalFactura: "1234567.45",
          lineasRevision: [],
          factura: null,
          pagosPorRevisar: [],
        },
      ],
    });
    expect(porTramite["tr-socio"]).toEqual({
      borradores: [expect.objectContaining({ id: "b-tr-socio" })],
    });

    // Mismos mensajes que el individual.
    expect(porTramite["no-existe"]).toEqual({ error: "Trámite no encontrado" });
    // Error inesperado → mensaje genérico, sin filtrar el detalle interno.
    expect(porTramite["tr-explota"]).toEqual({
      error: "Error al cargar los borradores del trámite",
    });

    // Red de seguridad ensureBorrador se aplicó a los trámites con permiso.
    expect(ensureBorrador).toHaveBeenCalledWith("tr-propio", "user-test-id");
    expect(ensureBorrador).toHaveBeenCalledWith("tr-socio", "user-test-id");
    expect(ensureBorrador).not.toHaveBeenCalledWith("no-existe", expect.anything());
  });

  it("SOCIO: trámite de cliente PROPIO → error 'No autorizado'; SOCIO_LM → payload", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

    const res = await loteGET(makeRequest("?tramiteIds=tr-propio,tr-socio"));
    expect(res.status).toBe(200);

    const porTramite = (await json(res)).porTramite as Record<string, Record<string, unknown>>;
    expect(porTramite["tr-propio"]).toEqual({ error: "No autorizado" });
    expect(porTramite["tr-socio"]).toEqual({
      borradores: [expect.objectContaining({ id: "b-tr-socio" })],
    });
    // Ni ensureBorrador ni listar se ejecutan para el trámite vetado.
    expect(ensureBorrador).not.toHaveBeenCalledWith("tr-propio", expect.anything());
    expect(listarBorradores).not.toHaveBeenCalledWith("tr-propio");
    // La asesoría es un costo interno de Galcomex: el SOCIO no recibe los
    // pagos por revisar (ni siquiera se consultan).
    const borradoresSocio = (porTramite["tr-socio"] as { borradores: Array<Record<string, unknown>> })
      .borradores;
    expect(borradoresSocio.every((b) => !("pagosPorRevisar" in b))).toBe(true);
    expect(leerPagosPorRevisar).not.toHaveBeenCalled();
  });

  it("REVISOR: recibe los pagos con asesoría por revisar de cada borrador (BigInt → string)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));
    vi.mocked(leerPagosPorRevisar).mockResolvedValue(
      new Map([
        [
          "b-tr-propio",
          [
            {
              pagoId: "p-1",
              concepto: "Pago Ascinter",
              numSoporte: null,
              valor: pesos(1_200_000),
              sumaFacturas: pesos(200_000),
              cobrable: 0n,
              noCobrable: pesos(1_200_000),
              motivo: "SOBRANTE_NO_COBRADO",
            },
          ],
        ],
      ]),
    );

    const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    const porTramite = (await json(res)).porTramite as Record<
      string,
      { borradores: Array<Record<string, unknown>> }
    >;
    expect(porTramite["tr-propio"].borradores[0].pagosPorRevisar).toEqual([
      {
        pagoId: "p-1",
        concepto: "Pago Ascinter",
        numSoporte: null,
        valor: "1200000.00",
        sumaFacturas: "200000.00",
        cobrable: "0.00",
        noCobrable: "1200000.00",
        motivo: "SOBRANTE_NO_COBRADO",
      },
    ]);
    expect(leerPagosPorRevisar).toHaveBeenCalledWith(["b-tr-propio"]);
  });

  it("los pagos por revisar de todo el lote se leen en UNA sola consulta (no una por trámite)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const ids = Array.from({ length: 23 }, (_, i) => `lote-rev-${i}`);
    for (const id of ids) TRAMITES[id] = "PROPIO";
    vi.mocked(leerPagosPorRevisar).mockImplementation(
      async (borradorIds) =>
        new Map(
          borradorIds
            .filter((id) => id === "b-lote-rev-7")
            .map((id) => [
              id,
              [
                {
                  pagoId: "p-7",
                  concepto: "Pago suelto",
                  numSoporte: null,
                  valor: pesos(500_000),
                  sumaFacturas: 0n,
                  cobrable: pesos(500_000),
                  noCobrable: 0n,
                  motivo: "PAGO_SIN_FACTURAS" as const,
                },
              ],
            ]),
        ),
    );

    try {
      // Grupos de 10 → 3 grupos, un trámite que falla y el resto con borrador.
      const res = await loteGET(makeRequest(`?tramiteIds=${[...ids, "tr-explota"].join(",")}`));
      expect(res.status).toBe(200);
      const porTramite = (await json(res)).porTramite as Record<
        string,
        { borradores?: Array<Record<string, unknown>>; error?: string }
      >;

      expect(leerPagosPorRevisar).toHaveBeenCalledTimes(1);
      expect([...vi.mocked(leerPagosPorRevisar).mock.calls[0][0]].sort()).toEqual(
        ids.map((id) => `b-${id}`).sort(),
      );
      expect(porTramite["tr-explota"]).toEqual({
        error: "Error al cargar los borradores del trámite",
      });
      expect(porTramite["lote-rev-7"].borradores?.[0].pagosPorRevisar).toEqual([
        expect.objectContaining({ pagoId: "p-7", valor: "500000.00", motivo: "PAGO_SIN_FACTURAS" }),
      ]);
      for (const id of ids.filter((i) => i !== "lote-rev-7")) {
        expect(porTramite[id].borradores?.[0].pagosPorRevisar, id).toEqual([]);
      }
    } finally {
      for (const id of ids) delete TRAMITES[id];
    }
  });

  it("si no se pueden leer los pagos por revisar, el revisor igual ve sus borradores (sin el aviso)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    vi.mocked(leerPagosPorRevisar).mockRejectedValue(new Error("auditoría no disponible"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const res = await loteGET(makeRequest("?tramiteIds=tr-propio"));
      const porTramite = (await json(res)).porTramite as Record<
        string,
        { borradores: Array<Record<string, unknown>> }
      >;
      expect(porTramite["tr-propio"].borradores).toEqual([
        expect.objectContaining({ id: "b-tr-propio" }),
      ]);
      expect("pagosPorRevisar" in porTramite["tr-propio"].borradores[0]).toBe(false);
    } finally {
      consola.mockRestore();
    }
  });

  it("ids duplicados se colapsan: una sola carga por trámite", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const res = await loteGET(
      makeRequest("?tramiteIds=tr-propio,tr-propio,%20tr-socio%20,tr-socio"),
    );
    expect(res.status).toBe(200);

    const porTramite = (await json(res)).porTramite as Record<string, unknown>;
    expect(Object.keys(porTramite).sort()).toEqual(["tr-propio", "tr-socio"]);
    expect(listarBorradores).toHaveBeenCalledTimes(2);
  });

  it("procesa en grupos de 10: nunca más de 10 cargas en vuelo", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));

    const ids = Array.from({ length: 25 }, (_, i) => `lote-${i}`);
    for (const id of ids) TRAMITES[id] = "PROPIO";

    let enVuelo = 0;
    let maxEnVuelo = 0;
    vi.mocked(listarBorradores).mockImplementation((async (tramiteId: string) => {
      enVuelo += 1;
      maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await new Promise((resolve) => setTimeout(resolve, 2));
      enVuelo -= 1;
      return [borradorFake(tramiteId)];
    }) as never);

    try {
      const res = await loteGET(makeRequest(`?tramiteIds=${ids.join(",")}`));
      expect(res.status).toBe(200);

      const porTramite = (await json(res)).porTramite as Record<string, unknown>;
      expect(Object.keys(porTramite)).toHaveLength(25);
      expect(listarBorradores).toHaveBeenCalledTimes(25);
      expect(maxEnVuelo).toBeLessThanOrEqual(10);
      expect(maxEnVuelo).toBeGreaterThan(1);
    } finally {
      for (const id of ids) delete TRAMITES[id];
    }
  });

  it("paridad: para el mismo trámite, el lote devuelve exactamente el body del GET individual", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("REVISOR" as Rol));

    const individual = await individualGET(
      new NextRequest("http://localhost/api/tramites/tr-propio/borrador"),
      { params: Promise.resolve({ id: "tr-propio" }) },
    );
    expect(individual.status).toBe(200);
    const bodyIndividual = await json(individual);

    const lote = await loteGET(makeRequest("?tramiteIds=tr-propio"));
    const porTramite = (await json(lote)).porTramite as Record<string, unknown>;

    expect(porTramite["tr-propio"]).toEqual(bodyIndividual);
  });

  it("paridad de errores: el GET individual sigue respondiendo 404 / 403 con el mismo mensaje", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("SOCIO" as Rol));

    const noExiste = await individualGET(
      new NextRequest("http://localhost/api/tramites/no-existe/borrador"),
      { params: Promise.resolve({ id: "no-existe" }) },
    );
    expect(noExiste.status).toBe(404);
    expect(await json(noExiste)).toEqual({ error: "Trámite no encontrado" });

    const vetado = await individualGET(
      new NextRequest("http://localhost/api/tramites/tr-propio/borrador"),
      { params: Promise.resolve({ id: "tr-propio" }) },
    );
    expect(vetado.status).toBe(403);
    expect(await json(vetado)).toEqual({ error: "No autorizado" });
  });
});

describe("POST /api/tramites/[id]/borrador — el borrador recién generado trae sus pagos por revisar", () => {
  const generar = () =>
    individualPOST(
      new NextRequest("http://localhost/api/tramites/tr-propio/borrador", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "tr-propio" }) },
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession("ADMIN" as Rol));
    vi.mocked(generarBorrador).mockResolvedValue(borradorFake("tr-propio") as never);
  });

  it("ADMIN: 201 con pagosPorRevisar y su motivo (BigInt → string), como el GET", async () => {
    vi.mocked(leerPagosPorRevisar).mockResolvedValue(
      new Map([
        [
          "b-tr-propio",
          [
            {
              pagoId: "p-9",
              concepto: "Transferencia transporte",
              numSoporte: null,
              valor: pesos(650_000),
              sumaFacturas: pesos(1_000_000),
              cobrable: pesos(650_000),
              noCobrable: 0n,
              motivo: "SOBRANTE_COBRADO",
            },
          ],
        ],
      ]),
    );

    const res = await generar();
    expect(res.status).toBe(201);
    const borrador = (await json(res)).borrador as Record<string, unknown>;
    expect(borrador.id).toBe("b-tr-propio");
    expect(borrador.pagosPorRevisar).toEqual([
      {
        pagoId: "p-9",
        concepto: "Transferencia transporte",
        numSoporte: null,
        valor: "650000.00",
        sumaFacturas: "1000000.00",
        cobrable: "650000.00",
        noCobrable: "0.00",
        motivo: "SOBRANTE_COBRADO",
      },
    ]);
    expect(leerPagosPorRevisar).toHaveBeenCalledWith(["b-tr-propio"]);
  });

  it("sin pagos por revisar → lista vacía; si no se pueden leer → sin el campo, y el borrador igual sale", async () => {
    vi.mocked(leerPagosPorRevisar).mockResolvedValue(new Map());
    const vacio = (await json(await generar())).borrador as Record<string, unknown>;
    expect(vacio.pagosPorRevisar).toEqual([]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(leerPagosPorRevisar).mockRejectedValue(new Error("BD caída"));
    const res = await generar();
    expect(res.status).toBe(201);
    const sinCampo = (await json(res)).borrador as Record<string, unknown>;
    expect(sinCampo.id).toBe("b-tr-propio");
    expect("pagosPorRevisar" in sinCampo).toBe(false);
    errorSpy.mockRestore();
  });
});
