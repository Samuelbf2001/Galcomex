/**
 * CxP v2 — Invariantes de cuentas por pagar a proveedores (diseño §C R20, P7b).
 * SOLO LECTURA: nunca escribe. Lo usan `scripts/cxp/verificar-invariantes.ts`
 * (antes y después de desplegar / conciliar) y las pruebas.
 *
 *   I1 por proveedor: Σ valor = pendiente mostrado + pagado + ajustado + cruzado
 *      (pendiente mostrado = saldo de las facturas en estado Pendiente/Abonada:
 *      si una factura "Pagada" todavía tiene saldo, esa deuda desaparece de la
 *      pantalla y el proveedor no cuadra).
 *   I2 por factura: aplicado + ajustes + cruzado ≤ valor, sin partes negativas.
 *   I3 por pago: Σ monto del puente ≤ valor del pago. (Aviso, no violación, si un
 *      pago creado con v2 tiene parte sin factura: lo permite el enlace de
 *      conciliación de un pago que ya existía.)
 *   I4 estado guardado = estadoDe(partes).
 *   I5 por bloque ACTIVO: Σ PagoTramite.costoBancario = 0 si GALCOMEX y
 *      = costoBancario de la cabecera si PRIMER_DO / PRORRATEADO.
 *   I6 por bloque ACTIVO: totalAplicado = Σ valor de sus pagos (y un bloque
 *      ANULADO no conserva pagos).
 *   I7 todo pago con puente tiene al menos una ficha y cada factura enlazada es
 *      del proveedor de alguna de sus fichas (misma clave NIT). Los pagos
 *      heredados de antes de la migración (reporte Q4) salen como aviso.
 *
 * La capa pura (`evaluarInvariantes`) recibe los datos ya cargados, para
 * probar cada invariante sin base de datos.
 */

import { type CostoBancarioAsumidoPor, type EstadoFacturaProveedor, type EstadoPagoGrupo, Prisma, type PrismaClient } from "@prisma/client";

import { claveProveedorDeFicha, estadoDe, formatoPesos } from "@/lib/cxp/saldos";
import { prisma as prismaGlobal } from "@/lib/db/prisma";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type CodigoInvariante = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";
export const INVARIANTES: readonly CodigoInvariante[] = ["I1", "I2", "I3", "I4", "I5", "I6", "I7"];

export interface Hallazgo {
  invariante: CodigoInvariante | "GUARDIAN";
  gravedad: "VIOLACION" | "AVISO";
  entidad: "Proveedor" | "FacturaProveedor" | "PagoTramite" | "PagoGrupo" | "BaseDeDatos";
  id: string;
  mensaje: string;
}

export interface FacturaInv {
  id: string;
  numFactura: string;
  consecutivo: string;
  /** Clave del proveedor: la de la ficha (`claveProveedorDeFicha`), si no la columna, si no "SIN_PROVEEDOR". */
  clave: string;
  nombreProveedor: string;
  valor: bigint;
  aplicado: bigint;
  ajustes: bigint;
  compensado: bigint;
  /** Algún monto del puente < 0 o algún ajuste ≤ 0 (los CHECK de BD lo impiden; se revisa igual). */
  parteNegativa: boolean;
  estado: EstadoFacturaProveedor;
}

export interface PagoInv {
  id: string;
  consecutivo: string;
  valor: bigint;
  costoBancario: bigint;
  grupoPagoId: string | null;
  createdAt: Date;
  /** Claves de proveedor de las fichas del pago. */
  clavesFichas: string[];
  puentes: { facturaId: string; monto: bigint }[];
}

export interface GrupoInv {
  id: string;
  estado: EstadoPagoGrupo;
  costoBancario: bigint;
  costoAsumidoPor: CostoBancarioAsumidoPor;
  totalAplicado: bigint;
}

export interface DatosInvariantes {
  facturas: FacturaInv[];
  pagos: PagoInv[];
  grupos: GrupoInv[];
  /** Fin de la migración de datos (M3): lo creado antes es "heredado". null = todo cuenta como v2. */
  corteV2: Date | null;
  /** Guardianes de saldo (M5): nombre → encendido. Vacío si no se pudo leer. */
  guardianes: { nombre: string; encendido: boolean }[];
}

export interface InformeInvariantes {
  revisadoEn: Date;
  totales: { facturas: number; pagos: number; grupos: number; proveedores: number };
  /** Violaciones por invariante (0 = cumple). */
  violacionesPor: Record<CodigoInvariante, number>;
  violaciones: Hallazgo[];
  avisos: Hallazgo[];
}

// ─── Capa pura ────────────────────────────────────────────────────────────────

const PAGADA_O_EQUIVALENTE: readonly EstadoFacturaProveedor[] = ["PAGADA", "FACTURADA_CLIENTE"];

