"use client";

import { AlertCircle, ArrowLeftRight, Loader2, Plus, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { CompensacionModal } from "@/components/clientes/compensacion-modal";
import {
  eliminarCompensacion,
  fetchCuentaCorriente,
  registrarMovimiento,
  type CuentaCorriente,
  type MovimientoCuentaRow,
  type NuevoMovimiento,
} from "@/components/clientes/cuenta-api";
import { claseCampo } from "@/components/clientes/form-campos";
import { ModuleState } from "@/components/layout/module-state";
import { EnlaceTramite, type TabTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useEsAdmin, usePermiso } from "@/lib/auth/rol-context";

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
  COMPENSACION: "Cruce de saldos",
};

const LINEAS_SERVICIO = ["TRAMITE", "CLASIFICACION", "PLAN_VALLEJO", "OTROS", "COMISION", "ASESORIA"];

/** Pestaña del DO más relevante para cada fuente de asiento, al enlazar la referencia. */
function tabParaFuente(fuente: string): TabTramite | undefined {
  return fuente === "FACTURA_PROVEEDOR" ? "facturas-proveedor" : undefined;
}

function MovimientoModal({
  clienteId,
  onClose,
  onGuardado,
}: {
  clienteId: string;
  onClose: () => void;
  onGuardado: (cuenta: CuentaCorriente) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
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
      toast({
        title: "Movimiento registrado",
        description: `${movimiento.concepto} · ${formatCOP(movimiento.valor || "0")}`,
        variant: "success",
      });
      onClose();
    } catch (caught: unknown) {
      const mensaje = describirError(caught, "No fue posible guardar.");
      setError(mensaje);
      toast({ title: "No se pudo registrar el movimiento", description: mensaje, variant: "error" });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Registrar movimiento"
      description="Importes que no nacen de un trámite: mensualidades, comisiones, ajustes."
      size="md"
      dismissible={!guardando}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={guardando}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form={formId}
            disabled={guardando}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {guardando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {guardando ? "Guardando…" : "Registrar"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Concepto *</span>
            <input
              name="concepto"
              required
              placeholder="Servicios aduaneros marzo"
              className={claseCampo(false)}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
            <input
              name="valor"
              required
              inputMode="numeric"
              placeholder="4000000"
              className={claseCampo(false, "font-mono")}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Tipo *</span>
            <select name="tipo" required defaultValue="ABONO" className={claseCampo(false, "bg-white")}>
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
              className={claseCampo(false, "bg-white")}
            >
              <option value="CARGO_MANUAL">Cargo manual</option>
              <option value="COMISION">Comisión</option>
              <option value="AJUSTE">Ajuste</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Rol *</span>
            <select name="rol" required defaultValue="PROVEEDOR" className={claseCampo(false, "bg-white")}>
              <option value="PROVEEDOR">Como proveedor</option>
              <option value="CLIENTE">Como cliente</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Línea de servicio</span>
            <select name="lineaServicio" defaultValue="TRAMITE" className={claseCampo(false, "bg-white")}>
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
              className={claseCampo(false)}
            />
          </label>
        </div>

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        ) : null}
      </form>
    </ModalShell>
  );
}

