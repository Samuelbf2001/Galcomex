/**
 * Lectura del catálogo de servicios de trámite (tabla `servicio_tramite`) y de
 * los tipos, en UNA consulta. Lo usan la creación y edición de DOs, las
 * transiciones (D1/D2 por servicio), la propuesta del tarifario y la regla de
 * servicio de las tarifas. Sin lógica: las reglas viven en `servicios.ts` (puro).
 *
 * Vive aparte de `lib/tramites/service.ts` para que `lib/tarifas/service.ts`
 * lo pueda usar sin importación circular.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ServicioCatalogo, TipoParaServicio } from "@/lib/tramites/servicios";

export interface CatalogoServicios {
  tipos: TipoParaServicio[];
  /** Servicios ACTIVOS de todos los tipos (activos o no los tipos). */
  catalogo: ServicioCatalogo[];
}

type Cliente = Prisma.TransactionClient | typeof prisma;

export async function cargarCatalogoServicios(db: Cliente = prisma): Promise<CatalogoServicios> {
  const tipos = await db.tipoTramite.findMany({
    select: {
      codigo: true,
      nombre: true,
      lineaServicio: true,
      flujoCorto: true,
      servicios: {
        where: { activo: true },
        orderBy: { orden: "asc" },
        select: {
          id: true,
          tipoTramiteCodigo: true,
          conceptoCodigo: true,
          nombre: true,
          tarifaGeneral: true,
          documentosNoAplican: true,
          orden: true,
          activo: true,
        },
      },
    },
    orderBy: { orden: "asc" },
  });

  return {
    tipos: tipos.map(({ servicios: _servicios, ...tipo }) => tipo),
    catalogo: tipos.flatMap((t) => t.servicios),
  };
}
