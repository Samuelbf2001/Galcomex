"use client";

import { Loader2, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import {
  ClientesApiError,
  createCliente,
  erroresPorCampo,
  fetchClientes,
  type ClienteRow,
  type CreateClienteInput,
} from "@/components/clientes/clientes-api";
import { claseCampo, MensajeCampo } from "@/components/clientes/form-campos";
import { ModuleState } from "@/components/layout/module-state";
import { ModalShell } from "@/components/ui/modal-shell";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/** Cliente, proveedor o las dos cosas; y si su facturación va por el socio LM. */
function RolEmpresa({ cliente }: { cliente: { esCliente: boolean; esProveedor: boolean; tipo: string } }) {
  const rol =
    cliente.esCliente && cliente.esProveedor
      ? "Cliente y proveedor"
      : cliente.esProveedor
        ? "Proveedor"
        : "Cliente";
  const claseRol =
    cliente.esCliente && cliente.esProveedor
      ? "border-violet-200 bg-violet-50 text-violet-700"
      : cliente.esProveedor
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-cyan-200 bg-cyan-50 text-cyan-700";

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${claseRol}`}>{rol}</span>
      {cliente.tipo === "SOCIO_LM" ? (
        <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          Socio LM
        </span>
      ) : null}
    </span>
  );
}

export function ClientesWorkspace() {
  // Solo ADMIN crea clientes (`POST /api/clientes` → requireRole(["ADMIN"])).
  const esAdmin = useEsAdmin();
  const [clientes, setClientes] = useState<ClienteRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      try {
        const rows = await fetchClientes(controller.signal);
        setClientes(rows);
        setLoadState("ready");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        setLoadError(describirError(caught, "Error al cargar clientes."));
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [reloadKey]);

  const recargar = () => setReloadKey((k) => k + 1);

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Empresas</h1>
          <p className="mt-1 text-sm text-slate-600">
            Clientes, proveedores y las que son las dos cosas a la vez. Cada una con sus funciones encendidas.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={recargar}
            className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Refrescar
          </button>
          {esAdmin ? (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nueva empresa
            </button>
          ) : null}
        </div>
      </div>

      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={6} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No se pudieron cargar los clientes"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : clientes.length === 0 ? (
        <ModuleState
          type="empty"
          title="Aún no hay clientes."
          detail={
            esAdmin
              ? "Crea la primera con «Nueva empresa»."
              : "Un administrador puede crear la primera con «Nueva empresa»."
          }
          action={
            esAdmin
              ? { label: "Nueva empresa", onClick: () => setModalOpen(true), icon: false }
              : undefined
          }
        />
      ) : (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-3">NIT</th>
                <th className="border-b border-slate-200 px-4 py-3">Rol</th>
                <th className="border-b border-slate-200 px-4 py-3">Contacto</th>
                <th className="border-b border-slate-200 px-4 py-3">Tarifas</th>
                <th className="border-b border-slate-200 px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody>
              {clientes.map((cliente) => (
                <tr key={cliente.id} className="border-b border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/clientes/${cliente.id}`}
                      className="text-slate-900 underline-offset-2 hover:text-cyan-700 hover:underline"
                    >
                      {cliente.nombre}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{cliente.nit}</td>
                  <td className="px-4 py-3">
                    <RolEmpresa cliente={cliente} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{cliente.contactoNombre ?? "-"}</td>
                  <td className="px-4 py-3">{cliente.tarifas.length}</td>
                  <td className="px-4 py-3">{cliente.activo ? "Activo" : "Inactivo"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen ? (
        <NuevoClienteModal
          onClose={() => setModalOpen(false)}
          onCreated={() => {
            setModalOpen(false);
            recargar();
          }}
        />
      ) : null}
    </section>
  );
}

function NuevoClienteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrores({});
    setIsSubmitting(true);

    const form = event.currentTarget;
    const formData = new FormData(form);

    const tarifaValor = optionalText(formData.get("tarifaValor"));
    const tarifas =
      tarifaValor !== null
        ? [
            {
              anio: Number(formData.get("tarifaAnio") ?? new Date().getFullYear()),
              tipo: String(formData.get("tarifaTipo") ?? "fijo"),
              valor: tarifaValor.replace(/[^\d]/g, ""),
            },
          ]
        : [];

    const input: CreateClienteInput = {
      nombre: String(formData.get("nombre") ?? "").trim(),
      nit: String(formData.get("nit") ?? "").trim(),
      tipo: String(formData.get("tipo") ?? "PROPIO"),
      contactoNombre: optionalText(formData.get("contactoNombre")),
      contactoEmail: optionalText(formData.get("contactoEmail")),
      contactoTel: optionalText(formData.get("contactoTel")),
      manejaAnticipo: formData.get("manejaAnticipo") === "on",
      tarifas,
    };

    try {
      const created = await createCliente(input);
      toast({ title: "Cliente creado", description: created.nombre, variant: "success" });
      form.reset();
      onCreated();
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible crear el cliente.");
      if (caught instanceof ClientesApiError && caught.details?.length) {
        setErrores(erroresPorCampo(caught.details));
        setError("Revisa los campos marcados.");
      } else {
        setError(mensaje);
      }
      toast({ title: "No se pudo crear el cliente", description: mensaje, variant: "error" });
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
      title="Nueva empresa"
      description="Cliente propio de Galcomex o del socio Luis Martínez."
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
            Cerrar
          </button>
          <button
            type="submit"
            form={formId}
            disabled={isSubmitting}
            className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {isSubmitting ? "Creando…" : "Crear cliente"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Nombre / Razón social</span>
            <input
              name="nombre"
              required
              aria-invalid={campo("nombre").invalido || undefined}
              aria-describedby={campo("nombre").describedBy}
              className={claseCampo(campo("nombre").invalido)}
            />
            <MensajeCampo id={campo("nombre").errorId} error={errores.nombre} />
          </label>
          <label className="space-y-1.5">
            <span className="text-sm font-medium text-slate-700">NIT</span>
            <input
              name="nit"
              required
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
              aria-invalid={campo("tipo").invalido || undefined}
              className={claseCampo(campo("tipo").invalido, "bg-white")}
            >
              <option value="PROPIO">Propio</option>
              <option value="SOCIO_LM">Socio LM</option>
            </select>
            <MensajeCampo id={campo("tipo").errorId} error={errores.tipo} />
          </label>
          <label className="space-y-1.5 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Contacto</span>
            <input
              name="contactoNombre"
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
              aria-invalid={campo("contactoTel").invalido || undefined}
              aria-describedby={campo("contactoTel").describedBy}
              className={claseCampo(campo("contactoTel").invalido)}
            />
            <MensajeCampo id={campo("contactoTel").errorId} error={errores.contactoTel} />
          </label>
        </div>

        <fieldset
          className={`space-y-3 border px-4 py-3 ${
            errores.tarifas ? "border-rose-300" : "border-slate-200"
          }`}
        >
          <legend className="px-1 text-xs font-semibold uppercase text-slate-500">
            Tarifa anual (opcional)
          </legend>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Año</span>
              <input
                name="tarifaAnio"
                type="number"
                min="2020"
                max="2100"
                defaultValue={new Date().getFullYear()}
                className={claseCampo(false)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Tipo tarifa</span>
              <select name="tarifaTipo" className={claseCampo(false, "bg-white")}>
                <option value="fijo">Fijo</option>
                <option value="por_contenedor">Por contenedor</option>
                <option value="porcentaje_cif">% sobre CIF</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Valor (COP)</span>
              <input
                name="tarifaValor"
                inputMode="numeric"
                placeholder="Dejar vacío si no aplica"
                aria-invalid={campo("tarifas").invalido || undefined}
                aria-describedby={campo("tarifas").describedBy}
                className={claseCampo(campo("tarifas").invalido)}
              />
            </label>
          </div>
          <MensajeCampo id={campo("tarifas").errorId} error={errores.tarifas} />
        </fieldset>

        <label className="flex items-center gap-2">
          <input name="manejaAnticipo" type="checkbox" defaultChecked className="h-4 w-4" />
          <span className="text-sm text-slate-700">Maneja anticipo</span>
        </label>

        {error ? (
          <div
            role="alert"
            className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </div>
        ) : null}
      </form>
    </ModalShell>
  );
}
