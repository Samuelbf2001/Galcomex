import { Prisma, type Beneficiario } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export type { Beneficiario };

/**
 * Serializa un snapshot a JSON apto para columnas Json de Prisma, convirtiendo
 * BigInt → string. Mismo replacer usado en el resto de services.
 */
function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

export type CrearBeneficiarioInput = {
  nombre: string;
  nit?: string | null;
  banco?: string | null;
  numCuenta?: string | null;
};

export class BeneficiarioNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Beneficiario ${id} no encontrado`);
    this.name = "BeneficiarioNoEncontradoError";
  }
}

export async function listarBeneficiarios(query?: string, empresaId?: string): Promise<Beneficiario[]> {
  return prisma.beneficiario.findMany({
    where: {
      // Fichas de pago enlazadas a una empresa (puente Beneficiario.empresaId, M5).
      ...(empresaId ? { empresaId } : {}),
      ...(query
        ? {
            OR: [
              { nombre: { contains: query, mode: "insensitive" } },
              { nit: { contains: query, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { nombre: "asc" },
  });
}

export async function crearBeneficiario(
  input: CrearBeneficiarioInput,
  usuarioId: string,
): Promise<Beneficiario> {
  return prisma.$transaction(async (tx) => {
    const beneficiario = await tx.beneficiario.create({
      data: {
        nombre: input.nombre.trim(),
        nit: input.nit?.trim() || null,
        banco: input.banco?.trim() || null,
        numCuenta: input.numCuenta?.trim() || null,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Beneficiario",
        entidadId: beneficiario.id,
        accion: "CREATE_BENEFICIARIO",
        usuarioId,
        despues: normalizeSerializable(beneficiario),
      },
    });

    return beneficiario;
  });
}

export async function actualizarBeneficiario(
  id: string,
  input: Partial<CrearBeneficiarioInput>,
  usuarioId: string,
): Promise<Beneficiario> {
  const existe = await prisma.beneficiario.findUnique({ where: { id } });
  if (!existe) throw new BeneficiarioNoEncontradoError(id);

  return prisma.$transaction(async (tx) => {
    const actualizado = await tx.beneficiario.update({
      where: { id },
      data: {
        ...(input.nombre !== undefined ? { nombre: input.nombre.trim() } : {}),
        ...(input.nit !== undefined ? { nit: input.nit?.trim() || null } : {}),
        ...(input.banco !== undefined ? { banco: input.banco?.trim() || null } : {}),
        ...(input.numCuenta !== undefined ? { numCuenta: input.numCuenta?.trim() || null } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Beneficiario",
        entidadId: id,
        accion: "UPDATE_BENEFICIARIO",
        usuarioId,
        antes: normalizeSerializable(existe),
        despues: normalizeSerializable(actualizado),
      },
    });

    return actualizado;
  });
}
