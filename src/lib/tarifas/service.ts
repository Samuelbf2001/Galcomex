/**
 * Tarifario por empresa — capa de BD (M2)
 *
 * Ciclo de vida: BORRADOR → VIGENTE → (VENCIDO | REEMPLAZADO). Solo se editan
 * los ítems de un BORRADOR; para cambiar un tarifario vigente se duplica a una
 * versión nueva (con incremento opcional, p. ej. IPC) y se publica: publicar
 * reemplaza al vigente anterior del mismo alcance.
 *
 * El cálculo es del motor puro (`./motor.ts`); aquí solo se arma el contexto
 * del trámite (base de cálculo + eventos + costos) y se persiste.
 */

import {
  DisparadorTarifa,
  EstadoTarifario,
  Prisma,
  TipoCalculoTarifa,
  type TarifaItem,
  type Tarifario,
} from "@prisma/client";

import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { plantillaPorCodigo } from "@/lib/tarifas/plantillas";
import {
  calcularLineasTarifa,
  vigenteEn,
  type ContextoTarifa,
  type ItemTarifaCalculable,
  type MinimosTarifa,
  type ResultadoTarifa,
} from "@/lib/tarifas/motor";
import {
  tarifaItemSchema,
  type TarifaItemPayload,
  type TarifaItemUpdatePayload,
  type TarifarioDuplicarPayload,
  type TarifarioPayload,
  type TarifarioUpdatePayload,
} from "@/lib/validations/tarifas";

// ─── Errores de dominio ───────────────────────────────────────────────────────

export class TarifarioNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Tarifario ${id} no encontrado`);
    this.name = "TarifarioNoEncontradoError";
  }
}

export class TarifarioNoHabilitadoError extends Error {
  public readonly status = 422;
  constructor(nombreEmpresa: string) {
    super(
      `${nombreEmpresa} no tiene habilitado el tarifario propio. Actívalo en la ficha, pestaña Funciones.`,
    );
    this.name = "TarifarioNoHabilitadoError";
  }
}

export class TarifarioNoEditableError extends Error {
  public readonly status = 422;
  constructor(estado: EstadoTarifario) {
    super(
      `Un tarifario ${estado} no se edita. Duplícalo a una versión nueva y publícala.`,
    );
    this.name = "TarifarioNoEditableError";
  }
}

export class TarifarioSinItemsError extends Error {
  public readonly status = 422;
  constructor() {
    super("No se puede publicar un tarifario sin ítems");
    this.name = "TarifarioSinItemsError";
  }
}

export class TransicionTarifarioInvalidaError extends Error {
  public readonly status = 422;
  constructor(de: EstadoTarifario, a: string) {
    super(`No se puede pasar un tarifario de ${de} a ${a}`);
    this.name = "TransicionTarifarioInvalidaError";
  }
}

export class TarifaItemNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Ítem de tarifa ${id} no encontrado`);
    this.name = "TarifaItemNoEncontradoError";
  }
}

export class TarifaItemDuplicadoError extends Error {
  public readonly status = 409;
  constructor(concepto: string) {
    super(`El tarifario ya tiene un ítem con el concepto ${concepto}`);
    this.name = "TarifaItemDuplicadoError";
  }
}

export class PlantillaNoEncontradaError extends Error {
  public readonly status = 422;
  constructor(codigo: string) {
    super(`La plantilla ${codigo} no existe`);
    this.name = "PlantillaNoEncontradaError";
  }
}

export class TarifarioSinNombreError extends Error {
  public readonly status = 422;
  constructor() {
    super("El tarifario necesita un nombre (o una plantilla que lo traiga)");
    this.name = "TarifarioSinNombreError";
  }
}

