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
  Ciudad,
  DisparadorTarifa,
  EstadoTarifario,
  Prisma,
  TipoCalculoTarifa,
  type TarifaItem,
  type Tarifario,
} from "@prisma/client";

import { cargarPagosParaCobro } from "@/lib/borradores/pagos-para-cobro";
import { desglosarPago } from "@/lib/calculations/pagos-cobrables";
import { capacidadesDeEmpresa } from "@/lib/capacidades/service";
import { tiene } from "@/lib/capacidades/resolver";
import { prisma } from "@/lib/db/prisma";
import { fechaCalendarioBogota } from "@/lib/tiempo/bogota";
import { plantillaPorCodigo } from "@/lib/tarifas/plantillas";
import { agenciamientoEstandarDe } from "@/lib/tarifas/agenciamiento";
import {
  calcularLineasTarifa,
  vigenteEn,
  type ContextoTarifa,
  type ItemTarifaCalculable,
  type MinimosTarifa,
  type ResultadoTarifa,
  type TramoTarifa,
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

/** B1 — la agencia se resta una sola vez por DO: no se puede agregar/editar un segundo ítem que la reste. */
export class TarifaRestaDuplicadaError extends Error {
  public readonly status = 422;
  constructor(nombrePublicoOtro: string) {
    super(`Este tarifario ya resta el agenciamiento en «${nombrePublicoOtro}»`);
    this.name = "TarifaRestaDuplicadaError";
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

/** B3 — R2: publicar un tarifario de ciudad no puede dejar dos VIGENTE con una ciudad en común. */
export class TarifarioCiudadEnUsoError extends Error {
  public readonly status = 422;
  constructor(ciudad: Ciudad, nombreOtro: string) {
    super(
      `${etiquetaCiudad(ciudad)} ya está en «${nombreOtro}» vigente: véncelo o publícalo con las mismas ciudades`,
    );
    this.name = "TarifarioCiudadEnUsoError";
  }
}

/** B3 — nombres para mensajes (la UI usa chips con el código; los mensajes de texto usan el nombre). */
const ETIQUETA_CIUDAD: Record<string, string> = {
  BAQ: "Barranquilla",
  CTG: "Cartagena",
  BUN: "Buenaventura",
  SMR: "Santa Marta",
  BGT: "Bogotá",
};

export function etiquetaCiudad(ciudad: Ciudad): string {
  return ETIQUETA_CIUDAD[ciudad] ?? ciudad;
}

/**
 * B1 (22-sep): un ítem MANUAL (alta o edición directa desde la ficha, no una
 * plantilla) solo puede usar un concepto ACTIVO del maestro `concepto_venta`.
 */
export class ConceptoNoEnCatalogoError extends Error {
  public readonly status = 422;
  constructor(codigo: string) {
    super(
      `El concepto "${codigo}" no existe en el catálogo de conceptos de venta o está inactivo. Elígelo del catálogo (Configuración → Catálogos).`,
    );
    this.name = "ConceptoNoEnCatalogoError";
  }
}

/**
 * La empresa tiene tarifario vigente pero al trámite le faltan datos de la
 * base de cálculo (CIF, contenedores, declaraciones…). Antes que facturar de
 * menos, se pide completar el trámite. Vive aquí (no en `borradores/service.ts`
 * ni en `tramites/flujo-corto.ts`) porque ambos la usan y así no hay
 * importación circular entre esos dos módulos.
 */
export type PendienteTarifa = { concepto: string; nombrePublico: string; motivo: string; causa?: string };

export class TarifaIncompletaError extends Error {
  public readonly status = 422;
  public readonly pendientes: PendienteTarifa[];
  constructor(pendientes: PendienteTarifa[]) {
    super(
      `El tarifario no se puede aplicar completo: ${pendientes
        .map((p) => `${p.nombrePublico} (${p.motivo.toLowerCase()})`)
        .join("; ")}. Completa lo que falta (base de cálculo del DO, pago o factura del proveedor, o el tarifario) o pasa la comisión a mano.`,
    );
    this.name = "TarifaIncompletaError";
    this.pendientes = pendientes;
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

function tramosDe(json: Prisma.JsonValue | null): TramoTarifa[] | null {
  if (!Array.isArray(json)) return null;
  const out: TramoTarifa[] = [];
  for (const t of json) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const { hasta, valor } = t as Record<string, unknown>;
    if (typeof valor !== "string" || !/^\d+$/.test(valor)) continue;
    if (hasta === null || (typeof hasta === "number" && Number.isInteger(hasta) && hasta >= 1)) {
      out.push({ hasta: hasta as number | null, valor });
    }
  }
  return out.length ? out : null;
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
    nitProveedorCosto: item.nitProveedorCosto,
    productoCosto: item.productoCosto,
    tramos: tramosDe(item.tramos),
    aplicaIva: item.aplicaIva,
    orden: item.orden,
    restaAgenciamiento: item.restaAgenciamiento,
    minimoEsDelTotal: item.minimoEsDelTotal,
  };
}

/**
 * Ids del maestro de conceptos (`concepto_venta`) por código. El enlace es
 * automático: si existe un concepto con el mismo `codigo` que el `concepto` del
 * ítem, el ítem queda apuntando a él. Si no existe, `conceptoId` queda null y
 * todo sigue funcionando por `concepto` + `siigoCodigo` (ver docs/CATALOGOS.md).
 */
async function idsConceptoPorCodigo(codigos: readonly string[]): Promise<Map<string, string>> {
  const unicos = [...new Set(codigos.filter((c) => c.length > 0))];
  if (unicos.length === 0) return new Map();
  const filas = await prisma.conceptoVenta.findMany({
    where: { codigo: { in: unicos } },
    select: { id: true, codigo: true },
  });
  return new Map(filas.map((f) => [f.codigo, f.id]));
}

/**
 * Concepto ACTIVO del maestro por código, para el alta/edición MANUAL de un
 * ítem (B1). A diferencia de `idsConceptoPorCodigo` (enlace automático y
 * silencioso que usan las plantillas y la duplicación), aquí un código que no
 * exista o esté inactivo es un error: el `siigoCodigo` del ítem lo pone el
 * catálogo, nunca quien llena el formulario.
 */
async function conceptoVentaActivoDe(codigo: string): Promise<{ id: string; siigoCodigo: string | null }> {
  const concepto = await prisma.conceptoVenta.findUnique({
    where: { codigo },
    select: { id: true, activo: true, siigoProducto: { select: { codigo: true } } },
  });
  if (!concepto || !concepto.activo) throw new ConceptoNoEnCatalogoError(codigo);
  return { id: concepto.id, siigoCodigo: concepto.siigoProducto?.codigo ?? null };
}

function itemCreateData(
  item: TarifaItemPayload,
  conceptoId?: string | null,
): Prisma.TarifaItemCreateWithoutTarifarioInput {
  return {
    orden: item.orden,
    concepto: item.concepto,
    ...(conceptoId ? { conceptoVenta: { connect: { id: conceptoId } } } : {}),
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
    nitProveedorCosto: item.nitProveedorCosto ?? null,
    productoCosto: item.productoCosto ?? null,
    tramos: item.tramos ? normalizeSerializable(item.tramos) : undefined,
    aplicaIva: item.aplicaIva,
    notas: item.notas ?? null,
    restaAgenciamiento: item.restaAgenciamiento,
    minimoEsDelTotal: item.minimoEsDelTotal,
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
 *
 * B3 (R1) — `ciudad` opcional:
 *   - Sin `ciudad` (`undefined`): comportamiento de hoy, cualquier VIGENTE en
 *     fecha (llamadas viejas, requisitos sin ciudad).
 *   - Con `ciudad`: si hay tarifarios VIGENTE cuyas `ciudades` la incluyen Y
 *     cuyo `vigenteDesde` ya llegó (M2, revisión de código 28-sep-2026: uno
 *     con `vigenteDesde` futuro todavía NO especializa la ciudad — publicarlo
 *     por adelantado no debe dejar la ciudad sin tarifa hoy), la ciudad está
 *     ESPECIALIZADA — se usa el de mayor versión en fecha, o `null` si
 *     ninguno lo está (un vencido por fecha SÍ sigue bloqueando). Nunca cae
 *     al general en silencio (usa `motivoSinTarifarioVigente` para explicar
 *     por qué). Sin tarifario propio ya iniciado de esa ciudad, usa el
 *     general (`ciudades` vacío).
 */
export async function tarifarioVigenteDe(
  empresaId: string,
  alcance: string,
  // F5: "hoy" es el día calendario en Bogotá, no el instante UTC — si no, una
  // tarifa deja de contar 5 horas antes de medianoche en Bogotá (19:00) el
  // último día de vigencia. Ver `lib/tiempo/bogota.ts`.
  fecha: Date = fechaCalendarioBogota(),
  ciudad?: Ciudad | null,
): Promise<TarifarioConItems | null> {
  const vigentes = await prisma.tarifario.findMany({
    where: { empresaId, alcance, estado: EstadoTarifario.VIGENTE },
    include: tarifarioInclude,
    orderBy: { version: "desc" },
  });

  if (!ciudad) {
    return vigentes.find((t) => vigenteEn(t, fecha)) ?? null;
  }

  const especializados = vigentes.filter((t) => t.ciudades.includes(ciudad) && yaIniciado(t, fecha));
  if (especializados.length > 0) {
    return especializados.find((t) => vigenteEn(t, fecha)) ?? null;
  }
  return vigentes.filter((t) => t.ciudades.length === 0).find((t) => vigenteEn(t, fecha)) ?? null;
}

/** `vigenteDesde` ya llegó (día calendario, comparación inclusiva). */
function yaIniciado(tarifario: { vigenteDesde: Date }, fecha: Date): boolean {
  return fecha.getTime() >= tarifario.vigenteDesde.getTime();
}

/**
 * Por qué no hay tarifario vigente para esta ciudad (B3, R1): distingue "la
 * ciudad tiene tarifario propio ya iniciado pero está fuera de fecha" (nunca
 * cae al general en silencio) de "no hay ninguno" — un tarifario de ciudad
 * con `vigenteDesde` futuro no cuenta (M2): mientras no empiece, la ciudad
 * sigue usando el general sin avisos. Solo para armar el mensaje.
 */
export async function motivoSinTarifarioVigente(
  empresaId: string,
  alcance: string,
  ciudad?: Ciudad | null,
  fecha: Date = fechaCalendarioBogota(),
): Promise<{ ciudadFueraDeFecha: boolean }> {
  if (!ciudad) return { ciudadFueraDeFecha: false };
  const especializados = await prisma.tarifario.findMany({
    where: { empresaId, alcance, estado: EstadoTarifario.VIGENTE, ciudades: { has: ciudad } },
    select: { vigenteDesde: true },
  });
  return { ciudadFueraDeFecha: especializados.some((t) => yaIniciado(t, fecha)) };
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

  const conceptos = await idsConceptoPorCodigo(items.map((i) => i.concepto));

  return prisma.$transaction(async (tx) => {
    const version = await siguienteVersion(tx, input.empresaId, alcance);
    const creado = await tx.tarifario.create({
      data: {
        empresaId: input.empresaId,
        nombre,
        alcance,
        ciudades: input.ciudades ?? [],
        vigenteDesde: input.vigenteDesde,
        vigenteHasta: input.vigenteHasta,
        notas,
        version,
        creadoPorId: input.usuarioId,
        items: { create: items.map((it) => itemCreateData(it, conceptos.get(it.concepto))) },
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
  if (
    antes.estado !== EstadoTarifario.BORRADOR &&
    (payload.alcance || payload.vigenteDesde || payload.vigenteHasta || payload.ciudades !== undefined)
  ) {
    throw new TarifarioNoEditableError(antes.estado);
  }

  return prisma.$transaction(async (tx) => {
    const despues = await tx.tarifario.update({
      where: { id },
      data: {
        nombre: payload.nombre,
        alcance: payload.alcance,
        ciudades: payload.ciudades,
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
    const idsReemplazados: string[] = [];

    if (estado === "VIGENTE") {
      // R2 (B3): reemplaza solo los VIGENTE del mismo conjunto de ciudades. Si
      // otro VIGENTE comparte una ciudad con un conjunto DISTINTO, no se puede
      // publicar en silencio: hay que vencerlo o publicar con las mismas ciudades.
      const antesSet = new Set(antes.ciudades);
      const otrosVigentes = await tx.tarifario.findMany({
        where: { empresaId: antes.empresaId, alcance: antes.alcance, estado: EstadoTarifario.VIGENTE, id: { not: id } },
        select: { id: true, nombre: true, ciudades: true },
      });

      for (const otro of otrosVigentes) {
        const otroSet = new Set(otro.ciudades);
        const mismoConjunto = otroSet.size === antesSet.size && [...otroSet].every((c) => antesSet.has(c));
        if (mismoConjunto) {
          idsReemplazados.push(otro.id);
          continue;
        }
        const comun = otro.ciudades.find((c) => antesSet.has(c));
        if (comun) throw new TarifarioCiudadEnUsoError(comun, otro.nombre);
      }

      if (idsReemplazados.length > 0) {
        await tx.tarifario.updateMany({
          where: { id: { in: idsReemplazados } },
          data: { estado: EstadoTarifario.REEMPLAZADO },
        });
      }
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
        despues: { estado: despues.estado, ciudades: despues.ciudades, idsReemplazados },
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
 * Copia los ítems de un tarifario para crear otro (`duplicarTarifario` y
 * `crearTarifarioDesde`): todos los campos del ítem salvo los ids, con el
 * incremento porcentual opcional (IPC) ya aplicado a los valores en COP.
 * Sin incremento (`incrementoPct` undefined) es una copia exacta.
 */
function copiarItemsDeTarifario(
  items: TarifaItem[],
  incrementoPct: number | undefined,
  redondeoA: number,
): Prisma.TarifaItemCreateWithoutTarifarioInput[] {
  return items.map((it) => {
    const minimos = minimosDe(it.minimos);
    const minimosAjustados = minimos
      ? Object.fromEntries(
          Object.entries(minimos).map(([k, v]) => [
            k,
            aplicarIncremento(BigInt(v), incrementoPct, redondeoA).toString(),
          ]),
        )
      : null;
    const tramos = tramosDe(it.tramos);
    const tramosAjustados = tramos
      ? tramos.map((t) => ({
          hasta: t.hasta,
          valor: aplicarIncremento(BigInt(t.valor), incrementoPct, redondeoA).toString(),
        }))
      : null;
    return {
      orden: it.orden,
      concepto: it.concepto,
      nombrePublico: it.nombrePublico,
      siigoCodigo: it.siigoCodigo,
      tipoCalculo: it.tipoCalculo,
      disparador: it.disparador,
      unidad: it.unidad,
      valor: aplicarIncremento(it.valor, incrementoPct, redondeoA),
      valorAdicional:
        it.valorAdicional === null ? null : aplicarIncremento(it.valorAdicional, incrementoPct, redondeoA),
      porcentajeBps: it.porcentajeBps,
      minimos: minimosAjustados ? normalizeSerializable(minimosAjustados) : undefined,
      conceptoCosto: it.conceptoCosto,
      nitProveedorCosto: it.nitProveedorCosto,
      productoCosto: it.productoCosto,
      tramos: tramosAjustados ? normalizeSerializable(tramosAjustados) : undefined,
      aplicaIva: it.aplicaIva,
      notas: it.notas,
      restaAgenciamiento: it.restaAgenciamiento,
      minimoEsDelTotal: it.minimoEsDelTotal,
      ...(it.eventoCodigo ? { evento: { connect: { codigo: it.eventoCodigo } } } : {}),
    };
  });
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

  const items = copiarItemsDeTarifario(origen.items, payload.incrementoPct, payload.redondeoA);

  return prisma.$transaction(async (tx) => {
    const version = await siguienteVersion(tx, empresaId, origen.alcance);
    const creado = await tx.tarifario.create({
      data: {
        empresaId,
        nombre: payload.nombre ?? origen.nombre,
        alcance: origen.alcance,
        // B3 (R4): copia las ciudades del origen salvo que el payload las cambie
        // (así se hace "Duplicar para Bogotá").
        ciudades: payload.ciudades ?? origen.ciudades,
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

export interface CrearTarifarioDesdeInput {
  /** Tarifario existente (de cualquier empresa) del que se copian los ítems. */
  origenTarifarioId: string;
  empresaId: string;
  /** Si falta, se usa el nombre del tarifario de origen. */
  nombre?: string;
  /** Si falta, se usa el `alcance` del tarifario de ORIGEN (F7) — no "TRAMITE" a ciegas. */
  alcance?: string;
  /** B3 (R4) — si falta, se copian las ciudades del tarifario de ORIGEN. */
  ciudades?: Ciudad[];
  vigenteDesde: Date;
  vigenteHasta: Date;
  notas?: string | null;
}

/**
 * "Arrancar desde" con una tarifa de OTRA empresa (B2, 22-sep): BORRADOR
 * nuevo con la siguiente versión para (empresa, alcance), copiando todos los
 * ítems del tarifario de origen tal cual (sin incremento). Reusa el mismo
 * copiado de ítems que `duplicarTarifario`.
 */
export async function crearTarifarioDesde(
  input: CrearTarifarioDesdeInput,
  usuarioId: string,
): Promise<TarifarioConItems> {
  await exigirCapacidadTarifario(input.empresaId);
  const origen = await getTarifario(input.origenTarifarioId);

  const items = copiarItemsDeTarifario(origen.items, undefined, 1_000);
  const nombre = input.nombre ?? origen.nombre;
  // F7: sin `alcance` en el payload, se hereda el del tarifario de ORIGEN —
  // copiar una tarifa de CLASIFICACION no puede terminar por defecto en TRAMITE.
  const alcance = input.alcance ?? origen.alcance;
  const notas = input.notas ?? `Copiado de ${origen.empresa.nombre} · ${origen.nombre} v${origen.version}`;

  return prisma.$transaction(async (tx) => {
    const version = await siguienteVersion(tx, input.empresaId, alcance);
    const creado = await tx.tarifario.create({
      data: {
        empresaId: input.empresaId,
        nombre,
        alcance,
        // B3 (R4): sin ciudades en el payload, copia las del origen.
        ciudades: input.ciudades ?? origen.ciudades,
        vigenteDesde: input.vigenteDesde,
        vigenteHasta: input.vigenteHasta,
        notas,
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
        accion: "CREAR_TARIFARIO_DESDE",
        usuarioId,
        antes: { origenId: origen.id, origenEmpresa: origen.empresa.nombre, origenVersion: origen.version },
        despues: normalizeSerializable(creado),
      },
    });

    return creado;
  });
}

/**
 * Catálogo LIGERO de tarifarios de TODAS las empresas (id, empresa, nombre,
 * alcance, versión, estado, ciudades, cantidad de ítems — sin los ítems
 * completos). Alimenta "Copiar la tarifa de otra empresa" en Nuevo tarifario
 * (B2). `ciudades` (BAJO 5, revisión de código 28-sep-2026) — el diseño B3 lo
 * pedía; sin esto el modal no puede prellenar los chips al copiar (BAJO 4).
 */
export interface TarifarioLigero {
  id: string;
  empresaId: string;
  empresaNombre: string;
  nombre: string;
  alcance: string;
  version: number;
  estado: EstadoTarifario;
  ciudades: Ciudad[];
  items: number;
}

export async function listarTarifariosLigero(
  opciones: { excluirEmpresaId?: string } = {},
): Promise<TarifarioLigero[]> {
  const filas = await prisma.tarifario.findMany({
    where: opciones.excluirEmpresaId ? { empresaId: { not: opciones.excluirEmpresaId } } : undefined,
    select: {
      id: true,
      empresaId: true,
      nombre: true,
      alcance: true,
      version: true,
      estado: true,
      ciudades: true,
      empresa: { select: { nombre: true } },
      _count: { select: { items: true } },
    },
    orderBy: [{ empresa: { nombre: "asc" } }, { alcance: "asc" }, { version: "desc" }],
  });

  return filas.map((f) => ({
    id: f.id,
    empresaId: f.empresaId,
    empresaNombre: f.empresa.nombre,
    nombre: f.nombre,
    alcance: f.alcance,
    version: f.version,
    estado: f.estado,
    ciudades: f.ciudades,
    items: f._count.items,
  }));
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
  if (payload.restaAgenciamiento) {
    const otro = t.items.find((i) => i.restaAgenciamiento);
    if (otro) throw new TarifaRestaDuplicadaError(otro.nombrePublico);
  }

  // Alta MANUAL: el concepto tiene que existir y estar activo en el catálogo;
  // el siigoCodigo lo pone el catálogo, se ignora el que mande el cliente (B1).
  const concepto = await conceptoVentaActivoDe(payload.concepto);
  const payloadConSiigo: TarifaItemPayload = { ...payload, siigoCodigo: concepto.siigoCodigo };

  await prisma.$transaction(async (tx) => {
    const item = await tx.tarifaItem.create({
      data: {
        ...itemCreateData(payloadConSiigo, concepto.id),
        tarifario: { connect: { id: tarifarioId } },
      },
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
    tramos: tramosDe(antes.tramos),
    notas: antes.notas,
    ...payload,
  });

  if (fusionado.concepto !== antes.concepto && t.items.some((i) => i.concepto === fusionado.concepto)) {
    throw new TarifaItemDuplicadoError(fusionado.concepto);
  }
  if (fusionado.restaAgenciamiento) {
    const otro = t.items.find((i) => i.id !== itemId && i.restaAgenciamiento);
    if (otro) throw new TarifaRestaDuplicadaError(otro.nombrePublico);
  }

  // Edición MANUAL: solo cuando el formulario manda `concepto` se exige que
  // esté activo en el catálogo y se recalcula el siigoCodigo desde ahí (B1).
  // Un PATCH que no toca `concepto` (p. ej. solo `orden`) conserva el enlace
  // laxo de siempre, para no romper ítems viejos que aún no están en el maestro.
  let conceptoId: string | undefined;
  if (payload.concepto !== undefined) {
    const concepto = await conceptoVentaActivoDe(fusionado.concepto);
    conceptoId = concepto.id;
    fusionado.siigoCodigo = concepto.siigoCodigo;
  } else {
    const conceptos = await idsConceptoPorCodigo([fusionado.concepto]);
    conceptoId = conceptos.get(fusionado.concepto);
  }

  await prisma.$transaction(async (tx) => {
    const despues = await tx.tarifaItem.update({
      where: { id: itemId },
      data: {
        ...itemCreateData(fusionado, conceptoId),
        // `connect` no desconecta: si el evento se quitó, hay que hacerlo explícito.
        ...(fusionado.eventoCodigo ? {} : { evento: { disconnect: true } }),
        ...(conceptoId ? {} : { conceptoVenta: { disconnect: true } }),
        ...(fusionado.minimos ? {} : { minimos: Prisma.DbNull }),
        ...(fusionado.tramos ? {} : { tramos: Prisma.DbNull }),
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
  /**
   * La empresa tiene encendida la función `tarifario_propio`, haya o no un
   * tarifario vigente. Facturación lo usa para no proponer la comisión fija por
   * defecto a una empresa que se factura por tarifario.
   */
  tarifarioPropio: boolean;
  resultado: ResultadoTarifa | null;
  contexto: ContextoTramite;
}

/** Contexto del motor más la orden de compra del cliente (no entra al cálculo). */
export type ContextoTramite = ContextoTarifa & {
  ordenCompraNumero: string | null;
  ordenCompraValor: bigint | null;
};

/**
 * Contexto del motor de tarifas para un trámite. Los costos que un ítem
 * ESPEJO_DE_COSTO puede reflejar son SOLO lo que se le cobra al cliente
 * (igual que el borrador; ver `lib/calculations/pagos-cobrables.ts`):
 * - facturas de proveedor: solo las que se cobran (`repercutible`); una
 *   «NO SE COBRA» (asesoría) nunca se espeja;
 * - pagos del libro: solo su parte cobrable (`desglosarPago`, con los mismos
 *   montos del pago en bloque que usa `generarBorrador`). Un pago que es
 *   todo asesoría no aparece: ni siquiera con 0, que taparía a otro costo con
 *   el mismo concepto. Los pagos sueltos y los 100 % repercutibles van
 *   completos, como siempre.
 */
export async function contextoDeTramite(tramiteId: string): Promise<ContextoTramite> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      valorCif: true,
      tipoCarga: true,
      numContenedores: true,
      numDeclaraciones: true,
      numDocumentos: true,
      numItems: true,
      ordenCompraNumero: true,
      ordenCompraValor: true,
      agenciaAduanas: true,
      eventos: { select: { eventoCodigo: true, cantidad: true } },
      facturasProveedor: {
        where: { repercutible: true },
        select: {
          concepto: true,
          valor: true,
          numFactura: true,
          proveedorClave: true,
          siigoProducto: { select: { codigo: true } },
        },
        // B6: el espejo "por proveedor" cobra una línea por factura; el orden fija el de las líneas.
        orderBy: [{ fecha: "asc" }, { numFactura: "asc" }],
      },
    },
  });
  if (!tramite) throw new TarifarioNoEncontradoError(tramiteId);

  const pagos = await cargarPagosParaCobro(prisma, tramiteId);
  const costosDePagos = pagos.flatMap(({ pago, paraCobro }) => {
    if (!pago.concepto) return [];
    const { cobrable, noCobrable } = desglosarPago(paraCobro);
    if (cobrable.valor === 0n && noCobrable > 0n) return [];
    return [{ concepto: pago.concepto, valor: cobrable.valor }];
  });

  const costos = [
    ...costosDePagos,
    // B6: una factura sin concepto de texto también cuenta (el espejo "por proveedor" la
    // identifica por NIT/producto); el espejo por texto no puede tomarla (concepto vacío).
    ...tramite.facturasProveedor.map((f) => ({
      concepto: f.concepto ?? "",
      valor: f.valor,
      // Solo las facturas de proveedor traen proveedor/producto/número (los pagos del libro no).
      proveedorClave: f.proveedorClave,
      productoCodigo: f.siigoProducto?.codigo ?? null,
      referencia: f.numFactura,
    })),
  ];

  const agenciamiento = await agenciamientoEstandarDe(tramite.agenciaAduanas);

  return {
    valorCif: tramite.valorCif,
    tipoCarga: tramite.tipoCarga,
    numContenedores: tramite.numContenedores,
    numDeclaraciones: tramite.numDeclaraciones,
    numDocumentos: tramite.numDocumentos,
    numItems: tramite.numItems,
    eventos: tramite.eventos.map((e) => ({ codigo: e.eventoCodigo, cantidad: e.cantidad })),
    costos,
    // B1 — agencia de aduanas del DO y su agenciamiento estándar. La UI lo
    // muestra en el panel del DO y en el editor del ítem del tarifario.
    agenciamiento,
    // No entra al motor: viaja con el contexto para que el panel del DO y la
    // revisión de la factura vean la OC del cliente (Polyrec).
    ordenCompraNumero: tramite.ordenCompraNumero,
    ordenCompraValor: tramite.ordenCompraValor,
  };
}

/**
 * Líneas que el tarifario vigente de la empresa propone para el trámite. Es
 * lo que ve el revisor antes de generar el borrador y lo que `generarBorrador`
 * usa como desglose de la comisión cuando la empresa tiene tarifario propio.
 *
 * `fecha` es el DÍA calendario en Bogotá (hallazgo 2 del 24-sep): con
 * `new Date()` (instante UTC) este default anulaba el de `tarifarioVigenteDe`
 * y desde las 19:00 del último día de vigencia el modal no veía tarifario (y
 * `ensureBorrador` facturaba la comisión por defecto); un día antes del cambio
 * de versión ya usaba la nueva.
 */
export async function propuestaParaTramite(
  tramiteId: string,
  fecha: Date = fechaCalendarioBogota(),
): Promise<PropuestaTarifa> {
  const tramite = await prisma.tramiteDO.findUnique({
    where: { id: tramiteId },
    select: {
      clienteId: true,
      ciudad: true,
      cliente: { select: { nombre: true } },
      tipoTramite: { select: { lineaServicio: true } },
    },
  });
  if (!tramite) throw new TarifarioNoEncontradoError(tramiteId);

  const contexto = await contextoDeTramite(tramiteId);
  const capacidades = await capacidadesDeEmpresa(tramite.clienteId);
  if (!tiene(capacidades, "tarifario_propio")) {
    return {
      tarifario: null,
      motivo: `${tramite.cliente.nombre} no tiene habilitado el tarifario propio`,
      tarifarioPropio: false,
      resultado: null,
      contexto,
    };
  }

  const alcance = tramite.tipoTramite.lineaServicio;
  const vigente = await tarifarioVigenteDe(tramite.clienteId, alcance, fecha, tramite.ciudad);
  if (!vigente) {
    const { ciudadFueraDeFecha } = await motivoSinTarifarioVigente(tramite.clienteId, alcance, tramite.ciudad, fecha);
    return {
      tarifario: null,
      motivo: ciudadFueraDeFecha
        ? `El tarifario de ${etiquetaCiudad(tramite.ciudad!)} está fuera de fecha`
        : `${tramite.cliente.nombre} no tiene un tarifario vigente para ${alcance.toLowerCase()} en esta fecha`,
      tarifarioPropio: true,
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
    tarifarioPropio: true,
    resultado,
    contexto,
  };
}

// Reexport para los consumidores que solo necesitan los enums.
export { DisparadorTarifa, TipoCalculoTarifa };
export type { Tarifario, TarifaItem };
