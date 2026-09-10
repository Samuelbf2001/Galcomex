import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { jsonResponse } from "@/lib/http/json";

/**
 * Tipos de trámite disponibles (M4).
 *
 * Con `?clienteId=` devuelve solo los que esa empresa puede abrir: un tipo con
 * `capacidadRequerida` (la clasificación arancelaria, por ejemplo) solo aparece
 * si la empresa tiene esa capacidad encendida. Así el formulario de creación no
 * ofrece algo que el backend va a rechazar.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const tipos = await prisma.tipoTramite.findMany({
    where: { activo: true },
    orderBy: { orden: "asc" },
  });

  const clienteId = request.nextUrl.searchParams.get("clienteId");

  if (!clienteId) {
    return jsonResponse({ tipos });
  }

  const cliente = await prisma.cliente.findUnique({
    where: { id: clienteId },
    select: { id: true },
  });

  if (!cliente) {
    return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  }

  const capacidades = await capacidadesDeEmpresa(clienteId);

  const disponibles = tipos.filter(
    (tipo) => !tipo.capacidadRequerida || tiene(capacidades, tipo.capacidadRequerida),
  );

  return jsonResponse({ tipos: disponibles });
}
