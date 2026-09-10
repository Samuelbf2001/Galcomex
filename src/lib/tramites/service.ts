import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Prisma,
  Rol,
  TipoCliente,
  type TramiteDO,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { configDe, tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import {
  validateReglaAgenciaFija,
  type ConfigReglaAgencia,
} from "@/lib/tramites/reglas";
import {
  claveSecuencia,
  filtroSecuencia,
  formatConsecutivo,
} from "@/lib/tramites/consecutivo";

type CreateTramiteInput = {
  ciudad: Ciudad;
  anio?: number;
  clienteId: string;
  /** Código de `TipoTramite`. Por defecto IMPORTACION (el trámite de siempre). */
  tipoTramiteCodigo?: string;
  /** N° que asigna un tercero (informe de la clasificadora, p. ej. 2140). */
  referenciaExterna?: string | null;
  proveedorCliente?: string | null;
  /** Opcional: los tipos con `requiereAgenciaAduanas = false` usan el default del tipo. */
  agenciaAduanas?: AgenciaAduanas;
  doAgencia?: string | null;
  doCliente?: string | null;
  eta?: Date | null;
  comentarios?: string | null;
  creadoPorId: string;
};

export class TipoTramiteNoEncontradoError extends Error {
  public readonly status = 422;
  constructor(codigo: string) {
    super(`El tipo de trámite ${codigo} no existe o está inactivo`);
    this.name = "TipoTramiteNoEncontradoError";
  }
}

export class TipoTramiteNoHabilitadoError extends Error {
  public readonly status = 422;
  constructor(nombreTipo: string, nombreEmpresa: string) {
    super(
      `${nombreEmpresa} no tiene habilitada la función "${nombreTipo}". Actívala en la ficha de la empresa, pestaña Funciones.`,
    );
    this.name = "TipoTramiteNoHabilitadoError";
  }
}

export class AgenciaAduanasRequeridaError extends Error {
  public readonly status = 422;
  constructor(nombreTipo: string) {
    super(`Los trámites de tipo "${nombreTipo}" requieren agencia de aduanas`);
    this.name = "AgenciaAduanasRequeridaError";
  }
}

type TransitionResult =
  | { ok: true; tramite: TramiteDO }
  | { ok: false; status: number; message: string; faltantes?: string[] };

const transitionMap: Record<EstadoTramite, EstadoTramite[]> = {
  SOLICITUD: [EstadoTramite.APERTURA],
  APERTURA: [EstadoTramite.EN_TRAMITE],
  EN_TRAMITE: [EstadoTramite.EN_PUERTO],
  EN_PUERTO: [EstadoTramite.DESPACHADO],
  DESPACHADO: [EstadoTramite.ENVIADO_A_FACTURAR],
  ENVIADO_A_FACTURAR: [EstadoTramite.FACTURADO],
  FACTURADO: [EstadoTramite.PAGADO],
  PAGADO: [EstadoTramite.CERRADO],
  CERRADO: [],
};

const TIPO_TRAMITE_POR_DEFECTO = "IMPORTACION";

/**
 * Carga el tipo de trámite y valida que la empresa pueda abrir trámites de ese
 * tipo. La clasificación arancelaria, por ejemplo, exige que el cliente tenga
 * encendida la capacidad `clasificacion_arancelaria` (M1 + M4).
 */
async function resolverTipoTramite(codigo: string, clienteId: string) {
  const tipo = await prisma.tipoTramite.findFirst({
    where: { codigo, activo: true },
  });

  if (!tipo) {
    throw new TipoTramiteNoEncontradoError(codigo);
  }

  if (tipo.capacidadRequerida) {
    const [capacidades, cliente] = await Promise.all([
      capacidadesDeEmpresa(clienteId),
      prisma.cliente.findUnique({ where: { id: clienteId }, select: { nombre: true } }),
    ]);

    if (!tiene(capacidades, tipo.capacidadRequerida)) {
      throw new TipoTramiteNoHabilitadoError(tipo.nombre, cliente?.nombre ?? "La empresa");
    }
  }

  return tipo;
}

function shouldRetryPrisma(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}

function normalizeSerializable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, nestedValue) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
    ),
  ) as T;
}

