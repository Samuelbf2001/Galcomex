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
import { etiquetaCiudad, tarifarioVigenteDe } from "@/lib/tarifas/service";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import { cargarCatalogoServicios, type CatalogoServicios } from "@/lib/tramites/catalogo-servicios";
import {
  resolverServicio,
  resolverServicioGuardado,
  ServicioFlujoCortoNoPermitidoError,
  serviciosDeTipo,
  type ServicioResuelto,
} from "@/lib/tramites/servicios";
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
  alcanceContador,
  etiquetaContador,
  filtroDeAlcance,
  formatConsecutivo,
  siguienteNumero,
  type AlcanceContador,
  type ConfigConsecutivo,
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
  /** Flujo corto (`tipoTramite.flujoCorto`: OTRO, EXPORTACION): valor del servicio sin IVA. */
  valorServicio?: bigint | null;
  /**
   * Servicio del DO (concepto de venta). En un tipo con catálogo (IMPORTACION:
   * vacío = Importación general, TRASLADO_ZF, NACIONALIZACION_ZF, DUTA;
   * EXPORTACION: se escoge solo) o en un «Otros» (cualquier concepto no
   * reservado). Obligatorio si viene `valorServicio`. Ver `resolverServicio`.
   */
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
  /**
   * B10 — gancho que corre DENTRO de la transacción de creación, después del
   * AuditLog. Si lanza, se deshace todo (no queda un DO huérfano). Lo usa
   * `liquidarComisiones` para ligar las comisiones al «Otros» recién creado.
   */
  alCrear?: (
    tx: Prisma.TransactionClient,
    tramite: { id: string; consecutivo: string },
  ) => Promise<void>;
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
 * Flujo corto (decisión de Ernesto, 26-sep-2026): `valorServicio` solo se
 * puede escribir en un DO cuyo tipo de trámite es `flujoCorto` (OTRO,
 * EXPORTACION) — un trámite estándar se factura por tarifario, no por un valor
 * a mano. Desde el 30-sep-2026 el servicio (`conceptoServicioCodigo`) también
 * vale en un tipo con catálogo de servicios (IMPORTACION). La clase vive en
 * `lib/tramites/servicios.ts` (puro); se re-exporta aquí por compatibilidad.
 */
export { ServicioFlujoCortoNoPermitidoError };

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
  constructor(
    mensaje = "Este servicio ya tiene factura en borrador; cambia el valor en el borrador de Facturación.",
  ) {
    super(mensaje);
    this.name = "ServicioConBorradorExistenteError";
  }
}

/** 30-sep-2026: el servicio de un trámite normal no cambia con borrador o desde «Enviado a facturar». */
const MENSAJE_SERVICIO_DO_BLOQUEADO =
  "El DO ya tiene factura en borrador o ya se mandó a facturar: su servicio ya no se puede cambiar desde el DO.";

/**
 * B10: un «Otros» creado por "Facturar comisiones" (LTRANS) toma su valor y su
 * concepto de las comisiones ligadas a él; cambiarlos rompería la cuenta.
 */
