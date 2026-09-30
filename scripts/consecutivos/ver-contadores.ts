/**
 * Estado de los contadores de consecutivos (30-sep-2026), SOLO LECTURA: la
 * misma tabla que `GET /api/tramites/consecutivos`.
 *
 *   npx tsx scripts/consecutivos/ver-contadores.ts [--anio 2026] [--json]
 *
 * Por cada contador del año: tipo, ciudades, último número usado, piso y el
 * consecutivo que tomaría el próximo DO. Barranquilla, Bogotá y Buenaventura
 * salen como UN contador compartido. Para verificar la ventana de puesta en
 * marcha (DISENO-NUMERACION.md §7): grupo 0282 (o el siguiente al último de
 * Camila), Cartagena 0251, Santa Marta 0002, Exportación 0013, Otros 0019,
 * Clasificación 0011.
 */
import "dotenv/config";

import { prisma } from "../../src/lib/db/prisma";
import { estadoContadores } from "../../src/lib/tramites/service";

function valorDe(bandera: string): string | null {
  const i = process.argv.indexOf(bandera);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function baseDeDatos(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return "(DATABASE_URL no definida o ilegible)";
  }
}

async function main() {
  const anioTexto = valorDe("--anio");
  const anio = anioTexto ? Number(anioTexto) : undefined;
  if (anioTexto && !Number.isInteger(anio)) throw new Error(`Año inválido: ${anioTexto}`);

  const contadores = await estadoContadores(anio);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(contadores, null, 2));
    return;
  }
  console.log(`Base de datos: ${baseDeDatos()}`);
  console.table(
    contadores.map((c) => ({
      contador: c.contador,
      clave: c.clave,
      ultimo: c.ultimo ?? "—",
      piso: c.piso ?? "—",
      siguiente: c.siguiente,
    })),
  );
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
