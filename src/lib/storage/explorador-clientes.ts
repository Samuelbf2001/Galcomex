/**
 * Vista "Por cliente" del explorador de archivos: en vez de navegar carpeta
 * por carpeta del bucket (`explorador.ts`), agrupa por cliente usando los
 * datos reales de la plataforma (Cliente → TramiteDO → Documento). Así
 * aparecen TODOS los clientes con documentos, sin depender de cómo quedó
 * nombrada su carpeta en el bucket.
 *
 * Los "sueltos" (histórico 2026 cargado fuera de un DO, subido al bucket SIN
 * registrar en la BD — ver `scripts/historico-clientes/importar.ts`) se
 * enlazan con su carpeta conocida del bucket solo cuando esa carpeta existe
 * de verdad (`historico-clientes-alias.ts`); si no hay alias o no hay
 * carpeta, simplemente no se ofrece el enlace.
 */
import { prisma } from "@/lib/db/prisma";
import { getStorageConfig } from "@/lib/storage/config";
import { carpetaDeConsecutivo, listarNivel, PREFIJO_TRAMITES } from "@/lib/storage/explorador";
import { carpetaHistoricaDeCliente } from "@/lib/storage/historico-clientes-alias";

export const PREFIJO_CLIENTES = "clientes/";

export type ClienteConArchivos = {
  id: string;
  nombre: string;
  nit: string;
  dos: number;
  documentos: number;
  sueltosPrefix?: string;
};

export type TramiteDeCliente = {
  id: string;
  consecutivo: string;
  estado: string;
  documentos: number;
  prefix: string;
};

export type ClienteConDetalle = {
  id: string;
  nombre: string;
  nit: string;
  tramites: TramiteDeCliente[];
  sueltosPrefix?: string;
};

/** Nombres de carpeta que hoy existen bajo `clientes/` en el bucket (una sola llamada, nivel único). */
async function carpetasSueltosExistentes(): Promise<Set<string>> {
  const config = getStorageConfig();
  const nivel = await listarNivel(config.bucket, PREFIJO_CLIENTES);
  return new Set(nivel.carpetas.map((p) => p.slice(PREFIJO_CLIENTES.length, -1)));
}

function sueltosPrefixDe(nombreCliente: string, carpetasSueltos: Set<string>): string | undefined {
  const alias = carpetaHistoricaDeCliente(nombreCliente);
  return alias && carpetasSueltos.has(alias) ? `${PREFIJO_CLIENTES}${alias}/` : undefined;
}

/** Directorio: todos los clientes con cuántos DOs y documentos tienen. */
export async function listarClientesConArchivos(): Promise<ClienteConArchivos[]> {
  const [clientes, tramites, carpetasSueltos] = await Promise.all([
    prisma.cliente.findMany({
      select: { id: true, nombre: true, nit: true },
      orderBy: { nombre: "asc" },
    }),
    prisma.tramiteDO.findMany({
      select: { clienteId: true, _count: { select: { documentos: true } } },
    }),
    carpetasSueltosExistentes(),
  ]);

  const porCliente = new Map<string, { dos: number; documentos: number }>();
  for (const t of tramites) {
    const acc = porCliente.get(t.clienteId) ?? { dos: 0, documentos: 0 };
    acc.dos += 1;
    acc.documentos += t._count.documentos;
    porCliente.set(t.clienteId, acc);
  }

  return clientes.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    nit: c.nit,
    ...(porCliente.get(c.id) ?? { dos: 0, documentos: 0 }),
    sueltosPrefix: sueltosPrefixDe(c.nombre, carpetasSueltos),
  }));
}

/** Detalle de un cliente: sus DOs (cada uno con su carpeta del explorador) + sueltos si hay. */
export async function listarArchivosDeCliente(clienteId: string): Promise<ClienteConDetalle | null> {
  const cliente = await prisma.cliente.findUnique({
    where: { id: clienteId },
    select: {
      id: true,
      nombre: true,
      nit: true,
      tramites: {
        select: { id: true, consecutivo: true, estado: true, _count: { select: { documentos: true } } },
        orderBy: { consecutivo: "asc" },
      },
    },
  });
  if (!cliente) return null;

  const alias = carpetaHistoricaDeCliente(cliente.nombre);
  const carpetasSueltos = alias ? await carpetasSueltosExistentes() : new Set<string>();

  return {
    id: cliente.id,
    nombre: cliente.nombre,
    nit: cliente.nit,
    sueltosPrefix: sueltosPrefixDe(cliente.nombre, carpetasSueltos),
    tramites: cliente.tramites.map((t) => ({
      id: t.id,
      consecutivo: t.consecutivo,
      estado: t.estado,
      documentos: t._count.documentos,
      prefix: `${PREFIJO_TRAMITES}${carpetaDeConsecutivo(t.consecutivo)}/`,
    })),
  };
}
