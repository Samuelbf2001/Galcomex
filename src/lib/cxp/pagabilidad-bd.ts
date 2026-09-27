/**
 * Pagabilidad de CxP v2 — capa de BD (diseño §B.6, P1).
 *
 * Carga en lote lo que `evaluarPagabilidad` (puro, `pagabilidad.ts`) y la regla
 * del costo bancario (D-1, `puedeAbsorberCosto`) necesitan de cada DO:
 * estado, cliente, capacidades, anticipos aplicados, pagos y borrador.
 *
 * Consumidor ÚNICO de la regla "sin anticipo no hay pago":
 *   exigeAnticipo = anticipos_cliente && pago_exige_anticipo (del cliente del DO)
 * La usan la lista de "Pagar en bloque", la ficha del proveedor y
 * `aplicarSaldo` al registrar, así que lo que la pantalla ofrece y lo que el
 * servidor acepta nunca se contradicen (RF-06).
 */

import { type EstadoBorrador, type EstadoTramite, Prisma } from "@prisma/client";

import { cargarPagosParaCobro } from "@/lib/borradores/pagos-para-cobro";
import { tiene, type MapaCapacidades } from "@/lib/capacidades/resolver";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { prisma } from "@/lib/db/prisma";
import { puedeAbsorberCosto } from "@/lib/cxp/saldos";

type Db = typeof prisma | Prisma.TransactionClient;

/** Lo que CxP necesita saber de un DO para decidir si se le puede pagar y quién asume el costo bancario. */
export interface ContextoDo {
  tramiteId: string;
  /** "DO.BAQ26-0238". */
  consecutivo: string;
  estado: EstadoTramite;
  anio: number;
  numero: number;
  clienteId: string;
  clienteNombre: string;
  /** `doCliente` + `proveedorCliente` ("IM054-26 SRF"): columna PROVEEDOR del Excel de Camila. */
  marca: string | null;
  /** anticipos_cliente && pago_exige_anticipo del cliente del DO. */
  exigeAnticipo: boolean;
  tieneAnticipoAplicado: boolean;
  /** Algún anticipo aplicado al DO aún no está verificado por el banco (solo aviso). */
  anticipoSinVerificar: boolean;
  totalAnticipoAplicado: bigint;
  /**
   * Σ de lo que los pagos del DO le cobran al cliente (`pagos-cobrables`): lo
   * pagado por facturas NO SE COBRA (asesoría) lo asume Galcomex y no cuenta.
   * Sin asesoría enlazada = Σ valor de los pagos, como siempre.
   */
  totalPagos: bigint;
  /**
   * Saldo del CLIENTE: anticipos aplicados − Σ parte cobrable de los pagos (el
   * costo bancario no se resta). Es la misma cifra del libro de pagos y de la
   * hoja del trámite (`getLibroPagos`), así el aviso «anticipo insuficiente»,
   * el estado de cuenta y la conciliación dicen lo mismo que el libro.
   */
  saldoTramite: bigint;
  /** El cliente usa el formato `factura_conceptos_iva` (nunca factura costos bancarios). */
  clienteUsaConceptosIva: boolean;
  /**
   * Estado del borrador que decide D-1: FACTURADO si alguno lo está, si no
   * APROBADO si alguno lo está, si no el del borrador más reciente; null si no hay.
   */
  estadoBorrador: EstadoBorrador | null;
  /** D-1: el DO todavía puede absorber (cobrarle al cliente) el costo de la transferencia. */
  puedeAbsorberCosto: boolean;
}

function estadoBorradorDecisivo(estados: { estado: EstadoBorrador; createdAt: Date }[]): EstadoBorrador | null {
  if (estados.length === 0) return null;
  if (estados.some((b) => b.estado === "FACTURADO")) return "FACTURADO";
  if (estados.some((b) => b.estado === "APROBADO")) return "APROBADO";
  const masReciente = [...estados].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return masReciente.estado;
}

function marcaDe(doCliente: string | null, proveedorCliente: string | null): string | null {
  const partes = [doCliente, proveedorCliente].map((p) => p?.trim() ?? "").filter((p) => p !== "");
  return partes.length > 0 ? partes.join(" ") : null;
}

/** anticipos_cliente && pago_exige_anticipo, a partir del mapa ya resuelto. */
export function exigeAnticipoSegun(capacidades: MapaCapacidades): boolean {
  return tiene(capacidades, "anticipos_cliente") && tiene(capacidades, "pago_exige_anticipo");
}

