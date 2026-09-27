/**
 * "Generar pago" desde una factura de proveedor (API + MCP) — CxP v2, diseño §B.3.
 *
 * P0 lo movió aquí desde `facturas-proveedor/service.ts` (que lo re-exporta)
 * para que P1 y P2 nunca compartan archivo. P1 lo reescribe para DELEGAR en
 * `crearPago({ aplicaciones })`: hereda la regla de anticipo, el banco del
 * 4x1000, el bloqueo de filas, el control de saldo y la idempotencia. Una
 * factura pagada no se vuelve a pagar (FACTURA_SIN_SALDO); con `monto` menor
 * que el saldo queda Abonada.
 */

import { CanalPago, type FacturaProveedor } from "@prisma/client";

import {
  FacturaProveedorNoEncontradaError,
  FacturaSinProveedorError,
  FacturaSinSaldoError,
  IdempotenciaConflictoError,
  MontoExcedeSaldoError,
  MontoInvalidoError,
} from "@/lib/cxp/errores";
import { numeroFacturaVisible, saldoDe } from "@/lib/cxp/saldos";
import { prisma } from "@/lib/db/prisma";
import { crearPago, type PagoCreado } from "@/lib/pagos/service";
import { fechaCalendarioAInput } from "@/lib/tiempo/bogota";

export type GenerarPagoInput = {
  facturaProveedorId: string;
  canalPago: CanalPago;
  viaSocio: boolean;
  fechaRealPago?: Date | null;
  /** Cuánto pagar (abono). Por defecto, todo el saldo de la factura. */
  monto?: bigint;
  /** Comprobante bancario (documento del mismo DO). */
  documentoId?: string | null;
  claveIdempotencia?: string | null;
  usuarioId: string;
};

/**
 * Idempotencia de "Generar pago" (§B.5, CA-43): si la clave ya se usó, se
 * devuelve ESE pago con `repetido: true` sin volver a mirar el saldo (que ya
 * bajó con el primer envío). Se compara lo que pidió el cliente — la factura,
 * el canal, el monto si lo mandó y la fecha si la mandó — y no el hash de
 * `crearPago`, porque sin `monto` el valor sale del saldo del momento y en el
 * reintento ya es otro. Si la clave es de otro pago → IDEMPOTENCIA_CONFLICTO.
 */
async function pagoPrevioPorClave(
  clave: string,
  factura: { id: string; tramiteId: string },
  input: GenerarPagoInput,
): Promise<PagoCreado | null> {
  const previo = await prisma.pagoTramite.findUnique({
    where: { claveIdempotencia: clave },
    include: { facturasProveedor: { select: { facturaId: true, monto: true } } },
  });
  if (!previo) return null;
  const { facturasProveedor, ...pago } = previo;
  const aplicacion = facturasProveedor.length === 1 ? facturasProveedor[0] : undefined;
  const mismaSolicitud =
    previo.tramiteId === factura.tramiteId &&
    aplicacion?.facturaId === factura.id &&
    previo.canalPago === input.canalPago &&
    (input.monto === undefined || aplicacion.monto === input.monto) &&
    (input.fechaRealPago === undefined ||
      fechaCalendarioAInput(previo.fechaRealPago) === fechaCalendarioAInput(input.fechaRealPago));
  if (!mismaSolicitud) throw new IdempotenciaConflictoError("OTRO_CONTENIDO");
  return { ...pago, repetido: true };
}

/**
 * Genera un PagoTramite desde una FacturaProveedor:
 * - valor = `monto` (o el saldo), concepto "Pago factura FE 12481 — ALMACARGA",
 *   numSoporte = N° de la factura, beneficiario = la ficha de la factura.
 * - Aplica el monto a la factura con `aplicarSaldo` (vía `crearPago`).
 * - Todo en una transacción atómica, con auditoría.
 */
