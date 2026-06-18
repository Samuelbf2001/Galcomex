import { type Beneficiario } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export type { Beneficiario };

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

export async function listarBeneficiarios(query?: string): Promise<Beneficiario[]> {
  return prisma.beneficiario.findMany({
    where: query
      ? {
          OR: [
            { nombre: { contains: query, mode: "insensitive" } },
            { nit: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { nombre: "asc" },
  });
}

export async function crearBeneficiario(input: CrearBeneficiarioInput): Promise<Beneficiario> {
  return prisma.beneficiario.create({
    data: {
      nombre: input.nombre.trim(),
      nit: input.nit?.trim() || null,
      banco: input.banco?.trim() || null,
      numCuenta: input.numCuenta?.trim() || null,
    },
  });
}

export async function actualizarBeneficiario(
  id: string,
  input: Partial<CrearBeneficiarioInput>,
): Promise<Beneficiario> {
  const existe = await prisma.beneficiario.findUnique({ where: { id } });
  if (!existe) throw new BeneficiarioNoEncontradoError(id);

  return prisma.beneficiario.update({
    where: { id },
    data: {
      ...(input.nombre !== undefined ? { nombre: input.nombre.trim() } : {}),
      ...(input.nit !== undefined ? { nit: input.nit?.trim() || null } : {}),
      ...(input.banco !== undefined ? { banco: input.banco?.trim() || null } : {}),
      ...(input.numCuenta !== undefined ? { numCuenta: input.numCuenta?.trim() || null } : {}),
    },
  });
}
