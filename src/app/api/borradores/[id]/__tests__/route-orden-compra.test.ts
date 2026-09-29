/**
 * B4 (Diseño B) — PATCH /api/borradores/[id]: el freno de la orden de compra
 * llega al cliente del API. Con el servicio mockeado se comprueba lo que la
 * RUTA hace: pasa el rol de la sesión y el `motivoExcepcionOc`, responde
 * `codigo` + `detalle` en 422/403 y valida el motivo con Zod (10–500). La regla
 * de negocio se prueba con la BD en `orden-compra-service.test.ts`.
 */
import { EstadoBorrador } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Rol } from "@/lib/auth/auth";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock("@/lib/borradores/service", () => ({ transicionarBorrador: vi.fn(), getBorradorCompleto: vi.fn() }));
vi.mock("@/lib/borradores/orden-compra-service", () => ({ evaluarOcSinRomper: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth/auth", () => {
  const getSession = vi.fn();
  return { auth: { api: { getSession } }, roles: ["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"] as const };
});

import { PATCH } from "@/app/api/borradores/[id]/route";
import { auth } from "@/lib/auth/auth";
import { transicionarBorrador } from "@/lib/borradores/service";

function sesion(rol: Rol) {
  return {
    user: { id: `u-${rol}`, email: `${rol}@example.test`, name: rol, rol, activo: true, debeCambiarPassword: false },
    session: { id: "s-1", expiresAt: new Date(Date.now() + 3_600_000) },
  } as never;
}

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/borradores/b1", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: "b1" }) },
  );
}

const DETALLE = { estado: "NO_CUADRA", numero: "OC11104", valorOc: "539000", base: "427000", diferencia: "-112000" };

describe("PATCH /api/borradores/[id] — orden de compra (B4)", () => {
  beforeEach(() => {
    vi.mocked(transicionarBorrador).mockReset();
  });

  it("OC_NO_CUADRA: 422 con `codigo`, el mensaje en pesos y el `detalle` de la evaluación", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion("REVISOR"));
    vi.mocked(transicionarBorrador).mockResolvedValueOnce({
      ok: false,
      status: 422,
      codigo: "OC_NO_CUADRA",
      message: "La factura suma $427.000 sin impuestos y la orden de compra OC11104 es de $539.000: faltan $112.000.",
      detalle: DETALLE,
    });

    const res = await patch({ nuevoEstado: EstadoBorrador.APROBADO });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "La factura suma $427.000 sin impuestos y la orden de compra OC11104 es de $539.000: faltan $112.000.",
      codigo: "OC_NO_CUADRA",
      detalle: DETALLE,
    });
  });

  it("pasa al servicio el ROL de la sesión y el motivo (el servicio decide si alcanza)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion("ADMIN"));
    vi.mocked(transicionarBorrador).mockResolvedValueOnce({
      ok: true,
      borrador: { id: "b1", tramiteId: "t1", formatoFactura: "COMISION", estado: EstadoBorrador.APROBADO } as never,
    });

    const res = await patch({ nuevoEstado: EstadoBorrador.APROBADO, motivoExcepcionOc: "  Cliente aceptó la diferencia por correo  " });
    expect(res.status).toBe(200);
    expect(transicionarBorrador).toHaveBeenCalledWith(
      expect.objectContaining({
        borradorId: "b1",
        nuevoEstado: EstadoBorrador.APROBADO,
        usuarioId: "u-ADMIN",
        rolUsuario: "ADMIN",
        motivoExcepcionOc: "Cliente aceptó la diferencia por correo",
      }),
    );
  });

  it("REVISOR con motivo: el servicio responde 403 EXCEPCION_OC_SOLO_ADMIN y la ruta lo entrega tal cual", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion("REVISOR"));
    vi.mocked(transicionarBorrador).mockResolvedValueOnce({
      ok: false,
      status: 403,
      codigo: "EXCEPCION_OC_SOLO_ADMIN",
      message: "Solo la administradora puede aprobar una factura que no cuadra con la orden de compra.",
      detalle: DETALLE,
    });

    const res = await patch({ nuevoEstado: EstadoBorrador.APROBADO, motivoExcepcionOc: "Cliente aceptó la diferencia por correo" });
    expect(res.status).toBe(403);
    expect((await res.json()).codigo).toBe("EXCEPCION_OC_SOLO_ADMIN");
    expect(transicionarBorrador).toHaveBeenCalledWith(expect.objectContaining({ rolUsuario: "REVISOR" }));
  });

  it("un motivo demasiado corto o demasiado largo es 400 de validación (Zod) y ni llega al servicio", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(sesion("ADMIN"));
    const corto = await patch({ nuevoEstado: EstadoBorrador.APROBADO, motivoExcepcionOc: "ok ok" });
    expect(corto.status).toBe(400);
    const largo = await patch({ nuevoEstado: EstadoBorrador.APROBADO, motivoExcepcionOc: "x".repeat(501) });
    expect(largo.status).toBe(400);
    expect(transicionarBorrador).not.toHaveBeenCalled();
  });
});
