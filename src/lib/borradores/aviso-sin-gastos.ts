/**
 * M2 (revisión INTEG-B, 29-sep-2026) — aviso «sin gastos de Galcomex».
 *
 * Desde Polyrec-1 (`solicitarFacturacion`, 29-sep) las empresas SIN
 * `anticipos_cliente` (Polyrec ZF, Sesderma, CW ASIA, Coldex…) se mandan a
 * facturar sin pagos: el cliente paga directo lo suyo. El riesgo: si Galcomex
 * SÍ pagó algo por el cliente (VUCE, puerto, transporte) y nadie lo registró, la
 * factura sale sin esos reembolsos y Galcomex pierde la plata.
 *
 * Esto es SOLO un aviso (no cambia montos ni bloquea nada): cuando el DO es de
 * una empresa sin `anticipos_cliente`, no tiene pagos y no tiene facturas de
 * proveedor que se cobren al cliente, la revisión del borrador y la respuesta
 * de «solicitar facturación» traen este texto para que quien revisa lo mire
 * ANTES de aprobar.
 *
 * No aplica al «Otros» de «Facturar comisiones» (B10): esa factura es una
 * comisión por contenedor, sin gastos por reembolsar por construcción.
 */

import { EstadoBorrador } from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";

export const AVISO_SIN_GASTOS_GALCOMEX =
  "Este trámite no tiene gastos pagados por Galcomex registrados. Si Galcomex pagó algo por el cliente (VUCE, puerto, transporte), regístralo antes de aprobar.";

export interface DatosAvisoSinGastos {
  /** La empresa del DO tiene la función `anticipos_cliente` (fondea sus DOs con anticipo). */
  empresaConAnticipos: boolean;
  /** Pagos a proveedores registrados en el DO. */
  pagos: number;
  /** Facturas de proveedor del DO que se le cobran al cliente (`repercutible`). */
  facturasCobrables: number;
  /** El DO es el «Otros» de una liquidación de comisiones (B10). */
  esLiquidacionDeComisiones: boolean;
}

/** Puro: ¿hay que avisar que el DO no tiene gastos pagados por Galcomex? */
export function debeAvisarSinGastos(datos: DatosAvisoSinGastos): boolean {
  return (
    !datos.empresaConAnticipos &&
    !datos.esLiquidacionDeComisiones &&
    datos.pagos === 0 &&
    datos.facturasCobrables === 0
  );
}

/** El aviso solo se muestra mientras la factura sigue por revisar (antes de aprobar). */
export function borradorEnRevision(estado: EstadoBorrador): boolean {
  return estado === EstadoBorrador.BORRADOR || estado === EstadoBorrador.EN_REVISION;
}

/**
 * El aviso de cada DO de la lista (`tramiteId` → texto) para los que aplica; los
 * demás no aparecen. Pocas consultas para todo el lote: capacidades por empresa
 * (pocas) y conteos agrupados de pagos y de facturas de proveedor.
 */
export async function avisosSinGastosDeTramites(tramiteIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(tramiteIds)];
  const avisos = new Map<string, string>();
  if (ids.length === 0) return avisos;

  const [tramites, pagos, facturas] = await Promise.all([
    prisma.tramiteDO.findMany({
      where: { id: { in: ids } },
      select: { id: true, clienteId: true, _count: { select: { comisionesLiquidadas: true } } },
    }),
    prisma.pagoTramite.groupBy({ by: ["tramiteId"], where: { tramiteId: { in: ids } }, _count: { _all: true } }),
    prisma.facturaProveedor.groupBy({
      by: ["tramiteId"],
      where: { tramiteId: { in: ids }, repercutible: true },
      _count: { _all: true },
    }),
  ]);

  const empresas = [...new Set(tramites.map((t) => t.clienteId))];
  const conAnticipos = new Map(
    await Promise.all(
      empresas.map(
        async (empresaId) => [empresaId, tiene(await capacidadesDeEmpresa(empresaId), "anticipos_cliente")] as const,
      ),
    ),
  );
  const pagosPor = new Map(pagos.map((p) => [p.tramiteId, p._count._all]));
  const facturasPor = new Map(facturas.map((f) => [f.tramiteId, f._count._all]));

  for (const tramite of tramites) {
    const avisar = debeAvisarSinGastos({
      empresaConAnticipos: conAnticipos.get(tramite.clienteId) ?? false,
      pagos: pagosPor.get(tramite.id) ?? 0,
      facturasCobrables: facturasPor.get(tramite.id) ?? 0,
      esLiquidacionDeComisiones: tramite._count.comisionesLiquidadas > 0,
    });
    if (avisar) avisos.set(tramite.id, AVISO_SIN_GASTOS_GALCOMEX);
  }
  return avisos;
}

/**
 * El aviso de un DO, o `null` si no aplica — y también `null` si no se pudo
 * calcular: es un apoyo para el revisor, nunca tumba la consulta ni el envío
 * a facturar (misma idea que `evaluarOcSinRomper`).
 */
export async function avisoSinGastosSinRomper(tramiteId: string): Promise<string | null> {
  try {
    return (await avisosSinGastosDeTramites([tramiteId])).get(tramiteId) ?? null;
  } catch (error) {
    console.error(`[borradores/aviso-sin-gastos] no se pudo calcular el aviso del trámite ${tramiteId}`, error);
    return null;
  }
}