export class EmpresaTarifarioNoEncontradaError extends Error {
  public readonly status = 404;
  constructor(id: string) {
    super(`Empresa ${id} no encontrada`);
    this.name = "EmpresaTarifarioNoEncontradaError";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSerializable(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

function minimosDe(json: Prisma.JsonValue | null): MinimosTarifa | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const out: MinimosTarifa = {};
  for (const clave of ["SUELTA", "CONTENEDOR_20", "CONTENEDOR_40"] as const) {
    const v = (json as Record<string, unknown>)[clave];
    if (typeof v === "string" && /^\d+$/.test(v)) out[clave] = v;
  }
  return out;
}

export function itemCalculableDe(item: TarifaItem): ItemTarifaCalculable {
  return {
    concepto: item.concepto,
    nombrePublico: item.nombrePublico,
    siigoCodigo: item.siigoCodigo,
    tipoCalculo: item.tipoCalculo,
    disparador: item.disparador,
    eventoCodigo: item.eventoCodigo,
    unidad: item.unidad,
    valor: item.valor,
    valorAdicional: item.valorAdicional,
    porcentajeBps: item.porcentajeBps,
    minimos: minimosDe(item.minimos),
    conceptoCosto: item.conceptoCosto,
    aplicaIva: item.aplicaIva,
    orden: item.orden,
  };
}

function itemCreateData(item: TarifaItemPayload): Prisma.TarifaItemCreateWithoutTarifarioInput {
  return {
    orden: item.orden,
    concepto: item.concepto,
    nombrePublico: item.nombrePublico,
    siigoCodigo: item.siigoCodigo ?? null,
    tipoCalculo: item.tipoCalculo,
    disparador: item.disparador,
    unidad: item.unidad,
    valor: item.valor,
    valorAdicional: item.valorAdicional ?? null,
    porcentajeBps: item.porcentajeBps ?? null,
    minimos: item.minimos ? normalizeSerializable(item.minimos) : undefined,
    conceptoCosto: item.conceptoCosto ?? null,
    aplicaIva: item.aplicaIva,
    notas: item.notas ?? null,
    ...(item.eventoCodigo ? { evento: { connect: { codigo: item.eventoCodigo } } } : {}),
  };
}

const tarifarioInclude = {
  items: { orderBy: [{ orden: "asc" }, { concepto: "asc" }] },
  empresa: { select: { id: true, nombre: true, nit: true } },
  creadoPor: { select: { name: true } },
} satisfies Prisma.TarifarioInclude;

export type TarifarioConItems = Prisma.TarifarioGetPayload<{ include: typeof tarifarioInclude }>;

async function exigirCapacidadTarifario(empresaId: string) {
  const empresa = await prisma.cliente.findUnique({
    where: { id: empresaId },
    select: { id: true, nombre: true },
  });
  if (!empresa) throw new EmpresaTarifarioNoEncontradaError(empresaId);

  const capacidades = await capacidadesDeEmpresa(empresaId);
  if (!tiene(capacidades, "tarifario_propio")) {
    throw new TarifarioNoHabilitadoError(empresa.nombre);
  }
  return empresa;
}

async function siguienteVersion(tx: Prisma.TransactionClient, empresaId: string, alcance: string) {
  const ultimo = await tx.tarifario.aggregate({
    where: { empresaId, alcance },
    _max: { version: true },
  });
  return (ultimo._max.version ?? 0) + 1;
}

// ─── Consultas ────────────────────────────────────────────────────────────────

export async function listarTarifarios(empresaId: string): Promise<TarifarioConItems[]> {
  return prisma.tarifario.findMany({
    where: { empresaId },
    include: tarifarioInclude,
    orderBy: [{ alcance: "asc" }, { version: "desc" }],
  });
}

export async function getTarifario(id: string): Promise<TarifarioConItems> {
  const t = await prisma.tarifario.findUnique({ where: { id }, include: tarifarioInclude });
  if (!t) throw new TarifarioNoEncontradoError(id);
  return t;
}

/**
 * Tarifario VIGENTE de la empresa para un alcance en una fecha. Un tarifario
 * marcado VIGENTE pero ya fuera de fecha NO cuenta: el sistema avisa en vez
 * de facturar con precios viejos.
 */
export async function tarifarioVigenteDe(
  empresaId: string,
  alcance: string,
  fecha: Date = new Date(),
): Promise<TarifarioConItems | null> {
  const vigentes = await prisma.tarifario.findMany({
    where: { empresaId, alcance, estado: EstadoTarifario.VIGENTE },
    include: tarifarioInclude,
    orderBy: { version: "desc" },
  });
  return vigentes.find((t) => vigenteEn(t, fecha)) ?? null;
}

// ─── Mutaciones ───────────────────────────────────────────────────────────────

export interface CrearTarifarioInput extends TarifarioPayload {
  empresaId: string;
  usuarioId: string;
}

export async function crearTarifario(input: CrearTarifarioInput): Promise<TarifarioConItems> {
  await exigirCapacidadTarifario(input.empresaId);

  const plantilla = input.plantilla ? plantillaPorCodigo(input.plantilla) : null;
  if (input.plantilla && !plantilla) throw new PlantillaNoEncontradaError(input.plantilla);

  const nombre = input.nombre ?? plantilla?.nombre;
  if (!nombre) throw new TarifarioSinNombreError();
  const alcance = input.alcance ?? plantilla?.alcance ?? "TRAMITE";
  const items: TarifaItemPayload[] =
    input.items.length > 0 ? input.items : (plantilla?.items ?? []).map((it) => tarifaItemSchema.parse(it));
  const notas =
    input.notas ?? (plantilla ? `Cargado desde la plantilla "${plantilla.nombre}" (${plantilla.fuente})` : null);

  return prisma.$transaction(async (tx) => {
    const version = await siguienteVersion(tx, input.empresaId, alcance);
    const creado = await tx.tarifario.create({
      data: {
        empresaId: input.empresaId,
        nombre,
        alcance,
        vigenteDesde: input.vigenteDesde,
        vigenteHasta: input.vigenteHasta,
        notas,
        version,
        creadoPorId: input.usuarioId,
        items: { create: items.map(itemCreateData) },
      },
      include: tarifarioInclude,
    });

    await tx.auditLog.create({
      data: {
        entidad: "Tarifario",
        entidadId: creado.id,
        accion: "CREATE",
        usuarioId: input.usuarioId,
        despues: normalizeSerializable(creado),
      },
    });

    return creado;
  });
}

export async function actualizarTarifario(
  id: string,
  payload: TarifarioUpdatePayload,
  usuarioId: string,
): Promise<TarifarioConItems> {
  const antes = await getTarifario(id);
  if (antes.estado !== EstadoTarifario.BORRADOR && (payload.alcance || payload.vigenteDesde || payload.vigenteHasta)) {
    throw new TarifarioNoEditableError(antes.estado);
  }

  return prisma.$transaction(async (tx) => {
    const despues = await tx.tarifario.update({
      where: { id },
      data: {
        nombre: payload.nombre,
        alcance: payload.alcance,
        vigenteDesde: payload.vigenteDesde,
        vigenteHasta: payload.vigenteHasta,
        notas: payload.notas,
      },
      include: tarifarioInclude,
    });
    await tx.auditLog.create({
      data: {
        entidad: "Tarifario",
        entidadId: id,
        accion: "UPDATE",
        usuarioId,
        antes: normalizeSerializable(antes),
        despues: normalizeSerializable(despues),
      },
    });
    return despues;
  });
}

export async function eliminarTarifario(id: string, usuarioId: string): Promise<void> {
  const antes = await getTarifario(id);
  if (antes.estado !== EstadoTarifario.BORRADOR) throw new TarifarioNoEditableError(antes.estado);

  await prisma.$transaction(async (tx) => {
    await tx.tarifario.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        entidad: "Tarifario",
        entidadId: id,
        accion: "DELETE",
        usuarioId,
        antes: normalizeSerializable(antes),
      },
    });
  });
}

