/**
 * Verifica de punta a punta el almacenamiento configurado en `.env`
 * (MinIO local, Cloudflare R2, Backblaze B2, Amazon S3…) haciendo cada
 * operación que la app usa contra el bucket, con las mismas funciones de
 * `src/lib/storage/`: existe el bucket → subir (buffer y streaming, como
 * `/api/storage/objeto`) → consultar → descargar y comparar bytes → 404 de un
 * archivo inexistente → mover de carpeta (recategorizar) → papelera
 * (`deleted/`) → listar recursivo y por nivel (explorador) → borrar.
 * Con `--grande` además sube 70 MB para probar la subida por partes que usa
 * el importador del histórico con archivos de más de 64 MB.
 *
 * En palabras simples: "¿la app puede guardar, mover, esconder y volver a leer
 * archivos en esta bodega?". Si todo sale ✅ se puede apuntar producción a ese
 * proveedor.
 *
 * Uso:
 *   npx tsx scripts/verificar-storage.ts                                   # con el .env del proyecto
 *   npx tsx --env-file=../r2-llaves.env scripts/verificar-storage.ts       # contra otra bodega
 *   npx tsx scripts/verificar-storage.ts --grande                          # + subida por partes (70 MB)
 *   docker exec <contenedor-app> npx tsx scripts/verificar-storage.ts      # en prod
 *
 * Solo escribe bajo `tramites/_verificacion/<uuid>/` (y su copia en `deleted/`)
 * y borra lo que crea. Sale con código 1 si algún paso falla.
 */
import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { BucketItem } from "minio";

import { getStorageClient } from "../src/lib/storage/client";
import { getStorageConfig, resumenStorage } from "../src/lib/storage/config";
import { moveStorageObject, softDeleteStorageObject } from "../src/lib/storage/service";

type Paso = { nombre: string; explicacion: string; correr: () => Promise<string | void> };

const MB = 1024 * 1024;
/** minio-js parte en trozos de 64 MB: 70 MB obliga a una subida por partes. */
const BYTES_GRANDE = 70 * MB;

function ahora(): string {
  return new Date().toISOString();
}

async function leerTodo(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const trozo of stream) partes.push(Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo));
  return Buffer.concat(partes);
}

async function listar(
  bucket: string,
  prefix: string,
  recursivo: boolean,
): Promise<{ archivos: string[]; carpetas: string[] }> {
  const stream = getStorageClient().listObjectsV2(bucket, prefix, recursivo);
  const archivos: string[] = [];
  const carpetas: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (item: BucketItem) => {
      if (item.prefix) carpetas.push(item.prefix);
      else if (item.name) archivos.push(item.name);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { archivos, carpetas };
}

function codigoDeError(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

async function existe(bucket: string, clave: string): Promise<boolean> {
  try {
    await getStorageClient().statObject(bucket, clave);
    return true;
  } catch (error) {
    const codigo = codigoDeError(error);
    if (codigo === "NotFound" || codigo === "NoSuchKey") return false;
    throw error;
  }
}

/** Flujo de `bytes` bytes con un patrón distinto por MB; va calculando su SHA-256. */
function flujoDePrueba(bytes: number, hash: ReturnType<typeof createHash>): Readable {
  let enviados = 0;
  return new Readable({
    read() {
      if (enviados >= bytes) {
        this.push(null);
        return;
      }
      const n = Math.min(MB, bytes - enviados);
      const trozo = Buffer.alloc(n, Math.floor(enviados / MB) % 251);
      hash.update(trozo);
      enviados += n;
      this.push(trozo);
    },
  });
}

async function hashDe(stream: NodeJS.ReadableStream): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const trozo of stream) {
    const b = Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo);
    hash.update(b);
    bytes += b.length;
  }
  return { hash: hash.digest("hex"), bytes };
}

