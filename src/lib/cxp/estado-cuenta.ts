/**
 * CxP v2 — lecturas del estado de cuenta con el proveedor (diseño §D.1, §D.5).
 * Capa de BD, SOLO LECTURA.
 *
 * Una sola fuente de cifras para la ficha del proveedor, el modal "Pagar en
 * bloque" y el filtro por proveedor de `/pagos`:
 *   · `cargarFilasFacturas`       → filas por factura (saldo, estado, pagabilidad, pagos, ajustes)
 *   · `getEstadoCuentaProveedor`  → ficha de la empresa (JSON de `contratos-api.ts`)
 *   · `resumenPorProveedor`       → Total de sus facturas / Pagado / Pendiente (franja de /pagos)
 *
 * Qué fichas cuentan como "el proveedor": las fichas de pago enlazadas a la
 * empresa (`Beneficiario.empresaId`) MÁS las sueltas (sin empresa) que
 * comparten su NIT base (la llave anti-duplicado es el NIT base, no la ficha:
 * una empresa puede tener varias cuentas bancarias). Una ficha enlazada a OTRA
 * empresa no cuenta aunque comparta la base. La cuenta corriente usa esta
 * misma lista (`fichasDeEmpresa`).
 */

import type { EstadoBorrador, EstadoTramite, Moneda, Prisma, TipoAjusteFacturaProveedor } from "@prisma/client";

import type {
  AjusteFacturaJson,
  EstadoCuentaProveedorJson,
  FacturaElegibleJson,
  FilaEstadoCuentaJson,
  PagoRealizadoJson,
  ResumenCxpJson,
} from "@/lib/cxp/contratos-api";
import {
  type AdvertenciaPago,
  advertenciaAnticipoInsuficiente,
  advertenciaAnticipoSinVerificar,
  evaluarPagabilidad,
  type MotivoNoPagable,
} from "@/lib/cxp/pagabilidad";
import { cargarContextoDos } from "@/lib/cxp/pagabilidad-bd";
import {
  doCorto,
  estadoDe,
  type EstadoCxp,
  etiquetaDe,
  type EtiquetaCxp,
  nitBaseDe,
  numeroFacturaVisible,
  type ResumenCxp,
  resumenProveedor,
  saldoDe,
} from "@/lib/cxp/saldos";
import type { CostoAsumidoPor } from "@/lib/cxp/tipos";
import { prisma } from "@/lib/db/prisma";
import { fechaCalendarioAInput } from "@/lib/tiempo/bogota";

type Db = typeof prisma | Prisma.TransactionClient;
export type RolLectorCxp = "ADMIN" | "REVISOR" | "OPERATIVO" | "SOCIO";

export class EmpresaProveedorNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(empresaId: string) {
    super(`Empresa ${empresaId} no encontrada`);
    this.name = "EmpresaProveedorNoEncontradaError";
  }
}

// ─── Filas por factura ────────────────────────────────────────────────────────

export interface PagoDeFacturaCxp {
  pagoId: string;
  grupoPagoId: string | null;
  fechaRealPago: Date | null;
  createdAt: Date;
  monto: bigint;
  esHistorico: boolean;
  comprobante: { documentoId: string; tramiteId: string } | null;
}

export interface AjusteDeFacturaCxp {
  id: string;
  tipo: TipoAjusteFacturaProveedor;
  monto: bigint;
  motivo: string;
  createdAt: Date;
}

