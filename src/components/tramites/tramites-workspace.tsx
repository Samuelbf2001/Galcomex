"use client";

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  X,
  FileText,
  Kanban,
  LayoutList,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { KanbanTramites } from "@/components/tramites/kanban-tramites";

import {
  createTramite,
  fetchClienteOptions,
  fetchTramites,
  type ClienteOption,
  type CreateTramiteInput,
  type TramiteRow,
} from "@/components/tramites/tramites-api";

type LoadState = "loading" | "ready" | "error";

type ClienteTipo = "PROPIO" | "SOCIO_LM";

const allFilter = "todos";

function normalizeFilter(value: string) {
  return value.trim().toLocaleLowerCase("es-CO");
}

function uniqueValues(rows: TramiteRow[], key: "estado" | "ciudad") {
  return Array.from(new Set(rows.map((row) => row[key]).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "es-CO"),
  );
}

function statusClassName(status: string) {
  const normalized = normalizeFilter(status);

  if (normalized.includes("cerr") || normalized.includes("fact")) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (normalized.includes("anul") || normalized.includes("cancel") || normalized.includes("error")) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (normalized.includes("pend") || normalized.includes("revision")) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  if (normalized.includes("proceso") || normalized.includes("activo") || normalized.includes("abier")) {
    return "border-cyan-200 bg-cyan-50 text-cyan-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-700";
}

function useTramites() {
  const [rows, setRows] = useState<TramiteRow[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetchTramites(controller.signal)
      .then((tramites) => {
        setRows(tramites);
        setState("ready");
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }

        setRows([]);
        setError(caught instanceof Error ? caught.message : "No fue posible cargar los tramites.");
        setState("error");
      });

    return () => controller.abort();
  }, [reloadKey]);

  return {
    error,
    reload: () => {
      setRows([]);
      setState("loading");
      setError(null);
      setReloadKey((key) => key + 1);
    },
    rows,
    state,
  };
}

