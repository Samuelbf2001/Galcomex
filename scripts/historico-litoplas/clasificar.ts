/**
 * Histórico Litoplas 2026 — PASO 1: clasificar en seco.
 *
 * Recorre las descargas de Drive (varias "partes" de un mismo árbol), reconoce
 * la carpeta de cada DO por su nombre (`DO.26-0107 IM036-26 ATF MOV-I26050290`),
 * decide la categoría de cada archivo con reglas por subcarpeta + nombre
 * (`reglas.ts`), detecta basura y duplicados (por huella SHA-256 dentro del
 * mismo DO) y escribe un MANIFIESTO: una fila por archivo con origen, destino
 * en el bucket, categoría, regla y acción. NO sube nada ni toca la base de datos.
 *
 * En palabras simples: es el inventario que Camila revisa antes de que se suba
 * algo, y el contrato que usa `importar.ts` después.
 *
 * Uso:
 *   npx tsx scripts/historico-litoplas/clasificar.ts
 *   npx tsx scripts/historico-litoplas/clasificar.ts --partes "D:\LITOPLAS-2026" --salida "C:\salida"
 *   npx tsx scripts/historico-litoplas/clasificar.ts --sin-hash      # rápido, sin detectar duplicados por contenido
 *
 * Salida (en --salida, por defecto <repo>/historico-litoplas-2026/):
 *   manifiesto.csv   una fila por archivo (separador ;)
 *   resumen-dos.csv  una fila por DO
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  RE_DO,
  claveDestino,
  clasificar,
  esBasura,
  parsearCarpetaDo,
  ramaDe,
  type FilaManifiesto,
} from "./reglas";

// ─── Argumentos ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const PARTES_POR_DEFECTO = [
  "LITOPLAS-20260916T021913Z-1-00",
  "LITOPLAS-20260916T021913Z-1-002",
  "LITOPLAS-20260916T021913Z-1-003",
  "LITOPLAS-20260916T021913Z-1-004",
  "LITOPLAS-20260916T021913Z-1-005",
  "LITOPLAS-20260916T021913Z-1-006",
].map((d) => path.join(process.env.USERPROFILE ?? "C:\\Users\\samue", "Downloads", d));

const partes = (opt("partes") ?? PARTES_POR_DEFECTO.join(";")).split(";").map((p) => p.trim()).filter(Boolean);
const salida = opt("salida") ?? path.resolve(process.cwd(), "..", "historico-litoplas-2026");
const sinHash = flag("sin-hash");
const anioHistorico = Number(opt("anio") ?? 2026);

// ─── Recorrido ───────────────────────────────────────────────────────────────

async function* caminar(dir: string): AsyncGenerator<{ ruta: string; bytes: number }> {
  const entradas = await readdir(dir, { withFileTypes: true });
  for (const e of entradas) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) yield* caminar(ruta);
    else if (e.isFile()) {
      const s = await stat(ruta);
      yield { ruta, bytes: s.size };
    }
  }
}

function sha256(ruta: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(ruta).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function csvCampo(v: string | number): string {
  const s = String(v ?? "");
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log("Histórico Litoplas 2026 — clasificación en seco");
  console.log(`  Partes : ${partes.length}`);
  for (const p of partes) console.log(`    - ${p}`);
  console.log(`  Salida : ${salida}`);
  console.log(`  Huella : ${sinHash ? "NO (sin detección de duplicados por contenido)" : "SHA-256"}`);
  console.log("");

  const filas: FilaManifiesto[] = [];
  const porDo = new Map<string, FilaManifiesto[]>();
  let vistos = 0;
  let bytesTotales = 0;

  for (const parte of partes) {
    let existe = false;
    try { existe = (await stat(parte)).isDirectory(); } catch { existe = false; }
    if (!existe) { console.log(`  ⚠ No existe: ${parte}`); continue; }

    for await (const { ruta, bytes } of caminar(parte)) {
      vistos += 1;
      bytesTotales += bytes;
      if (vistos % 500 === 0) process.stdout.write(`  … ${vistos} archivos\r`);

      const rel = path.relative(parte, ruta).split(path.sep);
      const nombre = rel[rel.length - 1];
      const ext = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase() : "";
      const idxDo = rel.findIndex((seg, i) => i < rel.length - 1 && RE_DO.test(seg));
      const base: FilaManifiesto = {
        rama: ramaDe(rel), carpetaDo: "", consecutivo: "", ciudad: "", numero: 0, im: "", mov: "", proveedor: "", oc: "",
        parte: path.basename(parte), rutaRelativa: rel.join("/"), nombre, ext, bytes, sha256: "",
        categoria: "", regla: "", destinoKey: "", accion: "OMITIR", nota: "",
      };

      const basura = esBasura(nombre, bytes);
      if (basura) { filas.push({ ...base, accion: "DESCARTAR", nota: basura }); continue; }

      if (idxDo < 0) { filas.push({ ...base, nota: "fuera de una carpeta de DO" }); continue; }

      const datos = parsearCarpetaDo(rel[idxDo], anioHistorico)!;
      const subcarpetas = rel.slice(idxDo + 1, rel.length - 1);
      const { categoria, regla } = clasificar(subcarpetas, nombre);
      const fila: FilaManifiesto = {
        ...base, carpetaDo: rel[idxDo], ...datos, categoria, regla,
        accion: datos.consecutivo ? "SUBIR" : "OMITIR",
        nota: datos.consecutivo ? "" : "DO en curso sin número (0XXX)",
      };
      if (fila.accion === "SUBIR" && !sinHash) fila.sha256 = await sha256(ruta);
      filas.push(fila);
      const lista = porDo.get(fila.carpetaDo) ?? [];
      lista.push(fila);
      porDo.set(fila.carpetaDo, lista);
    }
  }
  console.log(`  Recorridos ${vistos} archivos (${(bytesTotales / 1073741824).toFixed(2)} GB)`);

  // Duplicados (misma huella dentro del DO) y clave de destino.
  for (const [, lista] of porDo) {
    const porHuella = new Map<string, FilaManifiesto>();
    const usados = new Set<string>();
    for (const f of lista) {
      if (f.accion !== "SUBIR") continue;
      const huella = f.sha256 || `${f.bytes}:${f.nombre.toLowerCase()}`;
      const primero = porHuella.get(huella);
      if (primero) {
        f.accion = "DUPLICADO";
        f.destinoKey = primero.destinoKey;
        f.nota = `mismo contenido que ${primero.rutaRelativa}`;
        continue;
      }
      f.destinoKey = claveDestino(f.consecutivo, f.categoria, f.nombre, usados);
      porHuella.set(huella, f);
    }
  }

  // Orden de compra: del nombre de carpeta o del PDF `PO_OC38071_0.pdf`.
  const resumen: string[] = ["consecutivo;rama;carpeta_do;im;mov;proveedor;oc;archivos;subir;duplicados;descartar;omitir;bytes_subir;otro;tiene_factura_venta"];
  const dos = [...porDo.entries()].sort((a, b) => (a[1][0].consecutivo || a[0]).localeCompare(b[1][0].consecutivo || b[0]));
  let totSubir = 0, totBytes = 0, totDup = 0, totOtro = 0;
  for (const [carpeta, lista] of dos) {
    const p = lista[0];
    const subir = lista.filter((f) => f.accion === "SUBIR");
    const dup = lista.filter((f) => f.accion === "DUPLICADO").length;
    const desc = lista.filter((f) => f.accion === "DESCARTAR").length;
    const omit = lista.filter((f) => f.accion === "OMITIR").length;
    const bytes = subir.reduce((a, f) => a + f.bytes, 0);
    const otro = subir.filter((f) => f.categoria === "OTRO").length;
    const oc = lista.map((f) => f.nombre.match(/PO_OC(\d{5})|ORDEN DE COMPRA OC(\d{5})/i)).find(Boolean);
    const ocNum = p.oc || (oc ? `OC${oc[1] ?? oc[2]}` : "");
    for (const f of lista) f.oc = ocNum;
    const facturaVenta = lista.some((f) => /BAQ[ -]?1\d{4}/i.test(f.nombre));
    totSubir += subir.length; totBytes += bytes; totDup += dup; totOtro += otro;
    resumen.push([p.consecutivo, p.rama, carpeta, p.im, p.mov, p.proveedor, ocNum, lista.length, subir.length, dup, desc, omit, bytes, otro, facturaVenta ? "SI" : "NO"].map(csvCampo).join(";"));
  }

  const cab = "rama;carpeta_do;consecutivo;ciudad;numero;im;mov;proveedor;oc;parte;ruta_relativa;nombre;ext;bytes;sha256;categoria;regla;destino_key;accion;nota";
  const cuerpo = filas.map((f) => [f.rama, f.carpetaDo, f.consecutivo, f.ciudad, f.numero, f.im, f.mov, f.proveedor, f.oc, f.parte, f.rutaRelativa, f.nombre, f.ext, f.bytes, f.sha256, f.categoria, f.regla, f.destinoKey, f.accion, f.nota].map(csvCampo).join(";"));

  await mkdir(salida, { recursive: true });
  await writeFile(path.join(salida, "manifiesto.csv"), "\uFEFF" + [cab, ...cuerpo].join("\r\n"), "utf8");
  await writeFile(path.join(salida, "resumen-dos.csv"), "\uFEFF" + resumen.join("\r\n"), "utf8");

  const porCat = new Map<string, number>();
  for (const f of filas) if (f.accion === "SUBIR") porCat.set(f.categoria, (porCat.get(f.categoria) ?? 0) + 1);
  const conConsecutivo = dos.filter(([, l]) => l[0].consecutivo).length;

  console.log("");
  console.log(`DOs reconocidos : ${dos.length} (${conConsecutivo} con número, ${dos.length - conConsecutivo} en curso 0XXX)`);
  console.log(`A subir         : ${totSubir} archivos · ${(totBytes / 1073741824).toFixed(2)} GB`);
  console.log(`Duplicados      : ${totDup} (no se suben, quedan anotados)`);
  console.log(`Descartar       : ${filas.filter((f) => f.accion === "DESCARTAR").length} (basura)`);
  console.log(`Omitir          : ${filas.filter((f) => f.accion === "OMITIR").length} (fuera de DO o DO sin número)`);
  console.log(`En OTRO         : ${totOtro} (${totSubir ? Math.round((100 * totOtro) / totSubir) : 0} %) — para revisar desde Archivos`);
  console.log("Por categoría   :");
  for (const [c, n] of [...porCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${c.padEnd(22)} ${n}`);
  console.log("");
  console.log(`Manifiesto : ${path.join(salida, "manifiesto.csv")}`);
  console.log(`Resumen    : ${path.join(salida, "resumen-dos.csv")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