export class ServicioDeComisionesLiquidadasError extends Error {
  public readonly status = 409;
  constructor() {
    super(
      "El valor sale de las comisiones facturadas en este servicio: no se puede cambiar el valor ni el concepto.",
    );
    this.name = "ServicioDeComisionesLiquidadasError";
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
 * Argumentos del guard del servicio de un DO (`verificarServicioDelDo`).
 */
export type VerificarServicioArgs = {
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
  /**
   * D1 al CAMBIAR el servicio de un DO existente de un tipo con catálogo
   * (30-sep-2026): empresa y ciudad del DO. Sin ellos no se revisa la tarifa.
   */
  clienteId?: string;
  ciudad?: Ciudad | null;
  /** Catálogo ya leído (p. ej. `createTramite`), para no leerlo dos veces. */
  catalogo?: CatalogoServicios;
};

/** Lo que el guard resolvió cuando el payload trae el servicio; `null` si no lo toca. */
export type ServicioVerificado = {
  /** Lo que se debe guardar (p. ej. EXPORTACION aunque llegue vacío). */
  conceptoServicioCodigo: string | null;
  resuelto: ServicioResuelto;
} | null;

/**
 * Guard del servicio de un DO (antes `verificarServicioFlujoCorto`; el nombre
 * viejo sigue exportado). Partes independientes:
 *   - Si toca `referenciaExterna` (sale en "SERVICIO: …" de la factura,
 *     B-N2) Y el tipo es `flujoCorto`, exige que no esté bloqueado por
 *     factura (A2/B-N3) — sin penalizar a otros tipos que también usan
 *     `referenciaExterna` (p. ej. CLASIFICACION).
 *   - `valorServicio` (valor a mano): solo en un tipo `flujoCorto`
 *     (`ServicioFlujoCortoNoPermitidoError`).
 *   - `conceptoServicioCodigo` (el servicio): en un tipo con catálogo
 *     (IMPORTACION, EXPORTACION) solo uno de SU catálogo (422
 *     `SERVICIO_NO_PERMITIDO`); en un flujo corto sin catálogo (OTRO) cualquier
 *     concepto no reservado (422 `SERVICIO_RESERVADO`); en los demás tipos
 *     (CLASIFICACION) ninguno. Ver `resolverServicio`.
 *   - Flujo corto: bloqueado por factura (A2/B-N3) apenas se toca. Tipo con
 *     catálogo (30-sep-2026): el servicio se puede CAMBIAR mientras el DO no
 *     tenga borrador ni esté en «Enviado a facturar» o después (409), y, si la
 *     empresa exige tarifa (D1), no se puede pasar a un servicio sin tarifa
 *     vigente (422 con el mismo mensaje de D1).
 *   - B2: el estado COMBINADO (lo que ya tenía el DO + lo que llega) tiene que
 *     tener concepto si hay valor; el concepto (si viene) existe y está activo.
 *   - B10: el «Otros» de "Facturar comisiones" no cambia valor ni concepto.
 * Sin ninguno de los tres campos, no hace nada. La usan `createTramite` (sin
 * `tramiteId`/`antes`/`estadoActual`: DO nuevo, nunca hay borrador ni estado
 * previo) y el `PATCH /api/tramites/[id]`. Cambiar el servicio nunca cambia
 * el número ni la ciudad del DO.
 */
export async function verificarServicioDelDo(args: VerificarServicioArgs): Promise<ServicioVerificado> {
  const tocaValor = args.valorServicio !== undefined;
  const tocaConcepto = args.conceptoServicioCodigo !== undefined;
  const tocaServicio = tocaValor || tocaConcepto;
  const tocaReferencia = args.referenciaExterna !== undefined;
  if (!tocaServicio && !tocaReferencia) return null;

  const { tipos, catalogo } = args.catalogo ?? (await cargarCatalogoServicios());
  const tipo = tipos.find((t) => t.codigo === args.tipoTramiteCodigo) ?? null;
  const flujoCorto = tipo?.flujoCorto ?? false;
  const conCatalogo = tipo ? serviciosDeTipo(catalogo, tipo.codigo).length > 0 : false;
  const nombreTipo = tipo?.nombre ?? args.tipoTramiteCodigo;

  // El valor escrito a mano sigue siendo solo de flujo corto; el servicio,
  // de flujo corto o de un tipo con catálogo.
  if (tocaValor && !flujoCorto) {
    throw new ServicioFlujoCortoNoPermitidoError(nombreTipo);
  }
  if (tocaConcepto && !flujoCorto && !conCatalogo) {
    throw new ServicioFlujoCortoNoPermitidoError(nombreTipo);
  }

  const resuelto =
    tocaConcepto && tipo ? resolverServicio(tipo, catalogo, args.conceptoServicioCodigo, tipos) : null;
  const conceptoAntes = args.antes?.conceptoServicioCodigo ?? null;
  const cambiaConcepto =
    resuelto !== null && (args.antes === undefined || resuelto.conceptoGuardado !== conceptoAntes);

  // B10: el «Otros» de "Facturar comisiones" no cambia su valor ni su concepto
  // (un PATCH que reenvía los mismos valores no cambia nada y pasa).
  if (tocaServicio && args.tramiteId) {
    const cambia =
      !args.antes ||
      (tocaValor && args.valorServicio !== args.antes.valorServicio) ||
      (tocaConcepto && (resuelto?.conceptoGuardado ?? null) !== args.antes.conceptoServicioCodigo);
    if (
      cambia &&
      (await prisma.comisionTramite.count({ where: { liquidacionTramiteId: args.tramiteId } })) > 0
    ) {
      throw new ServicioDeComisionesLiquidadasError();
    }
  }

  if (args.tramiteId) {
    if (flujoCorto) {
      // Flujo corto: bloqueado por borrador/estado apenas se toca el servicio o
      // la referencia; otros tipos (CLASIFICACION también usa
      // `referenciaExterna`) no cambian nada.
      if (await servicioBloqueadoPorFactura(args.tramiteId, args.estadoActual)) {
        throw new ServicioConBorradorExistenteError();
      }
    } else if (conCatalogo && cambiaConcepto) {
      if (await servicioBloqueadoPorFactura(args.tramiteId, args.estadoActual)) {
        throw new ServicioConBorradorExistenteError(MENSAJE_SERVICIO_DO_BLOQUEADO);
      }
    }
  }

  if (!tocaServicio) return null;

  const conceptoResultante = tocaConcepto ? (resuelto?.conceptoGuardado ?? null) : conceptoAntes;
  const valorResultante = tocaValor ? (args.valorServicio ?? null) : (args.antes?.valorServicio ?? null);

  if (valorResultante !== null && !conceptoResultante) {
    throw new ConceptoServicioRequeridoError();
  }

  if (tocaConcepto && resuelto?.conceptoGuardado) {
    const concepto = await prisma.conceptoVenta.findUnique({
      where: { codigo: resuelto.conceptoGuardado },
      select: { activo: true },
    });
    if (!concepto || !concepto.activo) {
      throw new ConceptoServicioNoEncontradoError(resuelto.conceptoGuardado);
    }
  }

  // D1 al cambiar el servicio de un DO existente (30-sep-2026): con la función
  // encendida, no se deja un DO en un servicio sin tarifa vigente.
  if (
    tipo &&
    resuelto &&
    conCatalogo &&
    cambiaConcepto &&
    args.tramiteId &&
    args.clienteId
  ) {
    const [capacidades, empresa] = await Promise.all([
      capacidadesDeEmpresa(args.clienteId),
      prisma.cliente.findUnique({ where: { id: args.clienteId }, select: { nombre: true } }),
    ]);
    const faltaTarifa = await verificarTarifaVigente({
      clienteId: args.clienteId,
      nombreEmpresa: empresa?.nombre ?? "La empresa",
      tipo: { codigo: tipo.codigo, lineaServicio: tipo.lineaServicio },
      capacidades,
      consecutivo: null,
      ciudad: args.ciudad,
      servicio: resuelto,
    });
    if (faltaTarifa) throw faltaTarifa;
  }

  return tocaConcepto && resuelto
    ? { conceptoServicioCodigo: resuelto.conceptoGuardado, resuelto }
    : null;
}

/** Nombre anterior de `verificarServicioDelDo` (flujo corto, 26-sep-2026). */
export async function verificarServicioFlujoCorto(args: VerificarServicioArgs): Promise<void> {
  await verificarServicioDelDo(args);
}

export type DetallesTarifaVigenteRequerida = {
  clienteId: string;
  lineaServicio: string;
  tipoTramiteCodigo: string;
  /** 30-sep-2026: servicio de tarifa propia que no tiene tarifa (solo si no es la general). */
  servicio?: string;
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
 * Con qué clave se busca la tarifa de un servicio (30-sep-2026): la del
 * servicio resuelto (`null` = tarifa general, sin servicio). Sin servicio
 * resuelto, o en un «Otros» que todavía no escogió servicio, sin filtro por
 * servicio (`undefined`), como antes.
 */
function claveBusquedaTarifa(servicio: ServicioResuelto | null | undefined): string | null | undefined {
  if (!servicio || servicio.faltaServicio) return undefined;
  return servicio.claveTarifa;
}

/** Filtro por servicio de las consultas de «publicada» (mismo criterio que `tarifarioVigenteDe`). */
function filtroServicioTarifa(servicio: string | null | undefined): { conceptoServicioCodigo?: string | null } {
  return servicio === undefined ? {} : { conceptoServicioCodigo: servicio };
}

/**
 * Tarifa de la empresa para una línea de servicio en una fecha: la vigente (si
 * hay) o, si no, por qué la publicada no sirve (vencida o todavía no rige).
 * Mismo criterio que la facturación (`tarifarioVigenteDe`). 30-sep-2026: con
 * `servicio` busca solo la tarifa de ese servicio (`null` = la general).
 */
async function tarifaParaDo(
  empresaId: string,
  lineaServicio: string,
  fecha: Date,
  // B3 (R1, R5): ciudad del DO. Si tiene tarifario propio, el "fuera de
  // fecha" se calcula sobre ESE (nunca cae al general en silencio).
  ciudad?: Ciudad | null,
  servicio?: string | null,
): Promise<{ tarifario: TarifarioResumen | null; fueraDeFecha: TarifaFueraDeFecha | null }> {
  const vigente = await tarifarioVigenteDe(empresaId, lineaServicio, fecha, ciudad, servicio);

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

  const porServicio = filtroServicioTarifa(servicio);
  const publicadaCiudad = ciudad
    ? await prisma.tarifario.findFirst({
        where: {
          empresaId,
          alcance: lineaServicio,
          estado: EstadoTarifario.VIGENTE,
          ciudades: { has: ciudad },
          ...porServicio,
        },
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
        ...porServicio,
      },
      orderBy: { version: "desc" },
      select: { vigenteDesde: true, vigenteHasta: true },
    }));

  return { tarifario: null, fueraDeFecha: tarifaFueraDeFecha(publicada, fecha) };
}

/**
 * D1 — Sin tarifa vigente no hay DO. Devuelve el error (sin lanzarlo) para que
 * la creación lo lance y la transición lo convierta en su resultado 422.
 * 30-sep-2026: la tarifa es la del SERVICIO del DO (vacío = la general); un
 * servicio sin tarifa propia nunca toma la general en silencio.
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
  /** Servicio del DO (30-sep-2026). */
  servicio?: ServicioResuelto | null;
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
    claveBusquedaTarifa(args.servicio),
  );

  if (tarifa.tarifario) {
    return null;
  }

  // Solo un servicio con tarifa propia se nombra: la importación general
  // conserva el mensaje de siempre.
  const servicioPropio = args.servicio?.claveTarifa ? args.servicio : null;

  return new TarifaVigenteRequeridaError(
    mensajeTarifaRequerida({
      empresa: args.nombreEmpresa,
      lineaServicio: args.tipo.lineaServicio,
      tarifarioPropioActivo: tiene(args.capacidades, "tarifario_propio"),
      fueraDeFecha: tarifa.fueraDeFecha,
      consecutivo: args.consecutivo,
      servicioNombre: servicioPropio?.nombre ?? null,
    }),
    {
      clienteId: args.clienteId,
      lineaServicio: args.tipo.lineaServicio,
      tipoTramiteCodigo: args.tipo.codigo,
      ...(servicioPropio?.claveTarifa ? { servicio: servicioPropio.claveTarifa } : {}),
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
  /** 30-sep-2026: documentos que no aplican al servicio ACTUAL del DO (la nacionalización no tiene BL). */
  documentosNoAplican?: readonly string[];
}): Promise<DocumentosObligatoriosResultado> {
  const requeridos = documentosRequeridos(
    args.capacidades,
    args.tipoTramiteCodigo,
    args.documentosNoAplican ?? [],
  );

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
  /**
   * 30-sep-2026 — servicio que se va a escoger (concepto de venta). Vacío = el
   * servicio por defecto del tipo (Importación general, Exportación).
   */
  servicio?: string | null;
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

  const [tipo, catalogoServicios] = await Promise.all([
    prisma.tipoTramite.findFirst({ where: { codigo, activo: true } }),
    cargarCatalogoServicios(),
  ]);

  if (!tipo) {
    throw new TipoTramiteNoEncontradoError(codigo);
  }

  // Mismas reglas que `createTramite`: un servicio que el tipo no admite es 422.
  const servicio = resolverServicio(tipo, catalogoServicios.catalogo, input.servicio, catalogoServicios.tipos);

  const [tarifa, numeracion] = await Promise.all([
    tarifaParaDo(input.clienteId, tipo.lineaServicio, fecha, input.ciudad, claveBusquedaTarifa(servicio)),
    vistaPreviaNumero(tipo, input.ciudad),
  ]);

  return armarRequisitos({
    capacidades,
    empresa: empresa?.nombre ?? "La empresa",
    tipoTramite: tipo,
    tarifario: tarifa.tarifario,
    fueraDeFecha: tarifa.fueraDeFecha,
    servicio:
      servicio.servicio || servicio.conceptoGuardado
        ? {
            codigo: servicio.conceptoGuardado,
            nombre: servicio.nombre ?? servicio.conceptoGuardado ?? "",
            claveTarifa: servicio.claveTarifa,
            documentosNoAplican: servicio.documentosNoAplican,
          }
        : null,
    numeracion,
  });
}

