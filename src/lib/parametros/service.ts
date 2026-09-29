/**
 * Servicio de parámetros del sistema — Galcomex
 * Lee la tabla Parametro y convierte los valores string a las unidades que
 * espera el motor de cálculo (fase centavos, diseño B.2).
 *
 * Conversiones (todas exactas, sin parseFloat):
 *   IVA_COMISION   "0.19"   → tasaIva         = 19n          (tasaDeTexto, escala 100; NO es dinero)
 *   TASA_4X1000    "0.004"  → tasa4x1000      = 400n         (tasaDeTexto, escala 100.000; NO es dinero)
 *   COMISION_LM    "150000" → comisionDefault = 15_000_000n  (CENTAVOS; el texto es PESOS)
 *   DIAS_SLA_FACTURA "3"    → diasSla         = 3            (number)
 *
 * `tasaIva` y `tasa4x1000` son `bigint` que NO son dinero (lista cerrada A.2):
 * nunca viajan a una respuesta, un JSON guardado ni un AuditLog.
 */

import { centavosDeTexto, tasaDeTexto, textoCanonicoDeCentavos, type Centavos } from "@/lib/dinero";
import { prisma } from "@/lib/db/prisma";
import { CLAVE_APROBADORES_PSE, parsearAprobadores } from "@/lib/whatsapp/aprobadores";

import {
  CLAVES_DINERO_NO_NEGATIVO,
  ESCALA_TASAS,
  esClaveDePrefijoProtegido,
  esClaveDinero,
  esClaveProtegidaDinero,
} from "./claves";

export { CLAVES_PROTEGIDAS } from "./claves";

export type ParametrosSistema = {
  tasaIva: bigint; // 19n para 19% (tasa, no dinero)
  tasa4x1000: bigint; // 400n = 0.4% (escalado /100_000; tasa, no dinero)
  comisionDefault: Centavos; // 15_000_000n = $150.000 (centavos)
  diasSla: number; // 3 días
};

/**
 * Lee los parámetros del sistema desde la BD y los convierte a las unidades
 * que espera calcularBorrador().
 *
 * Lanza si faltan claves obligatorias en la tabla Parametro o si una tasa o
 * la comisión no se pueden leer exactas.
 */
export async function getParametrosSistema(): Promise<ParametrosSistema> {
  const claves = ["IVA_COMISION", "TASA_4X1000", "COMISION_LM", "DIAS_SLA_FACTURA"] as const;

  const rows = await prisma.parametro.findMany({
    where: { clave: { in: [...claves] } },
    select: { clave: true, valor: true },
  });

  const map = new Map<string, string>(rows.map((r) => [r.clave, r.valor]));

  for (const clave of claves) {
    if (!map.has(clave)) {
      throw new Error(`Parámetro obligatorio '${clave}' no encontrado en la tabla Parametro`);
    }
  }

  return convertirParametrosSistema({
    IVA_COMISION: map.get("IVA_COMISION")!,
    TASA_4X1000: map.get("TASA_4X1000")!,
    COMISION_LM: map.get("COMISION_LM")!,
    DIAS_SLA_FACTURA: map.get("DIAS_SLA_FACTURA")!,
  });
}

/** Conversión pura de los textos de `Parametro` (exportada para pruebas sin BD). */
export function convertirParametrosSistema(v: {
  IVA_COMISION: string;
  TASA_4X1000: string;
  COMISION_LM: string;
  DIAS_SLA_FACTURA: string;
}): ParametrosSistema {
  // IVA_COMISION "0.19" → 19n (exacto; lanza si no cabe en la escala)
  const tasaIva = tasaDeTexto(v.IVA_COMISION, ESCALA_TASAS.IVA_COMISION);

  // TASA_4X1000 "0.004" → 400n (= 0.4% expresado como entero /100_000)
  const tasa4x1000 = tasaDeTexto(v.TASA_4X1000, ESCALA_TASAS.TASA_4X1000);

  // COMISION_LM "150000" (PESOS texto; tolera "150000.45" y "150000.00") → 15_000_000n centavos
  const comisionDefault = centavosDeTexto(v.COMISION_LM.trim());

  // DIAS_SLA_FACTURA "3" → 3
  const diasSla = parseInt(v.DIAS_SLA_FACTURA, 10);

  return { tasaIva, tasa4x1000, comisionDefault, diasSla };
}

// ─── Edición de parámetros genéricos (ADMIN) ─────────────────────────────────
//
// Los parámetros SIIGO_* (integración con Siigo) tienen su propio flujo de
// edición en /api/configuracion/siigo/parametros + siigo-parametros.tsx.
// `DINERO_UNIDAD_BD` (marca de la fase centavos) no se edita nunca por aquí.
// Este servicio es para el resto de los Parametro del sistema (los que se
// listan en la tabla genérica de la página de Configuración).

