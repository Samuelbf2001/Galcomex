/**
 * Conciliación de la cartera de proveedores con el Excel MAESTRO de Camila
 * (CxP v2, diseño §E, paquete P7b). Lógica en `src/lib/cxp/conciliacion.ts`.
 *
 *   npx tsx scripts/cxp/conciliar-excel.ts \
 *     --archivo "CARTERA ALMACARGA.xlsx" --nit 800154017-8 \
 *     --archivo "CARTERA EXPRESS.xlsx"   --nit 802011826-3 \
 *     --usuario-email camila@galcomex.com \
 *     [--modo simulacro|aplicar] [--aplicar] [--canal TRANSF_BANCOLOMBIA] \
 *     [--salida conciliacion-cxp-2026-09-25.md] \
 *     [--enlazar-previos <pagoId,pagoId>] [--ignorar-previos <pagoId,pagoId>] \
 *     [--importar-historico --concepto-historico "ALMACENAJE"]
 *
 * SIMULACRO (por defecto): no escribe nada. Imprime el resumen y guarda el
 * reporte Markdown (`--salida`) y el CSV al lado (mismo nombre, `.csv`), con
 * el TOTAL exacto del Excel (centavos) de cada fila.
 *
 * APLICAR: exige `--modo aplicar` **y** `--aplicar` (una sola de las dos solo
 * simula y lo avisa). Registra un pago en bloque HISTÓRICO por fecha de PAGO
 * (costo $0, lo asume Galcomex, sin comprobante), idempotente: una segunda
 * corrida no crea nada. Los pagos previos sin enlazar NUNCA se pagan: se
 * enlazan solo los que se pasen por id en `--enlazar-previos`. Al terminar sin
 * errores y sin filas "pagada en el Excel con saldo en el sistema", apaga
 * `conciliacionPendiente` de las fichas de ese NIT.
 *
 * Solo ADMIN (`--usuario-email`). La base es la de `DATABASE_URL`: el script
 * imprime a cuál se conecta (sin la clave) antes de hacer nada.
 */

import "dotenv/config";

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { CanalPago } from "@prisma/client";
import * as XLSX from "xlsx";

import {
  conciliarProveedor,
  encabezadoCsv,
  type ErrorLectura,
  type FilaCartera,
  type InformeConciliacionProveedor,
  leerHojaCartera,
} from "../../src/lib/cxp/conciliacion";
import { nitBaseDe } from "../../src/lib/cxp/saldos";
import { prisma } from "../../src/lib/db/prisma";

interface Par {
  ruta: string;
  nit: string;
}

function valoresDe(bandera: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === bandera && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]);
  });
  return out;
}

function valorDe(bandera: string): string | null {
  return valoresDe(bandera)[0] ?? null;
}

function listaDe(bandera: string): string[] {
  return valoresDe(bandera)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function paresArchivoNit(): Par[] {
  const pares: Par[] = [];
  let ruta: string | null = null;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--archivo") ruta = process.argv[++i] ?? null;
    else if (a === "--nit") {
      const nit = process.argv[++i];
      if (!ruta || !nit) throw new Error("Cada --nit va después de su --archivo.");
      pares.push({ ruta, nit });
      ruta = null;
    }
  }
  if (ruta) throw new Error(`Falta --nit para ${ruta}.`);
  return pares;
}

function leerArchivo(ruta: string): { filas: FilaCartera[]; errores: ErrorLectura[] } {
  const archivo = basename(ruta);
  const wb = XLSX.read(readFileSync(ruta), { type: "buffer", cellDates: false });
  for (const nombre of wb.SheetNames) {
    const filasCrudas = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[nombre], { header: 1, raw: true, defval: "" });
    const r = leerHojaCartera(filasCrudas, archivo);
    if (r.filas.length > 0 || r.errores.some((e) => e.fila > 0)) return r;
  }
  return { filas: [], errores: [{ archivo, fila: 0, motivo: "Ninguna hoja tiene el encabezado FACTURA | PROVEEDOR | DO | FECHA | TOTAL | PAGO." }] };
}

function baseDeDatos(): string {
  const url = process.env.DATABASE_URL ?? "";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return "(DATABASE_URL no definida o ilegible)";
  }
}

function lineaResumen(inf: InformeConciliacionProveedor): string {
  const c = inf.antes.conteo;
  const partes = Object.entries(c)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return `${inf.nombreProveedor} (${inf.nitBase}) — ${partes.join(" · ")}`;
}

