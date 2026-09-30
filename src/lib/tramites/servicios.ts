/**
 * Servicio dentro del trámite normal — FUNCIONES PURAS, SIN BD.
 *
 * Decisión de Ernesto (30-sep-2026): la nacionalización, el traslado y la DUTA
 * son trámites de importación con un SERVICIO escogido (no «Otros»), y la
 * tarifa se busca por servicio también en la línea de trámites. El catálogo
 * vive en la tabla `servicio_tramite` (lo siembran la migración y el seed):
 *
 *   IMPORTACION: Importación (tarifa general, sin concepto) · Traslado de zona
 *                franca (TRASLADO_ZF) · Nacionalización desde zona franca
 *                (NACIONALIZACION_ZF, sin BL) · DUTA (DUTA)
 *   EXPORTACION: Exportación (EXPORTACION, tarifa general)
 *
 * Un tipo CON catálogo solo acepta sus servicios. Un tipo SIN catálogo se
 * comporta como antes: el de flujo corto (OTRO) acepta cualquier concepto de
 * venta que no esté reservado por un catálogo (B2); los demás (CLASIFICACION)
 * no llevan servicio. Sin ramas por código de tipo (invariante 7): todo sale
 * del catálogo y de la bandera `flujoCorto`. El servicio NUNCA cambia el
 * número del DO (ver `lib/tramites/consecutivo.ts`).
 *
 * Detalle: DISENO-NUMERACION.md §2.2.
 */

import type { CategoriaDocumento } from "@prisma/client";

export interface ServicioCatalogo {
  id: string;
  tipoTramiteCodigo: string;
  /** null solo en el servicio «tarifa general» de IMPORTACION. */
  conceptoCodigo: string | null;
  nombre: string;
  /** Se cobra con la tarifa de la línea SIN servicio (la de siempre). */
  tarifaGeneral: boolean;
  documentosNoAplican: readonly CategoriaDocumento[];
  orden: number;
  activo?: boolean;
}

export interface TipoParaServicio {
  codigo: string;
  nombre: string;
  lineaServicio: string;
  flujoCorto: boolean;
}

/** Nombres legibles de los tipos para los mensajes (la llave es el código). */
function nombreTipo(tipo: TipoParaServicio): string {
  return tipo.nombre;
}

