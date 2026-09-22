/**
 * Histórico clientes 2026 — PASO 1: clasificar en seco.
 *
 * Recorre `Archivos clientes/<CLIENTE>/…` (la unión de los 9 ZIP de Drive del
 * 2026-09-21), reconoce la carpeta de cada DO, conserva las subcarpetas del
 * cliente, decide la categoría con reglas (`reglas.ts`) y escribe el
 * MANIFIESTO. NO sube nada ni toca la BD.
 *
 * Lo que YA se cargó en la primera entrega de Litoplas (manifiesto del
 * 2026-09-16) se marca `YA_CARGADO` y no se vuelve a tocar: la orden es
 * clasificar solo lo que no tiene categoría, no reclasificar lo hecho.
 *
 * Uso:
 *   npx tsx scripts/historico-clientes/clasificar.ts
 *   npx tsx scripts/historico-clientes/clasificar.ts --raiz "D:\Archivos clientes" --sin-hash
 *   npx tsx scripts/historico-clientes/clasificar.ts --solo-cliente "POLYREC ZF"
 *
 * Salida (por defecto <repo>/historico-clientes-2026/):
 *   manifiesto.csv   una fila por archivo (separador ;)
 *   resumen-dos.csv  una fila por DO
 *   resumen-clientes.csv
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { esBasura } from "../historico-litoplas/reglas";
import {
  CLIENTES,
  RE_DO,
  claveSuelta,
  claveTramite,
  clasificarArchivo,
  esBasuraExtra,
  parsearCarpeta,
  ramaDe,
  type FilaManifiesto,
} from "./reglas";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const raiz = opt("raiz") ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\samue", "Downloads", "Archivos clientes");
const salida = opt("salida") ?? path.resolve(process.cwd(), "..", "historico-clientes-2026");
const manifiestoLitoplas = opt("manifiesto-litoplas") ?? path.resolve(process.cwd(), "..", "historico-litoplas-2026", "manifiesto.csv");
const sinHash = flag("sin-hash");
const soloCliente = opt("solo-cliente");
/** `ia-manifiesto.csv` de clasificar-ia.ts: ruta;categoria;… — solo se aplica sobre lo que las reglas dejaron en OTRO. */
const overridesPath = opt("overrides") ?? path.join(salida, "ia-manifiesto.csv");

async function* caminar(dir: string): AsyncGenerator<{ ruta: string; bytes: number }> {
  const entradas = await readdir(dir, { withFileTypes: true });
  for (const e of entradas) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) yield* caminar(ruta);
    else if (e.isFile()) yield { ruta, bytes: (await stat(ruta)).size };
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

/** Parser mínimo del manifiesto de Litoplas (`;`, comillas dobles). */
function parsearCsv(texto: string): Record<string, string>[] {
  const lineas: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let enComillas = false;
  const t = texto.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (enComillas) {
      if (c === '"') { if (t[i + 1] === '"') { campo += '"'; i += 1; } else enComillas = false; } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ";") { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i += 1;
      fila.push(campo); campo = "";
      if (fila.length > 1 || fila[0] !== "") lineas.push(fila);
      fila = [];
    } else campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); lineas.push(fila); }
  const cab = lineas.shift() ?? [];
  return lineas.map((l) => Object.fromEntries(cab.map((k, i) => [k, l[i] ?? ""])));
}

export const CABECERA =
  "cliente;rama;carpeta_do;consecutivo;ciudad;anio;numero;referencia;im;mov;proveedor;oc;subcarpetas;ruta_relativa;nombre;ext;bytes;sha256;categoria;regla;destino_key;accion;nota";

export function filaACsv(f: FilaManifiesto): string {
  return [
    f.cliente, f.rama, f.carpetaDo, f.consecutivo, f.ciudad, f.anio, f.numero, f.referencia, f.im, f.mov, f.proveedor, f.oc,
    f.subcarpetas, f.rutaRelativa, f.nombre, f.ext, f.bytes, f.sha256, f.categoria, f.regla, f.destinoKey, f.accion, f.nota,
  ].map(csvCampo).join(";");
}

