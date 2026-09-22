/**
 * Histórico clientes 2026 — PASO 1b: clasificar con IA lo que las reglas
 * dejaron en OTRO. Modelo: `gpt-5.6-luna` por la API de OpenAI (chat
 * completions + JSON Schema estricto), el mismo que usa `ghl-ai-analyzer`.
 * (Jev de TypeSafe sería más barato aún, pero no hay `OPENROUTER_API_KEY`
 * en este PC; ver `ghl-ai-analyzer/docs/HANDOFF_JEV.md`.)
 *
 * En palabras simples: se le muestra al modelo, por tandas de 40, el nombre
 * de cada archivo con su carpeta, su cliente y los archivos vecinos, y él
 * escoge una categoría del catálogo con una confianza. Solo se aplica si la
 * confianza llega a 0,60; lo demás se queda en OTRO para revisión humana.
 * NUNCA se toca un archivo que ya tenía categoría.
 *
 * Dos fuentes:
 *   --manifiesto  (por defecto) filas SUBIR con categoria OTRO del manifiesto nuevo
 *   --prod <csv>  los documentos que YA están en producción en OTRO
 *                 (id;consecutivo;nombreArchivo;storageKey;bytes, exportado por SQL)
 *
 * Salidas (en la carpeta del manifiesto):
 *   ia-manifiesto.csv   ruta;categoria;confianza;razon   → lo lee clasificar.ts --overrides
 *   ia-prod.csv         id;categoria;confianza;razon     → lo aplica aplicar-reclasificacion.ts
 *
 * Uso:
 *   npx tsx --env-file=C:\Users\samue\ghl-ai-analyzer\.env scripts/historico-clientes/clasificar-ia.ts
 *   npx tsx --env-file=… scripts/historico-clientes/clasificar-ia.ts --prod ../historico-clientes-2026/prod-otro-litoplas.csv
 *   … --dry (arma las tandas y muestra el prompt de la primera, sin llamar al modelo)
 *   … --limite 80 (solo los primeros N, para probar)
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const carpeta = opt("carpeta") ?? path.resolve(process.cwd(), "..", "historico-clientes-2026");
const manifiestoPath = opt("manifiesto") ?? path.join(carpeta, "manifiesto.csv");
const prodPath = opt("prod");
const dry = flag("dry");
const limite = opt("limite") ? Number(opt("limite")) : undefined;
const TANDA = Number(opt("tanda") ?? 40);
const PARALELO = Number(opt("paralelo") ?? 4);
const UMBRAL = Number(opt("umbral") ?? 0.6);
/**
 * `--env <archivo>`: carga un .env sencillo (KEY=valor) sin imprimir nada.
 * Por defecto el de ghl-ai-analyzer, que ya tiene la llave de luna.
 */
