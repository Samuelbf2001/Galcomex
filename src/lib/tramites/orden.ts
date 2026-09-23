import type { Prisma } from "@prisma/client";

/**
 * Orden de la tabla de trámites (revisión de Ernesto, 22-sep-2026). Función
 * PURA: solo arma el `orderBy` de Prisma, sin tocar la BD — así se puede
 * probar sin levantar Postgres.
 *
 * Referencia (coalesce de doAgencia/doCliente/proveedorCliente) y Docs
 * (conteo de checklist pendiente, calculado en el cliente) no aparecen aquí a
 * propósito: no son ordenables.
 */
export const CAMPOS_ORDEN_TRAMITE = [
  "consecutivo",
  "cliente",
  "estado",
  "ciudad",
  "modalidad",
  "apertura",
  "movimiento",
  "responsable",
] as const;

export type OrdenTramitesCampo = (typeof CAMPOS_ORDEN_TRAMITE)[number];
export type DireccionOrden = "asc" | "desc";

/** Orden de siempre: DO más nuevo primero. La vista kanban nunca manda `ordenarPor`, así que siempre cae aquí. */
const ORDEN_POR_DEFECTO: Prisma.TramiteDOOrderByWithRelationInput[] = [
  { anio: "desc" },
  { ciudad: "asc" },
  { numero: "desc" },
];

/**
 * `orderBy` de Prisma para `listTramites`. Sin `ordenarPor` se mantiene el
 * orden de siempre. Siempre agrega `id` al final como desempate estable: dos
 * trámites con el mismo valor de orden (la misma fecha de apertura, por
 * ejemplo) no deben cambiar de posición entre páginas.
 */
export function construirOrdenTramites(
  ordenarPor?: OrdenTramitesCampo,
  direccion: DireccionOrden = "desc",
): Prisma.TramiteDOOrderByWithRelationInput[] {
  const desempate: Prisma.TramiteDOOrderByWithRelationInput = { id: "asc" };

  switch (ordenarPor) {
    case "consecutivo":
      // Mismo criterio de siempre (año, ciudad, número): la dirección elegida
      // se aplica a los tres para conservar el orden cronológico del consecutivo.
      return [{ anio: direccion }, { ciudad: direccion }, { numero: direccion }, desempate];
    case "cliente":
      return [{ cliente: { nombre: direccion } }, desempate];
    case "estado":
      // Postgres ordena el enum EstadoTramite por su orden de declaración en
      // schema.prisma, que es el orden del pipeline (SOLICITUD → … → CERRADO).
      return [{ estado: direccion }, desempate];
    case "ciudad":
      return [{ ciudad: direccion }, desempate];
    case "modalidad":
      return [{ agenciaAduanas: direccion }, desempate];
    case "apertura":
      return [{ createdAt: direccion }, desempate];
    case "movimiento":
      return [{ updatedAt: direccion }, desempate];
    case "responsable":
      return [{ creadoPor: { name: direccion } }, desempate];
    default:
      return [...ORDEN_POR_DEFECTO, desempate];
  }
}