function partesValidas(f: FacturaInv): boolean {
  if (f.parteNegativa || f.valor < 0n || f.aplicado < 0n || f.ajustes < 0n || f.compensado < 0n) return false;
  return f.aplicado + f.ajustes + f.compensado <= f.valor;
}

/** Evalúa I1–I7 sobre datos ya cargados. No lanza: todo lo que no cuadra sale en el informe. */
export function evaluarInvariantes(d: DatosInvariantes, revisadoEn: Date = new Date()): InformeInvariantes {
  const violaciones: Hallazgo[] = [];
  const avisos: Hallazgo[] = [];
  const v = (h: Omit<Hallazgo, "gravedad">) => violaciones.push({ ...h, gravedad: "VIOLACION" });
  const a = (h: Omit<Hallazgo, "gravedad">) => avisos.push({ ...h, gravedad: "AVISO" });
  const facturaPor = new Map(d.facturas.map((f) => [f.id, f]));

  // I2 e I4 (por factura).
  for (const f of d.facturas) {
    const etiqueta = `${f.numFactura} (${f.consecutivo})`;
    if (!partesValidas(f)) {
      v({
        invariante: "I2",
        entidad: "FacturaProveedor",
        id: f.id,
        mensaje: `${etiqueta}: aplicado ${formatoPesos(f.aplicado)} + ajustes ${formatoPesos(f.ajustes)} + cruzado ${formatoPesos(f.compensado)} supera el valor ${formatoPesos(f.valor)} o tiene partes negativas.`,
      });
      continue; // sin partes válidas el estado esperado no se puede calcular
    }
    const esperado = estadoDe(f);
    if (f.estado !== esperado) {
      v({
        invariante: "I4",
        entidad: "FacturaProveedor",
        id: f.id,
        mensaje: `${etiqueta}: estado guardado ${f.estado}, pero por su saldo (${formatoPesos(f.valor - f.aplicado - f.ajustes - f.compensado)}) debería ser ${esperado}.`,
      });
    }
  }

  // I1 (por proveedor).
  const porProveedor = new Map<string, FacturaInv[]>();
  for (const f of d.facturas) {
    const lista = porProveedor.get(f.clave) ?? [];
    lista.push(f);
    porProveedor.set(f.clave, lista);
  }
  for (const [clave, fs] of porProveedor) {
    let valor = 0n;
    let pendienteMostrado = 0n;
    let pagado = 0n;
    let ajustado = 0n;
    let cruzado = 0n;
    for (const f of fs) {
      valor += f.valor;
      pagado += f.aplicado;
      ajustado += f.ajustes;
      cruzado += f.compensado;
      if (!PAGADA_O_EQUIVALENTE.includes(f.estado)) pendienteMostrado += f.valor - f.aplicado - f.ajustes - f.compensado;
    }
    const cuadre = pendienteMostrado + pagado + ajustado + cruzado;
    if (valor !== cuadre) {
      v({
        invariante: "I1",
        entidad: "Proveedor",
        id: clave,
        mensaje: `${fs[0].nombreProveedor} (${clave}): facturas ${formatoPesos(valor)} ≠ pendiente ${formatoPesos(pendienteMostrado)} + pagado ${formatoPesos(pagado)} + ajustado ${formatoPesos(ajustado)} + cruzado ${formatoPesos(cruzado)} (diferencia ${formatoPesos(valor - cuadre)}).`,
      });
    }
  }

  // I3 e I7 (por pago).
  for (const p of d.pagos) {
    if (p.puentes.length === 0) continue;
    const suma = p.puentes.reduce((s, x) => s + x.monto, 0n);
    const heredado = d.corteV2 !== null && p.createdAt < d.corteV2;
    if (suma > p.valor) {
      v({
        invariante: "I3",
        entidad: "PagoTramite",
        id: p.id,
        mensaje: `Pago ${p.id} (${p.consecutivo}): aplicado a facturas ${formatoPesos(suma)} > valor del pago ${formatoPesos(p.valor)}.`,
      });
    } else if (suma < p.valor && !heredado) {
      a({
        invariante: "I3",
        entidad: "PagoTramite",
        id: p.id,
        mensaje: `Pago ${p.id} (${p.consecutivo}) de v2: ${formatoPesos(p.valor - suma)} no cubren ninguna factura (válido solo si vino de enlazar un pago que ya existía).`,
      });
    }

    const registrar = heredado ? a : v;
    if (p.clavesFichas.length === 0) {
      registrar({
        invariante: "I7",
        entidad: "PagoTramite",
        id: p.id,
        mensaje: `Pago ${p.id} (${p.consecutivo}) cubre facturas pero no tiene ficha de pago${heredado ? " (heredado, reporte Q4)" : ""}.`,
      });
      continue;
    }
    for (const x of p.puentes) {
      const f = facturaPor.get(x.facturaId);
      if (!f) continue;
      if (!p.clavesFichas.includes(f.clave)) {
        registrar({
          invariante: "I7",
          entidad: "PagoTramite",
          id: p.id,
          mensaje: `Pago ${p.id} (${p.consecutivo}) cubre ${f.numFactura} de ${f.nombreProveedor}, que no es el proveedor del pago${heredado ? " (heredado, reporte Q4)" : ""}.`,
        });
      }
    }
  }

  // I5 e I6 (por bloque).
  const pagosPorGrupo = new Map<string, PagoInv[]>();
  for (const p of d.pagos) {
    if (!p.grupoPagoId) continue;
    const lista = pagosPorGrupo.get(p.grupoPagoId) ?? [];
    lista.push(p);
    pagosPorGrupo.set(p.grupoPagoId, lista);
  }
  for (const g of d.grupos) {
    const pagos = pagosPorGrupo.get(g.id) ?? [];
    if (g.estado === "ANULADO") {
      if (pagos.length > 0) {
        v({
          invariante: "I6",
          entidad: "PagoGrupo",
          id: g.id,
          mensaje: `Bloque ${g.id} está ANULADO pero conserva ${pagos.length} pago(s).`,
        });
      }
      continue;
    }
    const costos = pagos.reduce((s, p) => s + p.costoBancario, 0n);
    const esperado = g.costoAsumidoPor === "GALCOMEX" ? 0n : g.costoBancario;
    if (costos !== esperado) {
      v({
        invariante: "I5",
        entidad: "PagoGrupo",
        id: g.id,
        mensaje: `Bloque ${g.id} (${g.costoAsumidoPor}): Σ costo en los pagos ${formatoPesos(costos)}, debería ser ${formatoPesos(esperado)} (costo del bloque ${formatoPesos(g.costoBancario)}).`,
      });
    }
    const total = pagos.reduce((s, p) => s + p.valor, 0n);
    if (total !== g.totalAplicado) {
      v({
        invariante: "I6",
        entidad: "PagoGrupo",
        id: g.id,
        mensaje: `Bloque ${g.id}: total guardado ${formatoPesos(g.totalAplicado)} ≠ Σ de sus ${pagos.length} pago(s) ${formatoPesos(total)}.`,
      });
    }
  }
  const idsGrupos = new Set(d.grupos.map((g) => g.id));
  for (const [grupoId, pagos] of pagosPorGrupo) {
    if (!idsGrupos.has(grupoId)) {
      v({
        invariante: "I6",
        entidad: "PagoGrupo",
        id: grupoId,
        mensaje: `${pagos.length} pago(s) apuntan al bloque ${grupoId}, que no tiene cabecera.`,
      });
    }
  }

  for (const g of d.guardianes) {
    if (!g.encendido) {
      a({
        invariante: "GUARDIAN",
        entidad: "BaseDeDatos",
        id: g.nombre,
        mensaje: `El guardián de saldo ${g.nombre} está apagado (falta la migración M5 \`cxp_v2_guardian\`): la base no frena un doble pago escrito por fuera del dominio.`,
      });
    }
  }

  const violacionesPor = Object.fromEntries(INVARIANTES.map((c) => [c, 0])) as Record<CodigoInvariante, number>;
  for (const h of violaciones) if (h.invariante !== "GUARDIAN") violacionesPor[h.invariante] += 1;

  return {
    revisadoEn,
    totales: { facturas: d.facturas.length, pagos: d.pagos.length, grupos: d.grupos.length, proveedores: porProveedor.size },
    violacionesPor,
    violaciones,
    avisos,
  };
}

