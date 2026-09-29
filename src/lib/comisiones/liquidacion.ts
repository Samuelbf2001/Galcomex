/**
 * B10 — "Facturar comisiones" (caso LTRANS, Diseño B, 29-sep-2026).
 *
 * La comisión por contenedor se registra por DO (`comision_tramite`). Aquí se
 * convierte en factura: las comisiones que se escogen se juntan en UN servicio
 * «Otros» a nombre de la empresa que paga (valor = Σ unidades × valor por
 * contenedor, concepto de venta de su config) y quedan ligadas a él
 * (`liquidacionTramiteId`): no se pueden volver a cobrar, cambiar ni quitar.
 *
 * Todo pasa en UNA transacción (`createTramite` + gancho `alCrear`): si dos
 * personas facturan las mismas comisiones a la vez, una crea el «Otros» y la
 * otra recibe 409 sin dejar un DO huérfano. El «Otros» sigue el flujo corto de
 * siempre ("Mandar a facturar" → borrador → Siigo → cartera): esta función NO
 * factura ni toca Siigo.
 *
 * Dinero en BigInt (COP enteros), tolerancia 0. Sin columna de dinero nueva:
 * el valor facturado queda en `valorServicio` del «Otros» y en el AuditLog.
 */

import { Ciudad } from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import {
  CAPACIDAD_COMISION,
  configLiquidacionDe,
  referenciaLiquidacion,
  valorUnitarioDe,
} from "@/lib/comisiones/calculo";
import { ComisionInvalidaError } from "@/lib/comisiones/service";
import { prisma } from "@/lib/db/prisma";
import { normalizeSerializable } from "@/lib/db/serializable";
import { createTramite } from "@/lib/tramites/service";

/** Otra persona ya facturó alguna de las comisiones escogidas (o el DO ya las tiene ligadas). */
export class ComisionYaLiquidadaError extends Error {
  public readonly status = 409;
  public readonly codigo = "COMISION_YA_LIQUIDADA" as const;
  constructor() {
    super("Otra persona ya facturó alguna de estas comisiones. Recarga la ficha para ver lo que sigue por facturar.");
    this.name = "ComisionYaLiquidadaError";
  }
}

/**
 * B3 (revisión INTEG-B) — los contenedores de alguna comisión cambiaron entre
 * que se leyó la ficha y que se creó el «Otros»: lo cobrado no coincidiría con
 * lo que queda ligado. Se deshace todo (sin DO huérfano) y se pide recargar.
 */
export class ComisionCambioAlLiquidarError extends Error {
  public readonly status = 409;
  public readonly codigo = "COMISION_CAMBIO_AL_LIQUIDAR" as const;
  constructor() {
    super(
      "Los contenedores de alguna comisión cambiaron mientras se facturaba. Recarga la ficha y vuelve a intentar.",
    );
    this.name = "ComisionCambioAlLiquidarError";
  }
}

export interface LiquidarComisionesInput {
  /** Empresa que paga la comisión (LTRANS); el «Otros» sale a su nombre. */
  empresaId: string;
  /** Ids de `comision_tramite` a facturar (todas de esa empresa y sin liquidar). */
  comisionIds: string[];
  /** Ciudad del «Otros» (consecutivo). Por defecto Barranquilla. */
  ciudad?: Ciudad;
  usuarioId: string;
}

export interface LiquidarComisionesResultado {
  tramiteId: string;
  consecutivo: string;
  /** Σ unidades × valor por contenedor, SIN IVA: es el `valorServicio` del «Otros». */
  total: bigint;
  unidades: number;
  valorUnitario: bigint;
}

