/**
 * Pisos de consecutivo (30-sep-2026, DISENO-NUMERACION.md §2.1): «el último
 * número de este contador es por lo menos N». Sirve cuando Camila abrió DOs
 * fuera de la plataforma: la plataforma no vuelve a entregar esos números.
 *
 * Solo se inserta (la tabla es su propio historial) y lo hace
 * `scripts/consecutivos/fijar-piso.ts` con un usuario ADMIN, dentro del MISMO
 * candado del contador que usa `createTramite`, con AuditLog
 * `FIJAR_PISO_CONSECUTIVO`. Un piso menor o igual a lo que el contador ya
 * tiene no sirve para nada y se rechaza.
 */
import { Ciudad, Prisma, Rol } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import {
  alcanceContador,
  filtroDeAlcance,
  formatConsecutivo,
  siguienteNumero,
  type AlcanceContador,
} from "@/lib/tramites/consecutivo";

export const MOTIVO_PISO_MIN = 10;

export class PisoConsecutivoInvalidoError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "PisoConsecutivoInvalidoError";
  }
}

export type FijarPisoInput = {
  tipoTramiteCodigo: string;
  anio: number;
  /** Obligatoria en un contador por ciudad (IMPORTACION); se ignora en los demás. */
  ciudad?: Ciudad | null;
  /** Último número que ya usó el contador (el siguiente será este + 1). */
  ultimoNumero: number;
  motivo: string;
  /** Usuario ADMIN que fija el piso (queda en el piso y en el AuditLog). */
  usuarioId: string;
  /** false = simulacro: calcula y valida, no escribe. */
  aplicar: boolean;
};

export type ResultadoPiso = {
  clave: string;
  ultimoActual: number | null;
  pisoActual: number | null;
  siguienteAntes: string;
  siguienteDespues: string;
  aplicado: boolean;
  pisoId: string | null;
};

type Db = Prisma.TransactionClient | typeof prisma;

async function estadoDelContador(db: Db, tipoCodigo: string, alcance: AlcanceContador<Ciudad>) {
  const ultimo = await db.tramiteDO.findFirst({
    where: filtroDeAlcance(tipoCodigo, alcance),
    orderBy: { numero: "desc" },
    select: { numero: true },
  });
  const piso = await db.consecutivoPiso.aggregate({ where: { clave: alcance.clave }, _max: { ultimoNumero: true } });
  return { ultimo: ultimo?.numero ?? null, piso: piso._max.ultimoNumero ?? null };
}

export async function fijarPisoConsecutivo(input: FijarPisoInput): Promise<ResultadoPiso> {
  const motivo = input.motivo.trim();
  if (motivo.length < MOTIVO_PISO_MIN) {
    throw new PisoConsecutivoInvalidoError(
      `Escribe el motivo del piso (al menos ${MOTIVO_PISO_MIN} caracteres): de dónde sale el número.`,
    );
  }
  if (!Number.isInteger(input.ultimoNumero) || input.ultimoNumero < 1) {
    throw new PisoConsecutivoInvalidoError("El último número debe ser un entero mayor que cero.");
  }

  const [tipo, usuario] = await Promise.all([
    prisma.tipoTramite.findFirst({ where: { codigo: input.tipoTramiteCodigo, activo: true } }),
    prisma.user.findUnique({ where: { id: input.usuarioId }, select: { rol: true, activo: true } }),
  ]);
  if (!tipo) throw new PisoConsecutivoInvalidoError(`El tipo de trámite ${input.tipoTramiteCodigo} no existe o está inactivo.`);
  if (!usuario || usuario.rol !== Rol.ADMIN || usuario.activo === false) {
    throw new PisoConsecutivoInvalidoError("Solo un usuario ADMIN activo puede fijar un piso de consecutivo.");
  }
  if (tipo.secuenciaPor === "CIUDAD_ANIO" && !input.ciudad) {
    throw new PisoConsecutivoInvalidoError(`El contador de ${tipo.nombre} va por ciudad: indica la ciudad.`);
  }

  const ciudad = input.ciudad ?? Ciudad.BAQ;
  const alcance = alcanceContador(tipo, tipo.codigo, ciudad, input.anio);

  const calcular = async (db: Db): Promise<ResultadoPiso> => {
    const { ultimo, piso } = await estadoDelContador(db, tipo.codigo, alcance);
    const tope = Math.max(ultimo ?? 0, piso ?? 0);
    if (input.ultimoNumero <= tope) {
      throw new PisoConsecutivoInvalidoError(
        `El contador ${alcance.clave} ya va en ${tope}: un piso de ${input.ultimoNumero} no cambia nada.`,
      );
    }
    return {
      clave: alcance.clave,
      ultimoActual: ultimo,
      pisoActual: piso,
      siguienteAntes: formatConsecutivo(tipo, ciudad, input.anio, siguienteNumero(ultimo, piso)),
      siguienteDespues: formatConsecutivo(tipo, ciudad, input.anio, input.ultimoNumero + 1),
      aplicado: false,
      pisoId: null,
    };
  };

  if (!input.aplicar) return calcular(prisma);

  // Mismo candado que `createTramite`: nadie numera este contador mientras se fija el piso.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${alcance.claveLock}))`;
    const resultado = await calcular(tx);
    const creado = await tx.consecutivoPiso.create({
      data: {
        clave: alcance.clave,
        tipoTramiteCodigo: tipo.codigo,
        anio: alcance.anio,
        ultimoNumero: input.ultimoNumero,
        motivo,
        creadoPorId: input.usuarioId,
      },
    });
    await tx.auditLog.create({
      data: {
        entidad: "ConsecutivoPiso",
        entidadId: creado.id,
        accion: "FIJAR_PISO_CONSECUTIVO",
        usuarioId: input.usuarioId,
        antes: normalizeSerializable({
          clave: alcance.clave,
          ultimoActual: resultado.ultimoActual,
          pisoActual: resultado.pisoActual,
          siguiente: resultado.siguienteAntes,
        }),
        despues: normalizeSerializable({
          clave: alcance.clave,
          ultimoNumero: input.ultimoNumero,
          motivo,
          siguiente: resultado.siguienteDespues,
        }),
      },
    });
    return { ...resultado, aplicado: true, pisoId: creado.id };
  });
}