/** Texto para la consola / el reporte del despliegue. */
export function informeInvariantesTexto(inf: InformeInvariantes, maxPorGrupo = 50): string {
  const l: string[] = [];
  l.push(`Invariantes CxP v2 — revisado ${inf.revisadoEn.toISOString()}`);
  l.push(
    `Facturas ${inf.totales.facturas} · proveedores ${inf.totales.proveedores} · pagos con facturas o de bloque ${inf.totales.pagos} · bloques ${inf.totales.grupos}`,
  );
  l.push(INVARIANTES.map((c) => `${c}: ${inf.violacionesPor[c]}`).join(" · "));
  l.push(`Violaciones: ${inf.violaciones.length} · avisos: ${inf.avisos.length}`);
  for (const [titulo, lista] of [
    ["VIOLACIONES", inf.violaciones],
    ["AVISOS", inf.avisos],
  ] as const) {
    if (lista.length === 0) continue;
    l.push("");
    l.push(`${titulo}:`);
    for (const h of lista.slice(0, maxPorGrupo)) l.push(`  [${h.invariante}] ${h.mensaje}`);
    if (lista.length > maxPorGrupo) l.push(`  … y ${lista.length - maxPorGrupo} más`);
  }
  return l.join("\n");
}

// ─── Capa de BD (solo lectura) ────────────────────────────────────────────────

