/**
 * Emisión de eventos de facturación hacia n8n.
 *
 * Los eventos se emiten desde la ruta, DESPUÉS de que la transacción de
 * `transicionarBorrador` confirmó — nunca dentro de ella. Dos razones:
 * una llamada HTTP dentro de una transacción de Postgres la mantiene abierta
 * durante toda la latencia de red, y si la transacción terminara en rollback
 * ya habríamos anunciado un hecho que no ocurrió.
 *
 * Nada de esto puede tumbar la operación de negocio: aprobar una factura tiene
 * que funcionar aunque n8n esté caído. `dispatchWebhookEvent` ya es
 * fire-and-forget y hace no-op silencioso si no hay URL configurada; aquí solo
 * se añade la consulta de los datos del payload, que también se protege.
 *
 * Origen del requisito — reunión 1-jul-2026:
 *  - min 00:59: alertar a Camila cuando una factura quede aprobada con
 *    observaciones ("me pone facturas revisadas, hay observaciones").
 *  - min 01:01: que ella no tenga que preguntar por WhatsApp si ya se revisó.
 */

import { EstadoBorrador } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { dispatchWebhookEvent } from "@/lib/webhooks";

/**
 * Emite `factura.aprobada` o `factura.facturada` según el estado alcanzado.
 * Para cualquier otro estado no hace nada.
 *
 * No lanza nunca: cualquier fallo se registra y se descarta.
 */
export async function emitirEventoTransicionBorrador(
  borradorId: string,
  nuevoEstado: EstadoBorrador,
  usuarioId: string,
): Promise<void> {
  if (
    nuevoEstado !== EstadoBorrador.APROBADO &&
    nuevoEstado !== EstadoBorrador.FACTURADO
  ) {
    return;
  }

  try {
    const borrador = await prisma.borradorFactura.findUnique({
      where: { id: borradorId },
      select: {
        id: true,
        totalFactura: true,
        saldoAFavorCliente: true,
        saldoACargoCliente: true,
        numFacturaSiigo: true,
        fechaFactura: true,
        tramite: {
          select: {
            id: true,
            consecutivo: true,
            cliente: { select: { id: true, nombre: true } },
          },
        },
        // Las observaciones del revisor viven por línea; basta con saber si
        // alguna quedó con texto para que n8n decida si notifica.
        lineasRevision: { select: { observacion: true } },
        factura: { select: { id: true } },
      },
    });

    if (!borrador) return;

    const { tramite } = borrador;

    if (nuevoEstado === EstadoBorrador.APROBADO) {
      const observaciones = borrador.lineasRevision
        .map((linea) => linea.observacion)
        .filter((texto): texto is string => Boolean(texto && texto.trim()));

      await dispatchWebhookEvent("factura.aprobada", {
        borradorId: borrador.id,
        tramiteId: tramite.id,
        consecutivo: tramite.consecutivo,
        clienteId: tramite.cliente.id,
        clienteNombre: tramite.cliente.nombre,
        totalFactura: borrador.totalFactura.toString(),
        saldoAFavorCliente: borrador.saldoAFavorCliente.toString(),
        saldoACargoCliente: borrador.saldoACargoCliente.toString(),
        tieneObservaciones: observaciones.length > 0,
        observaciones: observaciones.length > 0 ? observaciones.join(" · ") : null,
        aprobadoPorId: usuarioId,
      });
      return;
    }

    // FACTURADO
    await dispatchWebhookEvent("factura.facturada", {
      facturaId: borrador.factura?.id ?? borrador.id,
      borradorId: borrador.id,
      tramiteId: tramite.id,
      consecutivo: tramite.consecutivo,
      clienteId: tramite.cliente.id,
      clienteNombre: tramite.cliente.nombre,
      numSiigo: borrador.numFacturaSiigo ?? "",
      totalFactura: borrador.totalFactura.toString(),
      fecha: (borrador.fechaFactura ?? new Date()).toISOString(),
    });
  } catch (error) {
    console.error(
      `[webhooks] No se pudo emitir el evento de ${nuevoEstado} para el borrador ${borradorId}`,
      error,
    );
  }
}