async function main() {
  const pares = paresArchivoNit();
  if (pares.length === 0) {
    throw new Error('Uso: --archivo "CARTERA X.xlsx" --nit 800154017-8 [--archivo … --nit …] --usuario-email admin@…');
  }
  const email = valorDe("--usuario-email");
  if (!email) throw new Error("Falta --usuario-email (un usuario ADMIN).");
  const modoPedido = valorDe("--modo") ?? "simulacro";
  if (modoPedido !== "simulacro" && modoPedido !== "aplicar") throw new Error("--modo debe ser simulacro o aplicar.");
  const confirmado = process.argv.includes("--aplicar");
  const modo: "simulacro" | "aplicar" = modoPedido === "aplicar" && confirmado ? "aplicar" : "simulacro";
  const canalTexto = valorDe("--canal") ?? "TRANSF_BANCOLOMBIA";
  if (!(canalTexto in CanalPago)) throw new Error(`Canal desconocido: ${canalTexto}.`);
  const canal = CanalPago[canalTexto as keyof typeof CanalPago];
  const importar = process.argv.includes("--importar-historico");
  const conceptoHistorico = valorDe("--concepto-historico");
  if (importar && !conceptoHistorico) {
    throw new Error('--importar-historico exige --concepto-historico (p. ej. "ALMACENAJE"): es el texto de la línea de terceros.');
  }
  const hoy = new Date().toISOString().slice(0, 10);
  const salida = valorDe("--salida") ?? `conciliacion-cxp-${hoy}.md`;

  console.log(`Base de datos: ${baseDeDatos()}`);
  console.log(`Modo: ${modo.toUpperCase()}`);
  if (modoPedido === "aplicar" && !confirmado) {
    console.log("⚠ Pediste --modo aplicar sin --aplicar: se hace SOLO el simulacro. Revisa el reporte y repite con --aplicar.");
  }
  if (confirmado && modoPedido !== "aplicar") {
    console.log("⚠ --aplicar sin --modo aplicar: se hace SOLO el simulacro.");
  }

  const usuario = await prisma.user.findUnique({ where: { email }, select: { id: true, rol: true } });
  if (!usuario) throw new Error(`No existe el usuario ${email}.`);
  if (usuario.rol !== "ADMIN") throw new Error(`${email} no es ADMIN: la conciliación solo la corre un administrador.`);

  const informes: InformeConciliacionProveedor[] = [];
  let conErrores = false;
  for (const par of pares) {
    const nitBase = nitBaseDe(par.nit);
    if (!nitBase) throw new Error(`NIT ilegible: ${par.nit}.`);
    const { filas, errores } = leerArchivo(par.ruta);
    const inf = await conciliarProveedor({
      archivo: basename(par.ruta),
      filas,
      erroresLectura: errores,
      nitBase,
      modo,
      usuarioId: usuario.id,
      canal,
      enlazarPrevios: listaDe("--enlazar-previos"),
      ignorarPrevios: listaDe("--ignorar-previos"),
      importarHistorico: importar ? { concepto: conceptoHistorico! } : null,
    });
    informes.push(inf);
    console.log(lineaResumen(inf));
    for (const b of inf.plan.bloques) {
      const ej = inf.ejecucion?.bloques.find((x) => x.fechaPago === b.fechaPago);
      console.log(
        `  bloque ${b.fechaPago}: ${b.facturas.map((f) => `${f.numFactura}/${f.consecutivo}=${f.monto}`).join(", ")} total ${b.total}` +
          (ej ? (ej.ok ? ` → OK ${ej.grupoPagoId}${ej.repetido ? " (repetido)" : ""}` : ` → ERROR ${ej.error}`) : ""),
      );
    }
    if (inf.cifrasAntes) console.log(`  pendiente antes: ${inf.cifrasAntes.pendiente}`);
    if (inf.cifrasDespues) console.log(`  pendiente después: ${inf.cifrasDespues.pendiente}`);
    if (inf.ejecucion) {
      console.log(`  cambios escritos: ${inf.cambios} · cartera conciliada: ${inf.ejecucion.carteraMarcadaConciliada ? "sí" : `no (${inf.ejecucion.motivoNoMarcada})`}`);
      if (
        inf.ejecucion.bloques.some((b) => !b.ok) ||
        inf.ejecucion.enlaces.some((e) => !e.ok) ||
        inf.ejecucion.importaciones.some((m) => !m.ok)
      ) {
        conErrores = true;
      }
    }
  }

  const md = [
    `# Conciliación CxP con el Excel maestro — ${modo === "aplicar" ? "APLICADA" : "SIMULACRO"}`,
    "",
    `- Fecha: ${new Date().toISOString()}`,
    `- Base de datos: \`${baseDeDatos()}\``,
    `- Usuario: ${email}`,
    `- Canal de los pagos históricos: ${canal}`,
    modo === "simulacro" ? "- **No se escribió nada.** Para aplicar: `--modo aplicar --aplicar` (con el OK de Ernesto)." : "",
    "",
    ...informes.map((i) => i.markdown),
  ].join("\n");
  writeFileSync(salida, md, "utf8");
  const rutaCsv = salida.replace(/\.md$/i, "") + ".csv";
  writeFileSync(rutaCsv, "﻿" + [encabezadoCsv(), ...informes.flatMap((i) => i.csv)].join("\r\n") + "\r\n", "utf8");
  console.log(`Reporte: ${salida}`);
  console.log(`CSV: ${rutaCsv}`);
  if (conErrores) process.exitCode = 1;
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
