/**
 * Qué muestra la cabecera del DO (`TabResumen` en `tramite-detalle.tsx`)
 * según el tipo de trámite (M4, revisión de Ernesto 22-sep-2026). Función
 * PURA, sin BD ni React: sin tipo cargado (respuestas viejas del API antes
 * de M4) se conserva el comportamiento histórico — importación de siempre,
 * con DO agencia/cliente y ETA.
 *
 *   D1 (CLASIFICACION): no tiene DO de agencia ni de cliente, solo el número
 *   que asigna la clasificadora (`etiquetaReferenciaExterna`, siempre visible
 *   y editable cuando el tipo lo define).
 */

export type TipoTramiteCabecera = {
  etiquetaReferenciaExterna: string | null;
  usaCamposDo: boolean;
  requiereEta: boolean;
} | null | undefined;

export type VisibilidadCabeceraDo = {
  /** Etiqueta del número externo (p. ej. "N° de informe de la clasificadora"); null = el tipo no lo usa. */
  etiquetaReferenciaExterna: string | null;
  /** Muestra "DO Agencia" y "DO Cliente". false en CLASIFICACION. */
  muestraCamposDo: boolean;
  /** Muestra "ETA". */
  muestraEta: boolean;
};

export function visibilidadCabeceraDo(tipoTramite: TipoTramiteCabecera): VisibilidadCabeceraDo {
  return {
    etiquetaReferenciaExterna: tipoTramite?.etiquetaReferenciaExterna ?? null,
    muestraCamposDo: tipoTramite?.usaCamposDo ?? true,
    muestraEta: tipoTramite?.requiereEta ?? true,
  };
}

/**
 * Qué "Fechas clave" del DO se muestran, según el tipo de trámite (revisión
 * de Ernesto 22-sep-2026, tanda 2). Función PURA. CLASIFICACION solo usa
 * "Documentos OK" y "Enviado a facturar" — las demás (aceptación de
 * declaración, levante, salida de carga) son de un trámite de importación
 * real. Sin tipo cargado, o con `fechasClave` ausente/vacío (respuestas
 * viejas del API antes de esta revisión), se muestran las cinco como
 * fallback seguro: nunca se oculta una fecha por un dato faltante.
 */

export const FECHAS_CLAVE_DO = [
  "fechaAceptacionDeclaracion",
  "fechaLevante",
  "fechaEnviadoAFacturar",
  "fechaDocumentosOk",
  "fechaSalidaCarga",
] as const;

export type FechaClaveDo = (typeof FECHAS_CLAVE_DO)[number];

export type TipoTramiteFechasClave = {
  fechasClave: string[];
} | null | undefined;

export function fechasClaveVisibles(tipoTramite: TipoTramiteFechasClave): FechaClaveDo[] {
  const config = tipoTramite?.fechasClave;
  if (!config || config.length === 0) return [...FECHAS_CLAVE_DO];
  return FECHAS_CLAVE_DO.filter((fecha) => config.includes(fecha));
}
