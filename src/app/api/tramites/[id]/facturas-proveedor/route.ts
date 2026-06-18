import { TipoCliente } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import {
  FacturaProveedorDuplicadaError,
  crearFacturaProveedor,
  listarPorTramite,
} from "@/lib/facturas-proveedor/service";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { prisma } from "@/lib/db/prisma";
import { crearFacturaProveedorSchema } from "@/lib/validations/facturas-proveedor";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Verifica que el trámite existe y, si el usuario es SOCIO, que su cliente sea SOCIO_LM. */
async function resolverTramiteConPermiso(tramiteId: string, rolUsuario: string) {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: { id: true, cliente: { select: { tipo: true } } },
  });

  if (!tramite) {
    return null;
  }

  if (rolUsuario === "SOCIO" && tramite.cliente.tipo !== TipoCliente.SOCIO_LM) {
    return "forbidden";
  }

  return tramite;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const { id } = await context.params;

  const permiso = await resolverTramiteConPermiso(id, session.user.rol);
  if (permiso === null) {
    return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
  }
  if (permiso === "forbidden") {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const facturas = await listarPorTramite(id);
  return jsonResponse({ facturas });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireRole(["ADMIN", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { id } = await context.params;

    const permiso = await resolverTramiteConPermiso(id, session.user.rol);
    if (permiso === null) {
      return NextResponse.json({ error: "Trámite no encontrado" }, { status: 404 });
    }
    if (permiso === "forbidden") {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    const payload = crearFacturaProveedorSchema.parse(await request.json());

    const factura = await crearFacturaProveedor({
      tramiteId: id,
      ...payload,
      subidaPorId: session.user.id,
    });

    return jsonResponse({ factura }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    if (error instanceof FacturaProveedorDuplicadaError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