function cargarEnv(ruta: string): void {
  let texto = "";
  try { texto = readFileSync(ruta, "utf8"); } catch { return; }
  for (const linea of texto.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1");
  }
}
cargarEnv(opt("env") ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\samue", "ghl-ai-analyzer", ".env"));

const MODELO = process.env.LLM_MODEL_CLASIFICACION ?? "gpt-5.6-luna";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";

// ─── Catálogo (mismos valores que el enum CategoriaDocumento) ────────────────

const CATALOGO: Record<string, string> = {
  FACTURA_COMERCIAL: "Factura o proforma del PROVEEDOR EXTRANJERO de la mercancía (invoice, commercial invoice, fattura). NO facturas de navieras, puertos ni transportadores colombianos.",
  BL: "Documento de transporte: BL, HBL, MBL, guía aérea (AWB), carta de porte, booking, liberación del BL, telex release, paz y salvo naviera, certificación de fletes.",
  PACKING_LIST: "Lista de empaque / packing list del embarque.",
  DECLARACION_DIAN: "Todo lo aduanero: DIM, DAV, levante, estado 50, mandato, póliza/seguro para la DIAN, acta de inspección o previa, selectividad, certificado de origen, formularios de zona franca (FMM, certificado de integración), archivos EDI, valoración.",
  SOPORTE_FACTURACION: "Soportes para facturar al cliente: factura de venta de Galcomex (BAQ-1xxxx), solicitud/relación de fondos, cuadros de liquidación, notas crédito o conciliaciones con el cliente.",
  FOTO_RECONOCIMIENTO: "Fotos o videos de reconocimiento, inspección, vaciado o de la carga.",
  COMPROBANTE_BANCARIO: "Comprobante de transferencia o pago bancario (Bancolombia, Occidente, SWIFT, giro al exterior), extracto, soporte de pago a un proveedor.",
  COMPROBANTE_COMERCIO: "Pagos y trámites en portales de comercio exterior: ROP / recibo oficial de pago de impuestos DIAN, instrucción de pago, registro o licencia de importación (VUCE, REG-, LIC-), visto bueno INVIMA/SIC, comprobante PSE del puerto, cartas a MinCIT.",
  FACTURA_PROVEEDOR: "Factura de un PROVEEDOR LOCAL de servicios del trámite: naviera (MSC, Maersk…), puerto (SPRB, Contecar, Compas: almacenaje, uso de instalaciones, vacíos, movilización), transportador, Almacarga, Express, Coldex, DHL.",
  CONTROL_TRAMITE: "Control interno del trámite: relación o radicado de documentos, check list, documentos recibidos/enviados, Excel de trabajo (Siscomex, Moviaduanas), TRM, consultas de inventario en zona franca, paquetes 'documentos del despacho'.",
  FICHA_TECNICA: "Documentación técnica o regulatoria del producto: ficha técnica, hoja de seguridad (MSDS), certificado de análisis/calidad/conformidad, descripción mínima, partida arancelaria, notificación sanitaria (NSOC), conceptos de MinJusticia, catálogos.",
  CORRESPONDENCIA: "Correos (Outlook, .eml), avisos de arribo, rastreos de courier, notificaciones.",
  ORDEN_COMPRA: "Orden de compra del cliente al proveedor, pedido, cotización, confirmación de pedido.",
  OTRO: "Solo si de verdad no se puede saber (nombre puramente numérico sin contexto, archivo ajeno al trámite).",
};

const RESPUESTA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resultados: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          i: { type: "integer", description: "índice del archivo tal como se envió" },
          categoria: { type: "string", enum: Object.keys(CATALOGO) },
          confianza: { type: "number", description: "0 a 1" },
          razon: { type: "string", description: "máximo 12 palabras" },
        },
        required: ["i", "categoria", "confianza", "razon"],
      },
    },
  },
  required: ["resultados"],
};

const SYSTEM = `Eres el archivista documental de Galcomex, una agencia logística de importaciones en Barranquilla, Colombia. Clasificas archivos de los expedientes (DO) de sus clientes SOLO por el nombre del archivo, la carpeta donde está y los archivos vecinos. Devuelves exactamente una categoría del catálogo por archivo, con una confianza honesta entre 0 y 1 (0,9+ solo si el nombre es inequívoco; 0,5 o menos si adivinas). Si no hay forma de saberlo, usa OTRO con confianza baja.

Catálogo de categorías:
${Object.entries(CATALOGO).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Pistas del negocio: "DO." es el número del expediente de Galcomex; "IM" es el número de importación de Litoplas; "MOV-I26…" es el expediente de Moviaduanas; "NAC" y "ZF" son nacionalización y zona franca (Polyrec ZF); "PL" en Sesderma es el número de su packing list/factura; "BGT" es Bogotá. Los archivos de una misma carpeta suelen ser del mismo tipo.`;

// ─── Entradas ────────────────────────────────────────────────────────────────

type Item = {
  clave: string; // ruta (manifiesto) o id (prod)
  cliente: string;
  do: string;
  carpeta: string;
  nombre: string;
  vecinos: string[];
};