/** El concepto no es uno de los servicios del tipo (422). */
export class ServicioNoPermitidoError extends Error {
  public readonly status = 422;
  public readonly codigo = "SERVICIO_NO_PERMITIDO" as const;
  constructor(tipo: TipoParaServicio, servicios: readonly ServicioCatalogo[]) {
    const nombres = servicios.map((s) => nombreCorto(s));
    const lista =
      nombres.length <= 1 ? nombres.join("") : `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
    super(`Los servicios de ${nombreTipo(tipo)} son: ${lista}.`);
    this.name = "ServicioNoPermitidoError";
  }
}

/**
 * El concepto está en el catálogo de OTRO tipo: se crea en ese tipo, no como
 * «Otros» (así nadie gasta un número OTR26 en una nacionalización).
 */
export class ServicioReservadoError extends Error {
  public readonly status = 422;
  public readonly codigo = "SERVICIO_RESERVADO" as const;
  constructor(servicio: ServicioCatalogo, tipoDueno: TipoParaServicio, tipoPedido: TipoParaServicio) {
    super(
      `«${nombreCorto(servicio)}» se crea como ${tipoDueno.nombre} con ese servicio, no como ${tipoPedido.nombre}.`,
    );
    this.name = "ServicioReservadoError";
  }
}

/**
 * Un tipo sin catálogo y sin flujo corto (CLASIFICACION) no lleva servicio.
 * Mismo texto que `ServicioFlujoCortoNoPermitidoError` de siempre.
 */
export class ServicioFlujoCortoNoPermitidoError extends Error {
  public readonly status = 422;
  constructor(nombreTipoTramite: string) {
    super(
      `Los trámites de tipo "${nombreTipoTramite}" no llevan servicio ni valor escritos a mano: eso es solo para servicios sueltos (Otros servicios).`,
    );
    this.name = "ServicioFlujoCortoNoPermitidoError";
  }
}

/** «Importación (tarifa general de la empresa)» → «Importación». */
export function nombreCorto(servicio: Pick<ServicioCatalogo, "nombre">): string {
  return servicio.nombre.replace(/\s*\(.*\)\s*$/, "").trim() || servicio.nombre;
}

/** Servicios activos de un tipo, en orden. Vacío = el tipo no tiene catálogo. */
export function serviciosDeTipo(
  catalogo: readonly ServicioCatalogo[],
  tipoCodigo: string,
): ServicioCatalogo[] {
  return catalogo
    .filter((s) => s.tipoTramiteCodigo === tipoCodigo && s.activo !== false)
    .sort((a, b) => a.orden - b.orden);
}

/**
 * Conceptos reservados: los de cualquier catálogo, con el servicio y el tipo
 * dueño. Un tipo sin catálogo no los puede usar.
 */
export function conceptosReservados(catalogo: readonly ServicioCatalogo[]): Map<string, ServicioCatalogo> {
  const reservados = new Map<string, ServicioCatalogo>();
  for (const s of catalogo) {
    if (s.activo === false || !s.conceptoCodigo) continue;
    if (!reservados.has(s.conceptoCodigo)) reservados.set(s.conceptoCodigo, s);
  }
  return reservados;
}

export interface ServicioResuelto {
  /** Lo que se guarda en `TramiteDO.conceptoServicioCodigo`. */
  conceptoGuardado: string | null;
  /**
   * Clave con la que se busca la tarifa: `null` = la tarifa SIN servicio (la
   * general de la línea); un código = solo la tarifa de ese servicio.
   */
  claveTarifa: string | null;
  /**
   * Flujo corto sin catálogo y sin servicio (un «Otros» recién abierto): no hay
   * con qué buscar la tarifa hasta escoger el servicio (B2, «Escoge el servicio»).
   */
  faltaServicio: boolean;
  /** Servicio del catálogo; `null` en un tipo sin catálogo. */
  servicio: ServicioCatalogo | null;
  /** Nombre del servicio para mensajes; `null` si no hay servicio. */
  nombre: string | null;
  /** Documentos de D2 y del checklist que no aplican a este servicio. */
  documentosNoAplican: CategoriaDocumento[];
}

/**
 * Servicio efectivo de un DO (tabla §2.2.2 del diseño): qué guardar, con qué
 * clave buscar la tarifa y qué documentos no aplican.
 *
 * @param tipo       tipo del DO.
 * @param catalogo   catálogo COMPLETO (todos los tipos): se necesita para saber
 *                   qué conceptos están reservados.
 * @param concepto   concepto que trae el DO (vacío = el servicio por defecto).
 * @param tipos      tipos conocidos (para nombrar al dueño de un reservado).
 */
export function resolverServicio(
  tipo: TipoParaServicio,
  catalogo: readonly ServicioCatalogo[],
  concepto: string | null | undefined,
  tipos: readonly TipoParaServicio[] = [],
): ServicioResuelto {
  const codigo = concepto?.trim() || null;
  const propios = serviciosDeTipo(catalogo, tipo.codigo);

  if (propios.length > 0) {
    const servicio = codigo
      ? propios.find((s) => s.conceptoCodigo === codigo)
      : (propios.find((s) => s.tarifaGeneral) ?? propios.find((s) => s.conceptoCodigo === null));
    if (!servicio) throw new ServicioNoPermitidoError(tipo, propios);
    return {
      conceptoGuardado: servicio.conceptoCodigo,
      claveTarifa: servicio.tarifaGeneral ? null : servicio.conceptoCodigo,
      faltaServicio: false,
      servicio,
      nombre: servicio.nombre,
      documentosNoAplican: [...servicio.documentosNoAplican],
    };
  }

  if (!tipo.flujoCorto) {
    if (codigo) throw new ServicioFlujoCortoNoPermitidoError(tipo.nombre);
    return {
      conceptoGuardado: null,
      claveTarifa: null,
      faltaServicio: false,
      servicio: null,
      nombre: null,
      documentosNoAplican: [],
    };
  }

  // Flujo corto sin catálogo (OTRO, B2): cualquier concepto no reservado.
  if (codigo) {
    const reservado = conceptosReservados(catalogo).get(codigo);
    if (reservado) {
      const dueno = tipos.find((t) => t.codigo === reservado.tipoTramiteCodigo) ?? {
        codigo: reservado.tipoTramiteCodigo,
        nombre: reservado.tipoTramiteCodigo,
        lineaServicio: "",
        flujoCorto: false,
      };
      throw new ServicioReservadoError(reservado, dueno, tipo);
    }
  }
  return {
    conceptoGuardado: codigo,
    claveTarifa: codigo,
    faltaServicio: codigo === null,
    servicio: null,
    nombre: null,
    documentosNoAplican: [],
  };
}

/**
 * Servicio de un DO que YA existe (propuesta del tarifario, transiciones,
 * facturación). Igual que `resolverServicio`, pero nunca lanza: un DO viejo con
 * un concepto que hoy no se permitiría (p. ej. un «Otros» anterior al 30-sep
 * con un servicio ahora reservado) sigue buscando SU tarifa por ese concepto,
 * como en B2 — nunca cae a la tarifa general en silencio.
 */
export function resolverServicioGuardado(
  tipo: TipoParaServicio,
  catalogo: readonly ServicioCatalogo[],
  concepto: string | null | undefined,
  tipos: readonly TipoParaServicio[] = [],
): ServicioResuelto {
  try {
    return resolverServicio(tipo, catalogo, concepto, tipos);
  } catch {
    const codigo = concepto?.trim() || null;
    return {
      conceptoGuardado: codigo,
      claveTarifa: codigo,
      faltaServicio: codigo === null && tipo.flujoCorto,
      servicio: null,
      nombre: codigo,
      documentosNoAplican: [],
    };
  }
}

/**
 * Qué servicio puede declarar una tarifa de este alcance (generaliza la regla
 * de B2, §2.2.3):
 *   - OBLIGATORIO: alcance de un tipo de flujo corto SIN catálogo («Otros»):
 *     cualquier concepto activo no reservado.
 *   - OPCIONAL: alcance de un tipo con catálogo que tiene servicios que NO son
 *     «tarifa general» (TRAMITE): vacío = tarifa general, o uno de esos.
 *   - NINGUNO: el resto (EXPORTACION: solo tarifa general; CLASIFICACION,
 *     PLAN_VALLEJO, alcances sin tipo).
 */
export type ReglaServicioAlcance =
  | { modo: "OBLIGATORIO"; reservados: string[] }
  | { modo: "OPCIONAL"; permitidos: ServicioCatalogo[] }
  | { modo: "NINGUNO" };

export function reglaServicioDeAlcance(
  alcance: string,
  tipos: readonly TipoParaServicio[],
  catalogo: readonly ServicioCatalogo[],
): ReglaServicioAlcance {
  const tiposDeAlcance = tipos.filter((t) => t.lineaServicio === alcance);
  const conCatalogo = tiposDeAlcance.filter((t) => serviciosDeTipo(catalogo, t.codigo).length > 0);

  const especificos = conCatalogo
    .flatMap((t) => serviciosDeTipo(catalogo, t.codigo))
    .filter((s) => !s.tarifaGeneral && s.conceptoCodigo !== null);
  if (especificos.length > 0) {
    return { modo: "OPCIONAL", permitidos: especificos };
  }

  if (conCatalogo.length === 0 && tiposDeAlcance.some((t) => t.flujoCorto)) {
    return { modo: "OBLIGATORIO", reservados: [...conceptosReservados(catalogo).keys()] };
  }

  return { modo: "NINGUNO" };
}

/**
 * Conceptos que el editor del flujo corto (ficha del DO) puede ofrecer
 * (revisión adversarial, 30-sep-2026): en un tipo CON catálogo (Exportación)
 * solo los de su catálogo; sin catálogo («Otros»), todos. El servidor aplica la
 * misma regla (`resolverServicio`); esto solo evita ofrecer lo que va a
 * rechazar con 422.
 */
export function conceptosDelEditorFlujoCorto<T extends { codigo: string }>(
  conceptos: readonly T[],
  serviciosTipo: readonly { conceptoCodigo: string | null }[],
): T[] {
  const propios = new Set(serviciosTipo.map((s) => s.conceptoCodigo).filter((c): c is string => Boolean(c)));
  return propios.size > 0 ? conceptos.filter((c) => propios.has(c.codigo)) : [...conceptos];
}

/** Problemas del catálogo (vacío = bien): máximo un «tarifa general» por tipo, concepto vacío solo en él, sin conceptos repetidos. */
export function validarCatalogoServicios(catalogo: readonly ServicioCatalogo[]): string[] {
  const errores: string[] = [];
  const porTipo = new Map<string, ServicioCatalogo[]>();
  for (const s of catalogo) {
    if (s.activo === false) continue;
    porTipo.set(s.tipoTramiteCodigo, [...(porTipo.get(s.tipoTramiteCodigo) ?? []), s]);
  }
  for (const [tipo, servicios] of porTipo) {
    if (servicios.filter((s) => s.tarifaGeneral).length > 1) {
      errores.push(`${tipo}: más de un servicio de tarifa general.`);
    }
    for (const s of servicios) {
      if (s.conceptoCodigo === null && !s.tarifaGeneral) {
        errores.push(`${tipo}: el servicio ${s.id} no tiene concepto y no es el de tarifa general.`);
      }
    }
  }
  const vistos = new Map<string, string>();
  for (const s of catalogo) {
    if (s.activo === false || !s.conceptoCodigo) continue;
    const previo = vistos.get(s.conceptoCodigo);
    if (previo) errores.push(`El concepto ${s.conceptoCodigo} está en dos servicios (${previo} y ${s.id}).`);
    else vistos.set(s.conceptoCodigo, s.id);
  }
  return errores;
}
