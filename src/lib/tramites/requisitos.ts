/**
 * Requisitos para abrir y avanzar un DO — lógica PURA (sin BD).
 *
 * Dos reglas de la revisión de Ernesto (22-sep-2026), ambas capacidades por
 * empresa (invariante 7 del CLAUDE.md: cero ramas por tipo de cliente):
 *
 *   D1 · `do_exige_tarifa_vigente` — sin tarifa VIGENTE de la línea de
 *        servicio del tipo de trámite no se crea el DO, y una solicitud que
 *        llegó de afuera no se abre (SOLICITUD → APERTURA).
 *   D2 · `docs_bl_factura_obligatorios` — el DO no pasa de APERTURA a
 *        EN_TRAMITE sin el BL y la factura comercial adjuntos.
 *
 * Las dos llevan config `{ tiposTramite: string[] }` con los códigos de
 * `TipoTramite` a los que aplica la regla. Los guards de
 * `lib/tramites/service.ts` y `GET /api/tramites/requisitos` usan estas mismas
 * funciones: la pantalla y el servidor dicen exactamente lo mismo.
 */

import type { CategoriaDocumento, EstadoTramite } from "@prisma/client";

import { definicionDe, type CodigoCapacidad } from "@/lib/capacidades/catalogo";
import { configDe, tiene, type MapaCapacidades } from "@/lib/capacidades/resolver";
import { vigenteEn } from "@/lib/tarifas/motor";

export const CAPACIDAD_TARIFA_VIGENTE = "do_exige_tarifa_vigente" as const satisfies CodigoCapacidad;
export const CAPACIDAD_DOCUMENTOS_OBLIGATORIOS =
  "docs_bl_factura_obligatorios" as const satisfies CodigoCapacidad;

type CodigoRegla = typeof CAPACIDAD_TARIFA_VIGENTE | typeof CAPACIDAD_DOCUMENTOS_OBLIGATORIOS;

/** Documentos que exige D2, en el orden en que se nombran en los mensajes. */
export const DOCUMENTOS_OBLIGATORIOS = [
  "BL",
  "FACTURA_COMERCIAL",
] as const satisfies readonly CategoriaDocumento[];

export type DocumentoObligatorio = (typeof DOCUMENTOS_OBLIGATORIOS)[number];

/** Etiqueta corta para listas y casillas de la UI. */
export const ETIQUETA_DOCUMENTO_OBLIGATORIO: Record<DocumentoObligatorio, string> = {
  BL: "BL o guía",
  FACTURA_COMERCIAL: "Factura comercial",
};

/** Cómo se nombra el documento dentro de una frase ("Falta el BL…"). */
const NOMBRE_EN_FRASE: Record<DocumentoObligatorio, string> = {
  BL: "el BL",
  FACTURA_COMERCIAL: "la factura comercial",
};

// ─── Config de las reglas ─────────────────────────────────────────────────────

/** `config.tiposTramite` si es una lista de textos; `null` si falta o está rota. */
export function leerTiposTramite(
  config: Record<string, unknown> | null | undefined,
): string[] | null {
  const valor = config?.tiposTramite;

  if (!Array.isArray(valor) || !valor.every((v): v is string => typeof v === "string")) {
    return null;
  }

  return valor;
}

/**
 * Tipos de trámite a los que aplica una regla. Una config ausente o rota cae a
 * la de fábrica del catálogo: la regla sigue protegiendo en vez de apagarse en
 * silencio. Una lista vacía es válida y significa "no aplica a ningún tipo".
 */
export function tiposTramiteDeRegla(
  codigo: CodigoRegla,
  config: Record<string, unknown> | null | undefined,
): string[] {
  return (
    leerTiposTramite(config) ?? leerTiposTramite(definicionDe(codigo).configPorDefecto) ?? []
  );
}

function reglaAplica(
  capacidades: MapaCapacidades,
  codigo: CodigoRegla,
  tipoTramiteCodigo: string,
): boolean {
  if (!tiene(capacidades, codigo)) return false;
  return tiposTramiteDeRegla(codigo, configDe(capacidades, codigo)).includes(tipoTramiteCodigo);
}

/** D1: ¿este tipo de trámite necesita tarifa vigente en esta empresa? */
export function exigeTarifaVigente(capacidades: MapaCapacidades, tipoTramiteCodigo: string): boolean {
  return reglaAplica(capacidades, CAPACIDAD_TARIFA_VIGENTE, tipoTramiteCodigo);
}