/**
 * VIGENTE: exige ítems y reemplaza al vigente anterior del mismo alcance.
 * VENCIDO: solo desde VIGENTE.
 */
export async function cambiarEstadoTarifario(
  id: string,
  estado: "VIGENTE" | "VENCIDO",
  usuarioId: string,
): Promise<TarifarioConItems> {
  const antes = await getTarifario(id);

  if (estado === "VIGENTE") {
    if (antes.estado !== EstadoTarifario.BORRADOR) throw new TransicionTarifarioInvalidaError(antes.estado, estado);
    if (antes.items.length === 0) throw new TarifarioSinItemsError();
  }
  if (estado === "VENCIDO" && antes.estado !== EstadoTarifario.VIGENTE) {
    throw new TransicionTarifarioInvalidaError(antes.estado, estado);
  }

  return prisma.$transaction(async (tx) => {
    if (estado === "VIGENTE") {
      await tx.tarifario.updateMany({
        where: {
          empresaId: antes.empresaId,
          alcance: antes.alcance,
          estado: EstadoTarifario.VIGENTE,
          id: { not: id },
        },
        data: { estado: EstadoTarifario.REEMPLAZADO },
      });
    }

    const despues = await tx.tarifario.update({
      where: { id },
      data: { estado: estado === "VIGENTE" ? EstadoTarifario.VIGENTE : EstadoTarifario.VENCIDO },
      include: tarifarioInclude,
    });

    await tx.auditLog.create({
      data: {
        entidad: "Tarifario",
        entidadId: id,
        accion: estado === "VIGENTE" ? "PUBLICAR_TARIFARIO" : "VENCER_TARIFARIO",
        usuarioId,
        antes: { estado: antes.estado },
        despues: { estado: despues.estado },
      },
    });

    return despues;
  });
}