/** Fila de dominio (BigInt, Date). Se serializa con `aFacturaElegibleJson` / `aFilaEstadoCuentaJson`. */
export interface FilaFacturaCxp {
  id: string;
  numFactura: string;
  numFacturaVisible: string;
  valor: bigint;
  aplicado: bigint;
  ajustes: bigint;
  compensado: bigint;
  saldo: bigint;
  estado: EstadoCxp;
  etiqueta: EtiquetaCxp;
  fecha: Date;
  createdAt: Date;
  moneda: Moneda;
  valorOrigenCentavos: bigint | null;
  trmCentavos: bigint | null;
  tramiteId: string;
  tramiteConsecutivo: string;
  doCorto: string;
  tramiteEstado: EstadoTramite;
  marca: string | null;
  clienteId: string;
  clienteNombre: string;
  beneficiarioId: string | null;
  beneficiarioNombre: string | null;
  repercutible: boolean;
  /** Saldo del DO (anticipos aplicados − pagos) antes de este pago. */
  saldoTramite: bigint;
  pagable: boolean;
  motivoNoPagable: MotivoNoPagable | null;
  advertencias: AdvertenciaPago[];
  puedeAbsorberCosto: boolean;
  conciliacionPendiente: boolean;
  /** Compatibilidad con e5cd35b: el DO tiene anticipo aplicado o la factura es un costo propio. */
  tieneAnticipoAplicado: boolean;
  facturadaAlCliente: { numSiigo: string | null; estado: EstadoBorrador } | null;
  pagos: PagoDeFacturaCxp[];
  ajustesDetalle: AjusteDeFacturaCxp[];
  tieneAjusteLegado: boolean;
  /** Fecha del pago que la dejó en saldo 0 (null si tiene saldo o se cerró sin pago). */
  fechaPago: Date | null;
  /** Abonos mientras tenga saldo (columna ABONOS de la exportación). */
  abonos: { fecha: Date | null; monto: bigint }[];
}

const facturaCxpSelect = {
  id: true,
  tramiteId: true,
  numFactura: true,
  proveedorNombre: true,
  beneficiarioId: true,
  valor: true,
  montoCompensado: true,
  fecha: true,
  createdAt: true,
  moneda: true,
  valorOrigenCentavos: true,
  trmCentavos: true,
  repercutible: true,
  beneficiario: {
    select: { id: true, nombre: true, nombreCorto: true, numFacturaConEspacio: true, conciliacionPendiente: true },
  },
  tramite: { select: { consecutivo: true, estado: true, anio: true, numero: true } },
  ajustes: { select: { id: true, tipo: true, monto: true, motivo: true, createdAt: true } },
  pagos: {
    select: {
      monto: true,
      pagoId: true,
      pago: {
        select: {
          grupoPagoId: true,
          fechaRealPago: true,
          createdAt: true,
          documento: { select: { id: true, tramiteId: true } },
          grupo: { select: { esHistorico: true } },
        },
      },
    },
  },
  lineasRevision: {
    select: { linea: { select: { borrador: { select: { estado: true, numFacturaSiigo: true } } } } },
  },
} satisfies Prisma.FacturaProveedorSelect;

