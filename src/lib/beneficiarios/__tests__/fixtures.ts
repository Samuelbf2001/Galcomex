/**
 * Ayudas de prueba para la fase 3 (toda ficha de pago pertenece a una
 * empresa; CHECK `beneficiario_empresa_o_socio` y FK empresa → Restrict).
 *
 * Las pruebas que antes creaban una ficha suelta con `prisma.beneficiario.create`
 * usan `crearFichaConEmpresaTest`: crea (o reutiliza por NIT exacto) una
 * empresa solo-proveedora con el nombre de la ficha y la enlaza. Para limpiar,
 * `borrarFichasYEmpresasTest` borra primero las fichas y después sus empresas
 * (al revés falla por la FK Restrict).
 */
import type { Beneficiario, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type DatosFicha = Omit<Prisma.BeneficiarioUncheckedCreateInput, "empresaId"> & { empresaId?: string | null };

let secuencia = 0;

/** NIT de empresa único por prueba cuando la ficha no trae NIT. */
function nitProvisionalTest(): string {
  secuencia += 1;
  return `VITEST-SIN-NIT-${Date.now()}-${process.pid}-${secuencia}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function crearFichaConEmpresaTest(
  datos: DatosFicha,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Beneficiario> {
  if (datos.empresaId) {
    return db.beneficiario.create({ data: { ...datos, empresaId: datos.empresaId } });
  }
  const nitEmpresa = typeof datos.nit === "string" && datos.nit.trim() !== "" ? datos.nit.trim() : nitProvisionalTest();
  const empresa =
    (await db.cliente.findUnique({ where: { nit: nitEmpresa }, select: { id: true } })) ??
    (await db.cliente.create({
      data: {
        nombre: datos.nombre,
        nit: nitEmpresa,
        esCliente: false,
        esProveedor: true,
        manejaAnticipo: false,
      },
      select: { id: true },
    }));
  return db.beneficiario.create({ data: { ...datos, empresaId: empresa.id } });
}

/**
 * Borra las fichas que cumplan `where` y, después, las empresas que quedaron
 * sin fichas y que solo existían para ellas (solo-proveedoras sin trámites).
 * Antes de llamarla, borra lo que cuelga de las fichas (facturas, pagos).
 */
export async function borrarFichasYEmpresasTest(where: Prisma.BeneficiarioWhereInput): Promise<void> {
  const fichas = await prisma.beneficiario.findMany({ where, select: { id: true, empresaId: true } });
  if (fichas.length === 0) return;
  await prisma.beneficiario.deleteMany({ where: { id: { in: fichas.map((f) => f.id) } } });
  const empresaIds = [...new Set(fichas.flatMap((f) => (f.empresaId ? [f.empresaId] : [])))];
  if (empresaIds.length === 0) return;
  await prisma.cliente
    .deleteMany({
      where: {
        id: { in: empresaIds },
        esCliente: false,
        beneficiarios: { none: {} },
        tramites: { none: {} },
      },
    })
    .catch(() => undefined);
}
