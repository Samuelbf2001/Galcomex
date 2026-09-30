/**
 * «Probar como otro rol»: la regla pura (`resolverRolEfectivo`), la lectura de
 * la cookie y `getSesionCruda` (donde se aplica el rol probado). Sin BD:
 * `auth.api.getSession` y la cabecera `Cookie` se controlan a mano.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(estado.cookie ? { cookie: estado.cookie } : {}),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
  roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
}));

import { auth, type Rol } from "@/lib/auth/auth";
import {
  COOKIE_ROL_SIMULADO,
  DURACION_SIMULACION_SEG,
  ETIQUETA_ROL_SIMULABLE,
  ROLES_SIMULABLES,
  esRolSimulable,
  leerCookie,
  resolverRolEfectivo,
} from "@/lib/auth/rol-simulado";
import { getSesionCruda, getSimulacionActual } from "@/lib/auth/session";

describe("constantes", () => {
  it("la cookie, los roles simulables (sin ADMIN) y la duración de 4 h", () => {
    expect(COOKIE_ROL_SIMULADO).toBe("galcomex_rol_simulado");
    expect([...ROLES_SIMULABLES]).toEqual(["REVISOR", "OPERATIVO", "SOCIO"]);
    expect(DURACION_SIMULACION_SEG).toBe(14_400);
  });

  it("cada rol simulable tiene su etiqueta en español", () => {
    expect(ETIQUETA_ROL_SIMULABLE).toEqual({
      REVISOR: "Revisor (Guillermo)",
      OPERATIVO: "Operativo (Karina)",
      SOCIO: "Socio (Lucho)",
    });
  });
});

describe("esRolSimulable", () => {
  it("acepta los tres roles y rechaza ADMIN, minúsculas y valores raros", () => {
    for (const rol of ROLES_SIMULABLES) expect(esRolSimulable(rol)).toBe(true);
    for (const valor of ["ADMIN", "revisor", "x", "", undefined, null, 1, {}]) {
      expect(esRolSimulable(valor)).toBe(false);
    }
  });
});

describe("resolverRolEfectivo", () => {
  it.each(ROLES_SIMULABLES)("ADMIN con la cookie «%s» simula ese rol", (rol) => {
    expect(resolverRolEfectivo("ADMIN", rol)).toEqual({ rol, simulado: rol });
  });

  it.each(["ADMIN", "x", "", undefined, "revisor", "REVISOR "])(
    "ADMIN con la cookie %j no cambia nada",
    (valor) => {
      expect(resolverRolEfectivo("ADMIN", valor)).toEqual({ rol: "ADMIN", simulado: null });
    },
  );

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "%s con la cookie de cualquier otro rol nunca sube ni cambia",
    (rolReal) => {
      for (const valor of ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO", "x", "", undefined]) {
        expect(resolverRolEfectivo(rolReal, valor)).toEqual({ rol: rolReal, simulado: null });
      }
    },
  );
});

describe("leerCookie", () => {
  it("encuentra la cookie entre varias y devuelve undefined si falta", () => {
    const cabecera = `session_token=abc; ${COOKIE_ROL_SIMULADO}=OPERATIVO; otra=1`;
    expect(leerCookie(cabecera, COOKIE_ROL_SIMULADO)).toBe("OPERATIVO");
    expect(leerCookie("session_token=abc", COOKIE_ROL_SIMULADO)).toBeUndefined();
    expect(leerCookie(null, COOKIE_ROL_SIMULADO)).toBeUndefined();
    expect(leerCookie("", COOKIE_ROL_SIMULADO)).toBeUndefined();
  });

  it("no confunde una cookie que solo termina igual", () => {
    expect(leerCookie(`x_${COOKIE_ROL_SIMULADO}=SOCIO`, COOKIE_ROL_SIMULADO)).toBeUndefined();
  });

  it("un valor con escapes rotos no lanza", () => {
    expect(leerCookie(`${COOKIE_ROL_SIMULADO}=%E0%A4%A`, COOKIE_ROL_SIMULADO)).toBe("%E0%A4%A");
  });
});

function sesion(rol: Rol) {
  return {
    user: {
      id: "admin-1",
      rol,
      email: "admin@example.test",
      name: "Admin",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "s-1",
      userId: "admin-1",
      expiresAt: new Date(Date.now() + 86_400_000),
      token: "t",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  };
}

function usarSesion(valor: ReturnType<typeof sesion> | null) {
  vi.mocked(auth.api.getSession).mockResolvedValue(valor as never);
}

describe("getSesionCruda (donde se aplica el rol probado)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estado.cookie = "";
  });

  it("ADMIN con la cookie: devuelve el rol probado, misma identidad y NO muta el original", async () => {
    const original = sesion("ADMIN");
    usarSesion(original);
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO`;

    const efectiva = await getSesionCruda();

    expect(efectiva?.user.rol).toBe("OPERATIVO");
    expect(efectiva?.user.id).toBe("admin-1");
    expect(efectiva?.user.email).toBe("admin@example.test");
    expect(efectiva).not.toBe(original);
    expect(original.user.rol).toBe("ADMIN");
    await expect(getSimulacionActual()).resolves.toEqual({
      rolReal: "ADMIN",
      simulado: "OPERATIVO",
    });
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "%s con la cookie de otro rol: la sesión queda igual",
    async (rolReal) => {
      const original = sesion(rolReal);
      usarSesion(original);
      estado.cookie = `${COOKIE_ROL_SIMULADO}=ADMIN`;

      const efectiva = await getSesionCruda();

      expect(efectiva).toBe(original);
      expect(efectiva?.user.rol).toBe(rolReal);
      await expect(getSimulacionActual()).resolves.toEqual({ rolReal, simulado: null });
    },
  );

  it("sin sesión → null, aunque exista la cookie", async () => {
    usarSesion(null);
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO`;
    await expect(getSesionCruda()).resolves.toBeNull();
    await expect(getSimulacionActual()).resolves.toBeNull();
  });
});