function ordenPago(a: PagoDeFacturaCxp, b: PagoDeFacturaCxp): number {
  const fa = (a.fechaRealPago ?? a.createdAt).getTime();
  const fb = (b.fechaRealPago ?? b.createdAt).getTime();
  return fa - fb || a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Carga las facturas que cumplen `where` con todo lo que la ficha, el modal y
 * `/pagos` necesitan. Orden: DO (consecutivo) y fecha.
 */
export async function cargarFilasFacturas(
  db: Db,
  where: Prisma.FacturaProveedorWhereInput,
): Promise<FilaFacturaCxp[]> {
  const facturas = await db.facturaProveedor.findMany({
    where,
    select: facturaCxpSelect,
    orderBy: [{ tramite: { consecutivo: "asc" } }, { fecha: "asc" }, { createdAt: "asc" }],
  });
  const contexto = await cargarContextoDos(
    db,
    facturas.map((f) => f.tramiteId),
  );

  return facturas.map((f) => {
    const c = contexto.get(f.tramiteId)!;
    const aplicado = f.pagos.reduce((s, p) => s + p.monto, 0n);
    const ajustes = f.ajustes.reduce((s, a) => s + a.monto, 0n);
    const partes = { valor: f.valor, aplicado, ajustes, compensado: f.montoCompensado };
    const saldo = saldoDe(partes);
    const tieneAjusteLegado = f.ajustes.some((a) => a.tipo === "LEGADO");
    const pagos: PagoDeFacturaCxp[] = f.pagos
      .map((p) => ({
        pagoId: p.pagoId,
        grupoPagoId: p.pago.grupoPagoId,
        fechaRealPago: p.pago.fechaRealPago,
        createdAt: p.pago.createdAt,
        monto: p.monto,
        esHistorico: p.pago.grupo?.esHistorico ?? false,
        comprobante: p.pago.documento ? { documentoId: p.pago.documento.id, tramiteId: p.pago.documento.tramiteId } : null,
      }))
      .sort(ordenPago);
    const pagosConMonto = pagos.filter((p) => p.monto > 0n);
    const ultimoPago = pagosConMonto[pagosConMonto.length - 1];
    const cobrada = f.lineasRevision
      .map((l) => l.linea.borrador)
      .filter((b) => b.estado === "APROBADO" || b.estado === "FACTURADO")
      .sort((a, b) => (a.estado === b.estado ? 0 : a.estado === "FACTURADO" ? -1 : 1))[0];

    const { pagable, motivo } = evaluarPagabilidad({
      saldo,
      tramiteEstado: c.estado,
      consecutivo: c.consecutivo,
      clienteNombre: c.clienteNombre,
      exigeAnticipo: c.exigeAnticipo,
      tieneAnticipoAplicado: c.tieneAnticipoAplicado,
      repercutible: f.repercutible,
      tieneProveedor: f.beneficiarioId !== null,
    });

    const advertencias: AdvertenciaPago[] = [];
    if (saldo > 0n) {
      const insuficiente = advertenciaAnticipoInsuficiente({
        tramiteId: f.tramiteId,
        consecutivo: c.consecutivo,
        anio: c.anio,
        numero: c.numero,
        saldoDespues: c.saldoTramite - saldo,
      });
      if (insuficiente && f.repercutible) advertencias.push(insuficiente);
      if (c.anticipoSinVerificar) {
        advertencias.push(
          advertenciaAnticipoSinVerificar({
            tramiteId: f.tramiteId,
            consecutivo: c.consecutivo,
            anio: c.anio,
            numero: c.numero,
          }),
        );
      }
    }

    return {
      id: f.id,
      numFactura: f.numFactura,
      numFacturaVisible: numeroFacturaVisible(f.numFactura, f.beneficiario?.numFacturaConEspacio ?? false),
      valor: f.valor,
      aplicado,
      ajustes,
      compensado: f.montoCompensado,
      saldo,
      estado: estadoDe(partes),
      etiqueta: etiquetaDe({ ...partes, tieneAjusteLegado }),
      fecha: f.fecha,
      createdAt: f.createdAt,
      moneda: f.moneda,
      valorOrigenCentavos: f.valorOrigenCentavos,
      trmCentavos: f.trmCentavos,
      tramiteId: f.tramiteId,
      tramiteConsecutivo: c.consecutivo,
      doCorto: doCorto(c.anio, c.numero),
      tramiteEstado: c.estado,
      marca: c.marca,
      clienteId: c.clienteId,
      clienteNombre: c.clienteNombre,
      beneficiarioId: f.beneficiarioId,
      beneficiarioNombre: f.beneficiario ? (f.beneficiario.nombreCorto ?? f.beneficiario.nombre) : null,
      repercutible: f.repercutible,
      saldoTramite: c.saldoTramite,
      pagable,
      motivoNoPagable: motivo,
      advertencias,
      puedeAbsorberCosto: c.puedeAbsorberCosto,
      conciliacionPendiente: f.beneficiario?.conciliacionPendiente ?? false,
      tieneAnticipoAplicado: c.tieneAnticipoAplicado || !f.repercutible,
      facturadaAlCliente: cobrada ? { numSiigo: cobrada.numFacturaSiigo, estado: cobrada.estado } : null,
      pagos,
      ajustesDetalle: f.ajustes.map((a) => ({ ...a })),
      tieneAjusteLegado,
      fechaPago: saldo === 0n && ultimoPago ? (ultimoPago.fechaRealPago ?? null) : null,
      abonos: saldo > 0n ? pagosConMonto.map((p) => ({ fecha: p.fechaRealPago, monto: p.monto })) : [],
    };
  });
}

// ─── Serialización (contratos-api.ts) ────────────────────────────────────────

function fechaJson(d: Date | null): string | null {
  return d ? fechaCalendarioAInput(d) : null;
}

export function aFacturaElegibleJson(f: FilaFacturaCxp): FacturaElegibleJson {
  return {
    id: f.id,
    numFactura: f.numFactura,
    numFacturaVisible: f.numFacturaVisible,
    valor: f.valor.toString(),
    aplicado: f.aplicado.toString(),
    ajustes: f.ajustes.toString(),
    compensado: f.compensado.toString(),
    saldo: f.saldo.toString(),
    estado: f.estado === "PARCIAL" ? "PARCIAL" : "REGISTRADA",
    fecha: fechaCalendarioAInput(f.fecha),
    moneda: f.moneda,
    valorOrigen: f.valorOrigenCentavos?.toString() ?? null,
    trm: f.trmCentavos?.toString() ?? null,
    tramiteId: f.tramiteId,
    tramiteConsecutivo: f.tramiteConsecutivo,
    doCorto: f.doCorto,
    tramiteEstado: f.tramiteEstado,
    marca: f.marca,
    clienteId: f.clienteId,
    clienteNombre: f.clienteNombre,
    beneficiarioId: f.beneficiarioId,
    beneficiarioNombre: f.beneficiarioNombre,
    repercutible: f.repercutible,
    saldoTramite: f.saldoTramite.toString(),
    pagable: f.pagable,
    motivoNoPagable: f.motivoNoPagable,
    advertencias: f.advertencias.map((a) => ({ codigo: a.codigo, mensaje: a.mensaje })),
    puedeAbsorberCosto: f.puedeAbsorberCosto,
    conciliacionPendiente: f.conciliacionPendiente,
    tieneAnticipoAplicado: f.tieneAnticipoAplicado,
    facturadaAlCliente: f.facturadaAlCliente,
  };
}

export function aFilaEstadoCuentaJson(f: FilaFacturaCxp): FilaEstadoCuentaJson {
  // La fila elegible trae el TOTAL de ajustes: aquí va como `montoAjustes` y
  // `ajustes` pasa a ser el detalle (arreglo).
  const { ajustes: montoAjustes, ...elegible } = aFacturaElegibleJson(f);
  return {
    ...elegible,
    montoAjustes,
    estado: f.estado,
    etiqueta: f.etiqueta,
    pagos: f.pagos.map((p) => ({
      pagoId: p.pagoId,
      grupoPagoId: p.grupoPagoId,
      fechaRealPago: fechaJson(p.fechaRealPago),
      monto: p.monto.toString(),
      esHistorico: p.esHistorico,
      comprobante: p.comprobante,
    })),
    ajustes: f.ajustesDetalle.map((a) => ({
      id: a.id,
      tipo: a.tipo,
      monto: a.monto.toString(),
      motivo: a.motivo,
      createdAt: a.createdAt.toISOString(),
    })),
    fechaPago: fechaJson(f.fechaPago),
    abonos: f.abonos.map((a) => ({ fecha: fechaJson(a.fecha), monto: a.monto.toString() })),
  };
}

export function aResumenCxpJson(r: ResumenCxp): ResumenCxpJson {
  return {
    facturado: r.facturado.toString(),
    pagado: r.pagado.toString(),
    ajustado: r.ajustado.toString(),
    cruzado: r.cruzado.toString(),
    pendiente: r.pendiente.toString(),
    pagadoSinFactura: r.pagadoSinFactura.toString(),
    nPendientes: r.nPendientes,
    nAbonadas: r.nAbonadas,
    nPagadas: r.nPagadas,
  };
}

// ─── Fichas del proveedor ─────────────────────────────────────────────────────

export interface FichaDelProveedor {
  id: string;
  nombre: string;
  nit: string | null;
  nitBase: string | null;
  nombreCorto: string | null;
  conciliacionPendiente: boolean;
}

const fichaSelect = {
  id: true,
  nombre: true,
  nit: true,
  nitBase: true,
  nombreCorto: true,
  conciliacionPendiente: true,
} satisfies Prisma.BeneficiarioSelect;

/**
 * Fichas de la empresa (por `empresaId`) + las que comparten su NIT base y no
 * están enlazadas a otra empresa (sueltas, `empresaId` null). Una ficha de OTRA
 * empresa con la misma base no entra: si dos empresas comparten base, cada una
 * suma solo lo suyo. Es la lista de la cuenta corriente y del estado de cuenta
 * CxP v2, para que las dos pantallas cuenten las mismas fichas.
 */
export async function fichasDeEmpresa(db: Db, empresaId: string, nitEmpresa: string | null): Promise<FichaDelProveedor[]> {
  const propias = await db.beneficiario.findMany({ where: { empresaId }, select: fichaSelect });
  const bases = new Set(propias.flatMap((f) => (f.nitBase ? [f.nitBase] : [])));
  const baseEmpresa = nitBaseDe(nitEmpresa);
  if (baseEmpresa) bases.add(baseEmpresa);
  const hermanas =
    bases.size === 0
      ? []
      : await db.beneficiario.findMany({
          where: { nitBase: { in: [...bases] }, OR: [{ empresaId: null }, { empresaId }] },
          select: fichaSelect,
        });
  const porId = new Map<string, FichaDelProveedor>();
  for (const f of [...propias, ...hermanas]) porId.set(f.id, f);
  return [...porId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre) || a.id.localeCompare(b.id));
}

