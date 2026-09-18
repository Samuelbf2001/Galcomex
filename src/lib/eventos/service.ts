/**
 * Eventos del trámite — capa de BD (M3)
 *
 * Marcar un evento ("se abrió el contenedor", "hubo entrega directa", "se
 * elaboró el registro") hace tres cosas:
 *   1. Deja rastro: quién, cuándo y cuántas veces.
 *   2. Exige sus documentos: crea los ítems del checklist que el evento pide
 *      (las fotos de la revisión, el registro y su pago).
 *   3. Habilita el ítem del tarifario que lo cobra (ver `lib/tarifas/service.ts`).
 *
 * Solo pueden marcar eventos las empresas con la capacidad `eventos_facturables`.
 */

import type { Prisma } from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { assertTramiteModificable } from "@/lib/tramites/guard";

export class TramiteEventosNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(tramiteId: string) {
    super(`Trámite ${tramiteId} no encontrado`);
    this.name = "TramiteEventosNoEncontradoError";
  }
}

export class EventosNoHabilitadosError extends Error {
  public readonly status = 422;
  constructor(nombreEmpresa: string) {
    super(
      `${nombreEmpresa} no tiene habilitados los eventos facturables. Actívalos en la ficha, pestaña Funciones.`,
    );
    this.name = "EventosNoHabilitadosError";
  }
}

export class EventoNoEncontradoError extends Error {
  public readonly status = 422;
  constructor(codigo: string) {
    super(`El evento ${codigo} no existe o está inactivo`);
    this.name = "EventoNoEncontradoError";
  }
}

export interface EventoCatalogoDto {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  documentosRequeridos: string[];
  permiteCantidad: boolean;
  orden: number;
}

export interface EventoTramiteDto {
  codigo: string;
  nombre: string;
  cantidad: number;
  observacion: string | null;
  marcadoPor: string;
  marcadoAt: Date;
  documentosRequeridos: string[];
}

function documentosDe(json: Prisma.JsonValue): string[] {
  return Array.isArray(json) ? json.filter((d): d is string => typeof d === "string") : [];
}

export async function listarCatalogoEventos(): Promise<EventoCatalogoDto[]> {
  const eventos = await prisma.catalogoEvento.findMany({
    where: { activo: true },
    orderBy: [{ orden: "asc" }, { codigo: "asc" }],
  });

  return eventos.map((e) => ({
    codigo: e.codigo,
    nombre: e.nombre,
    descripcion: e.descripcion,
    documentosRequeridos: documentosDe(e.documentosRequeridos),
    permiteCantidad: e.permiteCantidad,
    orden: e.orden,
  }));
}

// ─── Catálogos: edición del catálogo de eventos (Configuración → Catálogos) ───

export class EventoCatalogoNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(codigo: string) {
    super(`El evento ${codigo} no existe en el catálogo`);
    this.name = "EventoCatalogoNoEncontradoError";
  }
}

export interface EventoCatalogoAdminDto extends EventoCatalogoDto {
  activo: boolean;
  /** Ítems de tarifario que dependen del evento (avisa antes de desactivarlo). */
  itemsTarifario: number;
  /** Veces que se ha marcado en un trámite. */
  tramitesMarcados: number;
}

/** Catálogo COMPLETO (incluye inactivos) para la pantalla de Catálogos. */
export async function listarCatalogoEventosAdmin(): Promise<EventoCatalogoAdminDto[]> {
  const eventos = await prisma.catalogoEvento.findMany({
    orderBy: [{ orden: "asc" }, { codigo: "asc" }],
    include: { _count: { select: { tarifaItems: true, tramites: true } } },
  });

  return eventos.map((e) => ({
    codigo: e.codigo,
    nombre: e.nombre,
    descripcion: e.descripcion,
    documentosRequeridos: documentosDe(e.documentosRequeridos),
    permiteCantidad: e.permiteCantidad,
    orden: e.orden,
    activo: e.activo,
    itemsTarifario: e._count.tarifaItems,
    tramitesMarcados: e._count.tramites,
  }));
}

export interface ActualizarEventoCatalogoInput {
  codigo: string;
  nombre?: string;
  descripcion?: string | null;
  documentosRequeridos?: string[];
  permiteCantidad?: boolean;
  orden?: number;
  activo?: boolean;
  usuarioId: string;
}

/**
 * Edita un evento del catálogo. El `codigo` identifica y es INMUTABLE: es la FK
 * de `tarifa_item.eventoCodigo` y de `tramite_evento`, y cambiarlo dejaría
 * tarifarios apuntando al vacío.
 *
 * Cambiar `documentosRequeridos` afecta solo a los trámites que marquen el
 * evento DESPUÉS: los checklist ya creados no se tocan (nadie quiere que se le
 * borre un documento ya recibido).
 */