// ─── Numeración (30-sep-2026) ────────────────────────────────────────────────

type TipoConContador = ConfigConsecutivo & { codigo: string; nombre: string };

/** Último número de un contador y su piso (sin candado: solo lectura, o dentro del candado al crear). */
async function ultimoYPiso(
  db: Prisma.TransactionClient | typeof prisma,
  tipoCodigo: string,
  alcance: AlcanceContador<Ciudad>,
): Promise<{ ultimo: number | null; piso: number | null }> {
  const ultimo = await db.tramiteDO.findFirst({
    where: filtroDeAlcance(tipoCodigo, alcance),
    orderBy: { numero: "desc" },
    select: { numero: true },
  });
  const piso = await db.consecutivoPiso.aggregate({
    where: { clave: alcance.clave },
    _max: { ultimoNumero: true },
  });
  return { ultimo: ultimo?.numero ?? null, piso: piso._max.ultimoNumero ?? null };
}

/** Año del consecutivo: el de Bogotá (la noche del 31-dic el DO sigue siendo del año que termina). */
function anioConsecutivo(): number {
  return fechaCalendarioBogota().getUTCFullYear();
}

/** Ciudad para un contador que no la usa (por año o global): cualquiera sirve para el formato. */
const CIUDAD_SIN_USO: Ciudad = Ciudad.BAQ;

