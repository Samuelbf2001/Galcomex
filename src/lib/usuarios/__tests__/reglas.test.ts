/**
 * Reglas de edición de usuarios (puras): auto-desactivación, auto-degradación
 * y "siempre queda un ADMIN activo".
 */
import { describe, expect, it } from "vitest";

import {
  MENSAJE_AUTO_DESACTIVAR,
  MENSAJE_AUTO_QUITAR_ADMIN,
  MENSAJE_ULTIMO_ADMIN,
  ReglaUsuarioError,
  validarCambioUsuario,
  type EstadoUsuario,
} from "@/lib/usuarios/reglas";

const adminA: EstadoUsuario = { id: "a", rol: "ADMIN", activo: true };
const adminB: EstadoUsuario = { id: "b", rol: "ADMIN", activo: true };
const operativo: EstadoUsuario = { id: "o", rol: "OPERATIVO", activo: true };

function motivo(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ReglaUsuarioError) return error.message;
    throw error;
  }
}

describe("validarCambioUsuario", () => {
  it("un ADMIN no puede desactivarse a sí mismo aunque haya otros ADMIN", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: adminA,
          cambios: { activo: false },
          actorId: "a",
          adminsActivosIds: ["a", "b"],
        }),
      ),
    ).toBe(MENSAJE_AUTO_DESACTIVAR);
  });

  it("un ADMIN no puede quitarse su propio rol ADMIN", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: adminA,
          cambios: { rol: "REVISOR" },
          actorId: "a",
          adminsActivosIds: ["a", "b"],
        }),
      ),
    ).toBe(MENSAJE_AUTO_QUITAR_ADMIN);
  });

  it("sí puede cambiarse el nombre o reafirmar su rol", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: adminA,
          cambios: { name: "Nuevo nombre", rol: "ADMIN", activo: true },
          actorId: "a",
          adminsActivosIds: ["a"],
        }),
      ),
    ).toBeNull();
  });

  it("no deja quitar el rol al último ADMIN activo (cambio hecho por otro actor)", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: adminB,
          cambios: { rol: "OPERATIVO" },
          actorId: "script",
          adminsActivosIds: ["b"],
        }),
      ),
    ).toBe(MENSAJE_ULTIMO_ADMIN);
  });

  it("no deja desactivar al último ADMIN activo", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: adminB,
          cambios: { activo: false },
          actorId: "script",
          adminsActivosIds: ["b"],
        }),
      ),
    ).toBe(MENSAJE_ULTIMO_ADMIN);
  });

  it("con otro ADMIN activo, sí se puede desactivar o degradar a un ADMIN ajeno", () => {
    for (const cambios of [{ activo: false }, { rol: "SOCIO" as const }]) {
      expect(
        motivo(() =>
          validarCambioUsuario({
            objetivo: adminB,
            cambios,
            actorId: "a",
            adminsActivosIds: ["a", "b"],
          }),
        ),
      ).toBeNull();
    }
  });

  it("un ADMIN desactivado no cuenta: reactivarlo o degradarlo no toca la regla", () => {
    const inactivo: EstadoUsuario = { id: "c", rol: "ADMIN", activo: false };
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: inactivo,
          cambios: { rol: "REVISOR" },
          actorId: "a",
          adminsActivosIds: ["a"],
        }),
      ),
    ).toBeNull();
  });

  it("desactivar o cambiar el rol de un no-ADMIN siempre pasa", () => {
    expect(
      motivo(() =>
        validarCambioUsuario({
          objetivo: operativo,
          cambios: { activo: false, rol: "SOCIO" },
          actorId: "a",
          adminsActivosIds: ["a"],
        }),
      ),
    ).toBeNull();
  });

  it("el error de regla responde 422", () => {
    expect(new ReglaUsuarioError("x").status).toBe(422);
  });
});