function parsearCsv(texto: string, sep = ";"): Record<string, string>[] {
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
    else if (c === sep) { fila.push(campo); campo = ""; }
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

function csvCampo(v: string | number): string {
  const s = String(v ?? "");
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function itemsDelManifiesto(): Promise<Item[]> {
  const filas = parsearCsv(await readFile(manifiestoPath, "utf8"));
  const porCarpeta = new Map<string, string[]>();
  for (const f of filas) {
    if (f.accion !== "SUBIR" && f.accion !== "SUBIR_SUELTO") continue;
    const k = `${f.cliente}|${f.carpeta_do}|${f.subcarpetas}`;
    (porCarpeta.get(k) ?? porCarpeta.set(k, []).get(k)!).push(f.nombre);
  }
  return filas
    .filter((f) => f.accion === "SUBIR" && f.categoria === "OTRO")
    .map((f) => ({
      clave: `${f.cliente}/${f.ruta_relativa}`,
      cliente: f.cliente,
      do: f.carpeta_do,
      carpeta: f.subcarpetas,
      nombre: f.nombre,
      vecinos: (porCarpeta.get(`${f.cliente}|${f.carpeta_do}|${f.subcarpetas}`) ?? []).filter((n) => n !== f.nombre).slice(0, 8),
    }));
}

async function itemsDeProd(ruta: string): Promise<Item[]> {
  // Export SQL sin cabecera: id;consecutivo;nombreArchivo;storageKey;bytes
  const lineas = (await readFile(ruta, "utf8")).split(/\r?\n/).filter(Boolean);
  const filas = lineas.map((l) => l.split(";"));
  const porDo = new Map<string, string[]>();
  for (const [, cons, nombre] of filas) (porDo.get(cons) ?? porDo.set(cons, []).get(cons)!).push(nombre);
  return filas.map(([id, cons, nombre, key]) => ({
    clave: id,
    cliente: "LITOPLAS",
    do: cons,
    carpeta: key.split("/").slice(3, -1).join("/"),
    nombre,
    vecinos: (porDo.get(cons) ?? []).filter((n) => n !== nombre).slice(0, 8),
  }));
}

// ─── Modelo ──────────────────────────────────────────────────────────────────

type Resultado = { i: number; categoria: string; confianza: number; razon: string };

function promptDeTanda(items: Item[]): string {
  const lineas = items.map((it, i) =>
    `${i}. cliente=${it.cliente} | DO="${it.do}" | carpeta="${it.carpeta || "(raíz del DO)"}" | archivo="${it.nombre}"` +
    (it.vecinos.length ? ` | vecinos=[${it.vecinos.map((v) => `"${v}"`).join(", ")}]` : ""),
  );
  return `Clasifica estos ${items.length} archivos. Responde con un resultado por índice.\n\n${lineas.join("\n")}`;
}

async function clasificarTanda(items: Item[], intento = 1): Promise<Resultado[]> {
  const body = {
    model: MODELO,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: promptDeTanda(items) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "clasificacion", strict: true, schema: RESPUESTA_SCHEMA } },
  };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (intento < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 3000 * intento));
      return clasificarTanda(items, intento + 1);
    }
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[]; usage?: Record<string, number> };
  const contenido = JSON.parse(json.choices[0].message.content) as { resultados: Resultado[] };
  usoTotal.entrada += json.usage?.prompt_tokens ?? 0;
  usoTotal.salida += json.usage?.completion_tokens ?? 0;
  return contenido.resultados;
}

const usoTotal = { entrada: 0, salida: 0 };

/**
 * Sin llave de API (caso 2026-09-21: ni luna ni Jev en este PC) el trabajo lo
 * hacen subagentes Haiku de Claude Code: `--exportar` deja los lotes en
 * `ia-lotes/lote-N.json` + `ia-lotes/PROMPT.md`; cada agente escribe
 * `lote-N.resultado.json` con `{ resultados: [{i, categoria, confianza, razon}] }`;
 * `--importar` los junta y produce el mismo CSV que la ruta con API.
 */
