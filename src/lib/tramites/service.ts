import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoTarifario,
  EstadoTramite,
  Prisma,
  Rol,
  TipoCliente,
  type TramiteDO,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { configDe, tiene, type MapaCapacidades } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { tarifarioVigenteDe } from "@/lib/tarifas/service";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import {
  aplicarReglaAgenciaAlCrear,
  validateReglaAgenciaFija,
  type ConfigReglaAgencia,
} from "@/lib/tramites/reglas";
import {
  abreSolicitud,
  armarRequisitos,
  documentosFaltantes,
  documentosRequeridos,
  entraAOperacion,
  esEstadoOperativo,
  exigeTarifaVigente,
  mensajeDocumentosFaltantes,
  mensajeTarifaRequerida,
  tarifaFueraDeFecha,
  type DocumentoObligatorio,
  type RequisitosDo,
  type TarifaFueraDeFecha,
  type TarifarioResumen,
} from "@/lib/tramites/requisitos";
import {
  claveSecuencia,
  filtroSecuencia,
  formatConsecutivo,
} from "@/lib/tramites/consecutivo";
import {
  construirOrdenTramites,
  type DireccionOrden,
  type OrdenTramitesCampo,
} from "@/lib/tramites/orden";

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

/**
 * De dónde viene el DO. `SOLICITUD_PUBLICA` era el formulario externo
 * (`POST /api/solicitudes`, sin sesión, retirado el 2026-09-24): entraba
 * aunque la empresa no tuviera tarifa vigente, pero no se podía abrir hasta
 * publicarla. Los DOs creados así siguen existiendo como históricos y
 * conservan esa regla.
 */
export type OrigenTramite = "INTERNO" | "SOLICITUD_PUBLICA";

export type CreateTramiteOptions = {
  origen?: OrigenTramite;
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

/** La empresa tiene agencia fija y el trámite no la cumple (agencia o formato del DO). */
export class ReglaAgenciaFijaError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ReglaAgenciaFijaError";
  }
}

export class AgenciaAduanasRequeridaError extends Error {
  public readonly status = 422;
  constructor(nombreTipo: string) {
    super(`Los trámites de tipo "${nombreTipo}" requieren agencia de aduanas`);
    this.name = "AgenciaAduanasRequeridaError";
  }
}

export type DetallesTarifaVigenteRequerida = {
  clienteId: string;
  lineaServicio: string;
  tipoTramiteCodigo: string;
};

/**
 * D1 (capacidad `do_exige_tarifa_vigente`): la empresa no tiene tarifa
 * VIGENTE hoy para la línea de servicio del trámite. Los `detalles` le sirven
 * a la UI para llevar al usuario a la tarifa de la empresa.
 */
export class TarifaVigenteRequeridaError extends Error {
  public readonly status = 422;
  public readonly codigo = "TARIFA_VIGENTE_REQUERIDA" as const;
  public readonly detalles: DetallesTarifaVigenteRequerida;
  constructor(mensaje: string, detalles: DetallesTarifaVigenteRequerida) {
    super(mensaje);
    this.name = "TarifaVigenteRequeridaError";
    this.detalles = detalles;
  }
}

export type DetallesDocumentosObligatorios = {
  tramiteId: string;
  consecutivo: string;
  documentosFaltantes: DocumentoObligatorio[];
};

/**
 * D2 (capacidad `docs_bl_factura_obligatorios`): al DO le falta el BL o la
 * factura comercial para pasar de APERTURA a EN_TRAMITE.
 */
export class DocumentosObligatoriosFaltantesError extends Error {
  public readonly status = 422;
  public readonly codigo = "DOCUMENTOS_OBLIGATORIOS_FALTANTES" as const;
  public readonly detalles: DetallesDocumentosObligatorios;
  constructor(detalles: DetallesDocumentosObligatorios) {
    super(mensajeDocumentosFaltantes(detalles.documentosFaltantes, detalles.consecutivo));
    this.name = "DocumentosObligatoriosFaltantesError";
    this.detalles = detalles;
  }
}

type TransitionResult =
  | {
      ok: true;
      tramite: TramiteDO;
      /**
       * Requisitos que el ADMIN se saltó con su excepción (checklist, BL y
       * factura comercial). Cada uno queda además en un AuditLog
       * `OMITIR_REQUISITOS`. Vacío en una transición normal.
       */
      advertencias: string[];
    }
  | {
      ok: false;
      status: number;
      message: string;
      faltantes?: string[];
      /** Código estable del bloqueo (p. ej. `TARIFA_VIGENTE_REQUERIDA`). */
      codigo?: string;
      detalles?: Record<string, unknown>;
    };