async function main() {
  console.log("Histórico clientes 2026 — clasificación en seco");
  console.log(`  Raíz   : ${raiz}`);
  console.log(`  Salida : ${salida}`);
  console.log(`  Huella : ${sinHash ? "NO" : "SHA-256"}`);

  // Lo que ya subió la primera entrega de Litoplas: (carpeta_do, nombre, bytes).
  const yaCargado = new Set<string>();
  try {
    for (const r of parsearCsv(await readFile(manifiestoLitoplas, "utf8"))) {
      yaCargado.add(`${r.carpeta_do.toLowerCase()}|${r.nombre.toLowerCase()}|${r.bytes}`);
    }
    console.log(`  Litoplas ya cargado: ${yaCargado.size} archivos del manifiesto anterior`);
  } catch {
    console.log("  ⚠ No se encontró el manifiesto anterior de Litoplas: no se marcará nada como YA_CARGADO");
  }
  // Decisiones de la IA para lo que quedó en OTRO (ruta → categoría).
  const overrides = new Map<string, { categoria: string; confianza: string }>();
  try {
    for (const r of parsearCsv(await readFile(overridesPath, "utf8"))) {
      if (r.categoria && r.categoria !== "OTRO") overrides.set(r.ruta, { categoria: r.categoria, confianza: r.confianza });
    }
    console.log(`  IA: ${overrides.size} decisiones de ${path.basename(overridesPath)}`);
  } catch {
    console.log("  IA: sin archivo de decisiones (todo OTRO queda OTRO)");
  }
  console.log("");

  const clientes = (await readdir(raiz, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const filas: FilaManifiesto[] = [];
  const porDo = new Map<string, FilaManifiesto[]>();
  let vistos = 0;

  for (const cliente of clientes) {
    if (soloCliente && cliente.toUpperCase() !== soloCliente.toUpperCase()) continue;
    if (!CLIENTES[cliente]) { console.log(`  ⚠ Carpeta sin mapeo de cliente: ${cliente} (se omite)`); continue; }
    const base = path.join(raiz, cliente);
    for await (const { ruta, bytes } of caminar(base)) {
      vistos += 1;
      if (vistos % 1000 === 0) process.stdout.write(`  … ${vistos} archivos\r`);
      const rel = path.relative(base, ruta).split(path.sep);
      const nombre = rel[rel.length - 1];
      const ext = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase() : "";
      const idxDo = rel.findIndex((seg, i) => i < rel.length - 1 && RE_DO.test(seg));
      const carpetaDo = idxDo >= 0 ? rel[idxDo] : "";
      const fila: FilaManifiesto = {
        cliente, rama: ramaDe(rel, idxDo), carpetaDo, consecutivo: "", ciudad: "", anio: 0, numero: 0, referencia: "",
        im: "", mov: "", proveedor: "", oc: "", subcarpetas: "", rutaRelativa: rel.join("/"), nombre, ext, bytes,
        sha256: "", categoria: "", regla: "", destinoKey: "", accion: "OMITIR", nota: "",
      };

      const basura = esBasura(nombre, bytes) ?? esBasuraExtra(nombre);
      if (basura) { filas.push({ ...fila, accion: "DESCARTAR", nota: basura }); continue; }

      if (yaCargado.has(`${carpetaDo.toLowerCase()}|${nombre.toLowerCase()}|${bytes}`)) {
        filas.push({ ...fila, accion: "YA_CARGADO", nota: "primera entrega Litoplas (2026-09-16)" });
        continue;
      }

      if (idxDo < 0) {
        // Fuera de un DO: se sube a clientes/<CLIENTE>/… sin registrar (solo explorador).
        fila.accion = "SUBIR_SUELTO";
        fila.destinoKey = claveSuelta(cliente, fila.rutaRelativa);
        fila.nota = "fuera de una carpeta de DO";
        filas.push(fila);
        continue;
      }

      const datos = parsearCarpeta(cliente, carpetaDo)!;
      const subcarpetas = rel.slice(idxDo + 1, rel.length - 1);
      let { categoria, regla } = clasificarArchivo(subcarpetas, nombre, ext);
      if (categoria === "OTRO") {
        const ia = overrides.get(`${cliente}/${fila.rutaRelativa}`);
        if (ia) { categoria = ia.categoria as typeof categoria; regla = `IA luna (${ia.confianza})`; }
      }
      Object.assign(fila, datos, { subcarpetas: subcarpetas.join("/"), categoria, regla });
      if (!datos.consecutivo) {
        // DO en curso sin número: se sube a clientes/<CLIENTE>/… para no perderlo;
        // se registrará cuando Camila le dé número (decisión D6 de Litoplas).
        fila.accion = "SUBIR_SUELTO";
        fila.destinoKey = claveSuelta(cliente, fila.rutaRelativa);
        fila.nota = "DO en curso sin número (0XXX)";
        filas.push(fila);
        continue;
      }
      fila.accion = "SUBIR";
      if (fila.accion === "SUBIR" && !sinHash) fila.sha256 = await sha256(ruta);
      filas.push(fila);
      const k = `${cliente}|${carpetaDo}`;
      const lista = porDo.get(k) ?? [];
      lista.push(fila);
      porDo.set(k, lista);
    }
  }
  console.log(`  Recorridos ${vistos} archivos`);

  // Duplicados: mismo contenido dentro del MISMO DO y la MISMA subcarpeta (la
  // estructura del cliente se respeta: una copia en otra subcarpeta se sube).
  for (const [, lista] of porDo) {
    const porHuella = new Map<string, FilaManifiesto>();
    const usados = new Set<string>();
    for (const f of lista) {
      if (f.accion !== "SUBIR") continue;
      const huella = `${f.subcarpetas}|${f.sha256 || `${f.bytes}:${f.nombre.toLowerCase()}`}`;
      const primero = porHuella.get(huella);
      if (primero) {
        f.accion = "DUPLICADO";
        f.destinoKey = primero.destinoKey;
        f.nota = `mismo contenido que ${primero.rutaRelativa}`;
        continue;
      }
      f.destinoKey = claveTramite(f.consecutivo, f.categoria, f.subcarpetas ? f.subcarpetas.split("/") : [], f.nombre, usados);
      porHuella.set(huella, f);
    }
  }

  // Resúmenes.
  const resumenDos: string[] = ["cliente;consecutivo;rama;carpeta_do;referencia;archivos;subir;ya_cargado;duplicados;descartar;omitir;bytes_subir;otro;tiene_factura_venta"];
  const dos = [...porDo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [k, lista] of dos) {
    const p = lista[0];
    const subir = lista.filter((f) => f.accion === "SUBIR");
    const n = (a: string) => lista.filter((f) => f.accion === a).length;
    const bytes = subir.reduce((a, f) => a + f.bytes, 0);
    const otro = subir.filter((f) => f.categoria === "OTRO").length;
    const facturaVenta = lista.some((f) => /BAQ[ -]?1\d{4}/i.test(f.nombre));
    resumenDos.push([p.cliente, p.consecutivo, p.rama, k.split("|")[1], p.referencia, lista.length, subir.length, n("YA_CARGADO"), n("DUPLICADO"), n("DESCARTAR"), n("OMITIR"), bytes, otro, facturaVenta ? "SI" : "NO"].map(csvCampo).join(";"));
  }

  const resumenClientes: string[] = ["cliente;dos;archivos;subir;sueltos;ya_cargado;duplicados;descartar;omitir;gb_subir;otro;pct_otro"];
  for (const cliente of clientes) {
    const l = filas.filter((f) => f.cliente === cliente);
    if (!l.length) continue;
    const n = (a: string) => l.filter((f) => f.accion === a).length;
    const subir = l.filter((f) => f.accion === "SUBIR");
    const otro = subir.filter((f) => f.categoria === "OTRO").length;
    const gb = (l.filter((f) => f.accion === "SUBIR" || f.accion === "SUBIR_SUELTO").reduce((a, f) => a + f.bytes, 0) / 1073741824).toFixed(2);
    const ndos = new Set(l.filter((f) => f.consecutivo).map((f) => f.consecutivo)).size;
    resumenClientes.push([cliente, ndos, l.length, subir.length, n("SUBIR_SUELTO"), n("YA_CARGADO"), n("DUPLICADO"), n("DESCARTAR"), n("OMITIR"), gb, otro, subir.length ? Math.round((100 * otro) / subir.length) : 0].map(csvCampo).join(";"));
  }

  await mkdir(salida, { recursive: true });
  await writeFile(path.join(salida, "manifiesto.csv"), "\uFEFF" + [CABECERA, ...filas.map(filaACsv)].join("\r\n"), "utf8");
  await writeFile(path.join(salida, "resumen-dos.csv"), "\uFEFF" + resumenDos.join("\r\n"), "utf8");
  await writeFile(path.join(salida, "resumen-clientes.csv"), "\uFEFF" + resumenClientes.join("\r\n"), "utf8");

  const porCat = new Map<string, number>();
  for (const f of filas) if (f.accion === "SUBIR") porCat.set(f.categoria, (porCat.get(f.categoria) ?? 0) + 1);
  const tot = (a: string) => filas.filter((f) => f.accion === a).length;
  console.log("");
  console.log(`DOs reconocidos : ${dos.length}`);
  console.log(`A subir (en DO) : ${tot("SUBIR")} · sueltos ${tot("SUBIR_SUELTO")} · ya cargados ${tot("YA_CARGADO")} · duplicados ${tot("DUPLICADO")} · descartar ${tot("DESCARTAR")} · omitir ${tot("OMITIR")}`);
  console.log("Por categoría   :");
  for (const [c, n] of [...porCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${c.padEnd(22)} ${n}`);
  console.log("");
  console.log("Por cliente     :");
  for (const l of resumenClientes.slice(1)) console.log(`   ${l}`);
  console.log("");
  console.log(`Manifiesto : ${path.join(salida, "manifiesto.csv")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