export class ParametroNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(clave: string) {
    super(`Parámetro '${clave}' no encontrado`);
    this.name = "ParametroNoEncontradoError";
  }
}

/** El valor no cumple el formato de su clave (aprobadores PSE, dinero, tasas). */
export class ParametroValorInvalidoError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ParametroValorInvalidoError";
  }
}

/** Clave que nadie edita por la API ni por el MCP (`DINERO_UNIDAD_BD`, diseño A.4). */
export class ParametroProtegidoError extends Error {
  public readonly status = 403;
  public readonly codigo = "PARAMETRO_PROTEGIDO" as const;
  constructor(clave: string) {
    super(
      `El parámetro '${clave}' es una marca del sistema y no se puede editar (solo lo cambian la migración de centavos y su reversa)`,
    );
    this.name = "ParametroProtegidoError";
  }
}

/**
 * Valida el valor según su clave y devuelve el texto que se GUARDA.
 * Un parámetro sin validador acepta cualquier texto no vacío (tal cual).
 *
 * - Dinero (`COMISION_LM`, `UMBRAL_*`): PESOS texto con punto decimal, máx. 2
 *   decimales, sin separador de miles (`centavosDeTexto`: rechaza "150.000",
 *   "1e5", "150000.455"); se guarda CANÓNICO ("150000", "150000.45"; nunca
 *   "150000.00") para que la imagen anterior lo siga leyendo tras una reversa.
 * - Tasas (`IVA_COMISION`, `TASA_4X1000`): decimal exacto en su escala
 *   (`tasaDeTexto`), para no romper `getParametrosSistema`.
 */
export function validarValorParametro(clave: string, valor: string): string {
  if (clave === CLAVE_APROBADORES_PSE) {
    const resultado = parsearAprobadores(valor);
    if (!resultado.ok) throw new ParametroValorInvalidoError(resultado.error);
    return valor;
  }
  if (esClaveDinero(clave)) {
    let centavos: Centavos;
    try {
      centavos = centavosDeTexto(valor.trim());
    } catch {
      throw new ParametroValorInvalidoError(
        `El valor de ${clave} debe ser pesos con punto decimal, máximo 2 decimales y sin separador de miles (ej. "150000" o "150000.50"); llegó "${valor}"`,
      );
    }
    if (CLAVES_DINERO_NO_NEGATIVO.includes(clave) && centavos < 0n) {
      throw new ParametroValorInvalidoError(`El valor de ${clave} no puede ser negativo`);
    }
    return textoCanonicoDeCentavos(centavos);
  }
  const escala = ESCALA_TASAS[clave];
  if (escala !== undefined) {
    try {
      tasaDeTexto(valor, escala);
    } catch {
      throw new ParametroValorInvalidoError(
        `El valor de ${clave} debe ser una tasa decimal con punto (ej. "0.19" o "0.004"); llegó "${valor}"`,
      );
    }
    return valor.trim();
  }
  return valor;
}

export class ParametroSiigoProtegidoError extends Error {
  public readonly status = 400;
  constructor(clave: string) {
    super(
      `El parámetro '${clave}' es de integración Siigo y se edita desde la sección "Configuración de envío Siigo"`,
    );
    this.name = "ParametroSiigoProtegidoError";
  }
}

/**
 * Actualiza el valor de un Parametro genérico del sistema (ADMIN).
 * Genera AuditLog en la MISMA transacción con el valor anterior y el nuevo.
 * Rechaza `CLAVES_PROTEGIDAS` (`DINERO_UNIDAD_BD`, 403), claves SIIGO_*
 * (protegidas, ver arriba) y claves inexistentes. Las claves de dinero se
 * guardan en forma canónica (ver `validarValorParametro`).
 */
export async function actualizarParametro(
  clave: string,
  valor: string,
  usuarioId: string,
) {
  if (esClaveProtegidaDinero(clave)) {
    throw new ParametroProtegidoError(clave);
  }
  if (esClaveDePrefijoProtegido(clave)) {
    throw new ParametroSiigoProtegidoError(clave);
  }
  const valorGuardado = validarValorParametro(clave, valor);

  return prisma.$transaction(async (tx) => {
    const actual = await tx.parametro.findUnique({ where: { clave } });
    if (!actual) {
      throw new ParametroNoEncontradoError(clave);
    }

    const actualizado = await tx.parametro.update({
      where: { clave },
      data: { valor: valorGuardado },
    });

    await tx.auditLog.create({
      data: {
        entidad: "Parametro",
        entidadId: actual.id,
        accion: "UPDATE",
        usuarioId,
        antes: { clave, valor: actual.valor },
        despues: { clave, valor: actualizado.valor },
      },
    });

    return actualizado;
  });
}
