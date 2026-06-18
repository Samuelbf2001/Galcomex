import { TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import {
  TramiteSinPagosError,
  solicitarFacturacion,
} from "@/lib/facturas-proveedor/service";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  // SOCIO solo puede solicitar facturación en trámites de clientes SOCIO_LM
  if (session.user.rol === "SOCIO") {
    const tramite = await prisma.tramiteDO.findUnique({
      where: { id },
      select: { cliente: { select: { tipo: true } } },
    });

    if (!tramite) {
      return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
    }

    if (tramite.cliente.tipo !== TipoCliente.SOCIO_LM) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }
  }

  try {
    const result = await solicitarFacturacion(id, session.user.id);

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    return jsonResponse({ ok: true, message: "Trámite enviado a facturar" });
  } catch (error) {
    if (error instanceof TramiteSinPagosError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