export async function actualizarEventoCatalogo(
  input: ActualizarEventoCatalogoInput,
): Promise<EventoCatalogoAdminDto> {
  const { codigo, usuarioId } = input;

  const antes = await prisma.catalogoEvento.findUnique({ where: { codigo } });
  if (!antes) throw new EventoCatalogoNoEncontradoError(codigo);

  const data: Prisma.CatalogoEventoUpdateInput = {};
  if (input.nombre !== undefined) data.nombre = input.nombre;
  if (input.descripcion !== undefined) data.descripcion = input.descripcion ?? null;
  if (input.documentosRequeridos !== undefined) {
    data.documentosRequeridos = input.documentosRequeridos;
  }
  if (input.permiteCantidad !== undefined) data.permiteCantidad = input.permiteCantidad;
  if (input.orden !== undefined) data.orden = input.orden;
  if (input.activo !== undefined) data.activo = input.activo;

  await prisma.$transaction(async (tx) => {
    const despues = await tx.catalogoEvento.update({ where: { codigo }, data });

    await tx.auditLog.create({
      data: {
        entidad: "CatalogoEvento",
        entidadId: codigo,
        accion: "UPDATE",
        usuarioId,
        antes: {
          nombre: antes.nombre,
          descripcion: antes.descripcion,
          documentosRequeridos: documentosDe(antes.documentosRequeridos),
          permiteCantidad: antes.permiteCantidad,
          orden: antes.orden,
          activo: antes.activo,
        },
        despues: {
          nombre: despues.nombre,
          descripcion: despues.descripcion,
          documentosRequeridos: documentosDe(despues.documentosRequeridos),
          permiteCantidad: despues.permiteCantidad,
          orden: despues.orden,
          activo: despues.activo,
        },
      },
    });
  });

  const catalogo = await listarCatalogoEventosAdmin();
  const actualizado = catalogo.find((e) => e.codigo === codigo);
  if (!actualizado) throw new EventoCatalogoNoEncontradoError(codigo);
  return actualizado;
}

export async function eventosDeTramite(tramiteId: string): Promise<EventoTramiteDto[]> {
  const marcados = await prisma.tramiteEvento.findMany({
    where: { tramiteId },
    include: { evento: true, marcadoPor: { select: { name: true } } },
    orderBy: { evento: { orden: "asc" } },
  });

  return marcados.map((m) => ({
    codigo: m.eventoCodigo,
    nombre: m.evento.nombre,
    cantidad: m.cantidad,
    observacion: m.observacion,
    marcadoPor: m.marcadoPor.name,
    marcadoAt: m.createdAt,
    documentosRequeridos: documentosDe(m.evento.documentosRequeridos),
  }));
}

export interface MarcarEventosInput {
  tramiteId: string;
  eventos: { codigo: string; cantidad: number; observacion?: string | null }[];
  usuarioId: string;
}

/**
 * Reemplaza el conjunto de eventos del trámite. Idempotente: mandar la misma
 * lista dos veces no duplica nada. Los ítems de checklist que exige un evento
 * se crean al marcarlo y se retiran al desmarcarlo (solo si nadie los marcó
 * como recibidos).
 */
export async function marcarEventosTramite(input: MarcarEventosInput) {
  const { tramiteId, usuarioId } = input;

  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      id: true,
      consecutivo: true,
      estado: true,
      clienteId: true,
      cliente: { select: { nombre: true } },
    },
  });
  if (!tramite) throw new TramiteEventosNoEncontradoError(tramiteId);

  const capacidades = await capacidadesDeEmpresa(tramite.clienteId);
  if (!tiene(capacidades, "eventos_facturables")) {
    throw new EventosNoHabilitadosError(tramite.cliente.nombre);
  }

  // Dedupe por código: la última ocurrencia manda.
  const deseados = new Map<string, { cantidad: number; observacion: string | null }>();
  for (const e of input.eventos) {
    deseados.set(e.codigo, { cantidad: e.cantidad, observacion: e.observacion ?? null });
  }

  const catalogo = await prisma.catalogoEvento.findMany({
    where: { codigo: { in: [...deseados.keys()] }, activo: true },
  });
  const porCodigo = new Map(catalogo.map((c) => [c.codigo, c]));
  for (const codigo of deseados.keys()) {
    if (!porCodigo.has(codigo)) throw new EventoNoEncontradoError(codigo);
  }

  return prisma.$transaction(async (tx) => {
    await assertTramiteModificable(tx, tramite);

    const actuales = await tx.tramiteEvento.findMany({
      where: { tramiteId },
      include: { evento: true },
    });
    const antes = actuales.map((a) => ({
      codigo: a.eventoCodigo,
      cantidad: a.cantidad,
      observacion: a.observacion,
    }));

    // Desmarcar los que ya no vienen.
    for (const actual of actuales) {
      if (deseados.has(actual.eventoCodigo)) continue;
      await tx.tramiteEvento.delete({ where: { id: actual.id } });
      const docs = documentosDe(actual.evento.documentosRequeridos);
      if (docs.length > 0) {
        await tx.checklistItem.deleteMany({
          where: { tramiteId, descripcion: { in: docs }, recibido: false },
        });
      }
    }

    // Marcar o actualizar los que vienen.
    for (const [codigo, datos] of deseados) {
      const definicion = porCodigo.get(codigo);
      if (!definicion) continue;
      const cantidad = definicion.permiteCantidad ? datos.cantidad : 1;

      await tx.tramiteEvento.upsert({
        where: { tramiteId_eventoCodigo: { tramiteId, eventoCodigo: codigo } },
        create: {
          tramiteId,
          eventoCodigo: codigo,
          cantidad,
          observacion: datos.observacion,
          marcadoPorId: usuarioId,
        },
        update: { cantidad, observacion: datos.observacion },
      });

      for (const descripcion of documentosDe(definicion.documentosRequeridos)) {
        const existe = await tx.checklistItem.findFirst({
          where: { tramiteId, descripcion },
          select: { id: true },
        });
        if (!existe) {
          await tx.checklistItem.create({
            data: { tramiteId, descripcion, requerido: true },
          });
        }
      }
    }

    const despues = await tx.tramiteEvento.findMany({
      where: { tramiteId },
      select: { eventoCodigo: true, cantidad: true, observacion: true },
    });

    await tx.auditLog.create({
      data: {
        entidad: "TramiteDO",
        entidadId: tramiteId,
        accion: "SET_EVENTOS_TRAMITE",
        usuarioId,
        tramiteId,
        antes: { eventos: antes },
        despues: { eventos: despues.map((d) => ({ codigo: d.eventoCodigo, cantidad: d.cantidad, observacion: d.observacion })) },
      },
    });
  });
}