export async function generarPagoDesdeFactura(
  input: GenerarPagoInput,
): Promise<{ pago: PagoCreado; factura: FacturaProveedor }> {
  const { facturaProveedorId } = input;

  const factura = await prisma.facturaProveedor.findUnique({
    where: { id: facturaProveedorId },
    select: {
      id: true,
      tramiteId: true,
      numFactura: true,
      proveedorNombre: true,
      beneficiarioId: true,
      valor: true,
      montoCompensado: true,
      beneficiario: { select: { nombre: true, nombreCorto: true, numFacturaConEspacio: true } },
      ajustes: { select: { monto: true } },
      pagos: { select: { monto: true } },
    },
  });
  if (!factura) {
    throw new FacturaProveedorNoEncontradaError(facturaProveedorId);
  }

  const clave = input.claveIdempotencia ?? null;
  if (clave) {
    // Antes que el saldo: un reintento del mismo "Generar pago" devuelve el pago original.
    const previo = await pagoPrevioPorClave(clave, factura, input);
    if (previo) return { pago: previo, factura: await facturaCompleta(facturaProveedorId) };
  }

  const visible = numeroFacturaVisible(factura.numFactura, factura.beneficiario?.numFacturaConEspacio ?? false);
  const proveedor = factura.beneficiario
    ? (factura.beneficiario.nombreCorto ?? factura.beneficiario.nombre)
    : factura.proveedorNombre;

  if (!factura.beneficiarioId) {
    throw new FacturaSinProveedorError(visible);
  }

  try {
    const pago = await validarYCrear(
      input,
      { ...factura, beneficiarioId: factura.beneficiarioId },
      visible,
      proveedor,
    );
    return { pago, factura: await facturaCompleta(facturaProveedorId) };
  } catch (e) {
    // Carrera de dos envíos con la misma clave: el segundo pudo leer el saldo
    // ya en 0 (o distinto) antes de ver la clave del primero.
    if (
      clave &&
      (e instanceof FacturaSinSaldoError || e instanceof MontoExcedeSaldoError || e instanceof IdempotenciaConflictoError)
    ) {
      const previo = await pagoPrevioPorClave(clave, factura, input);
      if (previo) return { pago: previo, factura: await facturaCompleta(facturaProveedorId) };
    }
    throw e;
  }
}

function facturaCompleta(id: string): Promise<FacturaProveedor> {
  return prisma.facturaProveedor.findUniqueOrThrow({ where: { id } });
}

async function validarYCrear(
  input: GenerarPagoInput,
  factura: {
    id: string;
    tramiteId: string;
    numFactura: string;
    beneficiarioId: string;
    valor: bigint;
    montoCompensado: bigint;
    ajustes: { monto: bigint }[];
    pagos: { monto: bigint }[];
  },
  visible: string,
  proveedor: string,
): Promise<PagoCreado> {
  // Lectura previa para responder rápido; `crearPago` vuelve a validar con la fila bloqueada.
  const saldo = saldoDe({
    valor: factura.valor,
    aplicado: factura.pagos.reduce((s, p) => s + p.monto, 0n),
    ajustes: factura.ajustes.reduce((s, a) => s + a.monto, 0n),
    compensado: factura.montoCompensado,
  });
  if (saldo === 0n) {
    throw new FacturaSinSaldoError(visible, proveedor);
  }
  const monto = input.monto ?? saldo;
  if (monto <= 0n) {
    throw new MontoInvalidoError(visible);
  }
  if (monto > saldo) {
    throw new MontoExcedeSaldoError(visible, saldo, monto);
  }

  return crearPago({
    tramiteId: factura.tramiteId,
    concepto: `Pago factura ${visible} — ${proveedor}`,
    numSoporte: factura.numFactura,
    valor: monto,
    canalPago: input.canalPago,
    fechaRealPago: input.fechaRealPago,
    viaSocio: input.viaSocio,
    documentoId: input.documentoId ?? null,
    beneficiarioIds: [factura.beneficiarioId],
    aplicaciones: [{ facturaProveedorId: factura.id, monto }],
    claveIdempotencia: input.claveIdempotencia ?? null,
    modo: "GENERAR_PAGO",
    usuarioId: input.usuarioId,
  });
}
