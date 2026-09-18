/**
 * Reclasifica los documentos que quedaron en la categoría OTRO aplicando las
 * reglas por nombre de archivo (`src/lib/documentos/clasificador-nombre.ts`).
 *
 *   npx tsx scripts/reclasificar-otros.ts                 # SIMULA (por defecto)
 *   npx tsx scripts/reclasificar-otros.ts --aplicar       # escribe los cambios
 *   npx tsx scripts/reclasificar-otros.ts --tramite DO.BAQ26-0037
 *   npx tsx scripts/reclasificar-otros.ts --lote 200      # tamaño del lote (default 500)
 *
 * Por defecto NO escribe nada: imprime la tabla categoría → conteo y 10
 * ejemplos por categoría para que alguien los revise antes de aplicar.
 *
 * SOBRE LA BODEGA (S3/MinIO/R2): el script NO mueve objetos. La `storageKey`
 * sigue diciendo `tramites/<DO>/OTRO/<uuid>.<ext>` aunque la fila pase a, por
 * ejemplo, CONTROL_TRAMITE. Es aceptable y deliberado:
 *   · La clave es un identificador opaco. La app nunca lista carpetas para
 *     mostrar documentos: sirve cada archivo por enlace firmado a partir de la
 *     fila de `documento` (`lib/storage/proxy.ts`), y el explorador de archivos
 *     muestra la categoría de la fila, no la de la carpeta.
 *   · Mover miles de objetos en R2 es copy + delete: cuesta, tarda y no es
 *     reversible si algo falla a la mitad. Reclasificar una fila sí lo es.
 *   · Los documentos nuevos se siguen guardando en la carpeta de su categoría,
 *     así que la divergencia se congela en lo ya importado.
 *
 * Con `--aplicar` cada cambio queda en `AuditLog` (entidad `Documento`, acción
 * `RECLASIFICAR`) con la categoría anterior y la nueva, que es la única forma
 * de deshacerlo.
 *
 * Ver docs/CATALOGOS.md §4.
 */

import "dotenv/config";

import { CategoriaDocumento, Prisma } from "@prisma/client";

import { prisma } from "../src/lib/db/prisma";
import { clasificarPorNombre } from "../src/lib/documentos/clasificador-nombre";

interface Candidato {
  id: string;
  tramiteId: string;
  nombreArchivo: string;
  storageKey: string;
  propuesta: CategoriaDocumento;
}

function extensionDe(nombreArchivo: string, storageKey: string): string {
  const deNombre = nombreArchivo.match(/\.([^.]+)$/)?.[1];
  if (deNombre) return deNombre.toLowerCase();
  return storageKey.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
}

function leerEntero(bandera: string, porDefecto: number): number {
  const i = process.argv.indexOf(bandera);
  if (i === -1) return porDefecto;
  const valor = Number(process.argv[i + 1]);
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto;
}

function leerTexto(bandera: string): string | null {
  const i = process.argv.indexOf(bandera);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main() {
  const aplicar = process.argv.includes("--aplicar");
  const lote = leerEntero("--lote", 500);
  const consecutivo = leerTexto("--tramite");

  const documentos = await prisma.documento.findMany({
    where: {
      categoria: CategoriaDocumento.OTRO,
      eliminado: false,
      ...(consecutivo ? { tramite: { consecutivo } } : {}),
    },
    select: { id: true, tramiteId: true, nombreArchivo: true, storageKey: true },
    orderBy: { createdAt: "asc" },
  });

  const candidatos: Candidato[] = [];
  for (const d of documentos) {
    const propuesta = clasificarPorNombre(
      d.nombreArchivo,
      extensionDe(d.nombreArchivo, d.storageKey),
      d.storageKey,
    );
    if (propuesta && propuesta !== CategoriaDocumento.OTRO) {
      candidatos.push({ ...d, propuesta });
    }
  }

  const porCategoria = new Map<CategoriaDocumento, Candidato[]>();
  for (const c of candidatos) {
    const lista = porCategoria.get(c.propuesta) ?? [];
    lista.push(c);
    porCategoria.set(c.propuesta, lista);
  }

  console.log(aplicar ? "— APLICANDO —" : "— SIMULACIÓN (nada se escribió; usa --aplicar) —");
  console.log(
    `Documentos en OTRO${consecutivo ? ` del trámite ${consecutivo}` : ""}: ${documentos.length}`,
  );
  console.log(`Con categoría propuesta: ${candidatos.length}`);
  console.log(`Se quedan en OTRO: ${documentos.length - candidatos.length}\n`);

  const filas = [...porCategoria.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([categoria, lista]) => ({ categoria, documentos: lista.length }));
  console.table(filas);

  for (const [categoria, lista] of [...porCategoria.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`\n### ${categoria} (${lista.length}) — 10 ejemplos`);
    for (const c of lista.slice(0, 10)) console.log(`  · ${c.nombreArchivo}`);
  }

  if (!aplicar || candidatos.length === 0) {
    if (!aplicar) console.log("\nNada se escribió. Vuelve a correrlo con --aplicar.");
    return;
  }

  let actualizados = 0;
  for (let i = 0; i < candidatos.length; i += lote) {
    const bloque = candidatos.slice(i, i + lote);
    const operaciones: Prisma.PrismaPromise<unknown>[] = [];

    for (const c of bloque) {
      operaciones.push(
        prisma.documento.update({
          where: { id: c.id },
          data: { categoria: c.propuesta },
        }),
      );
      operaciones.push(
        prisma.auditLog.create({
          data: {
            entidad: "Documento",
            entidadId: c.id,
            accion: "RECLASIFICAR",
            usuarioId: USUARIO_ID,
            tramiteId: c.tramiteId,
            antes: { categoria: CategoriaDocumento.OTRO },
            despues: {
              categoria: c.propuesta,
              regla: "clasificarPorNombre",
              nombreArchivo: c.nombreArchivo,
              // La bodega no se toca: la clave conserva la carpeta vieja.
              storageKey: c.storageKey,
            },
          },
        }),
      );
    }

    await prisma.$transaction(operaciones);
    actualizados += bloque.length;
    console.log(`  lote ${i / lote + 1}: ${actualizados}/${candidatos.length}`);
  }

  console.log(`\n✓ ${actualizados} documentos reclasificados. Los objetos de la bodega no se movieron.`);
}

/**
 * Autor del cambio para el AuditLog: el primer ADMIN. Es un proceso de datos,
 * no una acción de usuario, pero `AuditLog.usuarioId` tiene FK obligatoria.
 */
let USUARIO_ID = "";

async function resolverUsuario(): Promise<void> {
  const admin = await prisma.user.findFirst({
    where: { rol: "ADMIN" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) {
    throw new Error("No hay ningún usuario ADMIN para firmar el AuditLog. Corre el seed primero.");
  }
  USUARIO_ID = admin.id;
}

(process.argv.includes("--aplicar") ? resolverUsuario() : Promise.resolve())
  .then(main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
