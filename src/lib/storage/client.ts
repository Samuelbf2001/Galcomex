import { Client } from "minio";

import { getStorageConfig } from "@/lib/storage/config";

declare global {
  var galcomexMinioClient: Client | undefined;
  var galcomexMinioPublicClient: Client | undefined;
}

/**
 * Cliente interno: usado para todas las operaciones servidor↔MinIO
 * (bucketExists, copyObject, removeObject, listObjects…). Apunta al endpoint
 * de red interna (ej. "minio" dentro de Docker).
 */
export function getStorageClient(): Client {
  if (globalThis.galcomexMinioClient) {
    return globalThis.galcomexMinioClient;
  }

  const config = getStorageConfig();
  const client = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
  });

  globalThis.galcomexMinioClient = client;

  return client;
}

/**
 * Cliente público: usado SOLO para firmar URLs prefirmadas de upload/download.
 * Apunta al endpoint accesible desde el navegador del usuario. El presign no
 * hace I/O de red (es cálculo de firma con la región fijada), por lo que este
 * cliente no necesita conectividad real hacia el host público.
 */
export function getStoragePublicClient(): Client {
  if (globalThis.galcomexMinioPublicClient) {
    return globalThis.galcomexMinioPublicClient;
  }

  const config = getStorageConfig();
  const client = new Client({
    endPoint: config.publicEndPoint,
    port: config.publicPort,
    useSSL: config.publicUseSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
  });

  globalThis.galcomexMinioPublicClient = client;

  return client;
}
