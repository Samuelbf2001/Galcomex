import { Prisma, type Beneficiario } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export type { Beneficiario };

/**
 * Normaliza un NIT para comparar "el mismo NIT" entre dos fuentes que lo
 * escriben distinto: quita puntos, espacios y guiones, y descarta el dígito
 * de verificación (DV) si viene pegado con guion ("800193576-1" → "800193576").
 * Sin guion se asume que el NIT ya viene sin DV.
 */
export function nitBase(nit: string): string {
  const limpio = nit.trim().replace(/[.\s]/g, "");
  const guion = limpio.lastIndexOf("-");
  return (guion >= 0 ? limpio.slice(0, guion) : limpio).toUpperCase();
}

/**
 * Una empresa marcada como proveedor necesita su ficha de pago (`Beneficiario`)
 * enlazada por `empresaId`: sin ese puente no aparece en el libro de pagos, en
 * las facturas de proveedor ni en la punta proveedor de la cuenta corriente.
 * Idempotente: reutiliza la ficha ya enlazada, enlaza una existente con el
 * mismo NIT o crea una nueva. Devuelve la ficha resultante.
 */
export async function asegurarBeneficiarioDeEmpresa(
  tx: Prisma.TransactionClient,
  empresa: { id: string; nombre: string; nit: string },
): Promise<Beneficiario> {
  const enlazado = await tx.beneficiario.findFirst({ where: { empresaId: empresa.id } });
  if (enlazado) return enlazado;

  const nit = empresa.nit.trim();
  const porNit = nit ? await tx.beneficiario.findFirst({ where: { nit, empresaId: null } }) : null;
  if (porNit) {
    return tx.beneficiario.update({ where: { id: porNit.id }, data: { empresaId: empresa.id } });
  }

  return tx.beneficiario.create({
    data: { nombre: empresa.nombre.trim(), nit: nit || null, empresaId: empresa.id },
  });
}

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
  /** Ficha de empresa a la que corresponde este beneficiario (M5). */
  empresaId?: string | null;
};

export class BeneficiarioNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Beneficiario ${id} no encontrado`);
    this.name = "BeneficiarioNoEncontradoError";
  }
}

export class EmpresaNoEncontradaParaBeneficiarioError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaNoEncontradaParaBeneficiarioError";
  }
}

async function validarEmpresaParaEnlazar(
  tx: Prisma.TransactionClient,
  empresaId: string,
): Promise<void> {
  const empresa = await tx.cliente.findUnique({ where: { id: empresaId }, select: { id: true } });
  if (!empresa) {
    throw new EmpresaNoEncontradaParaBeneficiarioError(empresaId);
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
    if (input.empresaId) {
      await validarEmpresaParaEnlazar(tx, input.empresaId);
    }

    const beneficiario = await tx.beneficiario.create({
      data: {
        nombre: input.nombre.trim(),
        nit: input.nit?.trim() || null,
        banco: input.banco?.trim() || null,
        numCuenta: input.numCuenta?.trim() || null,
        empresaId: input.empresaId || null,
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
    if (input.empresaId) {
      await validarEmpresaParaEnlazar(tx, input.empresaId);
    }

    const actualizado = await tx.beneficiario.update({
      where: { id },
      data: {
        ...(input.nombre !== undefined ? { nombre: input.nombre.trim() } : {}),
        ...(input.nit !== undefined ? { nit: input.nit?.trim() || null } : {}),
        ...(input.banco !== undefined ? { banco: input.banco?.trim() || null } : {}),
        ...(input.numCuenta !== undefined ? { numCuenta: input.numCuenta?.trim() || null } : {}),
        ...(input.empresaId !== undefined ? { empresaId: input.empresaId || null } : {}),
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

export class EmpresaNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaNoEncontradaError";
  }
}

/**
 * Enlazar la ficha de pago (beneficiario) de una empresa con un clic (M5,
 * "Enlazar ficha de pago"). A diferencia de `asegurarBeneficiarioDeEmpresa`
 * (que exige NIT idéntico y se dispara solo al guardar la ficha de empresa),
 * este además compara por NIT BASE — sin DV, puntos ni espacios — porque en la
 * práctica el NIT de la empresa y el del beneficiario vienen de fuentes
 * distintas y no siempre coinciden carácter a carácter ("800193576-1" vs
 * "800193576"). Idempotente: si ya hay un beneficiario enlazado, lo devuelve
 * tal cual (200, no es un error).
 */
export async function enlazarBeneficiarioEmpresa(
  empresaId: string,
  usuarioId: string,
): Promise<Beneficiario> {
  return prisma.$transaction(async (tx) => {
    const empresa = await tx.cliente.findUnique({
      where: { id: empresaId },
      select: { id: true, nombre: true, nit: true },
    });
    if (!empresa) {
      throw new EmpresaNoEncontradaError(empresaId);
    }

    const yaEnlazado = await tx.beneficiario.findFirst({ where: { empresaId } });
    if (yaEnlazado) return yaEnlazado;

    const baseEmpresa = empresa.nit ? nitBase(empresa.nit) : "";
    const candidatos = baseEmpresa
      ? await tx.beneficiario.findMany({ where: { empresaId: null, nit: { not: null } } })
      : [];
    const porNitBase = candidatos.find((b) => b.nit && nitBase(b.nit) === baseEmpresa) ?? null;

    const beneficiario = porNitBase
      ? await tx.beneficiario.update({ where: { id: porNitBase.id }, data: { empresaId } })
      : await tx.beneficiario.create({
          data: { nombre: empresa.nombre.trim(), nit: empresa.nit?.trim() || null, empresaId },
        });

    await tx.auditLog.create({
      data: {
        entidad: "Beneficiario",
        entidadId: beneficiario.id,
        accion: "ENLAZAR_BENEFICIARIO_EMPRESA",
        usuarioId,
        despues: normalizeSerializable(beneficiario),
      },
    });

    return beneficiario;
  });
}