type Db = PrismaClient | Prisma.TransactionClient;

const GUARDIANES = ["trg_pago_factura_saldo", "trg_ajuste_saldo", "trg_factura_valor_saldo"] as const;

/** Carga lo necesario para I1–I7 (lecturas agrupadas; nada se escribe). */
export async function cargarDatosInvariantes(db: Db = prismaGlobal): Promise<DatosInvariantes> {
  const [facturasBd, puentes, ajustes, pagosBd, gruposBd] = await Promise.all([
    db.facturaProveedor.findMany({
      select: {
        id: true,
        numFactura: true,
        valor: true,
        montoCompensado: true,
        estado: true,
        proveedorClave: true,
        proveedorNombre: true,
        beneficiario: { select: { id: true, nitBase: true, nombre: true, nombreCorto: true } },
        tramite: { select: { consecutivo: true } },
      },
    }),
    db.pagoTramiteFactura.groupBy({ by: ["facturaId"], _sum: { monto: true }, _min: { monto: true } }),
    db.ajusteFacturaProveedor.groupBy({ by: ["facturaId"], _sum: { monto: true }, _min: { monto: true } }),
    db.pagoTramite.findMany({
      where: { OR: [{ facturasProveedor: { some: {} } }, { grupoPagoId: { not: null } }] },
      select: {
        id: true,
        valor: true,
        costoBancario: true,
        grupoPagoId: true,
        createdAt: true,
        tramite: { select: { consecutivo: true } },
        beneficiarios: { select: { beneficiario: { select: { id: true, nitBase: true } } } },
        facturasProveedor: { select: { facturaId: true, monto: true } },
      },
    }),
    db.pagoGrupo.findMany({
      select: { id: true, estado: true, costoBancario: true, costoAsumidoPor: true, totalAplicado: true },
    }),
  ]);

  const puentePor = new Map(puentes.map((p) => [p.facturaId, p]));
  const ajustePor = new Map(ajustes.map((x) => [x.facturaId, x]));
  const facturas: FacturaInv[] = facturasBd.map((f) => {
    const p = puentePor.get(f.id);
    const aj = ajustePor.get(f.id);
    const clave = f.beneficiario ? claveProveedorDeFicha(f.beneficiario) : (f.proveedorClave ?? "SIN_PROVEEDOR");
    return {
      id: f.id,
      numFactura: f.numFactura,
      consecutivo: f.tramite.consecutivo,
      clave,
      nombreProveedor: f.beneficiario ? (f.beneficiario.nombreCorto ?? f.beneficiario.nombre) : f.proveedorNombre,
      valor: f.valor,
      aplicado: p?._sum.monto ?? 0n,
      ajustes: aj?._sum.monto ?? 0n,
      compensado: f.montoCompensado,
      parteNegativa: (p?._min.monto ?? 0n) < 0n || (aj ? (aj._min.monto ?? 1n) <= 0n : false),
      estado: f.estado,
    };
  });

  const pagos: PagoInv[] = pagosBd.map((p) => ({
    id: p.id,
    consecutivo: p.tramite.consecutivo,
    valor: p.valor,
    costoBancario: p.costoBancario,
    grupoPagoId: p.grupoPagoId,
    createdAt: p.createdAt,
    clavesFichas: [...new Set(p.beneficiarios.map((b) => claveProveedorDeFicha(b.beneficiario)))],
    puentes: p.facturasProveedor,
  }));

  let corteV2: Date | null = null;
  try {
    const filas = await db.$queryRaw<{ finished_at: Date | null }[]>(
      Prisma.sql`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = '20260925100200_cxp_v2_backfill' AND rolled_back_at IS NULL LIMIT 1`,
    );
    corteV2 = filas[0]?.finished_at ?? null;
  } catch {
    corteV2 = null;
  }

  let guardianes: { nombre: string; encendido: boolean }[] = [];
  try {
    const filas = await db.$queryRaw<{ tgname: string; tgenabled: string }[]>(
      Prisma.sql`SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger WHERE tgname = ANY(${[...GUARDIANES]}::text[])`,
    );
    guardianes = GUARDIANES.map((nombre) => {
      const t = filas.find((f) => f.tgname === nombre);
      return { nombre, encendido: t !== undefined && t.tgenabled !== "D" };
    });
  } catch {
    guardianes = [];
  }

  return { facturas, pagos, grupos: gruposBd, corteV2, guardianes };
}

/** Carga y evalúa I1–I7 sobre toda la base. Solo lectura. */
export async function verificarInvariantes(db: Db = prismaGlobal): Promise<InformeInvariantes> {
  return evaluarInvariantes(await cargarDatosInvariantes(db));
}
