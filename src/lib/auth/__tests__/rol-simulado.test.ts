/**
 * «Probar como otro rol»: la regla pura (`resolverRolEfectivo`), la lectura de
 * la cookie y `getSesionCruda` (donde se aplica el rol probado). Sin BD:
 * `auth.api.getSession` y la cabecera `Cookie` se controlan a mano.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(estado.cookie ? { cookie: estado.cookie } : {}),
}));

class RedireccionDePrueba extends Error {
  constructor(public readonly destino: string) {
    super(`redirect:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedireccionDePrueba(destino);
  },
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
  roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
}));

import { NextResponse } from "next/server";

import { auth, type Rol } from "@/lib/auth/auth";
import { exigirAccesoPagina } from "@/lib/auth/page-guard";
import {
  COOKIE_ROL_SIMULADO,
  COOKIE_ROL_SIMULADO_PRODUCCION,
  DURACION_SIMULACION_SEG,
  ETIQUETA_ROL_SIMULABLE,
  ROLES_SIMULABLES,
  esRolSimulable,
  leerCookie,
  nombreCookieRolSimulado,
  opcionesCookieRolSimulado,
  resolverRolEfectivo,
  valorCookieRolSimulado,
} from "@/lib/auth/rol-simulado";
import { getSesionCruda, getSimulacionActual, requireRole } from "@/lib/auth/session";

const ID = "cmadmin1";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("nombre y atributos de la cookie", () => {
  it("fuera de producción: nombre simple y sin Secure", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(nombreCookieRolSimulado()).toBe("galcomex_rol_simulado");
    expect(opcionesCookieRolSimulado()).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });
  });

  it("en producción: prefijo __Host- (Secure, path=/, sin Domain)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(COOKIE_ROL_SIMULADO_PRODUCCION).toBe("__Host-galcomex_rol_simulado");
    expect(nombreCookieRolSimulado()).toBe("__Host-galcomex_rol_simulado");
    const opciones = opcionesCookieRolSimulado();
    expect(opciones).toMatchObject({ httpOnly: true, secure: true, path: "/" });
    expect(opciones).not.toHaveProperty("domain");
  });

  it("el valor es ROL.userId", () => {
    expect(valorCookieRolSimulado("OPERATIVO", ID)).toBe("OPERATIVO.cmadmin1");
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
  it.each(ROLES_SIMULABLES)("ADMIN con la cookie «%s.<su id>» simula ese rol", (rol) => {
    expect(resolverRolEfectivo("ADMIN", `${rol}.${ID}`, ID)).toEqual({ rol, simulado: rol });
  });

  it("ADMIN con SOCIO.<su id> → SOCIO", () => {
    expect(resolverRolEfectivo("ADMIN", `SOCIO.${ID}`, ID)).toEqual({
      rol: "SOCIO",
      simulado: "SOCIO",
    });
  });

  it("el userId no coincide con el de la sesión → sin cambio (otra persona en el mismo navegador)", () => {
    for (const rol of ROLES_SIMULABLES) {
      expect(resolverRolEfectivo("ADMIN", `${rol}.cmotraadmin`, ID)).toEqual({
        rol: "ADMIN",
        simulado: null,
      });
    }
    // Ni siquiera un prefijo o una variante del id sirve: coincidencia exacta.
    for (const valor of [`SOCIO.${ID}x`, `SOCIO.${ID.slice(0, -1)}`, `SOCIO.${ID.toUpperCase()}`]) {
      expect(resolverRolEfectivo("ADMIN", valor, ID)).toEqual({ rol: "ADMIN", simulado: null });
    }
  });

  it.each(ROLES_SIMULABLES)("formato viejo «%s» (sin userId) → sin cambio", (rol) => {
    expect(resolverRolEfectivo("ADMIN", rol, ID)).toEqual({ rol: "ADMIN", simulado: null });
  });

  it.each([
    "ADMIN",
    `ADMIN.${ID}`,
    "x",
    "",
    undefined,
    "revisor",
    `revisor.${ID}`,
    `REVISOR .${ID}`,
    `REVISOR.`,
    `.${ID}`,
    ID,
  ])("ADMIN con la cookie %j no cambia nada", (valor) => {
    expect(resolverRolEfectivo("ADMIN", valor, ID)).toEqual({ rol: "ADMIN", simulado: null });
  });

  it("sin userId en la sesión nunca simula", () => {
    expect(resolverRolEfectivo("ADMIN", "SOCIO.", "")).toEqual({ rol: "ADMIN", simulado: null });
  });

  it.each(["REVISOR", "OPERATIVO", "SOCIO"] as const)(
    "%s con la cookie de cualquier otro rol nunca sube ni cambia",
    (rolReal) => {
      for (const valor of [
        "ADMIN",
        "REVISOR",
        "OPERATIVO",
        "SOCIO",
        `ADMIN.${ID}`,
        `REVISOR.${ID}`,
        `OPERATIVO.${ID}`,
        `SOCIO.${ID}`,
        "x",
        "",
        undefined,
      ]) {
        expect(resolverRolEfectivo(rolReal, valor, ID)).toEqual({ rol: rolReal, simulado: null });
      }
    },
  );
});

describe("leerCookie", () => {
  it("encuentra la cookie entre varias y devuelve undefined si falta", () => {
    const cabecera = `session_token=abc; ${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}; otra=1`;
    expect(leerCookie(cabecera, COOKIE_ROL_SIMULADO)).toBe(`OPERATIVO.${ID}`);
    expect(leerCookie("session_token=abc", COOKIE_ROL_SIMULADO)).toBeUndefined();
    expect(leerCookie(null, COOKIE_ROL_SIMULADO)).toBeUndefined();
    expect(leerCookie("", COOKIE_ROL_SIMULADO)).toBeUndefined();
  });

  it("con la cookie repetida toma la primera", () => {
    const cabecera = `${COOKIE_ROL_SIMULADO}=SOCIO.${ID}; ${COOKIE_ROL_SIMULADO}=REVISOR.${ID}`;
    expect(leerCookie(cabecera, COOKIE_ROL_SIMULADO)).toBe(`SOCIO.${ID}`);
  });

  it("no confunde una cookie que solo termina igual", () => {
    expect(leerCookie(`x_${COOKIE_ROL_SIMULADO}=SOCIO`, COOKIE_ROL_SIMULADO)).toBeUndefined();
  });

  it("un valor con escapes rotos no lanza", () => {
    expect(leerCookie(`${COOKIE_ROL_SIMULADO}=%E0%A4%A`, COOKIE_ROL_SIMULADO)).toBe("%E0%A4%A");
  });
});

function sesion(rol: Rol, id = ID) {
  return {
    user: {
      id,
      rol,
      email: "admin@example.test",
      name: "Admin",
      emailVerified: true,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    session: {
      id: "s-1",
      userId: id,
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
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}`;

    const efectiva = await getSesionCruda();

    expect(efectiva?.user.rol).toBe("OPERATIVO");
    expect(efectiva?.user.id).toBe(ID);
    expect(efectiva?.user.email).toBe("admin@example.test");
    expect(efectiva).not.toBe(original);
    expect(original.user.rol).toBe("ADMIN");
    await expect(getSimulacionActual()).resolves.toEqual({
      rolReal: "ADMIN",
      simulado: "OPERATIVO",
    });
  });

  it("en producción lee la cookie __Host- y no la de nombre simple", async () => {
    vi.stubEnv("NODE_ENV", "production");
    usarSesion(sesion("ADMIN"));

    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}`;
    expect((await getSesionCruda())?.user.rol).toBe("ADMIN");

    estado.cookie = `${COOKIE_ROL_SIMULADO_PRODUCCION}=OPERATIVO.${ID}`;
    expect((await getSesionCruda())?.user.rol).toBe("OPERATIVO");
  });

  it("ADMIN con la cookie de OTRA persona: sigue siendo ADMIN (no hereda la simulación)", async () => {
    usarSesion(sesion("ADMIN"));
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO.cmotraadmin`;

    expect((await getSesionCruda())?.user.rol).toBe("ADMIN");
    await expect(getSimulacionActual()).resolves.toEqual({ rolReal: "ADMIN", simulado: null });
  });

  it("ADMIN con la cookie en el formato viejo (sin userId): sigue siendo ADMIN", async () => {
    usarSesion(sesion("ADMIN"));
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO`;

    expect((await getSesionCruda())?.user.rol).toBe("ADMIN");
  });

  it("REVISOR con la cookie OPERATIVO.<su id>: la sesión queda igual, sigue REVISOR", async () => {
    const original = sesion("REVISOR");
    usarSesion(original);
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}`;

    const efectiva = await getSesionCruda();

    expect(efectiva).toBe(original);
    expect(efectiva?.user.rol).toBe("REVISOR");
    await expect(getSimulacionActual()).resolves.toEqual({ rolReal: "REVISOR", simulado: null });
  });

  it.each(["OPERATIVO", "SOCIO"] as const)(
    "%s con la cookie de otro rol: la sesión queda igual",
    async (rolReal) => {
      const original = sesion(rolReal);
      usarSesion(original);
      estado.cookie = `${COOKIE_ROL_SIMULADO}=ADMIN.${ID}`;

      const efectiva = await getSesionCruda();

      expect(efectiva).toBe(original);
      expect(efectiva?.user.rol).toBe(rolReal);
      await expect(getSimulacionActual()).resolves.toEqual({ rolReal, simulado: null });
    },
  );

  it("sin sesión → null, aunque exista la cookie", async () => {
    usarSesion(null);
    estado.cookie = `${COOKIE_ROL_SIMULADO}=SOCIO.${ID}`;
    await expect(getSesionCruda()).resolves.toBeNull();
    await expect(getSimulacionActual()).resolves.toBeNull();
  });
});

describe("la simulación de verdad quita permisos de administradora (API y páginas)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estado.cookie = "";
  });

  it("con simulación activa (ADMIN + OPERATIVO.<id>): requireRole([ADMIN]) responde 403", async () => {
    usarSesion(sesion("ADMIN"));
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}`;

    const resultado = await requireRole(["ADMIN"]);

    expect(resultado).toBeInstanceOf(NextResponse);
    expect((resultado as NextResponse).status).toBe(403);
  });

  it("con simulación activa: exigirAccesoPagina(/configuracion) redirige a /sin-acceso", async () => {
    usarSesion(sesion("ADMIN"));
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.${ID}`;

    const intento = exigirAccesoPagina("/configuracion");

    await expect(intento).rejects.toBeInstanceOf(RedireccionDePrueba);
    await expect(intento).rejects.toMatchObject({
      destino: `/sin-acceso?ruta=${encodeURIComponent("/configuracion")}`,
    });
  });

  it("control: sin simulación la administradora sí pasa las dos puertas", async () => {
    usarSesion(sesion("ADMIN"));

    const resultado = await requireRole(["ADMIN"]);
    expect(resultado).not.toBeInstanceOf(NextResponse);
    await expect(exigirAccesoPagina("/configuracion")).resolves.toMatchObject({
      user: { rol: "ADMIN" },
    });
  });

  it("control: la cookie de otra persona tampoco quita permisos (se ignora)", async () => {
    usarSesion(sesion("ADMIN"));
    estado.cookie = `${COOKIE_ROL_SIMULADO}=OPERATIVO.cmotraadmin`;

    expect(await requireRole(["ADMIN"])).not.toBeInstanceOf(NextResponse);
  });
});
