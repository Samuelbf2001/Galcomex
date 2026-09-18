/**
 * Siembra el maestro de conceptos de venta (Configuración → Catálogos) y enlaza
 * los ítems de tarifario que ya existen.
 *
 *   npx tsx scripts/seed-conceptos-venta.ts --dry-run   # solo muestra qué haría
 *   npx tsx scripts/seed-conceptos-venta.ts             # siembra y hace el backfill
 *
 * Idempotente: se puede correr las veces que haga falta. No pisa lo que un
 * ADMIN haya editado desde la UI (solo completa campos vacíos).
 *
 * Requiere la migración `20260918130100_catalogos_conceptos`. Si los productos
 * Siigo todavía no están sincronizados, los conceptos quedan sin producto: se
 * corre `POST /api/configuracion/siigo/sync` y luego este script otra vez.
 *
 * Ver docs/CATALOGOS.md.
 */

import "dotenv/config";

import { sembrarConceptosVenta } from "../src/lib/catalogos/seed-conceptos";
import { prisma } from "../src/lib/db/prisma";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const admin = await prisma.user.findFirst({
    where: { rol: "ADMIN" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const r = await sembrarConceptosVenta({ dryRun, usuarioId: admin?.id ?? null });

  console.log(dryRun ? "— SIMULACIÓN (nada se escribió) —" : "— APLICADO —");
  console.log(`Conceptos: ${r.conceptos.length} · crear ${r.creados} · completar ${r.completados}`);
  console.table(
    r.conceptos.map((c) => ({
      codigo: c.codigo,
      nombre: c.nombre,
      siigo: c.siigoCodigo ?? "—",
      producto: c.siigoProductoId ? "ok" : "sin sincronizar",
      iva: c.aplicaIva ? "sí" : "no",
      accion: c.accion,
    })),
  );

  if (r.sinProducto.length > 0) {
    console.log(
      `\nSin producto Siigo (sincroniza los productos y vuelve a correrlo): ${r.sinProducto.join(", ")}`,
    );
  }
  console.log(
    `\nÍtems de tarifario ${dryRun ? "por enlazar" : "enlazados"} al maestro: ${r.itemsEnlazados}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
