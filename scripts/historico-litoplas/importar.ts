/**
 * Histórico Litoplas 2026 — PASO 2: importar desde el manifiesto.
 *
 * Lee `manifiesto.csv` (lo produce `clasificar.ts`) y hace dos cosas, por
 * separado o juntas:
 *
 *   --fase subir      copia cada archivo con acción SUBIR a la bodega (MinIO / R2)
 *                     en su `destino_key`. Necesita los archivos en disco y las
 *                     variables MINIO_* del bucket destino. Se puede correr desde
 *                     el PC directo contra R2. Idempotente: si el objeto ya está
 *                     con el mismo tamaño, lo salta.
 *   --fase registrar  crea en la base de datos el trámite de cada DO (si no
 *                     existe) marcado como histórico, y un registro de documento
 *                     por archivo subido. Solo necesita el manifiesto y la BD
 *                     (puede correr dentro del contenedor en producción).
 *                     Idempotente por consecutivo y por storageKey.
 *   --fase todo       (por defecto) subir y luego registrar.
 *
 * Seguridad: si un consecutivo ya existe en la BD y NO es histórico, el DO se
 * reporta como CONFLICTO y no se toca (es un trámite real de la plataforma).
 *
 * Uso:
 *   npx tsx scripts/historico-litoplas/importar.ts --dry
 *   npx tsx scripts/historico-litoplas/importar.ts --solo DO.BAQ26-0107,DO.CTG26-0003
 *   npx tsx scripts/historico-litoplas/importar.ts --limite 5
 *   npx tsx scripts/historico-litoplas/importar.ts --fase registrar --manifiesto /app/manifiesto.csv
 *
 * Opciones: --manifiesto <csv> · --raiz <carpeta con las partes> · --cliente <nombre ILIKE>
 *           --usuario <email> · --sin-verificar (registrar sin comprobar que el objeto exista)
 */
import "dotenv/config";

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { AgenciaAduanas, Ciudad, EstadoTramite, Rol, type CategoriaDocumento } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";

import { prisma } from "../../src/lib/db/prisma";
import { getStorageClient } from "../../src/lib/storage/client";
import { getStorageConfig, resumenStorage } from "../../src/lib/storage/config";
import { mimePorExtension } from "./reglas";

// ─── Argumentos ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const manifiestoPath = opt("manifiesto") ?? path.resolve(process.cwd(), "..", "historico-litoplas-2026", "manifiesto.csv");
const raiz = opt("raiz") ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\samue", "Downloads");
const fase = (opt("fase") ?? "todo") as "subir" | "registrar" | "todo";
const dry = flag("dry");
const soloArg = opt("solo");
const solo = soloArg ? new Set(soloArg.split(",").map((s) => s.trim())) : null;
const limite = opt("limite") ? Number(opt("limite")) : undefined;
const clienteNombre = opt("cliente") ?? "LITOPLAS";
const usuarioEmail = opt("usuario") ?? "importacion@galcomex.com";
const sinVerificar = flag("sin-verificar");

// ─── CSV ─────────────────────────────────────────────────────────────────────

function parsearCsv(texto: string): Record<string, string>[] {
  const lineas: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let enComillas = false;
  const t = texto.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (enComillas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i += 1; } else enComillas = false;
      } else campo += c;
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

type Fila = {
  rama: string; carpetaDo: string; consecutivo: string; ciudad: string; numero: number; im: string; mov: string;
  proveedor: string; oc: string; parte: string; rutaRelativa: string; nombre: string; ext: string; bytes: number;
  sha256: string; categoria: string; regla: string; destinoKey: string; accion: string; nota: string;
};

function aFila(r: Record<string, string>): Fila {
  return {
    rama: r.rama, carpetaDo: r.carpeta_do, consecutivo: r.consecutivo, ciudad: r.ciudad, numero: Number(r.numero || 0),
    im: r.im, mov: r.mov, proveedor: r.proveedor, oc: r.oc, parte: r.parte, rutaRelativa: r.ruta_relativa, nombre: r.nombre,
    ext: r.ext, bytes: Number(r.bytes || 0), sha256: r.sha256, categoria: r.categoria, regla: r.regla,
    destinoKey: r.destino_key, accion: r.accion, nota: r.nota,
  };
}

// ─── Bodega ──────────────────────────────────────────────────────────────────

async function existeObjeto(bucket: string, key: string): Promise<number | null> {
  try {
    const s = await getStorageClient().statObject(bucket, key);
    return s.size;
  } catch {
    return null;
  }
}

async function subirArchivo(bucket: string, f: Fila): Promise<"subido" | "ya-estaba" | "falta-origen"> {
  const origen = path.join(raiz, f.parte, ...f.rutaRelativa.split("/"));
  let tam: number;
  try { tam = (await stat(origen)).size; } catch { return "falta-origen"; }
  const actual = await existeObjeto(bucket, f.destinoKey);
  if (actual !== null && actual === tam) return "ya-estaba";
  if (dry) return "subido";
  await getStorageClient().putObject(bucket, f.destinoKey, createReadStream(origen), tam, {
    "Content-Type": mimePorExtension(f.ext),
  });
  return "subido";
}

