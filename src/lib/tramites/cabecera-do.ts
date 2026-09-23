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
