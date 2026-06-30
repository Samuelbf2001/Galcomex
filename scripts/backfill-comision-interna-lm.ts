/**
 * Backfill de la comisión interna Galcomex→Lucho en borradores SOCIO_LM históricos.
 *
 * Contexto: el campo `comisionInternaLM` se añadió en Fase 1 con @default(0), y
 * `saldoLMInterno` nació también en 0 (nunca se calculó para los borradores
 * previos). Resultado: el cruce se muestra con comisión 0 y el módulo de
 * Liquidación LM (que lee el `saldoLMInterno` almacenado) vería 0 en los históricos.
 *
 * Este script, para cada borrador SOCIO_LM con `comisionInternaLM = 0`:
 *   1. Fija `comisionInternaLM = COMISION_LM` (150.000).
 *   2. RECALCULA `saldoLMInterno` desde los componentes almacenados
 *      (totalAnticipo, totalPagos, ivaComision) + costos bancarios crudos
 *      (Σ costos de pagos + costoRecaudo de anticipos distintos), idéntico a
 *      `actualizarComisionInternaLM`. NO deriva del 0 almacenado.
 *
 * No toca borradores con una comisión interna ya fijada manualmente (≠ 0).
 *
 * Uso:
 *   npx tsx scripts/backfill-comision-interna-lm.ts          # dry-run (no escribe)
 *   npx tsx scripts/backfill-comision-interna-lm.ts --apply  # aplica los cambios
 */
import "dotenv/config";
import { Rol, TipoCliente } from "@prisma/client";

import { calcularSaldoLMInterno } from "../src/lib/calculations/cruce-lm";
import { getParametrosSistema } from "../src/lib/parametros/service";
import { prisma } from "../src/lib/db/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const params = await getParametrosSistema();
  const comisionDefault = params.comisionDefault;

  // El audit log exige un usuario (FK). Usamos un ADMIN como autor del backfill.
  const admin = await prisma.user.findFirst({
    where: { rol: Rol.ADMIN },
    select: { id: true },
  });

  const borradores = await prisma.borradorFactura.findMany({
    where: {
      comisionInternaLM: 0n,
      tramite: { cliente: { tipo: TipoCliente.SOCIO_LM } },
    },
    select: {
      id: true,
      estado: true,
      tramiteId: true,
      totalAnticipo: true,
      totalPagos: true,
      ivaComision: true,
      saldoLMInterno: true,
      saldoAFavorCliente: true,
      tramite: { select: { consecutivo: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `\nComisión interna a aplicar (COMISION_LM): ${comisionDefault.toString()}`,
  );
  console.log(
    `Borradores SOCIO_LM con comisionInternaLM=0: ${borradores.length}\n`,
  );

  for (const b of borradores) {
    // Costos bancarios reales: Σ costos de pagos + Σ costoRecaudo de anticipos distintos.
    const [pagos, aplicaciones] = await Promise.all([
      prisma.pagoTramite.findMany({
        where: { tramiteId: b.tramiteId },
        select: { costoBancario: true },
      }),
      prisma.aplicacionAnticipo.findMany({
        where: { tramiteId: b.tramiteId },
        select: { anticipo: { select: { id: true, costoRecaudo: true } } },
      }),
    ]);

    const costosPagos = pagos.reduce((sum, p) => sum + p.costoBancario, 0n);
    const costoRecaudoAnticipo = aplicaciones
      .filter(
        (a, idx, arr) =>
          arr.findIndex((x) => x.anticipo.id === a.anticipo.id) === idx,
      )
      .reduce((sum, a) => sum + a.anticipo.costoRecaudo, 0n);
    const costosBancarios = costosPagos + costoRecaudoAnticipo;

    const { saldoLMInterno } = calcularSaldoLMInterno({
      totalAnticipo: b.totalAnticipo,
      totalPagos: b.totalPagos,
      comisionInternaLM: comisionDefault,
      ivaComision: b.ivaComision,
      costosBancarios,
      tasa4x1000: params.tasa4x1000,
    });

    const saldoLM = saldoLMInterno - b.saldoAFavorCliente;
    console.log(
      `  ${b.tramite.consecutivo.padEnd(16)} [${b.estado}]  ` +
        `saldoInterno → ${saldoLMInterno.toString()}  ` +
        `(saldoLM ${saldoLM.toString()})`,
    );

    if (apply) {
      await prisma.borradorFactura.update({
        where: { id: b.id },
        data: { comisionInternaLM: comisionDefault, saldoLMInterno },
      });
      if (admin) {
        await prisma.auditLog.create({
          data: {
            entidad: "BorradorFactura",
            entidadId: b.id,
            accion: "BACKFILL_COMISION_INTERNA_LM",
            usuarioId: admin.id,
            tramiteId: b.tramiteId,
            antes: { comisionInternaLM: "0", saldoLMInterno: b.saldoLMInterno.toString() },
            despues: {
              comisionInternaLM: comisionDefault.toString(),
              saldoLMInterno: saldoLMInterno.toString(),
            },
          },
        });
      }
    }
  }

  console.log(
    apply
      ? `\n✅ Aplicado a ${borradores.length} borradores.\n`
      : `\nDry-run: no se escribió nada. Re-ejecuta con --apply para aplicar.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