/** La ficha + las que comparten su NIT base (misma llave de proveedor). */
export async function fichasHermanas(db: Db, beneficiarioId: string): Promise<FichaDelProveedor[]> {
  const ficha = await db.beneficiario.findUnique({ where: { id: beneficiarioId }, select: fichaSelect });
  if (!ficha) return [];
  if (!ficha.nitBase) return [ficha];
  const hermanas = await db.beneficiario.findMany({ where: { nitBase: ficha.nitBase }, select: fichaSelect });
  return hermanas.sort((a, b) => (a.id === beneficiarioId ? -1 : b.id === beneficiarioId ? 1 : a.id.localeCompare(b.id)));
}

// ─── Pagos realizados (una fila por transferencia) ───────────────────────────

interface SnapshotAnulacion {
  pagos: {
    pagoId: string;
    tramiteId: string;
    consecutivo: string;
    valor: string;
    costoBancario: string;
    facturas: { facturaId: string; numFactura: string; numFacturaVisible?: string; monto: string }[];
  }[];
}

function esSnapshot(v: unknown): v is SnapshotAnulacion {
  return typeof v === "object" && v !== null && Array.isArray((v as { pagos?: unknown }).pagos);
}

const pagoRealizadoSelect = {
  id: true,
  tramiteId: true,
  concepto: true,
  valor: true,
  canalPago: true,
  costoBancario: true,
  fechaRealPago: true,
  createdAt: true,
  grupoPagoId: true,
  documento: { select: { id: true, tramiteId: true } },
  tramite: { select: { consecutivo: true } },
  beneficiarios: { select: { beneficiarioId: true } },
  facturasProveedor: {
    select: {
      facturaId: true,
      monto: true,
      factura: { select: { numFactura: true, beneficiario: { select: { numFacturaConEspacio: true } } } },
    },
  },
} satisfies Prisma.PagoTramiteSelect;

