/**
 * Etiquetas legibles para `lineaServicio` en la cuenta corriente por
 * contraparte. Reutiliza los mismos nombres que el filtro «Línea» de cartera
 * (`src/components/cartera/cartera-workspace.tsx`) y agrega las dos líneas
 * que solo existen en movimientos manuales (comisiones, asesoría no
 * repercutible). Un código que no esté en el mapa se muestra tal cual: mejor
 * un código en mayúsculas que una etiqueta inventada.
 */
const ETIQUETAS_LINEA_SERVICIO: Record<string, string> = {
  TRAMITE: "Trámites",
  CLASIFICACION: "Clasificación arancelaria",
  // Tipo Exportación (30-sep-2026): su propia línea, igual que en el filtro «Línea» de cartera.
  EXPORTACION: "Exportación",
  PLAN_VALLEJO: "Plan Vallejo",
  OTROS: "Otros servicios",
  OTRO: "Otros servicios",
  COMISION: "Comisiones",
  ASESORIA: "Asesoría",
};

export function etiquetaLineaServicio(codigo: string): string {
  return ETIQUETAS_LINEA_SERVICIO[codigo] ?? codigo;
}
