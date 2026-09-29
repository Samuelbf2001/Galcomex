/**
 * Resolver un envío a Siigo que quedó INCIERTO (solo ADMIN).
 *
 * INCIERTO = no sabemos si Siigo creó la factura (timeout, red, 5xx, respuesta
 * inválida, BD caída tras un 2xx, o un ENVIANDO colgado más de 10 minutos).
 * Mientras siga así, "Enviar a SIIGO" está bloqueado.
 *
 * - `revisarEnvioEnSiigo` («Revisar en SIIGO»):
 *   · con `siigoDraftId` → GET /v1/invoices/{id}. Existe → ENVIADO. 404 → se
 *     informa; NO se libera (una factura que tuvo id de Siigo no se recrea
 *     desde Galcomex).
 *   · sin `siigoDraftId` → el cliente Siigo de este código no expone una
 *     búsqueda de facturas por cliente/fecha/observaciones (solo GET por id),
 *     así que no se puede buscar automáticamente: se le dice al ADMIN qué
 *     buscar en el portal y se habilita «Liberar para reenviar».
 * - `liberarEnvioSiigo` («Liberar para reenviar»): INCIERTO sin id → ERROR
 *   (vuelve a permitir el envío), tras confirmación explícita en la UI.
 *
 * Todo deja AuditLog (SIIGO_ENVIO_REVISADO / SIIGO_ENVIO_LIBERADO).
 */

import { EstadoBorrador, Prisma, SiigoEnvioEstado } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

import { getInvoiceById, getToken, SiigoApiError, SiigoConfigError } from "./client";
import {
  BorradorSiigoNoEncontradoError,
  ConsultaSiigoError,
  EnvioSiigoNoResolubleError,
} from "./errores-envio";
import {
  estadoEnvioEfectivo,
  limiteEnviandoColgado,
  MINUTOS_ENVIANDO_COLGADO,
  type SiigoEnvioEstadoValor,
} from "./estado-envio";

export type RevisionEnvioSiigo = {
  /** Estado del envío después de revisar. */
  siigoEnvioEstado: SiigoEnvioEstadoValor | null;
  /** true si Siigo confirmó que la factura existe. */
  encontrada: boolean;
  siigoDraftId: string | null;
  /** Consecutivo que Siigo muestra para la factura encontrada. */
  consecutivo: string | null;
  /** false si no había id y Galcomex no pudo buscar por su cuenta. */
  busquedaAutomatica: boolean;
  /** true si el ADMIN puede «Liberar para reenviar» (tras mirar el portal). */
  puedeLiberar: boolean;
  mensaje: string;
};

const selectBorrador = {
  id: true,
  estado: true,
  tramiteId: true,
  siigoDraftId: true,
  siigoEnvioEstado: true,
  siigoEnvioIniciadoAt: true,
  siigoEnvioIntentoId: true,
  tramite: { select: { consecutivo: true, cliente: { select: { nit: true } } } },
} satisfies Prisma.BorradorFacturaSelect;

type BorradorParaResolver = Prisma.BorradorFacturaGetPayload<{ select: typeof selectBorrador }>;

async function cargar(borradorId: string): Promise<BorradorParaResolver> {
  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    select: selectBorrador,
  });
  if (!borrador) throw new BorradorSiigoNoEncontradoError();
  return borrador;
}

function exigirIncierto(borrador: BorradorParaResolver, ahora: Date): void {
  const efectivo = estadoEnvioEfectivo(borrador, ahora);
  if (efectivo === "INCIERTO") return;
  if (efectivo === "ENVIANDO") {
    throw new EnvioSiigoNoResolubleError(
      `Hay un envío a SIIGO en curso. Si en ${MINUTOS_ENVIANDO_COLGADO} minutos sigue igual, podrás revisarlo.`,
    );
  }
  if (efectivo === "ENVIADO") {
    throw new EnvioSiigoNoResolubleError("Esta factura ya está confirmada en SIIGO: no hay nada que resolver.");
  }
  if (efectivo === "ERROR") {
    throw new EnvioSiigoNoResolubleError(
      "SIIGO rechazó el último envío sin crear la factura: se puede volver a enviar sin revisar.",
    );
  }
  throw new EnvioSiigoNoResolubleError("Esta factura no se ha enviado a SIIGO.");
}

