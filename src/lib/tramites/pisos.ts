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
 *
 * Exportación por ciudad (30-sep-2026): Exportación también va por ciudad
 * (Barranquilla-Bogotá-Buenaventura, Cartagena, Santa Marta), así que su piso
 * pide la ciudad, igual que Importación.
 */
import { Ciudad, Prisma, Rol } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import {
  alcanceContador,
  formatConsecutivo,
  siguienteNumero,
  validarConfigContador,
} from "@/lib/tramites/consecutivo";
import { etiquetaDelContador, ultimoYPisoDelContador } from "@/lib/tramites/service";

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
  /** Obligatoria en un contador por ciudad (IMPORTACION, EXPORTACION); se ignora en los demás. */
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
  /** Etiqueta del contador: «contador de exportación de Cartagena». */
  contador: string;
  ultimoActual: number | null;
  pisoActual: number | null;
  siguienteAntes: string;
  siguienteDespues: string;
  aplicado: boolean;
  pisoId: string | null;
};

type Db = Prisma.TransactionClient | typeof prisma;

export async function fijarPisoConsecutivo(input: FijarPisoInput): Promise<ResultadoPiso> {
  const motivo = input.motivo.trim();
  if (motivo.length < MOTIVO_PISO_MIN) {
    throw new PisoConsecutivoInvalidoError(
      `Escribe el motivo del piso (al menos ${MOTIVO_PISO_MIN} caracteres): de dónde sale el número.`,
    );
  }
  // Mismo rango que `POST /api/tramites` (2020–2100). Sin esto, el script sin
  // `--anio` mandaba 0 (`Number(null)`) y fijaba el piso de un contador que
  // ningún DO usa, dejando creer que el piso real quedó puesto.
  if (!Number.isInteger(input.anio) || input.anio < 2020 || input.anio > 2100) {
    throw new PisoConsecutivoInvalidoError("Indica el año del contador (entre 2020 y 2100).");
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
  // Con la numeración mal configurada la clave y el número de abajo podrían no
  // ser los que usará `createTramite` (que tampoco numera en ese caso).
  const errorConfig = validarConfigContador(tipo, Object.values(Ciudad));
  if (errorConfig) {
    throw new PisoConsecutivoInvalidoError(`La numeración de ${tipo.nombre} está mal configurada: ${errorConfig}`);
  }

  const ciudad = input.ciudad ?? Ciudad.BAQ;
  const alcance = alcanceContador(tipo, tipo.codigo, ciudad, input.anio);
  const contador = etiquetaDelContador(tipo, alcance);

  const calcular = async (db: Db): Promise<ResultadoPiso> => {
    // El mismo cálculo que `createTramite`: en Exportación el tope incluye la
    // serie impresa (DO.EXP26-… de cualquier ciudad) y los pisos del grupo
    // anterior, no solo las ciudades de hoy.
    const { ultimo, piso } = await ultimoYPisoDelContador(db, tipo, alcance);
    const tope = Math.max(ultimo ?? 0, piso ?? 0);
    if (input.ultimoNumero <= tope) {
      throw new PisoConsecutivoInvalidoError(
        `El contador ${alcance.clave} ya va en ${tope}: un piso de ${input.ultimoNumero} no cambia nada.`,
      );
    }
    return {
      clave: alcance.clave,
      contador,
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