// ─── Base de datos ───────────────────────────────────────────────────────────

async function resolverCliente(): Promise<{ id: string; nombre: string }> {
  const idArg = opt("cliente-id");
  if (idArg) {
    const c = await prisma.cliente.findUnique({ where: { id: idArg }, select: { id: true, nombre: true } });
    if (!c) throw new Error(`No existe el cliente con id ${idArg}`);
    return c;
  }
  const candidatos = await prisma.cliente.findMany({
    where: { nombre: { contains: clienteNombre, mode: "insensitive" } },
    select: { id: true, nombre: true },
  });
  if (candidatos.length === 1) return candidatos[0];
  if (candidatos.length === 0) throw new Error(`No hay ningún cliente cuyo nombre contenga "${clienteNombre}"`);
  throw new Error(
    `Hay ${candidatos.length} clientes con "${clienteNombre}": ${candidatos.map((c) => `${c.nombre} (${c.id})`).join(", ")}. Usa --cliente-id.`,
  );
}

async function resolverUsuario(): Promise<{ id: string }> {
  const existente = await prisma.user.findUnique({ where: { email: usuarioEmail }, select: { id: true } });
  if (existente) return existente;
  if (dry) return { id: "(se crearía)" };
  const clave = await hashPassword(randomBytes(24).toString("base64url"));
  return prisma.user.create({
    data: {
      email: usuarioEmail,
      name: "Importación histórico",
      emailVerified: true,
      rol: Rol.OPERATIVO,
      accounts: { create: { accountId: usuarioEmail, providerId: "credential", password: clave } },
    },
    select: { id: true },
  });
}

type ResultadoDo = {
  consecutivo: string;
  estado: "CREADO" | "EXISTIA" | "CONFLICTO" | "DRY";
  documentosNuevos: number;
  documentosExistentes: number;
  sinObjeto: number;
};

