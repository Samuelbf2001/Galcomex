"use client";

import { CheckCircle2, Loader2, Plus, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      .catch(() => {/* silencioso */});
  }, []);

  return rol;
}

import { ModuleState } from "@/components/layout/module-state";
import {
  ClientesApiError,
  createCliente,
  fetchClientes,
  type ClienteRow,
  type CreateClienteInput,
} from "@/components/clientes/clientes-api";

type LoadState = "loading" | "ready" | "error";

function optionalText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function ClientesWorkspace() {
  const userRol = useUserRol();
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
        setLoadError(caught instanceof Error ? caught.message : "Error al cargar clientes.");
        setLoadState("error");
      }
    }

    void load();
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Clientes</h1>
          <p className="mt-1 text-sm text-slate-600">
            Clientes propios y facturacion por socio LM.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Refrescar
          </button>
          {userRol === "ADMIN" ? (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo cliente
            </button>
          ) : null}
        </div>
      </div>

      {loadState === "loading" ? (
        <ModuleState type="loading" title="Cargando clientes" />
      ) : loadState === "error" ? (
        <ModuleState type="error" title="No se pudieron cargar los clientes" detail={loadError ?? undefined} />
      ) : (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-3">NIT</th>
                <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
                <th className="border-b border-slate-200 px-4 py-3">Contacto</th>
                <th className="border-b border-slate-200 px-4 py-3">Tarifas</th>
                <th className="border-b border-slate-200 px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody>
              {clientes.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>
                    Sin clientes registrados
                  </td>
                </tr>
              ) : (
                clientes.map((cliente) => (
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
                      {cliente.tipo === "SOCIO_LM" ? "Socio LM" : "Propio"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{cliente.contactoNombre ?? "-"}</td>
                    <td className="px-4 py-3">{cliente.tarifas.length}</td>
                    <td className="px-4 py-3">{cliente.activo ? "Activo" : "Inactivo"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <NuevoClienteModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          setReloadKey((k) => k + 1);
        }}
      />
    </section>
  );
}

function NuevoClienteModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
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
      setSuccess(`${created.nombre} creado`);
      form.reset();
      onCreated();
    } catch (caught) {
      if (caught instanceof ClientesApiError && caught.details?.length) {
        setError(caught.details.map((d) => `${d.campo}: ${d.mensaje}`).join(" · "));
      } else {
        setError(caught instanceof Error ? caught.message : "No fue posible crear el cliente.");
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
            <h2 className="text-lg font-semibold text-slate-950">Nuevo cliente</h2>
            <p className="mt-1 text-sm text-slate-500">
              Cliente propio de Galcomex o del socio Luis Martinez.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50"
            aria-label="Cerrar"
            title="Cerrar"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Nombre / Razon social</span>
              <input
                name="nombre"
                required
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">NIT</span>
              <input
                name="nit"
                required
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Tipo</span>
              <select
                name="tipo"
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="PROPIO">Propio</option>
                <option value="SOCIO_LM">Socio LM</option>
              </select>
            </label>
            <label className="space-y-1.5 md:col-span-2">
              <span className="text-sm font-medium text-slate-700">Contacto</span>
              <input
                name="contactoNombre"
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
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Telefono contacto</span>
              <input
                name="contactoTel"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <fieldset className="space-y-3 border border-slate-200 px-4 py-3">
            <legend className="px-1 text-xs font-semibold uppercase text-slate-500">
              Tarifa anual (opcional)
            </legend>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Ano</span>
                <input
                  name="tarifaAnio"
                  type="number"
                  min="2020"
                  max="2100"
                  defaultValue={new Date().getFullYear()}
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Tipo tarifa</span>
                <select
                  name="tarifaTipo"
                  className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
                >
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
                  placeholder="Dejar vacio si no aplica"
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>
            </div>
          </fieldset>

          <label className="flex items-center gap-2">
            <input name="manejaAnticipo" type="checkbox" defaultChecked className="h-4 w-4" />
            <span className="text-sm text-slate-700">Maneja anticipo</span>
          </label>

          {error ? (
            <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}
          {success ? (
            <div className="flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {success}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Cerrar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Crear cliente
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
