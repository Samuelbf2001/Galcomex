import { describe, expect, it } from "vitest";

import { rutaFirmada, verificarEnlace, type AccesoObjeto } from "@/lib/storage/proxy";

const CLAVE = "secreto-de-prueba";

function params(ruta: string): URLSearchParams {
  return new URL(`http://x${ruta}`).searchParams;
}

describe("enlaces firmados de /api/storage/objeto", () => {
  const subida: AccesoObjeto = {
    metodo: "PUT",
    storageKey: "tramites/DO.BAQ26-0001/FACTURA_PROVEEDOR/abc.pdf",
    contentType: "application/pdf",
    sizeBytes: 12345,
    exp: 2_000_000_000,
  };

  it("firma y verifica una subida", () => {
    const r = verificarEnlace(params(rutaFirmada(subida, CLAVE)), "PUT", 1_900_000_000, CLAVE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.acceso.storageKey).toBe(subida.storageKey);
      expect(r.acceso.contentType).toBe("application/pdf");
      expect(r.acceso.sizeBytes).toBe(12345);
    }
  });

  it("firma y verifica una descarga (sin tipo ni tamaño)", () => {
    const bajada: AccesoObjeto = { metodo: "GET", storageKey: "tramites/x/BL/y.pdf", exp: 2_000_000_000 };
    const r = verificarEnlace(params(rutaFirmada(bajada, CLAVE)), "GET", 1_900_000_000, CLAVE);
    expect(r.ok).toBe(true);
  });

  it("rechaza el enlace vencido", () => {
    const r = verificarEnlace(params(rutaFirmada(subida, CLAVE)), "PUT", 2_000_000_001, CLAVE);
    expect(r).toEqual({ ok: false, motivo: "Enlace vencido" });
  });

  it("rechaza si se cambia la clave, el tamaño o el tipo", () => {
    const ruta = rutaFirmada(subida, CLAVE);
    const p1 = params(ruta); p1.set("key", "tramites/otro.pdf");
    const p2 = params(ruta); p2.set("size", "99999999");
    const p3 = params(ruta); p3.set("ct", "application/octet-stream");
    for (const p of [p1, p2, p3]) {
      expect(verificarEnlace(p, "PUT", 1_900_000_000, CLAVE)).toEqual({ ok: false, motivo: "Firma inválida" });
    }
  });

  it("rechaza usar un enlace de descarga para subir", () => {
    const bajada: AccesoObjeto = { metodo: "GET", storageKey: "tramites/x/BL/y.pdf", exp: 2_000_000_000 };
    const r = verificarEnlace(params(rutaFirmada(bajada, CLAVE)), "PUT", 1_900_000_000, CLAVE);
    expect(r.ok).toBe(false);
  });

  it("rechaza una firma hecha con otro secreto", () => {
    const r = verificarEnlace(params(rutaFirmada(subida, "otro")), "PUT", 1_900_000_000, CLAVE);
    expect(r).toEqual({ ok: false, motivo: "Firma inválida" });
  });
});