async function registrarDo(
  consecutivo: string,
  filas: Fila[],
  clienteId: string,
  usuarioId: string,
  bucket: string,
): Promise<ResultadoDo> {
  const p = filas[0];
  const res: ResultadoDo = { consecutivo, estado: "DRY", documentosNuevos: 0, documentosExistentes: 0, sinObjeto: 0 };
  const facturaVenta = filas.some((f) => /BAQ[ -]?1\d{4}/i.test(f.nombre));

  let tramite = await prisma.tramiteDO.findUnique({ where: { consecutivo }, select: { id: true, esHistorico: true } });
  if (tramite && !tramite.esHistorico) {
    res.estado = "CONFLICTO";
    return res;
  }

  if (!tramite) {
    if (dry) { res.estado = "DRY"; }
    else {
      const anio = 2000 + Number(consecutivo.match(/(\d{2})-\d{4}$/)?.[1] ?? 26);
      const creado = await prisma.tramiteDO.create({
        data: {
          consecutivo,
          tipoTramiteCodigo: "IMPORTACION",
          ciudad: p.ciudad as Ciudad,
          anio,
          numero: p.numero,
          clienteId,
          proveedorCliente: p.proveedor || null,
          agenciaAduanas: AgenciaAduanas.MOVIADUANAS,
          doAgencia: p.mov || null,
          doCliente: p.im || null,
          referenciaExterna: p.im || null,
          ordenCompraNumero: p.oc || null,
          estado: facturaVenta ? EstadoTramite.FACTURADO : EstadoTramite.EN_TRAMITE,
          esHistorico: true,
          comentarios: `Importado del archivo histórico Drive 2026 · carpeta "${p.carpetaDo}" · rama ${p.rama}`,
          creadoPorId: usuarioId,
        },
        select: { id: true, esHistorico: true },
      });
      await prisma.auditLog.create({
        data: {
          entidad: "TramiteDO", entidadId: creado.id, accion: "IMPORT_HISTORICO", usuarioId, tramiteId: creado.id,
          despues: { consecutivo, carpeta: p.carpetaDo, rama: p.rama, im: p.im, mov: p.mov, proveedor: p.proveedor },
        },
      });
      tramite = creado;
      res.estado = "CREADO";
    }
  } else {
    res.estado = "EXISTIA";
  }

  const aSubir = filas.filter((f) => f.accion === "SUBIR" && f.destinoKey);
  if (!tramite) { res.documentosNuevos = aSubir.length; return res; }

  const existentes = new Set(
    (await prisma.documento.findMany({ where: { tramiteId: tramite.id }, select: { storageKey: true } })).map((d) => d.storageKey),
  );
  for (const f of aSubir) {
    if (existentes.has(f.destinoKey)) { res.documentosExistentes += 1; continue; }
    if (!sinVerificar) {
      const tam = await existeObjeto(bucket, f.destinoKey);
      if (tam === null) { res.sinObjeto += 1; continue; }
    }
    if (!dry) {
      await prisma.documento.create({
        data: {
          tramiteId: tramite.id,
          categoria: f.categoria as CategoriaDocumento,
          nombreArchivo: f.nombre,
          storageKey: f.destinoKey,
          mimeType: mimePorExtension(f.ext),
          tamanoBytes: f.bytes,
          subidoPorId: usuarioId,
        },
      });
    }
    res.documentosNuevos += 1;
  }
  return res;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = getStorageConfig();
  const bodega = resumenStorage(config);
  console.log("Histórico Litoplas 2026 — importación");
  console.log(`  Manifiesto : ${manifiestoPath}`);
  console.log(`  Archivos   : ${raiz}`);
  console.log(`  Bodega     : ${bodega.nombreProveedor} · ${bodega.endpoint} · bucket ${bodega.bucket}`);
  console.log(`  Fase       : ${fase}${dry ? " (DRY, no escribe nada)" : ""}`);
  if (solo) console.log(`  Solo       : ${[...solo].join(", ")}`);
  if (limite) console.log(`  Límite     : ${limite} DOs`);
  console.log("");

  const filas = parsearCsv(await readFile(manifiestoPath, "utf8")).map(aFila);
  const porDo = new Map<string, Fila[]>();
  for (const f of filas) {
    if (!f.consecutivo) continue;
    if (solo && !solo.has(f.consecutivo)) continue;
    const l = porDo.get(f.consecutivo) ?? [];
    l.push(f);
    porDo.set(f.consecutivo, l);
  }
  let dos = [...porDo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (limite) dos = dos.slice(0, limite);
  console.log(`DOs en el manifiesto a procesar: ${dos.length}`);

  if (fase === "subir" || fase === "todo") {
    console.log("\n── Fase SUBIR ──");
    let subidos = 0, yaEstaban = 0, faltan = 0, bytes = 0;
    const inicio = Date.now();
    for (const [cons, lista] of dos) {
      const aSubir = lista.filter((f) => f.accion === "SUBIR" && f.destinoKey);
      let s = 0, y = 0, fa = 0;
      for (const f of aSubir) {
        const r = await subirArchivo(config.bucket, f);
        if (r === "subido") { s += 1; bytes += f.bytes; } else if (r === "ya-estaba") y += 1; else fa += 1;
      }
      subidos += s; yaEstaban += y; faltan += fa;
      console.log(`  ${cons.padEnd(15)} ${String(aSubir.length).padStart(4)} archivos · subidos ${s} · ya estaban ${y}${fa ? ` · SIN ORIGEN ${fa}` : ""}`);
    }
    const seg = Math.round((Date.now() - inicio) / 1000);
    console.log(`Subidos ${subidos} (${(bytes / 1048576).toFixed(0)} MB) · ya estaban ${yaEstaban} · sin origen ${faltan} · ${seg} s`);
  }

  if (fase === "registrar" || fase === "todo") {
    console.log("\n── Fase REGISTRAR ──");
    const cliente = await resolverCliente();
    const usuario = await resolverUsuario();
    console.log(`  Cliente : ${cliente.nombre} (${cliente.id})`);
    console.log(`  Usuario : ${usuarioEmail} (${usuario.id})`);
    const resultados: ResultadoDo[] = [];
    for (const [cons, lista] of dos) {
      const r = await registrarDo(cons, lista, cliente.id, usuario.id, config.bucket);
      resultados.push(r);
      const extra = r.estado === "CONFLICTO" ? " ← ya existe un trámite REAL con este número; no se tocó" : "";
      console.log(`  ${cons.padEnd(15)} ${r.estado.padEnd(9)} docs nuevos ${String(r.documentosNuevos).padStart(4)} · ya registrados ${r.documentosExistentes}${r.sinObjeto ? ` · sin objeto en bodega ${r.sinObjeto}` : ""}${extra}`);
    }
    const creados = resultados.filter((r) => r.estado === "CREADO").length;
    const conflictos = resultados.filter((r) => r.estado === "CONFLICTO");
    const docs = resultados.reduce((a, r) => a + r.documentosNuevos, 0);
    const sinObjeto = resultados.reduce((a, r) => a + r.sinObjeto, 0);
    console.log(`\nTrámites creados ${creados} · existían ${resultados.filter((r) => r.estado === "EXISTIA").length} · conflictos ${conflictos.length} · documentos ${dry ? "a registrar" : "registrados"} ${docs}${sinObjeto ? ` · sin objeto en bodega ${sinObjeto} (corre --fase subir primero)` : ""}`);
    if (conflictos.length) {
      console.log("CONFLICTOS (decidir con Camila: borrar o renumerar el trámite existente):");
      for (const c of conflictos) console.log(`   ${c.consecutivo}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
