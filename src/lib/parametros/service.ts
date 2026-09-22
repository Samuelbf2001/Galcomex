/**
 * Servicio de parámetros del sistema — Galcomex
 * Lee la tabla Parametro y convierte los valores string a BigInt escalados
 * que espera el motor de cálculo.
 *
 * Conversiones (deuda conocida resuelta aquí):
 *   IVA_COMISION   "0.19"   → tasaIva        = 19n   (porcentaje entero)
 *   TASA_4X1000    "0.004"  → tasa4x1000     = 400n  (escalado /100_000)
 *   COMISION_LM    "150000" → comisionDefault = 150_000n (COP BigInt)
 *   DIAS_SLA_FACTURA "3"    → diasSla        = 3     (number)
 */

import { prisma } from "@/lib/db/prisma";
import { CLAVE_APROBADORES_PSE, parsearAprobadores } from "@/lib/whatsapp/aprobadores";

export type ParametrosSistema = {
  tasaIva: bigint;        // 19n para 19%
  tasa4x1000: bigint;     // 400n = 0.4% (escalado /100_000)
  comisionDefault: bigint; // 150_000n COP
  diasSla: number;        // 3 días
};

/**
 * Lee los parámetros del sistema desde la BD y los convierte a las unidades
 * que espera calcularBorrador().
 *
 * Lanza si faltan claves obligatorias en la tabla Parametro.
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

  // IVA_COMISION "0.19" → 19n
  const tasaIva = BigInt(Math.round(parseFloat(map.get("IVA_COMISION")!) * 100));

  // TASA_4X1000 "0.004" → 400n (= 0.4% expresado como entero /100_000)
  const tasa4x1000 = BigInt(Math.round(parseFloat(map.get("TASA_4X1000")!) * 100_000));

  // COMISION_LM "150000" → 150_000n
  const comisionDefault = BigInt(map.get("COMISION_LM")!);

  // DIAS_SLA_FACTURA "3" → 3
  const diasSla = parseInt(map.get("DIAS_SLA_FACTURA")!, 10);

  return { tasaIva, tasa4x1000, comisionDefault, diasSla };
}

// ─── Edición de parámetros genéricos (ADMIN) ─────────────────────────────────
//
// Los parámetros SIIGO_* (integración con Siigo) tienen su propio flujo de
// edición en /api/configuracion/siigo/parametros + siigo-parametros.tsx.
// Este servicio es para el resto de los Parametro del sistema (los que se
// listan en la tabla genérica de la página de Configuración).

const PREFIJOS_PROTEGIDOS = ["SIIGO_"];

function esClaveProtegida(clave: string): boolean {
  return PREFIJOS_PROTEGIDOS.some((prefijo) => clave.startsWith(prefijo));
}

export class ParametroNoEncontradoError extends Error {
  public readonly status = 404;
  constructor(clave: string) {
    super(`Parámetro '${clave}' no encontrado`);
    this.name = "ParametroNoEncontradoError";
  }
}

/** El valor no cumple el formato de su clave (hoy: WHATSAPP_APROBADORES_PSE). */
export class ParametroValorInvalidoError extends Error {
  public readonly status = 422;
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ParametroValorInvalidoError";
  }
}

/** Validadores por clave. Un parámetro sin validador acepta cualquier texto no vacío. */
function validarValorParametro(clave: string, valor: string): void {
  if (clave === CLAVE_APROBADORES_PSE) {
    const resultado = parsearAprobadores(valor);
    if (!resultado.ok) throw new ParametroValorInvalidoError(resultado.error);
  }
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
 * Rechaza claves SIIGO_* (protegidas, ver arriba) y claves inexistentes.
 */
export async function actualizarParametro(
  clave: string,
  valor: string,
  usuarioId: string,
) {
  if (esClaveProtegida(clave)) {
    throw new ParametroSiigoProtegidoError(clave);
  }
  validarValorParametro(clave, valor);

  return prisma.$transaction(async (tx) => {
    const actual = await tx.parametro.findUnique({ where: { clave } });
    if (!actual) {
      throw new ParametroNoEncontradoError(clave);
    }

    const actualizado = await tx.parametro.update({
      where: { clave },
      data: { valor },
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
