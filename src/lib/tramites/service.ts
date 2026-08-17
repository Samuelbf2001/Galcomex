import {
  AgenciaAduanas,
  CategoriaDocumento,
  Ciudad,
  EstadoBorrador,
  EstadoTramite,
  Prisma,
  TipoCliente,
  type TramiteDO,
} from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type CreateTramiteInput = {
  ciudad: Ciudad;
  anio?: number;
  clienteId: string;
  proveedorCliente?: string | null;
  agenciaAduanas: AgenciaAduanas;
  doAgencia?: string | null;
  doCliente?: string | null;
  eta?: Date | null;
  comentarios?: string | null;
  creadoPorId: string;
};

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

/**
 * Reunión 2026-07-01 (bloque ~01:30): "si el trámite se cerró no pueden
 * modificar nada... nadie lo puede modificar para la seguridad de la misma
 * información". Un trámite CERRADO es inmutable en cuanto a documentos:
 * no se pueden subir nuevos ni eliminar/reemplazar los existentes.
 * Función pura y testeable — sin BD.
 */
export function puedeModificarDocumentos(estado: EstadoTramite): boolean {
  return estado !== EstadoTramite.CERRADO;
}

/**
 * Traduce el filtro de query `facturado` del listado de trámites al criterio
 * de Prisma sobre la relación `borradores`. Reusa el mismo criterio que usa
 * el dashboard (`src/lib/dashboard/service.ts`: `borradores: { none: { estado:
 * "FACTURADO" } }` para "pendiente de facturar") para que ambos módulos sean
 * consistentes entre sí.
 * Función pura y testeable — sin BD.
 *
 * @param facturado  true → solo trámites con un BorradorFactura FACTURADO.
 *                   false → solo trámites SIN ningún BorradorFactura FACTURADO.
 *                   undefined → sin filtrar (no se agrega criterio).
 */
export function construirFiltroFacturado(
  facturado: boolean | undefined,
): Prisma.BorradorFacturaListRelationFilter | undefined {
  if (facturado === undefined) {
    return undefined;
  }

  return facturado
    ? { some: { estado: EstadoBorrador.FACTURADO } }
    : { none: { estado: EstadoBorrador.FACTURADO } };
}

// ─── B4: BL + Factura Comercial obligatorios para clientes SOCIO_LM ──────────
// Reunión 2026-07-01 (bloque ~00:00–00:01): Ernesto demostró en vivo que un DO
// de cliente SOCIO_LM no se puede crear sin BL ni Factura Comercial. Esa
// exigencia solo vivía en el cliente (tramites-workspace.tsx) — un
// POST /api/tramites directo la saltaba, violando las invariantes #3 y #4 de
// CLAUDE.md. Como el storageKey del documento depende del `consecutivo` (que
// solo existe una vez creado el DO), los documentos SIEMPRE se suben en una
// segunda llamada, después de crear el trámite — no es posible bloquear la
// creación misma sin rediseñar storage. La red de seguridad real se aplica en
// el primer gate de progreso operativo del DO (transición APERTURA→EN_TRAMITE,
// el mismo punto donde ya se valida el checklist y la regla Litoplas): un DO
// SOCIO_LM no puede avanzar sin esos dos documentos.
// Alcance deliberadamente limitado a SOCIO_LM (Guillermo pidió extenderlo a
// todos los clientes en la reunión, pero es decisión de negocio pendiente —
// ver .claude/PENDIENTES.md).
const DOCUMENTOS_OBLIGATORIOS_SOCIO_LM: readonly CategoriaDocumento[] = [
  CategoriaDocumento.BL,
  CategoriaDocumento.FACTURA_COMERCIAL,
];

const ETIQUETAS_CATEGORIA_DOCUMENTO: Partial<Record<CategoriaDocumento, string>> = {
  BL: "BL (Bill of Lading)",
  FACTURA_COMERCIAL: "Factura comercial",
};

function etiquetaCategoriaDocumento(categoria: CategoriaDocumento): string {
  return ETIQUETAS_CATEGORIA_DOCUMENTO[categoria] ?? categoria;
}

