import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detectarProveedor,
  getStorageConfig,
  resumenStorage,
  StorageConfigError,
} from "@/lib/storage/config";

const BASE = {
  MINIO_ACCESS_KEY: "llave",
  MINIO_SECRET_KEY: "secreto",
  MINIO_BUCKET: "galcomex",
};

function conEnv(vars: Record<string, string | undefined>) {
  for (const k of [
    "MINIO_ENDPOINT",
    "MINIO_PORT",
    "MINIO_USE_SSL",
    "MINIO_REGION",
    "MINIO_PATH_STYLE",
    "STORAGE_PROVIDER",
    "MINIO_PUBLIC_ENDPOINT",
    "MINIO_PUBLIC_PORT",
    "MINIO_PUBLIC_USE_SSL",
    ...Object.keys(BASE),
  ]) {
    vi.stubEnv(k, "");
    delete process.env[k];
  }
  for (const [k, v] of Object.entries({ ...BASE, ...vars })) {
    if (v !== undefined) vi.stubEnv(k, v);
  }
}

describe("configuración de storage (MinIO / R2 / B2 / S3)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  describe("detectarProveedor", () => {
    it("adivina por el host cuando no se declara", () => {
      expect(detectarProveedor("minio")).toBe("minio");
      expect(detectarProveedor("localhost")).toBe("minio");
      expect(detectarProveedor("10.0.0.5")).toBe("minio");
      expect(detectarProveedor("abc123.r2.cloudflarestorage.com")).toBe("r2");
      expect(detectarProveedor("s3.us-west-004.backblazeb2.com")).toBe("b2");
      expect(detectarProveedor("s3.us-east-1.amazonaws.com")).toBe("s3");
      expect(detectarProveedor("s3.wasabisys.com")).toBe("otro");
    });

    it("lo declarado manda, y rechaza valores desconocidos", () => {
      expect(detectarProveedor("minio", "r2")).toBe("r2");
      expect(detectarProveedor("x.r2.cloudflarestorage.com", "OTRO")).toBe("otro");
      expect(() => detectarProveedor("minio", "dropbox")).toThrow(StorageConfigError);
    });
  });

  describe("getStorageConfig", () => {
    it("MinIO local: puerto 9000, http, región us-east-1, path-style", () => {
      conEnv({ MINIO_ENDPOINT: "localhost" });
      const c = getStorageConfig();
      expect(c.proveedor).toBe("minio");
      expect(c.port).toBe(9000);
      expect(c.useSSL).toBe(false);
      expect(c.region).toBe("us-east-1");
      expect(c.pathStyle).toBe(true);
      expect(resumenStorage(c).endpoint).toBe("http://localhost:9000");
    });

    it("Cloudflare R2: con SSL y sin puerto asume 443 y región auto", () => {
      conEnv({ MINIO_ENDPOINT: "abc123.r2.cloudflarestorage.com", MINIO_USE_SSL: "true" });
      const c = getStorageConfig();
      expect(c.proveedor).toBe("r2");
      expect(c.port).toBe(443);
      expect(c.useSSL).toBe(true);
      expect(c.region).toBe("auto");
      expect(resumenStorage(c)).toEqual({
        proveedor: "r2",
        nombreProveedor: "Cloudflare R2",
        bucket: "galcomex",
        endpoint: "https://abc123.r2.cloudflarestorage.com",
        region: "auto",
      });
    });

    it("Backblaze B2: respeta la región declarada y el path-style explícito", () => {
      conEnv({
        MINIO_ENDPOINT: "s3.us-west-004.backblazeb2.com",
        MINIO_USE_SSL: "true",
        MINIO_REGION: "us-west-004",
        MINIO_PATH_STYLE: "false",
      });
      const c = getStorageConfig();
      expect(c.proveedor).toBe("b2");
      expect(c.region).toBe("us-west-004");
      expect(c.pathStyle).toBe(false);
    });

    it("el endpoint público cae al interno si no se configura", () => {
      conEnv({ MINIO_ENDPOINT: "minio", MINIO_PORT: "9000" });
      const c = getStorageConfig();
      expect(c.publicEndPoint).toBe("minio");
      expect(c.publicPort).toBe(9000);
      expect(c.publicUseSSL).toBe(false);
    });

    it("falla claro si falta una variable obligatoria", () => {
      conEnv({ MINIO_ENDPOINT: "minio", MINIO_BUCKET: undefined });
      expect(() => getStorageConfig()).toThrow(/MINIO_BUCKET/);
    });

    it("rechaza un puerto inválido", () => {
      conEnv({ MINIO_ENDPOINT: "minio", MINIO_PORT: "abc" });
      expect(() => getStorageConfig()).toThrow(StorageConfigError);
    });
  });
});