async function exportarLotes(tandas: Item[][], fuente: "manifiesto" | "prod"): Promise<void> {
  const dir = path.join(carpeta, `ia-lotes-${fuente}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "PROMPT.md"), SYSTEM + "\n\nFormato de respuesta (JSON): " + JSON.stringify(RESPUESTA_SCHEMA), "utf8");
  for (let n = 0; n < tandas.length; n += 1) {
    await writeFile(path.join(dir, `lote-${n + 1}.json`), JSON.stringify({ lote: n + 1, prompt: promptDeTanda(tandas[n]), items: tandas[n].map((it, i) => ({ i, ...it })) }, null, 1), "utf8");
  }
  console.log(`  Exportados ${tandas.length} lotes en ${dir}`);
}

/**
 * Los ítems se leen de los `lote-N.json` EXPORTADOS (no del manifiesto
 * actual): si el manifiesto se regeneró con decisiones aplicadas, los índices
 * ya no coincidirían.
 */
async function importarLotes(fuente: "manifiesto" | "prod"): Promise<{ clave: string; item: Item; r: Resultado }[]> {
  const dir = path.join(carpeta, `ia-lotes-${fuente}`);
  const salida: { clave: string; item: Item; r: Resultado }[] = [];
  for (let n = 1; ; n += 1) {
    let lote: { items: (Item & { i: number })[] };
    try { lote = JSON.parse(await readFile(path.join(dir, `lote-${n}.json`), "utf8")); } catch { break; }
    let json: { resultados: Resultado[] };
    try { json = JSON.parse(await readFile(path.join(dir, `lote-${n}.resultado.json`), "utf8")); } catch { console.log(`  ⚠ falta lote-${n}.resultado.json`); continue; }
    const porIndice = new Map(lote.items.map((it) => [it.i, it]));
    for (const r of json.resultados) { const it = porIndice.get(r.i); if (it) salida.push({ clave: it.clave, item: it, r }); }
  }
  return salida;
}

async function main() {
  const items = prodPath ? await itemsDeProd(prodPath) : await itemsDelManifiesto();
  const lista = limite ? items.slice(0, limite) : items;
  const fuente = prodPath ? "prod" : "manifiesto";
  console.log(`Clasificación IA — fuente ${prodPath ? "PRODUCCIÓN (OTRO)" : "manifiesto (OTRO)"} · ${lista.length} archivos · modelo ${MODELO} · umbral ${UMBRAL}`);

  const tandas: Item[][] = [];
  for (let i = 0; i < lista.length; i += TANDA) tandas.push(lista.slice(i, i + TANDA));
  console.log(`  ${tandas.length} tandas de hasta ${TANDA}`);
  if (dry) { console.log("\n--- SYSTEM ---\n" + SYSTEM + "\n\n--- USER (tanda 1) ---\n" + promptDeTanda(tandas[0] ?? [])); return; }
  if (flag("exportar")) { await exportarLotes(tandas, fuente); return; }

  let salida: { clave: string; item: Item; r: Resultado }[] = [];
  if (flag("importar")) {
    salida = await importarLotes(fuente);
    await escribirSalida(salida, salida.length);
    return;
  } else {
    if (!API_KEY) throw new Error("Falta LLM_API_KEY (o OPENAI_API_KEY). Pásala con --env <archivo .env>, o usa --exportar / --importar con subagentes.");
    salida = await clasificarConApi(tandas);
  }
  await escribirSalida(salida, lista.length);
}

async function clasificarConApi(tandas: Item[][]): Promise<{ clave: string; item: Item; r: Resultado }[]> {
  const salida: { clave: string; item: Item; r: Resultado }[] = [];
  let hechas = 0;
  let idx = 0;
  const trabajadores = Array.from({ length: Math.min(PARALELO, tandas.length) }, async () => {
    while (idx < tandas.length) {
      const t = tandas[idx++];
      try {
        const rs = await clasificarTanda(t);
        for (const r of rs) if (t[r.i]) salida.push({ clave: t[r.i].clave, item: t[r.i], r });
      } catch (e) {
        console.log(`  ERROR tanda: ${e instanceof Error ? e.message : String(e)}`);
      }
      hechas += 1;
      process.stdout.write(`  tandas ${hechas}/${tandas.length}\r`);
    }
  });
  await Promise.all(trabajadores);
  console.log("");
  return salida;
}

async function escribirSalida(salida: { clave: string; item: Item; r: Resultado }[], total: number): Promise<void> {
  const lista = { length: total };
  const aplicadas = salida.filter((s) => s.r.confianza >= UMBRAL && s.r.categoria !== "OTRO");
  const porCat = new Map<string, number>();
  for (const s of aplicadas) porCat.set(s.r.categoria, (porCat.get(s.r.categoria) ?? 0) + 1);

  void lista;
  const nombre = prodPath ? "ia-prod.csv" : "ia-manifiesto.csv";
  const cab = prodPath ? "id;categoria;confianza;razon;nombre;consecutivo" : "ruta;categoria;confianza;razon;nombre;consecutivo";
  const filas = salida
    .sort((a, b) => a.clave.localeCompare(b.clave))
    .map((s) => [s.clave, s.r.confianza >= UMBRAL ? s.r.categoria : "OTRO", s.r.confianza.toFixed(2), s.r.razon, s.item.nombre, s.item.do].map(csvCampo).join(";"));
  await writeFile(path.join(carpeta, nombre), "\uFEFF" + [cab, ...filas].join("\r\n"), "utf8");

  console.log(`Respondidos ${salida.length}/${lista.length} · aplicables (≥ ${UMBRAL}) ${aplicadas.length} · quedan en OTRO ${salida.length - aplicadas.length}`);
  for (const [c, n] of [...porCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${c.padEnd(22)} ${n}`);
  console.log(`Tokens: entrada ${usoTotal.entrada} · salida ${usoTotal.salida}`);
  console.log(`Salida: ${path.join(carpeta, nombre)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