type PagoRealizadoFila = Prisma.PagoTramiteGetPayload<{ select: typeof pagoRealizadoSelect }>;

const grupoSelect = {
  id: true,
  concepto: true,
  canalPago: true,
  fechaRealPago: true,
  documento: { select: { id: true, tramiteId: true } },
  totalAplicado: true,
  costoBancario: true,
  costoAsumidoPor: true,
  estado: true,
  esHistorico: true,
  motivoAnulacion: true,
  anuladoEn: true,
  anuladoPor: { select: { name: true } },
  snapshotAnulacion: true,
  createdAt: true,
} satisfies Prisma.PagoGrupoSelect;

type GrupoFila = Prisma.PagoGrupoGetPayload<{ select: typeof grupoSelect }>;

function facturasDePago(p: PagoRealizadoFila) {
  return p.facturasProveedor.map((x) => ({
    facturaId: x.facturaId,
    numFactura: numeroFacturaVisible(x.factura.numFactura, x.factura.beneficiario?.numFacturaConEspacio ?? false),
    monto: x.monto,
  }));
}

/** Fila de "Pagos realizados" de un bloque (activo: con sus pagos; anulado: desde la foto). */
export function pagoRealizadoDeGrupo(g: GrupoFila, pagos: PagoRealizadoFila[]): PagoRealizadoJson {
  const anulado = g.estado === "ANULADO";
  const snapshot = anulado && esSnapshot(g.snapshotAnulacion) ? g.snapshotAnulacion : null;
  const dos = snapshot
    ? snapshot.pagos.map((p) => ({ tramiteId: p.tramiteId, consecutivo: p.consecutivo, valor: p.valor }))
    : pagos.map((p) => ({ tramiteId: p.tramiteId, consecutivo: p.tramite.consecutivo, valor: p.valor.toString() }));
  const facturas = snapshot
    ? snapshot.pagos.flatMap((p) =>
        p.facturas.map((f) => ({ facturaId: f.facturaId, numFactura: f.numFacturaVisible ?? f.numFactura, monto: f.monto })),
      )
    : pagos.flatMap((p) => facturasDePago(p).map((f) => ({ ...f, monto: f.monto.toString() })));
  const valor = snapshot ? g.totalAplicado : pagos.reduce((s, p) => s + p.valor, 0n);
  const aplicado = facturas.reduce((s, f) => s + BigInt(f.monto), 0n);
  return {
    tipo: "BLOQUE",
    id: g.id,
    fecha: fechaJson(g.fechaRealPago),
    concepto: g.concepto,
    valor: valor.toString(),
    aplicadoAFacturas: aplicado.toString(),
    sinFactura: (valor - aplicado > 0n ? valor - aplicado : 0n).toString(),
    canalPago: g.canalPago,
    costoBancario: g.costoBancario.toString(),
    costoAsumidoPor: g.costoAsumidoPor as CostoAsumidoPor,
    estado: g.estado,
    esHistorico: g.esHistorico,
    comprobante: g.documento ? { documentoId: g.documento.id, tramiteId: g.documento.tramiteId } : null,
    dos,
    facturas,
    anulacion:
      anulado && g.anuladoEn
        ? { motivo: g.motivoAnulacion ?? "", por: g.anuladoPor?.name ?? null, en: g.anuladoEn.toISOString() }
        : null,
  };
}