function redondear(valor: bigint, a: number): bigint {
  const paso = BigInt(a);
  if (paso <= 1n) return valor;
  return ((valor + paso / 2n) / paso) * paso;
}

/** `valor × (1 + pct/100)` con redondeo half-up a `redondeoA` (1.000 por defecto). */
export function aplicarIncremento(valor: bigint, incrementoPct: number | undefined, redondeoA: number): bigint {
  if (incrementoPct === undefined || incrementoPct === 0) return valor;
  // pct con 4 decimales de precisión (5.29 → 52900 / 1.000.000)
  const factor = BigInt(Math.round((100 + incrementoPct) * 10_000));
  const bruto = (valor * factor + 500_000n) / 1_000_000n;
  return redondear(bruto, redondeoA);
}

/**
 * Nueva versión BORRADOR a partir de un tarifario (mismo alcance, misma
 * empresa salvo `empresaDestinoId`), con incremento opcional. Es el camino
 * para "renovar el año": duplicar, revisar, publicar.
 */
export async function duplicarTarifario(
  id: string,
  payload: TarifarioDuplicarPayload,
  usuarioId: string,
): Promise<TarifarioConItems> {
  const origen = await getTarifario(id);
  const empresaId = payload.empresaDestinoId ?? origen.empresaId;
  if (empresaId !== origen.empresaId) await exigirCapacidadTarifario(empresaId);

  const items = origen.items.map<Prisma.TarifaItemCreateWithoutTarifarioInput>((it) => {
    const minimos = minimosDe(it.minimos);
    const minimosAjustados = minimos
      ? Object.fromEntries(
          Object.entries(minimos).map(([k, v]) => [
            k,
            aplicarIncremento(BigInt(v), payload.incrementoPct, payload.redondeoA).toString(),
          ]),
        )
      : null;
    return {
      orden: it.orden,
      concepto: it.concepto,
      nombrePublico: it.nombrePublico,
      siigoCodigo: it.siigoCodigo,
      tipoCalculo: it.tipoCalculo,
      disparador: it.disparador,
      unidad: it.unidad,
      valor: aplicarIncremento(it.valor, payload.incrementoPct, payload.redondeoA),
      valorAdicional:
        it.valorAdicional === null
          ? null
          : aplicarIncremento(it.valorAdicional, payload.incrementoPct, payload.redondeoA),
      porcentajeBps: it.porcentajeBps,
      minimos: minimosAjustados ? normalizeSerializable(minimosAjustados) : undefined,
      conceptoCosto: it.conceptoCosto,
      aplicaIva: it.aplicaIva,
      notas: it.notas,
      ...(it.eventoCodigo ? { evento: { connect: { codigo: it.eventoCodigo } } } : {}),
    };
  });

  return prisma.$transaction(async (tx) => {
    const version = await siguienteVersion(tx, empresaId, origen.alcance);
    const creado = await tx.tarifario.create({
      data: {
        empresaId,
        nombre: payload.nombre ?? origen.nombre,
        alcance: origen.alcance,
        vigenteDesde: payload.vigenteDesde,
        vigenteHasta: payload.vigenteHasta,
        notas:
          payload.incrementoPct !== undefined && payload.incrementoPct !== 0
            ? `Duplicado de la versión ${origen.version} con incremento del ${payload.incrementoPct} %`
            : `Duplicado de la versión ${origen.version}`,
        version,
        creadoPorId: usuarioId,
        items: { create: items },
      },
      include: tarifarioInclude,
    });

    await tx.auditLog.create({
      data: {
        entidad: "Tarifario",
        entidadId: creado.id,
        accion: "DUPLICAR_TARIFARIO",
        usuarioId,
        antes: { origenId: id, version: origen.version },
        despues: normalizeSerializable(creado),
      },
    });

    return creado;
  });
}

