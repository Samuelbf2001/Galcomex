"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileCheck2,
  Loader2,
  Paperclip,
  Plus,
  RotateCcw,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { ModalShell } from "@/components/ui/modal-shell";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { useRol } from "@/lib/auth/rol-context";
import {
  TIPOS_RECAUDO,
  type AnticipoRow,
  type EstadoMovimiento,
  type TipoRecaudo,
  type ClienteOption,
  type TramiteOption,
  AnticiposApiError,
  aplicarAnticipo,
  createAnticipo,
  eliminarAplicacion,
  fetchAnticipos,
  fetchClienteOptions,
  fetchTramiteOptions,
  formatCOP,
  formatDate,
  obtenerUrlDescargaSoporte,
  solicitarUploadUrlSoporte,
  subirComprobante,
  validarArchivoSoporte,
} from "@/components/anticipos/anticipos-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LoadState = "loading" | "ready" | "error";

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\$/g, "").replace(/COP/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  try {
    const v = BigInt(cleaned);
    if (v <= 0n) return null;
    return v.toString();
  } catch {
    return null;
  }
}

function saldoColorClass(restanteStr: string): string {
  try {
    const n = BigInt(restanteStr);
    if (n > 0n) return "text-emerald-700 font-semibold";
    return "text-slate-500";
  } catch {
    return "text-slate-500";
  }
}

// ---------------------------------------------------------------------------
// Modal: Crear anticipo
// ---------------------------------------------------------------------------

type CreateModalProps = {
  clientes: ClienteOption[];
  onClose: () => void;
  onCreated: (anticipo: AnticipoRow) => void;
};