function falloDeRegla(
  error: TarifaVigenteRequeridaError | DocumentosObligatoriosFaltantesError,
): TransitionResult {
  return {
    ok: false,
    status: error.status,
    message: error.message,
    codigo: error.codigo,
    detalles: { ...error.detalles },
  };
}

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
async function resolverTipoTramite(
  codigo: string,
  capacidades: MapaCapacidades,
  nombreEmpresa: string,
) {
  const tipo = await prisma.tipoTramite.findFirst({
    where: { codigo, activo: true },
  });

  if (!tipo) {
    throw new TipoTramiteNoEncontradoError(codigo);
  }

  if (tipo.capacidadRequerida && !tiene(capacidades, tipo.capacidadRequerida)) {
    throw new TipoTramiteNoHabilitadoError(tipo.nombre, nombreEmpresa);
  }

  return tipo;
}

/**
 * Tarifa de la empresa para una línea de servicio en una fecha: la vigente (si
 * hay) o, si no, por qué la publicada no sirve (vencida o todavía no rige).
 * Mismo criterio que la facturación (`tarifarioVigenteDe`).
 */
async function tarifaParaDo(
  empresaId: string,
  lineaServicio: string,
  fecha: Date,
): Promise<{ tarifario: TarifarioResumen | null; fueraDeFecha: TarifaFueraDeFecha | null }> {
  const vigente = await tarifarioVigenteDe(empresaId, lineaServicio, fecha);

  if (vigente) {
    return {
      tarifario: {
        id: vigente.id,
        nombre: vigente.nombre,
        version: vigente.version,
        vigenteHasta: vigente.vigenteHasta,
      },
      fueraDeFecha: null,
    };
  }

  const publicada = await prisma.tarifario.findFirst({
    where: { empresaId, alcance: lineaServicio, estado: EstadoTarifario.VIGENTE },
    orderBy: { version: "desc" },
    select: { vigenteDesde: true, vigenteHasta: true },
  });

  return { tarifario: null, fueraDeFecha: tarifaFueraDeFecha(publicada, fecha) };
}

/**
 * D1 — Sin tarifa vigente no hay DO. Devuelve el error (sin lanzarlo) para que
 * la creación lo lance y la transición lo convierta en su resultado 422.
 */
async function verificarTarifaVigente(args: {
  clienteId: string;
  nombreEmpresa: string;
  tipo: { codigo: string; lineaServicio: string };
  capacidades: MapaCapacidades;
  /** Consecutivo al abrir una solicitud; `null` al crear. */
  consecutivo: string | null;
}): Promise<TarifaVigenteRequeridaError | null> {
  if (!exigeTarifaVigente(args.capacidades, args.tipo.codigo)) {
    return null;
  }

  // F5: "hoy" es el día calendario en Bogotá, no el instante UTC (ver
  // `lib/tiempo/bogota.ts`) — si no, D1 deja de exigir tarifa 5 horas antes de
  // medianoche en Bogotá el último día de vigencia.
  const tarifa = await tarifaParaDo(
    args.clienteId,
    args.tipo.lineaServicio,
    fechaCalendarioBogota(),
  );

  if (tarifa.tarifario) {
    return null;
  }

  return new TarifaVigenteRequeridaError(
    mensajeTarifaRequerida({
      empresa: args.nombreEmpresa,
      lineaServicio: args.tipo.lineaServicio,
      tarifarioPropioActivo: tiene(args.capacidades, "tarifario_propio"),
      fueraDeFecha: tarifa.fueraDeFecha,
      consecutivo: args.consecutivo,
    }),
    {
      clienteId: args.clienteId,
      lineaServicio: args.tipo.lineaServicio,
      tipoTramiteCodigo: args.tipo.codigo,
    },
  );
}

type DocumentosObligatoriosResultado =
  | { ok: true; documentosOmitidos: DocumentoObligatorio[]; advertencia: string | null }
  | { ok: false; fallo: TransitionResult };

/**
 * D2 — BL y factura comercial (documentos no eliminados) antes de entrar a la
 * operación. Sin bypass, un faltante es un 422 (`fallo`); con la excepción de
 * ADMIN (`bypassChecklist`) deja pasar y devuelve qué se omitió, para que el
 * llamador arme la advertencia y el AuditLog `OMITIR_REQUISITOS`. La usan
 * tanto la transición normal como la reapertura de un CERRADO (F4): mismas
 * reglas sin importar de dónde salga el DO, sin una segunda implementación.
 */
