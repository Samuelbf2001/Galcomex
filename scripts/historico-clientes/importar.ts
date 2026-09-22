/**
 * Histórico clientes 2026 — PASO 2: importar desde el manifiesto.
 *
 * Igual que `historico-litoplas/importar.ts`, pero para las 11 carpetas de
 * clientes de la entrega del 2026-09-21 y con estas diferencias:
 *   · cada fila del manifiesto trae su `cliente` (carpeta) y se resuelve a la
 *     empresa de producción con `CLIENTES` de `reglas.ts`; si no existe se
 *     crea (`--crear-clientes`) con el NIT de `--nits <json>` o un marcador
 *     `PENDIENTE-NIT-<X>` para que Camila lo complete;
 *   · agencia: MOVIADUANAS para Litoplas, COLDEX para los demás;
 *   · las claves conservan las subcarpetas del cliente
 *     (`tramites/<DO>/<CAT>/<sub…>/<archivo>`) y lo que está fuera de un DO
 *     sube a `clientes/<CLIENTE>/…` SIN registrar en la BD (solo explorador);
 *   · los DOs de Bogotá (`BGT`) solo se registran si el enum `Ciudad` de la
 *     BD ya tiene ese valor; si no, se reportan como PENDIENTE_BGT y se saltan
 *     (los archivos sí se suben);
 *   · un DO que ya existe como histórico del MISMO cliente recibe los
 *     documentos nuevos; si existe y NO es histórico o es de otro cliente →
 *     CONFLICTO, no se toca.
 *
 * Fases: --fase subir | registrar | todo (por defecto). --dry no escribe nada.
 *
 *   npx tsx --env-file=../r2-llaves.env scripts/historico-clientes/importar.ts --fase subir --paralelo 6
 *   docker exec <app> npx tsx scripts/historico-clientes/importar.ts --fase registrar --manifiesto /app/manifiesto.csv --crear-clientes --sin-verificar
 *
 * Opciones: --manifiesto <csv> · --raiz <carpeta "Archivos clientes"> · --solo DO.X,DO.Y · --solo-cliente "POLYREC ZF"
 *           --excluir DO.X · --limite N · --usuario <email> · --sin-verificar · --nits <json {carpeta: nit}>
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
import { mimePorExtension } from "../historico-litoplas/reglas";
import { CLIENTES } from "./reglas";

// ─── Argumentos ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const flag = (name: string) => args.includes(`--${name}`);

const manifiestoPath = opt("manifiesto") ?? path.resolve(process.cwd(), "..", "historico-clientes-2026", "manifiesto.csv");
const raiz = opt("raiz") ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\samue", "Downloads", "Archivos clientes");
const fase = (opt("fase") ?? "todo") as "subir" | "registrar" | "todo";
const dry = flag("dry");
const soloArg = opt("solo");
const solo = soloArg ? new Set(soloArg.split(",").map((s) => s.trim())) : null;
const soloCliente = opt("solo-cliente")?.toUpperCase();
const excluirArg = opt("excluir");
const excluir = excluirArg ? new Set(excluirArg.split(",").map((s) => s.trim())) : null;
const limite = opt("limite") ? Number(opt("limite")) : undefined;
const usuarioEmail = opt("usuario") ?? "importacion@galcomex.com";
const sinVerificar = flag("sin-verificar");
const crearClientes = flag("crear-clientes");
const nitsPath = opt("nits");
const paralelo = Math.max(1, Math.min(16, Number(opt("paralelo") ?? 4)));

async function enParalelo<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      await fn(item);
    }
  });
  await Promise.all(trabajadores);
}

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

type Fila = {
  cliente: string; rama: string; carpetaDo: string; consecutivo: string; ciudad: string; anio: number; numero: number;
  referencia: string; im: string; mov: string; proveedor: string; oc: string; subcarpetas: string; rutaRelativa: string;
  nombre: string; ext: string; bytes: number; sha256: string; categoria: string; regla: string; destinoKey: string;
  accion: string; nota: string;
};

function aFila(r: Record<string, string>): Fila {
  return {
    cliente: r.cliente, rama: r.rama, carpetaDo: r.carpeta_do, consecutivo: r.consecutivo, ciudad: r.ciudad,
    anio: Number(r.anio || 0), numero: Number(r.numero || 0), referencia: r.referencia, im: r.im, mov: r.mov,
    proveedor: r.proveedor, oc: r.oc, subcarpetas: r.subcarpetas, rutaRelativa: r.ruta_relativa, nombre: r.nombre,
    ext: r.ext, bytes: Number(r.bytes || 0), sha256: r.sha256, categoria: r.categoria, regla: r.regla,
    destinoKey: r.destino_key, accion: r.accion, nota: r.nota,
  };
}

// ─── Bodega ──────────────────────────────────────────────────────────────────

async function existeObjeto(bucket: string, key: string): Promise<number | null> {
  try {
    return (await getStorageClient().statObject(bucket, key)).size;
  } catch {
    return null;
  }
}

async function subirArchivo(bucket: string, f: Fila): Promise<"subido" | "ya-estaba" | "falta-origen"> {
  const origen = path.join(raiz, f.cliente, ...f.rutaRelativa.split("/"));
  let tam: number;
  try { tam = (await stat(origen)).size; } catch { return "falta-origen"; }
  const actual = await existeObjeto(bucket, f.destinoKey);
  if (actual !== null && actual === tam) return "ya-estaba";
  if (dry) return "subido";
  await getStorageClient().putObject(bucket, f.destinoKey, createReadStream(origen), tam, { "Content-Type": mimePorExtension(f.ext) });
  return "subido";
}

// ─── Base de datos ───────────────────────────────────────────────────────────

type ClienteResuelto = { id: string; nombre: string; origen: "EXISTIA" | "CREADO" | "DRY" };

async function resolverCliente(carpeta: string, nits: Record<string, string>): Promise<ClienteResuelto | null> {
  const def = CLIENTES[carpeta];
  if (!def) return null;
  const candidatos = await prisma.cliente.findMany({
    where: { nombre: { contains: def.buscar, mode: "insensitive" } },
    select: { id: true, nombre: true },
  });
  if (candidatos.length === 1) return { ...candidatos[0], origen: "EXISTIA" };
  if (candidatos.length > 1) {
    throw new Error(`Hay ${candidatos.length} empresas con "${def.buscar}": ${candidatos.map((c) => `${c.nombre} (${c.id})`).join(", ")}.`);
  }
  if (!crearClientes) return null;
  if (dry) return { id: "(se crearía)", nombre: def.nombre, origen: "DRY" };
  const nit = nits[carpeta] ?? `PENDIENTE-NIT-${carpeta.replace(/\s+/g, "-")}`;
  const creado = await prisma.cliente.create({
    data: { nombre: def.nombre, nit, tipo: "PROPIO", esCliente: true, esProveedor: false },
    select: { id: true, nombre: true },
  });
  return { ...creado, origen: "CREADO" };
}

async function resolverUsuario(): Promise<{ id: string }> {
  const existente = await prisma.user.findUnique({ where: { email: usuarioEmail }, select: { id: true } });
  if (existente) return existente;
  if (dry) return { id: "(se crearía)" };
  const clave = await hashPassword(randomBytes(24).toString("base64url"));
  return prisma.user.create({
    data: {
      email: usuarioEmail, name: "Importación histórico", emailVerified: true, rol: Rol.OPERATIVO,
      accounts: { create: { accountId: usuarioEmail, providerId: "credential", password: clave } },
    },
    select: { id: true },
  });
}

async function ciudadesDeLaBd(): Promise<Set<string>> {
  const filas = await prisma.$queryRaw<{ enumlabel: string }[]>`
    select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'Ciudad'`;
  return new Set(filas.map((f) => f.enumlabel));
}

type ResultadoDo = {
  cliente: string;
  consecutivo: string;
  estado: "CREADO" | "EXISTIA" | "CONFLICTO" | "PENDIENTE_BGT" | "DRY";
  documentosNuevos: number;
  documentosExistentes: number;
  sinObjeto: number;
  detalle?: string;
};

async function registrarDo(
  consecutivo: string,
  filas: Fila[],
  cliente: ClienteResuelto,
  usuarioId: string,
  bucket: string,
  ciudades: Set<string>,
): Promise<ResultadoDo> {
  const p = filas[0];
  const res: ResultadoDo = { cliente: p.cliente, consecutivo, estado: "DRY", documentosNuevos: 0, documentosExistentes: 0, sinObjeto: 0 };
  const facturaVenta = filas.some((f) => /BAQ[ -]?1\d{4}/i.test(f.nombre));
  const def = CLIENTES[p.cliente];

  if (!ciudades.has(p.ciudad)) {
    res.estado = "PENDIENTE_BGT";
    res.detalle = `la BD no tiene la ciudad ${p.ciudad} en el enum Ciudad (falta desplegar la migración)`;
    return res;
  }

  let tramite = await prisma.tramiteDO.findUnique({ where: { consecutivo }, select: { id: true, esHistorico: true, clienteId: true } });
  if (tramite && (!tramite.esHistorico || tramite.clienteId !== cliente.id)) {
    res.estado = "CONFLICTO";
    res.detalle = !tramite.esHistorico ? "existe un trámite REAL con este número" : "el histórico existente es de OTRA empresa";
    return res;
  }

  if (!tramite) {
    if (dry) { res.estado = "DRY"; }
    else {
      const comentarios = [
        `Importado del archivo histórico Drive 2026 (entrega 2026-09-21) · cliente "${p.cliente}" · carpeta "${p.carpetaDo}" · rama ${p.rama}`,
        def.intermediario ? "Coldex actúa como cliente intermediario: el cliente final va en la referencia externa." : "",
      ].filter(Boolean).join("\n");
      const creado = await prisma.tramiteDO.create({
        data: {
          consecutivo,
          tipoTramiteCodigo: "IMPORTACION",
          ciudad: p.ciudad as Ciudad,
          anio: p.anio,
          numero: p.numero,
          clienteId: cliente.id,
          proveedorCliente: p.proveedor || null,
          agenciaAduanas: def.agencia === "MOVIADUANAS" ? AgenciaAduanas.MOVIADUANAS : AgenciaAduanas.COLDEX,
          doAgencia: p.mov || null,
          doCliente: p.im || null,
          referenciaExterna: (p.im || p.referencia || null)?.slice(0, 200) ?? null,
          ordenCompraNumero: p.oc || null,
          estado: facturaVenta ? EstadoTramite.FACTURADO : EstadoTramite.EN_TRAMITE,
          esHistorico: true,
          comentarios,
          creadoPorId: usuarioId,
        },
        select: { id: true, esHistorico: true, clienteId: true },
      });
      await prisma.auditLog.create({
        data: {
          entidad: "TramiteDO", entidadId: creado.id, accion: "IMPORT_HISTORICO", usuarioId, tramiteId: creado.id,
          despues: { consecutivo, cliente: p.cliente, carpeta: p.carpetaDo, rama: p.rama, referencia: p.referencia, im: p.im, mov: p.mov, proveedor: p.proveedor, entrega: "2026-09-21" },
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
  console.log("Histórico clientes 2026 — importación");
  console.log(`  Manifiesto : ${manifiestoPath}`);
  console.log(`  Archivos   : ${raiz}`);
  console.log(`  Bodega     : ${bodega.nombreProveedor} · ${bodega.endpoint} · bucket ${bodega.bucket}`);
  console.log(`  Fase       : ${fase}${dry ? " (DRY, no escribe nada)" : ""}`);
  if (solo) console.log(`  Solo       : ${[...solo].join(", ")}`);
  if (soloCliente) console.log(`  Cliente    : ${soloCliente}`);
  if (excluir) console.log(`  Excluir    : ${[...excluir].join(", ")}`);
  if (limite) console.log(`  Límite     : ${limite} DOs`);
  console.log("");

  const todas = parsearCsv(await readFile(manifiestoPath, "utf8")).map(aFila)
    .filter((f) => !soloCliente || f.cliente.toUpperCase() === soloCliente);
  const porDo = new Map<string, Fila[]>();
  const sueltos: Fila[] = [];
  for (const f of todas) {
    if (f.accion === "SUBIR_SUELTO") { if (!solo) sueltos.push(f); continue; }
    if (!f.consecutivo) continue;
    if (solo && !solo.has(f.consecutivo)) continue;
    if (excluir?.has(f.consecutivo)) continue;
    const l = porDo.get(f.consecutivo) ?? [];
    l.push(f);
    porDo.set(f.consecutivo, l);
  }
  let dos = [...porDo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (limite) dos = dos.slice(0, limite);
  console.log(`DOs en el manifiesto a procesar: ${dos.length} · archivos sueltos: ${sueltos.length}`);

  if (fase === "subir" || fase === "todo") {
    console.log("\n── Fase SUBIR ──");
    let subidos = 0, yaEstaban = 0, faltan = 0, errores = 0, bytes = 0;
    const inicio = Date.now();
    console.log(`  (${paralelo} subidas simultáneas)`);
    const grupos: [string, Fila[]][] = [...dos.map(([c, l]) => [c, l.filter((f) => f.accion === "SUBIR" && f.destinoKey)] as [string, Fila[]])];
    if (sueltos.length) grupos.push(["(sueltos clientes/…)", sueltos]);
    for (const [nombre, aSubir] of grupos) {
      let s = 0, y = 0, fa = 0, e = 0, b = 0;
      await enParalelo(aSubir, paralelo, async (f) => {
        try {
          const r = await subirArchivo(config.bucket, f);
          if (r === "subido") { s += 1; b += f.bytes; } else if (r === "ya-estaba") y += 1; else fa += 1;
        } catch (error) {
          e += 1;
          console.log(`    ERROR ${f.destinoKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      subidos += s; yaEstaban += y; faltan += fa; errores += e; bytes += b;
      const seg = Math.max(1, Math.round((Date.now() - inicio) / 1000));
      console.log(
        `  ${nombre.padEnd(22)} ${String(aSubir.length).padStart(4)} archivos · subidos ${s} · ya estaban ${y}${fa ? ` · SIN ORIGEN ${fa}` : ""}${e ? ` · ERRORES ${e}` : ""}` +
          ` · ${(b / 1048576).toFixed(0)} MB · acumulado ${(bytes / 1048576).toFixed(0)} MB a ${(bytes / 1048576 / seg).toFixed(2)} MB/s`,
      );
    }
    const seg = Math.round((Date.now() - inicio) / 1000);
    console.log(`Subidos ${subidos} (${(bytes / 1048576).toFixed(0)} MB) · ya estaban ${yaEstaban} · sin origen ${faltan} · errores ${errores} · ${seg} s`);
    if (errores) console.log("Hubo errores: relanza la misma orden; los objetos ya subidos se saltan.");
  }

  if (fase === "registrar" || fase === "todo") {
    console.log("\n── Fase REGISTRAR ──");
    const nits: Record<string, string> = nitsPath ? JSON.parse(await readFile(nitsPath, "utf8")) : {};
    const usuario = await resolverUsuario();
    const ciudades = await ciudadesDeLaBd();
    console.log(`  Usuario  : ${usuarioEmail} (${usuario.id})`);
    console.log(`  Ciudades : ${[...ciudades].join(", ")}`);
    const clientesCache = new Map<string, ClienteResuelto | null>();
    const resultados: ResultadoDo[] = [];
    for (const [cons, lista] of dos) {
      const carpeta = lista[0].cliente;
      if (!clientesCache.has(carpeta)) {
        const c = await resolverCliente(carpeta, nits);
        clientesCache.set(carpeta, c);
        console.log(`  Empresa "${carpeta}" → ${c ? `${c.nombre} (${c.id}) ${c.origen}` : "NO EXISTE (usa --crear-clientes)"}`);
      }
      const cliente = clientesCache.get(carpeta);
      if (!cliente) {
        resultados.push({ cliente: carpeta, consecutivo: cons, estado: "CONFLICTO", documentosNuevos: 0, documentosExistentes: 0, sinObjeto: 0, detalle: "empresa inexistente" });
        continue;
      }
      const r = await registrarDo(cons, lista, cliente, usuario.id, config.bucket, ciudades);
      resultados.push(r);
      console.log(`  ${cons.padEnd(15)} ${carpeta.padEnd(26)} ${r.estado.padEnd(13)} docs nuevos ${String(r.documentosNuevos).padStart(4)} · ya registrados ${r.documentosExistentes}${r.sinObjeto ? ` · sin objeto en bodega ${r.sinObjeto}` : ""}${r.detalle ? ` ← ${r.detalle}` : ""}`);
    }
    const n = (e: ResultadoDo["estado"]) => resultados.filter((r) => r.estado === e).length;
    const docs = resultados.reduce((a, r) => a + r.documentosNuevos, 0);
    const sinObjeto = resultados.reduce((a, r) => a + r.sinObjeto, 0);
    console.log(`\nTrámites creados ${n("CREADO")} · existían ${n("EXISTIA")} · conflictos ${n("CONFLICTO")} · pendientes BGT ${n("PENDIENTE_BGT")} · documentos ${dry ? "a registrar" : "registrados"} ${docs}${sinObjeto ? ` · sin objeto en bodega ${sinObjeto} (corre --fase subir primero)` : ""}`);
    const conflictos = resultados.filter((r) => r.estado === "CONFLICTO");
    if (conflictos.length) {
      console.log("CONFLICTOS:");
      for (const c of conflictos) console.log(`   ${c.consecutivo} (${c.cliente}) — ${c.detalle}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
