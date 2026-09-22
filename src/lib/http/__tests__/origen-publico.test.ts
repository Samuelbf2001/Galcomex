import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { origenPublico } from "@/lib/http/origen-publico";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/x", { headers });
}

describe("origenPublico", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("usa APP_URL cuando apunta a un dominio real", () => {
    vi.stubEnv("APP_URL", "https://galcomex.sixteam.pro/");
    expect(origenPublico(req())).toBe("https://galcomex.sixteam.pro");
  });

  it("ignora APP_URL de localhost y usa las cabeceras del proxy", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const r = req({ "x-forwarded-host": "galcomex.sixteam.pro", "x-forwarded-proto": "https" });
    expect(origenPublico(r)).toBe("https://galcomex.sixteam.pro");
  });

  it("sin configuración ni proxy cae al origen local", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(origenPublico(req())).toBe("http://localhost:3000");
  });
});
