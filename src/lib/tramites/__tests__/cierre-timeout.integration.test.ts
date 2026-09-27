/**
 * CxP v2 — cerrar un DO mientras un pago en bloque retiene su candado.
 *
 * Cerrar el DO bloquea su fila (`bloquearTramites`, FOR UPDATE) dentro de
 * `transitionTramite`. Los pagos en bloque y la anulación de bloque retienen
 * ese mismo candado hasta 30 s (su transacción tiene `timeout: 30_000`). Con
 * el timeout por defecto de Prisma (5 s) el cierre vencía (P2028) y la ruta
 * `/api/tramites/[id]/estado` respondía 500.
 *
 * Lo que se prueba:
 *  - integración (Postgres real): con el candado del DO retenido 7 s por otra
 *    transacción, el cierre ESPERA y cierra (antes: P2028 a los 5 s);
 *  - ruta: si aun así la transacción vence (P2028) o choca (P2034), responde
 *    409 `DO_OCUPADO` con un mensaje para reintentar, no 500; cualquier otro
 *    error de Prisma se sigue relanzando.
 *
 * La parte de integración requiere DATABASE_URL de una base desechable
 * migrada (+ seed); sin BD se omite, igual que el resto de pruebas de
 * integración.
 */
import "dotenv/config";

import { EstadoTramite, Prisma, Rol } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return {
    auth: { api: { getSession } },
    roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
  };
});

// `transitionTramite` real por defecto; la parte de la ruta le inyecta el
// error de Prisma con `mockRejectedValueOnce` (retener un candado 35 s en una
// prueba no es razonable).
vi.mock("@/lib/tramites/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tramites/service")>();
  return { ...real, transitionTramite: vi.fn(real.transitionTramite) };
});

// ── Importaciones post-mock ───────────────────────────────────────────────────

import { POST as estadoPOST } from "@/app/api/tramites/[id]/estado/route";
import { auth } from "@/lib/auth/auth";
import {
  crearTramiteTest,
  ensureDb,
  liberarBdAlmacarga,
  prepararBdAlmacarga,
} from "@/lib/cxp/__tests__/fixtures/almacarga";
import { bloquearTramites } from "@/lib/cxp/bloqueos";
import { prisma } from "@/lib/db/prisma";
import { transitionTramite } from "@/lib/tramites/service";

// ── Utilidades ────────────────────────────────────────────────────────────────

/** Más que el timeout por defecto de Prisma (5 s) y menos que el del cierre (35 s). */
const RETENCION_MS = 7_000;
const DIA = 86_400_000;

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sesionAdmin() {
  return {
    user: {
      id: "usuario-cierre-timeout",
      rol: Rol.ADMIN,
      email: "vitest-cierre-timeout@example.test",
      name: "Vitest Cierre Timeout",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "session-cierre-timeout",
      userId: "usuario-cierre-timeout",
      expiresAt: new Date(Date.now() + DIA),
      token: "token-cierre-timeout",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      ipAddress: null as string | null | undefined,
      userAgent: null as string | null | undefined,
    },
  };
}

function cerrarRequest(tramiteId: string) {
  return new NextRequest(`http://localhost/api/tramites/${tramiteId}/estado`, {
    method: "POST",
    body: JSON.stringify({ estado: EstadoTramite.CERRADO }),
    headers: { "content-type": "application/json" },
  });
}

function errorPrisma(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(prepararBdAlmacarga);
afterAll(liberarBdAlmacarga);

afterEach(() => {
  vi.mocked(transitionTramite).mockReset();
  vi.mocked(auth.api.getSession).mockReset();
});

// ── Integración: el cierre espera el candado del pago en bloque ──────────────

describe("Cerrar el DO con su candado retenido por otra operación de CxP", () => {
  it("el candado del DO retenido 7 s (más que los 5 s por defecto de Prisma): el cierre espera y cierra, sin P2028", async (ctx) => {
    const db = ensureDb(ctx);
    // Aquí corre la transición real, sin errores inyectados.
    const real = await vi.importActual<typeof import("@/lib/tramites/service")>("@/lib/tramites/service");
    vi.mocked(transitionTramite).mockImplementation(real.transitionTramite);

    const tramiteId = await crearTramiteTest(db, { estado: EstadoTramite.PAGADO });

    // Otra transacción (como crearPagoMultiDO o anularPagoGrupo) toma el
    // candado del DO y lo retiene RETENCION_MS antes de confirmar.
    let avisarBloqueado: () => void = () => {};
    const bloqueado = new Promise<void>((r) => {
      avisarBloqueado = r;
    });
    const retenedor = prisma.$transaction(
      async (tx) => {
        await bloquearTramites(tx, [tramiteId]);
        avisarBloqueado();
        await esperar(RETENCION_MS);
      },
      { maxWait: 10_000, timeout: RETENCION_MS + 10_000 },
    );
    await bloqueado;

    const inicio = Date.now();
    const cierre = transitionTramite(tramiteId, EstadoTramite.CERRADO, db.userId, false, Rol.ADMIN);
    const [rr, rc] = await Promise.allSettled([retenedor, cierre] as const);
    const espera = Date.now() - inicio;

    expect(rr.status).toBe("fulfilled");
    if (rc.status === "rejected") {
      const reason: unknown = rc.reason;
      const code = reason instanceof Prisma.PrismaClientKnownRequestError ? reason.code : "sin código";
      throw new Error(`El cierre falló (${code}): ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    expect(rc.value.ok, rc.value.ok ? "" : rc.value.message).toBe(true);
    // Esperó de verdad al candado (margen por la resolución de los relojes).
    expect(espera).toBeGreaterThanOrEqual(RETENCION_MS - 1_000);

    const tramite = await prisma.tramiteDO.findUniqueOrThrow({ where: { id: tramiteId } });
    expect(tramite.estado).toBe(EstadoTramite.CERRADO);
  }, 30_000);
});

// ── Ruta: si la transacción vence igual, 409 para reintentar ─────────────────

describe("POST /api/tramites/[id]/estado — DO ocupado", () => {
  it.each([
    ["P2028", "Transaction already closed: A commit cannot be executed on an expired transaction."],
    ["P2034", "Transaction failed due to a write conflict or a deadlock. Please retry your transaction"],
  ])("%s → 409 DO_OCUPADO con mensaje para reintentar", async (code, message) => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesionAdmin());
    vi.mocked(transitionTramite).mockRejectedValueOnce(errorPrisma(code, message));

    const res = await estadoPOST(cerrarRequest("tramite-ocupado"), {
      params: Promise.resolve({ id: "tramite-ocupado" }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "El DO está ocupado registrando un pago; reintenta en unos segundos.",
      codigo: "DO_OCUPADO",
    });
  });

  it("otro error de Prisma (P2002) no se disfraza de DO ocupado: se relanza", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesionAdmin());
    const otro = errorPrisma("P2002", "Unique constraint failed");
    vi.mocked(transitionTramite).mockRejectedValueOnce(otro);

    await expect(
      estadoPOST(cerrarRequest("tramite-otro"), { params: Promise.resolve({ id: "tramite-otro" }) }),
    ).rejects.toBe(otro);
  });
});