async function verificarDocumentosObligatorios(args: {
  tx: Prisma.TransactionClient;
  tramiteId: string;
  consecutivo: string;
  tipoTramiteCodigo: string;
  capacidades: MapaCapacidades;
  bypassChecklist: boolean;
}): Promise<DocumentosObligatoriosResultado> {
  const requeridos = documentosRequeridos(args.capacidades, args.tipoTramiteCodigo);

  if (requeridos.length === 0) {
    return { ok: true, documentosOmitidos: [], advertencia: null };
  }

  const presentes = await args.tx.documento.findMany({
    where: { tramiteId: args.tramiteId, eliminado: false, categoria: { in: requeridos } },
    select: { categoria: true },
  });
  const faltan = documentosFaltantes(
    requeridos,
    presentes.map((documento) => documento.categoria),
  );

  if (faltan.length === 0) {
    return { ok: true, documentosOmitidos: [], advertencia: null };
  }

  const error = new DocumentosObligatoriosFaltantesError({
    tramiteId: args.tramiteId,
    consecutivo: args.consecutivo,
    documentosFaltantes: faltan,
  });

  if (!args.bypassChecklist) {
    return { ok: false, fallo: falloDeRegla(error) };
  }

  return {
    ok: true,
    documentosOmitidos: faltan,
    advertencia: `${error.message} Pasó por excepción de ADMIN y quedó registrado en el historial.`,
  };
}

/**
 * Qué le pide el sistema a un DO de esta empresa y tipo, para que la UI lo
 * muestre ANTES de crear (`GET /api/tramites/requisitos`). Usa las mismas
 * reglas puras que los guards de `createTramite` y `transitionTramite`.
 */
export async function requisitosDeDo(input: {
  clienteId: string;
  tipoTramiteCodigo?: string;
  fecha?: Date;
}): Promise<RequisitosDo> {
  // F5: mismo criterio que `verificarTarifaVigente` — "hoy" es el día
  // calendario en Bogotá, no el instante UTC.
  const fecha = input.fecha ?? fechaCalendarioBogota();
  const codigo = input.tipoTramiteCodigo ?? TIPO_TRAMITE_POR_DEFECTO;

  // `capacidadesDeEmpresa` lanza EmpresaNoEncontradaError (404) si no existe.
  const [capacidades, empresa] = await Promise.all([
    capacidadesDeEmpresa(input.clienteId),
    prisma.cliente.findUnique({ where: { id: input.clienteId }, select: { nombre: true } }),
  ]);

  const tipo = await prisma.tipoTramite.findFirst({
    where: { codigo, activo: true },
    select: { codigo: true, lineaServicio: true },
  });

  if (!tipo) {
    throw new TipoTramiteNoEncontradoError(codigo);
  }

  const tarifa = await tarifaParaDo(input.clienteId, tipo.lineaServicio, fecha);

  return armarRequisitos({
    capacidades,
    empresa: empresa?.nombre ?? "La empresa",
    tipoTramite: tipo,
    tarifario: tarifa.tarifario,
    fueraDeFecha: tarifa.fueraDeFecha,
  });
}

function shouldRetryPrisma(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}


