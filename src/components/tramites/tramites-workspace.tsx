"use client";

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { KanbanTramites } from "@/components/tramites/kanban-tramites";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { Paginacion } from "@/components/ui/paginacion";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin, usePermiso } from "@/lib/auth/rol-context";

import {
  CODIGO_TARIFA_VIGENTE_REQUERIDA,
  createTramite,
  ETIQUETA_DOCUMENTO_OBLIGATORIO,
  fetchClienteOptions,
  fetchRequisitosDo,
  fetchTiposTramiteEmpresa,
  type ReglaAgenciaEmpresa,
  fetchTramitesPage,
  TRAMITES_PAGE_SIZE,
  TramitesApiError,
  type ClienteOption,
  type CreateTramiteInput,
  type DocumentoObligatorioCodigo,
  type FacturadoFilter,
  type RequisitosDo,
  type TipoTramiteOption,
  type TramiteFilters,
  type TramiteRow,
} from "@/components/tramites/tramites-api";
import { ACCEPTED_FILE_EXTENSIONS_ATTR, ALLOWED_FILE_TYPES_LABEL } from "@/lib/storage/config";

type LoadState = "loading" | "ready" | "error";

const AGENCIA_LABEL: Record<string, string> = {
  COLDEX: "Coldex",
  MOVIADUANAS: "Moviaduanas",
  AR_LOGISTY: "AR Logisty",
  CORTES: "Cortes",
};

/** Convierte una expresión regular sencilla en una pista legible (^I\d{8}$ → I########). */
function pistaFormato(regex: string): string {
  return regex
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\d\{(\d+)\}/g, (_, n: string) => "#".repeat(Number(n)))
    .replace(/\\d/g, "#");
}

/** POST /api/tramites exige ADMIN/REVISOR/OPERATIVO (SOCIO solo consulta). */
const ROLES_CREAR_DO = ["ADMIN", "REVISOR", "OPERATIVO"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ClienteTipo = "PROPIO" | "SOCIO_LM";

const allFilter = "todos";

// Valores fijos de los enums Ciudad y EstadoTramite (prisma/schema.prisma).
// No se derivan de las filas cargadas porque el filtrado ahora es server-side:
// las filas ya vienen filtradas, asi que las opciones se verian recortadas.
const CIUDADES_TRAMITE = ["BAQ", "CTG", "BUN", "SMR", "BGT"] as const;
const ESTADOS_TRAMITE = [
  "SOLICITUD",
  "APERTURA",
  "EN_TRAMITE",
  "EN_PUERTO",
  "DESPACHADO",
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
  "CERRADO",
] as const;

function normalizeFilter(value: string) {
  return value.trim().toLocaleLowerCase("es-CO");
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

type ResultadoTramites = {
  /** Clave de filtros+página+recarga a la que pertenece este resultado. */
  key: string;
  rows: TramiteRow[];
  total: number;
  error: string | null;
};

/**
 * Trae UNA página de trámites (`take`/`skip`) para una combinación de
 * filtros. El estado de carga se DERIVA: si el último resultado no
 * corresponde a la clave actual (filtros + página + tamaño + recarga),
 * estamos cargando. Así el efecto no llama a setState de forma síncrona
 * (react-hooks/set-state-in-effect).
 *
 * `activo=false` no dispara la petición — la vista kanban la usa para no
 * traer su propia página mientras no es la vista visible.
 */
function useTramitesResultado(
  filters: TramiteFilters,
  page: { take: number; skip: number },
  activo: boolean,
  reloadSignal: number,
) {
  const [resultado, setResultado] = useState<ResultadoTramites | null>(null);

  const key = JSON.stringify([
    filters.q ?? "",
    filters.estado ?? "",
    filters.ciudad ?? "",
    filters.clienteId ?? "",
    filters.tipoCliente ?? "",
    filters.facturado ?? "",
    page.take,
    page.skip,
    reloadSignal,
  ]);

  // Una recarga explícita (botón "Reintentar" o justo después de crear un DO)
  // descarta las filas previas para que se vea el skeleton, no una
  // actualización silenciosa. Reset en async para evitar el warning de
  // react-hooks/set-state-in-effect (mismo idioma que seccion-documentos.tsx).
  useEffect(() => {
    Promise.resolve().then(() => setResultado(null));
  }, [reloadSignal]);

  useEffect(() => {
    if (!activo) return;

    const controller = new AbortController();

    fetchTramitesPage(controller.signal, filters, page)
      .then((result) => {
        setResultado({ key, rows: result.rows, total: result.total, error: null });
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }

        setResultado({
          key,
          rows: [],
          total: 0,
          error: caught instanceof Error ? caught.message : "No fue posible cargar los trámites.",
        });
      });

    return () => controller.abort();
    // `key` ya resume filtros+página+recarga; `filters`/`page` son el mismo
    // objeto que produjo esa clave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, activo]);

  const actual = resultado?.key === key ? resultado : null;
  const state: LoadState = actual ? (actual.error ? "error" : "ready") : "loading";
  // Mientras llega la página nueva se conservan las filas anteriores (recarga
  // secundaria); tras un error, una recarga explícita o en la primera carga
  // no hay filas.
  const rows = actual ? actual.rows : (resultado?.rows ?? []);
  const total = actual ? actual.total : (resultado?.total ?? 0);
  const error = actual?.error ?? null;

  return { error, rows, state, total };
}

/**
 * Sube un adjunto al DO recién creado (enlace firmado → PUT a la bodega →
 * registro). Cualquier paso fallido lanza para que el llamador lo cuente.
 */
async function subirAdjuntoDO(tramiteId: string, categoria: string, file: File): Promise<void> {
  const contentType = file.type || "application/octet-stream";
  const urlRes = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      action: "uploadUrl",
      categoria,
      carpeta: "documentos-adjuntos",
      fileName: file.name,
      contentType,
      sizeBytes: file.size,
    }),
  });
  if (!urlRes.ok) {
    throw new Error(`No se obtuvo URL de subida (${urlRes.status}).`);
  }
  const urlPayload: unknown = await urlRes.json().catch(() => null);
  if (!isRecord(urlPayload) || !isRecord(urlPayload.uploadUrl)) {
    throw new Error("Respuesta de URL de subida no válida.");
  }
  const uploadUrl = String(urlPayload.uploadUrl.uploadUrl ?? "");
  const storageKey = String(urlPayload.uploadUrl.storageKey ?? "");
  if (!uploadUrl || !storageKey) {
    throw new Error("Respuesta de URL de subida incompleta.");
  }

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": contentType },
  });
  if (!putRes.ok) {
    throw new Error(`Fallo al subir el archivo (${putRes.status}).`);
  }

  const registerRes = await fetch(`/api/tramites/${tramiteId}/documentos`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      action: "register",
      categoria,
      nombreArchivo: file.name,
      storageKey,
      mimeType: contentType,
      tamanoBytes: file.size,
    }),
  });
  if (!registerRes.ok) {
    throw new Error(`No se pudo registrar el adjunto (${registerRes.status}).`);
  }
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

