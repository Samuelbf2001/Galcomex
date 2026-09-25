/**
 * "Devolver con observación" — el camino de vuelta del borrador de factura.
 *
 * Hasta ahora el REVISOR (Guillermo) solo podía APROBAR: si encontraba algo
 * mal no tenía forma de regresarle el borrador a quien lo armó (recibía 403 al
 * escribir comentarios de cabecera y al mover el estado hacia atrás). Esto
 * cierra ese hueco:
 *
 *   EN_REVISION → BORRADOR   y   APROBADO → BORRADOR
 *
 * El mapa de estados NO se duplica aquí: vive en `service.ts` como
 * `TRANSICIONES_DEVOLUCION`, al lado del mapa de ida (`TRANSITIONS`).
 *
 * La observación queda en `BorradorFactura.comentariosCabecera` (el array de
 * strings que ya se muestra en la ficha) con el prefijo `DEVUELTO POR …`, y
 * ese prefijo es justamente lo que permite filtrarla al armar las
 * observaciones que van a SIIGO: es una nota interna de revisión, no un texto
 * para la factura del cliente (ver `esObservacionDevolucion`).
 *
 * Efecto colateral buscado: un aviso por WhatsApp a Camila, disparado sin
 * bloquear la respuesta (`src/lib/notificaciones/whatsapp.ts`).
 */

import { EstadoBorrador, SiigoEnvioEstado, type Prisma } from "@prisma/client";

import type { Rol } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import {
  type ResultadoNotificacion,
  notificarWhatsApp,
  obtenerDestinoWhatsAppCamila,
} from "@/lib/notificaciones/whatsapp";
import { assertTramiteModificable } from "@/lib/tramites/guard";

import {
  BorradorNoEncontradoError,
  TRANSICIONES_DEVOLUCION,
  getBorradorCompleto,
} from "./service";

// ─── Constantes del contrato ──────────────────────────────────────────────────

/** Roles que pueden devolver un borrador. Mismo gate que el endpoint. */
export const ROLES_DEVOLUCION: readonly Rol[] = ["ADMIN", "REVISOR"];

/** Límites de la observación. Los reusa el esquema Zod del endpoint. */
export const OBSERVACION_MIN = 5;
export const OBSERVACION_MAX = 1000;

/**
 * Prefijo de la línea que se agrega a `comentariosCabecera`. Es el marcador
 * que distingue una nota interna de revisión de un comentario de cabecera de
 * verdad (los que sí salen impresos en la factura de SIIGO).
 */
export const PREFIJO_DEVOLUCION = "DEVUELTO POR ";

/** Etiqueta del evento para el aviso de WhatsApp y el AuditLog de notificación. */
export const EVENTO_DEVOLUCION = "borrador_devuelto";

/**
 * ¿Esta línea de `comentariosCabecera` es una nota de devolución interna?
 * Lo usan los armadores de observaciones de SIIGO para excluirla.
 */
export function esObservacionDevolucion(texto: string): boolean {
  return texto.trimStart().startsWith(PREFIJO_DEVOLUCION);
}

// ─── Errores tipados ──────────────────────────────────────────────────────────

export class RolNoPuedeDevolverError extends Error {
  public readonly status = 403;
  constructor(rol: string) {
    super(`El rol ${rol} no puede devolver borradores de factura`);
    this.name = "RolNoPuedeDevolverError";
  }
}

export class ObservacionInvalidaError extends Error {
  public readonly status = 422;
  constructor() {
    super(
      `La observación debe tener entre ${OBSERVACION_MIN} y ${OBSERVACION_MAX} caracteres`,
    );
    this.name = "ObservacionInvalidaError";
  }
}

/**
 * El borrador no admite devolución. El mensaje habla del consecutivo del DO
 * (lo que el usuario ve en pantalla), nunca del id interno.
 */
export class BorradorNoDevolvibleError extends Error {
  public readonly status = 422;
  public readonly consecutivo: string;
  constructor(estado: EstadoBorrador, consecutivo: string) {
    super(
      estado === EstadoBorrador.FACTURADO
        ? `El borrador del ${consecutivo} ya está FACTURADO: no se puede devolver. Anula la factura en SIIGO antes de corregirla.`
        : `El borrador del ${consecutivo} ya está en BORRADOR: no hay nada que devolver.`,
    );
    this.name = "BorradorNoDevolvibleError";
    this.consecutivo = consecutivo;
  }
}

