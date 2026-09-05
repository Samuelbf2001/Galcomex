"use client";

import { AlertCircle, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  fetchCuentaCorriente,
  registrarMovimiento,
  type CuentaCorriente,
  type MovimientoCuentaRow,
  type NuevoMovimiento,
} from "@/components/clientes/cuenta-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mismo patrón que en el resto de secciones de la ficha.
function useUserRol(): string {
  const [rol, setRol] = useState<string>("OPERATIVO");

  useEffect(() => {
    fetch("/api/auth/get-session", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (isRecord(data) && isRecord(data.user) && typeof data.user.rol === "string") {
          setRol(data.user.rol);
        }
      })
      .catch(() => {
        /* silencioso */
      });
  }, []);

  return rol;
}

function formatCOP(valor: string): string {
  let entero: bigint;
  try {
    entero = BigInt(valor);
  } catch {
    return valor;
  }

  const negativo = entero < 0n;
  const absoluto = (negativo ? -entero : entero).toString();
  const conSeparadores = absoluto.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${negativo ? "−" : ""}$ ${conSeparadores}`;
}

function formatFecha(iso: string): string {
  if (!iso) return "—";
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(fecha);
}

const ETIQUETA_FUENTE: Record<string, string> = {
  FACTURA_VENTA: "Factura de venta",
  ABONO_CLIENTE: "Abono del cliente",
  DEVOLUCION_CLIENTE: "Devolución",
  FACTURA_PROVEEDOR: "Factura de proveedor",
  PAGO_PROVEEDOR: "Pago al proveedor",
  CARGO_MANUAL: "Cargo manual",
  COMISION: "Comisión",
  AJUSTE: "Ajuste",
};

const LINEAS_SERVICIO = ["TRAMITE", "CLASIFICACION", "PLAN_VALLEJO", "COMISION", "ASESORIA"];

function MovimientoModal({
  clienteId,
  onClose,
  onGuardado,
}: {
  clienteId: string;
  onClose: () => void;
  onGuardado: (cuenta: CuentaCorriente) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setGuardando(true);

    const datos = new FormData(event.currentTarget);
    const movimiento: NuevoMovimiento = {
      rol: String(datos.get("rol") ?? "PROVEEDOR") as NuevoMovimiento["rol"],
      tipo: String(datos.get("tipo") ?? "ABONO") as NuevoMovimiento["tipo"],
      origen: String(datos.get("origen") ?? "CARGO_MANUAL") as NuevoMovimiento["origen"],
      lineaServicio: String(datos.get("lineaServicio") ?? "TRAMITE"),
      concepto: String(datos.get("concepto") ?? ""),
      valor: String(datos.get("valor") ?? "0").replace(/\D/g, ""),
      fecha: new Date(`${String(datos.get("fecha") ?? "")}T00:00:00.000Z`).toISOString(),
    };

    try {
      const cuenta = await registrarMovimiento(clienteId, movimiento);
      if (cuenta) onGuardado(cuenta);
      onClose();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "No fue posible guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-lg border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Registrar movimiento</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Importes que no nacen de un trámite: mensualidades, comisiones, ajustes.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Concepto *</span>
              <input
                name="concepto"
                required
                placeholder="Servicios aduaneros marzo"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
              <input
                name="valor"
                required
                inputMode="numeric"
                placeholder="4000000"
                className="h-10 w-full border border-slate-300 px-3 font-mono text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Tipo *</span>
              <select
                name="tipo"
                required
                defaultValue="ABONO"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="ABONO">Le debemos (sube el saldo a su favor)</option>
                <option value="CARGO">Nos debe (sube el saldo a su cargo)</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Origen *</span>
              <select
                name="origen"
                required
                defaultValue="CARGO_MANUAL"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="CARGO_MANUAL">Cargo manual</option>
                <option value="COMISION">Comisión</option>
                <option value="AJUSTE">Ajuste</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Rol *</span>
              <select
                name="rol"
                required
                defaultValue="PROVEEDOR"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="PROVEEDOR">Como proveedor</option>
                <option value="CLIENTE">Como cliente</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Línea de servicio</span>
              <select
                name="lineaServicio"
                defaultValue="TRAMITE"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                {LINEAS_SERVICIO.map((linea) => (
                  <option key={linea} value={linea}>
                    {linea}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Fecha *</span>
              <input
                name="fecha"
                type="date"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="h-10 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {guardando ? "Guardando…" : "Registrar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FilaMovimiento({ movimiento }: { movimiento: MovimientoCuentaRow }) {
  const aFavorNuestro = !movimiento.valor.startsWith("-");

  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-4 py-2.5 text-slate-600">{formatFecha(movimiento.fecha)}</td>
      <td className="px-4 py-2.5">
        <span className="font-medium text-slate-900">{movimiento.concepto}</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {ETIQUETA_FUENTE[movimiento.fuente] ?? movimiento.fuente}
          {movimiento.referencia ? ` · ${movimiento.referencia}` : ""}
        </span>
      </td>
      <td className="px-4 py-2.5 text-xs text-slate-500">{movimiento.lineaServicio}</td>
      <td
        className={`px-4 py-2.5 text-right font-mono font-semibold ${
          aFavorNuestro ? "text-emerald-700" : "text-rose-700"
        }`}
      >
        {formatCOP(movimiento.valor)}
      </td>
    </tr>
  );
}

/**
 * Cuenta corriente de la contraparte (M5): junta en un solo saldo lo que la
 * empresa nos debe como cliente y lo que le debemos como proveedor.
 */
export function SeccionCuentaCorriente({ clienteId }: { clienteId: string }) {
  const userRol = useUserRol();
  const puedeRegistrar = userRol === "ADMIN";

  const [cuenta, setCuenta] = useState<CuentaCorriente | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [verTodo, setVerTodo] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetchCuentaCorriente(clienteId, controller.signal)
      .then((datos) => {
        setCuenta(datos);
        setCargando(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Error al cargar la cuenta.");
        setCargando(false);
      });

    return () => controller.abort();
  }, [clienteId]);

  // Sin permiso para ver cartera la sección no se muestra en absoluto.
  if (!cargando && !error && !cuenta) {
    return null;
  }

  const neto = cuenta ? BigInt(cuenta.neto) : 0n;
  const visibles =
    cuenta && !verTodo ? cuenta.movimientos.slice(0, 12) : (cuenta?.movimientos ?? []);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Cuenta corriente</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Las dos puntas cruzadas: lo que nos debe como cliente y lo que le debemos como
            proveedor.
          </p>
        </div>
        {puedeRegistrar ? (
          <button
            type="button"
            onClick={() => setModalAbierto(true)}
            className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Registrar movimiento
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {cargando ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">Cargando cuenta…</p>
      ) : cuenta ? (
        <>
          <div className="grid gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-3">
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Nos debe
              </p>
              <p className="mt-0.5 font-mono text-lg font-bold text-slate-900">
                {formatCOP(cuenta.totalACargo)}
              </p>
            </div>
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Le debemos
              </p>
              <p className="mt-0.5 font-mono text-lg font-bold text-slate-900">
                {formatCOP(cuenta.totalAFavor)}
              </p>
            </div>
            <div className="bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Saldo cruzado
              </p>
              <p
                className={`mt-0.5 font-mono text-lg font-bold ${
                  neto > 0n ? "text-emerald-700" : neto < 0n ? "text-rose-700" : "text-slate-900"
                }`}
              >
                {formatCOP(cuenta.neto)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {neto === 0n
                  ? "Cuenta saldada"
                  : neto > 0n
                    ? `${cuenta.empresa.nombre} le debe a Galcomex`
                    : `Galcomex le debe a ${cuenta.empresa.nombre}`}
              </p>
            </div>
          </div>

          {cuenta.porLinea.length > 1 ? (
            <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-2.5">
              {cuenta.porLinea.map((linea) => (
                <span
                  key={linea.lineaServicio}
                  className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                >
                  <span className="font-medium text-slate-600">{linea.lineaServicio}</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {formatCOP(linea.neto)}
                  </span>
                </span>
              ))}
            </div>
          ) : null}

          {cuenta.movimientos.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              Sin movimientos en la cuenta.
            </p>
          ) : (
            <>
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-4 py-2.5">Fecha</th>
                    <th className="border-b border-slate-200 px-4 py-2.5">Concepto</th>
                    <th className="border-b border-slate-200 px-4 py-2.5">Línea</th>
                    <th className="border-b border-slate-200 px-4 py-2.5 text-right">
                      Valor (COP)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((movimiento) => (
                    <FilaMovimiento key={movimiento.id} movimiento={movimiento} />
                  ))}
                </tbody>
              </table>

              {cuenta.movimientos.length > visibles.length || verTodo ? (
                <div className="border-t border-slate-200 px-4 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => setVerTodo((actual) => !actual)}
                    className="text-sm font-semibold text-cyan-700 transition hover:text-cyan-900"
                  >
                    {verTodo
                      ? "Ver solo los últimos"
                      : `Ver los ${cuenta.movimientos.length} movimientos`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {modalAbierto ? (
        <MovimientoModal
          clienteId={clienteId}
          onClose={() => setModalAbierto(false)}
          onGuardado={(actualizada) => setCuenta(actualizada)}
        />
      ) : null}
    </div>
  );
}
