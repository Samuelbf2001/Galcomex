"use client";

import { CheckCircle2, ExternalLink, Loader2, Pencil, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import {
  ClientesApiError,
  erroresPorCampo,
  fetchClienteDetalle,
  updateCliente,
  upsertTarifa,
  type AnticipoResumen,
  type ClienteDetalle,
  type DetalleValidacion,
  type FacturaResumen,
  type TarifaCliente,
  type TramiteResumen,
  type UpdateClienteInput,
} from "@/components/clientes/clientes-api";
import { claseCampo, MensajeCampo } from "@/components/clientes/form-campos";
import { SeccionCapacidades } from "@/components/clientes/seccion-capacidades";
import { SeccionCuentaCorriente } from "@/components/clientes/seccion-cuenta-corriente";
import { SeccionPagosProveedor } from "@/components/clientes/seccion-pagos-proveedor";
import { SeccionTarifario } from "@/components/clientes/seccion-tarifario";
import { ModuleState } from "@/components/layout/module-state";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";

// ---------------------------------------------------------------------------
// Helpers de formato
// ---------------------------------------------------------------------------

function formatCOP(bigStr: string): string {
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(BigInt(bigStr)));
  } catch {
    return bigStr;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

function estadoBadgeClass(estado: string): string {
  const n = estado.toLowerCase();
  if (n.includes("cerr") || n.includes("pagad")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (n.includes("facturado")) {
    return "border-violet-200 bg-violet-50 text-violet-700";
  }
  if (n.includes("facturar")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (n.includes("tramite") || n.includes("puerto") || n.includes("apertura")) {
    return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}


// ---------------------------------------------------------------------------
// Sub-componente: modal editar cliente
// ---------------------------------------------------------------------------

type EditClienteModalProps = {
  cliente: ClienteDetalle;
  onClose: () => void;
  onSaved: (updated: ClienteDetalle) => void;
};

function EditClienteModal({ cliente, onClose, onSaved }: EditClienteModalProps) {
  const { toast } = useToast();
  const formId = useId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setErrores({});
    setIsSubmitting(true);

    const fd = new FormData(e.currentTarget);

    const input: UpdateClienteInput = {
      nombre: String(fd.get("nombre") ?? "").trim(),
      nit: String(fd.get("nit") ?? "").trim(),
      tipo: String(fd.get("tipo") ?? "PROPIO") as "PROPIO" | "SOCIO_LM",
      contactoNombre: (String(fd.get("contactoNombre") ?? "").trim()) || null,
      contactoEmail: (String(fd.get("contactoEmail") ?? "").trim()) || null,
      contactoTel: (String(fd.get("contactoTel") ?? "").trim()) || null,
      manejaAnticipo: fd.get("manejaAnticipo") === "on",
      activo: fd.get("activo") === "on",
      esCliente: fd.get("esCliente") === "on",
      esProveedor: fd.get("esProveedor") === "on",
    };

    try {
      const updated = await updateCliente(cliente.id, input);
      toast({ title: "Cliente actualizado", description: updated.nombre, variant: "success" });
      onSaved({ ...cliente, ...updated });
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible guardar los cambios.");
      if (caught instanceof ClientesApiError && caught.details?.length) {
        setErrores(erroresPorCampo(caught.details));
        setError("Revisa los campos marcados.");
      } else {
        setError(mensaje);
      }
      toast({ title: "No se pudo guardar el cliente", description: mensaje, variant: "error" });
    } finally {
      setIsSubmitting(false);
    }
  }

  const campo = (nombre: string) => ({
    invalido: Boolean(errores[nombre]),
    describedBy: errores[nombre] ? `${formId}-${nombre}-error` : undefined,
    errorId: `${formId}-${nombre}-error`,
  });

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Editar cliente"
      description={cliente.nombre}
      size="lg"
      dismissible={!isSubmitting}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form={formId}
            disabled={isSubmitting}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {isSubmitting ? "Guardando…" : "Guardar cambios"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Nombre / Razón social *</span>
            <input
              name="nombre"
              required
              defaultValue={cliente.nombre}
              aria-invalid={campo("nombre").invalido || undefined}
              aria-describedby={campo("nombre").describedBy}
              className={claseCampo(campo("nombre").invalido)}
            />
            <MensajeCampo id={campo("nombre").errorId} error={errores.nombre} />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">NIT *</span>
            <input
              name="nit"
              required
              defaultValue={cliente.nit}
              aria-invalid={campo("nit").invalido || undefined}
              aria-describedby={campo("nit").describedBy}
              className={claseCampo(campo("nit").invalido)}
            />
            <MensajeCampo id={campo("nit").errorId} error={errores.nit} />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Tipo</span>
            <select
              name="tipo"
              defaultValue={cliente.tipo}
              aria-invalid={campo("tipo").invalido || undefined}
              className={claseCampo(campo("tipo").invalido, "bg-white")}
            >
              <option value="PROPIO">Propio</option>
              <option value="SOCIO_LM">Socio LM</option>
            </select>
            <MensajeCampo id={campo("tipo").errorId} error={errores.tipo} />
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Nombre contacto</span>
            <input
              name="contactoNombre"
              defaultValue={cliente.contactoNombre ?? ""}
              aria-invalid={campo("contactoNombre").invalido || undefined}
              className={claseCampo(campo("contactoNombre").invalido)}
            />
            <MensajeCampo id={campo("contactoNombre").errorId} error={errores.contactoNombre} />
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Email contacto</span>
            <input
              name="contactoEmail"
              type="email"
              defaultValue={cliente.contactoEmail ?? ""}
              aria-invalid={campo("contactoEmail").invalido || undefined}
              aria-describedby={campo("contactoEmail").describedBy}
              className={claseCampo(campo("contactoEmail").invalido)}
            />
            <MensajeCampo id={campo("contactoEmail").errorId} error={errores.contactoEmail} />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Teléfono contacto</span>
            <input
              name="contactoTel"
              defaultValue={cliente.contactoTel ?? ""}
              aria-invalid={campo("contactoTel").invalido || undefined}
              aria-describedby={campo("contactoTel").describedBy}
              className={claseCampo(campo("contactoTel").invalido)}
            />
            <MensajeCampo id={campo("contactoTel").errorId} error={errores.contactoTel} />
          </label>
        </div>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2">
            <input
              name="manejaAnticipo"
              type="checkbox"
              defaultChecked={cliente.manejaAnticipo}
              className="h-4 w-4"
            />
            <span className="text-sm text-slate-700">Maneja anticipo</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              name="activo"
              type="checkbox"
              defaultChecked={cliente.activo}
              className="h-4 w-4"
            />
            <span className="text-sm text-slate-700">Activo</span>
          </label>
          {/* Roles simultáneos (M5): Ascinter, Coldex y Eltrans son las dos cosas. */}
          <label className="flex items-center gap-2">
            <input
              name="esCliente"
              type="checkbox"
              defaultChecked={cliente.esCliente !== false}
              className="h-4 w-4"
            />
            <span className="text-sm text-slate-700">Es cliente</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              name="esProveedor"
              type="checkbox"
              defaultChecked={cliente.esProveedor === true}
              className="h-4 w-4"
            />
            <span className="text-sm text-slate-700">Es proveedor</span>
          </label>
        </div>

        {error ? (
          <div role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
      </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de trámites
// ---------------------------------------------------------------------------

function SeccionTramites({ tramites }: { tramites: TramiteResumen[] }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Trámites ({tramites.length})</p>
      </div>

      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-3">Consecutivo</th>
            <th className="border-b border-slate-200 px-4 py-3">Ciudad</th>
            <th className="border-b border-slate-200 px-4 py-3">Estado</th>
            <th className="border-b border-slate-200 px-4 py-3 w-14"></th>
          </tr>
        </thead>
        <tbody>
          {tramites.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                Sin trámites registrados
              </td>
            </tr>
          ) : (
            tramites.map((tramite) => (
              <tr
                key={tramite.id}
                className="border-b border-slate-100 last:border-b-0"
              >
                <td className="px-4 py-3 font-mono font-semibold text-slate-900">
                  {tramite.consecutivo}
                </td>
                <td className="px-4 py-3 text-slate-600">{tramite.ciudad}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex h-6 items-center border px-2 text-xs font-semibold ${estadoBadgeClass(tramite.estado)}`}
                  >
                    {tramite.estado}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/tramites/${tramite.id}`}
                    className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-cyan-700"
                    aria-label={`Ver trámite ${tramite.consecutivo}`}
                    title="Ver trámite"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de anticipos
// ---------------------------------------------------------------------------

function SeccionAnticipos({ anticipos }: { anticipos: AnticipoResumen[] }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Anticipos ({anticipos.length})</p>
      </div>

      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-3">Fecha</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Monto</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Aplicado</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Restante</th>
            <th className="border-b border-slate-200 px-4 py-3">Canal</th>
            <th className="border-b border-slate-200 px-4 py-3">Verificado</th>
          </tr>
        </thead>
        <tbody>
          {anticipos.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                Sin anticipos registrados
              </td>
            </tr>
          ) : (
            anticipos.map((anticipo) => {
              let restante = "0";
              try {
                const r = BigInt(anticipo.monto) - BigInt(anticipo.montoAplicado);
                restante = r.toString();
              } catch { /* noop */ }

              return (
                <tr
                  key={anticipo.id}
                  className="border-b border-slate-100 last:border-b-0"
                >
                  <td className="px-4 py-3 text-slate-600">{formatDate(anticipo.fecha)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900">
                    {formatCOP(anticipo.monto)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600">
                    {formatCOP(anticipo.montoAplicado)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">
                    <span
                      className={(() => {
                        try {
                          const n = BigInt(restante);
                          if (n > 0n) return "text-emerald-700";
                          if (n < 0n) return "text-rose-600";
                        } catch { /* noop */ }
                        return "text-slate-500";
                      })()}
                    >
                      {formatCOP(restante)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{anticipo.canalPago}</td>
                  <td className="px-4 py-3">
                    {anticipo.verificadoBanco ? (
                      <CheckCircle2
                        className="h-4 w-4 text-emerald-600"
                        aria-label="Verificado en banco"
                        role="img"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">Pendiente</span>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de facturas
// ---------------------------------------------------------------------------

function SeccionFacturas({ facturas }: { facturas: FacturaResumen[] }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Facturas ({facturas.length})</p>
      </div>

      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-3">N° Siigo</th>
            <th className="border-b border-slate-200 px-4 py-3">Fecha</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Total factura</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Saldo a favor</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Saldo a cargo</th>
            <th className="border-b border-slate-200 px-4 py-3">Fecha pago</th>
          </tr>
        </thead>
        <tbody>
          {facturas.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                Sin facturas registradas
              </td>
            </tr>
          ) : (
            facturas.map((factura) => (
              <tr
                key={factura.id}
                className="border-b border-slate-100 last:border-b-0"
              >
                <td className="px-4 py-3 font-mono font-semibold text-slate-900">
                  {factura.numSiigo}
                </td>
                <td className="px-4 py-3 text-slate-600">{formatDate(factura.fecha)}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900">
                  {formatCOP(factura.totalFactura)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-emerald-700">
                  {formatCOP(factura.saldoAFavorCliente)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-rose-600">
                  {formatCOP(factura.saldoACargoCliente)}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {formatDate(factura.fechaPagoCliente)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: cabecera del cliente
// ---------------------------------------------------------------------------

function ClienteCabecera({
  cliente,
  puedeEditar,
  onEdit,
}: {
  cliente: ClienteDetalle;
  /** `PATCH /api/clientes/[id]` es solo ADMIN. */
  puedeEditar: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="border border-slate-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Nombre / Razón social
            </p>
            <p className="mt-0.5 text-lg font-bold text-slate-950">{cliente.nombre}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">NIT</p>
            <p className="mt-0.5 text-sm font-mono font-semibold text-slate-800">
              {cliente.nit}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Rol</p>
            <p className="mt-0.5 text-sm text-slate-700">
              {cliente.esCliente && cliente.esProveedor
                ? "Cliente y proveedor"
                : cliente.esProveedor
                  ? "Proveedor"
                  : "Cliente"}
              {cliente.tipo === "SOCIO_LM" ? " · Socio LM" : ""}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</p>
            <span
              className={`mt-0.5 inline-flex h-6 items-center border px-2 text-xs font-semibold ${
                cliente.activo
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-slate-50 text-slate-500"
              }`}
            >
              {cliente.activo ? "Activo" : "Inactivo"}
            </span>
          </div>
          {cliente.manejaAnticipo ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Anticipo
              </p>
              <p className="mt-0.5 text-sm text-emerald-700 font-semibold">Habilitado</p>
            </div>
          ) : null}
        </div>

        {puedeEditar ? (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Editar
          </button>
        ) : null}
      </div>

      {(cliente.contactoNombre || cliente.contactoEmail || cliente.contactoTel) ? (
        <div className="mt-3 border-t border-slate-100 pt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
          {cliente.contactoNombre ? (
            <span>
              <span className="font-medium text-slate-500">Contacto:</span>{" "}
              {cliente.contactoNombre}
            </span>
          ) : null}
          {cliente.contactoEmail ? (
            <span>
              <span className="font-medium text-slate-500">Email:</span>{" "}
              {cliente.contactoEmail}
            </span>
          ) : null}
          {cliente.contactoTel ? (
            <span>
              <span className="font-medium text-slate-500">Tel:</span>{" "}
              {cliente.contactoTel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton de la ficha: reserva alturas parecidas al contenido real para que
// el salto al llegar los datos sea mínimo (CLS medido antes: 0,25).
// ---------------------------------------------------------------------------

function SeccionSkeleton({ rows, cols, rowHeight }: { rows: number; cols: number; rowHeight?: number }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-32" />
      </div>
      <TableSkeleton rows={rows} cols={cols} rowHeight={rowHeight} />
    </div>
  );
}

function FichaSkeleton() {
  return (
    <section className="space-y-4" aria-busy="true" aria-label="Cargando ficha del cliente">
      {/* Cabecera: 4 datos en fila + línea de contacto (≈ 112 px). */}
      <div className="border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-6 w-56" />
            </div>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="h-3 w-12" />
                <Skeleton className="mt-2 h-5 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3">
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-28" />
      </div>
      {/* Funciones (filas altas), cuenta corriente (3 KPI + tabla) y las 4 tablas. */}
      <SeccionSkeleton rows={4} cols={3} rowHeight={72} />
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-96 max-w-full" />
        </div>
        <CardsSkeleton count={3} height={72} />
        <TableSkeleton rows={4} cols={4} />
      </div>
      <SeccionSkeleton rows={2} cols={3} />
      <SeccionSkeleton rows={4} cols={4} />
      <SeccionSkeleton rows={3} cols={6} />
      <SeccionSkeleton rows={3} cols={6} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Componente principal exportado
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

export function ClienteDetallePage({ clienteId }: { clienteId: string }) {
  // Editar cliente y tarifas pega a `PATCH /api/clientes/[id]` (solo ADMIN).
  const puedeEditar = useEsAdmin();
  const [cliente, setCliente] = useState<ClienteDetalle | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editModalOpen, setEditModalOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      try {
        const data = await fetchClienteDetalle(clienteId, controller.signal);
        setCliente(data);
        setLoadState("ready");
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "Error al cargar el cliente."));
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [clienteId, reloadKey]);

  const recargar = () => setReloadKey((k) => k + 1);

  if (loadState === "loading") {
    return <FichaSkeleton />;
  }

  if (loadState === "error" || !cliente) {
    return (
      <ModuleState
        type="error"
        title="No fue posible cargar el cliente"
        detail={loadError ?? undefined}
        action={{ label: "Reintentar", onClick: recargar }}
      />
    );
  }

  return (
    <section className="space-y-4">
      <ClienteCabecera
        cliente={cliente}
        puedeEditar={puedeEditar}
        onEdit={() => setEditModalOpen(true)}
      />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={recargar}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Refrescar
        </button>
      </div>

      <SeccionCapacidades clienteId={cliente.id} />

      <SeccionCuentaCorriente clienteId={cliente.id} />

      <SeccionTarifario clienteId={cliente.id} />

      {cliente.esProveedor ? <SeccionPagosProveedor empresaId={cliente.id} nombreEmpresa={cliente.nombre} /> : null}

      <SeccionTramites tramites={cliente.tramites} />

      <SeccionAnticipos anticipos={cliente.anticipos} />

      <SeccionFacturas facturas={cliente.facturas} />

      {editModalOpen && puedeEditar ? (
        <EditClienteModal
          cliente={cliente}
          onClose={() => setEditModalOpen(false)}
          onSaved={(updated) => {
            setCliente(updated);
            setEditModalOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}
