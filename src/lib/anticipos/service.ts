import { EstadoMovimiento, Rol, TipoRecaudo } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

export class VerificarAnticipoPermisoError extends Error {
  public readonly status = 403;
  constructor() {
    super("No tienes permiso para verificar este anticipo");
    this.name = "VerificarAnticipoPermisoError";
  }
}

export class AnticipoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Anticipo ${id} no encontrado`);
    this.name = "AnticipoNoEncontradoError";
  }
}

type CrearAnticipoInput = {
  clienteId: string;
  monto: bigint;
  fecha: Date;
  tipoRecaudo: TipoRecaudo;
  soporteKey?: string | null;
  verificadoBanco?: boolean;
};

type AplicarAnticipoInput = {
  anticipoId: string;
  tramiteId: string;
  montoAplicado: bigint;
};

type AplicarAnticipoResult =
  | { ok: true; aplicacion: { id: string; anticipoId: string; tramiteId: string; montoAplicado: bigint; createdAt: Date } }
  | { ok: false; status: number; message: string };

type DesgloseDO = {
  aplicacionId: string;
  tramiteId: string;
  consecutivo: string;
  montoAplicado: bigint;
};

type AnticipoConSaldo = {
  id: string;
  clienteId: string;
  monto: bigint;
  fecha: Date;
  tipoRecaudo: TipoRecaudo;
  costoRecaudo: bigint;
  soporteKey: string | null;
  verificadoBanco: boolean;
  createdAt: Date;
  updatedAt: Date;
  aplicado: bigint;
  restante: bigint;
  aplicaciones: DesgloseDO[];
};

export async function crearAnticipo(input: CrearAnticipoInput) {
  // Snapshot del costo de recaudo desde la matriz
  const matrizRow = await prisma.matrizRecaudo.findUnique({
    where: { tipoRecaudo: input.tipoRecaudo },
    select: { costoFijo: true },
  });
  const costoRecaudo = matrizRow?.costoFijo ?? 0n;

  return prisma.anticipo.create({
    data: {
      clienteId: input.clienteId,
      monto: input.monto,
      fecha: input.fecha,
      tipoRecaudo: input.tipoRecaudo,
      costoRecaudo,
      soporteKey: input.soporteKey ?? null,
      verificadoBanco: input.verificadoBanco ?? false,
    },
  });
}

export async function aplicarAnticipo(
  input: AplicarAnticipoInput,
): Promise<AplicarAnticipoResult> {
  const lockKey = `anticipo:${input.anticipoId}`;

  return prisma.$transaction(async (tx) => {
    // Advisory lock para evitar sobre-aplicación bajo concurrencia
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const anticipo = await tx.anticipo.findUnique({
      where: { id: input.anticipoId },
      include: {
        aplicaciones: {
          select: { montoAplicado: true },
        },
      },
    });

    if (!anticipo) {
      return { ok: false, status: 404, message: "Anticipo no encontrado" };
    }

    const tramite = await tx.tramiteDO.findUnique({
      where: { id: input.tramiteId },
      select: { id: true },
    });

    if (!tramite) {
      return { ok: false, status: 404, message: "Tramite no encontrado" };
    }

    const aplicadoActual = anticipo.aplicaciones.reduce(
      (sum, ap) => sum + ap.montoAplicado,
      0n,
    );

    if (aplicadoActual + input.montoAplicado > anticipo.monto) {
      const restante = anticipo.monto - aplicadoActual;
      return {
        ok: false,
        status: 422,
        message: `Monto excede el saldo disponible del anticipo. Restante: ${restante}`,
      };
    }

    const aplicacion = await tx.aplicacionAnticipo.create({
      data: {
        anticipoId: input.anticipoId,
        tramiteId: input.tramiteId,
        montoAplicado: input.montoAplicado,
      },
    });

    return { ok: true, aplicacion };
  });
}

export async function eliminarAplicacion(aplicacionId: string) {
  return prisma.aplicacionAnticipo.delete({
    where: { id: aplicacionId },
  });
}

export async function getAnticipoConSaldo(
  anticipoId: string,
): Promise<AnticipoConSaldo | null> {
  const anticipo = await prisma.anticipo.findUnique({
    where: { id: anticipoId },
    include: {
      aplicaciones: {
        include: {
          tramite: {
            select: { id: true, consecutivo: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!anticipo) {
    return null;
  }

  const aplicado = anticipo.aplicaciones.reduce(
    (sum, ap) => sum + ap.montoAplicado,
    0n,
  );
  const restante = anticipo.monto - aplicado;

  const aplicaciones: DesgloseDO[] = anticipo.aplicaciones.map((ap) => ({
    aplicacionId: ap.id,
    tramiteId: ap.tramiteId,
    consecutivo: ap.tramite.consecutivo,
    montoAplicado: ap.montoAplicado,
  }));

  const { aplicaciones: _raw, ...base } = anticipo;
  void _raw;

  return {
    ...base,
    aplicado,
    restante,
    aplicaciones,
  };
}

type ListarAnticiposInput = {
  clienteId?: string;
  conSaldo?: boolean;
};

export async function listarAnticipos(
  input: ListarAnticiposInput = {},
): Promise<AnticipoConSaldo[]> {
  const anticipos = await prisma.anticipo.findMany({
    where: input.clienteId ? { clienteId: input.clienteId } : undefined,
    include: {
      aplicaciones: {
        include: {
          tramite: {
            select: { id: true, consecutivo: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { fecha: "desc" },
  });

  const resultado: AnticipoConSaldo[] = anticipos.map((anticipo) => {
    const aplicado = anticipo.aplicaciones.reduce(
      (sum, ap) => sum + ap.montoAplicado,
      0n,
    );
    const restante = anticipo.monto - aplicado;

    const aplicaciones: DesgloseDO[] = anticipo.aplicaciones.map((ap) => ({
      aplicacionId: ap.id,
      tramiteId: ap.tramiteId,
      consecutivo: ap.tramite.consecutivo,
      montoAplicado: ap.montoAplicado,
    }));

    const { aplicaciones: _raw, ...base } = anticipo;
    void _raw;

    return {
      ...base,
      aplicado,
      restante,
      aplicaciones,
    };
  });

  if (input.conSaldo) {
    return resultado.filter((a) => a.restante > 0n);
  }

  return resultado;
}

/**
 * Cambia el estado de un anticipo (BORRADOR → REALIZADO → VERIFICADO).
 * Regla de permiso:
 *   - Cliente SOCIO_LM: solo ADMIN puede verificar.
 *   - Cliente PROPIO: ADMIN o OPERATIVO pueden verificar.
 */
export async function verificarAnticipo(
  anticipoId: string,
  nuevoEstado: EstadoMovimiento,
  usuarioRol: Rol,
  usuarioId?: string,
) {
  const anticipo = await prisma.anticipo.findUnique({
    where: { id: anticipoId },
    include: { cliente: { select: { tipo: true } } },
  });

  if (!anticipo) {
    throw new AnticipoNoEncontradoError(anticipoId);
  }

  const esClienteSocioLM = anticipo.cliente.tipo === "SOCIO_LM";
  const puedeVerificar = usuarioRol === Rol.ADMIN ||
    (!esClienteSocioLM && usuarioRol === Rol.OPERATIVO);

  if (!puedeVerificar) {
    throw new VerificarAnticipoPermisoError();
  }

  const estadoAntes = anticipo.estado;
  const verificadoBancoAntes = anticipo.verificadoBanco;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.anticipo.update({
      where: { id: anticipoId },
      data: {
        estado: nuevoEstado,
        verificadoBanco: nuevoEstado === "VERIFICADO" ? true : anticipo.verificadoBanco,
      },
    });

    if (usuarioId) {
      await tx.auditLog.create({
        data: {
          entidad: "Anticipo",
          entidadId: anticipoId,
          accion: "VERIFICAR",
          usuarioId,
          antes: { estado: estadoAntes, verificadoBanco: verificadoBancoAntes } as import("@prisma/client").Prisma.InputJsonValue,
          despues: { estado: nuevoEstado, verificadoBanco: updated.verificadoBanco } as import("@prisma/client").Prisma.InputJsonValue,
        },
      });
    }

    return updated;
  });
}
