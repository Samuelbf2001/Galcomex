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
 *
 * Fase centavos (diseño E.2.3): la BD está en CENTAVOS. Dorado exacto:
 * FE-11298 = 502.801,45 → total 1.487.623,45 · a cargo 69.623,45; ítems Siigo
 * con `price` 502801.45. Exige que FE-11298 ya tenga sus centavos reales (tras
 * la re-expresión C.5 o registrada así). Con `--historico-entero` acepta la
 * factura histórica en pesos enteros (502.801) y valida el mismo cálculo ×100
 * (total 1.487.623,00 · a cargo 69.623,00).
 *
 *   npx tsx scripts/validar-formato-conceptos-iva.ts --tramite <id> --empresa <id> --tarifario <id> [--historico-entero]
 */

import "dotenv/config";

import { SeccionLinea } from "@prisma/client";

import { formatoPesos, pesos, stringifyDinero } from "../src/lib/dinero";
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

/** Centavos → "502.801,45" (es-CO, sin "$"). */
const cop = (v: bigint) => formatoPesos(v, { simbolo: false });
let fallos = 0;
/** Compara en CENTAVOS; muestra PESOS (el serializador único emite pesos con 2 decimales). */
function comparar(que: string, obtenido: unknown, esperado: unknown) {
  const ok = stringifyDinero(obtenido) === stringifyDinero(esperado);
  if (!ok) fallos++;
  console.log(`  ${ok ? "✓" : "✗"} ${que}: ${stringifyDinero(obtenido)}${ok ? "" : `  (esperado ${stringifyDinero(esperado)})`}`);
}