/** D2: documentos que este tipo de trámite debe tener antes de pasar a EN_TRAMITE. */
export function documentosRequeridos(
  capacidades: MapaCapacidades,
  tipoTramiteCodigo: string,
): DocumentoObligatorio[] {
  return reglaAplica(capacidades, CAPACIDAD_DOCUMENTOS_OBLIGATORIOS, tipoTramiteCodigo)
    ? [...DOCUMENTOS_OBLIGATORIOS]
    : [];
}

/** Los requeridos que no están entre las categorías de documentos vivos del DO. */
export function documentosFaltantes(
  requeridos: readonly DocumentoObligatorio[],
  categoriasPresentes: Iterable<string>,
): DocumentoObligatorio[] {
  const presentes = new Set(categoriasPresentes);
  return requeridos.filter((categoria) => !presentes.has(categoria));
}

// ─── Momentos del flujo de estados ────────────────────────────────────────────

/**
 * Sacar un DO de SOLICITUD hacia la operación: es "abrirlo". Cerrarlo no
 * cuenta (descartar una solicitud no es abrirla).
 */
export function abreSolicitud(desde: EstadoTramite, hacia: EstadoTramite): boolean {
  return desde === "SOLICITUD" && hacia !== "SOLICITUD" && hacia !== "CERRADO";
}

const ESTADOS_EN_OPERACION: readonly EstadoTramite[] = [
  "EN_TRAMITE",
  "EN_PUERTO",
  "DESPACHADO",
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
];

/** El estado ya es "operación": EN_TRAMITE o más allá (sin contar CERRADO). */
export function esEstadoOperativo(estado: EstadoTramite): boolean {
  return ESTADOS_EN_OPERACION.includes(estado);
}

/**
 * Pasar de SOLICITUD/APERTURA a EN_TRAMITE o más allá. Sin excepción de ADMIN
 * solo existe APERTURA → EN_TRAMITE; con ella el ADMIN puede saltar estados y
 * el salto también cuenta, para que no sirva de atajo.
 */
export function entraAOperacion(desde: EstadoTramite, hacia: EstadoTramite): boolean {
  return (desde === "SOLICITUD" || desde === "APERTURA") && esEstadoOperativo(hacia);
}

// ─── Mensajes (español, con el consecutivo, nunca ids internos) ──────────────

const NOMBRE_LINEA_SERVICIO: Record<string, string> = {
  TRAMITE: "importación",
  CLASIFICACION: "clasificación arancelaria",
  EXPORTACION: "exportación",
  PLAN_VALLEJO: "Plan Vallejo",
  OTROS: "otros servicios",
};

/** "TRAMITE" → "importación". Una línea nueva sale legible sin tocar código. */
export function nombreLineaServicio(lineaServicio: string): string {
  return NOMBRE_LINEA_SERVICIO[lineaServicio] ?? lineaServicio.toLowerCase().replace(/_/g, " ");
}

/** "DO.BAQ26-0301" se nombra tal cual; "CLAS26-0001" como "trámite CLAS26-0001". */
function referenciaTramite(consecutivo: string): string {
  return consecutivo.startsWith("DO.") ? consecutivo : `trámite ${consecutivo}`;
}