function FilaMovimiento({
  movimiento,
  onDeshacer,
  deshaciendo,
}: {
  movimiento: MovimientoCuentaRow;
  onDeshacer?: (compensacionId: string) => void;
  deshaciendo: boolean;
}) {
  const aFavorNuestro = !movimiento.valor.startsWith("-");

  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-4 py-2.5 text-slate-600">{formatFecha(movimiento.fecha)}</td>
      <td className="px-4 py-2.5">
        <span className="font-medium text-slate-900">{movimiento.concepto}</span>
        {movimiento.compensacionId ? (
          <span className="ml-2 inline-flex items-center gap-1 border border-cyan-200 bg-cyan-50 px-1.5 text-[10px] font-semibold uppercase text-cyan-700">
            <ArrowLeftRight className="h-3 w-3" aria-hidden="true" />
            cruce
            {onDeshacer ? (
              <button
                type="button"
                onClick={() => onDeshacer(movimiento.compensacionId ?? "")}
                disabled={deshaciendo}
                className="ml-1 inline-flex items-center gap-0.5 text-cyan-800 hover:underline disabled:opacity-50"
                aria-label="Deshacer el cruce"
              >
                <Undo2 className="h-3 w-3" aria-hidden="true" />
                deshacer
              </button>
            ) : null}
          </span>
        ) : null}
        <span className="mt-0.5 block text-xs text-slate-500">
          {ETIQUETA_FUENTE[movimiento.fuente] ?? movimiento.fuente}
          {movimiento.referencia ? (
            <>
              {" · "}
              <EnlaceTramite id={movimiento.tramiteId} tab={tabParaFuente(movimiento.fuente)}>
                {movimiento.referencia}
              </EnlaceTramite>
            </>
          ) : null}
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

type LoadState = "loading" | "ready" | "error" | "sin-permiso";

/**
 * Cuenta corriente de la contraparte (M5): junta en un solo saldo lo que la
 * empresa nos debe como cliente y lo que le debemos como proveedor.
 */
export function SeccionCuentaCorriente({ clienteId }: { clienteId: string }) {
  // GET /api/clientes/[id]/cuenta → ADMIN y REVISOR; POST → solo ADMIN.
  const puedeVer = usePermiso(["ADMIN", "REVISOR"]);
  const puedeRegistrar = useEsAdmin();

  const [cuenta, setCuenta] = useState<CuentaCorriente | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(puedeVer ? "loading" : "sin-permiso");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [cruceAbierto, setCruceAbierto] = useState(false);
  const [deshaciendo, setDeshaciendo] = useState<string | null>(null);
  const [verTodo, setVerTodo] = useState(false);
  const { toast } = useToast();
  const confirmar = useConfirm();

  async function deshacerCruce(compensacionId: string) {
    const ok = await confirmar({
      title: "Deshacer el cruce",
      description: "Se retiran las dos puntas: vuelve a deberse lo que se había cruzado.",
      confirmText: "Deshacer",
      variant: "danger",
    });
    if (!ok) return;
    setDeshaciendo(compensacionId);
    try {
      const actualizada = await eliminarCompensacion(clienteId, compensacionId);
      if (actualizada) setCuenta(actualizada);
      toast({ title: "Cruce deshecho", variant: "success" });
    } catch (caught) {
      toast({ title: "No se pudo deshacer", description: describirError(caught), variant: "error" });
    } finally {
      setDeshaciendo(null);
    }
  }

  useEffect(() => {
    // Con criterio explícito: si el rol no puede, ni se consulta.
    if (!puedeVer) return;

    const controller = new AbortController();

    fetchCuentaCorriente(clienteId, controller.signal)
      .then((datos) => {
        // `null` = el API respondió 403 (el rol no puede ver cartera).
        if (!datos) {
          setLoadState("sin-permiso");
          return;
        }
        setCuenta(datos);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar la cuenta."));
        setLoadState("error");
      });

    return () => controller.abort();
  }, [clienteId, reloadKey, puedeVer]);

  function recargar() {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  // Función `cuenta_corriente` apagada (empresa que solo es cliente): la sección
  // no se muestra, porque repetiría la cartera. Mientras carga tampoco, para no
  // mostrar y quitar un esqueleto en cada ficha que no la usa.
  if (loadState === "sin-permiso" || loadState === "loading") return null;
  if (loadState === "ready" && cuenta && !cuenta.habilitada) return null;

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
        {puedeRegistrar && loadState === "ready" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCruceAbierto(true)}
              disabled={!cuenta || BigInt(cuenta.maximoCompensable) <= 0n}
              title={
                cuenta && BigInt(cuenta.maximoCompensable) <= 0n
                  ? "Para cruzar, la empresa tiene que debernos y nosotros deberle a la vez"
                  : undefined
              }
              className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
              Cruzar saldos
            </button>
            <button
              type="button"
              onClick={() => setModalAbierto(true)}
              className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Registrar movimiento
            </button>
          </div>
        ) : null}
      </div>

      {loadState === "error" ? (
        <ModuleState
          type="error"
          title="No se pudo cargar la cuenta corriente"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : !cuenta ? null : (
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
                    <FilaMovimiento
                      key={movimiento.id}
                      movimiento={movimiento}
                      onDeshacer={puedeRegistrar ? deshacerCruce : undefined}
                      deshaciendo={deshaciendo === movimiento.compensacionId}
                    />
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
      )}

      {modalAbierto && puedeRegistrar ? (
        <MovimientoModal
          clienteId={clienteId}
          onClose={() => setModalAbierto(false)}
          onGuardado={(actualizada) => setCuenta(actualizada)}
        />
      ) : null}

      {cruceAbierto && puedeRegistrar && cuenta ? (
        <CompensacionModal
          clienteId={clienteId}
          cuenta={cuenta}
          onClose={() => setCruceAbierto(false)}
          onGuardado={(actualizada) => {
            setCuenta(actualizada);
            toast({ title: "Saldos cruzados", variant: "success" });
          }}
        />
      ) : null}
    </div>
  );
}
