/**
 * Validación del formato de factura CONCEPTOS_IVA contra una factura real.
 *
 * Réplica local del DO.26-0069 IM054-26 SRF de Litoplas (factura Siigo
 * BAQ-18385, $1.487.623,45). Usa los servicios reales sobre la BD de
 * DATABASE_URL y compara línea a línea. No envía nada a Siigo.
 *
 *   npx tsx scripts/validar-formato-conceptos-iva.ts --tramite <id> --empresa <id> --tarifario <id>
 *
 * El tarifario debe ser un BORRADOR de la empresa (se ajusta a lo que dicen las
 * facturas reales y se publica). Solo para BD local o de pruebas.
 */

import "dotenv/config";

import { SeccionLinea } from "@prisma/client";

import { actualizarLinea } from "../src/lib/borradores/lineas-service";
import { generarBorrador } from "../src/lib/borradores/service";
import { setCapacidadesEmpresa } from "../src/lib/capacidades/service";
import { prisma } from "../src/lib/db/prisma";
import { construirItemsSiigo } from "../src/lib/siigo/items-factura";
import {
  actualizarItemTarifario,
  cambiarEstadoTarifario,
  getTarifario,
} from "../src/lib/tarifas/service";

function arg(nombre: string): string {
  const i = process.argv.indexOf(`--${nombre}`);
  const valor = i >= 0 ? process.argv[i + 1] : undefined;
  if (!valor) throw new Error(`Falta --${nombre}`);
  return valor;
}