async function main(): Promise<void> {
  const grande = process.argv.includes("--grande");
  const config = getStorageConfig();
  const resumen = resumenStorage(config);
  const cliente = getStorageClient();
  const { bucket } = config;

  console.log("Verificación del almacenamiento de documentos");
  console.log(`  Proveedor : ${resumen.nombreProveedor} (${resumen.proveedor})`);
  console.log(`  Endpoint  : ${resumen.endpoint}`);
  console.log(`  Bucket    : ${resumen.bucket}`);
  console.log(`  Región    : ${resumen.region ?? "(por defecto)"}`);
  console.log(`  Path-style: ${config.pathStyle ? "sí" : "no"}`);
  console.log("");

  const base = `tramites/_verificacion/${randomUUID()}/`;
  const clave = `${base}OTRO/buffer.pdf`;
  const claveStream = `${base}OTRO/stream.pdf`;
  const claveMovida = `${base}BL/movido.pdf`;
  const claveGrande = `${base}OTRO/grande.pdf`;
  /** Todo lo que se crea, para limpiar pase lo que pase. */
  const creadas = new Set<string>();
  const contenido = Buffer.from(`%PDF-1.4\n% prueba galcomex ${ahora()}\n%%EOF\n`);

  const pasos: Paso[] = [
    {
      nombre: "El bucket existe",
      explicacion: "La app puede ver la bodega con estas llaves.",
      correr: async () => {
        const hay = await cliente.bucketExists(bucket);
        if (!hay) throw new Error(`El bucket "${bucket}" no existe o las llaves no lo pueden ver`);
      },
    },
    {
      nombre: "Subir un archivo",
      explicacion: "Lo que hacen los scripts de importación.",
      correr: async () => {
        creadas.add(clave);
        await cliente.putObject(bucket, clave, contenido, contenido.length, { "Content-Type": "application/pdf" });
        return `${contenido.length} bytes → ${clave}`;
      },
    },
    {
      nombre: "Subir en streaming",
      explicacion: "Es lo que pasa cuando alguien adjunta un documento a un DO (`/api/storage/objeto`).",
      correr: async () => {
        creadas.add(claveStream);
        await cliente.putObject(bucket, claveStream, Readable.from([contenido]), contenido.length, {
          "Content-Type": "application/pdf",
        });
      },
    },
    {
      nombre: "Consultar el archivo (stat)",
      explicacion: "Tamaño y tipo coinciden con lo subido; la descarga usa el tipo para abrir el PDF.",
      correr: async () => {
        const stat = await cliente.statObject(bucket, claveStream);
        if (stat.size !== contenido.length) throw new Error(`tamaño ${stat.size} ≠ ${contenido.length}`);
        const tipo = stat.metaData?.["content-type"];
        if (tipo !== "application/pdf") throw new Error(`content-type "${tipo}" en vez de application/pdf`);
        return `size=${stat.size} content-type=${tipo}`;
      },
    },
    {
      nombre: "Descargar y comparar bytes",
      explicacion: "Lo que baja es exactamente lo que subió.",
      correr: async () => {
        const bajado = await leerTodo(await cliente.getObject(bucket, claveStream));
        if (!bajado.equals(contenido)) throw new Error("los bytes descargados no coinciden");
        return `${bajado.length} bytes iguales`;
      },
    },
    {
      nombre: "Archivo inexistente",
      explicacion: "La app debe poder decir \"el archivo no existe\" (404) en vez de un error genérico.",
      correr: async () => {
        let codigo: string | undefined;
        try {
          await cliente.statObject(bucket, `${base}no-existe.pdf`);
        } catch (error) {
          codigo = codigoDeError(error);
        }
        if (codigo !== "NotFound" && codigo !== "NoSuchKey") {
          throw new Error(`código ${codigo ?? "(ninguno: respondió como si existiera)"}; la app mostraría 502`);
        }
        return `código ${codigo} → 404`;
      },
    },
    {
      nombre: "Mover de carpeta (recategorizar)",
      explicacion: "Cambiar la categoría de un documento lo mueve de `OTRO/` a `BL/` en la bodega.",
      correr: async () => {
        creadas.add(claveMovida);
        await moveStorageObject({ from: claveStream, to: claveMovida });
        if (await existe(bucket, claveStream)) throw new Error("el original sigue en su carpeta");
        if (!(await existe(bucket, claveMovida))) throw new Error("no llegó a la carpeta nueva");
      },
    },
    {
      nombre: "Eliminar a la papelera",
      explicacion: "Eliminar un documento en la app lo copia a `deleted/` con quién y cuándo, y quita el original.",
      correr: async () => {
        const r = await softDeleteStorageObject({ storageKey: clave, deletedBy: "verificacion" });
        creadas.add(r.deletedStorageKey);
        if (await existe(bucket, clave)) throw new Error("el original no se quitó");
        const stat = await cliente.statObject(bucket, r.deletedStorageKey);
        const quien = stat.metaData?.["deleted-by"];
        return `→ ${r.deletedStorageKey} (metadatos ${quien === "verificacion" ? "conservados" : "no devueltos por el proveedor"})`;
      },
    },
    {
      nombre: "Listar todo (recursivo)",
      explicacion: "La API de storage y los importadores listan así.",
      correr: async () => {
        const { archivos } = await listar(bucket, base, true);
        if (!archivos.includes(claveMovida)) throw new Error(`falta ${claveMovida} (${archivos.length} encontrados)`);
        return `${archivos.length} objeto(s) bajo ${base}`;
      },
    },
    {
      nombre: "Listar un nivel (explorador de Archivos)",
      explicacion: "La pantalla Archivos pide una carpeta a la vez y necesita ver las subcarpetas.",
      correr: async () => {
        const { carpetas, archivos } = await listar(bucket, base, false);
        if (!carpetas.includes(`${base}BL/`)) throw new Error(`no aparece la carpeta BL/ (carpetas: ${carpetas.join(", ")})`);
        if (archivos.length) throw new Error("mezcló archivos de subcarpetas en el nivel");
        return `carpetas: ${carpetas.map((c) => c.slice(base.length)).join(", ")}`;
      },
    },
  ];

  if (grande) {
    pasos.push({
      nombre: "Subida por partes (70 MB)",
      explicacion: "El histórico tiene PDF y ZIP de hasta ~1 GB; por encima de 64 MB se suben en partes.",
      correr: async () => {
        creadas.add(claveGrande);
        const hashSubida = createHash("sha256");
        const inicio = Date.now();
        await cliente.putObject(bucket, claveGrande, flujoDePrueba(BYTES_GRANDE, hashSubida), BYTES_GRANDE, {
          "Content-Type": "application/pdf",
        });
        const segundos = (Date.now() - inicio) / 1000;
        const stat = await cliente.statObject(bucket, claveGrande);
        if (stat.size !== BYTES_GRANDE) throw new Error(`tamaño ${stat.size} ≠ ${BYTES_GRANDE}`);
        const bajado = await hashDe(await cliente.getObject(bucket, claveGrande));
        if (bajado.hash !== hashSubida.digest("hex")) throw new Error("el contenido descargado no coincide");
        return `70 MB en ${segundos.toFixed(1)} s, etag ${stat.etag} (sufijo -N = por partes), bytes iguales`;
      },
    });
  }

  pasos.push({
    nombre: "Borrar lo creado",
    explicacion: "El bucket queda como estaba.",
    correr: async () => {
      for (const k of creadas) await cliente.removeObject(bucket, k);
      const restantes = (await listar(bucket, base, true)).archivos.length;
      if (restantes) throw new Error(`quedaron ${restantes} objeto(s) de prueba`);
      creadas.clear();
    },
  });

  let fallos = 0;
  for (const paso of pasos) {
    const inicio = Date.now();
    try {
      const detalle = await paso.correr();
      console.log(`✅ ${paso.nombre} (${Date.now() - inicio} ms)${detalle ? ` — ${detalle}` : ""}`);
    } catch (error) {
      fallos += 1;
      const mensaje = error instanceof Error ? error.message : String(error);
      console.log(`❌ ${paso.nombre} — ${mensaje}`);
      console.log(`   Qué significa: ${paso.explicacion}`);
      if (paso.nombre === "El bucket existe") {
        console.log("   Sin bucket no tiene sentido seguir. Revisa MINIO_ENDPOINT, MINIO_BUCKET y las llaves.");
        break;
      }
    }
  }

  // Limpieza de emergencia por si algo falló a mitad de camino.
  for (const k of creadas) {
    try {
      await cliente.removeObject(bucket, k);
    } catch {
      // ya no existe
    }
  }

  console.log("");
  if (fallos === 0) {
    console.log(`Todo en orden: la app puede usar ${resumen.nombreProveedor} como almacenamiento.`);
    return;
  }
  console.log(`${fallos} paso(s) fallaron. No apuntes producción a este proveedor hasta resolverlo.`);
  process.exitCode = 1;
}

main().catch((error) => {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`❌ No se pudo ni empezar: ${mensaje}`);
  process.exitCode = 1;
});
