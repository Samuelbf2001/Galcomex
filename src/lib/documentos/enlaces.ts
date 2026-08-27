/**
 * Enlaces públicos para compartir documentos — Galcomex
 *
 * Permite compartir un documento del trámite con un tercero SIN usuario en
 * el sistema, vía una URL pública /compartir/{token}. El token es la única
 * credencial: aleatorio, criptográficamente fuerte (32 bytes, base64url),
 * generado con node:crypto (mismo mecanismo que src/lib/crypto/pse.ts).
 *
 * Roles que pueden crear/revocar: ADMIN, REVISOR, OPERATIVO (no SOCIO).
 */

import { randomBytes } from "node:crypto";

import { type DocumentoEnlace, Prisma, type Rol } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

// ─── Constantes ───────────────────────────────────────────────────────────────

/**
 * Días de expiración por defecto de un enlace público, si el parámetro
 * configurable no existe todavía en la tabla Parametro (no se tocó
 * prisma/seed.ts en esta tarea). Si en el futuro se agrega la clave
 * DIAS_EXPIRACION_ENLACE_DOCUMENTO vía la pantalla de Configuración, se
 * usará automáticamente sin cambios de código.
 */
const DIAS_EXPIRACION_DEFAULT = 7;
const CLAVE_PARAMETRO_DIAS_EXPIRACION = "DIAS_EXPIRACION_ENLACE_DOCUMENTO";

const ROLES_PUEDEN_COMPARTIR: readonly Rol[] = ["ADMIN", "REVISOR", "OPERATIVO"];

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class EnlaceNoEncontradoError extends Error {
  public readonly status = 404;

  constructor(id: string) {
    super(`Enlace '${id}' no encontrado`);
    this.name = "EnlaceNoEncontradoError";
  }
}

export class EnlacePermisoError extends Error {
  public readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "EnlacePermisoError";
  }
}

// Re-exportado aquí para que los callers (rutas) no dependan de conocer el
// nombre del error de documentos/service.ts al validar el documento base.
export class DocumentoNoEncontradoParaEnlaceError extends Error {
  public readonly status = 404;