async function main() {
  const tramiteId = arg("tramite");
  const empresaId = arg("empresa");
  const tarifarioId = arg("tarifario");
  const historicoEntero = process.argv.includes("--historico-entero");

  const usuario = await prisma.user.findFirstOrThrow({ where: { rol: "ADMIN" }, select: { id: true } });
  const usuarioId = usuario.id;

  console.log("\n1. Tarifario según las facturas reales 2026 (edición parcial de ítems)");
  const tarifario = await getTarifario(tarifarioId);
  if (tarifario.estado === "BORRADOR") {
    const item = (concepto: string) => tarifario.items.find((i) => i.concepto === concepto);
    const cambios: [string, Record<string, unknown>][] = [
      ["GASTOS_TRAMITE", { nombrePublico: "ASESORIA LOGISTICA OPERATIVA", siigoCodigo: "007" }],
      ["REVISION_DESPACHO", { nombrePublico: "SERV COORDINACION EN DESPACHO", siigoCodigo: "006", valor: pesos(200_000), disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 20 }],
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
    comparar("edición parcial conserva disparador/orden/valor de GASTOS", [gastos.disparador, gastos.orden, gastos.valorCentavos], ["SIEMPRE", 10, pesos(100_000)]);
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
    console.log(`    ${l.seccion.padEnd(11)} ${String(l.orden).padStart(3)} ${(l.siigoProducto?.codigo ?? "—").padEnd(4)} ${l.aplicaIva ? "IVA" : "   "} ${l.concepto.padEnd(52)} ${cop(l.valorCentavos).padStart(13)}`);
  }

  // FE-11298 (Almacarga, producto 03): 502.801,45 real. Sin --historico-entero se exige.
  const almacargaValor = borrador.lineasRevision.find((l) => l.siigoProducto?.codigo === "03")?.valorCentavos;
  const almacargaEsperada = historicoEntero ? pesos(502_801) : 50_280_145n;
  const centavosAlmacarga = almacargaEsperada - pesos(502_801); // 45 o 0
  if (almacargaValor === pesos(502_801) && !historicoEntero) {
    console.log("  ⚠ FE-11298 sigue en pesos enteros (502.801): falta la re-expresión C.5. Usa --historico-entero para validar el cálculo ×100.");
  }

  comparar("formato", borrador.formatoFactura, "CONCEPTOS_IVA");
  comparar("terceros", borrador.lineasRevision.filter((l) => l.seccion === SeccionLinea.TERCEROS && !l.tipoFija).map((l) => [l.siigoProducto?.codigo, l.valorCentavos]), [["31", pesos(486_075)], ["11", pesos(99_484)], ["03", almacargaEsperada]]);
  comparar("conceptos propios", borrador.lineasRevision.filter((l) => l.seccion === SeccionLinea.OPERACIONAL && !l.tipoFija).map((l) => [l.siigoProducto?.codigo, l.valorCentavos, l.aplicaIva]).sort(), [["002", pesos(20_000), true], ["004", pesos(20_000), true], ["006", pesos(200_000), true], ["007", pesos(100_000), true]]);
  // 4x1000 al peso: 0,4 % de 1.088.360,45 = 4.353,44 → 4.353 (igual con o sin los 0,45)
  comparar("4x1000", borrador.impuesto4x1000Centavos, pesos(4_353));
  comparar("IVA", borrador.ivaComisionCentavos, pesos(64_600));
  comparar("ReteIVA", borrador.retencionesCentavos, pesos(9_690));
  comparar("costos bancarios", borrador.costosBancariosCentavos, 0n);
  // Dorado exacto: 148.762.345 (1.487.623,45) · 6.962.345 (69.623,45)
  comparar("total factura", borrador.totalFacturaCentavos, pesos(1_487_623) + centavosAlmacarga);
  comparar("saldo a cargo", borrador.saldoACargoClienteCentavos, pesos(69_623) + centavosAlmacarga);
  comparar("observaciones", borrador.comentariosCabecera, ["NO PRACTICAR RETEFUENTE NI RETEICA", "DO.BAQ26-0114 IM054-26 SRF"]);

  console.log("\n4. Ítems que irían a Siigo (sin enviar)");
  const items = construirItemsSiigo(
    borrador.lineasRevision.map((l) => ({
      concepto: l.concepto,
      valorCentavos: l.valorCentavos,
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
    ["03", historicoEntero ? 502_801 : 502_801.45, false, "800154017"],
    ["13", 4_353, false, "890300279"],
    ["007", 100_000, true, null],
    ["006", 200_000, true, null],
    ["004", 20_000, true, null],
    ["002", 20_000, true, null],
  ]);

  console.log("\n5. Editar una línea recalcula IVA, 4x1000 y ReteIVA");
  const almacarga = borrador.lineasRevision.find((l) => l.siigoProducto?.codigo === "03")!;
  const revision = borrador.lineasRevision.find((l) => l.siigoProducto?.codigo === "006")!;
  await actualizarLinea({ lineaId: revision.id, valor: pesos(180_000), usuarioId });
  await actualizarLinea({ lineaId: almacarga.id, valor: pesos(1_000_000), usuarioId });
  let b = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: borrador.id } });
  comparar("con revisión 180.000 y Almacarga 1.000.000: [IVA, ReteIVA, 4x1000, total]", [b.ivaComisionCentavos, b.retencionesCentavos, b.impuesto4x1000Centavos, b.totalFacturaCentavos], [pesos(60_800), pesos(9_120), pesos(6_342), pesos(1_963_581)]);
  await actualizarLinea({ lineaId: revision.id, valor: pesos(200_000), usuarioId });
  await actualizarLinea({ lineaId: almacarga.id, valor: almacargaEsperada, usuarioId });
  b = await prisma.borradorFactura.findUniqueOrThrow({ where: { id: borrador.id } });
  comparar("revertido: total", b.totalFacturaCentavos, pesos(1_487_623) + centavosAlmacarga);

  console.log(
    `\n${fallos === 0 ? `✅ Todo cuadra con BAQ-18385 (${formatoPesos(pesos(1_487_623) + centavosAlmacarga)} / a cargo ${formatoPesos(pesos(69_623) + centavosAlmacarga)})` : `❌ ${fallos} diferencia(s)`}`,
  );
  console.log(`   borrador ${borrador.id}`);
  await prisma.$disconnect();
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
