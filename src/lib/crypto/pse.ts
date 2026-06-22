import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_HEX = process.env.PSE_ENCRYPTION_KEY ?? "";

function getKey(): Buffer {
  if (KEY_HEX.length !== 64) {
    throw new Error("PSE_ENCRYPTION_KEY debe ser 32 bytes en hex (64 caracteres)");
  }
  return Buffer.from(KEY_HEX, "hex");
}

/** Cifra el código PSE. Devuelve "iv:authTag:ciphertext" en hex. */
export function encryptPseCode(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12); // 96 bits para GCM
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Descifra un código PSE previamente cifrado con encryptPseCode. */
export function decryptPseCode(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Formato de código PSE cifrado inválido");
  }
  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Genera un token URL-safe de 32 bytes. */
export function generatePseToken(): string {
  return randomBytes(32).toString("hex");
}
