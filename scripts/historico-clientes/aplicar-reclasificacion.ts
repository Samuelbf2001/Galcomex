/**
 * Aplica en la BD las categorías que la IA decidió para documentos que YA
 * estaban registrados en OTRO (`ia-prod.csv` de `clasificar-ia.ts --prod`).
 * Solo toca filas que SIGAN en OTRO: nunca reclasifica lo que ya tiene
 * categoría. Deja `AuditLog Documento/RECLASIFICAR` por cada cambio (única
 * forma de deshacerlo) y NO mueve objetos en la bodega (misma decisión que
 * `scripts/reclasificar-otros.ts`).
 *
 *   npx tsx scripts/historico-clientes/aplicar-reclasificacion.ts --csv /app/ia-prod.csv            # SIMULA
 *   npx tsx scripts/historico-clientes/aplicar-reclasificacion.ts --csv /app/ia-prod.csv --aplicar
 */
import "dotenv/config";

import { CategoriaDocumento, Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";

import { prisma } from "../../src/lib/db/prisma";

const args = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const csvPath = opt("csv");
const aplicar = args.includes("--aplicar");
const umbral = Number(opt("umbral") ?? 0.6);

function parsearCsv(texto: string): Record<string, string>[] {
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

async function main() {
  if (!csvPath) throw new Error("Falta --csv <ia-prod.csv>");
  const filas = parsearCsv(await readFile(csvPath, "utf8"));
  const validas = new Set(Object.values(CategoriaDocumento));
  const candidatos = filas.filter((f) => f.categoria && f.categoria !== "OTRO" && validas.has(f.categoria as CategoriaDocumento) && Number(f.confianza) >= umbral);
  console.log(aplicar ? "— APLICANDO —" : "— SIMULACIÓN (usa --aplicar) —");
  console.log(`Filas en el CSV: ${filas.length} · con categoría y confianza ≥ ${umbral}: ${candidatos.length}`);

  const admin = await prisma.user.findFirst({ where: { rol: "ADMIN" }, select: { id: true }, orderBy: { createdAt: "asc" } });
  if (!admin) throw new Error("No hay ADMIN para firmar el AuditLog");

  const docs = await prisma.documento.findMany({
    where: { id: { in: candidatos.map((c) => c.id) }, categoria: CategoriaDocumento.OTRO, eliminado: false },
    select: { id: true, tramiteId: true, nombreArchivo: true, storageKey: true },
  });
  const porId = new Map(docs.map((d) => [d.id, d]));
  const aplicables = candidatos.filter((c) => porId.has(c.id));
  console.log(`Siguen en OTRO (se pueden cambiar): ${aplicables.length}`);

  const porCat = new Map<string, number>();
  for (const c of aplicables) porCat.set(c.categoria, (porCat.get(c.categoria) ?? 0) + 1);
  console.table([...porCat.entries()].sort((a, b) => b[1] - a[1]).map(([categoria, n]) => ({ categoria, documentos: n })));
  for (const c of aplicables.slice(0, 15)) console.log(`  · ${c.categoria.padEnd(22)} ${c.confianza}  ${porId.get(c.id)!.nombreArchivo}`);

  if (!aplicar || !aplicables.length) return;

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const c of aplicables) {
    const d = porId.get(c.id)!;
    ops.push(prisma.documento.update({ where: { id: c.id }, data: { categoria: c.categoria as CategoriaDocumento } }));
    ops.push(prisma.auditLog.create({
      data: {
        entidad: "Documento", entidadId: c.id, accion: "RECLASIFICAR", usuarioId: admin.id, tramiteId: d.tramiteId,
        antes: { categoria: CategoriaDocumento.OTRO },
        despues: { categoria: c.categoria, regla: "IA (Haiku/luna) 2026-09-21", confianza: Number(c.confianza), razon: c.razon, nombreArchivo: d.nombreArchivo, storageKey: d.storageKey },
      },
    }));
  }
  await prisma.$transaction(ops);
  console.log(`✓ ${aplicables.length} documentos reclasificados (AuditLog RECLASIFICAR). La bodega no se tocó.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