/** Condición de "nadie tocó el envío desde que lo leí" para los UPDATE. */
function mismoIntento(borrador: BorradorParaResolver, ahora: Date): Prisma.BorradorFacturaWhereInput {
  return {
    id: borrador.id,
    siigoDraftId: borrador.siigoDraftId,
    siigoEnvioIntentoId: borrador.siigoEnvioIntentoId,
    ...(borrador.siigoEnvioEstado === SiigoEnvioEstado.ENVIANDO
      ? {
          siigoEnvioEstado: SiigoEnvioEstado.ENVIANDO,
          // Sigue colgado (no es un envío nuevo en curso).
          OR: [
            { siigoEnvioIniciadoAt: null },
            { siigoEnvioIniciadoAt: { lt: limiteEnviandoColgado(ahora) } },
          ],
        }
      : { siigoEnvioEstado: borrador.siigoEnvioEstado }),
  };
}

function fechaColombia(fecha: Date | null): string {
  if (!fecha) return "la fecha del envío";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(fecha);
}

async function auditar(
  borrador: BorradorParaResolver,
  usuarioId: string,
  accion: "SIIGO_ENVIO_REVISADO" | "SIIGO_ENVIO_LIBERADO",
  antes: Prisma.InputJsonValue,
  despues: Prisma.InputJsonValue,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  await db.auditLog.create({
    data: {
      entidad: "BorradorFactura",
      entidadId: borrador.id,
      accion,
      usuarioId,
      tramiteId: borrador.tramiteId,
      antes,
      despues,
    },
  });
}

// ─── Revisar en SIIGO ─────────────────────────────────────────────────────────

export async function revisarEnvioEnSiigo(
  borradorId: string,
  usuarioId: string,
): Promise<RevisionEnvioSiigo> {
  const ahora = new Date();
  const borrador = await cargar(borradorId);
  exigirIncierto(borrador, ahora);

  const antes = {
    siigoEnvioEstado: borrador.siigoEnvioEstado,
    siigoDraftId: borrador.siigoDraftId,
    siigoEnvioIntentoId: borrador.siigoEnvioIntentoId,
  };

  // ── Sin id: no hay cómo buscarla desde aquí ────────────────────────────────
  if (!borrador.siigoDraftId) {
    const nit = borrador.tramite.cliente?.nit?.trim() || "(sin NIT)";
    const mensaje = `Galcomex no puede buscar esta factura automáticamente en SIIGO. Búscala en el portal: cliente NIT ${nit}, creada el ${fechaColombia(borrador.siigoEnvioIniciadoAt)}, con «${borrador.tramite.consecutivo}» en las observaciones. Si está, NO la reenvíes (cuando la estampen, usa «Marcar facturado»). Si no está, usa «Liberar para reenviar».`;
    await auditar(borrador, usuarioId, "SIIGO_ENVIO_REVISADO", antes, {
      resultado: "SIN_BUSQUEDA_AUTOMATICA",
    });
    return {
      siigoEnvioEstado: "INCIERTO",
      encontrada: false,
      siigoDraftId: null,
      consecutivo: null,
      busquedaAutomatica: false,
      puedeLiberar: true,
      mensaje,
    };
  }

  // ── Con id: preguntarle a Siigo ────────────────────────────────────────────
  const siigoDraftId = borrador.siigoDraftId;
  let factura;
  try {
    const token = await getToken();
    factura = await getInvoiceById(token, siigoDraftId);
  } catch (err) {
    if (err instanceof SiigoApiError && err.status === 404) {
      const mensaje = `SIIGO no encuentra el documento ${siigoDraftId}. Galcomex no vuelve a crear una factura que ya tuvo id de SIIGO: revísalo en el portal. Si hay que facturar, créala allá y usa «Marcar facturado».`;
      await auditar(borrador, usuarioId, "SIIGO_ENVIO_REVISADO", antes, {
        resultado: "NO_ENCONTRADA",
        siigoDraftId,
      });
      return {
        siigoEnvioEstado: "INCIERTO",
        encontrada: false,
        siigoDraftId,
        consecutivo: null,
        busquedaAutomatica: true,
        puedeLiberar: false,
        mensaje,
      };
    }
    if (err instanceof SiigoConfigError) throw new ConsultaSiigoError(err.message, 503);
    const detalle = err instanceof Error ? err.message : "Error desconocido";
    throw new ConsultaSiigoError(`No se pudo consultar SIIGO: ${detalle}`, 502);
  }

  const confirmado = await prisma.$transaction(async (tx) => {
    const r = await tx.borradorFactura.updateMany({
      where: mismoIntento(borrador, ahora),
      data: {
        siigoEnvioEstado: SiigoEnvioEstado.ENVIADO,
        ultimoErrorSiigo: null,
        enviadoASiigoEn: borrador.siigoEnvioIniciadoAt ?? ahora,
      },
    });
    if (r.count === 0) return false;
    await auditar(
      borrador,
      usuarioId,
      "SIIGO_ENVIO_REVISADO",
      antes,
      {
        resultado: "ENCONTRADA",
        siigoEnvioEstado: SiigoEnvioEstado.ENVIADO,
        siigoDraftId,
        consecutivo: factura.consecutivo || null,
      },
      tx,
    );
    return true;
  });
  if (!confirmado) {
    throw new EnvioSiigoNoResolubleError("El envío cambió mientras se revisaba. Recarga la página.");
  }

  return {
    siigoEnvioEstado: "ENVIADO",
    encontrada: true,
    siigoDraftId,
    consecutivo: factura.consecutivo || null,
    busquedaAutomatica: true,
    puedeLiberar: false,
    mensaje: `SIIGO confirma la factura${factura.consecutivo ? ` ${factura.consecutivo}` : ""}. Quedó vinculada: no se reenvía.`,
  };
}

