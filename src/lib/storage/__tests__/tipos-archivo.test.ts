import { describe, expect, it } from "vitest";

import { ACCEPTED_FILE_EXTENSIONS_ATTR, ALLOWED_STORAGE_FILE_TYPES } from "@/lib/storage/config";
import {
  isAllowedStorageContentType,
  StorageValidationError,
  validateStorageFile,
} from "@/lib/storage/service";

// Lo que de verdad manda Litoplas (histórico 2026): además de PDF/JPG/PNG/XLSX
// llegan .xls, .docx/.doc, .zip/.rar con fotos, correos .eml y videos .mp4.
const CASOS_REALES: Array<[string, string]> = [
  ["DO.26-0037 IM027-26 EXCEL MOVIAD.xls", "application/vnd.ms-excel"],
  ["ACTA PREVIA LITOPLAS I26020100.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["MANDATO 2026.doc", "application/msword"],
  ["FOTOS.zip", "application/zip"],
  ["FOTOS.zip", "application/x-zip-compressed"],
  ["FOTOS .rar", "application/vnd.rar"],
  ["FOTOS .rar", "application/x-rar-compressed"],
  ["Bandeja de entrada_ Karina De la hoz - Outlook.eml", "message/rfc822"],
  ["VIDEO INSPECCION.mp4", "video/mp4"],
  ["SOL DE FONDOS.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
];

describe("tipos de archivo aceptados en la bodega", () => {
  it.each(CASOS_REALES)("acepta %s (%s)", (fileName, contentType) => {
    expect(validateStorageFile({ fileName, contentType, sizeBytes: 1024 })).toBe(contentType);
  });

  it("rechaza tipos que no están en la lista", () => {
    expect(() =>
      validateStorageFile({ fileName: "Thumbs.db", contentType: "application/octet-stream", sizeBytes: 10 }),
    ).toThrow(StorageValidationError);
  });

  it("rechaza extensión que no coincide con el tipo", () => {
    expect(() =>
      validateStorageFile({ fileName: "informe.docx", contentType: "application/vnd.ms-excel", sizeBytes: 10 }),
    ).toThrow("La extension no coincide");
  });

  // Fix 2026-09-22: `contentType in ALLOWED_STORAGE_FILE_TYPES` también es
  // cierto para propiedades HEREDADAS del prototipo de Object ("constructor",
  // "toString", "hasOwnProperty"…), lo que dejaba pasar tipos que nunca
  // estuvieron en la lista. Ahora se usa Object.hasOwn.
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "rechaza '%s' (propiedad heredada del prototipo, no un tipo real de la lista)",
    (contentType) => {
      expect(isAllowedStorageContentType(contentType)).toBe(false);
      expect(() =>
        validateStorageFile({ fileName: "archivo.pdf", contentType, sizeBytes: 10 }),
      ).toThrow(StorageValidationError);
    },
  );

  // Fix 2026-09-22: sin extensión no hay forma de comparar contra el tipo
  // declarado, así que se rechaza en vez de dejarlo pasar en silencio.
  it("rechaza un archivo sin extensión en el nombre", () => {
    expect(() =>
      validateStorageFile({ fileName: "sin-extension", contentType: "application/pdf", sizeBytes: 10 }),
    ).toThrow("debe incluir una extension");
  });

  it("rechaza cuando no se manda nombre de archivo en absoluto", () => {
    expect(() =>
      validateStorageFile({ contentType: "application/pdf", sizeBytes: 10 }),
    ).toThrow("debe incluir una extension");
  });

  it("el accept de los inputs cubre todas las extensiones del servidor", () => {
    const accept = new Set(ACCEPTED_FILE_EXTENSIONS_ATTR.split(","));
    for (const ext of new Set(Object.values(ALLOWED_STORAGE_FILE_TYPES))) {
      expect(accept.has(`.${ext}`)).toBe(true);
    }
  });
});