export async function liquidarComisiones(
  input: LiquidarComisionesInput,
): Promise<LiquidarComisionesResultado> {
  const ids = [...new Set(input.comisionIds)];
  if (ids.length === 0) {
    throw new ComisionInvalidaError("Escoge al menos una comisión para facturar.");
  }

  const [capacidades, empresa] = await Promise.all([
    capacidadesDeEmpresa(input.empresaId),
    prisma.cliente.findUnique({ where: { id: input.empresaId }, select: { nombre: true } }),
  ]);
  const nombreEmpresa = empresa?.nombre ?? "La empresa";

  if (!tiene(capacidades, CAPACIDAD_COMISION)) {
    throw new ComisionInvalidaError(
      `Activa «Comisión a cobrar por contenedor» en ${nombreEmpresa} (ficha, pestaña Funciones).`,
    );
  }
  const valorUnitario = valorUnitarioDe(capacidades);
  if (valorUnitario <= 0n) {
    throw new ComisionInvalidaError(
      `Falta el valor por contenedor de ${nombreEmpresa}: configúralo en Funciones → «Comisión a cobrar por contenedor».`,
    );
  }
  if (!tiene(capacidades, "factura_conceptos_iva")) {
    throw new ComisionInvalidaError(
      `Activa «Factura con conceptos e IVA» en ${nombreEmpresa} (ficha, pestaña Funciones): sin ella no se le puede facturar la comisión.`,
    );
  }
  const config = configLiquidacionDe(capacidades);
  const concepto = await prisma.conceptoVenta.findUnique({
    where: { codigo: config.conceptoVenta },
    select: { activo: true },
  });
  if (!concepto || !concepto.activo) {
    throw new ComisionInvalidaError(
      `El concepto de venta «${config.conceptoVenta}» no existe o está inactivo. Créalo en Configuración → Catálogos, o cámbialo en la función «Comisión a cobrar por contenedor» de ${nombreEmpresa}.`,
    );
  }

  const comisiones = await prisma.comisionTramite.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      empresaId: true,
      unidades: true,
      liquidacionTramiteId: true,
      tramite: { select: { consecutivo: true } },
    },
    orderBy: { tramite: { consecutivo: "asc" } },
  });
  if (comisiones.length !== ids.length || comisiones.some((c) => c.empresaId !== input.empresaId)) {
    throw new ComisionInvalidaError(
      `Alguna de las comisiones escogidas no existe o no es de ${nombreEmpresa}. Recarga la ficha.`,
    );
  }
  if (comisiones.some((c) => c.liquidacionTramiteId !== null)) {
    throw new ComisionYaLiquidadaError();
  }

  const unidades = comisiones.reduce((suma, c) => suma + c.unidades, 0);
  const total = comisiones.reduce((suma, c) => suma + BigInt(c.unidades) * valorUnitario, 0n);
  const filas = comisiones.map((c) => ({ consecutivo: c.tramite.consecutivo, unidades: c.unidades }));
  const liquidadaEn = new Date();

  const tramite = await createTramite(
    {
      tipoTramiteCodigo: config.tipoTramite,
      clienteId: input.empresaId,
      ciudad: input.ciudad ?? Ciudad.BAQ,
      referenciaExterna: referenciaLiquidacion(filas),
      valorServicio: total,
      conceptoServicioCodigo: config.conceptoVenta,
      creadoPorId: input.usuarioId,
    },
    {
      // Dentro de la transacción de creación: o quedan el «Otros» Y las
      // comisiones ligadas, o no queda nada.
      alCrear: async (tx, creado) => {
        const ligadas = await tx.comisionTramite.updateMany({
          where: { id: { in: ids }, empresaId: input.empresaId, liquidacionTramiteId: null },
          data: { liquidacionTramiteId: creado.id, liquidadaEn },
        });
        if (ligadas.count !== ids.length) throw new ComisionYaLiquidadaError();

        // B3: las unidades se leyeron ANTES de esta transacción. Con las filas
        // ya ligadas (y bloqueadas por el UPDATE de arriba) se vuelven a sumar:
        // si alguien las cambió en el medio, lo cobrado (`total`) no coincide con
        // lo ligado y no se factura (409, se deshace el DO recién creado).
        const relegadas = await tx.comisionTramite.aggregate({
          where: { liquidacionTramiteId: creado.id },
          _sum: { unidades: true },
        });
        if ((relegadas._sum.unidades ?? 0) !== unidades) throw new ComisionCambioAlLiquidarError();

        await tx.auditLog.create({
          data: {
            entidad: "Cliente",
            entidadId: input.empresaId,
            accion: "LIQUIDAR_COMISIONES",
            usuarioId: input.usuarioId,
            tramiteId: creado.id,
            despues: normalizeSerializable({
              tramite: { id: creado.id, consecutivo: creado.consecutivo },
              comisiones: comisiones.map((c) => ({
                comisionId: c.id,
                tramite: c.tramite.consecutivo,
                unidades: c.unidades,
              })),
              unidades,
              valorUnitario,
              total,
              conceptoVenta: config.conceptoVenta,
            }),
          },
        });
      },
    },
  );

  return {
    tramiteId: tramite.id,
    consecutivo: tramite.consecutivo,
    total,
    unidades,
    valorUnitario,
  };
}
