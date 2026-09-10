/**
 * Servicio de capacidades — Galcomex
 *
 * Capa de BD sobre el resolver puro (`./resolver.ts`). Los consumidores de
 * dominio deberían pedir el mapa una sola vez por request:
 *
 *     const capacidades = await capacidadesDeEmpresa(tramite.clienteId);
 *     if (tiene(capacidades, "base_cif")) { ... }
 *
 * No cachea entre requests a propósito: un interruptor recién apagado tiene que
 * verse en la siguiente pantalla, y el costo son dos SELECT por índice.
 */

import { Prisma } from "@prisma/client";

import {
  CAPACIDADES,
  type CodigoCapacidad,
  esCodigoCapacidad,
} from "@/lib/capacidades/catalogo";
import {
  resolverCapacidades,
  type ConfigCapacidad,
  type DefinicionResoluble,
  type MapaCapacidades,
  type OverrideCapacidad,
} from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";

export class EmpresaNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaNoEncontradaError";
  }
}

export class CapacidadDesconocidaError extends Error {
  public readonly status = 400;
  constructor(codigo: string) {
    super(`La capacidad ${codigo} no existe en el catálogo`);
    this.name = "CapacidadDesconocidaError";
  }
}

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

/** Narrowing de `Prisma.JsonValue` a la forma de config que espera el resolver. */
function asConfig(valor: Prisma.JsonValue | null | undefined): ConfigCapacidad {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== "object" || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

/** Config → valor aceptable por una columna Json opcional de Prisma. */
function toPrismaJson(
  config: ConfigCapacidad,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return config === null ? Prisma.DbNull : (config as Prisma.InputJsonValue);
}

/**
 * Catálogo efectivo. Se lee de BD (una capacidad puede desactivarse en caliente
 * con `activa = false`), con el catálogo de código como respaldo: si la
 * migración todavía no corrió, el sistema resuelve por defaults en vez de dejar
 * a todas las empresas sin capacidades.
 */
export async function catalogoCapacidades(): Promise<DefinicionResoluble[]> {
  const filas = await prisma.capacidad.findMany({ orderBy: { orden: "asc" } });

  if (filas.length === 0) {
    return CAPACIDADES.map((capacidad) => ({
      codigo: capacidad.codigo,
      porDefecto: capacidad.porDefecto,
      configPorDefecto: capacidad.configPorDefecto,
      activa: true,
    }));
  }

  return filas.map((fila) => ({
    codigo: fila.codigo,
    porDefecto: fila.porDefecto,
    configPorDefecto: asConfig(fila.configPorDefecto),
    activa: fila.activa,
  }));
}

export interface CapacidadUI {
  codigo: string;
  nombre: string;
  descripcion: string;
  grupo: string;
  porDefecto: boolean;
  configPorDefecto: ConfigCapacidad;
}

/** Catálogo completo para pintar la ficha (incluye textos y agrupación). */
export async function catalogoCapacidadesUI(): Promise<CapacidadUI[]> {
  const filas = await prisma.capacidad.findMany({
    where: { activa: true },
    orderBy: { orden: "asc" },
  });

  if (filas.length > 0) {
    return filas.map((fila) => ({
      codigo: fila.codigo,
      nombre: fila.nombre,
      descripcion: fila.descripcion ?? "",
      grupo: fila.grupo,
      porDefecto: fila.porDefecto,
      configPorDefecto: asConfig(fila.configPorDefecto),
    }));
  }

  return CAPACIDADES.map((capacidad) => ({
    codigo: capacidad.codigo,
    nombre: capacidad.nombre,
    descripcion: capacidad.descripcion,
    grupo: capacidad.grupo,
    porDefecto: capacidad.porDefecto,
    configPorDefecto: capacidad.configPorDefecto,
  }));
}

function aOverrides(
  filas: { codigo: string; habilitado: boolean; config: Prisma.JsonValue | null }[],
): OverrideCapacidad[] {
  return filas.map((fila) => ({
    codigo: fila.codigo,
    habilitado: fila.habilitado,
    config: asConfig(fila.config),
  }));
}

/**
 * Mapa de capacidades efectivas de una empresa (defaults → grupo → empresa).
 * Lanza `EmpresaNoEncontradaError` si el id no existe: leer capacidades de una
 * empresa fantasma casi siempre es un bug del llamador.
 */
export async function capacidadesDeEmpresa(
  empresaId: string,
): Promise<MapaCapacidades> {
  const empresa = await prisma.cliente.findUnique({
    where: { id: empresaId },
    select: {
      id: true,
      grupoEmpresaId: true,
      capacidades: {
        select: { codigo: true, habilitado: true, config: true },
      },
    },
  });

  if (!empresa) {
    throw new EmpresaNoEncontradaError(empresaId);
  }

  const [catalogo, overridesGrupo] = await Promise.all([
    catalogoCapacidades(),
    empresa.grupoEmpresaId
      ? prisma.grupoEmpresaCapacidad.findMany({
          where: { grupoId: empresa.grupoEmpresaId },
          select: { codigo: true, habilitado: true, config: true },
        })
      : Promise.resolve([]),
  ]);

  return resolverCapacidades(
    catalogo,
    aOverrides(overridesGrupo),
    aOverrides(empresa.capacidades),
  );
}

export interface CapacidadFicha extends CapacidadUI {
  habilitado: boolean;
  config: ConfigCapacidad;
  origenHabilitado: string;
  origenConfig: string;
  /** `true` si esta empresa tiene un override propio (no está heredando). */
  tieneOverride: boolean;
}

/**
 * Catálogo + estado resuelto, listo para pintar los interruptores de la ficha
 * de empresa. Una sola función para que la UI no tenga que cruzar dos listas.
 */
export async function capacidadesParaFicha(
  empresaId: string,
): Promise<CapacidadFicha[]> {
  const [catalogo, mapa] = await Promise.all([
    catalogoCapacidadesUI(),
    capacidadesDeEmpresa(empresaId),
  ]);

  return catalogo.map((capacidad) => {
    const resuelta = mapa.get(capacidad.codigo);

    return {
      ...capacidad,
      habilitado: resuelta?.habilitado ?? capacidad.porDefecto,
      config: resuelta?.config ?? capacidad.configPorDefecto,
      origenHabilitado: resuelta?.origenHabilitado ?? "DEFECTO",
      origenConfig: resuelta?.origenConfig ?? "DEFECTO",
      tieneOverride:
        resuelta?.origenHabilitado === "EMPRESA" ||
        resuelta?.origenConfig === "EMPRESA",
    };
  });
}

export interface CambioCapacidad {
  codigo: CodigoCapacidad;
  /** `true` borra el override y devuelve la capacidad a lo que herede. */
  heredar?: boolean;
  habilitado?: boolean;
  config?: ConfigCapacidad;
}

/**
 * Aplica cambios de capacidades de una empresa en una sola transacción y deja
 * un `AuditLog` por capacidad tocada (invariante #5 del CLAUDE.md).
 */
export async function setCapacidadesEmpresa(input: {
  empresaId: string;
  cambios: CambioCapacidad[];
  usuarioId: string;
}): Promise<MapaCapacidades> {
  const { empresaId, cambios, usuarioId } = input;

  for (const cambio of cambios) {
    if (!esCodigoCapacidad(cambio.codigo)) {
      throw new CapacidadDesconocidaError(cambio.codigo);
    }
  }

  const empresa = await prisma.cliente.findUnique({
    where: { id: empresaId },
    select: { id: true },
  });

  if (!empresa) {
    throw new EmpresaNoEncontradaError(empresaId);
  }

  await prisma.$transaction(async (tx) => {
    for (const cambio of cambios) {
      const antes = await tx.empresaCapacidad.findUnique({
        where: { empresaId_codigo: { empresaId, codigo: cambio.codigo } },
      });

      if (cambio.heredar) {
        if (!antes) continue;

        await tx.empresaCapacidad.delete({
          where: { empresaId_codigo: { empresaId, codigo: cambio.codigo } },
        });

        await tx.auditLog.create({
          data: {
            entidad: "EmpresaCapacidad",
            entidadId: `${empresaId}:${cambio.codigo}`,
            accion: "RESET_CAPACIDAD_EMPRESA",
            usuarioId,
            antes: normalizeSerializable(antes),
          },
        });

        continue;
      }

      const habilitado = cambio.habilitado ?? antes?.habilitado ?? false;
      const config =
        cambio.config !== undefined ? cambio.config : asConfig(antes?.config);

      const despues = await tx.empresaCapacidad.upsert({
        where: { empresaId_codigo: { empresaId, codigo: cambio.codigo } },
        create: {
          empresaId,
          codigo: cambio.codigo,
          habilitado,
          config: toPrismaJson(config),
        },
        update: {
          habilitado,
          config: toPrismaJson(config),
        },
      });

      // Transición: `Cliente.manejaAnticipo` sigue existiendo y varias vistas
      // aún lo leen. Se mantiene en espejo hasta retirar la columna.
      if (cambio.codigo === "anticipos_cliente") {
        await tx.cliente.update({
          where: { id: empresaId },
          data: { manejaAnticipo: habilitado },
        });
      }

      await tx.auditLog.create({
        data: {
          entidad: "EmpresaCapacidad",
          entidadId: `${empresaId}:${cambio.codigo}`,
          accion: "SET_CAPACIDAD_EMPRESA",
          usuarioId,
          antes: antes ? normalizeSerializable(antes) : undefined,
          despues: normalizeSerializable(despues),
        },
      });
    }
  });

  return capacidadesDeEmpresa(empresaId);
}
