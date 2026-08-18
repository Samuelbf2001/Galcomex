/**
 * Test unitario puro (sin BD) de la regla de acceso a documentos por cliente.
 * Reutiliza el mismo criterio que resolverTramiteConPermiso
 * (src/lib/auth/tramite-acceso.ts): SOCIO solo ve clientes SOCIO_LM.
 */
import { TipoCliente } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { puedeVerDocumentosDeCliente } from "../acceso-cliente";

describe("puedeVerDocumentosDeCliente", () => {
  it("SOCIO puede ver documentos de un cliente SOCIO_LM", () => {
    expect(puedeVerDocumentosDeCliente("SOCIO", TipoCliente.SOCIO_LM)).toBe(true);
  });

  it("SOCIO NO puede ver documentos de un cliente PROPIO", () => {
    expect(puedeVerDocumentosDeCliente("SOCIO", TipoCliente.PROPIO)).toBe(false);
  });

  it.each(["ADMIN", "REVISOR", "OPERATIVO"] as const)(
    "%s puede ver documentos de un cliente PROPIO",
    (rol) => {
      expect(puedeVerDocumentosDeCliente(rol, TipoCliente.PROPIO)).toBe(true);
    },
  );

  it.each(["ADMIN", "REVISOR", "OPERATIVO"] as const)(
    "%s puede ver documentos de un cliente SOCIO_LM",
    (rol) => {
      expect(puedeVerDocumentosDeCliente(rol, TipoCliente.SOCIO_LM)).toBe(true);
    },
  );
});
