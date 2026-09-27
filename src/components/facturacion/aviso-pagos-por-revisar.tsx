/**
 * Aviso para quien revisa el borrador: pagos de un trámite con asesoría
 * («NO SE COBRA») cuyo reparto con lo que se le cobra al cliente no es seguro.
 *
 * Los datos vienen en `pagosPorRevisar` de cada borrador en
 * GET /api/tramites/[id]/borrador y en el lote de facturación (solo ADMIN y
 * REVISOR; ver `lib/borradores/pagos-por-revisar.ts`). Cada pago trae su
 * `motivo` (`MOTIVOS_REVISION_PAGO`) y el texto depende de él: en
 * SOBRANTE_COBRADO y PAGO_SIN_FACTURAS la posible asesoría SÍ se le está
 * cobrando al cliente; en SOBRANTE_NO_COBRADO el sobrante lo asume Galcomex;
 * en ABONO_PARCIAL el error puede ir en los dos sentidos.
 *
 * PENDIENTE DE MONTAR (archivos de otra sesión, ver instrucciones de montaje):
 * `facturacion-api.ts` normaliza el campo con `normalizarPagosPorRevisar` y
 * `revisor-borrador.tsx` pinta `<AvisoPagosPorRevisar pagos={…} />` junto a
 * los demás avisos antes de aprobar, conservando la lista al recibir un
 * borrador actualizado (`conservarPagosPorRevisar`). Nunca va a
 * comentariosCabecera (viaja a SIIGO y la ve el cliente).
 */

import { AlertTriangle } from "lucide-react";

import { formatCOP } from "@/components/facturacion/facturacion-api";
import {
  MOTIVOS_REVISION_PAGO,
  type MotivoRevisionPago,
} from "@/lib/calculations/pagos-cobrables";

/** Pago por revisar tal como llega del API (BigInt serializado como texto). */
export type PagoPorRevisarRow = {
  pagoId: string;
  concepto: string;
  numSoporte: string | null;
  /** Valor del pago (COP). */
  valor: string;
  /** Σ de lo que abona a sus facturas (COP). */
  sumaFacturas: string;
  /** Parte que se le cobra al cliente en el borrador (COP). */
  cobrable: string;
  /** Parte que NO se le cobra al cliente (COP). */
  noCobrable: string;
  /** Por qué hay que revisarlo; `null` en borradores generados antes de guardarlo. */
  motivo: MotivoRevisionPago | null;
};

const ENTERO = /^-?\d+$/;

function texto(valor: unknown): string | null {
  if (typeof valor === "string" && ENTERO.test(valor)) return valor;
  if (typeof valor === "number" && Number.isSafeInteger(valor)) return String(valor);
  return null;
}

function aMotivo(valor: unknown): MotivoRevisionPago | null {
  return typeof valor === "string" && (MOTIVOS_REVISION_PAGO as readonly string[]).includes(valor)
    ? (valor as MotivoRevisionPago)
    : null;
}

/**
 * Normaliza `pagosPorRevisar` de un borrador de la respuesta del API.
 * - Lista → los pagos bien formados (lo mal formado se descarta; un motivo
 *   ausente o desconocido queda en `null`).
 * - Cualquier otra cosa (campo ausente: SOCIO, respuestas de PATCH/POST que no
 *   lo traen, o error al leerlo) → `null` = «esta respuesta no lo dice», que
 *   NO es lo mismo que `[]` («no hay pagos por revisar»).
 */
export function normalizarPagosPorRevisar(raw: unknown): PagoPorRevisarRow[] | null {
  if (!Array.isArray(raw)) return null;
  const lista: PagoPorRevisarRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const valor = texto(r.valor);
    const sumaFacturas = texto(r.sumaFacturas);
    const cobrable = texto(r.cobrable);
    const noCobrable = texto(r.noCobrable);
    if (
      typeof r.pagoId !== "string" ||
      valor === null ||
      sumaFacturas === null ||
      cobrable === null ||
      noCobrable === null
    ) {
      continue;
    }
    lista.push({
      pagoId: r.pagoId,
      concepto: typeof r.concepto === "string" ? r.concepto : "",
      numSoporte: typeof r.numSoporte === "string" ? r.numSoporte : null,
      valor,
      sumaFacturas,
      cobrable,
      noCobrable,
      motivo: aMotivo(r.motivo),
    });
  }
  return lista;
}

/**
 * Borrador actualizado que conserva la lista del anterior cuando la respuesta
 * nueva no la trae (`null`/ausente). Los pagos por revisar se calculan UNA vez
 * al generar el borrador y no cambian mientras exista, pero las respuestas de
 * PATCH/POST del borrador (estado, forma de pago, SIIGO, líneas) no los
 * incluyen: sin esto, el aviso desaparecería tras la primera acción.
 */
export function conservarPagosPorRevisar<
  T extends { id: string; pagosPorRevisar?: PagoPorRevisarRow[] | null },
>(nuevo: T, anterior: T | null | undefined): T {
  if (nuevo.pagosPorRevisar != null) return nuevo;
  if (!anterior || anterior.id !== nuevo.id || anterior.pagosPorRevisar == null) return nuevo;
  return { ...nuevo, pagosPorRevisar: anterior.pagosPorRevisar };
}

/**
 * Qué hacer si el pago (o parte de él) era asesoría. Un pago ya registrado no
 * se puede volver a enlazar a otras facturas: hay que eliminarlo y registrarlo
 * de nuevo con su factura.
 */