/**
 * Calcula qué categorías de documento obligatorias faltan para un trámite,
 * dado el tipo de cliente y las categorías de documentos ya presentes (no
 * eliminados). Solo aplica a clientes SOCIO_LM; para cualquier otro tipo
 * siempre devuelve `[]`.
 * Función pura y testeable — sin BD.
 */
export function faltanDocumentosObligatorios(
  tipoCliente: TipoCliente,
  categoriasPresentes: CategoriaDocumento[],
): CategoriaDocumento[] {
  if (tipoCliente !== TipoCliente.SOCIO_LM) {
    return [];
  }

  const presentes = new Set(categoriasPresentes);
  return DOCUMENTOS_OBLIGATORIOS_SOCIO_LM.filter((categoria) => !presentes.has(categoria));
}

function formatConsecutivo(ciudad: Ciudad, anio: number, numero: number) {
  const shortYear = String(anio).slice(-2);
  return `DO.${ciudad}${shortYear}-${String(numero).padStart(4, "0")}`;
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
  const lockKey = `tramite-do:${input.ciudad}:${anio}`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

          const ultimo = await tx.tramiteDO.findFirst({
            where: {
              ciudad: input.ciudad,
              anio,
            },
            orderBy: { numero: "desc" },
            select: { numero: true },
          });
          const numero = (ultimo?.numero ?? 0) + 1;
          const consecutivo = formatConsecutivo(input.ciudad, anio, numero);
          const plantilla = await tx.plantillaChecklist.findFirst({
            orderBy: { nombre: "asc" },
            include: {
              items: {
                orderBy: { orden: "asc" },
              },
            },
          });

          const tramite = await tx.tramiteDO.create({
            data: {
              consecutivo,
              ciudad: input.ciudad,
              anio,
              numero,
              clienteId: input.clienteId,
              proveedorCliente: input.proveedorCliente,
              agenciaAduanas: input.agenciaAduanas,
              doAgencia: input.doAgencia,
              doCliente: input.doCliente,
              eta: input.eta,
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

export const tramiteDetalleInclude = {
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

function isLitoplas(clienteNombre: string) {
  return clienteNombre.toLowerCase().includes("litoplas");
}

function validateLitoplasRule(tramite: {
  cliente: { nombre: string };
  agenciaAduanas: AgenciaAduanas;
  doAgencia: string | null;
}) {
  if (!isLitoplas(tramite.cliente.nombre)) {
    return null;
  }

  if (tramite.agenciaAduanas !== AgenciaAduanas.MOVIADUANAS) {
    return "Litoplas debe operar con Moviaduanas";
  }

  if (!tramite.doAgencia || !/^I\d{8}$/.test(tramite.doAgencia)) {
    return "Litoplas requiere DO de agencia con formato I########";
  }

  return null;
}

export async function transitionTramite(
  tramiteId: string,
  estadoDes: EstadoTramite,
  usuarioId: string,
  bypassChecklist = false,
): Promise<TransitionResult> {
  return prisma.$transaction(async (tx) => {
    const actual = await tx.tramiteDO.findUnique({
      where: { id: tramiteId },
      include: {
        cliente: { select: { nombre: true, tipo: true } },
        checklistItems: true,
        documentos: {
          where: { eliminado: false },
          select: { categoria: true },
        },
      },
    });

    if (!actual) {
      return { ok: false, status: 404, message: "Tramite no encontrado" };
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

      const litoplasError = validateLitoplasRule(actual);

      if (litoplasError) {
        return {
          ok: false,
          status: 422,
          message: litoplasError,
        };
      }

      // B4: hueco de seguridad — la exigencia de BL + Factura Comercial para
      // SOCIO_LM solo vivía en el cliente. No es bypasseable con `bypassChecklist`
      // (igual que Litoplas): es un requisito estructural, no un hábito operativo.
      const documentosFaltantes = faltanDocumentosObligatorios(
        actual.cliente.tipo,
        actual.documentos.map((documento) => documento.categoria),
      );

      if (documentosFaltantes.length > 0) {
        return {
          ok: false,
          status: 422,
          message: `Faltan documentos obligatorios para clientes SOCIO_LM: ${documentosFaltantes
            .map(etiquetaCategoriaDocumento)
            .join(", ")}`,
          faltantes: documentosFaltantes.map(etiquetaCategoriaDocumento),
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