/**
 * Número que tomaría un DO de este tipo y ciudad si se creara ahora, y de qué
 * contador. Es una vista previa, no una reserva: si otra persona crea un DO
 * del mismo contador en ese momento, el número final es el siguiente.
 */
async function vistaPreviaNumero(
  tipo: TipoConContador,
  ciudad: Ciudad | undefined,
): Promise<{ siguiente: string; contador: string } | null> {
  if (!ciudad && tipo.secuenciaPor === "CIUDAD_ANIO") return null;
  const ciudadDo = ciudad ?? CIUDAD_SIN_USO;
  const anio = anioConsecutivo();
  const alcance = alcanceContador(tipo, tipo.codigo, ciudadDo, anio);
  const { ultimo, piso } = await ultimoYPiso(prisma, tipo.codigo, alcance);
  return {
    siguiente: formatConsecutivo(tipo, ciudadDo, anio, siguienteNumero(ultimo, piso)),
    contador: etiquetaContador(alcance, (c) => etiquetaCiudad(c as Ciudad), tipo.nombre),
  };
}

export type EstadoContador = {
  clave: string;
  tipoTramiteCodigo: string;
  tipoNombre: string;
  /** Ciudades del contador (null = cualquier ciudad: contador por año o global). */
  ciudades: Ciudad[] | null;
  contador: string;
  anio: number | null;
  ultimo: number | null;
  piso: number | null;
  /** Consecutivo que tomaría el próximo DO (con la primera ciudad del contador). */
  siguiente: string;
};