export async function createTramite(input: CreateTramiteInput) {
  const anio = input.anio ?? new Date().getFullYear();
  const attempts = 5;

  const tipo = await resolverTipoTramite(
    input.tipoTramiteCodigo ?? TIPO_TRAMITE_POR_DEFECTO,
    input.clienteId,
  );

  // Cada tipo decide si pide agencia de aduanas. La clasificación arancelaria
  // no la necesita y queda en null, en vez de inventar un valor para llenar la
  // columna.
  const agenciaAduanas =
    input.agenciaAduanas ?? tipo.agenciaAduanasPorDefecto ?? null;

  if (tipo.requiereAgenciaAduanas && !agenciaAduanas) {
    throw new AgenciaAduanasRequeridaError(tipo.nombre);
  }

  const lockKey = claveSecuencia(tipo, tipo.codigo, input.ciudad, anio);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

          const ultimo = await tx.tramiteDO.findFirst({
            where: filtroSecuencia(tipo, tipo.codigo, input.ciudad, anio),
            orderBy: { numero: "desc" },
            select: { numero: true },
          });
          const numero = (ultimo?.numero ?? 0) + 1;
          const consecutivo = formatConsecutivo(tipo, input.ciudad, anio, numero);
          const plantilla = tipo.usaChecklist
            ? await tx.plantillaChecklist.findFirst({
                orderBy: { nombre: "asc" },
                include: {
                  items: {
                    orderBy: { orden: "asc" },
                  },
                },
              })
            : null;

          const tramite = await tx.tramiteDO.create({
            data: {
              consecutivo,
              tipoTramiteCodigo: tipo.codigo,
              referenciaExterna: input.referenciaExterna ?? null,
              ciudad: input.ciudad,
              anio,
              numero,
              clienteId: input.clienteId,
              proveedorCliente: input.proveedorCliente,
              agenciaAduanas,
              doAgencia: input.doAgencia,
              doCliente: input.doCliente,
              eta: tipo.requiereEta ? input.eta : null,
              comentarios: input.comentarios,
              creadoPorId: input.creadoPorId,
              checklistItems: plantilla
                ? {
                    create: plantilla.items.map((item) => ({
                      descripcion: item.descripcion,
                      requerido: item.requerido,
                    })),
                  }
                : undefined,
            },
            include: tramiteInclude,
          });

          await tx.auditLog.create({
            data: {
              entidad: "TramiteDO",
              entidadId: tramite.id,
              accion: "CREATE",
              usuarioId: input.creadoPorId,
              tramiteId: tramite.id,
              despues: normalizeSerializable(tramite),
            },
          });

          return tramite;
        },
      );
    } catch (error) {
      if (attempt < attempts && shouldRetryPrisma(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("No fue posible generar el consecutivo del DO");
}

export const tramiteInclude = {
  cliente: {
    select: {
      id: true,
      nombre: true,
      nit: true,
      tipo: true,
    },
  },
  creadoPor: {
    select: {
      id: true,
      name: true,
      email: true,
      rol: true,
    },
  },
  checklistItems: {
    orderBy: { descripcion: "asc" },
  },
} satisfies Prisma.TramiteDOInclude;

// ─── Listado con filtros ──────────────────────────────────────────────────────
// Estados del ciclo de vida en los que el trámite ya paso por facturación.
// Un trámite tambien se considera facturado si alguno de sus borradores llego
// a estado FACTURADO (momento en el que se crea el registro Factura — ver
// borradores/service.ts). Se combinan ambas señales con OR porque el estado
// del TramiteDO y el estado del BorradorFactura se actualizan por separado y
// pueden desincronizarse (p.ej. un TramiteDO movido manualmente a FACTURADO
// sin que exista aun el borrador facturado, o viceversa).
const ESTADOS_FACTURADOS: EstadoTramite[] = [
  EstadoTramite.FACTURADO,
  EstadoTramite.PAGADO,
  EstadoTramite.CERRADO,
];

export type TramiteListQuery = {
  q?: string;
  estado?: EstadoTramite;
  ciudad?: Ciudad;
  clienteId?: string;
  tipoCliente?: TipoCliente;
  /** true = solo facturados, false = solo no facturados, undefined = sin filtro. */
  facturado?: boolean;
  take?: number;
  skip?: number;
};

export type TramiteListOptions = {
  /**
   * Scoping del rol SOCIO: solo ve tramites de clientes tipo SOCIO_LM.
   * Se aplica SIEMPRE con AND respecto a los demas filtros — nunca se
   * debilita (si ademas se pide tipoCliente=PROPIO, el resultado es vacio).
   */
  socioScope?: boolean;
};

export async function listTramites(
  query: TramiteListQuery,
  options: TramiteListOptions = {},
) {
  const where: Prisma.TramiteDOWhereInput = {};
  const and: Prisma.TramiteDOWhereInput[] = [];

  if (query.estado) {
    where.estado = query.estado;
  }

  if (query.ciudad) {
    where.ciudad = query.ciudad;
  }

  if (query.clienteId) {
    where.clienteId = query.clienteId;
  }

  if (query.q) {
    and.push({
      OR: [
        { consecutivo: { contains: query.q, mode: "insensitive" } },
        { doAgencia: { contains: query.q, mode: "insensitive" } },
        { doCliente: { contains: query.q, mode: "insensitive" } },
        { cliente: { nombre: { contains: query.q, mode: "insensitive" } } },
      ],
    });
  }

  if (query.tipoCliente) {
    and.push({ cliente: { tipo: query.tipoCliente } });
  }

  if (query.facturado === true) {
    and.push({
      OR: [
        { estado: { in: ESTADOS_FACTURADOS } },
        { borradores: { some: { estado: EstadoBorrador.FACTURADO } } },
      ],
    });
  } else if (query.facturado === false) {
    and.push({
      estado: { notIn: ESTADOS_FACTURADOS },
      borradores: { none: { estado: EstadoBorrador.FACTURADO } },
    });
  }

  if (options.socioScope) {
    and.push({ cliente: { tipo: TipoCliente.SOCIO_LM } });
  }

  if (and.length > 0) {
    where.AND = and;
  }

  const [tramites, total] = await prisma.$transaction([
    prisma.tramiteDO.findMany({
      where,
      orderBy: [{ anio: "desc" }, { ciudad: "asc" }, { numero: "desc" }],
      take: query.take ?? 50,
      skip: query.skip ?? 0,
      include: tramiteInclude,
    }),
    prisma.tramiteDO.count({ where }),
  ]);

  return { tramites, total };
}

export const tramiteDetalleInclude = {
  cliente: {
    select: {
      id: true,
      nombre: true,
      nit: true,
      tipo: true,
    },
  },
  tipoTramite: {
    select: {
      codigo: true,
      nombre: true,
      etiquetaReferenciaExterna: true,
      facturacionSeparada: true,
      lineaServicio: true,
    },
  },
  creadoPor: {
    select: {
      name: true,
    },
  },
  checklistItems: {
    orderBy: { descripcion: "asc" },
  },
  estadoLogs: {
    orderBy: { createdAt: "desc" },
  },
  aplicacionesAnticipo: {
    include: {
      anticipo: {
        select: {
          id: true,
          monto: true,
          fecha: true,
          tipoRecaudo: true,
          costoRecaudo: true,
          verificadoBanco: true,
          estado: true,
          soporteKey: true,
        },
      },
    },
  },
  borradores: {
    orderBy: { createdAt: "desc" },
    include: {
      factura: true,
    },
  },
  auditLogs: {
    orderBy: { createdAt: "desc" },
    take: 30,
    include: {
      usuario: {
        select: { name: true },
      },
    },
  },
} satisfies Prisma.TramiteDOInclude;

export async function transitionTramite(
  tramiteId: string,
  estadoDes: EstadoTramite,
  usuarioId: string,
  bypassChecklist = false,
  /**
   * Rol del usuario que solicita la transición. Solo se usa para decidir la
   * "reapertura de emergencia" cuando el trámite YA está CERRADO (punto 3 del
   * guard transversal): en ese caso, únicamente ADMIN puede sacarlo de
   * CERRADO, y queda un AuditLog explícito con accion "REAPERTURA". Si no se
   * provee (callers que nunca transicionan un trámite CERRADO, p.ej.
   * solicitarFacturacion), se trata como "no ADMIN" — deniega por defecto.
   */
  usuarioRol?: Rol,
): Promise<TransitionResult> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.tramiteDO.findUnique({
      where: { id: tramiteId },
      include: {
        cliente: { select: { nombre: true } },
        checklistItems: true,
      },
    });

    if (!actual) {
      return { ok: false, status: 404, message: "Tramite no encontrado" };
    }

    // Reapertura de emergencia: el trámite YA está CERRADO (estado terminal).
    // Bloqueo total salvo ADMIN, que puede sacarlo de CERRADO hacia cualquier
    // estado — queda auditado con accion "REAPERTURA" (distinta de
    // "UPDATE_ESTADO") para que sea trazable como excepción. No aplica cuando
    // el destino también es CERRADO (no-op sin sentido de negocio).
    if (actual.estado === EstadoTramite.CERRADO && estadoDes !== EstadoTramite.CERRADO) {
      if (usuarioRol !== Rol.ADMIN) {
        return {
          ok: false,
          status: 403,
          message: `El trámite ${actual.consecutivo} está cerrado. Solo un ADMIN puede reabrirlo.`,
        };
      }

      const reabierto = await tx.tramiteDO.update({
        where: { id: tramiteId },
        data: { estado: estadoDes },
        include: tramiteInclude,
      });

      await tx.estadoLog.create({
        data: {
          tramiteId,
          estadoAntes: actual.estado,
          estadoDes,
          usuarioId,
        },
      });

      await tx.auditLog.create({
        data: {
          entidad: "TramiteDO",
          entidadId: tramiteId,
          accion: "REAPERTURA",
          usuarioId,
          tramiteId,
          antes: normalizeSerializable({ estado: actual.estado }),
          despues: normalizeSerializable({ estado: estadoDes }),
        },
      });

      return { ok: true, tramite: reabierto };
    }

    if (!bypassChecklist && !transitionMap[actual.estado].includes(estadoDes)) {
      return {
        ok: false,
        status: 422,
        message: `Transicion invalida: ${actual.estado} -> ${estadoDes}`,
      };
    }

    if (
      actual.estado === EstadoTramite.APERTURA &&
      estadoDes === EstadoTramite.EN_TRAMITE
    ) {
      if (!bypassChecklist) {
        const faltantes = actual.checklistItems
          .filter((item) => item.requerido && !item.recibido)
          .map((item) => item.descripcion);

        if (faltantes.length > 0) {
          return {
            ok: false,
            status: 422,
            message: "Checklist requerido incompleto",
            faltantes,
          };
        }
      }

      const capacidades = await capacidadesDeEmpresa(actual.clienteId);
      const reglaError = validateReglaAgenciaFija(
        actual,
        configDe<ConfigReglaAgencia>(capacidades, "regla_agencia_fija"),
      );

      if (reglaError) {
        return {
          ok: false,
          status: 422,
          message: reglaError,
        };
      }
    }

    const updated = await tx.tramiteDO.update({
      where: { id: tramiteId },
      data: { estado: estadoDes },
      include: tramiteInclude,
    });

    await tx.estadoLog.create({
      data: {
        tramiteId,
        estadoAntes: actual.estado,
        estadoDes,
        usuarioId,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "TramiteDO",
        entidadId: tramiteId,
        accion: "UPDATE_ESTADO",
        usuarioId,
        tramiteId,
        antes: normalizeSerializable({ estado: actual.estado }),
        despues: normalizeSerializable({ estado: estadoDes }),
      },
    });

    return { ok: true, tramite: updated };
  });
}

export { formatConsecutivo };