function CreateAnticipoModal({ clientes, onClose, onCreated }: CreateModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [montoRaw, setMontoRaw] = useState("");
  const [clienteId, setClienteId] = useState("");

  // Soporte del anticipo (comprobante bancario) — obligatorio.
  const [fileName, setFileName] = useState<string | null>(null);
  const [soporteKey, setSoporteKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = "";
    setUploadError(null);
    setSoporteKey(null);
    setFileName(null);
    if (!f) return;

    if (!clienteId) {
      setUploadError("Selecciona un cliente antes de adjuntar el comprobante.");
      return;
    }

    const problema = validarArchivoSoporte(f);
    if (problema) {
      setUploadError(problema);
      return;
    }

    setUploading(true);
    try {
      const { storageKey, uploadUrl } = await solicitarUploadUrlSoporte({
        consecutivo: clienteId,
        fileName: f.name,
        contentType: f.type,
        sizeBytes: f.size,
      });
      await subirComprobante(uploadUrl, f);
      setSoporteKey(storageKey);
      setFileName(f.name);
    } catch (caught) {
      setUploadError(
        caught instanceof AnticiposApiError ? caught.message : "Error al subir el comprobante.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const fecha = String(formData.get("fecha") ?? "").trim();
    const tipoRecaudo = String(formData.get("tipoRecaudo") ?? "") as TipoRecaudo;

    if (!clienteId) { setError("Selecciona un cliente."); return; }
    if (!fecha) { setError("La fecha es obligatoria."); return; }

    const montoBig = parseBigIntInput(montoRaw);
    if (!montoBig) { setError("El monto debe ser un número entero mayor a 0."); return; }

    if (!soporteKey) {
      setError("Adjunta el comprobante del anticipo antes de continuar.");
      return;
    }

    setIsSubmitting(true);
    try {
      const anticipo = await createAnticipo({
        clienteId,
        monto: montoBig,
        fecha: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
        tipoRecaudo,
        verificadoBanco: false,
        soporteKey,
      });
      toast({
        title: "Anticipo registrado",
        description: `${formatCOP(montoBig)} · ${clientes.find((c) => c.id === clienteId)?.nombre ?? ""}`,
        variant: "success",
      });
      onCreated(anticipo);
    } catch (caught) {
      setError(
        caught instanceof AnticiposApiError
          ? caught.message
          : describirError(caught, "Error al registrar el anticipo."),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Registrar anticipo"
      size="lg"
      dismissible={!isSubmitting && !uploading}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Cliente *</span>
            <select
              name="clienteId"
              required
              value={clienteId}
              onChange={(e) => setClienteId(e.target.value)}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <option value="">Seleccionar cliente</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre} — {c.nit}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Monto (COP) *</span>
              <input
                value={montoRaw}
                onChange={(e) => setMontoRaw(e.target.value)}
                placeholder="5.800.000"
                inputMode="numeric"
                className="h-10 w-full border border-slate-300 px-3 text-sm outline-none focus:border-cyan-600"
              />
            </label>
            <label className="block space-y-1.5">
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

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Tipo de recaudo *</span>
            <select
              name="tipoRecaudo"
              required
              defaultValue="BANCOLOMBIA"
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <optgroup label="Digital">
                {TIPOS_RECAUDO.filter((t) => t.grupo === "DIGITAL").map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} (${new Intl.NumberFormat("es-CO").format(Number(t.costoFijo ?? "0"))})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Físico">
                {TIPOS_RECAUDO.filter((t) => t.grupo === "FISICO").map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} (${new Intl.NumberFormat("es-CO").format(Number(t.costoFijo ?? "0"))})
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Comprobante de pago (soporte) *</span>
            <div className="flex items-center gap-2">
              <label
                className={`inline-flex h-10 cursor-pointer items-center gap-2 border px-3 text-sm font-medium transition ${
                  !clienteId
                    ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <Paperclip className="h-4 w-4" aria-hidden="true" />
                Adjuntar archivo
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="hidden"
                  disabled={!clienteId || uploading}
                  onChange={(e) => void handleFileChange(e)}
                />
              </label>
              {uploading ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Subiendo…
                </span>
              ) : soporteKey && fileName ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                  <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {fileName}
                </span>
              ) : null}
            </div>
            {!clienteId ? (
              <p className="text-xs text-slate-500">Selecciona un cliente primero.</p>
            ) : null}
            {uploadError ? (
              <p className="text-xs font-medium text-rose-600">{uploadError}</p>
            ) : null}
          </label>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
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
              disabled={isSubmitting || uploading || !soporteKey}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Registrar anticipo
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Modal: Aplicar anticipo a un DO
// ---------------------------------------------------------------------------

type AplicarModalProps = {
  anticipo: AnticipoRow;
  tramites: TramiteOption[];
  onClose: () => void;
  onApplied: (anticipoId: string, desglose: { aplicacionId: string; tramiteId: string; montoAplicado: string }) => void;
};

function AplicarAnticipoModal({ anticipo, tramites, onClose, onApplied }: AplicarModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [montoRaw, setMontoRaw] = useState("");
  const restante = BigInt(anticipo.restante);

  // Calcular restante en vivo mientras el usuario escribe
  const montoIngresado = parseBigIntInput(montoRaw);
  const montoValido = montoIngresado ? BigInt(montoIngresado) : 0n;
  const restantePostAplicacion = restante - montoValido;
  const sobreAplicando = montoValido > 0n && restantePostAplicacion < 0n;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (sobreAplicando) {
      setError(`Monto excede el saldo disponible. Restante: ${formatCOP(anticipo.restante)}`);
      return;
    }

    const formData = new FormData(e.currentTarget);
    const tramiteId = String(formData.get("tramiteId") ?? "").trim();
    if (!tramiteId) { setError("Selecciona un trámite."); return; }

    const montoBig = parseBigIntInput(montoRaw);
    if (!montoBig) { setError("El monto debe ser mayor a 0."); return; }

    setIsSubmitting(true);
    try {
      const result = await aplicarAnticipo(anticipo.id, {
        tramiteId,
        montoAplicado: montoBig,
      });
      toast({
        title: "Anticipo aplicado",
        description: `${formatCOP(montoBig)} a ${tramites.find((t) => t.id === tramiteId)?.consecutivo ?? "DO"}`,
        variant: "success",
      });
      onApplied(anticipo.id, result);
    } catch (caught) {
      setError(
        caught instanceof AnticiposApiError
          ? caught.message
          : describirError(caught, "Error al aplicar el anticipo."),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Aplicar anticipo a DO"
      description={`Saldo disponible: ${formatCOP(anticipo.restante)}`}
      size="md"
      dismissible={!isSubmitting}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Trámite (DO) *</span>
            <select
              name="tramiteId"
              required
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
            >
              <option value="">Seleccionar DO</option>
              {tramites.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.consecutivo} — {t.clienteNombre}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Monto a aplicar (COP) *</span>
            <input
              value={montoRaw}
              onChange={(e) => setMontoRaw(e.target.value)}
              placeholder="5.800.000"
              inputMode="numeric"
              className={`h-10 w-full border px-3 text-sm outline-none focus:border-cyan-600 ${sobreAplicando ? "border-rose-400 bg-rose-50" : "border-slate-300"}`}
            />
            {/* Indicador en vivo */}
            {montoValido > 0n ? (
              <p className={`text-xs ${sobreAplicando ? "text-rose-600 font-medium" : "text-slate-500"}`}>
                {sobreAplicando
                  ? `Excede el saldo. Disponible: ${formatCOP(anticipo.restante)}`
                  : `Restante tras aplicar: ${formatCOP(restantePostAplicacion.toString())}`}
              </p>
            ) : null}
          </label>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
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
              disabled={isSubmitting || sobreAplicando}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Aplicar
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Fila de anticipo con desglose expandible
// ---------------------------------------------------------------------------

type AnticipoFilaProps = {
  anticipo: AnticipoRow;
  /** POST /api/anticipos/[id]/aplicaciones → solo ADMIN. */
  puedeAplicar: boolean;
  /** DELETE /api/anticipos/[id]/aplicaciones/[aplicacionId] → solo ADMIN. */
  puedeEliminarAplicacion: boolean;
  /** PATCH /api/anticipos/[id]/verificar → ADMIN u OPERATIVO. */
  puedeVerificar: boolean;
  /** Id del anticipo que se está verificando (bloquea doble clic). */
  verificandoId: string | null;
  onAplicar: (anticipo: AnticipoRow) => void;
  onEliminarAplicacion: (anticipoId: string, aplicacionId: string) => void;
  onVerificar: (id: string) => Promise<void>;
  deletingAplicacionId: string | null;
};

function AnticipoFila({
  anticipo,
  puedeAplicar,
  puedeEliminarAplicacion,
  puedeVerificar,
  verificandoId,
  onAplicar,
  onEliminarAplicacion,
  onVerificar,
  deletingAplicacionId,
}: AnticipoFilaProps) {
  const [expanded, setExpanded] = useState(false);
  const [descargando, setDescargando] = useState(false);
  const [descargaError, setDescargaError] = useState<string | null>(null);
  const hasAplicaciones = anticipo.aplicaciones.length > 0;

  async function handleDescargar() {
    if (!anticipo.soporteKey) return;
    setDescargando(true);
    setDescargaError(null);
    try {
      const url = await obtenerUrlDescargaSoporte(anticipo.soporteKey);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (caught) {
      setDescargaError(
        caught instanceof AnticiposApiError ? caught.message : "Error al obtener el comprobante.",
      );
    } finally {
      setDescargando(false);
    }
  }

  return (
    <>
      <tr className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
        {/* Expander */}
        <td className="px-3 py-2 w-8">
          {hasAplicaciones ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="text-slate-400 transition hover:text-slate-700"
              aria-label={
                expanded
                  ? `Ocultar desglose del anticipo de ${anticipo.clienteNombre || "cliente"}`
                  : `Ver desglose por DO del anticipo de ${anticipo.clienteNombre || "cliente"}`
              }
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="block w-4" />
          )}
        </td>

        {/* Cliente */}
        <td className="px-3 py-2.5 text-sm font-medium text-slate-800">
          <EnlaceCliente id={anticipo.clienteId}>
            {anticipo.clienteNombre || anticipo.clienteId}
          </EnlaceCliente>
        </td>

        {/* Monto */}
        <td className="px-3 py-2.5 text-right text-sm font-semibold text-slate-900">
          {formatCOP(anticipo.monto)}
        </td>

        {/* Fecha */}
        <td className="whitespace-nowrap px-3 py-2.5 text-sm text-slate-600">
          {formatDate(anticipo.fecha)}
        </td>

        {/* Recaudo */}
        <td className="px-3 py-2.5 text-sm text-slate-600">
          {TIPOS_RECAUDO.find((t) => t.value === anticipo.tipoRecaudo)?.label ?? anticipo.tipoRecaudo}
        </td>

        {/* Verificado */}
        <td className="px-3 py-2.5 text-center">
          {anticipo.estado === "VERIFICADO" ? (
            <CheckCircle2 className="inline h-4 w-4 text-emerald-600" aria-label="Verificado" />
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </td>

        {/* Aplicado */}
        <td className="px-3 py-2.5 text-right text-sm text-slate-700">
          {formatCOP(anticipo.aplicado)}
        </td>

        {/* Restante */}
        <td className={`px-3 py-2.5 text-right text-sm ${saldoColorClass(anticipo.restante)}`}>
          {formatCOP(anticipo.restante)}
        </td>

        {/* Acciones */}
        <td className="px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {anticipo.estado === "VERIFICADO" && (
              <span className="inline-flex items-center border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                VERIFICADO
              </span>
            )}
            {anticipo.estado === "BORRADOR" && (
              <span className="inline-flex items-center border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                BORRADOR
              </span>
            )}
            {anticipo.estado === "REALIZADO" && puedeVerificar && (
              <button
                type="button"
                onClick={() => void onVerificar(anticipo.id)}
                disabled={verificandoId !== null}
                className="inline-flex h-7 items-center gap-1 border border-cyan-300 bg-cyan-50 px-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
                title="Marcar como verificado en banco"
              >
                {verificandoId === anticipo.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : null}
                Verificar
              </button>
            )}
            {anticipo.estado === "REALIZADO" && !puedeVerificar && (
              <span className="inline-flex items-center border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                REALIZADO
              </span>
            )}
            {puedeAplicar ? (
              <button
                type="button"
                onClick={() => onAplicar(anticipo)}
                disabled={BigInt(anticipo.restante) <= 0n}
                title={
                  BigInt(anticipo.restante) <= 0n
                    ? "Este anticipo ya no tiene saldo disponible"
                    : "Aplicar parte del anticipo a un DO"
                }
                className="inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
              >
                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                Aplicar
              </button>
            ) : null}
            {anticipo.soporteKey ? (
              <button
                type="button"
                onClick={() => void handleDescargar()}
                disabled={descargando}
                className="inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                title="Ver comprobante"
              >
                {descargando ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Comprobante
              </button>
            ) : null}
          </div>
          {descargaError ? (
            <p className="mt-1 text-[10px] font-medium text-rose-600">{descargaError}</p>
          ) : null}
        </td>
      </tr>

      {/* Desglose de aplicaciones */}
      {expanded && hasAplicaciones ? (
        <tr className="bg-slate-50">
          <td colSpan={9} className="px-6 py-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Desglose por DO
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase text-slate-400">
                  <th className="pb-1 text-left font-medium">Consecutivo DO</th>
                  <th className="pb-1 text-right font-medium">Monto aplicado</th>
                  {puedeEliminarAplicacion ? <th className="pb-1 w-8"></th> : null}
                </tr>
              </thead>
              <tbody>
                {anticipo.aplicaciones.map((ap) => (
                  <tr key={ap.aplicacionId} className="border-t border-slate-100">
                    <td className="py-1.5">
                      <EnlaceTramite id={ap.tramiteId} className="font-medium">
                        {ap.consecutivo}
                      </EnlaceTramite>
                    </td>
                    <td className="py-1.5 text-right font-semibold text-slate-800">
                      {formatCOP(ap.montoAplicado)}
                    </td>
                    {puedeEliminarAplicacion ? (
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => onEliminarAplicacion(anticipo.id, ap.aplicacionId)}
                          disabled={deletingAplicacionId !== null}
                          className="inline-flex h-6 w-6 items-center justify-center text-slate-400 transition hover:text-rose-600 disabled:opacity-40"
                          aria-label={`Eliminar aplicación de ${formatCOP(ap.montoAplicado)} en ${ap.consecutivo}`}
                          title="Eliminar aplicación"
                        >
                          {deletingAplicacionId === ap.aplicacionId ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Componente principal: AnticiposWorkspace
// ---------------------------------------------------------------------------

export function AnticiposWorkspace() {
  // Permisos = requireRole de cada endpoint (la página admite ADMIN/OPERATIVO):
  //   POST /api/anticipos, POST/DELETE …/aplicaciones → ADMIN
  //   PATCH /api/anticipos/[id]/verificar → ADMIN u OPERATIVO
  const rol = useRol();
  const esAdmin = rol === "ADMIN";
  const puedeVerificar = rol === "ADMIN" || rol === "OPERATIVO";
  const { toast } = useToast();
  const confirmar = useConfirm();
  const [anticipos, setAnticipos] = useState<AnticipoRow[]>([]);
  const [clientes, setClientes] = useState<ClienteOption[]>([]);
  const [tramites, setTramites] = useState<TramiteOption[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [conSaldo, setConSaldo] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [aplicarTarget, setAplicarTarget] = useState<AnticipoRow | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [deletingAplicacionId, setDeletingAplicacionId] = useState<string | null>(null);
  const [verificandoId, setVerificandoId] = useState<string | null>(null);

  // Carga inicial
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);

      const [anticiposData, clientesData, tramitesData] = await Promise.all([
        fetchAnticipos({ conSaldo }, controller.signal),
        fetchClienteOptions(controller.signal),
        fetchTramiteOptions(controller.signal),
      ]);

      // Enriquecer nombres de cliente
      const enriched = anticiposData.map((a) => ({
        ...a,
        clienteNombre:
          a.clienteNombre ||
          clientesData.find((c) => c.id === a.clienteId)?.nombre ||
          a.clienteId,
      }));

      setAnticipos(enriched);
      setClientes(clientesData);
      setTramites(tramitesData);
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(describirError(caught, "Error al cargar los anticipos."));
      setLoadState("error");
    });

    return () => controller.abort();
  }, [reloadKey, conSaldo]);

  // Estadísticas
  const stats = useMemo(() => {
    const total = anticipos.reduce((s, a) => s + BigInt(a.monto), 0n);
    const aplicado = anticipos.reduce((s, a) => s + BigInt(a.aplicado), 0n);
    const restante = anticipos.reduce((s, a) => s + BigInt(a.restante), 0n);
    return { total, aplicado, restante };
  }, [anticipos]);

  function handleAnticipoCreado() {
    setCreateOpen(false);
    setReloadKey((k) => k + 1);
  }

  function handleApplied(
    anticipoId: string,
    desglose: { aplicacionId: string; tramiteId: string; montoAplicado: string },
  ) {
    setAplicarTarget(null);
    // Actualizar localmente para no recargar todo
    setAnticipos((prev) =>
      prev.map((a) => {
        if (a.id !== anticipoId) return a;
        const tramite = tramites.find((t) => t.id === desglose.tramiteId);
        const aplicadoNuevo = (BigInt(a.aplicado) + BigInt(desglose.montoAplicado)).toString();
        const restanteNuevo = (BigInt(a.monto) - BigInt(aplicadoNuevo)).toString();
        return {
          ...a,
          aplicado: aplicadoNuevo,
          restante: restanteNuevo,
          aplicaciones: [
            ...a.aplicaciones,
            {
              aplicacionId: desglose.aplicacionId,
              tramiteId: desglose.tramiteId,
              consecutivo: tramite?.consecutivo ?? desglose.tramiteId,
              montoAplicado: desglose.montoAplicado,
            },
          ],
        };
      }),
    );
  }

  async function handleEliminarAplicacion(anticipoId: string, aplicacionId: string) {
    if (deletingAplicacionId) return;
    const anticipo = anticipos.find((a) => a.id === anticipoId);
    const aplicacion = anticipo?.aplicaciones.find((x) => x.aplicacionId === aplicacionId);
    const ok = await confirmar({
      title: "¿Eliminar esta aplicación del anticipo?",
      description: aplicacion
        ? `${formatCOP(aplicacion.montoAplicado)} aplicados a ${aplicacion.consecutivo} volverán al saldo disponible del anticipo. El DO quedará sin ese anticipo.`
        : "El monto volverá al saldo disponible del anticipo.",
      confirmText: "Eliminar aplicación",
      variant: "danger",
    });
    if (!ok) return;

    setDeletingAplicacionId(aplicacionId);
    setGlobalError(null);

    try {
      await eliminarAplicacion(anticipoId, aplicacionId);
      setAnticipos((prev) =>
        prev.map((a) => {
          if (a.id !== anticipoId) return a;
          const ap = a.aplicaciones.find((x) => x.aplicacionId === aplicacionId);
          const monto = ap ? BigInt(ap.montoAplicado) : 0n;
          const aplicadoNuevo = (BigInt(a.aplicado) - monto).toString();
          const restanteNuevo = (BigInt(a.monto) - BigInt(aplicadoNuevo)).toString();
          return {
            ...a,
            aplicado: aplicadoNuevo,
            restante: restanteNuevo,
            aplicaciones: a.aplicaciones.filter((x) => x.aplicacionId !== aplicacionId),
          };
        }),
      );
      toast({
        title: "Aplicación eliminada",
        description: aplicacion
          ? `${formatCOP(aplicacion.montoAplicado)} volvieron al saldo del anticipo`
          : undefined,
        variant: "success",
      });
    } catch (caught) {
      const mensaje =
        caught instanceof AnticiposApiError
          ? caught.message
          : describirError(caught, "Error al eliminar la aplicación.");
      setGlobalError(mensaje);
      toast({ title: "No se pudo eliminar la aplicación", description: mensaje, variant: "error" });
    } finally {
      setDeletingAplicacionId(null);
    }
  }

  async function handleVerificar(id: string) {
    if (verificandoId) return; // evita doble clic
    setGlobalError(null);
    setVerificandoId(id);
    try {
      const response = await fetch(`/api/anticipos/${id}/verificar`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ estado: "VERIFICADO" as EstadoMovimiento }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const msg =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as Record<string, unknown>).error === "string"
            ? (payload as Record<string, unknown>).error as string
            : `Error al verificar (${response.status}).`;
        throw new AnticiposApiError(msg, response.status);
      }
      setAnticipos((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                estado: "VERIFICADO" as EstadoMovimiento,
                verificadoBanco: true,
              }
            : a,
        ),
      );
      toast({ title: "Anticipo verificado en banco", variant: "success" });
    } catch (caught) {
      const mensaje = describirError(caught, "Error de red al verificar.");
      setGlobalError(mensaje);
      toast({ title: "No se pudo verificar el anticipo", description: mensaje, variant: "error" });
    } finally {
      setVerificandoId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Anticipos</h1>
          <p className="mt-1 text-sm text-slate-600">
            Registro, verificación bancaria y aplicación multi-DO.
          </p>
        </div>
        {/* POST /api/anticipos → solo ADMIN */}
        {esAdmin ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-10 shrink-0 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Registrar anticipo
          </button>
        ) : null}
      </div>

      {/* Tarjetas de resumen */}
      {loadState === "loading" ? <CardsSkeleton count={3} height={84} /> : null}
      {loadState === "ready" && (
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Total recibido", value: stats.total.toString(), color: "text-slate-900" },
            { label: "Aplicado a DOs", value: stats.aplicado.toString(), color: "text-slate-700" },
            { label: "Saldo disponible", value: stats.restante.toString(), color: "text-emerald-700" },
          ].map((s) => (
            <div key={s.label} className="border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</p>
              <p className={`mt-1 text-xl font-bold ${s.color}`}>{formatCOP(s.value)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filtro con saldo */}
      <div className="flex items-center gap-3 border border-slate-200 bg-white px-4 py-3 text-sm">
        <span className="font-medium text-slate-700">Filtro:</span>
        <button
          type="button"
          onClick={() => setConSaldo(false)}
          className={`h-8 border px-3 text-xs font-semibold transition ${
            !conSaldo
              ? "border-slate-950 bg-slate-950 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Todos
        </button>
        <button
          type="button"
          onClick={() => setConSaldo(true)}
          className={`h-8 border px-3 text-xs font-semibold transition ${
            conSaldo
              ? "border-emerald-700 bg-emerald-700 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          Con saldo
        </button>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="ml-auto inline-flex h-8 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {/* Error global */}
      {globalError ? (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {globalError}
          <button
            type="button"
            onClick={() => setGlobalError(null)}
            className="ml-auto"
            aria-label="Cerrar aviso de error"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* Tabla */}
      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={9} rowHeight={45} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No fue posible cargar los anticipos"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: () => setReloadKey((k) => k + 1) }}
        />
      ) : (
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-900">
            Anticipos {conSaldo ? "(con saldo)" : "(todos)"}
          </p>
          <p className="text-slate-500">{anticipos.length} registros</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2.5 w-8"></th>
                <th className="border-b border-slate-200 px-3 py-2.5">Cliente</th>
                <th className="border-b border-slate-200 px-3 py-2.5 text-right">Monto</th>
                <th className="border-b border-slate-200 px-3 py-2.5">Fecha</th>
                <th className="border-b border-slate-200 px-3 py-2.5">Recaudo</th>
                <th className="border-b border-slate-200 px-3 py-2.5 text-center">Verificado</th>
                <th className="border-b border-slate-200 px-3 py-2.5 text-right">Aplicado</th>
                <th className="border-b border-slate-200 px-3 py-2.5 text-right">Restante</th>
                <th className="border-b border-slate-200 px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {anticipos.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-500">
                    {conSaldo
                      ? "No hay anticipos con saldo disponible."
                      : "Sin anticipos registrados."}
                  </td>
                </tr>
              ) : (
                anticipos.map((anticipo) => (
                  <AnticipoFila
                    key={anticipo.id}
                    anticipo={anticipo}
                    puedeAplicar={esAdmin}
                    puedeEliminarAplicacion={esAdmin}
                    puedeVerificar={puedeVerificar}
                    verificandoId={verificandoId}
                    onAplicar={(a) => setAplicarTarget(a)}
                    onEliminarAplicacion={(anticipoId, aplicacionId) =>
                      void handleEliminarAplicacion(anticipoId, aplicacionId)
                    }
                    onVerificar={handleVerificar}
                    deletingAplicacionId={deletingAplicacionId}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Modal crear (solo ADMIN) */}
      {createOpen && esAdmin ? (
        <CreateAnticipoModal
          clientes={clientes}
          onClose={() => setCreateOpen(false)}
          onCreated={handleAnticipoCreado}
        />
      ) : null}

      {/* Modal aplicar (solo ADMIN) */}
      {aplicarTarget && esAdmin ? (
        <AplicarAnticipoModal
          anticipo={aplicarTarget}
          tramites={tramites}
          onClose={() => setAplicarTarget(null)}
          onApplied={handleApplied}
        />
      ) : null}
    </section>
  );
}
