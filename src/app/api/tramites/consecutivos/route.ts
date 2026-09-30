import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";

import { requireRole } from "@/lib/auth/session";
import { validationError } from "@/lib/http/errors";
import { jsonResponse } from "@/lib/http/json";
import { estadoContadores } from "@/lib/tramites/service";

const querySchema = z.object({
  anio: z.coerce.number().int().min(2020).max(2100).optional(),
});

/**
 * Estado de los contadores de consecutivos del año (30-sep-2026), solo
 * lectura: por cada contador → tipo, ciudades, último número, piso y el
 * consecutivo que tomaría el próximo DO. Barranquilla, Bogotá y Buenaventura
 * salen como UN contador (compartido); Cartagena y Santa Marta, cada una el
 * suyo; Exportación, Otros y Clasificación, por año.
 *
 *   GET /api/tramites/consecutivos[?anio=2026]
 *
 * ADMIN y REVISOR. Para verificar la ventana de puesta en marcha
 * (DISENO-NUMERACION.md §7) y después de fijar un piso.
 */
export async function GET(request: NextRequest) {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  try {
    const { anio } = querySchema.parse({ anio: request.nextUrl.searchParams.get("anio") ?? undefined });
    const contadores = await estadoContadores(anio);
    return jsonResponse({ contadores });
  } catch (error) {
    if (error instanceof ZodError) {
      return validationError(error);
    }
    throw error;
  }
}
