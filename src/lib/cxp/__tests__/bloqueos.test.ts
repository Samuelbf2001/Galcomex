/**
 * `bloquearTramites` (CxP v2, §B.5) contra Postgres real. Requiere DATABASE_URL
 * de una base de pruebas desechable; sin BD los tests se omiten.
 */
import "dotenv/config";

import { Ciudad, Rol, TipoCliente } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";

import { bloquearTramites } from "../bloqueos";

const PREFIJO = "vitest-cxp-bloqueos";
const runId = `${PREFIJO}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let disponible = false;
let userId = "";
let clienteId = "";
const tramites: string[] = [];

async function limpiar() {
  await prisma.tramiteDO.deleteMany({ where: { comentarios: { startsWith: PREFIJO } } });
  await prisma.cliente.deleteMany({ where: { nit: { startsWith: PREFIJO } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIJO } } });
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    await limpiar();
    const user = await prisma.user.create({
      data: { email: `${runId}@example.test`, name: "Vitest bloqueos", rol: Rol.ADMIN, emailVerified: true },
    });
    userId = user.id;
    const cliente = await prisma.cliente.create({
      data: { nombre: "CLIENTE BLOQUEOS", nit: `${PREFIJO}-${runId}`, tipo: TipoCliente.PROPIO },
    });
    clienteId = cliente.id;
    for (let numero = 1; numero <= 2; numero++) {
      const t = await prisma.tramiteDO.create({
        data: {
          consecutivo: `DO.BAQ04-${String(numero).padStart(4, "0")}-${runId}`,
          ciudad: Ciudad.BAQ,
          anio: 3004,
          numero: 900_000 + Math.floor(Math.random() * 90_000) + numero,
          clienteId,
          creadoPorId: userId,
          comentarios: `${PREFIJO}:${runId}`,
        },
      });
      tramites.push(t.id);
    }
    disponible = true;
  } catch {
    disponible = false;
  }
});

afterAll(async () => {
  if (disponible) await limpiar();
  await prisma.$disconnect();
});

describe("bloquearTramites", () => {
  it("devuelve los ids existentes ordenados, sin repetidos; [] si no hay ids", async (ctx) => {
    if (!disponible) ctx.skip("BD de pruebas no disponible");
    const [a, b] = [...tramites].sort();
    const r = await prisma.$transaction((tx) => bloquearTramites(tx, [b, a, b, "no-existe"]));
    expect(r).toEqual([a, b]);
    expect(await prisma.$transaction((tx) => bloquearTramites(tx, []))).toEqual([]);
  });

  it("el bloqueo dura hasta el fin de la transacción: otra transacción no puede tomar la fila (NOWAIT)", async (ctx) => {
    if (!disponible) ctx.skip("BD de pruebas no disponible");
    const id = tramites[0];
    let soltar: () => void = () => undefined;
    const esperar = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    let tomado: () => void = () => undefined;
    const bloqueado = new Promise<void>((resolve) => {
      tomado = resolve;
    });

    const tx1 = prisma.$transaction(
      async (tx) => {
        await bloquearTramites(tx, [id]);
        tomado();
        await esperar;
      },
      { timeout: 15_000 },
    );

    await bloqueado;
    await expect(
      prisma.$transaction((tx) => tx.$queryRaw`SELECT id FROM "tramite_do" WHERE id = ${id} FOR UPDATE NOWAIT`),
    ).rejects.toThrow();
    soltar();
    await tx1;

    // Liberado: ahora sí se puede tomar.
    const libre = await prisma.$transaction((tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id FROM "tramite_do" WHERE id = ${id} FOR UPDATE NOWAIT`,
    );
    expect(libre).toEqual([{ id }]);
  });
});
