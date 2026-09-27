/**
 * Compara, empresa por empresa, el lado proveedor de la cuenta corriente con el
 * estado de cuenta de CxP v2 (pedido de Ernesto, 26-sep: «valida muy bien que se
 * cruce»). SOLO LECTURA sobre `DATABASE_URL`.
 *
 *   npx tsx scripts/cxp/comparar-cuenta-vs-cxp.ts
 *
 * Por diseño, la cuenta corriente suma además los movimientos a mano (facturas
 * de contraparte sin DO, ajustes, cruces) y CxP v2 no. Por eso se comparan las
 * FACTURAS DE PROVEEDOR de cada lado; los movimientos a mano salen aparte.
 * Sale con código 1 si alguna empresa difiere en facturas de proveedor.
 */

import "dotenv/config";

import { getCuentaCorriente } from "../../src/lib/cuenta-corriente/service";
import { getEstadoCuentaProveedor } from "../../src/lib/cxp/estado-cuenta";
import { prisma } from "../../src/lib/db/prisma";

async function main() {
  const empresas = await prisma.cliente.findMany({
    where: { OR: [{ esProveedor: true }, { beneficiarios: { some: {} } }] },
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });

  let diferencias = 0;
  console.log("empresa | fichas_cc(empresaId) | fichas_cxp(empresaId+NIT) | cc_facturas_proveedor | cxp_pendiente | cc_movimientos_a_mano_proveedor | igual");
  for (const e of empresas) {
    const [cc, cxp, fichasCc] = await Promise.all([
      getCuentaCorriente(e.id),
      getEstadoCuentaProveedor(e.id, "ADMIN"),
      prisma.beneficiario.count({ where: { empresaId: e.id } }),
    ]);
    const ccFacturas = cc.movimientos
      .filter((a) => a.fuente === "FACTURA_PROVEEDOR")
      .reduce((s, a) => s - a.valor, 0n);
    const ccManualProveedor = cc.pendienteProveedor - ccFacturas;
    const cxpPendiente = cxp.resumen ? BigInt(cxp.resumen.pendiente) : 0n;
    const igual = ccFacturas === cxpPendiente && fichasCc === cxp.fichas.length;
    if (!igual) diferencias += 1;
    console.log(
      [e.nombre, fichasCc, cxp.fichas.length, ccFacturas, cxpPendiente, ccManualProveedor, igual ? "sí" : "NO"].join(" | "),
    );
  }
  console.log(`\nEmpresas revisadas: ${empresas.length} · con diferencia en facturas de proveedor o fichas: ${diferencias}`);
  await prisma.$disconnect();
  if (diferencias > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(2);
});