/**
 * El borrador ya salió (o pudo salir) hacia Siigo. Devolverlo dejaría en Siigo
 * una factura que Galcomex ya no reconoce como aprobada y, como el envío no se
 * repite, "Sincronizar" terminaría enlazando esa versión vieja. Solo se puede
 * devolver si nunca se envió o si Siigo lo rechazó (estado ERROR).
 */
export class BorradorYaEnSiigoError extends Error {
  public readonly status = 409;
  public readonly consecutivo: string;
  constructor(consecutivo: string) {
    super(
      `El borrador del ${consecutivo} ya se envió a SIIGO (o su envío está sin confirmar): no se puede devolver. Anúlalo en SIIGO y pide a un ADMIN que lo libere antes de corregirlo.`,
    );
    this.name = "BorradorYaEnSiigoError";
    this.consecutivo = consecutivo;
  }
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type DevolverBorradorInput = {
  borradorId: string;
  usuarioId: string;
  rol: Rol;
  observacion: string;
};

export type DevolverBorradorResult = {
  borrador: Awaited<ReturnType<typeof getBorradorCompleto>>;
  /** Línea exacta que se agregó a `comentariosCabecera`. */
  observacion: string;
  /** Consecutivo del DO, para que la UI pueda decir de qué trámite habla. */
  consecutivo: string;
};

type DatosAviso = {
  usuarioId: string;
  nombreUsuario: string;
  borradorId: string;
  tramiteId: string;
  consecutivo: string;
  cliente: string;
  observacion: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FORMATO_FECHA = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Fecha de la devolución en hora de Colombia (dd/mm/aaaa). */
export function fechaDevolucion(momento: Date = new Date()): string {
  return FORMATO_FECHA.format(momento);
}

/** Línea que se guarda en `comentariosCabecera`. */
export function construirObservacionDevolucion(
  nombreUsuario: string,
  observacion: string,
  momento: Date = new Date(),
): string {
  return `${PREFIJO_DEVOLUCION}${nombreUsuario} (${fechaDevolucion(momento)}): ${observacion.trim()}`;
}

/**
 * URL pública de la app. `APP_URL` manda; si no está, cae a la que ya usaba el
 * resto del sistema (`NEXT_PUBLIC_APP_URL`).
 */
function appUrl(): string {
  const base = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  return base.replace(/\/+$/, "");
}

/**
 * Mensaje que recibe Camila. Función pura para poder fijarla en un test.
 *
 * El consecutivo ya viene con su prefijo propio (`DO.BAQ26-0001`,
 * `CLAS26-0001`, `OTR26-0001`), así que se usa tal cual — anteponerle otro
 * "DO." lo dejaría como "DO.DO.BAQ26-0001".
 */
export function construirMensajeDevolucion(datos: DatosAviso): string {
  const base = appUrl();
  const enlace = `${base}/tramites/${datos.tramiteId}`;
  return (
    `Galcomex: ${datos.nombreUsuario} devolvió el borrador del ${datos.consecutivo} ` +
    `(${datos.cliente}) con observación: ${datos.observacion.trim()}. ` +
    `Revísalo en ${enlace}`
  );
}

/**
 * Arma y dispara el aviso a Camila. Exportada para poder probarla aparte;
 * `devolverBorrador` la llama SIN `await`.
 */
export async function notificarDevolucionAWhatsApp(
  datos: DatosAviso,
): Promise<ResultadoNotificacion> {
  const destino = await obtenerDestinoWhatsAppCamila();

  return notificarWhatsApp({
    destino,
    texto: construirMensajeDevolucion(datos),
    contexto: {
      usuarioId: datos.usuarioId,
      evento: EVENTO_DEVOLUCION,
      entidad: "BorradorFactura",
      entidadId: datos.borradorId,
      tramiteId: datos.tramiteId,
      datos: {
        consecutivo: datos.consecutivo,
        cliente: datos.cliente,
        devueltoPor: datos.nombreUsuario,
      },
    },
  });
}

// ─── Caso de uso ──────────────────────────────────────────────────────────────

/**
 * Devuelve un borrador a estado BORRADOR con una observación del revisor.
 *
 * - Permitido a ADMIN y REVISOR.
 * - Transiciones válidas: EN_REVISION → BORRADOR y APROBADO → BORRADOR
 *   (`TRANSICIONES_DEVOLUCION` en `service.ts`).
 * - Al devolver desde APROBADO se retira la aprobación (`aprobadoPorId` y
 *   `fechaAprobacion` vuelven a null): ya no está aprobado por nadie. El
 *   `snapshotCalculo` se conserva como rastro de qué se había aprobado.
 * - Deja `AuditLog` accion `"DEVOLVER"` con snapshot antes/después.
 * - Dispara el aviso de WhatsApp a Camila sin bloquear la respuesta.
 */
export async function devolverBorrador(
  input: DevolverBorradorInput,
): Promise<DevolverBorradorResult> {
  const { borradorId, usuarioId, rol } = input;

  if (!ROLES_DEVOLUCION.includes(rol)) {
    throw new RolNoPuedeDevolverError(rol);
  }

  const observacion = input.observacion.trim();
  if (observacion.length < OBSERVACION_MIN || observacion.length > OBSERVACION_MAX) {
    throw new ObservacionInvalidaError();
  }

  const { resultado, aviso } = await prisma.$transaction(async (tx) => {
    const borrador = await tx.borradorFactura.findUnique({
      where: { id: borradorId },
      select: {
        id: true,
        estado: true,
        tramiteId: true,
        comentariosCabecera: true,
        aprobadoPorId: true,
        fechaAprobacion: true,
        siigoDraftId: true,
        siigoEnvioEstado: true,
        tramite: {
          select: {
            id: true,
            consecutivo: true,
            estado: true,
            cliente: { select: { nombre: true } },
          },
        },
      },
    });

    if (!borrador) {
      throw new BorradorNoEncontradoError(borradorId);
    }

    await assertTramiteModificable(tx, borrador.tramite);

    const destino = TRANSICIONES_DEVOLUCION[borrador.estado];
    if (destino === null) {
      throw new BorradorNoDevolvibleError(borrador.estado, borrador.tramite.consecutivo);
    }

    if (
      borrador.siigoDraftId !== null ||
      (borrador.siigoEnvioEstado !== null &&
        borrador.siigoEnvioEstado !== SiigoEnvioEstado.ERROR)
    ) {
      throw new BorradorYaEnSiigoError(borrador.tramite.consecutivo);
    }

    const usuario = await tx.user.findUnique({
      where: { id: usuarioId },
      select: { name: true, email: true },
    });
    const nombreUsuario = usuario?.name?.trim() || usuario?.email || usuarioId;

    const comentariosPrevios = Array.isArray(borrador.comentariosCabecera)
      ? (borrador.comentariosCabecera as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0,
        )
      : [];

    const linea = construirObservacionDevolucion(nombreUsuario, observacion);
    const comentarios: Prisma.InputJsonValue = [...comentariosPrevios, linea];

    await tx.borradorFactura.update({
      where: { id: borradorId },
      data: {
        estado: destino,
        comentariosCabecera: comentarios,
        // La aprobación se retira: el borrador vuelve a estar sin aprobar.
        aprobadoPorId: null,
        fechaAprobacion: null,
      },
    });

    await tx.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion: "DEVOLVER",
        usuarioId,
        tramiteId: borrador.tramiteId,
        antes: {
          estado: borrador.estado,
          comentariosCabecera: comentariosPrevios,
          aprobadoPorId: borrador.aprobadoPorId,
          fechaAprobacion: borrador.fechaAprobacion?.toISOString() ?? null,
        },
        despues: {
          estado: destino,
          comentariosCabecera: [...comentariosPrevios, linea],
          aprobadoPorId: null,
          fechaAprobacion: null,
          observacion: linea,
        },
      },
    });

    return {
      resultado: { observacion: linea, consecutivo: borrador.tramite.consecutivo },
      aviso: {
        usuarioId,
        nombreUsuario,
        borradorId,
        tramiteId: borrador.tramiteId,
        consecutivo: borrador.tramite.consecutivo,
        cliente: borrador.tramite.cliente.nombre,
        observacion,
      } satisfies DatosAviso,
    };
  });

  // Fire-and-forget: el aviso no puede demorar ni tumbar la respuesta del
  // endpoint. `notificarWhatsApp` nunca lanza, pero el `.catch` deja cubierto
  // cualquier fallo al leer el parámetro del destinatario.
  void notificarDevolucionAWhatsApp(aviso).catch((error: unknown) => {
    console.error(
      "[borradores/devolver] no se pudo disparar el aviso de WhatsApp",
      JSON.stringify({
        borradorId,
        consecutivo: aviso.consecutivo,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  const borrador = await getBorradorCompleto(borradorId);

  return {
    borrador,
    observacion: resultado.observacion,
    consecutivo: resultado.consecutivo,
  };
}
