import { Prisma, Rol } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { prisma } from "@/lib/db/prisma";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { createTramite } from "@/lib/tramites/service";
import { solicitudExternaSchema } from "@/lib/validations/solicitudes";

// Endpoint público — no requiere sesión.
// Permite a clientes externos solicitar apertura de un DO dando su NIT.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo JSON inválido" }, { status: 400 });
  }

  let data: ReturnType<typeof solicitudExternaSchema.parse>;
  try {
    data = solicitudExternaSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  // Buscar cliente por NIT
  const cliente = await prisma.cliente.findUnique({
    where: { nit: data.nit },
    select: { id: true, nombre: true, activo: true },
  });

  if (!cliente) {
    return NextResponse.json(
      { error: "NIT no registrado. Contacte a Galcomex para ser registrado como cliente." },
      { status: 404 },
    );
  }

  if (!cliente.activo) {
    return NextResponse.json(
      { error: "El cliente no está activo. Contacte a Galcomex." },
      { status: 403 },
    );
  }

  // Usar el usuario ADMIN como creador del DO externo
  const adminUser = await prisma.user.findFirst({
    where: { rol: Rol.ADMIN },
    select: { id: true },
  });

  if (!adminUser) {
    return NextResponse.json(
      { error: "Error de configuración del sistema. Contacte a Galcomex." },
      { status: 500 },
    );
  }

  try {
    const tramite = await createTramite({
      ciudad: data.ciudad,
      clienteId: cliente.id,
      proveedorCliente: data.proveedorCliente,
      agenciaAduanas: data.agenciaAduanas,
      eta: data.eta,
      comentarios: data.comentarios
        ? `[SOLICITUD EXTERNA] ${data.comentarios}`
        : "[SOLICITUD EXTERNA]",
      creadoPorId: adminUser.id,
    });

    return jsonResponse(
      {
        consecutivo: tramite.consecutivo,
        id: tramite.id,
        cliente: cliente.nombre,
      },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "Error al crear el trámite. Intente nuevamente." },
        { status: 400 },
      );
    }
    throw error;
  }
}