// ─── Ítems ────────────────────────────────────────────────────────────────────

async function exigirBorrador(tarifarioId: string) {
  const t = await getTarifario(tarifarioId);
  if (t.estado !== EstadoTarifario.BORRADOR) throw new TarifarioNoEditableError(t.estado);
  return t;
}

export async function agregarItemTarifario(
  tarifarioId: string,
  payload: TarifaItemPayload,
  usuarioId: string,
): Promise<TarifarioConItems> {
  const t = await exigirBorrador(tarifarioId);
  if (t.items.some((i) => i.concepto === payload.concepto)) {
    throw new TarifaItemDuplicadoError(payload.concepto);
  }

  await prisma.$transaction(async (tx) => {
    const item = await tx.tarifaItem.create({
      data: { ...itemCreateData(payload), tarifario: { connect: { id: tarifarioId } } },
    });
    await tx.auditLog.create({
      data: {
        entidad: "TarifaItem",
        entidadId: item.id,
        accion: "CREATE",
        usuarioId,
        despues: normalizeSerializable(item),
      },
    });
  });

  return getTarifario(tarifarioId);
}

export async function actualizarItemTarifario(
  tarifarioId: string,
  itemId: string,
  payload: TarifaItemUpdatePayload,
  usuarioId: string,
): Promise<TarifarioConItems> {
  const t = await exigirBorrador(tarifarioId);
  const antes = t.items.find((i) => i.id === itemId);
  if (!antes) throw new TarifaItemNoEncontradoError(itemId);

  // Coherencia del ítem resultante (tipo de cálculo ↔ campos).
  const fusionado = tarifaItemSchema.parse({
    ...itemCalculableDe(antes),
    minimos: minimosDe(antes.minimos),
    notas: antes.notas,
    ...payload,
  });

  if (fusionado.concepto !== antes.concepto && t.items.some((i) => i.concepto === fusionado.concepto)) {
    throw new TarifaItemDuplicadoError(fusionado.concepto);
  }

  await prisma.$transaction(async (tx) => {
    const despues = await tx.tarifaItem.update({
      where: { id: itemId },
      data: {
        ...itemCreateData(fusionado),
        // `connect` no desconecta: si el evento se quitó, hay que hacerlo explícito.
        ...(fusionado.eventoCodigo ? {} : { evento: { disconnect: true } }),
        ...(fusionado.minimos ? {} : { minimos: Prisma.DbNull }),
      },
    });
    await tx.auditLog.create({
      data: {
        entidad: "TarifaItem",
        entidadId: itemId,
        accion: "UPDATE",
        usuarioId,
        antes: normalizeSerializable(antes),
        despues: normalizeSerializable(despues),
      },
    });
  });

  return getTarifario(tarifarioId);
}

export async function eliminarItemTarifario(
  tarifarioId: string,
  itemId: string,
  usuarioId: string,
): Promise<TarifarioConItems> {
  const t = await exigirBorrador(tarifarioId);
  const antes = t.items.find((i) => i.id === itemId);
  if (!antes) throw new TarifaItemNoEncontradoError(itemId);

  await prisma.$transaction(async (tx) => {
    await tx.tarifaItem.delete({ where: { id: itemId } });
    await tx.auditLog.create({
      data: {
        entidad: "TarifaItem",
        entidadId: itemId,
        accion: "DELETE",
        usuarioId,
        antes: normalizeSerializable(antes),
      },
    });
  });

  return getTarifario(tarifarioId);
}

