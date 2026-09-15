/**
 * Demo del tarifario y los eventos (M2 + M3) con las empresas de la reunión.
 *
 *   npx tsx scripts/demo-tarifario.ts             # configura y muestra la propuesta
 *   npx tsx scripts/demo-tarifario.ts --limpiar   # retira lo que este script creó
 *
 * Qué hace (idempotente):
 *   1. Carga los conceptos de venta demo como productos Siigo SOLO si el
 *      código no existe (ids `demo-siigo-<codigo>`; el sync real los pisa por
 *      código, así que en producción no chocan).
 *   2. Enciende `tarifario_propio` y `eventos_facturables` en LITOPLAS S.A. y en
 *      CW (más `base_cif` en CW), como quedó en la reunión.
 *   3. Crea y publica los tarifarios desde las plantillas transcritas de las
 *      propuestas 2026 (Litoplas importaciones, clasificación y exportaciones;
 *      CW ASIA), salvo que ya exista uno de esa plantilla.
 *   4. Toma el trámite de Litoplas más reciente, le pone base de cálculo
 *      (3 declaraciones, contenedor de 20′) y marca "revisión en despacho" y
 *      "elaboración de registro", y muestra lo que el tarifario propone.
 *
 * Nunca toca NITs, tipos ni trámites que no sean el del ejemplo. Requiere la
 * migración 20260910120000_tarifario_eventos aplicada.
 */

import "dotenv/config";

import type { CodigoCapacidad } from "../src/lib/capacidades/catalogo";
import { setCapacidadesEmpresa } from "../src/lib/capacidades/service";
import { prisma } from "../src/lib/db/prisma";
import { marcarEventosTramite } from "../src/lib/eventos/service";
import { CONCEPTOS_VENTA_DEMO, PLANTILLAS_TARIFARIO } from "../src/lib/tarifas/plantillas";
import { cambiarEstadoTarifario, crearTarifario, propuestaParaTramite } from "../src/lib/tarifas/service";

const MARCA = "[DEMO TARIFARIO]";
const PREFIJO_SIIGO_DEMO = "demo-siigo-";

