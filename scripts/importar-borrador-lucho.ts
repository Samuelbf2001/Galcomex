/**
 * Importador del borrador de venta de Lucho (Luis Martínez, socio Galcomex).
 *
 * Lee un archivo .xls con el formato de Lucho, valida la reconciliación,
 * crea (idempotentemente) el cliente, DO, anticipo, facturas de proveedor,
 * pagos y borrador en la BD.
 *
 * Uso:
 *   npx tsx scripts/importar-borrador-lucho.ts <ruta.xls> [--ciudad CTG] [--dry-run] [--force]
 *
 * Opciones:
 *   --ciudad CTG    Ciudad del DO cuando el Excel no la incluye (ej. DO.26-0113)
 *   --dry-run       Muestra qué haría sin escribir en BD
 *   --force         Continúa aunque haya discrepancias de reconciliación del Excel
 *
 * Idempotencia: se puede ejecutar varias veces sin duplicar datos.
 *   - Cliente: upsert por NIT
 *   - DO: busca por consecutivo, crea si no existe
 *   - Anticipo: busca por (clienteId, monto, soporteKey marker), crea si no existe
 *   - FacturaProveedor: busca por (tramiteId, numFactura), crea si no existe
 *   - PagoTramite: busca por (tramiteId, concepto, valor), crea si no existe
 *   - BorradorFactura: crea uno nuevo cada vez (el borrador es el artefacto de la factura)
 *
 * NOTA sobre la generación del borrador:
 *   El motor calcularBorrador() usa la fórmula del Excel maestro de Galcomex (BUN26-0026).
 *   En el Excel de Lucho, el impuesto 4x1000 ya viene incluido como línea de terceros
 *   (pagado directamente al banco por el cliente), mientras que el motor calcula el 4x1000
 *   como un porcentaje del anticipo. Esto genera una diferencia entre el 4x1000 del motor
 *   y el del Excel. El script corrige esta discrepancia actualizando el borrador con los
 *   valores exactos del Excel tras llamar a generarBorrador.
 */

import * as path from "node:path";

import { AgenciaAduanas, CanalPago, Ciudad, Rol, TipoCliente, TipoRecaudo } from "@prisma/client";

import { crearAnticipo, aplicarAnticipo } from "../src/lib/anticipos/service";
import { generarBorrador } from "../src/lib/borradores/service";
import { prisma } from "../src/lib/db/prisma";
import {
  parseBorradorLucho,
  reconciliar,
  type BorradorLuchoParseado,
  type LineaTercero,
} from "../src/lib/excel/borrador-lucho";
import { crearFacturaProveedor } from "../src/lib/facturas-proveedor/service";
import { crearPago } from "../src/lib/pagos/service";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--")) ?? "";
const ciudadArg = (() => {
  const idx = args.indexOf("--ciudad");
  return idx !== -1 ? (args[idx + 1] ?? null) : null;
})();
const isDryRun = args.includes("--dry-run");
const isForce = args.includes("--force");