function pagoRealizadoSuelto(p: PagoRealizadoFila): PagoRealizadoJson {
  const facturas = facturasDePago(p);
  const aplicado = facturas.reduce((s, f) => s + f.monto, 0n);
  return {
    tipo: "SUELTO",
    id: p.id,
    fecha: fechaJson(p.fechaRealPago),
    concepto: p.concepto,
    valor: p.valor.toString(),
    aplicadoAFacturas: aplicado.toString(),
    sinFactura: (p.valor - aplicado > 0n ? p.valor - aplicado : 0n).toString(),
    canalPago: p.canalPago,
    costoBancario: p.costoBancario.toString(),
    costoAsumidoPor: null,
    estado: "ACTIVO",
    esHistorico: false,
    comprobante: p.documento ? { documentoId: p.documento.id, tramiteId: p.documento.tramiteId } : null,
    dos: [{ tramiteId: p.tramiteId, consecutivo: p.tramite.consecutivo, valor: p.valor.toString() }],
    facturas: facturas.map((f) => ({ ...f, monto: f.monto.toString() })),
    anulacion: null,
  };
}

/** Detalle de un bloque (GET /api/pagos/grupos/[id]). null si no existe. */
export async function getPagoRealizadoDeGrupo(db: Db, grupoId: string): Promise<PagoRealizadoJson | null> {
  const g = await db.pagoGrupo.findUnique({ where: { id: grupoId }, select: grupoSelect });
  if (!g) return null;
  const pagos = await db.pagoTramite.findMany({
    where: { grupoPagoId: grupoId },
    select: pagoRealizadoSelect,
    orderBy: [{ tramite: { consecutivo: "asc" } }],
  });
  return pagoRealizadoDeGrupo(g, pagos);
}