/** Cómo se nombra un documento obligatorio dentro de una frase ("Adjunta el BL…"). */
const FRASE_DOCUMENTO: Record<DocumentoObligatorioCodigo, string> = {
  BL: "el BL",
  FACTURA_COMERCIAL: "la factura comercial",
};

/** "Adjunta el BL y la factura comercial para crear este DO." — solo los que faltan. */
function mensajeDocumentosFaltantes(faltantes: DocumentoObligatorioCodigo[]): string {
  const partes = faltantes.map((categoria) => FRASE_DOCUMENTO[categoria]);
  const lista =
    partes.length <= 1 ? partes.join("") : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;

  return `Adjunta ${lista} para crear este DO.`;
}

export function CreateTramiteDialog({
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
  // Tipos de trámite disponibles PARA ESTA EMPRESA (M4): el backend ya filtra
  // por capacidad, así que aquí solo llegan los que se pueden abrir. Se guarda
  // junto al clienteId que los produjo para no mostrar los del cliente anterior
  // mientras llega la respuesta nueva.
  const [tiposCargados, setTiposCargados] = useState<{
    clienteId: string;
    tipos: TipoTramiteOption[];
    reglaAgencia: ReglaAgenciaEmpresa | null;
  }>({ clienteId: "", tipos: [], reglaAgencia: null });
  const [tipoElegido, setTipoElegido] = useState("");
  const [tiposError, setTiposError] = useState<{ clienteId: string; message: string } | null>(null);
  const [tiposReload, setTiposReload] = useState(0);
  const cargandoTipos = Boolean(clienteId) && tiposCargados.clienteId !== clienteId && tiposError?.clienteId !== clienteId;
  const errorTiposActual = tiposError?.clienteId === clienteId ? tiposError.message : null;
  const { toast } = useToast();
  const esAdmin = useEsAdmin();

  const CATEGORIAS: { key: string; label: string }[] = [
    { key: "FACTURA_COMERCIAL",  label: "Factura comercial" },
    { key: "BL",                 label: "BL (Bill of Lading)" },
    { key: "PACKING_LIST",       label: "Packing list" },
    { key: "DECLARACION_DIAN",   label: "Declaración DIAN" },
    { key: "SOPORTE_FACTURACION",label: "Soporte facturación" },
    { key: "FOTO_RECONOCIMIENTO",label: "Foto reconocimiento" },
    { key: "COMPROBANTE_BANCARIO",label: "Comprobante bancario" },
    { key: "COMPROBANTE_COMERCIO",label: "Comprobante de comercio exterior" },
    { key: "FACTURA_PROVEEDOR",  label: "Factura proveedor" },
    { key: "CONTROL_TRAMITE",    label: "Control del trámite" },
    { key: "FICHA_TECNICA",      label: "Documentación técnica del producto" },
    { key: "CORRESPONDENCIA",    label: "Correos y notificaciones" },
    { key: "ORDEN_COMPRA",       label: "Orden de compra" },
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

  const tiposTramite = useMemo(
    () => (tiposCargados.clienteId === clienteId ? tiposCargados.tipos : []),
    [tiposCargados, clienteId],
  );

  // El tipo efectivo se DERIVA: si lo elegido ya no está disponible (cambió la
  // empresa), cae al primero de la lista. Así no hay que sincronizar estado
  // desde un efecto.
  const tipoTramiteSeleccionado = useMemo(
    () =>
      tiposTramite.find((tipo) => tipo.codigo === tipoElegido) ??
      tiposTramite[0] ??
      null,
    [tiposTramite, tipoElegido],
  );

  const tipoTramiteCodigo = tipoTramiteSeleccionado?.codigo ?? "IMPORTACION";

  // Requisitos del DO (D1 tarifa vigente, D2 documentos obligatorios): se
  // consultan en cuanto hay empresa + tipo de trámite elegidos. El estado de
  // carga se DERIVA igual que `tiposCargados` arriba: si el último resultado
  // no corresponde a la clave actual (empresa + tipo), estamos cargando.
  const [requisitosResultado, setRequisitosResultado] = useState<{
    key: string;
    data: RequisitosDo | null;
    error: string | null;
  } | null>(null);
  const requisitosKey = clienteId ? `${clienteId}::${tipoTramiteCodigo}` : "";
  const requisitosActual = requisitosResultado?.key === requisitosKey ? requisitosResultado : null;
  const requisitosLoading = Boolean(clienteId) && !requisitosActual;
  const requisitos = requisitosActual?.data ?? null;

  useEffect(() => {
    if (!open || !clienteId) {
      return;
    }

    const controller = new AbortController();
    // Pequeño debounce: evita dos peticiones seguidas cuando cambiar de
    // empresa también cambia el tipo de trámite por defecto.
    const timeout = setTimeout(() => {
      fetchRequisitosDo(clienteId, tipoTramiteCodigo, controller.signal)
        .then((data) => {
          setRequisitosResultado({ key: requisitosKey, data, error: null });
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === "AbortError") return;
          setRequisitosResultado({
            key: requisitosKey,
            data: null,
            error: describirError(caught, "No se pudo consultar la tarifa vigente de esta empresa."),
          });
        });
    }, 300);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requisitosKey]);

  // Qué campos pide el formulario lo decide el tipo de trámite, no un if por
  // cliente. Sin tipo cargado todavía se asume el comportamiento histórico.
  const pideAgencia = tipoTramiteSeleccionado?.requiereAgenciaAduanas ?? true;
  // Agencia fija de la empresa (Litoplas → Moviaduanas): queda puesta y bloqueada.
  const agenciaFija =
    tiposCargados.clienteId === clienteId ? tiposCargados.reglaAgencia : null;
  const pideEta = tipoTramiteSeleccionado?.requiereEta ?? true;
  const etiquetaReferencia = tipoTramiteSeleccionado?.etiquetaReferenciaExterna ?? null;

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

  // Los tipos disponibles dependen de la empresa: la clasificación arancelaria
  // solo aparece si esa empresa tiene la capacidad encendida.
  useEffect(() => {
    if (!open || !clienteId) {
      return;
    }

    const controller = new AbortController();

    fetchTiposTramiteEmpresa(clienteId, controller.signal)
      .then(({ tipos, reglaAgencia }) => {
        setTiposCargados({ clienteId, tipos, reglaAgencia });
        setTiposError(null);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setTiposError({ clienteId, message: describirError(caught, "No se pudieron cargar los tipos de trámite de esta empresa.") });
      });

    return () => controller.abort();
  }, [open, clienteId, tiposReload]);

  if (!open) {
    return null;
  }

  // D2: qué documentos exige ESTE trámite (empresa + tipo), no el tipo de
  // cliente — ver `documentosObligatorios.requeridos` de `GET
  // /api/tramites/requisitos` (invariante 7: cero ramas por TipoCliente).
  const documentosRequeridos = requisitos?.documentosObligatorios.requeridos ?? [];
  const documentosFaltantes = documentosRequeridos.filter((categoria) => {
    const file = stagedFiles[categoria];
    return file === null || file === undefined;
  });
  const missingRequiredDocs = documentosFaltantes.length > 0;
  // D1: sin tarifa vigente no se puede crear el DO.
  const bloqueadoPorTarifa = Boolean(
    requisitos && requisitos.tarifaVigente.requerida && !requisitos.tarifaVigente.cumple,
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (isSubmitting || cargandoTipos || errorTiposActual || !clienteId || tiposTramite.length === 0) return;
    if (bloqueadoPorTarifa) return;
    if (missingRequiredDocs) {
      setError(mensajeDocumentosFaltantes(documentosFaltantes));
      return;
    }

    setIsSubmitting(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const rawAnio = String(formData.get("anio") ?? "");
    const input: CreateTramiteInput = {
      ciudad: String(formData.get("ciudad") ?? ""),
      anio: rawAnio ? Number(rawAnio) : undefined,
      clienteId: String(formData.get("clienteId") ?? ""),
      tipoTramiteCodigo,
      referenciaExterna: etiquetaReferencia
        ? optionalText(formData.get("referenciaExterna"))
        : undefined,
      agenciaAduanas: pideAgencia
        ? (agenciaFija?.agencia ?? String(formData.get("agenciaAduanas") ?? ""))
        : undefined,
      doAgencia: optionalText(formData.get("doAgencia")),
      doCliente: optionalText(formData.get("doCliente")),
      // TODO(invariante 7): ramifica por TipoCliente (SOCIO_LM) para decidir
      // si se pide ETA; migrar a una capacidad cuando se aborde el resto de
      // las 131 ramas vivas (ver CLAUDE.md).
      eta:
        pideEta && clienteSeleccionado?.tipo !== "SOCIO_LM"
          ? formatDateInputAsIso(formData.get("eta"))
          : undefined,
    };

    try {
      const created = await createTramite(input);

      // Subir archivos adjuntos al DO recién creado. Un adjunto fallido no
      // bloquea el DO, pero sí se informa cuántos quedaron sin subir.
      const filePairs = Object.entries(stagedFiles).filter((e): e is [string, File] => e[1] !== null);
      let adjuntosFallidos = 0;
      for (const [categoria, file] of filePairs) {
        try {
          await subirAdjuntoDO(created.id, categoria, file);
        } catch {
          adjuntosFallidos += 1;
        }
      }

      const adjuntosOk = filePairs.length - adjuntosFallidos;
      setSuccess(
        `${created.doNumber} creado${adjuntosOk > 0 ? ` · ${adjuntosOk} archivo(s) adjunto(s)` : ""}`,
      );
      if (adjuntosFallidos > 0) {
        toast({
          title: `DO creado, pero ${adjuntosFallidos} adjunto(s) no se subieron`,
          description: "Puedes volver a subirlos desde la pestaña Documentos del DO.",
          variant: "error",
        });
      } else {
        toast({ title: `DO ${created.doNumber} creado`, variant: "success" });
      }
      onCreated(created);
      form.reset();
      setClienteId("");
      setTipoCliente("PROPIO");
      setStagedFiles({});
    } catch (caught) {
      setError(describirError(caught, "No fue posible crear el trámite."));

      // Carrera: el servidor confirma que ya no hay tarifa vigente aunque el
      // panel decía lo contrario (se publicó/venció justo ahora). Refresca los
      // requisitos para que el panel ámbar y sus acciones queden al día.
      if (caught instanceof TramitesApiError && caught.codigo === CODIGO_TARIFA_VIGENTE_REQUERIDA) {
        fetchRequisitosDo(clienteId, tipoTramiteCodigo)
          .then((data) => setRequisitosResultado({ key: requisitosKey, data, error: null }))
          .catch(() => {
            // Sin refresco al menos queda el mensaje del 422 en el banner de error.
          });
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Crear trámite"
      description={
        tipoTramiteSeleccionado && tipoTramiteSeleccionado.codigo !== "IMPORTACION"
          ? `Consecutivo propio con prefijo ${tipoTramiteSeleccionado.prefijoConsecutivo}: no consume numeración de importación.`
          : "El consecutivo se asigna automáticamente por ciudad y año."
      }
      size="xl"
      dismissible={!isSubmitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
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
                <option value="BGT">BGT</option>
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Año</span>
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
                  Este DO será operado por el socio Lucho y visible en su portal.
                </p>
              ) : (
                <p className="flex items-start gap-2 border-l-2 border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
                  <Building2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  DO interno de Galcomex.
                </p>
              )}
            </div>
          </div>

          {cargandoTipos ? <p role="status" className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Cargando opciones de la empresa…</p> : errorTiposActual ? <ModuleState type="error" title="No pudimos cargar las opciones del trámite" detail={errorTiposActual} action={{ label: "Reintentar", onClick: () => { setTiposError(null); setTiposReload((value) => value + 1); } }} /> : clienteId && tiposTramite.length === 0 ? <ModuleState type="empty" title="Esta empresa no tiene tipos de trámite habilitados" detail="Un administrador puede habilitarlos en la ficha de la empresa." /> : null}
          {/* Tipo de trámite (M4): solo aparece si la empresa puede abrir más
              de uno. Decide qué campos pide el resto del formulario. */}
          {tiposTramite.length > 1 ? (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-slate-700" id="tipo-tramite-label">
                Tipo de trámite
              </span>
              <div
                className="flex border border-slate-300 bg-white"
                role="group"
                aria-labelledby="tipo-tramite-label"
              >
                {tiposTramite.map((tipo) => (
                  <button
                    key={tipo.codigo}
                    type="button"
                    onClick={() => setTipoElegido(tipo.codigo)}
                    aria-pressed={tipoTramiteCodigo === tipo.codigo}
                    className={`inline-flex h-10 flex-1 items-center justify-center px-3 text-sm font-semibold transition first:border-l-0 border-l border-slate-300 ${
                      tipoTramiteCodigo === tipo.codigo
                        ? "bg-slate-950 text-white"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {tipo.nombre}
                  </button>
                ))}
              </div>
              {tipoTramiteSeleccionado?.descripcion ? (
                <p className="text-xs text-slate-500">
                  {tipoTramiteSeleccionado.descripcion}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* D1: tarifa vigente — sin ella el servidor no crea el DO. */}
          {clienteId && requisitosLoading ? (
            <p role="status" className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Comprobando tarifa vigente…
            </p>
          ) : null}
          {bloqueadoPorTarifa && requisitos ? (
            <div
              role="alert"
              className="space-y-2 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {requisitos.tarifaVigente.mensaje ??
                  `${clienteSeleccionado?.nombre ?? "Esta empresa"} no tiene una tarifa vigente para esta línea. Sin tarifa no se puede crear el DO.`}
              </p>
              {esAdmin ? (
                requisitos.tarifaVigente.tarifarioPropioHabilitado ? (
                  <Link
                    href={`/clientes/${clienteId}?abrir=tarifas`}
                    onClick={onClose}
                    className="inline-flex h-9 items-center border border-amber-400 bg-white px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100"
                  >
                    Crear tarifa
                  </Link>
                ) : (
                  <Link
                    href={`/clientes/${clienteId}?abrir=funciones`}
                    onClick={onClose}
                    className="inline-flex h-9 items-center border border-amber-400 bg-white px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100"
                  >
                    Activar «Tarifario propio»
                  </Link>
                )
              ) : (
                <p>Pídele a Camila que publique la tarifa de esta empresa.</p>
              )}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-3">
            {pideAgencia ? (
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Agencia aduanas</span>
                {agenciaFija?.agencia ? (
                  <>
                    <div
                      className="flex h-10 w-full items-center border border-emerald-200 bg-emerald-50 px-3 text-sm font-medium text-emerald-800"
                      title={agenciaFija.mensajeAgencia ?? undefined}
                    >
                      {AGENCIA_LABEL[agenciaFija.agencia] ?? agenciaFija.agencia}
                    </div>
                    <span className="block text-xs text-slate-500">
                      Fija para esta empresa (pestaña Funciones de la ficha).
                    </span>
                  </>
                ) : (
                  <select
                    name="agenciaAduanas"
                    required
                    className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
                  >
                    <option value="COLDEX">Coldex</option>
                    <option value="MOVIADUANAS">Moviaduanas</option>
                    <option value="AR_LOGISTY">AR Logisty</option>
                    <option value="CORTES">Cortes</option>
                  </select>
                )}
              </label>
            ) : null}
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">DO agencia</span>
              <input
                name="doAgencia"
                placeholder={agenciaFija?.formatoDoAgencia ? pistaFormato(agenciaFija.formatoDoAgencia) : "I########"}
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
              {agenciaFija?.formatoDoAgencia ? (
                <span className="block text-xs text-slate-500">
                  {agenciaFija.mensajeFormato ?? `Formato exigido: ${pistaFormato(agenciaFija.formatoDoAgencia)}`}
                </span>
              ) : null}
            </label>
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">DO cliente</span>
              <input
                name="doCliente"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            {etiquetaReferencia ? (
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  {etiquetaReferencia}
                </span>
                <input
                  name="referenciaExterna"
                  placeholder="2140"
                  className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
                />
              </label>
            ) : null}
          </div>

          {pideEta && clienteSeleccionado?.tipo !== "SOCIO_LM" ? (
            <label className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">ETA</span>
              <input
                name="eta"
                type="date"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
          ) : null}

          {/* D2: documentos obligatorios — los exige el trámite (empresa +
              tipo), no el tipo de cliente. */}
          {documentosRequeridos.length > 0 ? (
            <div className="space-y-2">
              <span className="text-sm font-medium text-slate-700">
                Documentos obligatorios{" "}
                <span className="text-xs font-normal text-rose-600">(obligatorio para este trámite)</span>
              </span>
              <ul className="divide-y divide-slate-100 border border-rose-200 bg-rose-50">
                {documentosRequeridos.map((key) => {
                  const label = ETIQUETA_DOCUMENTO_OBLIGATORIO[key];
                  const file = stagedFiles[key] ?? null;
                  const inputId = `req-adjunto-${key}`;
                  return (
                    <li key={key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="w-full sm:w-44 shrink-0 text-sm font-medium text-rose-700">{label} *</span>
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
                            className="inline-flex items-center gap-1.5 border border-rose-300 bg-white px-2.5 py-1 text-xs text-rose-700 transition hover:bg-rose-50"
                          >
                            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                            Seleccionar
                          </button>
                          <span className="text-xs text-rose-500">Obligatorio</span>
                        </>
                      )}
                      <input
                        id={inputId}
                        type="file"
                        accept={ACCEPTED_FILE_EXTENSIONS_ATTR}
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
          ) : null}

          {/* Zona de adjuntos — uno por categoría */}
          <div className="space-y-2">
            <span className="text-sm font-medium text-slate-700">Documentos adjuntos</span>
            <ul className="divide-y divide-slate-100 border border-slate-200 bg-white">
              {CATEGORIAS.filter(({ key }) => !documentosRequeridos.includes(key as DocumentoObligatorioCodigo)).map(({ key, label }) => {
                const file = stagedFiles[key] ?? null;
                const inputId = `adjunto-${key}`;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="w-full sm:w-44 shrink-0 text-sm text-slate-600">{label}</span>
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
                        <span className="text-xs text-slate-400">{ALLOWED_FILE_TYPES_LABEL}</span>
                      </>
                    )}
                    <input
                      id={inputId}
                      type="file"
                      accept={ACCEPTED_FILE_EXTENSIONS_ATTR}
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
            <div role="alert" className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cerrar
            </button>
            <button
              type="submit"
              disabled={
                isSubmitting ||
                loadingClientes ||
                cargandoTipos ||
                Boolean(errorTiposActual) ||
                !clienteId ||
                tiposTramite.length === 0 ||
                requisitosLoading ||
                bloqueadoPorTarifa ||
                missingRequiredDocs
              }
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {isSubmitting ? "Creando trámite…" : "Crear DO"}
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

type ViewMode = "tabla" | "kanban";

export function TramitesWorkspace() {
  const router = useRouter();
  const puedeCrearDO = usePermiso(ROLES_CREAR_DO);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [estado, setEstado] = useState(allFilter);
  const [ciudad, setCiudad] = useState(allFilter);
  const [clienteId, setClienteId] = useState(allFilter);
  const [tipoCliente, setTipoCliente] = useState(allFilter);
  const [facturado, setFacturado] = useState<FacturadoFilter>("todos");
  const [viewMode, setViewMode] = useState<ViewMode>("tabla");
  const [filterClientes, setFilterClientes] = useState<ClienteOption[]>([]);
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(25);
  const [reloadSignal, setReloadSignal] = useState(0);
  const tablaRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => setReloadSignal((s) => s + 1), []);

  // Cambiar de página desplaza el listado a la vista (si quedó scrolleado
  // hacia abajo, la página nueva se ve desde el principio).
  function handlePaginaChange(next: number) {
    setPagina(next);
    tablaRef.current?.scrollIntoView?.({ block: "start" });
  }

  // Debounce del texto de busqueda para no re-consultar por cada tecla.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timeout);
  }, [search]);

  // Clientes para el select del filtro (independiente del dialogo de creacion).
  useEffect(() => {
    const controller = new AbortController();

    fetchClienteOptions(controller.signal)
      .then(setFilterClientes)
      .catch(() => {
        // El filtro por cliente es un extra; si falla la carga, el select queda vacio.
      });

    return () => controller.abort();
  }, []);

  const filters = useMemo<TramiteFilters>(
    () => ({
      q: debouncedSearch,
      estado,
      ciudad,
      clienteId,
      tipoCliente,
      facturado,
    }),
    [debouncedSearch, estado, ciudad, clienteId, tipoCliente, facturado],
  );

  // Cambiar cualquier filtro o la búsqueda vuelve a la página 1: el rango
  // visible de antes ya no tiene sentido con el nuevo resultado. Reset en
  // async para evitar el warning de react-hooks/set-state-in-effect (mismo
  // idioma que seccion-documentos.tsx).
  useEffect(() => {
    Promise.resolve().then(() => setPagina(1));
  }, [filters]);

  // Vista tabla: página server-side (25/50/100, por defecto 25).
  const tabla = useTramitesResultado(
    filters,
    { take: porPagina, skip: (pagina - 1) * porPagina },
    true,
    reloadSignal,
  );
  // Vista kanban: trae su propia página (más grande, como antes de A7) en vez
  // de reusar la de la tabla — así no se ve recortada a 25 tarjetas. Solo
  // pide datos mientras es la vista activa.
  const kanban = useTramitesResultado(
    filters,
    { take: TRAMITES_PAGE_SIZE, skip: 0 },
    viewMode === "kanban",
    reloadSignal,
  );
  const vistaActiva = viewMode === "kanban" ? kanban : tabla;

  const hasFilters =
    Boolean(search.trim()) ||
    estado !== allFilter ||
    ciudad !== allFilter ||
    clienteId !== allFilter ||
    tipoCliente !== allFilter ||
    facturado !== "todos";

  function limpiarFiltros() {
    setSearch("");
    setDebouncedSearch("");
    setEstado(allFilter);
    setCiudad(allFilter);
    setClienteId(allFilter);
    setTipoCliente(allFilter);
    setFacturado("todos");
  }

  // Carga inicial (sin filas todavía) → skeleton que reserva el alto de la
  // tabla; recargas con filas ya visibles → ModuleState loading.
  const tablaInitialLoading = tabla.state === "loading" && tabla.rows.length === 0;
  const emptyTitle = hasFilters ? "Sin resultados para los filtros" : "Sin trámites registrados";
  const emptyDetail = hasFilters
    ? "Ajusta estado, ciudad, cliente, tipo o búsqueda para ampliar la consulta."
    : "Cuando existan DOs, aparecerán en esta tabla operativa.";

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Trámites</h1>
          <p className="mt-1 text-sm text-slate-600">
            Busca un DO y abre su hoja de trabajo para seguir documentos, pagos y facturación.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Toggle tabla / kanban */}
          <div className="flex border border-slate-300 bg-white">
            <button
              type="button"
              onClick={() => setViewMode("tabla")}
              title="Vista tabla"
              aria-pressed={viewMode === "tabla"}
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
              aria-pressed={viewMode === "kanban"}
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

          {puedeCrearDO ? (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-10 shrink-0 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Crear DO
            </button>
          ) : null}
        </div>
      </div>

      {puedeCrearDO ? (
        <CreateTramiteDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(tramite) => {
            reload();
            router.push(`/tramites/${tramite.id}`);
          }}
        />
      ) : null}

      <div className="border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">
          <SlidersHorizontal className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Filtros operativos
        </div>
        <div className="space-y-3 px-4 py-3">
          <label className="relative block">
            <span className="sr-only">Buscar trámite</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por número de DO"
              className="h-10 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
            <label>
              <span className="sr-only">Filtrar por estado</span>
              <select
                value={estado}
                onChange={(event) => setEstado(event.target.value)}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              >
                <option value={allFilter}>Todos los estados</option>
                {ESTADOS_TRAMITE.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="sr-only">Filtrar por ciudad</span>
              <select
                value={ciudad}
                onChange={(event) => setCiudad(event.target.value)}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              >
                <option value={allFilter}>Todas las ciudades</option>
                {CIUDADES_TRAMITE.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="sr-only">Filtrar por cliente</span>
              <select
                value={clienteId}
                onChange={(event) => setClienteId(event.target.value)}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              >
                <option value={allFilter}>Todos los clientes</option>
                {filterClientes.map((cliente) => (
                  <option key={cliente.id} value={cliente.id}>
                    {cliente.nombre}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="sr-only">Filtrar por tipo de cliente</span>
              <select
                value={tipoCliente}
                onChange={(event) => setTipoCliente(event.target.value)}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              >
                <option value={allFilter}>Propio y Socio</option>
                <option value="PROPIO">Galcomex (propio)</option>
                <option value="SOCIO_LM">Con socio (Lucho)</option>
              </select>
            </label>

            <label>
              <span className="sr-only">Filtrar por facturado</span>
              <select
                value={facturado}
                onChange={(event) => setFacturado(event.target.value as FacturadoFilter)}
                className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              >
                <option value="todos">Facturado: todos</option>
                <option value="si">Facturados</option>
                <option value="no">No facturados</option>
              </select>
            </label>

            {hasFilters && (vistaActiva.state === "loading" || vistaActiva.rows.length > 0) ? <button
              type="button"
              onClick={limpiarFiltros}
              disabled={!hasFilters}
              className="inline-flex h-10 items-center justify-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Limpiar filtros
            </button> : null}
          </div>
        </div>
      </div>

      {/* Vista Kanban: trae su propia página (TRAMITES_PAGE_SIZE), no la
          paginada de la tabla — ver comentario junto a `kanban` arriba. */}
      {viewMode === "kanban" ? (
        <div>
          {kanban.state === "loading" ? (
            <ModuleState type="loading" title="Cargando trámites…" />
          ) : kanban.state === "error" ? (
            <ModuleState
              type="error"
              title="No se pudieron cargar los trámites"
              detail={kanban.error ?? undefined}
              action={{ label: "Reintentar", onClick: reload }}
            />
          ) : kanban.rows.length === 0 ? (
            <ModuleState type="empty" title={emptyTitle} detail={emptyDetail} action={hasFilters ? { label: "Limpiar filtros", onClick: limpiarFiltros, icon: false } : undefined} />
          ) : (
            <KanbanTramites rows={kanban.rows} onEstadoChanged={reload} />
          )}
        </div>
      ) : null}

      {/* Vista Tabla: la carga inicial reserva el alto de la tabla con un skeleton */}
      {viewMode === "tabla" && tablaInitialLoading ? (
        <TableSkeleton rows={8} cols={10} rowHeight={45} />
      ) : null}
      {viewMode === "tabla" && !tablaInitialLoading ? (
        <div ref={tablaRef} className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
            <p className="font-semibold text-slate-900">DOs operativos</p>
            <p className="text-slate-500" aria-live="polite">
              {tabla.state === "error"
                ? "—"
                : tabla.state === "loading"
                  ? "Actualizando resultados…"
                  : `Mostrando ${tabla.rows.length} de ${tabla.total}`}
            </p>
          </div>
          {tabla.state === "error" ? (
            <div className="p-4">
              <ModuleState
                type="error"
                title="No se pudieron cargar los trámites"
                detail={tabla.error ?? undefined}
                action={{ label: "Reintentar", onClick: reload }}
              />
            </div>
          ) : tabla.rows.length === 0 ? (
            <div className="p-4">
              <ModuleState type="empty" title={emptyTitle} detail={emptyDetail} action={hasFilters ? { label: "Limpiar filtros", onClick: limpiarFiltros, icon: false } : undefined} />
            </div>
          ) : (
          <div className="overflow-x-auto" aria-busy={tabla.state === "loading"}>
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
                {tabla.rows.map((tramite) => (
                      <tr
                        key={tramite.id}
                        className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-950">
                          <EnlaceTramite id={tramite.id}>{tramite.doNumber}</EnlaceTramite>
                          {tramite.esHistorico ? (
                            <span
                              className="ml-2 inline-flex h-5 items-center border border-amber-300 bg-amber-50 px-1.5 text-[11px] font-semibold text-amber-800"
                              title="Cargado desde el archivo histórico: tiene carpeta y documentos, sin detalle financiero"
                            >
                              Histórico
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          <EnlaceCliente id={tramite.clienteId}>{tramite.cliente}</EnlaceCliente>
                        </td>
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
                    ))}
              </tbody>
            </table>
          </div>
          )}
          {tabla.state !== "error" ? (
            <Paginacion
              total={tabla.total}
              pagina={pagina}
              porPagina={porPagina}
              onPaginaChange={handlePaginaChange}
              onPorPaginaChange={setPorPagina}
              opciones={[25, 50, 100]}
              etiqueta="trámites"
              cargando={tabla.state === "loading"}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