/**
 * Estado de todos los contadores del año (`GET /api/tramites/consecutivos` y
 * `scripts/consecutivos/ver-contadores.ts`). Solo lectura. Un contador por
 * tipo activo y, en los que van por ciudad, uno por grupo de ciudades.
 */
export async function estadoContadores(anio: number = anioConsecutivo()): Promise<EstadoContador[]> {
  const tipos = await prisma.tipoTramite.findMany({ where: { activo: true }, orderBy: { orden: "asc" } });
  const salida: EstadoContador[] = [];
  const vistos = new Set<string>();
  const ciudades = Object.values(Ciudad);

  for (const tipo of tipos) {
    const candidatas = tipo.secuenciaPor === "CIUDAD_ANIO" ? ciudades : [CIUDAD_SIN_USO];
    for (const ciudad of candidatas) {
      const alcance = alcanceContador(tipo, tipo.codigo, ciudad, anio);
      if (vistos.has(alcance.clave)) continue;
      vistos.add(alcance.clave);
      const { ultimo, piso } = await ultimoYPiso(prisma, tipo.codigo, alcance);
      salida.push({
        clave: alcance.clave,
        tipoTramiteCodigo: tipo.codigo,
        tipoNombre: tipo.nombre,
        ciudades: alcance.ciudades,
        contador: etiquetaContador(alcance, (c) => etiquetaCiudad(c as Ciudad), tipo.nombre),
        anio: alcance.anio,
        ultimo,
        piso,
        siguiente: formatConsecutivo(tipo, alcance.ciudades?.[0] ?? ciudad, anio, siguienteNumero(ultimo, piso)),
      });
    }
  }
  return salida;
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

/**
 * Plantilla de checklist de apertura: la estándar por id (`checklist-estandar`,
 * la que siembran el seed y la migración); si no existe, la primera por nombre,
 * como antes.
 */
async function plantillaChecklistEstandar(tx: Prisma.TransactionClient) {
  const include = { items: { orderBy: { orden: "asc" as const } } };
  return (
    (await tx.plantillaChecklist.findUnique({ where: { id: "checklist-estandar" }, include })) ??
    (await tx.plantillaChecklist.findFirst({ orderBy: { nombre: "asc" }, include }))
  );
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
  const anio = input.anio ?? anioConsecutivo();
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

  // Servicio del DO (30-sep-2026): en un tipo con catálogo, uno de SU catálogo
  // (vacío = el servicio por defecto: Importación general, Exportación); en un
  // «Otros», cualquier concepto no reservado. El valor a mano sigue siendo
  // solo de flujo corto, y el concepto debe estar activo. Una sola lectura
  // del catálogo por creación.
  const catalogoServicios = await cargarCatalogoServicios();
  const servicio = resolverServicio(
    tipo,
    catalogoServicios.catalogo,
    input.conceptoServicioCodigo,
    catalogoServicios.tipos,
  );
  await verificarServicioDelDo({
    tipoTramiteCodigo: tipo.codigo,
    valorServicio: input.valorServicio,
    conceptoServicioCodigo:
      input.conceptoServicioCodigo === undefined && servicio.conceptoGuardado === null
        ? undefined
        : servicio.conceptoGuardado,
    catalogo: catalogoServicios,
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
      servicio,
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

  // Numeración como Camila (30-sep-2026): el contador depende solo de tipo +
  // ciudad + año, nunca del servicio. BAQ, BGT y BUN comparten UN contador
  // (mismo candado, mismo máximo); el siguiente es max(último, piso) + 1.
  const alcance = alcanceContador(tipo, tipo.codigo, input.ciudad, anio);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${alcance.claveLock}))`;

          const { ultimo, piso } = await ultimoYPiso(tx, tipo.codigo, alcance);
          const numero = siguienteNumero(ultimo, piso);
          const consecutivo = formatConsecutivo(tipo, input.ciudad, anio, numero);
          const plantilla = tipo.usaChecklist ? await plantillaChecklistEstandar(tx) : null;
          // Los ítems cuyo documento no aplica al servicio no se copian (la
          // nacionalización no pide el BL).
          const itemsChecklist = (plantilla?.items ?? []).filter(
            (item) =>
              !item.categoriaDocumento || !servicio.documentosNoAplican.includes(item.categoriaDocumento),
          );

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
              conceptoServicioCodigo: servicio.conceptoGuardado,
              creadoPorId: input.creadoPorId,
              checklistItems: plantilla
                ? {
                    create: itemsChecklist.map((item) => ({
                      descripcion: item.descripcion,
                      requerido: item.requerido,
                      categoriaDocumento: item.categoriaDocumento,
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

          if (opciones.alCrear) {
            await opciones.alCrear(tx, { id: tramite.id, consecutivo: tramite.consecutivo });
          }

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
      // 30-sep-2026: catálogo de servicios del tipo, para el editor del
      // servicio y la marca de la cabecera del DO.
      servicios: {
        where: { activo: true },
        orderBy: { orden: "asc" },
        select: { conceptoCodigo: true, nombre: true, tarifaGeneral: true, documentosNoAplican: true },
      },
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
            nombre: true,
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

    // Servicio ACTUAL del DO (30-sep-2026): D1 busca la tarifa de ese servicio
    // y D2/checklist no piden lo que no le aplica (la nacionalización no tiene
    // BL). Se lee una sola vez y solo si alguna regla lo necesita.
    let servicioLeido: ServicioResuelto | null = null;
    const servicioDelDo = async (): Promise<ServicioResuelto> => {
      if (!servicioLeido) {
        const { tipos, catalogo } = await cargarCatalogoServicios(tx);
        servicioLeido = resolverServicioGuardado(
          actual.tipoTramite,
          catalogo,
          actual.conceptoServicioCodigo,
          tipos,
        );
      }
      return servicioLeido;
    };

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
          servicio: await servicioDelDo(),
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
          documentosNoAplican: (await servicioDelDo()).documentosNoAplican,
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
        servicio: await servicioDelDo(),
      });

      if (faltaTarifa) {
        return falloDeRegla(faltaTarifa);
      }
    }

    const esAperturaAEnTramite =
      actual.estado === EstadoTramite.APERTURA && estadoDes === EstadoTramite.EN_TRAMITE;
    const pasaAOperacion = entraAOperacion(actual.estado, estadoDes);
    // Un ítem pendiente cuyo documento no aplica al servicio ACTUAL no frena
    // (cubre un cambio de servicio después de crear el DO).
    const noAplicanChecklist =
      esAperturaAEnTramite || pasaAOperacion ? (await servicioDelDo()).documentosNoAplican : [];
    const checklistPendiente = actual.checklistItems
      .filter((item) => item.requerido && !item.recibido)
      .filter((item) => !item.categoriaDocumento || !noAplicanChecklist.includes(item.categoriaDocumento))
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
        documentosNoAplican: (await servicioDelDo()).documentosNoAplican,
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