/**
 * ¿El DO exige anticipo antes de pagar a terceros? (consumidor único de la
 * capacidad). Un DO inexistente responde `true` (lo más seguro para el dinero).
 */
export async function exigeAnticipoDelDo(db: Db, tramiteId: string): Promise<boolean> {
  const tramite = await db.tramiteDO.findUnique({ where: { id: tramiteId }, select: { clienteId: true } });
  if (!tramite) return true;
  return exigeAnticipoSegun(await capacidadesDeEmpresa(tramite.clienteId));
}

/**
 * Carga en lote el contexto de varios DOs (una consulta por tabla, capacidades
 * por cliente sin repetir). Los ids que no existen no vuelven en el mapa.
 */
export async function cargarContextoDos(db: Db, tramiteIds: readonly string[]): Promise<Map<string, ContextoDo>> {
  const ids = [...new Set(tramiteIds)];
  const resultado = new Map<string, ContextoDo>();
  if (ids.length === 0) return resultado;

  const [tramites, aplicaciones, pagos, borradores] = await Promise.all([
    db.tramiteDO.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        consecutivo: true,
        estado: true,
        anio: true,
        numero: true,
        clienteId: true,
        doCliente: true,
        proveedorCliente: true,
        cliente: { select: { nombre: true } },
      },
    }),
    db.aplicacionAnticipo.findMany({
      where: { tramiteId: { in: ids } },
      select: { tramiteId: true, montoAplicado: true, anticipo: { select: { verificadoBanco: true } } },
    }),
    db.pagoTramite.groupBy({
      by: ["tramiteId"],
      where: { tramiteId: { in: ids } },
      _sum: { valor: true },
    }),
    db.borradorFactura.findMany({
      where: { tramiteId: { in: ids } },
      select: { tramiteId: true, estado: true, createdAt: true },
    }),
  ]);

  const capacidadesPorCliente = new Map<string, MapaCapacidades>();
  for (const clienteId of new Set(tramites.map((t) => t.clienteId))) {
    capacidadesPorCliente.set(clienteId, await capacidadesDeEmpresa(clienteId));
  }

  // DOs con pagos enlazados a facturas NO SE COBRA: su total de pagos es la
  // parte cobrable, con la MISMA fuente que el libro y el borrador
  // (`cargarPagosParaCobro`). Los demás (casi todos) siguen con Σ valor.
  const conAsesoria = await db.pagoTramiteFactura.findMany({
    where: { pago: { tramiteId: { in: ids } }, factura: { repercutible: false } },
    select: { pago: { select: { tramiteId: true } } },
  });
  const cobrablePorDo = new Map<string, bigint>();
  for (const tramiteId of new Set(conAsesoria.map((e) => e.pago.tramiteId))) {
    const cargados = await cargarPagosParaCobro(db, tramiteId);
    cobrablePorDo.set(
      tramiteId,
      cargados.reduce((s, p) => s + p.desglose.cobrable.valor, 0n),
    );
  }

  for (const t of tramites) {
    const caps = capacidadesPorCliente.get(t.clienteId)!;
    const apls = aplicaciones.filter((a) => a.tramiteId === t.id);
    const totalAnticipoAplicado = apls.reduce((s, a) => s + a.montoAplicado, 0n);
    const totalPagos = cobrablePorDo.get(t.id) ?? pagos.find((p) => p.tramiteId === t.id)?._sum.valor ?? 0n;
    const estadoBorrador = estadoBorradorDecisivo(borradores.filter((b) => b.tramiteId === t.id));
    const clienteUsaConceptosIva = tiene(caps, "factura_conceptos_iva");
    resultado.set(t.id, {
      tramiteId: t.id,
      consecutivo: t.consecutivo,
      estado: t.estado,
      anio: t.anio,
      numero: t.numero,
      clienteId: t.clienteId,
      clienteNombre: t.cliente.nombre,
      marca: marcaDe(t.doCliente, t.proveedorCliente),
      exigeAnticipo: exigeAnticipoSegun(caps),
      tieneAnticipoAplicado: apls.length > 0,
      anticipoSinVerificar: apls.some((a) => !a.anticipo.verificadoBanco),
      totalAnticipoAplicado,
      totalPagos,
      saldoTramite: totalAnticipoAplicado - totalPagos,
      clienteUsaConceptosIva,
      estadoBorrador,
      puedeAbsorberCosto: puedeAbsorberCosto({ clienteUsaConceptosIva, estadoBorrador }),
    });
  }
  return resultado;
}
