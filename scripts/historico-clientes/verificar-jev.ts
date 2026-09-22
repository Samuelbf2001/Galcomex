/**
 * Segunda opinión con Jev (TypeSafe, vía OpenRouter `alpha/decisions`) sobre
 * lo que Haiku/luna clasificó. Jev no escribe texto: elige una opción del
 * catálogo y da una probabilidad. Se usa como VERIFICADOR, patrón del
 * handoff (`ghl-ai-analyzer/docs/HANDOFF_JEV.md`): el código pone el piso,
 * el modelo el criterio, y una persona decide por encima de un umbral.
 *
 * Regla de cruce (por archivo):
 *   · coinciden → se aplica, confianza = máx.
 *   · difieren  → Haiku si su confianza ≥ 0,80; si no, Jev si su prob. ≥ 0,60; si no, OTRO.
 *
 * Entrada: `ia-lotes-<fuente>/lote-N.json` + `ia-<fuente>.csv` (salida de clasificar-ia.ts --importar)
 * Salida:  `jev-<fuente>.csv` (crudo) y `ia-<fuente>.csv` reescrito con la decisión final.
 *
 *   npx tsx scripts/historico-clientes/verificar-jev.ts --env ../openrouter-llave.env
 *   npx tsx scripts/historico-clientes/verificar-jev.ts --env ../openrouter-llave.env --prod
 */
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const carpeta = opt("carpeta") ?? path.resolve(process.cwd(), "..", "historico-clientes-2026");
const fuente = flag("prod") ? "prod" : "manifiesto";
const PARALELO = Number(opt("paralelo") ?? 6);
const limite = opt("limite") ? Number(opt("limite")) : undefined;

function cargarEnv(ruta: string): void {
  let texto = "";
  try { texto = readFileSync(ruta, "utf8"); } catch { return; }
  for (const linea of texto.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}
cargarEnv(opt("env") ?? path.resolve(process.cwd(), "..", "openrouter-llave.env"));
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

const CRITERIOS: Record<string, string> = {
  FACTURA_COMERCIAL: "Invoice or proforma from the FOREIGN supplier of the goods (commercial invoice, fattura). Not invoices from Colombian carriers, ports or truckers.",
  BL: "Transport document: BL, HBL, MBL, air waybill, carta de porte, booking, BL release, telex release, paz y salvo, freight certification.",
  PACKING_LIST: "Packing list of the shipment.",
  DECLARACION_DIAN: "Customs paperwork: DIM, DAV, levante, estado 50, mandato, insurance policy for customs, inspection act, previa, selectividad, certificate of origin, free-zone forms (FMM, certificado de integracion), EDI files, valuation.",
  SOPORTE_FACTURACION: "Supports for billing the client: Galcomex sales invoice (BAQ-1xxxx), fund request/relation (solicitud de fondos), settlement sheets, credit notes or reconciliations with the client.",
  FOTO_RECONOCIMIENTO: "Photos or videos of inspection, recognition, unloading or the cargo.",
  COMPROBANTE_BANCARIO: "Bank transfer or payment receipt (Bancolombia, Occidente, SWIFT), bank statement, proof of payment to a supplier.",
  COMPROBANTE_COMERCIO: "Payments and filings in foreign-trade portals: ROP (DIAN tax payment receipt), payment instruction, import registration or license (VUCE, REG-, LIC-), INVIMA/SIC approval, port PSE receipt, letters to MinCIT.",
  FACTURA_PROVEEDOR: "Invoice from a LOCAL service supplier: shipping line (MSC, Maersk), port (SPRB, Contecar, Compas: storage, use, empties, mobilization), trucker, Almacarga, Express, Coldex, DHL.",
  CONTROL_TRAMITE: "Internal control of the file: document relation or filing, checklist, documents received/sent, working spreadsheets (Siscomex, Moviaduanas), TRM, free-zone inventory queries, 'documents of the dispatch' bundles.",
  FICHA_TECNICA: "Technical or regulatory product documentation: datasheet, MSDS, analysis/quality/conformity certificate, minimum description, tariff heading, sanitary notification (NSOC), MinJusticia concepts, catalogs.",
  CORRESPONDENCIA: "Emails (Outlook, .eml), arrival notices, courier tracking, notifications.",
  ORDEN_COMPRA: "Purchase order from the client to the supplier, order, quotation, order confirmation.",
  OTRO: "No evidence: the name gives no clue about the type of document.",
};

type Item = { i: number; clave: string; cliente: string; do: string; carpeta: string; nombre: string; vecinos: string[] };
type Fila = Record<string, string>;

function parsearCsv(texto: string): Fila[] {
  const lineas: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let enComillas = false;
  const t = texto.replace(/^﻿/, "");
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
const csvCampo = (v: string | number) => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

type Jev = { choice: string; prob: number };

async function preguntarJev(it: Item, intento = 1): Promise<Jev> {
  const state =
    `Archivo de un expediente de importación (DO) en Colombia.\n` +
    `Cliente: ${it.cliente}\nCarpeta del DO: "${it.do}"\nSubcarpeta: "${it.carpeta || "(raíz del DO)"}"\n` +
    `Nombre del archivo: "${it.nombre}"\n` +
    (it.vecinos.length ? `Archivos vecinos en la misma carpeta: ${it.vecinos.map((v) => `"${v}"`).join(", ")}` : "");
  const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "~typesafe/jev-latest",
      state,
      questions: { categoria: { type: "choice", instructions: "¿Qué tipo de documento es este archivo, según su nombre y su carpeta?", criteria: CRITERIOS } },
    }),
  });
  if (!res.ok) {
    if (intento < 4 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 1500 * intento)); return preguntarJev(it, intento + 1); }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { answers: { categoria: { choice: string; probabilities: Record<string, number> } }; usage?: { cost?: number } };
  costo += json.usage?.cost ?? 0;
  const a = json.answers.categoria;
  return { choice: a.choice, prob: a.probabilities?.[a.choice] ?? 0 };
}
let costo = 0;