const cop = (v: bigint) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
let fallos = 0;
function comparar(que: string, obtenido: unknown, esperado: unknown) {
  const ok = JSON.stringify(obtenido, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(esperado, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  if (!ok) fallos++;
  console.log(`  ${ok ? "✓" : "✗"} ${que}: ${JSON.stringify(obtenido, (_, v) => (typeof v === "bigint" ? cop(v) : v))}${ok ? "" : `  (esperado ${JSON.stringify(esperado, (_, v) => (typeof v === "bigint" ? cop(v) : v))})`}`);
}

async function main() {
  const tramiteId = arg("tramite");
  const empresaId = arg("empresa");
  const tarifarioId = arg("tarifario");

  const usuario = await prisma.user.findFirstOrThrow({ where: { rol: "ADMIN" }, select: { id: true } });
  const usuarioId = usuario.id;

  console.log("\n1. Tarifario según las facturas reales 2026 (edición parcial de ítems)");
  const tarifario = await getTarifario(tarifarioId);
  if (tarifario.estado === "BORRADOR") {
    const item = (concepto: string) => tarifario.items.find((i) => i.concepto === concepto);
    const cambios: [string, Record<string, unknown>][] = [
      ["GASTOS_TRAMITE", { nombrePublico: "ASESORIA LOGISTICA OPERATIVA", siigoCodigo: "007" }],
      ["REVISION_DESPACHO", { nombrePublico: "SERV COORDINACION EN DESPACHO", siigoCodigo: "006", valor: 200_000n, disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 20 }],
      ["SISTEMATIZACION", { nombrePublico: "SISTEMATIZACION DE ARCHIVOS" }],
      ["DOCUMENTACION", { nombrePublico: "REVISION DOCUMENTAL", unidad: "DOCUMENTO" }],
    ];
    for (const [concepto, payload] of cambios) {
      const it = item(concepto);
      if (!it) throw new Error(`El tarifario no tiene ${concepto}`);
      await actualizarItemTarifario(tarifarioId, it.id, payload, usuarioId);
    }
    const editado = await getTarifario(tarifarioId);
    const gastos = editado.items.find((i) => i.concepto === "GASTOS_TRAMITE")!;
    comparar("edición parcial conserva disparador/orden/valor de GASTOS", [gastos.disparador, gastos.orden, gastos.valor], ["SIEMPRE", 10, 100_000n]);
    await cambiarEstadoTarifario(tarifarioId, "VIGENTE", usuarioId);
    console.log("  ✓ publicado");
  } else {
    console.log(`  (ya está ${tarifario.estado})`);
  }

  console.log("\n2. Función factura_conceptos_iva encendida");
  await setCapacidadesEmpresa({
    empresaId,
    usuarioId,
    cambios: [{ codigo: "factura_conceptos_iva", habilitado: true }],
  });

  console.log("\n3. Borrador generado");
  const generado = await generarBorrador({ tramiteId, usuarioId });
  const borrador = await prisma.borradorFactura.findUniqueOrThrow({
    where: { id: generado.id },
    include: {
      lineasRevision: {
        orderBy: [{ seccion: "asc" }, { orden: "asc" }],
        include: {
          siigoProducto: { select: { codigo: true } },
          facturas: { select: { factura: { select: { proveedorNit: true } } } },
        },
      },
    },
  });
  for (const l of borrador.lineasRevision) {
    console.log(`    ${l.seccion.padEnd(11)} ${String(l.orden).padStart(3)} ${(l.siigoProducto?.codigo ?? "—").padEnd(4)} ${l.aplicaIva ? "IVA" : "   "} ${l.concepto.padEnd(52)} ${cop(l.valor).padStart(10)}`);
  }

  comparar("formato", borrador.formatoFactura, "CONCEPTOS_IVA");
  comparar("terceros", borrador.lineasRevision.filter((l) => l.seccion === SeccionLinea.TERCEROS && !l.tipoFija).map((l) => [l.siigoProducto?.codigo, l.valor]), [["31", 486_075n], ["11", 99_484n], ["03", 502_801n]]);
  comparar("conceptos propios", borrador.lineasRevision.filter((l) => l.seccion === SeccionLinea.OPERACIONAL && !l.tipoFija).map((l) => [l.siigoProducto?.codigo, l.valor, l.aplicaIva]).sort(), [["002", 20_000n, true], ["004", 20_000n, true], ["006", 200_000n, true], ["007", 100_000n, true]]);
  comparar("4x1000", borrador.impuesto4x1000, 4_353n);
  comparar("IVA", borrador.ivaComision, 64_600n);
  comparar("ReteIVA", borrador.retenciones, 9_690n);
  comparar("costos bancarios", borrador.costosBancarios, 0n);
  comparar("total factura", borrador.totalFactura, 1_487_623n);
  comparar("saldo a cargo", borrador.saldoACargoCliente, 69_623n);
  comparar("observaciones", borrador.comentariosCabecera, ["NO PRACTICAR RETEFUENTE NI RETEICA", "DO.BAQ26-0114 IM054-26 SRF"]);

  console.log("\n4. Ítems que irían a Siigo (sin enviar)");
  const items = construirItemsSiigo(
    borrador.lineasRevision.map((l) => ({
      concepto: l.concepto,
      valor: l.valor,
      orden: l.orden,
      seccion: l.seccion,
      tipoFija: l.tipoFija,
      aplicaIva: l.aplicaIva,
      productoCodigo: l.siigoProducto?.codigo ?? (l.tipoFija === "IMPUESTO_4X1000" ? "13" : null),
      nitTercero: l.facturas[0]?.factura.proveedorNit ?? null,
    })),
    { formato: borrador.formatoFactura, ivaTaxId: 1564, nit4x1000: "890300279" },
  );
  for (const i of items) console.log(`    ${i.code.padEnd(4)} ${String(i.price).padStart(8)} ${i.taxes ? "IVA" : "   "} ${i.customer?.identification ?? ""}  ${i.description}`);
  comparar("ítems (código, precio, IVA, tercero)", items.map((i) => [i.code, i.price, Boolean(i.taxes), i.customer?.identification ?? null]), [
    ["31", 486_075, false, "890912462"],
    ["11", 99_484, false, "802011826"],
    ["03", 502_801, false, "800154017"],
    ["13", 4_353, false, "890300279"],
    ["007", 100_000, true, null],
    ["006", 200_000, true, null],
    ["004", 20_000, true, null],
    ["002", 20_000, true, null],
  ]);

  console.log("\n5. Editar una línea recalcula IVA, 4x1000 y ReteIVA");
  const almacarga = borrador.lineasRevision.find((l) => l.siigoProducto?.codigo === "03")!;
  const revision = borrador.lineasRevision.find((l) => l.siigoProducto?.codigo === "006")!;
  await actualizarLinea({ lineaId: revision.id, valor: 180_000n, usuarioId });
  await actualizarLinea({ lineaId: almacarga.id, valor: 1_000_000n, usuarioId });
  let b = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: borrador.id } });
  comparar("con revisión 180.000 y Almacarga 1.000.000: [IVA, ReteIVA, 4x1000, total]", [b.ivaComision, b.retenciones, b.impuesto4x1000, b.totalFactura], [60_800n, 9_120n, 6_342n, 1_963_581n]);
  await actualizarLinea({ lineaId: revision.id, valor: 200_000n, usuarioId });
  await actualizarLinea({ lineaId: almacarga.id, valor: 502_801n, usuarioId });
  b = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: borrador.id } });
  comparar("revertido: total", b.totalFactura, 1_487_623n);

  console.log(`\n${fallos === 0 ? "✅ Todo cuadra con BAQ-18385" : `❌ ${fallos} diferencia(s)`}`);
  console.log(`   borrador ${borrador.id}`);
  await prisma.$disconnect();
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
