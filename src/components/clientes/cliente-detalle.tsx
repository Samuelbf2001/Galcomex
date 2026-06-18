"use client";

import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  ClientesApiError,
  fetchClienteDetalle,
  updateCliente,
  upsertTarifa,
  type AnticipoResumen,
  type ClienteDetalle,
  type FacturaResumen,
  type TarifaCliente,
  type TramiteResumen,
  type UpdateClienteInput,
} from "@/components/clientes/clientes-api";

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

function tipoLabel(tipo: string): string {
  const map: Record<string, string> = {
    por_contenedor: "Por contenedor",
    fijo: "Fijo",
    porcentaje_cif: "% sobre CIF",
  };
  return map[tipo] ?? tipo;
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
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
    };

    try {
      const updated = await updateCliente(cliente.id, input);
      onSaved({ ...cliente, ...updated });
    } catch (caught) {
      if (caught instanceof ClientesApiError && caught.details?.length) {
        setError(caught.details.map((d) => `${d.campo}: ${d.mensaje}`).join(" · "));
      } else {
        setError(caught instanceof Error ? caught.message : "No fue posible guardar los cambios.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-2xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Editar cliente</h2>
            <p className="mt-1 text-sm text-slate-500">{cliente.nombre}</p>
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
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Nombre / Razon social *</span>
              <input
                name="nombre"
                required
                defaultValue={cliente.nombre}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">NIT *</span>
              <input
                name="nit"
                required
                defaultValue={cliente.nit}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Tipo</span>
              <select
                name="tipo"
                defaultValue={cliente.tipo}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="PROPIO">Propio</option>
                <option value="SOCIO_LM">Socio LM</option>
              </select>
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-sm font-medium text-slate-700">Nombre contacto</span>
              <input
                name="contactoNombre"
                defaultValue={cliente.contactoNombre ?? ""}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Email contacto</span>
              <input
                name="contactoEmail"
                type="email"
                defaultValue={cliente.contactoEmail ?? ""}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Telefono contacto</span>
              <input
                name="contactoTel"
                defaultValue={cliente.contactoTel ?? ""}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="flex gap-6">
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
          </div>

          {error ? (
            <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
              disabled={isSubmitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Guardar cambios
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: modal agregar/editar tarifa
// ---------------------------------------------------------------------------

type TarifaModalProps = {
  clienteId: string;
  initial?: TarifaCliente;
  onClose: () => void;
  onSaved: (tarifas: TarifaCliente[]) => void;
};

function TarifaModal({ clienteId, initial, onClose, onSaved }: TarifaModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const fd = new FormData(e.currentTarget);
    const valorRaw = String(fd.get("valor") ?? "")
      .replace(/\./g, "")
      .replace(/,/g, "")
      .replace(/\$/g, "")
      .trim();

    const tarifa: TarifaCliente = {
      anio: Number(fd.get("anio") ?? new Date().getFullYear()),
      tipo: String(fd.get("tipo") ?? "fijo"),
      valor: valorRaw,
    };

    try {
      const updated = await upsertTarifa(clienteId, tarifa);
      onSaved(updated.tarifas);
    } catch (caught) {
      if (caught instanceof ClientesApiError && caught.details?.length) {
        setError(caught.details.map((d) => `${d.campo}: ${d.mensaje}`).join(" · "));
      } else {
        setError(caught instanceof Error ? caught.message : "No fue posible guardar la tarifa.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-md border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">
            {initial ? "Editar tarifa" : "Agregar tarifa"}
          </h2>
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
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Ano</span>
              <input
                name="anio"
                type="number"
                min="2020"
                max="2100"
                required
                defaultValue={initial?.anio ?? new Date().getFullYear()}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Tipo tarifa</span>
              <select
                name="tipo"
                defaultValue={initial?.tipo ?? "fijo"}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="fijo">Fijo</option>
                <option value="por_contenedor">Por contenedor</option>
                <option value="porcentaje_cif">% sobre CIF</option>
              </select>
            </label>
          </div>

          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Valor (COP) *</span>
            <input
              name="valor"
              required
              inputMode="numeric"
              defaultValue={initial?.valor ?? ""}
              placeholder="150000"
              className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
            />
          </label>

          {error ? (
            <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
              disabled={isSubmitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Guardar tarifa
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de tarifas
// ---------------------------------------------------------------------------

function SeccionTarifas({
  clienteId,
  tarifas,
  onTarifasChanged,
}: {
  clienteId: string;
  tarifas: TarifaCliente[];
  onTarifasChanged: (tarifas: TarifaCliente[]) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTarifa, setEditingTarifa] = useState<TarifaCliente | undefined>();

  function openEdit(tarifa: TarifaCliente) {
    setEditingTarifa(tarifa);
    setModalOpen(true);
  }

  function openNew() {
    setEditingTarifa(undefined);
    setModalOpen(true);
  }

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Tarifas ({tarifas.length})</p>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex h-9 items-center gap-2 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Agregar tarifa
        </button>
      </div>

      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="border-b border-slate-200 px-4 py-3">Ano</th>
            <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
            <th className="border-b border-slate-200 px-4 py-3 text-right">Valor (COP)</th>
            <th className="border-b border-slate-200 px-4 py-3 w-14"></th>
          </tr>
        </thead>
        <tbody>
          {tarifas.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                Sin tarifas registradas
              </td>
            </tr>
          ) : (
            tarifas.map((tarifa) => (
              <tr
                key={`${tarifa.anio}-${tarifa.tipo}`}
                className="border-b border-slate-100 last:border-b-0"
              >
                <td className="px-4 py-3 font-medium">{tarifa.anio}</td>
                <td className="px-4 py-3 text-slate-600">{tipoLabel(tarifa.tipo)}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900">
                  {formatCOP(tarifa.valor)}
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => openEdit(tarifa)}
                    className="inline-flex h-7 w-7 items-center justify-center text-slate-400 transition hover:text-cyan-700"
                    aria-label="Editar tarifa"
                    title="Editar tarifa"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {modalOpen ? (
        <TarifaModal
          clienteId={clienteId}
          initial={editingTarifa}
          onClose={() => setModalOpen(false)}
          onSaved={(updated) => {
            onTarifasChanged(updated);
            setModalOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: sección de tramites
// ---------------------------------------------------------------------------

function SeccionTramites({ tramites }: { tramites: TramiteResumen[] }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Tramites ({tramites.length})</p>
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
                Sin tramites registrados
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
                    aria-label={`Ver tramite ${tramite.consecutivo}`}
                    title="Ver tramite"
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
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
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
  onEdit,
}: {
  cliente: ClienteDetalle;
  onEdit: () => void;
}) {
  return (
    <div className="border border-slate-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Nombre / Razon social
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
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Tipo</p>
            <p className="mt-0.5 text-sm text-slate-700">
              {cliente.tipo === "SOCIO_LM" ? "Socio LM" : "Propio"}
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

        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Editar
        </button>
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
// Componente principal exportado
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

export function ClienteDetallePage({ clienteId }: { clienteId: string }) {
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
        setLoadError(caught instanceof Error ? caught.message : "Error al cargar el cliente.");
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [clienteId, reloadKey]);

  if (loadState === "loading") {
    return <ModuleState type="loading" title="Cargando ficha del cliente" />;
  }

  if (loadState === "error" || !cliente) {
    return (
      <ModuleState
        type="error"
        title="No fue posible cargar el cliente"
        detail={loadError ?? undefined}
      />
    );
  }

  return (
    <section className="space-y-4">
      <ClienteCabecera cliente={cliente} onEdit={() => setEditModalOpen(true)} />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Refrescar
        </button>
      </div>

      <SeccionTarifas
        clienteId={cliente.id}
        tarifas={cliente.tarifas}
        onTarifasChanged={(tarifas) => setCliente((prev) => (prev ? { ...prev, tarifas } : prev))}
      />

      <SeccionTramites tramites={cliente.tramites} />

      <SeccionAnticipos anticipos={cliente.anticipos} />

      <SeccionFacturas facturas={cliente.facturas} />

      {editModalOpen ? (
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
