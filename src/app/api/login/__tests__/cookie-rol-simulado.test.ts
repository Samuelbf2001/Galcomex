/**
 * POST /api/login — un inicio de sesión exitoso borra la cookie de «Probar
 * como otro rol» que hubiera quedado en el navegador (y conserva TODAS las
 * cookies de Better Auth). Sin BD: `auth.api.signInEmail` se controla a mano.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { signInEmail: vi.fn() } },
  roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const,
}));

import { POST } from "@/app/api/login/route";
import { auth } from "@/lib/auth/auth";
import { resetRateLimitParaTests } from "@/lib/http/rate-limit";

function respuestaAuth(status: number, cuerpo: unknown, cookies: string[] = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(cuerpo), { status, headers });
}

function reqLogin() {
  return new NextRequest("http://localhost/api/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "admin@example.test", password: "ClaveSegura-2026" }),
  });
}

/** Los `set-cookie` de la respuesta, con el nombre de cada cookie. */
function cookiesDe(res: Response) {
  return res.headers.getSetCookie().map((linea) => ({ nombre: linea.split("=")[0], linea }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitParaTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/login y la cookie de «Probar como otro rol»", () => {
  it("un inicio exitoso borra la cookie y conserva las cookies de Better Auth", async () => {
    vi.mocked(auth.api.signInEmail).mockResolvedValue(
      respuestaAuth(200, { user: { id: "admin-1" } }, [
        "better-auth.session_token=abc; Path=/; HttpOnly",
        "better-auth.session_data=xyz; Path=/; HttpOnly",
      ]) as never,
    );

    const res = await POST(reqLogin());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const cookies = cookiesDe(res);
    expect(cookies.map((c) => c.nombre)).toEqual(
      expect.arrayContaining([
        "galcomex_rol_simulado",
        "better-auth.session_token",
        "better-auth.session_data",
      ]),
    );
    expect(res.cookies.get("galcomex_rol_simulado")).toMatchObject({
      value: "",
      maxAge: 0,
      path: "/",
      httpOnly: true,
    });
    const borrada = cookies.find((c) => c.nombre === "galcomex_rol_simulado");
    expect(borrada?.linea).toMatch(/Max-Age=0/i);
  });

  it("en producción borra la cookie con el nombre __Host- (Secure, path=/)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(auth.api.signInEmail).mockResolvedValue(
      respuestaAuth(200, { user: { id: "admin-1" } }, ["better-auth.session_token=abc; Path=/"]) as never,
    );

    const res = await POST(reqLogin());

    const borrada = cookiesDe(res).find((c) => c.nombre === "__Host-galcomex_rol_simulado");
    expect(borrada).toBeDefined();
    expect(borrada?.linea).toMatch(/Max-Age=0/i);
    expect(borrada?.linea).toMatch(/Secure/i);
    expect(borrada?.linea).toMatch(/Path=\//);
    expect(borrada?.linea).not.toMatch(/Domain=/i);
    expect(cookiesDe(res).map((c) => c.nombre)).toContain("better-auth.session_token");
  });

  it("un inicio fallido no toca la cookie", async () => {
    vi.mocked(auth.api.signInEmail).mockResolvedValue(
      respuestaAuth(401, { message: "credenciales" }) as never,
    );

    const res = await POST(reqLogin());

    expect(res.status).toBe(401);
    expect(cookiesDe(res)).toEqual([]);
  });
});