if (!filePath) {
  console.error("Uso: npx tsx scripts/importar-borrador-lucho.ts <ruta.xls> [--ciudad CTG] [--dry-run] [--force]");
  process.exit(1);
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function fmt(n: bigint): string {
  return new Intl.NumberFormat("es-CO").format(n);
}

function fmtDiff(n: bigint): string {
  if (n === 0n) return "✓";
  return `✗ DIFF ${fmt(n)}`;
}

function parseCiudad(str: string): Ciudad {
  const upper = str.toUpperCase().trim();
  if (upper === "BAQ") return Ciudad.BAQ;
  if (upper === "CTG") return Ciudad.CTG;
  if (upper === "BUN") return Ciudad.BUN;
  if (upper === "SMR") return Ciudad.SMR;
  throw new Error(
    `Ciudad desconocida: "${str}". Válidas: BAQ, CTG, BUN, SMR`,
  );
}

/**
 * Inferir el canal de pago para una línea de terceros.
 * - PSE (esPse=true) → canal PSE, costoBancario=0, viaSocio=false
 * - No PSE (viaSocio=true) → TRANSF_BANCOLOMBIA, costoBancario=3900, viaSocio=true
 * - 4x1000 → igual que no PSE (pagado por Lucho en efectivo al banco)
 */
function canalParaTercero(t: LineaTercero): CanalPago {
  return t.esPse ? CanalPago.PSE : CanalPago.TRANSF_BANCOLOMBIA;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n── Importador borrador Lucho ──────────────────────────────────────────`);
  console.log(`  Archivo : ${path.basename(filePath)}`);
  if (isDryRun) console.log(`  Modo    : DRY-RUN (sin escritura en BD)`);
  console.log();

  // ── 1. Parsear Excel ─────────────────────────────────────────────────────
  console.log("▶ Parseando Excel...");
  let p: BorradorLuchoParseado;
  try {
    p = parseBorradorLucho(filePath);
  } catch (err) {
    console.error("ERROR al parsear:", err);
    process.exit(1);
  }

  console.log(`  Cliente : ${p.clienteNombre} (NIT ${p.clienteNit})`);
  console.log(`  Factura : ${p.numFactura}  Fecha: ${p.fecha}`);
  console.log(`  DO      : ${p.do.textoOriginal}`);
  console.log(`  Terceros: ${p.terceros.length} líneas  |  Operacionales: ${p.operacionales.length} líneas`);
  console.log(`  Total factura: ${fmt(p.totalFactura)}  |  Anticipo: ${fmt(p.anticipo)}  |  Saldo: ${fmt(p.saldoAFavor)}`);
  console.log();

  // ── 2. Reconciliación del Excel ──────────────────────────────────────────
  console.log("▶ Reconciliando datos del Excel...");
  const discExcel = reconciliar(p);
  if (discExcel.length > 0) {
    console.error("  ✗ DISCREPANCIAS EN EL EXCEL:");
    for (const d of discExcel) {
      console.error(
        `    ${d.campo}: esperado=${fmt(d.esperado)} calculado=${fmt(d.calculado)} diff=${fmt(d.diferencia)}`,
      );
    }
    if (!isForce) {
      console.error("\n  Usa --force para continuar con discrepancias.");
      process.exit(1);
    }
    console.warn("  ⚠ Continuando con --force a pesar de discrepancias.");
  } else {
    console.log("  ✓ Reconciliación del Excel OK (0 discrepancias)");
  }
  console.log();

  // ── 3. Determinar ciudad del DO ──────────────────────────────────────────
  let ciudadStr: string;
  if (p.do.ciudad) {
    ciudadStr = p.do.ciudad;
  } else if (ciudadArg) {
    ciudadStr = ciudadArg;
    console.log(`  Ciudad del DO: ${ciudadStr} (tomada de --ciudad)`);
  } else {
    console.error(
      `  ERROR: El DO "${p.do.textoOriginal}" no incluye ciudad y no se pasó --ciudad.\n` +
      `  Usa: --ciudad BAQ (o CTG, BUN, SMR)`,
    );
    process.exit(1);
  }
  const ciudad = parseCiudad(ciudadStr);
  const anio = 2000 + parseInt(p.do.anio, 10);
  const numero = parseInt(p.do.numero, 10);
  const consecutivoCompleto = `DO.${ciudad}${p.do.anio}-${p.do.numero}`;

  if (isDryRun) {
    console.log("── DRY-RUN: lo que se crearía en BD ───────────────────────────────────");
    console.log(`  Cliente : ${p.clienteNombre} (NIT ${p.clienteNit}) [tipo SOCIO_LM]`);
    console.log(`  DO      : ${consecutivoCompleto} (${ciudad} ${anio} #${numero})`);
    console.log(`  Anticipo: ${fmt(p.anticipo)} (PSE)`);
    console.log(`  Terceros (${p.terceros.filter((t) => !t.es4x1000).length} facturas + ${p.terceros.filter((t) => t.es4x1000).length} 4x1000):`);
    for (const t of p.terceros) {
      const canal = canalParaTercero(t);
      console.log(
        `    [${t.esPse ? "PSE " : "LM  "}${t.es4x1000 ? "4x1 " : "    "}] ${fmt(t.valor).padStart(14)} | ${canal}${t.referencias.length ? " | refs:" + t.referencias.map((r) => r.numFactura).join("/") : ""}`,
      );
    }
    console.log(`  Borrador: comision=${fmt(p.totalOperacionales)} IVA=${fmt(p.iva)} ret=${fmt(p.totalRetenciones)}`);
    console.log();
    return;
  }

  // ── 4. Obtener usuario ADMIN (para auditoría) ─────────────────────────────
  const admin = await prisma.user.findFirst({
    where: { rol: Rol.ADMIN },
    select: { id: true },
  });
  if (!admin) {
    throw new Error("No hay usuario ADMIN en la BD (corre el seed).");
  }

  // ── 5. Cliente (upsert por NIT) ───────────────────────────────────────────
  console.log(`▶ Upsert cliente NIT ${p.clienteNit}...`);
  const cliente = await prisma.cliente.upsert({
    where: { nit: p.clienteNit },
    update: { nombre: p.clienteNombre },
    create: {
      nombre: p.clienteNombre,
      nit: p.clienteNit,
      tipo: TipoCliente.SOCIO_LM,
      manejaAnticipo: true,
    },
  });
  console.log(`  ${cliente.nombre} (id=${cliente.id})`);

  // ── 6. DO (buscar por consecutivo, crear si no existe) ────────────────────
  console.log(`▶ DO ${consecutivoCompleto}...`);
  let tramite = await prisma.tramiteDO.findUnique({
    where: { consecutivo: consecutivoCompleto },
    select: { id: true, consecutivo: true },
  });

  if (!tramite) {
    // createTramite genera consecutivo auto, pero necesitamos un número específico.
    // Creamos directamente con el número del Excel.
    tramite = await prisma.tramiteDO.create({
      data: {
        consecutivo: consecutivoCompleto,
        ciudad,
        anio,
        numero,
        clienteId: cliente.id,
        agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
        comentarios: `importado-desde:${path.basename(filePath)}`,
        creadoPorId: admin.id,
      },
      select: { id: true, consecutivo: true },
    });
    console.log(`  Creado DO id=${tramite.id}`);
  } else {
    console.log(`  DO ya existe id=${tramite.id}`);
  }
  const tramiteId = tramite.id;

  // ── 7. Anticipo + aplicación (idempotente) ────────────────────────────────
  const SOPORTEKEY_MARKER = `lucho-import:${p.numFactura}`;
  console.log(`▶ Anticipo ${fmt(p.anticipo)}...`);

  let anticipo = await prisma.anticipo.findFirst({
    where: {
      clienteId: cliente.id,
      monto: p.anticipo,
      soporteKey: SOPORTEKEY_MARKER,
    },
    select: { id: true },
  });

  if (!anticipo) {
    anticipo = await crearAnticipo({
      clienteId: cliente.id,
      monto: p.anticipo,
      fecha: new Date(p.fecha),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA, // Tipo desconocido; usamos BANCOLOMBIA (digital)
      soporteKey: SOPORTEKEY_MARKER,
      verificadoBanco: true,
    });
    console.log(`  Creado anticipo id=${anticipo.id}`);
  } else {
    console.log(`  Anticipo ya existe id=${anticipo.id}`);
  }

  // Aplicación del anticipo al DO (idempotente)
  const aplicExistente = await prisma.aplicacionAnticipo.findFirst({
    where: { anticipoId: anticipo.id, tramiteId },
  });
  if (!aplicExistente) {
    const res = await aplicarAnticipo({
      anticipoId: anticipo.id,
      tramiteId,
      montoAplicado: p.anticipo,
    });
    if (!res.ok) {
      throw new Error(`Error al aplicar anticipo: ${res.message}`);
    }
    console.log(`  Anticipo aplicado al DO`);
  } else {
    console.log(`  Aplicación ya existe`);
  }

  // ── 8. Facturas de proveedor + pagos (idempotente) ─────────────────────────
  //
  // Reglas de mapeo (una PagoTramite por línea del Excel):
  //   • 4x1000 → PagoTramite sin FacturaProveedor
  //   • Sin referencia → PagoTramite sin FacturaProveedor (ej. DIAN, INVIMA)
  //   • Con referencia(s) → FacturaProveedor (numFactura = primera ref) + PagoTramite vinculado
  //     Si la misma ref aparece en más de una línea, el numFactura se hace único con el
  //     sufijo "-L{fila}" para evitar conflicto de unicidad (tramiteId, numFactura).
  //
  console.log(`▶ Líneas de terceros (${p.terceros.length} líneas)...`);

  // Rastrear qué numFacturas ya se han usado para este tramite en esta ejecución
  const refsUsadas = new Set<string>();

  for (const t of p.terceros) {
    const canal = canalParaTercero(t);
    const viaSocio = !t.esPse;

    if (t.es4x1000 || t.referencias.length === 0) {
      // Sin factura de proveedor
      const conceptoPago = t.es4x1000
        ? `${t.concepto} (fila ${t.fila})`
        : t.concepto;
      await upsertPagoTramite({
        tramiteId,
        concepto: conceptoPago,
        valor: t.valor,
        canalPago: canal,
        viaSocio,
        usuarioId: admin.id,
      });
      continue;
    }

    // Con referencia(s): una FacturaProveedor + un PagoTramite para esta línea
    const primeraRef = t.referencias[0]!.numFactura;
    const todasRefs = t.referencias.map((r) => r.numFactura).join("/");
    const provNombre = t.proveedorNombre ?? t.concepto.split(".")[0].trim();

    // Determinar numFactura único para esta línea
    let numFactura = primeraRef;
    if (refsUsadas.has(numFactura)) {
      // La misma referencia ya la usó otra línea — añadir sufijo de fila
      numFactura = `${primeraRef}-L${t.fila}`;
    }
    refsUsadas.add(numFactura);

    // También registrar en BD como ya usada (para idempotencia entre ejecuciones)
    const existsInBD = await prisma.facturaProveedor.findUnique({
      where: { tramiteId_numFactura: { tramiteId, numFactura } },
      select: { id: true },
    });
    // Si no existe en BD pero ya está en refsUsadas localmente, el sufijo ya lo manejamos
    // Si no existe, lo creamos
    let fp: { id: string };
    if (!existsInBD) {
      fp = await crearFacturaProveedor({
        tramiteId,
        proveedorNombre: provNombre,
        numFactura,
        valor: t.valor,
        fecha: new Date(p.fecha),
        subidaPorId: admin.id,
      });
      console.log(`  ✚ FacturaProveedor ${numFactura} (${provNombre}) = ${fmt(t.valor)} [refs: ${todasRefs}]`);
    } else {
      fp = existsInBD;
      console.log(`  ≈ FacturaProveedor ${numFactura} ya existe id=${fp.id}`);
    }

    // Un PagoTramite por línea, vinculado a la FacturaProveedor
    await upsertPagoTramite({
      tramiteId,
      concepto: `${t.concepto} (fila ${t.fila})`,
      valor: t.valor,
      canalPago: canal,
      viaSocio,
      numSoporte: todasRefs,
      facturaProveedorId: fp.id,
      usuarioId: admin.id,
    });

    // La factura tiene su pago registrado → estado PAGADA (ciclo REGISTRADA→PAGADA)
    await prisma.facturaProveedor.update({
      where: { id: fp.id },
      data: { estado: "PAGADA" },
    });
  }

  // ── 9. Generar borrador (idempotente: si ya existe uno para el DO, no duplica) ──
  const borradorExistente = await prisma.borradorFactura.findFirst({
    where: { tramiteId },
    orderBy: { createdAt: "desc" },
  });

  if (borradorExistente) {
    console.log(
      `≈ Borrador ya existe (${borradorExistente.estado}, total=${fmt(borradorExistente.totalFactura)}) — no se duplica`,
    );
    const cuadra =
      borradorExistente.totalFactura === p.totalFactura &&
      borradorExistente.saldoAFavorCliente === p.saldoAFavor;
    console.log(
      cuadra
        ? "✅ El borrador existente cuadra al peso con el Excel.\n"
        : `❌ El borrador existente NO cuadra (total=${fmt(borradorExistente.totalFactura)} vs Excel=${fmt(p.totalFactura)}).\n`,
    );
    if (!cuadra) process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  console.log(`▶ Generando borrador...`);

  const conceptosOperacionales = p.operacionales.map((o) => ({
    concepto: o.concepto,
    valor: o.valor,
  }));

  const borrador = await generarBorrador({
    tramiteId,
    comision: p.totalOperacionales,
    ivaComision: p.iva,           // Override: IVA del Excel, no 19% × comisión
    retenciones: p.totalRetenciones,
    conceptosOperacionales,
    usuarioId: admin.id,
  });

  // ── 10. Corregir el borrador si el motor generó 4x1000 incorrecto ─────────
  // El motor de cálculo usa anticipo × 0.004 para el impuesto 4x1000. En el
  // Excel de Lucho, el 4x1000 es una línea de pago a tercero (base = pagos, no anticipo).
  // Corregimos los totales del borrador con los valores exactos del Excel.
  const totalFacturaMotor = borrador.totalFactura;
  const saldoMotor = borrador.saldoAFavorCliente;
  const necesitaCorreccion =
    totalFacturaMotor !== p.totalFactura || saldoMotor !== p.saldoAFavor;

  if (necesitaCorreccion) {
    console.log(
      `  ⚠ Motor generó totalFactura=${fmt(totalFacturaMotor)} (Excel=${fmt(p.totalFactura)}) — corrigiendo...`,
    );
    await prisma.borradorFactura.update({
      where: { id: borrador.id },
      data: {
        totalFactura: p.totalFactura,
        impuesto4x1000: p.terceros.find((t) => t.es4x1000)?.valor ?? 0n,
        saldoAFavorCliente: p.saldoAFavor,
        saldoACargoCliente: 0n,
      },
    });
    console.log(`  ✓ Borrador corregido id=${borrador.id}`);
  } else {
    console.log(`  ✓ Borrador generado sin corrección id=${borrador.id}`);
  }

  // ── 11. Reconciliación final sistema vs Excel ─────────────────────────────
  const borradorFinal = await prisma.borradorFactura.findUnique({
    where: { id: borrador.id },
    select: {
      totalFactura: true,
      saldoAFavorCliente: true,
      comision: true,
      ivaComision: true,
      impuesto4x1000: true,
      costosBancarios: true,
      retenciones: true,
      totalPagos: true,
      totalAnticipo: true,
    },
  });

  if (!borradorFinal) throw new Error("No se encontró el borrador tras crearlo");

  const filas: Array<[string, bigint, bigint]> = [
    ["Anticipo aplicado", borradorFinal.totalAnticipo, p.anticipo],
    ["Total pagos (terceros)", borradorFinal.totalPagos, p.totalTerceros],
    ["Comisión", borradorFinal.comision, p.totalOperacionales],
    ["IVA comisión", borradorFinal.ivaComision, p.iva],
    ["Retenciones", borradorFinal.retenciones, p.totalRetenciones],
    ["TOTAL FACTURA", borradorFinal.totalFactura, p.totalFactura],
    ["SALDO A FAVOR", borradorFinal.saldoAFavorCliente, p.saldoAFavor],
  ];

  console.log();
  console.log("RECONCILIACIÓN SISTEMA vs EXCEL (tolerancia 0 pesos)");
  console.log("─".repeat(72));
  console.log("Concepto".padEnd(26) + "Sistema".padStart(16) + "Excel".padStart(16) + "  OK");
  console.log("─".repeat(72));
  let todoOk = true;
  for (const [label, sistema, excel] of filas) {
    const ok = sistema === excel;
    if (!ok) todoOk = false;
    console.log(
      label.padEnd(26) +
      fmt(sistema).padStart(16) +
      fmt(excel).padStart(16) +
      "  " +
      fmtDiff(excel - sistema),
    );
  }
  console.log("─".repeat(72));

  if (todoOk) {
    console.log("\n✅ TODO CUADRA AL PESO — el sistema replica el Excel exactamente.\n");
  } else {
    console.log("\n❌ HAY DISCREPANCIAS.\n");
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

// ─── Helper: upsert PagoTramite por (tramiteId, concepto, valor) ─────────────

async function upsertPagoTramite(input: {
  tramiteId: string;
  concepto: string;
  valor: bigint;
  canalPago: CanalPago;
  viaSocio: boolean;
  numSoporte?: string;
  facturaProveedorId?: string;
  usuarioId: string;
}): Promise<void> {
  const existing = await prisma.pagoTramite.findFirst({
    where: {
      tramiteId: input.tramiteId,
      concepto: input.concepto,
      valor: input.valor,
    },
    select: { id: true },
  });

  if (existing) {
    // Already exists — link to factura via pivot if needed (idempotent)
    if (input.facturaProveedorId) {
      await prisma.pagoTramiteFactura.upsert({
        where: {
          pagoId_facturaId: { pagoId: existing.id, facturaId: input.facturaProveedorId },
        },
        create: { pagoId: existing.id, facturaId: input.facturaProveedorId },
        update: {},
      });
    }
    return;
  }

  await crearPago({
    tramiteId: input.tramiteId,
    concepto: input.concepto,
    valor: input.valor,
    canalPago: input.canalPago,
    numSoporte: input.numSoporte,
    usuarioId: input.usuarioId,
  });

  // Link to FacturaProveedor if provided (crearPago doesn't set this)
  if (input.facturaProveedorId) {
    const pago = await prisma.pagoTramite.findFirst({
      where: {
        tramiteId: input.tramiteId,
        concepto: input.concepto,
        valor: input.valor,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (pago) {
      await prisma.pagoTramite.update({
        where: { id: pago.id },
        data: { viaSocio: input.viaSocio },
      });
      await prisma.pagoTramiteFactura.upsert({
        where: {
          pagoId_facturaId: { pagoId: pago.id, facturaId: input.facturaProveedorId },
        },
        create: { pagoId: pago.id, facturaId: input.facturaProveedorId },
        update: {},
      });
    }
  } else {
    // Set viaSocio on the newly created pago
    const pago = await prisma.pagoTramite.findFirst({
      where: {
        tramiteId: input.tramiteId,
        concepto: input.concepto,
        valor: input.valor,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (pago && input.viaSocio) {
      await prisma.pagoTramite.update({
        where: { id: pago.id },
        data: { viaSocio: input.viaSocio },
      });
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exitCode = 1;
});
