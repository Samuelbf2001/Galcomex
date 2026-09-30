import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { domainErrorResponse, isDomainError, validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import {
  createTramite,
  listTramites,
  TarifaVigenteRequeridaError,
} from "@/lib/tramites/service";
import { ServicioNoPermitidoError, ServicioReservadoError } from "@/lib/tramites/servicios";
import {
  tramiteCreateSchema,
  tramiteQuerySchema,
} from "@/lib/validations/tramites";

export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO", "SOCIO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  let query: ReturnType<typeof tramiteQuerySchema.parse>;
  try {
    query = tramiteQuerySchema.parse({
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      estado: request.nextUrl.searchParams.get("estado") ?? undefined,
      ciudad: request.nextUrl.searchParams.get("ciudad") ?? undefined,
      clienteId: request.nextUrl.searchParams.get("clienteId") ?? undefined,
      tipoCliente: request.nextUrl.searchParams.get("tipoCliente") ?? undefined,
      facturado: request.nextUrl.searchParams.get("facturado") ?? undefined,
      ordenarPor: request.nextUrl.searchParams.get("ordenarPor") ?? undefined,
      direccion: request.nextUrl.searchParams.get("direccion") ?? undefined,
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }

  // Scoping del rol SOCIO: solo ve tramites de clientes tipo SOCIO_LM.
  // Se combina (AND) con los filtros de la query dentro de listTramites y
  // nunca se debilita — ver comentario en TramiteListOptions.socioScope.
  const { tramites, total } = await listTramites(query, {
    socioScope: session.user.rol === "SOCIO",
  });

  return jsonResponse({ tramites, total });
}

export async function POST(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const payload = tramiteCreateSchema.parse(await request.json());

    // 30-sep-2026: el año del DO lo pone el servidor (el de Bogotá). Solo la
    // administradora (rol efectivo de la sesión) crea un DO de otro año — las
    // cargas históricas y el MCP van como ADMIN.
    if (
      payload.anio !== undefined &&
      payload.anio !== fechaCalendarioBogota().getUTCFullYear() &&
      session.user.rol !== "ADMIN"
    ) {
      return NextResponse.json(
        { error: "Solo la administradora puede crear un DO de otro año.", codigo: "ANIO_SOLO_ADMIN" },
        { status: 422 },
      );
    }

    const tramite = await createTramite({
      ...payload,
      eta: payload.eta ?? undefined,
      creadoPorId: session.user.id,
    });

    return jsonResponse({ tramite }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }

    // Sin tarifa vigente no hay DO (capacidad `do_exige_tarifa_vigente`). Lleva
    // `codigo` y `detalles` para que la UI mande al usuario a la tarifa de la
    // empresa (`/clientes/{clienteId}?abrir=tarifas`).
    if (error instanceof TarifaVigenteRequeridaError) {
      return NextResponse.json(
        { error: error.message, codigo: error.codigo, detalles: error.detalles },
        { status: error.status },
      );
    }

    // Servicio que el tipo no admite o que es de otro tipo (30-sep-2026).
    if (error instanceof ServicioNoPermitidoError || error instanceof ServicioReservadoError) {
      return NextResponse.json({ error: error.message, codigo: error.codigo }, { status: error.status });
    }

    // Tipo de trámite inexistente, no habilitado para la empresa o sin agencia
    // de aduanas: errores de dominio con `status` (422).
    if (isDomainError(error)) {
      return domainErrorResponse(error);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      return NextResponse.json(
        { error: "Cliente o usuario relacionado no existe" },
        { status: 400 },
      );
    }

    throw error;
  }
}