/**
 * Registro de pagos del proveedor: una fila por transferencia (bloque o pago
 * suelto), incluidos los bloques anulados. Un pago entra si alguno de sus
 * beneficiarios es una ficha del proveedor o si cubre una factura de ellas.
 * Devuelve también `pagadoSinFactura` (pagos activos cuyo ÚNICO beneficiario
 * es una ficha del proveedor y que no se aplicaron por completo a facturas).
 */
export async function pagosRealizadosDeFichas(
  db: Db,
  fichaIds: readonly string[],
): Promise<{ pagos: PagoRealizadoJson[]; pagadoSinFactura: bigint }> {
  if (fichaIds.length === 0) return { pagos: [], pagadoSinFactura: 0n };
  const ids = [...fichaIds];
  const [pagos, gruposAnulados] = await Promise.all([
    db.pagoTramite.findMany({
      where: {
        OR: [
          { beneficiarios: { some: { beneficiarioId: { in: ids } } } },
          { facturasProveedor: { some: { factura: { beneficiarioId: { in: ids } } } } },
        ],
      },
      select: pagoRealizadoSelect,
      orderBy: [{ tramite: { consecutivo: "asc" } }, { orden: "asc" }],
    }),
    db.pagoGrupo.findMany({ where: { beneficiarioId: { in: ids }, estado: "ANULADO" }, select: grupoSelect }),
  ]);

  const grupoIds = [...new Set(pagos.flatMap((p) => (p.grupoPagoId ? [p.grupoPagoId] : [])))];
  const [grupos, pagosDeGrupos] = await Promise.all([
    grupoIds.length ? db.pagoGrupo.findMany({ where: { id: { in: grupoIds } }, select: grupoSelect }) : [],
    grupoIds.length
      ? db.pagoTramite.findMany({
          where: { grupoPagoId: { in: grupoIds } },
          select: pagoRealizadoSelect,
          orderBy: [{ tramite: { consecutivo: "asc" } }],
        })
      : [],
  ]);

  const filas: { orden: number; creado: number; fila: PagoRealizadoJson }[] = [];
  const clave = (fecha: Date | null, creado: Date) => ({ orden: (fecha ?? creado).getTime(), creado: creado.getTime() });

  for (const g of [...grupos, ...gruposAnulados.filter((a) => !grupoIds.includes(a.id))]) {
    const suyos = pagosDeGrupos.filter((p) => p.grupoPagoId === g.id);
    filas.push({ ...clave(g.fechaRealPago, g.createdAt), fila: pagoRealizadoDeGrupo(g, suyos) });
  }
  for (const p of pagos) {
    if (p.grupoPagoId) continue;
    filas.push({ ...clave(p.fechaRealPago, p.createdAt), fila: pagoRealizadoSuelto(p) });
  }
  filas.sort((a, b) => b.orden - a.orden || b.creado - a.creado);

  const fichas = new Set(ids);
  let pagadoSinFactura = 0n;
  for (const p of pagos) {
    if (p.beneficiarios.length !== 1 || !fichas.has(p.beneficiarios[0].beneficiarioId)) continue;
    const aplicado = p.facturasProveedor.reduce((s, x) => s + x.monto, 0n);
    if (p.valor > aplicado) pagadoSinFactura += p.valor - aplicado;
  }

  return { pagos: filas.map((f) => f.fila), pagadoSinFactura };
}

// ─── Estado de cuenta de la empresa (ficha) ──────────────────────────────────

/**
 * `GET /api/clientes/[id]/cuenta-proveedor`. ADMIN/REVISOR: vista COMPLETA
 * (todas las facturas, registro de pagos, totales). OPERATIVO (D-6, como
 * hoy): SOLO_PENDIENTES (facturas con saldo), sin totales ni registro de pagos.
 */
