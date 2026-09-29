/**
 * Comisión por contenedor de un DO (caso LTRANS) — servicio con BD.
 *
 * Reglas en `calculo.ts` (puro). Aquí: quién puede cobrar comisión, qué DOs
 * la muestran, registrar/quitar las unidades de un DO (con AuditLog) y el
 * resumen "por facturar" de la ficha de la empresa que paga.
 *
 *   - Paga comisión: empresa con la capacidad `comision_por_evento` (LTRANS).
 *     Su config `valor` es el valor por contenedor (hoy 90.000).
 *   - La muestran: los DOs de empresas con `contenedores_obligatorio`
 *     (Polyrec, Polyrec ZF) — el número de contenedores es la base.
 */

import { Prisma, type ComisionTramite, type TipoCarga } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import {
  aOverrides,
  capacidadesDeEmpresa,
  catalogoCapacidades,
} from "@/lib/capacidades/service";
import { resolverCapacidades, tiene } from "@/lib/capacidades/resolver";
import { getParametrosSistema } from "@/lib/parametros/service";
import { assertTramiteModificable } from "@/lib/tramites/guard";
import { CAPACIDAD_CONTENEDORES } from "@/lib/tramites/requisitos";
import {
  CAPACIDAD_COMISION,
  errorUnidades,
  totalesComision,
  unidadesDisponibles,
  valorUnitarioDe,
  type TotalesComision,
} from "@/lib/comisiones/calculo";
import { impedimentoParaDeshacer } from "@/lib/comisiones/deshacer-reglas";

export class ComisionInvalidaError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ComisionInvalidaError";
  }
}

/** B3: la comisión se facturó justo mientras se editaba o quitaba (otra persona ganó la carrera). */
export class ComisionYaFacturadaAlEditarError extends Error {
  public readonly status = 409;
  constructor() {
    super("Esta comisión se acaba de facturar en un servicio «Otros»: ya no se puede cambiar ni quitar. Recarga la ficha.");
    this.name = "ComisionYaFacturadaAlEditarError";
  }
}

export class TramiteComisionNoEncontradoError extends Error {
  public readonly status = 404;
  constructor() {
    super("Trámite no encontrado");
    this.name = "TramiteComisionNoEncontradoError";
  }
}

export interface EmpresaQuePaga {
  empresaId: string;
  nombre: string;
  /** Valor por contenedor de su config (0 = sin configurar). */
  valorUnitario: bigint;
}

/**
 * Empresas con `comision_por_evento` encendida (por empresa o por su grupo).
 * Los candidatos salen de las filas de capacidad y la cascada completa se
 * resuelve aquí mismo con sus filas (una empresa puede apagarla aunque su grupo
 * la tenga): una sola consulta, sin releer cada empresa — si una se borra
 * mientras tanto, simplemente no aparece.
 */
export async function empresasQuePaganComision(): Promise<EmpresaQuePaga[]> {
  const filasCapacidad = { select: { codigo: true, habilitado: true, config: true } } as const;
  const [catalogo, candidatas] = await Promise.all([
    catalogoCapacidades(),
    prisma.cliente.findMany({
      where: {
        activo: true,
        OR: [
          { capacidades: { some: { codigo: CAPACIDAD_COMISION, habilitado: true } } },
          {
            grupoEmpresa: {
              capacidades: { some: { codigo: CAPACIDAD_COMISION, habilitado: true } },
            },
          },
        ],
      },
      select: {
        id: true,
        nombre: true,
        capacidades: filasCapacidad,
        grupoEmpresa: { select: { capacidades: filasCapacidad } },
      },
      orderBy: { nombre: "asc" },
    }),
  ]);

  const resultado: EmpresaQuePaga[] = [];
  for (const empresa of candidatas) {
    const capacidades = resolverCapacidades(
      catalogo,
      aOverrides(empresa.grupoEmpresa?.capacidades ?? []),
      aOverrides(empresa.capacidades),
    );
    if (!tiene(capacidades, CAPACIDAD_COMISION)) continue;
    resultado.push({
      empresaId: empresa.id,
      nombre: empresa.nombre,
      valorUnitario: valorUnitarioDe(capacidades),
    });
  }
  return resultado;
}

export interface ComisionDeTramite {
  empresaId: string;
  nombre: string;
  unidades: number;
  valorUnitario: bigint;
  subtotal: bigint;
  /** B10 — consecutivo del «Otros» donde ya se facturó (null = por facturar; no se puede cambiar ni quitar). */
  facturadaEn: string | null;
}