  constructor(documentoId: string) {
    super(`Documento '${documentoId}' no encontrado`);
    this.name = "DocumentoNoEncontradoParaEnlaceError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export function puedeCompartirDocumento(rol: Rol): boolean {
  return ROLES_PUEDEN_COMPARTIR.includes(rol);
}

/** Genera un token público URL-safe de 32 bytes (256 bits de entropía). */
function generarToken(): string {
  return randomBytes(32).toString("base64url");
}

async function resolverDiasExpiracion(): Promise<number> {
  try {
    const parametro = await prisma.parametro.findUnique({
      where: { clave: CLAVE_PARAMETRO_DIAS_EXPIRACION },
    });
    if (parametro) {
      const dias = parseInt(parametro.valor, 10);
      if (Number.isFinite(dias) && dias > 0) {
        return dias;
      }
    }
  } catch {
    // Tabla/columna no disponible (p.ej. en algún entorno de test aislado):
    // seguir con el fallback fijo.
  }
  return DIAS_EXPIRACION_DEFAULT;
}

// ─── Funciones del servicio ───────────────────────────────────────────────────

/**
 * Devuelve el enlace activo (no revocado, no vencido) más reciente para un
 * documento, si existe. Uso: la ruta POST es idempotente — si ya hay un
 * enlace activo, lo devuelve en vez de crear uno duplicado.
 */
export async function obtenerEnlaceActivo(documentoId: string): Promise<DocumentoEnlace | null> {
  return prisma.documentoEnlace.findFirst({
    where: { documentoId, revocado: false, expiraEn: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Crea un enlace público para compartir un documento. Si ya existe un
 * enlace activo para el mismo documento, lo devuelve sin crear uno nuevo
 * (evita proliferación de tokens válidos para el mismo archivo).
 * Genera AuditLog en la misma transacción.
 */
export async function crearEnlaceDocumento(
  documentoId: string,
  usuarioId: string,
  rol: Rol,
): Promise<DocumentoEnlace> {
  if (!puedeCompartirDocumento(rol)) {
    throw new EnlacePermisoError(
      "No tienes permiso para compartir documentos. Solo ADMIN, REVISOR u OPERATIVO pueden hacerlo.",
    );
  }

  const doc = await prisma.documento.findUnique({ where: { id: documentoId } });
  if (!doc || doc.eliminado) {
    throw new DocumentoNoEncontradoParaEnlaceError(documentoId);
  }

  const activo = await obtenerEnlaceActivo(documentoId);
  if (activo) {
    return activo;
  }

  const dias = await resolverDiasExpiracion();
  const expiraEn = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  const token = generarToken();

  return prisma.$transaction(async (tx) => {
    const enlace = await tx.documentoEnlace.create({
      data: {
        token,
        documentoId,
        expiraEn,
        creadoPorId: usuarioId,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "DocumentoEnlace",
        entidadId: enlace.id,
        accion: "CREATE",
        usuarioId,
        tramiteId: doc.tramiteId,
        despues: normalizeSerializable({ ...enlace, token: undefined }),
      },
    });

    return enlace;
  });
}

/**
 * Revoca un enlace público (revocado=true). Idempotente: revocar un enlace
 * ya revocado no falla, simplemente no vuelve a auditar el cambio.
 * Genera AuditLog en la misma transacción.
 */
export async function revocarEnlace(
  enlaceId: string,
  usuarioId: string,
  rol: Rol,
): Promise<DocumentoEnlace> {
  if (!puedeCompartirDocumento(rol)) {
    throw new EnlacePermisoError(
      "No tienes permiso para revocar enlaces. Solo ADMIN, REVISOR u OPERATIVO pueden hacerlo.",
    );
  }

  const enlace = await prisma.documentoEnlace.findUnique({
    where: { id: enlaceId },
    include: { documento: { select: { tramiteId: true } } },
  });

  if (!enlace) {
    throw new EnlaceNoEncontradoError(enlaceId);
  }

  if (enlace.revocado) {
    return enlace;
  }

  return prisma.$transaction(async (tx) => {
    const actualizado = await tx.documentoEnlace.update({
      where: { id: enlaceId },
      data: { revocado: true },
    });

    await tx.auditLog.create({
      data: {
        entidad: "DocumentoEnlace",
        entidadId: enlaceId,
        accion: "REVOKE",
        usuarioId,
        tramiteId: enlace.documento.tramiteId,
        antes: normalizeSerializable({ ...enlace, token: undefined, documento: undefined }),
        despues: normalizeSerializable({ ...actualizado, token: undefined }),
      },
    });

    return actualizado;
  });
}

// ─── Validación del token (uso público, sin sesión) ───────────────────────────

export type EnlacePublicoInvalidoRazon =
  | "no_encontrado"
  | "revocado"
  | "vencido"
  | "documento_eliminado";

export type EnlacePublicoResultado =
  | {
      valido: true;
      documento: { id: string; nombreArchivo: string; storageKey: string };
    }
  | { valido: false; razon: EnlacePublicoInvalidoRazon };

/**
 * Lógica PURA de validación de un enlace ya cargado de BD (enlace + su
 * documento). Separada de resolverEnlacePublico() para poder testearla sin
 * mockear Prisma.
 */
export function evaluarEnlace(
  enlace: {
    revocado: boolean;
    expiraEn: Date;
    documento: { id: string; nombreArchivo: string; storageKey: string; eliminado: boolean };
  },
  ahora: Date = new Date(),
): EnlacePublicoResultado {
  if (enlace.revocado) {
    return { valido: false, razon: "revocado" };
  }
  if (enlace.expiraEn.getTime() < ahora.getTime()) {
    return { valido: false, razon: "vencido" };
  }
  if (enlace.documento.eliminado) {
    return { valido: false, razon: "documento_eliminado" };
  }
  return {
    valido: true,
    documento: {
      id: enlace.documento.id,
      nombreArchivo: enlace.documento.nombreArchivo,
      storageKey: enlace.documento.storageKey,
    },
  };
}

/**
 * Resuelve un token público: lo busca en BD y aplica evaluarEnlace().
 * No filtra el motivo exacto de invalidez al llamador HTTP (evita fugas de
 * información) — quien llame a esta función internamente sí puede ver la
 * razón (útil para logs), pero la ruta pública debe responder siempre el
 * mismo mensaje genérico.
 */
export async function resolverEnlacePublico(token: string): Promise<EnlacePublicoResultado> {
  const enlace = await prisma.documentoEnlace.findUnique({
    where: { token },
    include: {
      documento: {
        select: { id: true, nombreArchivo: true, storageKey: true, eliminado: true },
      },
    },
  });

  if (!enlace) {
    return { valido: false, razon: "no_encontrado" };
  }

  return evaluarEnlace(enlace);
}
