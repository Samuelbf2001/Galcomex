import {
  AgenciaAduanas,
  Ciudad,
  EstadoBorrador,
  EstadoFacturaProveedor,
  EstadoTarifario,
  EstadoTramite,
  Prisma,
  Rol,
  TipoCarga,
  TipoCliente,
  type TramiteDO,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { configDe, tiene, type MapaCapacidades } from "@/lib/capacidades/resolver";
import { bloquearTramites } from "@/lib/cxp/bloqueos";
import { DoConFacturasPendientesError } from "@/lib/cxp/errores";
import { numeroFacturaVisible } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { tarifarioVigenteDe } from "@/lib/tarifas/service";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import {
  FacturaNoEmitidaError,
  exigeFacturaEmitida,
  motivoValido,
} from "@/lib/tramites/factura-emitida";
import {
  aplicarReglaAgenciaAlCrear,
  validateReglaAgenciaFija,
  type ConfigReglaAgencia,
} from "@/lib/tramites/reglas";
import {
  abreSolicitud,
  armarRequisitos,
  cumpleContenedores,
  documentosFaltantes,
  documentosRequeridos,
  entraAOperacion,
  esEstadoOperativo,
  exigeContenedores,
  exigeTarifaVigente,
  mensajeContenedoresRequeridos,
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
import { estadosSiguientes } from "@/lib/tramites/transiciones";
import { resolverFacturableFlujoCorto } from "@/lib/tramites/flujo-corto";

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
  /** D3: contenedores del BL (capacidad `contenedores_obligatorio`). */
  numContenedores?: number | null;
  /** `SUELTA` = carga suelta, sin contenedores (cumple D3). */
  tipoCarga?: TipoCarga | null;
  /** Flujo corto (`tipoTramite.flujoCorto`, solo OTRO): valor del servicio sin IVA. */
  valorServicio?: bigint | null;
  /** Concepto de venta del servicio. Obligatorio si viene `valorServicio` (validado por Zod). */
  conceptoServicioCodigo?: string | null;
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

/**
 * F1 (fase 1 del plan "una sola Empresa"): un DO solo se abre a nombre de una
 * empresa marcada como cliente (`esCliente = true`). Defensa en el servidor
 * aunque la UI ya pida `rol=cliente` en el selector — una empresa
 * solo-proveedor (ALMACARGA, EXPRESS LOGISTICA) no puede recibir trámites.
 */
export class EmpresaNoEsClienteError extends Error {
  public readonly status = 422;
  constructor(nombreEmpresa: string) {
    super(
      `${nombreEmpresa} está marcada solo como proveedor. Márcala como cliente en su ficha para abrirle trámites.`,
    );
    this.name = "EmpresaNoEsClienteError";
  }
}

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

/**
 * D3 (capacidad `contenedores_obligatorio`, caso Polyrec / Polyrec ZF): el DO
 * no trae número de contenedores ni está marcado como carga suelta.
 */
export class ContenedoresRequeridosError extends Error {
  public readonly status = 422;
  public readonly codigo = "CONTENEDORES_REQUERIDOS" as const;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ContenedoresRequeridosError";
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

/**
 * Flujo corto (decisión de Ernesto, 26-sep-2026): `valorServicio` y
 * `conceptoServicioCodigo` solo se pueden escribir en un DO cuyo tipo de
 * trámite es `flujoCorto` (hoy, OTRO) — un trámite estándar se factura por
 * tarifario, no por un valor a mano.
 */
export class ServicioFlujoCortoNoPermitidoError extends Error {
  public readonly status = 422;
  constructor(nombreTipo: string) {
    super(
      `Los trámites de tipo "${nombreTipo}" no llevan servicio ni valor escritos a mano: eso es solo para servicios sueltos (Otros servicios).`,
    );
    this.name = "ServicioFlujoCortoNoPermitidoError";
  }
}

export class ConceptoServicioNoEncontradoError extends Error {
  public readonly status = 422;
  constructor(codigo: string) {
    super(`El concepto de venta "${codigo}" no existe o está inactivo`);
    this.name = "ConceptoServicioNoEncontradoError";
  }
}

/** B2: el DO va a quedar con valor pero sin concepto (en el estado combinado, no solo en el payload). */
export class ConceptoServicioRequeridoError extends Error {
  public readonly status = 422;
  constructor() {
    super("Escoge el concepto de venta del servicio.");
    this.name = "ConceptoServicioRequeridoError";
  }
}

/**
 * A2/B-N2/B-N3 (decisión de Ernesto 26-sep-2026): con un borrador ya
 * generado (cualquier estado), o desde ENVIADO_A_FACTURAR aunque no haya
 * borrador todavía, el servicio se edita en Facturación, no en el DO.
 */
export class ServicioConBorradorExistenteError extends Error {
  public readonly status = 409;
  constructor() {
    super("Este servicio ya tiene factura en borrador; cambia el valor en el borrador de Facturación.");
    this.name = "ServicioConBorradorExistenteError";
  }
}

/** Estados desde los que un flujo corto ya no se edita en el DO (A2/B-N3): igual que la ficha. */
const ESTADOS_SERVICIO_BLOQUEADO: readonly EstadoTramite[] = [
  EstadoTramite.ENVIADO_A_FACTURAR,
  EstadoTramite.FACTURADO,
  EstadoTramite.PAGADO,
  EstadoTramite.CERRADO,
];

/** true si ya hay un borrador del DO, o si su estado ya pasó a "enviado a facturar" o más allá. */
async function servicioBloqueadoPorFactura(
  tramiteId: string,
  estadoActual: EstadoTramite | undefined,
): Promise<boolean> {
  if (estadoActual && ESTADOS_SERVICIO_BLOQUEADO.includes(estadoActual)) {
    return true;
  }
  const borrador = await prisma.borradorFactura.findFirst({
    where: { tramiteId },
    select: { id: true },
  });
  return borrador !== null;
}

/**
 * Guard del flujo corto. Dos partes independientes:
 *   - Si toca `referenciaExterna` (sale en "SERVICIO: …" de la factura,
 *     B-N2) Y el tipo es `flujoCorto`, exige que no esté bloqueado por
 *     factura (A2/B-N3) — sin penalizar a otros tipos que también usan
 *     `referenciaExterna` (p. ej. CLASIFICACION).
 *   - Si toca `valorServicio`/`conceptoServicioCodigo`: exige que el tipo sea
 *     `flujoCorto` (`ServicioFlujoCortoNoPermitidoError`), que no esté
 *     bloqueado por factura (A2/B-N3), que el estado COMBINADO (lo que ya
 *     tenía el DO + lo que llega) tenga concepto si hay valor (B2 — un PATCH
 *     que solo trae `valorServicio` con el concepto YA guardado en `antes`
 *     no lo vuelve a exigir), y que el concepto (si viene) exista y esté
 *     activo.
 * Sin ninguno de los tres campos, no hace nada. La usan `createTramite` (sin
 * `tramiteId`/`antes`/`estadoActual`: DO nuevo, nunca hay borrador ni estado
 * previo) y el `PATCH /api/tramites/[id]`.
 */
export async function verificarServicioFlujoCorto(args: {
  tipoTramiteCodigo: string;
  /** DO existente (PATCH): permite el chequeo de borrador/estado (A2/B-N2/B-N3). */
  tramiteId?: string;
  /** Estado ACTUAL del DO antes del PATCH (A2/B-N3). */
  estadoActual?: EstadoTramite;
  /** Estado ANTES del PATCH, para completar lo que el payload no toca (B2). */
  antes?: { valorServicio: bigint | null; conceptoServicioCodigo: string | null };
  valorServicio?: bigint | null;
  conceptoServicioCodigo?: string | null;
  /** B-N2: la referencia externa también queda bloqueada por factura en un flujo corto. */
  referenciaExterna?: string | null;
}): Promise<void> {
  const tocaServicio =
    args.valorServicio !== undefined || args.conceptoServicioCodigo !== undefined;
  const tocaReferencia = args.referenciaExterna !== undefined;
  if (!tocaServicio && !tocaReferencia) return;

  const tipo = await prisma.tipoTramite.findUnique({
    where: { codigo: args.tipoTramiteCodigo },
    select: { flujoCorto: true, nombre: true },
  });

  if (tocaServicio && !tipo?.flujoCorto) {
    throw new ServicioFlujoCortoNoPermitidoError(tipo?.nombre ?? args.tipoTramiteCodigo);
  }

  // El bloqueo por borrador/estado solo aplica a un DO flujoCorto; otros
  // tipos (CLASIFICACION también usa `referenciaExterna`) no cambian nada.
  if (tipo?.flujoCorto && args.tramiteId) {
    if (await servicioBloqueadoPorFactura(args.tramiteId, args.estadoActual)) {
      throw new ServicioConBorradorExistenteError();
    }
  }

  if (!tocaServicio) return;

  const conceptoResultante =
    args.conceptoServicioCodigo !== undefined
      ? args.conceptoServicioCodigo
      : args.antes?.conceptoServicioCodigo ?? null;
  const valorResultante =
    args.valorServicio !== undefined ? args.valorServicio : args.antes?.valorServicio ?? null;

  if (valorResultante !== null && !conceptoResultante) {
    throw new ConceptoServicioRequeridoError();
  }

  if (args.conceptoServicioCodigo) {
    const concepto = await prisma.conceptoVenta.findUnique({
      where: { codigo: args.conceptoServicioCodigo },
      select: { activo: true },
    });
    if (!concepto || !concepto.activo) {
      throw new ConceptoServicioNoEncontradoError(args.conceptoServicioCodigo);
    }
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

/**
 * Convierte cualquier error de dominio con `.status` (y opcionalmente
 * `.codigo`/`.detalles`) en el resultado `{ ok: false }` de una transición.
 * Firma amplia a propósito: la usan tanto los errores propios de esta
 * cascada (D1/D2/factura emitida) como los del flujo corto
 * (`lib/tramites/flujo-corto.ts`), que no llevan `.detalles`.
 */
function falloDeRegla(
  error: Error & { status: number; codigo?: string; detalles?: Record<string, unknown> },
): TransitionResult {
  return {
    ok: false,
    status: error.status,
    message: error.message,
    codigo: error.codigo,
    detalles: error.detalles ? { ...error.detalles } : undefined,
  };
}

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
  // B3 (R1, R5): ciudad del DO. Si tiene tarifario propio, el "fuera de
  // fecha" se calcula sobre ESE (nunca cae al general en silencio).
  ciudad?: Ciudad | null,
): Promise<{ tarifario: TarifarioResumen | null; fueraDeFecha: TarifaFueraDeFecha | null }> {
  const vigente = await tarifarioVigenteDe(empresaId, lineaServicio, fecha, ciudad);

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

  const publicadaCiudad = ciudad
    ? await prisma.tarifario.findFirst({
        where: { empresaId, alcance: lineaServicio, estado: EstadoTarifario.VIGENTE, ciudades: { has: ciudad } },
        orderBy: { version: "desc" },
        select: { vigenteDesde: true, vigenteHasta: true },
      })
    : null;

  // Ciudad sin tarifario propio (o sin ciudad): el publicado general de hoy.
  const publicada =
    publicadaCiudad ??
    (await prisma.tarifario.findFirst({
      where: {
        empresaId,
        alcance: lineaServicio,
        estado: EstadoTarifario.VIGENTE,
        ...(ciudad ? { ciudades: { isEmpty: true } } : {}),
      },
      orderBy: { version: "desc" },
      select: { vigenteDesde: true, vigenteHasta: true },
    }));

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
  /** B3 (R5) — ciudad del DO, fija desde que se crea. */
  ciudad?: Ciudad | null;
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
    args.ciudad,
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
  /** B3 — ciudad del DO que se va a crear (opcional: sin ella, cualquier VIGENTE en fecha). */
  ciudad?: Ciudad;
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
    select: { codigo: true, lineaServicio: true, camposBaseCalculo: true },
  });

  if (!tipo) {
    throw new TipoTramiteNoEncontradoError(codigo);
  }

  const tarifa = await tarifaParaDo(input.clienteId, tipo.lineaServicio, fecha, input.ciudad);

  return armarRequisitos({
    capacidades,
    empresa: empresa?.nombre ?? "La empresa",
    tipoTramite: tipo,
    tarifario: tarifa.tarifario,
    fueraDeFecha: tarifa.fueraDeFecha,
  });
}

/**
 * D3 al editar la base de cálculo (`PATCH /api/tramites/[id]`): con la
 * capacidad `contenedores_obligatorio` no se deja dejar SIN contenedores un DO
 * que ya los tenía (o estaba marcado como carga suelta). Un DO viejo que nunca
 * tuvo el dato se puede seguir editando: la ficha le muestra el aviso.
 */
export async function verificarContenedoresAlEditar(
  antes: Pick<
    TramiteDO,
    "clienteId" | "tipoTramiteCodigo" | "consecutivo" | "numContenedores" | "tipoCarga"
  >,
  cambios: { numContenedores?: number | null; tipoCarga?: TipoCarga | null },
): Promise<void> {
  if (cambios.numContenedores === undefined && cambios.tipoCarga === undefined) return;
  if (!cumpleContenedores(antes)) return;

  const despues = {
    numContenedores:
      cambios.numContenedores !== undefined ? cambios.numContenedores : antes.numContenedores,
    tipoCarga: cambios.tipoCarga !== undefined ? cambios.tipoCarga : antes.tipoCarga,
  };
  if (cumpleContenedores(despues)) return;

  const [capacidades, empresa, tipo] = await Promise.all([
    capacidadesDeEmpresa(antes.clienteId),
    prisma.cliente.findUnique({ where: { id: antes.clienteId }, select: { nombre: true } }),
    prisma.tipoTramite.findUnique({
      where: { codigo: antes.tipoTramiteCodigo },
      select: { camposBaseCalculo: true },
    }),
  ]);

  if (exigeContenedores(capacidades, tipo?.camposBaseCalculo)) {
    throw new ContenedoresRequeridosError(
      mensajeContenedoresRequeridos(empresa?.nombre ?? "La empresa", antes.consecutivo),
    );
  }
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
  // El año del consecutivo es el de Bogotá: la noche del 31-dic (desde las
  // 19:00, ya 1-ene en UTC) el DO sigue siendo del año que termina.
  const anio = input.anio ?? fechaCalendarioBogota().getUTCFullYear();
  const attempts = 5;
  const origen: OrigenTramite = opciones.origen ?? "INTERNO";

  // Una sola lectura de capacidades por creación: la usan el tipo de trámite,
  // la tarifa vigente (D1) y la agencia fija. `capacidadesDeEmpresa` lanza
  // EmpresaNoEncontradaError (404) si la empresa no existe.
  const [capacidades, empresa] = await Promise.all([
    capacidadesDeEmpresa(input.clienteId),
    prisma.cliente.findUnique({
      where: { id: input.clienteId },
      select: { nombre: true, esCliente: true },
    }),
  ]);
  const nombreEmpresa = empresa?.nombre ?? "La empresa";

  // F1 — guarda de servidor: sin esto, una empresa solo-proveedor podría
  // recibir un DO si alguien llama a la API directo (la UI ya filtra el
  // selector con `rol=cliente`).
  if (empresa && !empresa.esCliente) {
    throw new EmpresaNoEsClienteError(nombreEmpresa);
  }

  const tipo = await resolverTipoTramite(
    input.tipoTramiteCodigo ?? TIPO_TRAMITE_POR_DEFECTO,
    capacidades,
    nombreEmpresa,
  );

  // Flujo corto (OTRO): `valorServicio`/`conceptoServicioCodigo` solo en un
  // tipo `flujoCorto`, y con el concepto de venta activo.
  await verificarServicioFlujoCorto({
    tipoTramiteCodigo: tipo.codigo,
    valorServicio: input.valorServicio,
    conceptoServicioCodigo: input.conceptoServicioCodigo,
  });

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
      ciudad: input.ciudad,
    });

    if (faltaTarifa) {
      throw faltaTarifa;
    }
  }

  // D3 — número de contenedores desde la creación (capacidad
  // `contenedores_obligatorio`). La solicitud externa no lo trae: se completa
  // en la ficha del DO.
  const pideContenedores = exigeContenedores(capacidades, tipo.camposBaseCalculo);
  if (
    origen !== "SOLICITUD_PUBLICA" &&
    pideContenedores &&
    !cumpleContenedores({ numContenedores: input.numContenedores, tipoCarga: input.tipoCarga })
  ) {
    throw new ContenedoresRequeridosError(mensajeContenedoresRequeridos(nombreEmpresa));
  }
  // Carga suelta sin número: se guarda 0 contenedores, no "desconocido".
  const numContenedores =
    input.numContenedores ?? (input.tipoCarga === "SUELTA" ? 0 : null);

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
              numContenedores,
              tipoCarga: input.tipoCarga ?? null,
              comentarios: input.comentarios,
              valorServicio: input.valorServicio ?? null,
              conceptoServicioCodigo: input.conceptoServicioCodigo ?? null,
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
  // `usaCamposDo`: la lista lo usa para decidir si la columna "Referencia"
  // muestra `referenciaExterna` en vez del coalesce de siempre (ver
  // `normalizeRow` en tramites-api.ts). `flujoCorto`: este mismo include lo
  // devuelve el PATCH del DO — sin él, el editor de servicio (flujo corto)
  // desaparecería de la pantalla justo después de guardar.
  tipoTramite: {
    select: {
      usaCamposDo: true,
      flujoCorto: true,
    },
  },
  // Servicio + valor del flujo corto (solo si `tipoTramite.flujoCorto`).
  conceptoServicio: {
    select: { codigo: true, nombre: true },
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
        // Buscar "CUADRE · ROJO" filtra los históricos por el color de su marca
        // (bloque [HIST-PLATA-…] en comentarios). Solo amplía la búsqueda.
        { comentarios: { contains: query.q, mode: "insensitive" } },
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
      // Flujo corto (OTRO, 26-sep-2026): sin operación de importación, se
      // factura por servicio + valor escrito a mano.
      flujoCorto: true,
    },
  },
  // Servicio + valor del flujo corto (solo si `tipoTramite.flujoCorto`).
  conceptoServicio: {
    select: { codigo: true, nombre: true },
  },
  creadoPor: {
    select: {
      name: true,
    },
  },
  checklistItems: {
    orderBy: { descripcion: "asc" },
    // Cuántos archivos cubren cada requisito (fotos de la revisión, registro…).
    include: { _count: { select: { documentos: { where: { eliminado: false } } } } },
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

/**
 * Facturas de proveedor del DO que aún deben plata (CxP v2, R10): saldo > 0
 * (valor − Σ pagos aplicados − ajustes − cruce) o estado Pendiente/Abonada.
 * Se toma la unión de ambas lecturas para que un estado desalineado nunca
 * deje cerrar un DO con deuda. Número en formato visible ("FE 12481").
 */
async function facturasProveedorConSaldo(
  tx: Prisma.TransactionClient,
  tramiteId: string,
): Promise<{ numFactura: string; saldo: bigint }[]> {
  const facturas = await tx.facturaProveedor.findMany({
    where: { tramiteId },
    select: {
      numFactura: true,
      valor: true,
      estado: true,
      montoCompensado: true,
      beneficiario: { select: { numFacturaConEspacio: true } },
      pagos: { select: { monto: true } },
      ajustes: { select: { monto: true } },
    },
    orderBy: [{ fecha: "asc" }, { createdAt: "asc" }],
  });
  return facturas.flatMap((f) => {
    const saldado =
      f.pagos.reduce((s, p) => s + p.monto, 0n) + f.ajustes.reduce((s, a) => s + a.monto, 0n) + f.montoCompensado;
    const bruto = f.valor - saldado;
    const saldo = bruto < 0n ? 0n : bruto;
    const pendientePorEstado =
      f.estado === EstadoFacturaProveedor.REGISTRADA || f.estado === EstadoFacturaProveedor.PARCIAL;
    if (saldo === 0n && !pendientePorEstado) return [];
    return [
      {
        numFactura: numeroFacturaVisible(f.numFactura, f.beneficiario?.numFacturaConEspacio ?? false),
        saldo,
      },
    ];
  });
}

/**
 * Opciones de la transacción de `transitionTramite`. Cerrar el DO espera su
 * candado (`bloquearTramites`), que un pago en bloque o la anulación de un
 * bloque retienen hasta 30 s (su propio timeout); con los 5 s por defecto de
 * Prisma el cierre vencía en esa espera (P2028) y la ruta respondía 500. El
 * timeout queda por encima de ese presupuesto de 30 s.
 */
const TX_TRANSICION = { maxWait: 10_000, timeout: 35_000 } as const;

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
  opciones: {
    /**
     * Solo ADMIN: motivo escrito para entrar a Facturado sin factura emitida
     * (decisión 25-sep-2026). `bypassChecklist` NO alcanza para eso.
     */
    motivoExcepcion?: string | null;
  } = {},
): Promise<TransitionResult> {
  return prisma.$transaction(async (tx) => {
    // CxP v2 (R10, §B.5): cerrar el DO bloquea su fila ANTES de leerla, en el
    // mismo orden (DO → facturas) que pagos, anulación de bloques y borrado de
    // pagos; así el conteo de facturas pendientes no se cruza con una
    // operación que reabra una factura.
    if (estadoDes === EstadoTramite.CERRADO) {
      await bloquearTramites(tx, [tramiteId]);
    }

    const actual = await tx.tramiteDO.findUnique({
      where: { id: tramiteId },
      include: {
        cliente: { select: { nombre: true } },
        checklistItems: true,
        tipoTramite: {
          select: {
            codigo: true,
            lineaServicio: true,
            requiereAgenciaAduanas: true,
            flujoCorto: true,
          },
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

    // Flujo corto (servicio suelto: OTRO, decisión de Ernesto 26-sep-2026):
    // llegar a ENVIADO_A_FACTURAR por cualquier camino (atajo, DESPACHADO o
    // incluso la reapertura de un CERRADO) exige lo mismo que
    // `solicitarFacturacion`/`generarBorrador` — formato CONCEPTOS_IVA y
    // (valor + concepto a mano, o una tarifa vigente con líneas) — y fija
    // `fechaEnviadoAFacturar` igual que esa función. Nunca se manda a
    // facturar "en blanco". No aplica a otros destinos ni a tipos que no
    // sean flujoCorto.
    let fechaEnviadoAFacturarFlujoCorto: Date | null = null;
    if (estadoDes === EstadoTramite.ENVIADO_A_FACTURAR && actual.tipoTramite.flujoCorto) {
      const resuelto = await resolverFacturableFlujoCorto(
        {
          clienteId: actual.clienteId,
          valorServicio: actual.valorServicio,
          conceptoServicioCodigo: actual.conceptoServicioCodigo,
          tipoTramite: { flujoCorto: true, lineaServicio: actual.tipoTramite.lineaServicio },
        },
        tramiteId,
      );
      if (resuelto && !resuelto.ok) {
        return falloDeRegla(resuelto.error);
      }
      fechaEnviadoAFacturarFlujoCorto = fechaCalendarioBogota();
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
          ciudad: actual.ciudad,
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
        data: {
          estado: estadoDes,
          ...(fechaEnviadoAFacturarFlujoCorto
            ? { fechaEnviadoAFacturar: fechaEnviadoAFacturarFlujoCorto }
            : {}),
        },
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

    // Flujo corto (OTRO, decisión de Ernesto 26-sep-2026): desde SOLICITUD,
    // APERTURA o EN_TRAMITE también se puede saltar directo a
    // ENVIADO_A_FACTURAR — sin operación de importación, no hay EN_PUERTO ni
    // DESPACHADO que pasar. El resto del mapa es igual para todos los tipos.
    const destinosValidos = estadosSiguientes(actual.estado, {
      flujoCorto: actual.tipoTramite.flujoCorto,
    });
    if (!bypassChecklist && !destinosValidos.includes(estadoDes)) {
      return {
        ok: false,
        status: 422,
        message: `Transicion invalida: ${actual.estado} -> ${estadoDes}`,
      };
    }

    // CxP v2 (R10): no se cierra un DO con facturas de proveedor Pendientes o
    // Abonadas (tampoco con la excepción de ADMIN): después ya no admitiría el
    // pago y la deuda quedaría colgada.
    if (estadoDes === EstadoTramite.CERRADO && actual.estado !== EstadoTramite.CERRADO) {
      const pendientes = await facturasProveedorConSaldo(tx, tramiteId);
      if (pendientes.length > 0) {
        const error = new DoConFacturasPendientesError(actual.consecutivo, pendientes);
        return {
          ok: false,
          status: error.status,
          message: error.message,
          codigo: error.codigo,
          // BigInt → string: la ruta responde con NextResponse.json.
          detalles: {
            consecutivo: actual.consecutivo,
            facturas: pendientes.map((f) => ({ numFactura: f.numFactura, saldo: f.saldo.toString() })),
          },
        };
      }
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
        ciudad: actual.ciudad,
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

    // «Facturado» solo con factura emitida (decisión de Ernesto, 25-sep-2026):
    // entrar a FACTURADO (o saltar a PAGADO sin pasar por él) exige un borrador
    // FACTURADO. La excepción de checklist del ADMIN no alcanza: forzarlo pide
    // motivo escrito y deja su propio AuditLog. «Pagado» desde Facturado sigue
    // libre y cerrar (descartar) no la pide.
    let facturadoForzado: { motivo: string; borradores: EstadoBorrador[] } | null = null;
    if (exigeFacturaEmitida(actual.estado, estadoDes)) {
      const borradores = await tx.borradorFactura.findMany({
        where: { tramiteId },
        select: { estado: true },
      });
      if (!borradores.some((b) => b.estado === EstadoBorrador.FACTURADO)) {
        const esAdmin = usuarioRol === Rol.ADMIN;
        const motivo = esAdmin ? motivoValido(opciones.motivoExcepcion) : null;
        const estados = borradores.map((b) => b.estado);
        if (!motivo) {
          return falloDeRegla(
            new FacturaNoEmitidaError({
              tramiteId,
              consecutivo: actual.consecutivo,
              estadoDestino: estadoDes,
              borradores: estados,
              puedeForzar: esAdmin,
            }),
          );
        }
        facturadoForzado = { motivo, borradores: estados };
        advertencias.push(
          `${actual.consecutivo} pasó a ${estadoDes.replace(/_/g, " ")} sin factura emitida, por excepción de ADMIN. Motivo: ${motivo}`,
        );
      }
    }

    const updated = await tx.tramiteDO.update({
      where: { id: tramiteId },
      data: {
        estado: estadoDes,
        ...(fechaEnviadoAFacturarFlujoCorto
          ? { fechaEnviadoAFacturar: fechaEnviadoAFacturarFlujoCorto }
          : {}),
      },
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

    if (facturadoForzado) {
      await tx.auditLog.create({
        data: {
          entidad: "TramiteDO",
          entidadId: tramiteId,
          accion: "FORZAR_FACTURADO",
          usuarioId,
          tramiteId,
          antes: normalizeSerializable({
            estado: actual.estado,
            borradores: facturadoForzado.borradores,
          }),
          despues: normalizeSerializable({ estado: estadoDes, motivo: facturadoForzado.motivo }),
        },
      });
    }

    return { ok: true, tramite: updated, advertencias };
  }, TX_TRANSICION);
}

export { formatConsecutivo };