/** dd/mm/aaaa en UTC (las vigencias se guardan a medianoche UTC). */
export function formatearFechaCorta(fecha: Date): string {
  const dd = String(fecha.getUTCDate()).padStart(2, "0");
  const mm = String(fecha.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${fecha.getUTCFullYear()}`;
}

function unirConY(partes: readonly string[]): string {
  if (partes.length <= 1) return partes.join("");
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

/** "Falta el BL y la factura comercial del DO.BAQ26-0301." */
export function mensajeDocumentosFaltantes(
  faltantes: readonly DocumentoObligatorio[],
  consecutivo: string,
): string {
  const lista = unirConY(faltantes.map((categoria) => NOMBRE_EN_FRASE[categoria]));
  return `Falta ${lista} del ${referenciaTramite(consecutivo)}.`;
}

/**
 * Por qué no hay tarifa aunque haya una publicada: ya venció o todavía no
 * empieza a regir (un tarifario VIGENTE fuera de fecha no cuenta).
 */
export type TarifaFueraDeFecha =
  | { motivo: "VENCIDA"; fecha: Date }
  | { motivo: "FUTURA"; fecha: Date };

/**
 * Compara la última tarifa publicada (estado VIGENTE) con la fecha. `null` si
 * no hay publicada o si en realidad está en fecha. Mismo criterio de vigencia
 * que la facturación (`vigenteEn` del motor de tarifas).
 */
export function tarifaFueraDeFecha(
  publicada: { vigenteDesde: Date; vigenteHasta: Date } | null,
  fecha: Date,
): TarifaFueraDeFecha | null {
  if (!publicada) return null;
  if (fecha.getTime() < publicada.vigenteDesde.getTime()) {
    return { motivo: "FUTURA", fecha: publicada.vigenteDesde };
  }
  if (!vigenteEn(publicada, fecha)) {
    return { motivo: "VENCIDA", fecha: publicada.vigenteHasta };
  }
  return null;
}

export interface MensajeTarifaInput {
  empresa: string;
  lineaServicio: string;
  /** Sin `tarifario_propio` la empresa ni siquiera puede cargar tarifas. */
  tarifarioPropioActivo: boolean;
  fueraDeFecha?: TarifaFueraDeFecha | null;
  /** Consecutivo del DO al intentar abrir una solicitud; `null` al crear. */
  consecutivo?: string | null;
}

/**
 * "LITOPLAS SA no tiene una tarifa vigente de importación. Publica la tarifa
 * de la empresa antes de crear el DO."
 */
export function mensajeTarifaRequerida(input: MensajeTarifaInput): string {
  const linea = nombreLineaServicio(input.lineaServicio);
  let detalle = "";

  if (input.fueraDeFecha?.motivo === "VENCIDA") {
    detalle = `: la publicada venció el ${formatearFechaCorta(input.fueraDeFecha.fecha)}`;
  } else if (input.fueraDeFecha?.motivo === "FUTURA") {
    detalle = `: la publicada empieza a regir el ${formatearFechaCorta(input.fueraDeFecha.fecha)}`;
  }

  const momento = input.consecutivo
    ? `abrir el ${referenciaTramite(input.consecutivo)}`
    : "crear el DO";

  const instruccion = input.tarifarioPropioActivo
    ? `Publica la tarifa de la empresa antes de ${momento}.`
    : `Activa «Tarifario propio versionado» en la pestaña Funciones de la empresa y publica su tarifa antes de ${momento}.`;

  return `${input.empresa} no tiene una tarifa vigente de ${linea}${detalle}. ${instruccion}`;
}

// ─── Contrato de GET /api/tramites/requisitos ─────────────────────────────────

export interface TarifarioResumen {
  id: string;
  nombre: string;
  version: number;
  vigenteHasta: Date;
}

export interface RequisitosDo {
  tarifaVigente: {
    /** La empresa tiene D1 encendida para este tipo de trámite. */
    requerida: boolean;
    /** `true` si no se exige o si hay tarifa vigente hoy. */
    cumple: boolean;
    /** Línea de servicio del tipo (alcance del tarifario): TRAMITE, CLASIFICACION, OTROS… */
    lineaServicio: string;
    /** Tarifario vigente hoy para esa línea, se exija o no. */
    tarifario: TarifarioResumen | null;
    /** Sin esta función la empresa no puede cargar tarifas: la UI debe pedir activarla primero. */
    tarifarioPropioHabilitado: boolean;
    /** El mismo texto que devolvería el servidor al crear; `null` si cumple. */
    mensaje: string | null;
  };
  documentosObligatorios: {
    /** Categorías que el DO debe tener antes de pasar a EN_TRAMITE (vacío = ninguna). */
    requeridos: DocumentoObligatorio[];
  };
}

export function armarRequisitos(input: {
  capacidades: MapaCapacidades;
  empresa: string;
  tipoTramite: { codigo: string; lineaServicio: string };
  tarifario: TarifarioResumen | null;
  fueraDeFecha: TarifaFueraDeFecha | null;
}): RequisitosDo {
  const requerida = exigeTarifaVigente(input.capacidades, input.tipoTramite.codigo);
  const tarifarioPropioHabilitado = tiene(input.capacidades, "tarifario_propio");
  const cumple = !requerida || input.tarifario !== null;

  return {
    tarifaVigente: {
      requerida,
      cumple,
      lineaServicio: input.tipoTramite.lineaServicio,
      tarifario: input.tarifario,
      tarifarioPropioHabilitado,
      mensaje: cumple
        ? null
        : mensajeTarifaRequerida({
            empresa: input.empresa,
            lineaServicio: input.tipoTramite.lineaServicio,
            tarifarioPropioActivo: tarifarioPropioHabilitado,
            fueraDeFecha: input.fueraDeFecha,
            consecutivo: null,
          }),
    },
    documentosObligatorios: {
      requeridos: documentosRequeridos(input.capacidades, input.tipoTramite.codigo),
    },
  };
}
