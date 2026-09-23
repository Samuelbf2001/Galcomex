import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";
import {
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
  DELETED_PREFIX,
  listStorageObjects,
  softDeleteStorageObject,
  StorageValidationError,
} from "@/lib/storage";

export const runtime = "nodejs";

const expiresInSecondsSchema = z
  .number()
  .int()
  .positive()
  .max(15 * 60)
  .optional();

const uploadUrlSchema = z.object({
  action: z.literal("uploadUrl"),
  consecutivo: z.string().min(1),
  categoria: z.string().min(1),
  fileName: z.string().min(1).optional(),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  expiresInSeconds: expiresInSecondsSchema,
});

const downloadUrlSchema = z.object({
  action: z.literal("downloadUrl"),
  storageKey: z.string().min(1),
  expiresInSeconds: expiresInSecondsSchema,
});

function validationError(error: ZodError | StorageValidationError) {
  if (error instanceof StorageValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json(
    {
      error: "Payload invalido",
      details: error.issues.map((issue) => ({
        campo: issue.path.join("."),
        mensaje: issue.message,
      })),
    },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const prefix = request.nextUrl.searchParams.get("prefix") ?? undefined;
    const includeDeleted = request.nextUrl.searchParams.get("includeDeleted") === "true";

    // La papelera (`deleted/`) solo la ve ADMIN (igual que el explorador de
    // archivos, ver lib/storage/explorador.ts#puedeVerPrefijo).
    if (session.user.rol !== "ADMIN" && (includeDeleted || prefix?.startsWith(DELETED_PREFIX))) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    const objects = await listStorageObjects({ prefix, includeDeleted });

    return jsonResponse({ objects });
  } catch (error) {
    if (error instanceof StorageValidationError) {
      return validationError(error);
    }

    throw error;
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = await request.json();

    if (payload?.action === "uploadUrl") {
      const uploadUrl = await createPresignedUploadUrl(uploadUrlSchema.parse(payload));

      return jsonResponse({ uploadUrl }, { status: 201 });
    }

    if (payload?.action === "downloadUrl") {
      const parsed = downloadUrlSchema.parse(payload);

      // Igual que en GET: la papelera solo la puede descargar ADMIN.
      if (session.user.rol !== "ADMIN" && parsed.storageKey.startsWith(DELETED_PREFIX)) {
        return NextResponse.json({ error: "No autorizado" }, { status: 403 });
      }

      const downloadUrl = await createPresignedDownloadUrl(parsed);

      return jsonResponse({ downloadUrl });
    }

    return NextResponse.json({ error: "Accion no soportada" }, { status: 400 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof StorageValidationError) {
      return validationError(error);
    }

    throw error;
  }
}

/**
 * Solo ADMIN: enviar un objeto de la bodega directamente a la papelera
 * (`deleted/`), sin pasar por el repositorio documental del DO. REVISOR y
 * OPERATIVO quedaban antes con esta puerta abierta y podían borrar CUALQUIER
 * archivo con solo conocer su storageKey (sin registro en BD ni AuditLog).
 * Las claves que SÍ están registradas como Documento activo se rechazan:
 * esas se eliminan desde `DELETE /api/tramites/[id]/documentos/[documentoId]`,
 * que además valida permisos por rol y deja su propio AuditLog.
 */
export async function DELETE(request: NextRequest) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = z
      .object({
        storageKey: z.string().min(1),
      })
      .parse(await request.json());

    const documentoActivo = await prisma.documento.findFirst({
      where: { storageKey: payload.storageKey, eliminado: false },
      select: { id: true, tramiteId: true },
    });

    if (documentoActivo) {
      return NextResponse.json(
        {
          error:
            "Ese archivo está registrado como documento de un trámite; elimínalo desde el repositorio de documentos del DO.",
        },
        { status: 409 },
      );
    }

    const deleted = await softDeleteStorageObject({
      storageKey: payload.storageKey,
      deletedBy: session.user.id,
    });

    await prisma.auditLog.create({
      data: {
        entidad: "StorageObject",
        entidadId: payload.storageKey,
        accion: "DELETE",
        usuarioId: session.user.id,
        despues: JSON.parse(JSON.stringify(deleted)),
      },
    });

    return jsonResponse({ deleted });
  } catch (error) {
    if (error instanceof ZodError || error instanceof StorageValidationError) {
      return validationError(error);
    }

    throw error;
  }
}
