/**
 * CxP v2 — la ÚNICA puerta que sube o baja el saldo de una factura de
 * proveedor (diseño §B.2). Capa de BD: todas las funciones corren DENTRO de una
 * transacción interactiva (`prisma.$transaction(async (tx) => …)`).
 *
 * Caminos que pasan por aquí:
 *   · pago simple del DO (`crearPago`)             → modo PAGO_SIMPLE
 *   · "Generar pago" desde la factura (API/MCP)    → modo GENERAR_PAGO
 *   · pago en bloque (`crearPagoMultiDO`)          → modo BLOQUE
 *   · conciliación con el Excel (P7)               → modo CONCILIACION
 *   · cruce de cuenta corriente                    → modo COMPENSACION
 * y para devolver saldo: borrar un pago suelto, anular un bloque, deshacer un
 * cruce (`revertirSaldo`) y quitar un ajuste LEGADO (`eliminarAjusteLegado`).
 *
 * Orden único de bloqueo (evita deadlocks, §B.5):
 *   (1) cabecera de idempotencia → (2) `bloquearTramites` → (3) `bloquearFacturas`.
 * El guardián de BD (`trg_pago_factura_saldo`, M5) repite el control de saldo;
 * si responde `CXP_SOBREAPLICACION` se traduce a `MontoExcedeSaldoError` (409).
 */

import { type EstadoFacturaProveedor, Prisma } from "@prisma/client";

import { bloquearTramites } from "@/lib/cxp/bloqueos";
import {
  errorDeAplicacion,
  esErrorSobreaplicacion,
  MontoExcedeSaldoError,
  SinAnticipoError,
} from "@/lib/cxp/errores";
import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import {
  claveProveedorDeFicha,
  estadoDe,
  type EstadoCxp,
  numeroFacturaVisible,
  type ProveedorDePago,
  saldoDe,
  type SolicitudAplicacion,
  validarAplicaciones,
} from "@/lib/cxp/saldos";
import type {
  CambioSaldoFactura,
  FacturaBloqueada,
  FichaProveedor,
  ModoAplicacion,
  OrigenSaldo,
  ResultadoAplicacion,
} from "@/lib/cxp/tipos";
import { prisma } from "@/lib/db/prisma";
import { TramiteCerradoError } from "@/lib/tramites/guard";

type Tx = Prisma.TransactionClient;

function serializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

// ─── Errores propios de esta capa ─────────────────────────────────────────────

export class AjusteNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(ajusteId: string) {
    super(`Ajuste ${ajusteId} no encontrado.`);
    this.name = "AjusteNoEncontradoError";
  }
}

export class AjusteNoEliminableError extends Error {
  public readonly status = 422;
  constructor() {
    super("Solo se pueden quitar los ajustes que dejó la migración (LEGADO).");
    this.name = "AjusteNoEliminableError";
  }
}

// ─── Bloqueo y carga de facturas ──────────────────────────────────────────────

const fichaSelect = {
  id: true,
  nombre: true,
  nombreCorto: true,
  nit: true,
  nitBase: true,
  numFacturaConEspacio: true,
  conciliacionPendiente: true,
  empresaId: true,
} satisfies Prisma.BeneficiarioSelect;

/**
 * `SELECT … FROM factura_proveedor WHERE id = ANY($1) ORDER BY id FOR UPDATE` y
 * luego carga saldos frescos (Σ puente, Σ ajustes, compensado), ficha y DO.
 * En READ COMMITTED, tras obtener el bloqueo las sumas ya ven lo que confirmó
 * cualquier otra transacción: el segundo de dos pagos simultáneos ve el saldo
 * real. Los ids que no existen no vuelven en el mapa.
 */