function StateRow({
  colSpan,
  state,
  title,
  detail,
  onRetry,
}: {
  colSpan: number;
  state: "loading" | "error" | "empty";
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const Icon = state === "loading" ? Loader2 : state === "error" ? AlertTriangle : FileText;

  return (
    <tr>
      <td className="px-4 py-12 text-center" colSpan={colSpan}>
        <div className="mx-auto flex max-w-md flex-col items-center text-sm text-slate-600">
          <Icon
            className={`h-6 w-6 text-slate-500 ${state === "loading" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <p className="mt-3 font-medium text-slate-950">{title}</p>
          {detail ? <p className="mt-1">{detail}</p> : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-4 inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reintentar
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function formatDateInputAsIso(value: FormDataEntryValue | null) {
  const raw = String(value ?? "");

  if (!raw) {
    return null;
  }

  return new Date(`${raw}T00:00:00.000Z`).toISOString();
}

function optionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();

  return text ? text : null;
}

function CreateTramiteDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (tramite: TramiteRow) => void;
}) {
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [loadingClientes, setLoadingClientes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tipoCliente, setTipoCliente] = useState<ClienteTipo>("PROPIO");
  const [clienteId, setClienteId] = useState("");
  const [stagedFiles, setStagedFiles] = useState<Record<string, File | null>>({});

  const CATEGORIAS: { key: string; label: string }[] = [
    { key: "FACTURA_COMERCIAL",  label: "Factura comercial" },
    { key: "BL",                 label: "BL (Bill of Lading)" },
    { key: "PACKING_LIST",       label: "Packing list" },
    { key: "DECLARACION_DIAN",   label: "Declaración DIAN" },
    { key: "SOPORTE_FACTURACION",label: "Soporte facturación" },
    { key: "FOTO_RECONOCIMIENTO",label: "Foto reconocimiento" },
    { key: "COMPROBANTE_BANCARIO",label: "Comprobante bancario" },
    { key: "FACTURA_PROVEEDOR",  label: "Factura proveedor" },
    { key: "OTRO",               label: "Otro" },
  ];

  const clientesFiltrados = useMemo(
    () => clientes.filter((cliente) => cliente.tipo === tipoCliente),
    [clientes, tipoCliente],
  );

  const clienteSeleccionado = useMemo(
    () => clientesFiltrados.find((cliente) => cliente.id === clienteId) ?? null,
    [clientesFiltrados, clienteId],
  );

  function handleTipoClienteChange(next: ClienteTipo) {
    if (next === tipoCliente) {
      return;
    }

    setTipoCliente(next);
    // Resetea la seleccion para no dejar un cliente de tipo distinto al filtro.
    setClienteId("");
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();

    async function loadClientes() {
      setLoadingClientes(true);
      setError(null);
      setClienteId("");
      try {
        const options = await fetchClienteOptions(controller.signal);
        setClientes(options);
      } catch (caught: unknown) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }

        setError(caught instanceof Error ? caught.message : "No fue posible cargar clientes.");
      } finally {
        setLoadingClientes(false);
      }
    }

    void loadClientes();

    return () => controller.abort();
  }, [open]);

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
    const rawAnio = String(formData.get("anio") ?? "");
    const input: CreateTramiteInput = {
      ciudad: String(formData.get("ciudad") ?? ""),
      anio: rawAnio ? Number(rawAnio) : undefined,
      clienteId: String(formData.get("clienteId") ?? ""),
      proveedorCliente: optionalText(formData.get("proveedorCliente")),
      agenciaAduanas: String(formData.get("agenciaAduanas") ?? ""),
      doAgencia: optionalText(formData.get("doAgencia")),
      doCliente: optionalText(formData.get("doCliente")),
      eta: formatDateInputAsIso(formData.get("eta")),
    };

    try {
      const created = await createTramite(input);

      // Subir archivos adjuntos al DO recién creado
      const filePairs = Object.entries(stagedFiles).filter((e): e is [string, File] => e[1] !== null);
      for (const [categoria, file] of filePairs) {
        try {
          const urlRes = await fetch(`/api/tramites/${created.id}/documentos`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "uploadUrl",
              categoria,
              fileName: file.name,
              contentType: file.type || "application/octet-stream",
              sizeBytes: file.size,
            }),
          });
          if (!urlRes.ok) continue;
          const { uploadUrl } = (await urlRes.json()) as { uploadUrl: { url: string; key: string } };

          await fetch(uploadUrl.url, {
            method: "PUT",
            body: file,
            headers: { "content-type": file.type || "application/octet-stream" },
          });

          await fetch(`/api/tramites/${created.id}/documentos`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "register",
              categoria,
              nombreArchivo: file.name,
              storageKey: uploadUrl.key,
              mimeType: file.type || "application/octet-stream",
              tamanoBytes: file.size,
            }),
          });
        } catch {
          // No bloqueamos la creación del DO si falla un archivo
        }
      }

      setSuccess(`${created.doNumber} creado${filePairs.length > 0 ? ` · ${filePairs.length} archivo(s) adjunto(s)` : ""}`);
      onCreated(created);
      form.reset();
      setClienteId("");
      setTipoCliente("PROPIO");
      setStagedFiles({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No fue posible crear el tramite.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Crear tramite</h2>
            <p className="mt-1 text-sm text-slate-500">
              El consecutivo se asigna automaticamente por ciudad y ano.
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

        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 md:grid-cols-4">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Ciudad</span>
              <select
                name="ciudad"
                required
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="CTG">CTG</option>
                <option value="BAQ">BAQ</option>
                <option value="BUN">BUN</option>
                <option value="SMR">SMR</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Ano</span>
              <input
                name="anio"
                type="number"
                min="2020"
                max="2100"
                defaultValue={new Date().getFullYear()}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <div className="space-y-1.5 md:col-span-2">
              <span className="block text-sm font-medium text-slate-700" id="tipo-cliente-label">
                Tipo de cliente
              </span>
              {/* Toggle Galcomex (propio) / Con socio (Lucho) */}
              <div
                className="flex border border-slate-300 bg-white"
                role="group"
                aria-labelledby="tipo-cliente-label"
              >
                <button
                  type="button"
                  onClick={() => handleTipoClienteChange("PROPIO")}
                  aria-pressed={tipoCliente === "PROPIO"}
                  className={`inline-flex h-10 flex-1 items-center justify-center px-3 text-sm font-semibold transition ${
                    tipoCliente === "PROPIO"
                      ? "bg-slate-950 text-white"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Galcomex (propio)
                </button>
                <button
                  type="button"
                  onClick={() => handleTipoClienteChange("SOCIO_LM")}
                  aria-pressed={tipoCliente === "SOCIO_LM"}
                  className={`inline-flex h-10 flex-1 items-center justify-center border-l border-slate-300 px-3 text-sm font-semibold transition ${
                    tipoCliente === "SOCIO_LM"
                      ? "bg-slate-950 text-white"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Con socio (Lucho)
                </button>
              </div>

              <label className="block space-y-1.5">
                <span className="sr-only">Cliente</span>
                <select
                  name="clienteId"
                  required
                  disabled={loadingClientes}
                  value={clienteId}
                  onChange={(event) => setClienteId(event.target.value)}
                  className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600 disabled:bg-slate-100"
                >
                  <option value="">
                    {loadingClientes
                      ? "Cargando clientes"
                      : clientesFiltrados.length === 0
                        ? "Sin clientes de este tipo"
                        : "Seleccionar cliente"}
                  </option>
                  {clientesFiltrados.map((cliente) => (
                    <option key={cliente.id} value={cliente.id}>
                      {cliente.nombre} — {cliente.nit} ·{" "}
                      {cliente.tipo === "SOCIO_LM" ? "Socio Lucho" : "Propio"}
                    </option>
                  ))}
                </select>
              </label>

              {tipoCliente === "SOCIO_LM" || clienteSeleccionado?.tipo === "SOCIO_LM" ? (
                <p className="flex items-start gap-2 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  <Users className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Este DO sera operado por el socio Lucho y visible en su portal.
                </p>
              ) : (
                <p className="flex items-start gap-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  DO interno de Galcomex.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Agencia aduanas</span>
              <select
                name="agenciaAduanas"
                required
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
              >
                <option value="COLDEX">Coldex</option>
                <option value="MOVIADUANAS">Moviaduanas</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">DO agencia</span>
              <input
                name="doAgencia"
                placeholder="I########"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">DO cliente</span>
              <input
                name="doCliente"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Proveedor cliente</span>
              <input
                name="proveedorCliente"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">ETA</span>
              <input
                name="eta"
                type="date"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          </div>

          {/* Zona de adjuntos — uno por categoría */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-slate-700">Documentos adjuntos</span>
            <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
              {CATEGORIAS.map(({ key, label }) => {
                const file = stagedFiles[key] ?? null;
                const inputId = `adjunto-${key}`;
                return (
                  <li key={key} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-44 shrink-0 text-sm text-slate-600">{label}</span>
                    {file ? (
                      <>
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{file.name}</span>
                        <span className="shrink-0 text-xs text-slate-400">
                          {file.size < 1024 * 1024
                            ? `${(file.size / 1024).toFixed(0)} KB`
                            : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStagedFiles((prev) => ({ ...prev, [key]: null }))}
                          className="shrink-0 p-1 text-slate-400 transition hover:text-red-500"
                          aria-label={`Quitar ${label}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => document.getElementById(inputId)?.click()}
                          className="inline-flex items-center gap-1.5 border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-100"
                        >
                          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                          Seleccionar
                        </button>
                        <span className="text-xs text-slate-400">PDF, JPG, PNG, XLSX</span>
                      </>
                    )}
                    <input
                      id={inputId}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.xlsx"
                      className="sr-only"
                      onChange={(e) => {
                        const picked = e.target.files?.[0] ?? null;
                        if (picked) setStagedFiles((prev) => ({ ...prev, [key]: picked }));
                        e.target.value = "";
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {error ? (
            <div className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
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
              disabled={isSubmitting || loadingClientes}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Crear DO
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type ViewMode = "tabla" | "kanban";

export function TramitesWorkspace() {
  const { error, reload, rows, state } = useTramites();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [estado, setEstado] = useState(allFilter);
  const [ciudad, setCiudad] = useState(allFilter);
  const [viewMode, setViewMode] = useState<ViewMode>("tabla");

  const estados = useMemo(() => uniqueValues(rows, "estado"), [rows]);
  const ciudades = useMemo(() => uniqueValues(rows, "ciudad"), [rows]);

  const filteredRows = useMemo(() => {
    const query = normalizeFilter(search);
    const selectedEstado = normalizeFilter(estado);
    const selectedCiudad = normalizeFilter(ciudad);

    return rows.filter((row) => {
      const searchable = normalizeFilter(
        [
          row.doNumber,
          row.cliente,
          row.estado,
          row.ciudad,
          row.modalidad,
          row.referencia,
          row.responsable,
        ].join(" "),
      );
      const matchesSearch = query ? searchable.includes(query) : true;
      const matchesEstado =
        estado === allFilter ? true : normalizeFilter(row.estado) === selectedEstado;
      const matchesCiudad =
        ciudad === allFilter ? true : normalizeFilter(row.ciudad) === selectedCiudad;

      return matchesSearch && matchesEstado && matchesCiudad;
    });
  }, [ciudad, estado, rows, search]);

  const hasFilters = Boolean(search.trim()) || estado !== allFilter || ciudad !== allFilter;
  const isLoading = state === "loading";
  const isError = state === "error";
  const emptyTitle = hasFilters ? "Sin resultados para los filtros" : "Sin tramites registrados";
  const emptyDetail = hasFilters
    ? "Ajusta estado, ciudad o busqueda para ampliar la consulta."
    : "Cuando existan DOs, apareceran en esta tabla operativa.";

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Tramites</h1>
          <p className="mt-1 text-sm text-slate-600">
            Lista maestra de DOs, pipeline y detalle documental.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Toggle tabla / kanban */}
          <div className="flex border border-slate-300 bg-white">
            <button
              type="button"
              onClick={() => setViewMode("tabla")}
              title="Vista tabla"
              className={`inline-flex h-10 w-10 items-center justify-center transition ${
                viewMode === "tabla"
                  ? "bg-slate-950 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <LayoutList className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Vista tabla</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("kanban")}
              title="Vista kanban"
              className={`inline-flex h-10 w-10 items-center justify-center border-l border-slate-300 transition ${
                viewMode === "kanban"
                  ? "bg-slate-950 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Kanban className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Vista kanban</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-10 shrink-0 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Crear DO
          </button>
        </div>
      </div>

      <CreateTramiteDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(tramite) => {
          reload();
          router.push(`/tramites/${tramite.id}`);
        }}
      />

      <div className="border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">
          <SlidersHorizontal className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Filtros operativos
        </div>
        <div className="grid gap-3 px-4 py-3 xl:grid-cols-[minmax(280px,1fr)_minmax(240px,auto)_220px_auto]">
          <label className="relative block">
            <span className="sr-only">Buscar tramite</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por DO, cliente, referencia o responsable"
              className="h-10 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEstado(allFilter)}
              className={`h-9 border px-3 text-xs font-semibold transition ${
                estado === allFilter
                  ? "border-slate-950 bg-slate-950 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Todos {rows.length}
            </button>
            {estados.slice(0, 4).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setEstado(option)}
                className={`h-9 border px-3 text-xs font-semibold transition ${
                  estado === option
                    ? "border-cyan-700 bg-cyan-700 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <label>
            <span className="sr-only">Filtrar por ciudad</span>
            <select
              value={ciudad}
              onChange={(event) => setCiudad(event.target.value)}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            >
              <option value={allFilter}>Todas las ciudades</option>
              {ciudades.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              setSearch("");
              setEstado(allFilter);
              setCiudad(allFilter);
            }}
            className="inline-flex h-10 items-center justify-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Limpiar
          </button>
        </div>
      </div>

      {/* Vista Kanban */}
      {viewMode === "kanban" ? (
        <div>
          {isLoading ? (
            <div className="flex items-center gap-2 border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
              Cargando tramites...
            </div>
          ) : isError ? (
            <div className="flex items-center gap-3 border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
              <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">No se pudieron cargar los tramites</p>
                {error ? <p className="mt-0.5 text-xs">{error}</p> : null}
                <button type="button" onClick={reload} className="mt-2 text-xs underline hover:no-underline">
                  Reintentar
                </button>
              </div>
            </div>
          ) : (
            <KanbanTramites rows={filteredRows} onEstadoChanged={reload} />
          )}
        </div>
      ) : null}

      {/* Vista Tabla */}
      {viewMode === "tabla" ? (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
            <p className="font-semibold text-slate-900">DOs operativos</p>
            <p className="text-slate-500">
              {filteredRows.length} de {rows.length} visibles
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1080px] w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-3">DO</th>
                  <th className="border-b border-slate-200 px-4 py-3">Cliente</th>
                  <th className="border-b border-slate-200 px-4 py-3">Estado</th>
                  <th className="border-b border-slate-200 px-4 py-3">Ciudad</th>
                  <th className="border-b border-slate-200 px-4 py-3">Modalidad</th>
                  <th className="border-b border-slate-200 px-4 py-3">Referencia</th>
                  <th className="border-b border-slate-200 px-4 py-3">Apertura</th>
                  <th className="border-b border-slate-200 px-4 py-3">Movimiento</th>
                  <th className="border-b border-slate-200 px-4 py-3">Docs</th>
                  <th className="border-b border-slate-200 px-4 py-3">Responsable</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <StateRow
                    colSpan={10}
                    state="loading"
                    title="Cargando tramites"
                    detail="Consultando GET /api/tramites."
                  />
                ) : null}
                {isError ? (
                  <StateRow
                    colSpan={10}
                    state="error"
                    title="No se pudieron cargar los tramites"
                    detail={error ?? undefined}
                    onRetry={reload}
                  />
                ) : null}
                {!isLoading && !isError && filteredRows.length === 0 ? (
                  <StateRow colSpan={10} state="empty" title={emptyTitle} detail={emptyDetail} />
                ) : null}
                {!isLoading && !isError
                  ? filteredRows.map((tramite) => (
                      <tr
                        key={tramite.id}
                        className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">
                          <Link
                            href={`/tramites/${tramite.id}`}
                            className="text-cyan-700 hover:underline"
                          >
                            {tramite.doNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{tramite.cliente}</td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <span
                            className={`inline-flex h-7 items-center border px-2 text-xs font-semibold ${statusClassName(
                              tramite.estado,
                            )}`}
                          >
                            {tramite.estado}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.ciudad}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.modalidad}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{tramite.referencia}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.fechaApertura}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.ultimoMovimiento}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.documentosPendientes ?? "-"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                          {tramite.responsable}
                        </td>
                      </tr>
                    ))
                  : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
