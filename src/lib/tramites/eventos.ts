/**
 * Emisión de eventos de trámite hacia n8n.
 *
 * Igual que en facturación: se emite desde la ruta, después de que la
 * operación quedó confirmada en base de datos, y nunca dentro de una
 * transacción. Crear un DO o enviarlo a facturar tiene que funcionar aunque
 * n8n esté caído, así que nada de esto lanza: los fallos se registran y se
 * descartan.
 */

import { prisma } from "@/lib/db/prisma";
import { dispatchWebhookEvent } from "@/lib/webhooks";

/** Emite `do.creado` para un trámite recién creado. No lanza nunca. */
export async function emitirDoCreado(tramiteId: string): Promise<void> {
  try {
    const tramite = await prisma.tramiteDO.findUnique({
      where: { id: tramiteId },
      select: {
        id: true,
        consecutivo: true,
        ciudad: true,
        agenciaAduanas: true,
        creadoPorId: true,
        createdAt: true,
        cliente: { select: { id: true, nombre: true } },
      },
    });

    if (!tramite) return;

    await dispatchWebhookEvent("do.creado", {
      tramiteId: tramite.id,
      consecutivo: tramite.consecutivo,
      clienteId: tramite.cliente.id,
      clienteNombre: tramite.cliente.nombre,
      ciudad: tramite.ciudad,
      agenciaAduanas: tramite.agenciaAduanas,
      creadoPorId: tramite.creadoPorId,
      createdAt: tramite.createdAt.toISOString(),
    });
  } catch (error) {
    console.error(`[webhooks] No se pudo emitir do.creado para ${tramiteId}`, error);
  }
}

/** Emite `do.enviado_a_facturar`. No lanza nunca. */
export async function emitirDoEnviadoAFacturar(tramiteId: string): Promise<void> {
  try {
    const tramite = await prisma.tramiteDO.findUnique({
      where: { id: tramiteId },
      select: {
        id: true,
        consecutivo: true,
        fechaEnviadoAFacturar: true,
        cliente: { select: { id: true, nombre: true } },
      },
    });

    if (!tramite) return;

    await dispatchWebhookEvent("do.enviado_a_facturar", {
      tramiteId: tramite.id,
      consecutivo: tramite.consecutivo,
      clienteId: tramite.cliente.id,
      clienteNombre: tramite.cliente.nombre,
      fechaEnviadoAFacturar: (
        tramite.fechaEnviadoAFacturar ?? new Date()
      ).toISOString(),
    });
  } catch (error) {
    console.error(
      `[webhooks] No se pudo emitir do.enviado_a_facturar para ${tramiteId}`,
      error,
    );
  }
}