export async function createTramite(
  input: CreateTramiteInput,
  opciones: CreateTramiteOptions = {},
) {
  const anio = input.anio ?? new Date().getFullYear();
  const attempts = 5;
  const origen: OrigenTramite = opciones.origen ?? "INTERNO";

  // Una sola lectura de capacidades por creación: la usan el tipo de trámite,
  // la tarifa vigente (D1) y la agencia fija. `capacidadesDeEmpresa` lanza
  // EmpresaNoEncontradaError (404) si la empresa no existe.
  const [capacidades, empresa] = await Promise.all([
    capacidadesDeEmpresa(input.clienteId),
    prisma.cliente.findUnique({ where: { id: input.clienteId }, select: { nombre: true } }),
  ]);
  const nombreEmpresa = empresa?.nombre ?? "La empresa";

  const tipo = await resolverTipoTramite(
    input.tipoTramiteCodigo ?? TIPO_TRAMITE_POR_DEFECTO,
    capacidades,
    nombreEmpresa,
  );

  // D1 — sin tarifa vigente no hay DO (capacidad `do_exige_tarifa_vigente`).
  // La solicitud externa sí entra: queda en SOLICITUD y `transitionTramite`
  // no la deja abrir hasta que la tarifa esté publicada.
  if (origen !== "SOLICITUD_PUBLICA") {
    const faltaTarifa = await verificarTarifaVigente({
      clienteId: input.clienteId,
      nombreEmpresa,
      tipo,
      capacidades,
      consecutivo: null,
    });

    if (faltaTarifa) {
      throw faltaTarifa;
    }
  }

  // Cada tipo decide si pide agencia de aduanas. La clasificación arancelaria
  // no la necesita y queda en null, en vez de inventar un valor para llenar la
  // columna.
  // Agencia fija de la empresa (capacidad `regla_agencia_fija`, caso Litoplas →
  // Moviaduanas): si el tipo pide agencia, la de la regla manda desde la creación.
  let agenciaAduanas: AgenciaAduanas | null =
    input.agenciaAduanas ?? tipo.agenciaAduanasPorDefecto ?? null;

  if (tipo.requiereAgenciaAduanas) {
    const regla = aplicarReglaAgenciaAlCrear(
      configDe<ConfigReglaAgencia>(capacidades, "regla_agencia_fija"),
      { agenciaAduanas: input.agenciaAduanas ?? null, doAgencia: input.doAgencia ?? null },
      nombreEmpresa,
    );
    if (!regla.ok) throw new ReglaAgenciaFijaError(regla.mensaje);
    if (regla.agenciaAduanas) agenciaAduanas = regla.agenciaAduanas as AgenciaAduanas;
  }

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
  // Solo `usaCamposDo`: la lista lo usa para decidir si la columna
  // "Referencia" muestra `referenciaExterna` en vez del coalesce de siempre
  // (ver `normalizeRow` en tramites-api.ts).
  tipoTramite: {
    select: {
      usaCamposDo: true,
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
  /** Columna de orden (A8); ausente = orden de siempre. La vista kanban nunca la manda. */
  ordenarPor?: OrdenTramitesCampo;
  direccion?: DireccionOrden;
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
      orderBy: construirOrdenTramites(query.ordenarPor, query.direccion),
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
      // Revisión de Ernesto 22-sep-2026 (tanda 2): la cabecera del DO y el
      // panel "Base de cálculo y eventos" ocultan campos por tipo de trámite.
      requiereEta: true,
      usaCamposDo: true,
      camposBaseCalculo: true,
      usaEventos: true,
      fechasClave: true,
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
        tipoTramite: {
          select: { codigo: true, lineaServicio: true, requiereAgenciaAduanas: true },
        },
      },
    });

    if (!actual) {
      return { ok: false, status: 404, message: "Tramite no encontrado" };
    }

    // Las capacidades se leen una sola vez y solo si alguna regla las
    // necesita. Se declara antes de la reapertura de emergencia (F4) porque
    // esa rama también la usa para D1/D2.
    let capacidadesLeidas: MapaCapacidades | null = null;
    const capacidadesDelCliente = async (): Promise<MapaCapacidades> => {
      if (!capacidadesLeidas) {
        capacidadesLeidas = await capacidadesDeEmpresa(actual.clienteId);
      }
      return capacidadesLeidas;
    };

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

      // F4 — reabrir no es un atajo para saltarse D1/D2: si el destino deja
      // de ser SOLICITUD, exige la misma tarifa vigente que abrir una
      // solicitud (sin excepción de ADMIN, igual que abajo); si llega a
      // EN_TRAMITE o más allá, exige los mismos documentos, con la misma
      // excepción de ADMIN vía `bypassChecklist`. Reutiliza exactamente las
      // funciones de guard de la transición normal — nada se reimplementa.
      const advertenciasReapertura: string[] = [];
      let documentosOmitidosReapertura: DocumentoObligatorio[] = [];

      if (estadoDes !== EstadoTramite.SOLICITUD) {
        const faltaTarifa = await verificarTarifaVigente({
          clienteId: actual.clienteId,
          nombreEmpresa: actual.cliente.nombre,
          tipo: actual.tipoTramite,
          capacidades: await capacidadesDelCliente(),
          consecutivo: actual.consecutivo,
        });

        if (faltaTarifa) {
          return falloDeRegla(faltaTarifa);
        }
      }

      if (esEstadoOperativo(estadoDes)) {
        const resultado = await verificarDocumentosObligatorios({
          tx,
          tramiteId,
          consecutivo: actual.consecutivo,
          tipoTramiteCodigo: actual.tipoTramite.codigo,
          capacidades: await capacidadesDelCliente(),
          bypassChecklist,
        });

        if (!resultado.ok) {
          return resultado.fallo;
        }

        documentosOmitidosReapertura = resultado.documentosOmitidos;
        if (resultado.advertencia) advertenciasReapertura.push(resultado.advertencia);
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

      if (documentosOmitidosReapertura.length > 0) {
        await tx.auditLog.create({
          data: {
            entidad: "TramiteDO",
            entidadId: tramiteId,
            accion: "OMITIR_REQUISITOS",
            usuarioId,
            tramiteId,
            antes: normalizeSerializable({
              estado: actual.estado,
              documentosFaltantes: documentosOmitidosReapertura,
            }),
            despues: normalizeSerializable({ estado: estadoDes }),
          },
        });
      }

      return { ok: true, tramite: reabierto, advertencias: advertenciasReapertura };
    }

    if (!bypassChecklist && !transitionMap[actual.estado].includes(estadoDes)) {
      return {
        ok: false,
        status: 422,
        message: `Transicion invalida: ${actual.estado} -> ${estadoDes}`,
      };
    }

    // D1 — Abrir una solicitud exige tarifa vigente, igual que crear el DO:
    // así la solicitud pública (que entra sin tarifa) no se cuela. No hay
    // excepción de ADMIN: quien deba saltársela apaga la función en la ficha
    // de la empresa, y ese cambio queda en el AuditLog de capacidades.
    if (abreSolicitud(actual.estado, estadoDes)) {
      const faltaTarifa = await verificarTarifaVigente({
        clienteId: actual.clienteId,
        nombreEmpresa: actual.cliente.nombre,
        tipo: actual.tipoTramite,
        capacidades: await capacidadesDelCliente(),
        consecutivo: actual.consecutivo,
      });

      if (faltaTarifa) {
        return falloDeRegla(faltaTarifa);
      }
    }

    const esAperturaAEnTramite =
      actual.estado === EstadoTramite.APERTURA && estadoDes === EstadoTramite.EN_TRAMITE;
    const pasaAOperacion = entraAOperacion(actual.estado, estadoDes);
    const checklistPendiente = actual.checklistItems
      .filter((item) => item.requerido && !item.recibido)
      .map((item) => item.descripcion);

    if (esAperturaAEnTramite && !bypassChecklist && checklistPendiente.length > 0) {
      return {
        ok: false,
        status: 422,
        message: "Checklist requerido incompleto",
        faltantes: checklistPendiente,
      };
    }

    // D2 — BL y factura comercial adjuntos (documentos no eliminados) antes de
    // entrar a la operación. La excepción del ADMIN (la misma del checklist)
    // deja pasar, pero nunca en silencio: advertencia + AuditLog aparte.
    const advertencias: string[] = [];
    let documentosOmitidos: DocumentoObligatorio[] = [];

    if (pasaAOperacion) {
      const resultado = await verificarDocumentosObligatorios({
        tx,
        tramiteId,
        consecutivo: actual.consecutivo,
        tipoTramiteCodigo: actual.tipoTramite.codigo,
        capacidades: await capacidadesDelCliente(),
        bypassChecklist,
      });

      if (!resultado.ok) {
        return resultado.fallo;
      }

      documentosOmitidos = resultado.documentosOmitidos;
      if (resultado.advertencia) advertencias.push(resultado.advertencia);
    }

    const checklistOmitido = pasaAOperacion && bypassChecklist ? checklistPendiente : [];

    if (checklistOmitido.length > 0) {
      advertencias.push(
        `El checklist del ${actual.consecutivo} estaba incompleto (${checklistOmitido.join(", ")}). Pasó por excepción de ADMIN y quedó registrado en el historial.`,
      );
    }

    if (esAperturaAEnTramite) {
      // La agencia fija (Litoplas → Moviaduanas + DO I########) solo aplica a
      // los tipos que llevan agencia, igual que en `createTramite`: una
      // clasificación o un Plan Vallejo no tienen DO de agencia y quedaban
      // atascados en APERTURA.
      const reglaError = actual.tipoTramite.requiereAgenciaAduanas
        ? validateReglaAgenciaFija(
            actual,
            configDe<ConfigReglaAgencia>(await capacidadesDelCliente(), "regla_agencia_fija"),
          )
        : null;

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

    // Excepción del ADMIN con requisitos pendientes: registro propio, además
    // del cambio de estado, para que se pueda auditar quién se saltó qué.
    if (checklistOmitido.length > 0 || documentosOmitidos.length > 0) {
      await tx.auditLog.create({
        data: {
          entidad: "TramiteDO",
          entidadId: tramiteId,
          accion: "OMITIR_REQUISITOS",
          usuarioId,
          tramiteId,
          antes: normalizeSerializable({
            estado: actual.estado,
            checklistPendiente: checklistOmitido,
            documentosFaltantes: documentosOmitidos,
          }),
          despues: normalizeSerializable({ estado: estadoDes }),
        },
      });
    }

    return { ok: true, tramite: updated, advertencias };
  });
}

export { formatConsecutivo };