// ─── Liberar para reenviar ────────────────────────────────────────────────────

export async function liberarEnvioSiigo(
  borradorId: string,
  usuarioId: string,
): Promise<{ siigoEnvioEstado: "ERROR" }> {
  const ahora = new Date();
  const borrador = await cargar(borradorId);

  if (borrador.estado === EstadoBorrador.FACTURADO) {
    throw new EnvioSiigoNoResolubleError("La factura ya está FACTURADA: no se puede liberar el envío.");
  }
  if (borrador.siigoDraftId) {
    throw new EnvioSiigoNoResolubleError(
      `Este envío tiene id de SIIGO (${borrador.siigoDraftId}): usa «Revisar en SIIGO». Una factura con id de SIIGO no se vuelve a crear desde Galcomex.`,
    );
  }
  exigirIncierto(borrador, ahora);

  const mensaje = `Liberado por un ADMIN el ${fechaColombia(ahora)} tras revisar el portal de SIIGO y no encontrar la factura. Se puede volver a enviar.`;

  const liberado = await prisma.$transaction(async (tx) => {
    const r = await tx.borradorFactura.updateMany({
      where: mismoIntento(borrador, ahora),
      data: {
        siigoEnvioEstado: SiigoEnvioEstado.ERROR,
        ultimoErrorSiigo: mensaje,
      },
    });
    if (r.count === 0) return false;
    await auditar(
      borrador,
      usuarioId,
      "SIIGO_ENVIO_LIBERADO",
      {
        siigoEnvioEstado: borrador.siigoEnvioEstado,
        siigoEnvioIniciadoAt: borrador.siigoEnvioIniciadoAt?.toISOString() ?? null,
        siigoEnvioIntentoId: borrador.siigoEnvioIntentoId,
      },
      { siigoEnvioEstado: SiigoEnvioEstado.ERROR, motivo: mensaje },
      tx,
    );
    return true;
  });
  if (!liberado) {
    throw new EnvioSiigoNoResolubleError("El envío cambió mientras tanto. Recarga la página.");
  }

  return { siigoEnvioEstado: "ERROR" };
}