export async function bloquearFacturas(tx: Tx, ids: readonly string[]): Promise<Map<string, FacturaBloqueada>> {
  const unicos = [...new Set(ids)].sort();
  const resultado = new Map<string, FacturaBloqueada>();
  if (unicos.length === 0) return resultado;

  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "factura_proveedor" WHERE id = ANY(${unicos}::text[]) ORDER BY id FOR UPDATE`,
  );

  const [filas, sumas] = await Promise.all([
    tx.facturaProveedor.findMany({
      where: { id: { in: unicos } },
      select: {
        id: true,
        tramiteId: true,
        numFactura: true,
        proveedorNombre: true,
        proveedorClave: true,
        beneficiarioId: true,
        valor: true,
        montoCompensado: true,
        compensacionId: true,
        estado: true,
        repercutible: true,
        fecha: true,
        createdAt: true,
        moneda: true,
        beneficiario: { select: fichaSelect },
        ajustes: { select: { tipo: true, monto: true } },
        tramite: {
          select: { id: true, consecutivo: true, estado: true, clienteId: true, anio: true, numero: true },
        },
      },
    }),
    tx.pagoTramiteFactura.groupBy({
      by: ["facturaId"],
      where: { facturaId: { in: unicos } },
      _sum: { monto: true },
    }),
  ]);

  for (const f of filas) {
    const ficha: FichaProveedor | null = f.beneficiario ?? null;
    const aplicado = sumas.find((s) => s.facturaId === f.id)?._sum.monto ?? 0n;
    const ajustes = f.ajustes.reduce((s, a) => s + a.monto, 0n);
    resultado.set(f.id, {
      id: f.id,
      numFactura: numeroFacturaVisible(f.numFactura, ficha?.numFacturaConEspacio ?? false),
      numFacturaOriginal: f.numFactura,
      tramiteId: f.tramiteId,
      beneficiarioId: f.beneficiarioId,
      proveedorClave: ficha ? claveProveedorDeFicha(ficha) : null,
      proveedorClaveColumna: f.proveedorClave,
      nombreProveedor: ficha ? (ficha.nombreCorto ?? ficha.nombre) : f.proveedorNombre,
      valor: f.valor,
      aplicado,
      ajustes,
      compensado: f.montoCompensado,
      estado: f.estado,
      repercutible: f.repercutible,
      fecha: f.fecha,
      createdAt: f.createdAt,
      moneda: f.moneda,
      tieneAjusteLegado: f.ajustes.some((a) => a.tipo === "LEGADO"),
      compensacionId: f.compensacionId,
      beneficiario: ficha,
      tramite: f.tramite,
    });
  }
  return resultado;
}

// ─── Estado derivado ──────────────────────────────────────────────────────────

async function partesDe(tx: Tx, facturaId: string) {
  const factura = await tx.facturaProveedor.findUnique({
    where: { id: facturaId },
    select: { valor: true, montoCompensado: true, estado: true, tramiteId: true },
  });
  if (!factura) return null;
  const [aplicado, ajustes] = await Promise.all([
    tx.pagoTramiteFactura.aggregate({ where: { facturaId }, _sum: { monto: true } }),
    tx.ajusteFacturaProveedor.aggregate({ where: { facturaId }, _sum: { monto: true } }),
  ]);
  return {
    factura,
    partes: {
      valor: factura.valor,
      aplicado: aplicado._sum.monto ?? 0n,
      ajustes: ajustes._sum.monto ?? 0n,
      compensado: factura.montoCompensado,
    },
  };
}

/**
 * Único escritor de `FacturaProveedor.estado`: lo recalcula desde el saldo
 * (`estadoDe`). Escribe AuditLog `UPDATE_ESTADO` si cambia (salvo
 * `auditar: false`, cuando el llamador deja su propio registro más completo).
 */
export async function recalcularEstadoFactura(
  tx: Tx,
  facturaId: string,
  ctx: { usuarioId: string; motivo: string; auditar?: boolean },
): Promise<{ estadoAntes: EstadoFacturaProveedor; estadoDespues: EstadoCxp; saldo: bigint }> {
  const datos = await partesDe(tx, facturaId);
  if (!datos) throw new Error(`Factura de proveedor ${facturaId} no encontrada al recalcular su estado`);
  const saldo = saldoDe(datos.partes);
  const estadoDespues = estadoDe(datos.partes);
  const estadoAntes = datos.factura.estado;
  if (estadoAntes !== estadoDespues) {
    await tx.facturaProveedor.update({ where: { id: facturaId }, data: { estado: estadoDespues } });
    if (ctx.auditar !== false) {
      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaId,
          accion: "UPDATE_ESTADO",
          usuarioId: ctx.usuarioId,
          tramiteId: datos.factura.tramiteId,
          antes: serializable({ estado: estadoAntes }),
          despues: serializable({ estado: estadoDespues, saldo, motivo: ctx.motivo }),
        },
      });
    }
  }
  return { estadoAntes, estadoDespues, saldo };
}

// ─── Aplicar ──────────────────────────────────────────────────────────────────

export interface AplicarSaldoInput {
  origen: OrigenSaldo;
  aplicaciones: SolicitudAplicacion[];
  /** Ya bloqueadas en ESTA transacción con `bloquearFacturas` (se actualizan en sitio). */
  facturas: Map<string, FacturaBloqueada>;
  /** Pago simple: fichas del pago (cada factura debe ser de una de ellas). */
  proveedoresPago?: ProveedorDePago[];
  /** Bloque / compensación: todas del mismo proveedor. */
  proveedorBloque?: { clave: string; nombre: string };
  modo: ModoAplicacion;
  usuarioId: string;
}

/**
 * ÚNICA puerta para bajar el saldo de una factura.
 *  1. `validarAplicaciones` (puro) → error tipado con todos los detalles.
 *  2. Pagabilidad por DO: DO no CERRADO; anticipo según `exigeAnticipoDelDo`
 *     (salvo costos propios no repercutibles, registro histórico o cruce).
 *  3. PAGO: puente con `monto`. COMPENSACION: `montoCompensado += monto`.
 *  4. Estado derivado + AuditLog por factura (estado y saldo antes/después, monto, modo, origen).
 *  5. Si el guardián de BD responde CXP_SOBREAPLICACION → `MontoExcedeSaldoError`.
 */
export async function aplicarSaldo(tx: Tx, input: AplicarSaldoInput): Promise<ResultadoAplicacion> {
  const { origen, aplicaciones, facturas, modo, usuarioId } = input;

  const validacion = validarAplicaciones({
    solicitudes: aplicaciones,
    facturas,
    tramiteIdPago: origen.tipo === "PAGO" ? origen.tramiteId : undefined,
    proveedoresPago: input.proveedoresPago,
    proveedorBloque: input.proveedorBloque,
  });
  if (!validacion.ok) throw errorDeAplicacion(validacion.errores);

  // DO cerrado: nadie aplica saldo (R10).
  for (const s of aplicaciones) {
    const f = facturas.get(s.facturaProveedorId)!;
    if (f.tramite.estado === "CERRADO") {
      throw new TramiteCerradoError({ id: f.tramite.id, consecutivo: f.tramite.consecutivo });
    }
  }

  // Sin anticipo no hay pago (R9): solo pagos reales, no históricos ni cruces.
  const exentoAnticipo = origen.tipo === "COMPENSACION" || (origen.tipo === "PAGO" && origen.esHistorico);
  if (!exentoAnticipo) {
    const porDo = new Map<string, boolean>();
    for (const s of aplicaciones) {
      const f = facturas.get(s.facturaProveedorId)!;
      porDo.set(f.tramiteId, (porDo.get(f.tramiteId) ?? false) || f.repercutible);
    }
    const tramitesConTerceros = [...porDo.entries()].filter(([, repercute]) => repercute).map(([id]) => id);
    const contexto = await cargarContextoDos(tx, tramitesConTerceros);
    for (const tramiteId of tramitesConTerceros) {
      const c = contexto.get(tramiteId);
      if (c && c.exigeAnticipo && !c.tieneAnticipoAplicado) {
        throw new SinAnticipoError(c.consecutivo, c.clienteNombre);
      }
    }
  }

  const cambios: CambioSaldoFactura[] = [];
  for (const s of aplicaciones) {
    const f = facturas.get(s.facturaProveedorId)!;
    const saldoAntes = saldoDe(f);
    try {
      if (origen.tipo === "PAGO") {
        await tx.pagoTramiteFactura.create({
          data: { pagoId: origen.pagoId, facturaId: f.id, monto: s.monto },
        });
      } else {
        await tx.facturaProveedor.update({
          where: { id: f.id },
          data: { montoCompensado: { increment: s.monto }, compensacionId: origen.compensacionId },
        });
      }
    } catch (e) {
      if (esErrorSobreaplicacion(e)) throw new MontoExcedeSaldoError(f.numFactura, saldoAntes, s.monto);
      throw e;
    }

    if (origen.tipo === "PAGO") f.aplicado += s.monto;
    else {
      f.compensado += s.monto;
      f.compensacionId = origen.compensacionId;
    }

    const { estadoAntes, estadoDespues, saldo } = await recalcularEstadoFactura(tx, f.id, {
      usuarioId,
      motivo: modo,
      auditar: false,
    });
    f.estado = estadoDespues;

    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: f.id,
        accion: "UPDATE_ESTADO",
        usuarioId,
        tramiteId: f.tramiteId,
        antes: serializable({
          estado: estadoAntes,
          saldo: saldoAntes,
          // Compatibilidad con la pasada 0 de la migración / re-avance (monto del bloque).
          ...(modo === "BLOQUE" ? { montoPagadoEnGrupo: s.monto } : {}),
        }),
        despues: serializable({ estado: estadoDespues, saldo, monto: s.monto, modo, origen }),
      },
    });

    cambios.push({
      facturaId: f.id,
      monto: s.monto,
      saldoAntes,
      saldoDespues: saldo,
      estadoAntes,
      estadoDespues,
    });
  }

  return { modo, origen, aplicaciones, cambios };
}

// ─── Revertir ─────────────────────────────────────────────────────────────────

export type RevertirSaldoInput =
  | { tipo: "PAGOS"; pagoIds: string[] }
  | { tipo: "COMPENSACION"; compensacionId: string };

/**
 * ÚNICA puerta para devolver saldo (borrar pago suelto, anular bloque, deshacer
 * cruce). Bloquea las facturas afectadas, borra el puente (o deja el
 * compensado en 0 y `compensacionId` null) y recalcula el estado. El llamador
 * ya tomó `bloquearTramites` de los DOs involucrados. Devuelve los ids de las
 * facturas afectadas.
 */
export async function revertirSaldo(
  tx: Tx,
  input: RevertirSaldoInput,
  usuarioId: string,
  motivo: string,
): Promise<string[]> {
  if (input.tipo === "PAGOS") {
    if (input.pagoIds.length === 0) return [];
    const puentes = await tx.pagoTramiteFactura.findMany({
      where: { pagoId: { in: input.pagoIds } },
      select: { pagoId: true, facturaId: true, monto: true },
    });
    const facturaIds = [...new Set(puentes.map((p) => p.facturaId))].sort();
    const bloqueadas = await bloquearFacturas(tx, facturaIds);
    await tx.pagoTramiteFactura.deleteMany({ where: { pagoId: { in: input.pagoIds } } });
    for (const facturaId of facturaIds) {
      const f = bloqueadas.get(facturaId);
      const monto = puentes.filter((p) => p.facturaId === facturaId).reduce((s, p) => s + p.monto, 0n);
      const saldoAntes = f ? saldoDe(f) : null;
      const r = await recalcularEstadoFactura(tx, facturaId, { usuarioId, motivo, auditar: false });
      await tx.auditLog.create({
        data: {
          entidad: "FacturaProveedor",
          entidadId: facturaId,
          accion: "UPDATE_ESTADO",
          usuarioId,
          tramiteId: f?.tramiteId,
          antes: serializable({ estado: r.estadoAntes, saldo: saldoAntes }),
          despues: serializable({
            estado: r.estadoDespues,
            saldo: r.saldo,
            montoRevertido: monto,
            modo: "REVERSION",
            pagoIds: input.pagoIds,
            motivo,
          }),
        },
      });
    }
    return facturaIds;
  }

  const afectadas = await tx.facturaProveedor.findMany({
    where: { compensacionId: input.compensacionId },
    select: { id: true },
  });
  const facturaIds = afectadas.map((f) => f.id).sort();
  const bloqueadas = await bloquearFacturas(tx, facturaIds);
  for (const facturaId of facturaIds) {
    const f = bloqueadas.get(facturaId);
    const saldoAntes = f ? saldoDe(f) : null;
    await tx.facturaProveedor.update({
      where: { id: facturaId },
      data: { montoCompensado: 0n, compensacionId: null },
    });
    const r = await recalcularEstadoFactura(tx, facturaId, { usuarioId, motivo, auditar: false });
    await tx.auditLog.create({
      data: {
        entidad: "FacturaProveedor",
        entidadId: facturaId,
        accion: "UPDATE_ESTADO",
        usuarioId,
        tramiteId: f?.tramiteId,
        antes: serializable({ estado: r.estadoAntes, saldo: saldoAntes, compensado: f?.compensado ?? null }),
        despues: serializable({
          estado: r.estadoDespues,
          saldo: r.saldo,
          modo: "REVERSION_COMPENSACION",
          compensacionId: input.compensacionId,
          motivo,
        }),
      },
    });
  }
  return facturaIds;
}

// ─── Ajuste LEGADO (v2: solo se puede quitar) ─────────────────────────────────

/**
 * Quita un ajuste LEGADO que dejó la migración y reabre la factura
 * (Abonada / Pendiente). Solo ADMIN (lo exige la ruta). DO modificable.
 * v2 no crea ajustes manuales (D-8).
 */
export async function eliminarAjusteLegado(
  ajusteId: string,
  motivo: string,
  usuarioId: string,
): Promise<{ facturaId: string; estado: EstadoCxp; saldo: bigint }> {
  return prisma.$transaction(async (tx) => {
    const ajuste = await tx.ajusteFacturaProveedor.findUnique({
      where: { id: ajusteId },
      select: { id: true, tipo: true, monto: true, motivo: true, facturaId: true, factura: { select: { tramiteId: true } } },
    });
    if (!ajuste) throw new AjusteNoEncontradoError(ajusteId);
    if (ajuste.tipo !== "LEGADO") throw new AjusteNoEliminableError();

    const tramiteId = ajuste.factura.tramiteId;
    await bloquearTramites(tx, [tramiteId]);
    const tramite = await tx.tramiteDO.findUnique({
      where: { id: tramiteId },
      select: { id: true, consecutivo: true, estado: true },
    });
    if (tramite?.estado === "CERRADO") throw new TramiteCerradoError(tramite);

    await bloquearFacturas(tx, [ajuste.facturaId]);
    await tx.ajusteFacturaProveedor.delete({ where: { id: ajusteId } });
    const r = await recalcularEstadoFactura(tx, ajuste.facturaId, { usuarioId, motivo, auditar: false });

    await tx.auditLog.create({
      data: {
        entidad: "AjusteFacturaProveedor",
        entidadId: ajusteId,
        accion: "DELETE_AJUSTE_LEGADO",
        usuarioId,
        tramiteId,
        antes: serializable({ ...ajuste, estadoFactura: r.estadoAntes }),
        despues: serializable({ facturaId: ajuste.facturaId, estado: r.estadoDespues, saldo: r.saldo, motivo }),
      },
    });

    return { facturaId: ajuste.facturaId, estado: r.estadoDespues, saldo: r.saldo };
  });
}
