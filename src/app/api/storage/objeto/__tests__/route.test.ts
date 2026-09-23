/**
 * Tests del proxy de descarga `/api/storage/objeto` (GET).
 *
 * Fix de seguridad (2026-09-22): antes se servía `inline` cualquier tipo de
 * archivo que el llamador pidiera (o que la bodega tuviera guardado), lo que
 * permitía que el navegador intentara "abrir" un XLSX/ZIP/EML como si fuera
 * HTML. Ahora solo PDF, JPG y PNG se sirven `inline`; todo lo demás se fuerza
 * a `attachment` + `application/octet-stream`, y la respuesta siempre lleva
 * `X-Content-Type-Options: nosniff` y `Content-Security-Policy: sandbox`.
 *
 * Se mockean `verificarEnlace` (el enlace firmado ya se prueba a fondo en
 * proxy.test.ts), el cliente de MinIO y `getStorageConfig`: aquí solo importa
 * la lógica de content-type/disposition/headers.
 */

import { Readable } from "node:stream";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const statObjectMock = vi.fn();
const getObjectMock = vi.fn();

vi.mock("@/lib/storage/client", () => ({
  getStorageClient: () => ({
    statObject: statObjectMock,
    getObject: getObjectMock,
  }),
}));

vi.mock("@/lib/storage/config", () => ({
  getStorageConfig: () => ({ bucket: "test-bucket" }),
}));

vi.mock("@/lib/storage/proxy", () => ({
  verificarEnlace: vi.fn(),
}));

import { verificarEnlace } from "@/lib/storage/proxy";

import { GET } from "../route";

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

function mockAcceso(storageKey: string) {
  vi.mocked(verificarEnlace).mockReturnValue({ ok: true, acceso: { storageKey } } as never);
}

function mockObjeto(size: number, contentType: string | undefined) {
  statObjectMock.mockResolvedValue({ size, metaData: contentType ? { "content-type": contentType } : {} });
  getObjectMock.mockResolvedValue(Readable.from([Buffer.from("contenido")]));
}

describe("GET /api/storage/objeto — inline solo pdf/jpg/png, nosniff siempre", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PDF sin ?descargar → inline, mismo content-type, nosniff + CSP sandbox", async () => {
    mockAcceso("tramites/DO-1/FACTURA_COMERCIAL/a.pdf");
    mockObjeto(10, "application/pdf");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("JPG sin ?descargar → inline", async () => {
    mockAcceso("tramites/DO-1/FOTO_RECONOCIMIENTO/foto.jpg");
    mockObjeto(10, "image/jpeg");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("PNG sin ?descargar → inline", async () => {
    mockAcceso("tramites/DO-1/FOTO_RECONOCIMIENTO/foto.png");
    mockObjeto(10, "image/png");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("XLSX se fuerza SIEMPRE a attachment + octet-stream, aunque no se pida ?descargar", async () => {
    mockAcceso("tramites/DO-1/OTRO/informe.xlsx");
    mockObjeto(10, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("EML (mime no listado) también se fuerza a attachment + octet-stream", async () => {
    mockAcceso("tramites/DO-1/CORRESPONDENCIA/correo.eml");
    mockObjeto(10, "message/rfc822");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("PDF con ?descargar=1 respeta la intención de descarga (attachment), pero mantiene el content-type real", async () => {
    mockAcceso("tramites/DO-1/FACTURA_COMERCIAL/a.pdf");
    mockObjeto(10, "application/pdf");

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y&descargar=1"));

    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("archivo sin Content-Type guardado (subido por rclone) se deduce por extensión, y solo es inline si esa extensión es pdf/jpg/png", async () => {
    mockAcceso("tramites/historico/2026/factura.pdf");
    mockObjeto(10, undefined);

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("enlace inválido/vencido → 403, no llega a tocar el storage", async () => {
    vi.mocked(verificarEnlace).mockReturnValue({ ok: false, motivo: "Enlace vencido" } as never);

    const res = await GET(req("/api/storage/objeto?key=x&exp=1&sig=y"));

    expect(res.status).toBe(403);
    expect(statObjectMock).not.toHaveBeenCalled();
  });
});