const REGISTRAR_DE_NUEVO_CON_ASESORIA =
  "Si era asesoría, pide a quien registra pagos que elimine este pago y lo registre de nuevo seleccionando su factura NO SE COBRA; después vuelve a generar el borrador.";

/**
 * Explicación en lenguaje de negocio de por qué hay que revisar el pago y qué
 * hacer, según su `motivo`. Sin motivo (borradores viejos) → texto neutro.
 */
export function explicacionPagoPorRevisar(pago: PagoPorRevisarRow): string {
  const cobrado = formatCOP(pago.cobrable);
  const noCobrado = formatCOP(pago.noCobrable);
  switch (pago.motivo) {
    case "PAGO_SIN_FACTURAS":
      return `Este pago no tiene facturas enlazadas y en el trámite hay asesoría que sus pagos enlazados no cubren. Al cliente se le está cobrando ${cobrado} de este pago. ${REGISTRAR_DE_NUEVO_CON_ASESORIA}`;
    case "SOBRANTE_COBRADO":
      // Pago mixto (ya descuenta asesoría): el cobro de más viene de OTRO pago
      // a las mismas facturas; rehacer este no arregla nada.
      if (BigInt(pago.noCobrable) > 0n) {
        return `Este pago ya descuenta la asesoría (${noCobrado}, no se cobra) y al cliente se le cobran ${cobrado}. Pero entre este y otros pagos a las mismas facturas se pagó más de lo que valen: el cobro de más viene del otro pago (también sale en esta lista). Revisa ese pago.`;
      }
      return `Este pago (solo o junto con otros pagos de sus facturas) pagó más de lo que valen esas facturas. Al cliente se le está cobrando ${cobrado} de este pago. ${REGISTRAR_DE_NUEVO_CON_ASESORIA} Si no era asesoría, revisa si ese gasto se pagó dos veces o si su factura quedó registrada por menos.`;
    case "SOBRANTE_NO_COBRADO": {
      const sobrante = BigInt(pago.valor) - BigInt(pago.sumaFacturas);
      const cuanto = sobrante > 0n ? `${formatCOP(sobrante.toString())} más` : "más";
      return `Se pagó ${cuanto} de lo que suman sus facturas. Ese sobrante lo asume Galcomex: de este pago no se le cobran ${noCobrado} al cliente. Si el sobrante era un gasto que sí se cobra (por ejemplo, transporte), pide a quien registra pagos que elimine este pago y lo registre de nuevo seleccionando también la factura de ese gasto; después vuelve a generar el borrador.`;
    }
    case "ABONO_PARCIAL":
      return `Abono parcial: el pago es menor que lo que suman sus facturas. Se descontó primero la asesoría (${noCobrado}, no se cobra) y al cliente se le cobra el resto (${cobrado}). Revisa en el soporte bancario o en el estado de cuenta del proveedor cuánto fue a cada factura: si la asesoría no se pagó completa con este pago, al cliente se le está cobrando de menos; si a la asesoría se le pagó más de lo que dice su factura (por ejemplo, con IVA), al cliente se le está cobrando de más. Si no cuadra, corrige el pago o la factura y vuelve a generar el borrador.`;
    case "BLOQUE_SIN_MONTOS":
      return `Pago en bloque sin un detalle confiable de cuánto fue a cada factura. Se tomó lo más seguro para el cliente: no se cobran ${noCobrado} de este pago (la asesoría por lo más alto registrado y, si lo hay, el sobrante) y al cliente se le cobra ${cobrado}. Revisa el detalle del bloque en el libro de pagos.`;
    default:
      return `Al cliente se le cobra ${cobrado} de este pago y no se le cobran ${noCobrado}. Revisa en el libro de pagos cómo se repartió entre lo que se cobra y la asesoría.`;
  }
}

/**
 * Lo pagado y, cuando es un dato claro, lo que suman sus facturas. Sin
 * facturas (PAGO_SIN_FACTURAS) no hay suma; en BLOQUE_SIN_MONTOS la suma
 * lleva la asesoría por lo más alto registrado, no por su factura, y
 * confundiría.
 */
function montosPagoPorRevisar(p: PagoPorRevisarRow): string {
  if (p.motivo === "PAGO_SIN_FACTURAS" || p.motivo === "BLOQUE_SIN_MONTOS") {
    return `: pagado ${formatCOP(p.valor)}. `;
  }
  return `: pagado ${formatCOP(p.valor)}; sus facturas suman ${formatCOP(p.sumaFacturas)}. `;
}

/**
 * Aviso antes de aprobar. `pagos` null o vacío → no pinta nada (el SOCIO
 * nunca recibe la lista).
 */
export function AvisoPagosPorRevisar({
  pagos,
}: {
  pagos: readonly PagoPorRevisarRow[] | null | undefined;
}) {
  if (!pagos || pagos.length === 0) return null;
  const plural = pagos.length === 1 ? "" : "s";
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">
          Revisa {pagos.length} pago{plural} antes de aprobar
        </p>
        <p className="text-xs">
          Este trámite tiene facturas marcadas NO SE COBRA (asesoría). En {pagos.length === 1 ? "este pago" : "estos pagos"} el
          sistema no pudo confirmar qué parte fue asesoría y qué parte se le cobra al cliente.
        </p>
        <ul className="mt-1 space-y-1">
          {pagos.map((p) => (
            <li key={p.pagoId} className="text-xs">
              <span className="font-medium">
                {p.concepto || "Pago sin concepto"}
                {p.numSoporte ? ` · soporte ${p.numSoporte}` : null}
              </span>
              {montosPagoPorRevisar(p)}
              {explicacionPagoPorRevisar(p)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