async function main() {
  if (!API_KEY) throw new Error("Falta OPENROUTER_API_KEY (pásala con --env ../openrouter-llave.env)");
  const dir = path.join(carpeta, `ia-lotes-${fuente}`);
  const items: Item[] = [];
  for (const f of (await readdir(dir)).filter((n) => /^lote-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
    const j = JSON.parse(await readFile(path.join(dir, f), "utf8")) as { items: Item[] };
    items.push(...j.items);
  }
  const lista = limite ? items.slice(0, limite) : items;
  const iaPath = path.join(carpeta, `ia-${fuente}.csv`);
  const haiku = new Map(parsearCsv(await readFile(iaPath, "utf8")).map((r) => [r.ruta ?? r.id, r]));
  const claveCol = fuente === "prod" ? "id" : "ruta";
  console.log(`Jev verificador — ${fuente} · ${lista.length} archivos · Haiku previo: ${haiku.size}`);

  const jev = new Map<string, Jev>();
  let idx = 0, hechos = 0, errores = 0;
  // `--reusar`: toma las respuestas de Jev ya guardadas en jev-<fuente>.csv (no llama a la API).
  if (flag("reusar")) {
    for (const r of parsearCsv(await readFile(path.join(carpeta, `jev-${fuente}.csv`), "utf8"))) {
      jev.set(r[claveCol], { choice: r.jev, prob: Number(r.prob_jev) });
    }
    idx = lista.length;
    console.log(`  reusadas ${jev.size} respuestas de Jev`);
  }
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (idx < lista.length) {
      const it = lista[idx++];
      try { jev.set(it.clave, await preguntarJev(it)); } catch (e) { errores += 1; if (errores <= 3) console.log(`  ERROR ${it.nombre}: ${e instanceof Error ? e.message : e}`); }
      hechos += 1;
      if (hechos % 25 === 0) process.stdout.write(`  ${hechos}/${lista.length}\r`);
    }
  }));
  console.log(`  respondidos ${jev.size} · errores ${errores} · costo US$${costo.toFixed(4)}`);

  // Cruce.
  let coinciden = 0;
  const gana = { haiku: 0, jev: 0, otro: 0 };
  const crudo = [`${claveCol};haiku;conf_haiku;jev;prob_jev;final;nombre;consecutivo`];
  const finalFilas = [`${claveCol};categoria;confianza;razon;nombre;consecutivo`];
  for (const it of lista) {
    const h = haiku.get(it.clave);
    const j = jev.get(it.clave);
    const hCat = h?.categoria ?? "OTRO";
    const hConf = Number(h?.confianza ?? 0);
    const jCat = j?.choice ?? "OTRO";
    const jProb = j?.prob ?? 0;
    let final = "OTRO", conf = 0, razon = h?.razon ?? "";
    if (hCat !== "OTRO" && hCat === jCat) { final = hCat; conf = Math.max(hConf, jProb); coinciden += 1; razon = `${razon} · Jev coincide ${jProb.toFixed(2)}`; }
    else if (hCat !== "OTRO" && hConf >= 0.8) { final = hCat; conf = hConf; gana.haiku += 1; razon = `${razon} · Jev dijo ${jCat} ${jProb.toFixed(2)}`; }
    else if (jCat !== "OTRO" && jProb >= 0.6) { final = jCat; conf = jProb; gana.jev += 1; razon = `Jev ${jProb.toFixed(2)} (Haiku decía ${hCat} ${hConf.toFixed(2)})`; }
    else { gana.otro += 1; }
    crudo.push([it.clave, hCat, hConf.toFixed(2), jCat, jProb.toFixed(2), final, it.nombre, it.do].map(csvCampo).join(";"));
    finalFilas.push([it.clave, final, conf.toFixed(2), razon, it.nombre, it.do].map(csvCampo).join(";"));
  }
  await writeFile(path.join(carpeta, `jev-${fuente}.csv`), "﻿" + crudo.join("\r\n"), "utf8");
  await writeFile(iaPath, "﻿" + finalFilas.join("\r\n"), "utf8");
  const aplicadas = finalFilas.length - 1 - gana.otro;
  console.log(`Coinciden ${coinciden} · gana Haiku ${gana.haiku} · gana Jev ${gana.jev} · quedan OTRO ${gana.otro} → aplicables ${aplicadas}/${lista.length}`);
  console.log(`Crudo: ${path.join(carpeta, `jev-${fuente}.csv`)} · Final: ${iaPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