export interface ComisionesTramite {
  /** El DO muestra la sección: su empresa pide contenedores y alguien paga comisión. */
  aplica: boolean;
  consecutivo: string;
  numContenedores: number | null;
  tipoCarga: string | null;
  /** Contenedores del DO que pueden llevar comisión (carga suelta = 1); null = falta el dato. */
  unidadesDisponibles: number | null;
  empresas: EmpresaQuePaga[];
  comisiones: ComisionDeTramite[];
}

export async function comisionesDeTramite(tramiteId: string): Promise<ComisionesTramite> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      id: true,
      consecutivo: true,
      clienteId: true,
      numContenedores: true,
      tipoCarga: true,
      comisiones: {
        select: {
          empresaId: true,
          unidades: true,
          empresa: { select: { nombre: true } },
          liquidacion: { select: { consecutivo: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!tramite) throw new TramiteComisionNoEncontradoError();

  const [capacidadesDo, empresas] = await Promise.all([
    capacidadesDeEmpresa(tramite.clienteId),
    empresasQuePaganComision(),
  ]);
  // La empresa del DO nunca se paga comisión a sí misma.
  const quePagan = empresas.filter((e) => e.empresaId !== tramite.clienteId);
  const valorDe = new Map(quePagan.map((e) => [e.empresaId, e.valorUnitario]));

  const comisiones = tramite.comisiones.map((c) => {
    const valorUnitario = valorDe.get(c.empresaId) ?? 0n;
    return {
      empresaId: c.empresaId,
      nombre: c.empresa.nombre,
      unidades: c.unidades,
      valorUnitario,
      subtotal: BigInt(c.unidades) * valorUnitario,
      facturadaEn: c.liquidacion?.consecutivo ?? null,
    };
  });

  return {
    aplica:
      comisiones.length > 0 ||
      (tiene(capacidadesDo, CAPACIDAD_CONTENEDORES) && quePagan.length > 0),
    consecutivo: tramite.consecutivo,
    numContenedores: tramite.numContenedores,
    tipoCarga: tramite.tipoCarga,
    unidadesDisponibles: unidadesDisponibles(tramite),
    empresas: quePagan,
    comisiones,
  };
}

/**
 * Registra cuántos contenedores del DO llevan comisión de una empresa.
 * `unidades = 0` la quita. Valida contra los contenedores del DO y lo que ya
 * llevan otras empresas; deja AuditLog con el antes y el después.
 */
export async function registrarComisionTramite(input: {
  tramiteId: string;
  empresaId: string;
  unidades: number;
  usuarioId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const tramite = await tx.tramiteDO.findUnique({
      where: { id: input.tramiteId },
      select: {
        id: true,
        consecutivo: true,
        estado: true,
        clienteId: true,
        numContenedores: true,
        tipoCarga: true,
        comisiones: {
          select: {
            id: true,
            empresaId: true,
            unidades: true,
            liquidacionTramiteId: true,
            liquidacion: { select: { consecutivo: true } },
          },
        },
      },
    });
    if (!tramite) throw new TramiteComisionNoEncontradoError();
    await assertTramiteModificable(tx, tramite);

    const anterior = tramite.comisiones.find((c) => c.empresaId === input.empresaId) ?? null;

    // B10 — una comisión ya facturada (ligada a un «Otros») no se cambia ni se
    // quita: se cobraría distinto de lo que salió en la factura. Reenviar las
    // mismas unidades no cambia nada y pasa.
    if (anterior?.liquidacionTramiteId) {
      if (input.unidades === anterior.unidades) {
        return tx.comisionTramite.findUniqueOrThrow({ where: { id: anterior.id } });
      }
      throw new ComisionInvalidaError(
        `Esta comisión ya se facturó en ${anterior.liquidacion?.consecutivo ?? "un servicio «Otros»"}: no se puede cambiar ni quitar.`,
      );
    }

    if (input.unidades === 0) {
      if (!anterior) return null;
      // B3: `liquidacionTramiteId: null` en el WHERE — si entre la lectura de
      // arriba y este borrado otra persona facturó la comisión, no se borra.
      const borradas = await tx.comisionTramite.deleteMany({
        where: { id: anterior.id, liquidacionTramiteId: null },
      });
      if (borradas.count !== 1) throw new ComisionYaFacturadaAlEditarError();
      await tx.auditLog.create({
        data: {
          entidad: "ComisionTramite",
          entidadId: anterior.id,
          accion: "DELETE",
          usuarioId: input.usuarioId,
          tramiteId: tramite.id,
          antes: normalizeSerializable(anterior),
        },
      });
      return null;
    }

    if (input.empresaId === tramite.clienteId) {
      throw new ComisionInvalidaError("La empresa del DO no puede pagarse comisión a sí misma.");
    }
    const capacidadesPaga = await capacidadesDeEmpresa(input.empresaId);
    if (!tiene(capacidadesPaga, CAPACIDAD_COMISION)) {
      throw new ComisionInvalidaError(
        "Esa empresa no tiene activa la función «Comisión a cobrar por contenedor». Actívala en su ficha, pestaña Funciones.",
      );
    }

    const otrasUnidades = tramite.comisiones
      .filter((c) => c.empresaId !== input.empresaId)
      .reduce((suma, c) => suma + c.unidades, 0);
    const error = errorUnidades({
      unidades: input.unidades,
      disponibles: unidadesDisponibles(tramite),
      otrasUnidades,
      consecutivo: tramite.consecutivo,
    });
    if (error) throw new ComisionInvalidaError(error);

    // B3: editar solo si la fila sigue sin facturar (`liquidacionTramiteId: null`
    // en el WHERE, no solo en la lectura de arriba): con dos personas a la vez,
    // una comisión que otra acaba de facturar no se cambia a mitad de camino.
    // Sin fila previa se CREA (el índice único evita el duplicado): un upsert
    // podría caer en su rama de edición sobre una fila que otra persona creó y
    // facturó justo en el medio.
    let guardada: ComisionTramite;
    if (anterior) {
      const editadas = await tx.comisionTramite.updateMany({
        where: { id: anterior.id, liquidacionTramiteId: null },
        data: { unidades: input.unidades, registradoPorId: input.usuarioId },
      });
      if (editadas.count !== 1) throw new ComisionYaFacturadaAlEditarError();
      guardada = await tx.comisionTramite.findUniqueOrThrow({ where: { id: anterior.id } });
    } else {
      try {
        guardada = await tx.comisionTramite.create({
          data: {
            tramiteId: tramite.id,
            empresaId: input.empresaId,
            unidades: input.unidades,
            registradoPorId: input.usuarioId,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ComisionInvalidaError(
            "Otra persona registró la comisión de esta empresa en este DO mientras tanto. Recarga la ficha.",
          );
        }
        throw error;
      }
    }
    await tx.auditLog.create({
      data: {
        entidad: "ComisionTramite",
        entidadId: guardada.id,
        accion: anterior ? "UPDATE" : "CREATE",
        usuarioId: input.usuarioId,
        tramiteId: tramite.id,
        antes: anterior ? normalizeSerializable(anterior) : undefined,
        despues: normalizeSerializable(guardada),
      },
    });
    return guardada;
  });
}

/**
 * Al editar la base de cálculo del DO: no dejar menos contenedores de los que
 * ya llevan comisión (4 contenedores, 2 de LTRANS → no se puede bajar a 1).
 */
export async function verificarComisionesAlEditar(
  antes: {
    id: string;
    consecutivo: string;
    numContenedores: number | null;
    tipoCarga: TipoCarga | null;
  },
  cambios: { numContenedores?: number | null; tipoCarga?: TipoCarga | null },
): Promise<void> {
  if (cambios.numContenedores === undefined && cambios.tipoCarga === undefined) return;

  const agregado = await prisma.comisionTramite.aggregate({
    where: { tramiteId: antes.id },
    _sum: { unidades: true },
  });
  const comprometidas = agregado._sum.unidades ?? 0;
  if (comprometidas === 0) return;

  const despues = unidadesDisponibles({
    numContenedores:
      cambios.numContenedores !== undefined ? cambios.numContenedores : antes.numContenedores,
    tipoCarga: cambios.tipoCarga !== undefined ? cambios.tipoCarga : antes.tipoCarga,
  });
  if (despues === null || despues < comprometidas) {
    throw new ComisionInvalidaError(
      `El ${antes.consecutivo} tiene ${comprometidas} contenedor${comprometidas === 1 ? "" : "es"} con comisión: no puede quedar con menos. Ajusta primero la comisión.`,
    );
  }
}

export interface FilaComisionEmpresa {
  /** Id de la fila de comisión (lo que se manda a "Facturar comisiones"). */
  comisionId: string;
  tramiteId: string;
  consecutivo: string;
  empresaDo: string;
  referencia: string | null;
  fecha: Date;
  numContenedores: number | null;
  unidades: number;
  subtotal: bigint;
}

/** B10 — comisión ya facturada: sin subtotal recalculado (el valor por contenedor pudo cambiar después). */
export interface FilaComisionFacturada {
  comisionId: string;
  tramiteId: string;
  consecutivo: string;
  empresaDo: string;
  unidades: number;
  liquidadaEn: Date | null;
  /**
   * El «Otros» a nombre de la empresa donde se facturó. `deshacible` = se puede
   * deshacer la liquidación (M3); si no, `motivoNoDeshacible` dice por qué.
   */
  otros: {
    id: string;
    consecutivo: string;
    estado: string;
    valorServicio: bigint | null;
    deshacible: boolean;
    motivoNoDeshacible: string | null;
  };
}

export interface ComisionesDeEmpresa {
  habilitada: boolean;
  valorUnitario: bigint;
  tasaIva: bigint;
  /** Por facturar: solo las comisiones sin liquidar (los `totales` cuentan solo estas). */
  filas: FilaComisionEmpresa[];
  totales: TotalesComision;
  /** B10 — ya facturadas, con el «Otros» donde salieron. */
  facturadas: FilaComisionFacturada[];
}

/**
 * Comisiones de la empresa que paga (ficha de LTRANS): `filas` = por facturar
 * (sin liquidar; los `totales` solo cuentan estas) y `facturadas` = ya ligadas
 * a un «Otros» (B10, `liquidarComisiones`).
 */
export async function comisionesDeEmpresa(empresaId: string): Promise<ComisionesDeEmpresa> {
  const [capacidades, parametros, registros] = await Promise.all([
    capacidadesDeEmpresa(empresaId),
    getParametrosSistema(),
    prisma.comisionTramite.findMany({
      where: { empresaId },
      select: {
        id: true,
        unidades: true,
        liquidadaEn: true,
        liquidacion: {
          select: {
            id: true,
            consecutivo: true,
            estado: true,
            valorServicio: true,
            borradores: { select: { estado: true, siigoEnvioEstado: true, siigoDraftId: true } },
            _count: {
              select: { pagos: true, aplicacionesAnticipo: true, facturasProveedor: true, movimientosCuenta: true },
            },
          },
        },
        tramite: {
          select: {
            id: true,
            consecutivo: true,
            referenciaExterna: true,
            createdAt: true,
            numContenedores: true,
            cliente: { select: { nombre: true } },
          },
        },
      },
      orderBy: { tramite: { consecutivo: "asc" } },
    }),
  ]);

  const valorUnitario = valorUnitarioDe(capacidades);
  const porFacturar = registros.filter((r) => !r.liquidacion);
  const facturadas: FilaComisionFacturada[] = registros.flatMap((r) => {
    const otros = r.liquidacion;
    if (!otros) return [];
    // M3: la misma regla que aplica el servicio que deshace (`deshacer-reglas.ts`).
    const motivoNoDeshacible = impedimentoParaDeshacer({
      estado: otros.estado,
      borradores: otros.borradores,
      movimientos:
        otros._count.pagos +
        otros._count.aplicacionesAnticipo +
        otros._count.facturasProveedor +
        otros._count.movimientosCuenta,
    });
    return [
      {
        comisionId: r.id,
        tramiteId: r.tramite.id,
        consecutivo: r.tramite.consecutivo,
        empresaDo: r.tramite.cliente.nombre,
        unidades: r.unidades,
        liquidadaEn: r.liquidadaEn,
        otros: {
          id: otros.id,
          consecutivo: otros.consecutivo,
          estado: otros.estado,
          valorServicio: otros.valorServicio,
          deshacible: motivoNoDeshacible === null,
          motivoNoDeshacible,
        },
      },
    ];
  });
  const filas = porFacturar.map((r) => ({
    comisionId: r.id,
    tramiteId: r.tramite.id,
    consecutivo: r.tramite.consecutivo,
    empresaDo: r.tramite.cliente.nombre,
    referencia: r.tramite.referenciaExterna,
    fecha: r.tramite.createdAt,
    numContenedores: r.tramite.numContenedores,
    unidades: r.unidades,
    subtotal: BigInt(r.unidades) * valorUnitario,
  }));

  return {
    habilitada: tiene(capacidades, CAPACIDAD_COMISION),
    valorUnitario,
    tasaIva: parametros.tasaIva,
    filas,
    totales: totalesComision(
      filas.map((f) => ({ unidades: f.unidades, valorUnitario })),
      parametros.tasaIva,
    ),
    facturadas,
  };
}
