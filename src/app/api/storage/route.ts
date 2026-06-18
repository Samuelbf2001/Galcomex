import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireSession } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import {
  createPresignedDownloadUrl,
  createPresignedUploadUrl,
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
  const session = await requireSession();

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const objects = await listStorageObjects({
      prefix: request.nextUrl.searchParams.get("prefix") ?? undefined,
      includeDeleted: request.nextUrl.searchParams.get("includeDeleted") === "true",
    });

    return jsonResponse({ objects });
  } catch (error) {
    if (error instanceof StorageValidationError) {
      return validationError(error);
    }

    throw error;
  }
}

export async function POST(request: NextRequest) {
  const session = await requireSession();

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
      const downloadUrl = await createPresignedDownloadUrl(
        downloadUrlSchema.parse(payload),
      );

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

export async function DELETE(request: NextRequest) {
  const session = await requireSession();

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = z
      .object({
        storageKey: z.string().min(1),
      })
      .parse(await request.json());
    const deleted = await softDeleteStorageObject({
      storageKey: payload.storageKey,
      deletedBy: session.user.id,
    });

    return jsonResponse({ deleted });
  } catch (error) {
    if (error instanceof ZodError || error instanceof StorageValidationError) {
      return validationError(error);
    }

    throw error;
  }
}