// ─── Propuesta para un trámite ────────────────────────────────────────────────

export interface PropuestaTarifa {
  /** Null cuando la empresa no tiene la función o no hay tarifario vigente. */
  tarifario: {
    id: string;
    nombre: string;
    version: number;
    alcance: string;
    vigenteDesde: Date;
    vigenteHasta: Date;
  } | null;
  /** Por qué no hay propuesta, en palabras para la UI. */
  motivo: string | null;
  resultado: ResultadoTarifa | null;
  contexto: ContextoTarifa;
}

export async function contextoDeTramite(tramiteId: string): Promise<ContextoTarifa> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      valorCif: true,
      tipoCarga: true,
      numContenedores: true,
      numDeclaraciones: true,
      numDocumentos: true,
      numItems: true,
      eventos: { select: { eventoCodigo: true, cantidad: true } },
      pagos: { select: { concepto: true, valor: true } },
      facturasProveedor: { select: { concepto: true, valor: true } },
    },
  });
  if (!tramite) throw new TarifarioNoEncontradoError(tramiteId);

  const costos = [
    ...tramite.pagos.filter((p) => p.concepto).map((p) => ({ concepto: p.concepto ?? "", valor: p.valor })),
    ...tramite.facturasProveedor.filter((f) => f.concepto).map((f) => ({ concepto: f.concepto ?? "", valor: f.valor })),
  ];

  return {
    valorCif: tramite.valorCif,
    tipoCarga: tramite.tipoCarga,
    numContenedores: tramite.numContenedores,
    numDeclaraciones: tramite.numDeclaraciones,
    numDocumentos: tramite.numDocumentos,
    numItems: tramite.numItems,
    eventos: tramite.eventos.map((e) => ({ codigo: e.eventoCodigo, cantidad: e.cantidad })),
    costos,
  };
}

/**
 * Líneas que el tarifario vigente de la empresa propone para el trámite. Es
 * lo que ve el revisor antes de generar el borrador y lo que `generarBorrador`
 * usa como desglose de la comisión cuando la empresa tiene tarifario propio.
 */
export async function propuestaParaTramite(tramiteId: string, fecha: Date = new Date()): Promise<PropuestaTarifa> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      clienteId: true,
      cliente: { select: { nombre: true } },
      tipoTramite: { select: { lineaServicio: true } },
    },
  });
  if (!tramite) throw new TarifarioNoEncontradoError(tramiteId);

  const contexto = await contextoDeTramite(tramiteId);
  const capacidades = await capacidadesDeEmpresa(tramite.clienteId);
  if (!tiene(capacidades, "tarifario_propio")) {
    return { tarifario: null, motivo: `${tramite.cliente.nombre} no tiene habilitado el tarifario propio`, resultado: null, contexto };
  }

  const alcance = tramite.tipoTramite.lineaServicio;
  const vigente = await tarifarioVigenteDe(tramite.clienteId, alcance, fecha);
  if (!vigente) {
    return {
      tarifario: null,
      motivo: `${tramite.cliente.nombre} no tiene un tarifario vigente para ${alcance.toLowerCase()} en esta fecha`,
      resultado: null,
      contexto,
    };
  }

  const resultado = calcularLineasTarifa(vigente.items.map(itemCalculableDe), contexto);

  return {
    tarifario: {
      id: vigente.id,
      nombre: vigente.nombre,
      version: vigente.version,
      alcance: vigente.alcance,
      vigenteDesde: vigente.vigenteDesde,
      vigenteHasta: vigente.vigenteHasta,
    },
    motivo: null,
    resultado,
    contexto,
  };
}

// Reexport para los consumidores que solo necesitan los enums.
export { DisparadorTarifa, TipoCalculoTarifa };
export type { Tarifario, TarifaItem };
