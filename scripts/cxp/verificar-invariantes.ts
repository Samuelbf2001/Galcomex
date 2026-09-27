/**
 * Verifica los invariantes de CxP v2 (I1–I7, diseño §C R20) sobre la base de
 * `DATABASE_URL`. SOLO LECTURA. Lógica en `src/lib/cxp/invariantes.ts`.
 *
 *   npx tsx scripts/cxp/verificar-invariantes.ts [--json] [--salida informe.txt] [--max 50]
 *
 * Sale con código 1 si hay alguna violación (los avisos no cuentan), para
 * usarlo como compuerta en el runbook del despliegue (§I).
 */

import "dotenv/config";

import { writeFileSync } from "node:fs";

import { informeInvariantesTexto, verificarInvariantes } from "../../src/lib/cxp/invariantes";
import { prisma } from "../../src/lib/db/prisma";

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
  const informe = await verificarInvariantes(prisma);
  const max = Number(valorDe("--max") ?? "50");
  const texto = `Base de datos: ${baseDeDatos()}\n${informeInvariantesTexto(informe, Number.isFinite(max) && max > 0 ? max : 50)}`;
  const salida = valorDe("--salida");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(informe, null, 2));
  } else {
    console.log(texto);
  }
  if (salida) writeFileSync(salida, texto + "\n", "utf8");
  if (informe.violaciones.length > 0) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