export async function getEstadoCuentaProveedor(
  empresaId: string,
  rol: RolLectorCxp,
  db: Db = prisma,
): Promise<EstadoCuentaProveedorJson> {
  const empresa = await db.cliente.findUnique({
    where: { id: empresaId },
    select: { id: true, nombre: true, nit: true, esCliente: true, esProveedor: true },
  });
  if (!empresa) throw new EmpresaProveedorNoEncontradaError(empresaId);

  const fichas = await fichasDeEmpresa(db, empresaId, empresa.nit);
  const fichaIds = fichas.map((f) => f.id);
  const completa = rol === "ADMIN" || rol === "REVISOR";

  const filas =
    fichaIds.length === 0 ? [] : await cargarFilasFacturas(db, { beneficiarioId: { in: fichaIds } });
  const visibles = completa ? filas : filas.filter((f) => f.saldo > 0n);

  let resumen: ResumenCxpJson | null = null;
  let pagos: PagoRealizadoJson[] = [];
  if (completa) {
    const realizados = await pagosRealizadosDeFichas(db, fichaIds);
    pagos = realizados.pagos;
    resumen = aResumenCxpJson(resumenProveedor(filas, realizados.pagadoSinFactura));
  }

  const primeraFecha = filas.reduce<Date | null>((min, f) => (min === null || f.fecha < min ? f.fecha : min), null);

  return {
    empresa: {
      id: empresa.id,
      nombre: empresa.nombre,
      nombreCorto: fichas.find((f) => f.nombreCorto)?.nombreCorto ?? null,
      esCliente: empresa.esCliente,
      esProveedor: empresa.esProveedor,
    },
    fichas: fichas.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      nit: f.nit,
      nombreCorto: f.nombreCorto,
      conciliacionPendiente: f.conciliacionPendiente,
    })),
    vista: completa ? "COMPLETA" : "SOLO_PENDIENTES",
    resumen,
    facturas: visibles.map(aFilaEstadoCuentaJson),
    pagos,
    historialDesde: fechaJson(primeraFecha),
  };
}

// ─── Resumen para /pagos ──────────────────────────────────────────────────────

export interface ResumenPorProveedor {
  nombre: string;
  fichaIds: string[];
  resumen: ResumenCxp;
  /** Facturas con saldo y DOs distintos entre ellas ("3 facturas en 3 DOs"). */
  facturasConSaldo: number;
  dosConSaldo: number;
}

/**
 * Cifras de la franja de `/pagos` filtrado por proveedor ("Total de sus
 * facturas · Pagado · Pendiente por pagar"). Misma función de filas que la
 * ficha: las dos pantallas nunca se contradicen.
 */
export async function resumenPorProveedor(
  filtro: { empresaId?: string; beneficiarioId?: string },
  db: Db = prisma,
): Promise<ResumenPorProveedor | null> {
  let fichas: FichaDelProveedor[] = [];
  let nombre = "";
  if (filtro.empresaId) {
    const empresa = await db.cliente.findUnique({ where: { id: filtro.empresaId }, select: { nombre: true, nit: true } });
    if (!empresa) return null;
    fichas = await fichasDeEmpresa(db, filtro.empresaId, empresa.nit);
    nombre = fichas.find((f) => f.nombreCorto)?.nombreCorto ?? empresa.nombre;
  } else if (filtro.beneficiarioId) {
    fichas = await fichasHermanas(db, filtro.beneficiarioId);
    if (fichas.length === 0) return null;
    nombre = fichas[0].nombreCorto ?? fichas[0].nombre;
  } else {
    return null;
  }
  const fichaIds = fichas.map((f) => f.id);
  const filas = fichaIds.length ? await cargarFilasFacturas(db, { beneficiarioId: { in: fichaIds } }) : [];
  const { pagadoSinFactura } = await pagosRealizadosDeFichas(db, fichaIds);
  const conSaldo = filas.filter((f) => f.saldo > 0n);
  return {
    nombre,
    fichaIds,
    resumen: resumenProveedor(filas, pagadoSinFactura),
    facturasConSaldo: conSaldo.length,
    dosConSaldo: new Set(conSaldo.map((f) => f.tramiteId)).size,
  };
}
