"use client";

import { ArrowLeftRight, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { registrarCompensacion, type CuentaCorriente } from "@/components/clientes/cuenta-api";
import { claseCampo } from "@/components/clientes/form-campos";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError } from "@/components/ui/toast";
import { etiquetaLineaServicio } from "@/lib/cuenta-corriente/etiquetas-linea";
import { hoyBogotaISO } from "@/lib/tiempo/bogota";

function formatCOP(valor: string): string {
  let entero: bigint;
  try {
    entero = BigInt(valor);
  } catch {
    return valor;
  }
  const negativo = entero < 0n;
  const absoluto = (negativo ? -entero : entero).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "−" : ""}$ ${absoluto}`;
}

const LINEAS_SERVICIO = ["TRAMITE", "CLASIFICACION", "PLAN_VALLEJO", "OTROS", "COMISION", "ASESORIA"];

/** Dígitos de un valor en pesos como BigInt; vacío o inválido = 0. */
function aBigInt(valor: string): bigint {
  try {
    return BigInt(valor.replace(/\D/g, "") || "0");
  } catch {
    return 0n;
  }
}

/**
 * Cruce de saldos: salda el mismo importe en las dos puntas sin plata. Es lo
 * que Camila hace hoy a mano con Coldex: "meto esa factura y la cruzo con lo
 * que ellos nos deben, para no hacer doble transferencia".
 *
 * «Sin factura» de proveedor solo cruza lo registrado a mano
 * (`maximoSinFacturaProveedor`): lo que le debemos en facturas se cruza
 * eligiendo la factura (las que no se cobran al cliente) o se paga por el libro
 * de pagos; cruzarlo sin factura la dejaría Pendiente y se pagaría dos veces.
 */
export function CompensacionModal({
  clienteId,
  cuenta,
  onClose,
  onGuardado,
}: {
  clienteId: string;
  cuenta: CuentaCorriente;
  onClose: () => void;
  onGuardado: (cuenta: CuentaCorriente) => void;
}) {
  const maximoSinFactura = cuenta.maximoSinFacturaProveedor ?? "0";
  const sinFacturaPermitido = aBigInt(maximoSinFactura) > 0n;

  const [valor, setValor] = useState(maximoSinFactura);
  const [fecha, setFecha] = useState(hoyBogotaISO());
  const [concepto, setConcepto] = useState("");
  const [lineaServicio, setLineaServicio] = useState("TRAMITE");
  const [facturaId, setFacturaId] = useState("");
  const [facturaProveedorId, setFacturaProveedorId] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const facturaProveedor = cuenta.compensables.facturasProveedor.find((f) => f.id === facturaProveedorId) ?? null;
  const facturaVenta = cuenta.compensables.facturasVenta.find((f) => f.id === facturaId) ?? null;
  const valorEfectivo = facturaProveedor ? facturaProveedor.valor : valor;
  // Sin factura de proveedor: no se puede pasar de lo registrado a mano.
  const excedeSinFactura = !facturaProveedor && aBigInt(valorEfectivo) > aBigInt(maximoSinFactura);
  const bloqueadoSinFactura = !facturaProveedor && (!sinFacturaPermitido || excedeSinFactura);

  function elegirFacturaProveedor(id: string) {
    setFacturaProveedorId(id);
    const f = cuenta.compensables.facturasProveedor.find((x) => x.id === id);
    // Volver a «Sin factura» prellena con lo que se puede cruzar sin factura.
    setValor(f ? f.valor : maximoSinFactura);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (guardando || bloqueadoSinFactura) return;
    setError(null);
    setGuardando(true);
    try {
      const actualizada = await registrarCompensacion(clienteId, {
        valor: facturaProveedor ? undefined : valorEfectivo.replace(/\D/g, ""),
        fecha,
        concepto: concepto.trim(),
        lineaServicio,
        facturaId: facturaId || null,
        facturaProveedorId: facturaProveedorId || null,
      });
      if (actualizada) onGuardado(actualizada);
      onClose();
    } catch (caught) {
      setError(describirError(caught, "No fue posible registrar el cruce."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Cruzar saldos"
      description={`A cargo de ${cuenta.empresa.nombre} (le debe a Galcomex): ${formatCOP(cuenta.pendienteCliente)}. A favor de ${cuenta.empresa.nombre} (Galcomex le debe): ${formatCOP(cuenta.pendienteProveedor)}. Se puede cruzar hasta ${formatCOP(cuenta.maximoCompensable)} sin que se mueva plata.`}
      size="md"
      dismissible={!guardando}
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600">Contra qué factura de venta (opcional)</span>
          <select value={facturaId} onChange={(e) => setFacturaId(e.target.value)} className={claseCampo(false)}>
            <option value="">Sin factura: baja el saldo manual a cargo de {cuenta.empresa.nombre}</option>
            {cuenta.compensables.facturasVenta.map((f) => (
              <option key={f.id} value={f.id}>
                {f.numSiigo}
                {f.referencia ? ` · ${f.referencia}` : ""} · pendiente {formatCOP(f.pendiente)}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600">Contra qué factura de proveedor (opcional, solo las que no se cobran al cliente)</span>
          <select value={facturaProveedorId} onChange={(e) => elegirFacturaProveedor(e.target.value)} className={claseCampo(false)}>
            <option value="" disabled={!sinFacturaPermitido}>
              {sinFacturaPermitido
                ? `Sin factura: baja lo registrado a mano a favor de ${cuenta.empresa.nombre} (hasta ${formatCOP(maximoSinFactura)})`
                : `Sin factura: no hay nada registrado a mano a favor de ${cuenta.empresa.nombre}`}
            </option>
            {cuenta.compensables.facturasProveedor.map((f) => (
              <option key={f.id} value={f.id}>
                {f.numFactura} · {f.referencia} · {formatCOP(f.valor)}
              </option>
            ))}
          </select>
          {!facturaProveedor && !sinFacturaPermitido ? (
            <span className="block text-xs text-amber-700">
              Sin factura de proveedor solo se cruza lo registrado a mano, y no hay nada registrado a mano a favor de{" "}
              {cuenta.empresa.nombre}. Lo que le debemos está en facturas: las que no se cobran al cliente elígelas en
              esta lista; las demás se pagan por el libro de pagos o en «Pagar en bloque».
            </span>
          ) : null}
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">Valor a cruzar (COP) *</span>
            <CampoMoneda
              value={valorEfectivo}
              onValueChange={setValor}
              required
              disabled={Boolean(facturaProveedor)}
              className={claseCampo(false)}
            />
            {facturaProveedor ? <span className="text-xs text-slate-500">La factura de proveedor se cruza por su total.</span> : null}
            {sinFacturaPermitido && excedeSinFactura ? (
              <span className="text-xs text-amber-700">
                Sin factura de proveedor solo se cruza lo registrado a mano: hasta {formatCOP(maximoSinFactura)}. Lo demás
                que le debemos está en facturas: elígela en la lista o págala por el libro de pagos.
              </span>
            ) : null}
            {facturaVenta && BigInt(valorEfectivo || "0") > BigInt(facturaVenta.pendiente) ? (
              <span className="text-xs text-amber-700">La factura solo tiene pendientes {formatCOP(facturaVenta.pendiente)}.</span>
            ) : null}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">Fecha *</span>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required className={claseCampo(false)} />
          </label>
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-slate-600">Concepto *</span>
            <input
              value={concepto}
              onChange={(e) => setConcepto(e.target.value)}
              required
              placeholder="Describe el cruce"
              className={claseCampo(false)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">Línea</span>
            <select value={lineaServicio} onChange={(e) => setLineaServicio(e.target.value)} className={claseCampo(false)}>
              {LINEAS_SERVICIO.map((l) => (
                <option key={l} value={l}>
                  {etiquetaLineaServicio(l)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={guardando} className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Cancelar
          </button>
          <button type="submit" disabled={guardando || bloqueadoSinFactura} className="inline-flex h-9 items-center gap-1.5 border border-slate-950 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
            {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />}
            Cruzar
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
