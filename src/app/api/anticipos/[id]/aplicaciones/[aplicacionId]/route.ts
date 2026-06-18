import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { jsonResponse } from "@/lib/http/json";
import { eliminarAplicacion } from "@/lib/anticipos/service";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; aplicacionId: string }> },
) {
  const session = await requireRole(["ADMIN"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { aplicacionId } = await params;

    await eliminarAplicacion(aplicacionId);

    return jsonResponse({ ok: true });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Aplicacion no encontrada" },
        { status: 404 },
      );
    }

    throw error;
  }
}