const ok = (t: string) => console.log(`    ✓ ${t}`);
const aviso = (t: string) => console.log(`    ⚠ ${t}`);
const nota = (t: string) => console.log(`      ${t}`);
function titulo(t: string) {
  console.log(`\n${"─".repeat(78)}\n${t}\n${"─".repeat(78)}`);
}
const cop = (v: bigint) => `$ ${v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

async function usuarioAdmin(): Promise<string> {
  const camila = await prisma.user.findFirst({ where: { email: "camila@galcomex.com" }, select: { id: true } });
  if (camila) return camila.id;
  const admin = await prisma.user.findFirst({ where: { rol: "ADMIN" }, select: { id: true } });
  if (!admin) throw new Error("No hay ningún ADMIN en la BD: corre npm run db:seed primero");
  return admin.id;
}

function esDePrueba(nombre: string, nit: string): boolean {
  const n = nombre.toUpperCase();
  return n.startsWith("DEMO") || nit.startsWith("DEMO-") || nit.startsWith("REPLICA-") || nit.startsWith("vitest-");
}

async function localizar(claves: string[], excluir: string[] = []): Promise<{ id: string; nombre: string } | null> {
  const todas = await prisma.cliente.findMany({ select: { id: true, nombre: true, nit: true } });
  const hit = todas.filter((c) => {
    if (esDePrueba(c.nombre, c.nit)) return false;
    const bajo = c.nombre.toLowerCase();
    if (excluir.some((x) => bajo.includes(x))) return false;
    return claves.some((k) => bajo.includes(k));
  });
  if (hit.length !== 1) {
    aviso(`${claves.join("/")}: ${hit.length === 0 ? "no existe" : `ambigua (${hit.map((h) => h.nombre).join(", ")})`}`);
    return null;
  }
  return hit[0]!;
}

// ─── Limpieza ─────────────────────────────────────────────────────────────────

async function limpiar() {
  titulo("Limpiando lo que creó el demo");
  const tarifarios = await prisma.tarifario.findMany({ where: { notas: { contains: MARCA } }, select: { id: true, nombre: true } });
  for (const t of tarifarios) {
    await prisma.borradorFactura.updateMany({ where: { tarifarioId: t.id }, data: { tarifarioId: null } });
    await prisma.tarifario.delete({ where: { id: t.id } });
    ok(`tarifario "${t.nombre}" eliminado`);
  }
  const eventos = await prisma.tramiteEvento.findMany({ where: { observacion: MARCA }, select: { id: true, tramiteId: true } });
  for (const e of eventos) await prisma.tramiteEvento.delete({ where: { id: e.id } });
  if (eventos.length) ok(`${eventos.length} eventos de ejemplo desmarcados`);
  const siigo = await prisma.siigoProducto.deleteMany({ where: { id: { startsWith: PREFIJO_SIIGO_DEMO } } });
  if (siigo.count) ok(`${siigo.count} productos Siigo demo retirados`);
  nota("Las funciones encendidas en las fichas se dejan como están (se apagan desde la pestaña Funciones).");
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--limpiar")) {
    await limpiar();
    return;
  }

  const usuarioId = await usuarioAdmin();

  titulo("1. Conceptos de venta como productos Siigo (solo si no existen)");
  let creados = 0;
  for (const c of CONCEPTOS_VENTA_DEMO) {
    const existe = await prisma.siigoProducto.findUnique({ where: { codigo: c.siigoCodigo }, select: { id: true } });
    if (existe) continue;
    await prisma.siigoProducto.create({
      data: {
        id: `${PREFIJO_SIIGO_DEMO}${c.siigoCodigo}`,
        codigo: c.siigoCodigo,
        nombre: c.nombreSiigo,
        tipo: "Product",
        activo: true,
        grupoContableId: 0,
        grupoContableNombre: c.iva ? "Servicios (demo)" : "Servicios Ingresos Excluido (demo)",
        clasificacionIva: c.iva ? "Taxed" : "Excluded",
      },
    });
    creados++;
  }
  ok(`${creados} productos creados · ${CONCEPTOS_VENTA_DEMO.filter((c) => c.confirmar).length} códigos marcados "confirmar con Camila"`);

  titulo("2. Funciones por empresa");
  const litoplas = await localizar(["litoplas"]);
  // El cliente es CW ASIA SAS (NIT 900775062-7); CW Express es su transportador.
  const cw = await localizar(["cw asia"]);
  const polyrecZf = await localizar(["polyrec zona franca", "polired zona franca"]);
  const empresas = [
    { empresa: litoplas, etiqueta: "LITOPLAS", capacidades: ["tarifario_propio", "eventos_facturables"] as CodigoCapacidad[], plantillas: ["LITOPLAS_IMPO_2026", "LITOPLAS_CLAS_2026", "LITOPLAS_EXPO_2026"] },
    { empresa: cw, etiqueta: "CW ASIA", capacidades: ["tarifario_propio", "eventos_facturables", "base_cif"] as CodigoCapacidad[], plantillas: ["CW_ASIA_2026"] },
    { empresa: polyrecZf, etiqueta: "POLYREC ZF", capacidades: ["tarifario_propio"] as CodigoCapacidad[], plantillas: ["POLYREC_ZF_2026"] },
  ];
  for (const e of empresas) {
    if (!e.empresa) continue;
    await setCapacidadesEmpresa({
      empresaId: e.empresa.id,
      cambios: e.capacidades.map((codigo) => ({ codigo, habilitado: true })),
      usuarioId,
    });
    ok(`${e.empresa.nombre}: ${e.capacidades.join(", ")} encendidas`);
  }

  titulo("3. Tarifarios desde las propuestas 2026");
  for (const e of empresas) {
    if (!e.empresa) continue;
    for (const codigo of e.plantillas) {
      const plantilla = PLANTILLAS_TARIFARIO.find((p) => p.codigo === codigo)!;
      const marcaPlantilla = `${MARCA} ${codigo}`;
      const ya = await prisma.tarifario.findFirst({ where: { empresaId: e.empresa.id, notas: { contains: marcaPlantilla } }, select: { id: true, estado: true, version: true } });
      if (ya) {
        nota(`${e.etiqueta} · ${plantilla.nombre}: ya existe (v${ya.version}, ${ya.estado})`);
        continue;
      }
      const creado = await crearTarifario({
        empresaId: e.empresa.id,
        plantilla: codigo,
        vigenteDesde: codigo.startsWith("CW") ? new Date("2026-03-11T00:00:00.000Z") : codigo.startsWith("POLYREC") ? new Date("2026-01-01T00:00:00.000Z") : new Date("2026-02-02T00:00:00.000Z"),
        vigenteHasta: codigo.startsWith("CW") ? new Date("2027-03-10T00:00:00.000Z") : codigo.startsWith("POLYREC") ? new Date("2026-12-31T00:00:00.000Z") : new Date("2027-01-31T00:00:00.000Z"),
        notas: `${marcaPlantilla} · ${plantilla.fuente}`,
        items: [],
        usuarioId,
      });
      await cambiarEstadoTarifario(creado.id, "VIGENTE", usuarioId);
      ok(`${e.etiqueta} · ${plantilla.nombre}: v${creado.version} publicada con ${creado.items.length} ítems`);
    }
  }

  titulo("4. Ejemplo: un trámite de Litoplas con base de cálculo y eventos");
  if (!litoplas) {
    aviso("Sin Litoplas no hay ejemplo.");
    return;
  }
  const tramite = await prisma.tramiteDO.findFirst({
    where: { clienteId: litoplas.id, tipoTramiteCodigo: "IMPORTACION", estado: { notIn: ["CERRADO"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, consecutivo: true, estado: true },
  });
  if (!tramite) {
    aviso("Litoplas no tiene trámites de importación abiertos para el ejemplo.");
    return;
  }
  await prisma.tramiteDO.update({
    where: { id: tramite.id },
    data: { numDeclaraciones: 3, tipoCarga: "CONTENEDOR_20", numContenedores: 1, numDocumentos: 4 },
  });
  await marcarEventosTramite({
    tramiteId: tramite.id,
    usuarioId,
    eventos: [
      { codigo: "REVISION_DESPACHO", cantidad: 1, observacion: MARCA },
      { codigo: "ELABORACION_REGISTRO", cantidad: 1, observacion: MARCA },
    ],
  });
  ok(`${tramite.consecutivo} (${tramite.estado}): 3 declaraciones, contenedor de 20′, revisión en despacho + registro elaborado`);

  const propuesta = await propuestaParaTramite(tramite.id);
  if (!propuesta.resultado) {
    aviso(propuesta.motivo ?? "sin propuesta");
    return;
  }
  nota(`Tarifario: ${propuesta.tarifario?.nombre} v${propuesta.tarifario?.version}`);
  for (const l of propuesta.resultado.lineas) {
    nota(`${l.nombrePublico.padEnd(58)} ${cop(l.valor).padStart(14)}   ${l.origen === "EVENTO" ? "(evento)" : ""} ${l.detalle}`);
  }
  nota(`${"Total conceptos".padEnd(58)} ${cop(propuesta.resultado.total).padStart(14)}`);
  nota(`${"Con IVA".padEnd(58)} ${cop(propuesta.resultado.totalConIva).padStart(14)}`);
  if (propuesta.resultado.pendientes.length) {
    aviso(`Pendientes: ${propuesta.resultado.pendientes.map((p) => `${p.nombrePublico} — ${p.motivo}`).join("; ")}`);
  }
  const checklist = await prisma.checklistItem.findMany({ where: { tramiteId: tramite.id, recibido: false }, select: { descripcion: true } });
  nota(`Checklist pendiente ahora: ${checklist.map((c) => c.descripcion).join(" · ") || "nada"}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
