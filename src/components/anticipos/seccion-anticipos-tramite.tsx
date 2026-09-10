"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  Loader2,
  Paperclip,
  Plus,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  TIPOS_RECAUDO,
  type AnticipoRow,
  type EstadoMovimiento,
  type TipoRecaudo,
  aplicarAnticipo,
  createAnticipo,
  fetchAnticipos,
  formatCOP,
  formatDate,
  obtenerUrlDescargaSoporte,
  solicitarUploadUrlSoporte,
  subirComprobante,
  validarArchivoSoporte,
} from "@/components/anticipos/anticipos-api";
import { ModuleState } from "@/components/layout/module-state";
import { ModalShell } from "@/components/ui/modal-shell";
import { describirError, useToast } from "@/components/ui/toast";
import { useEsAdmin, usePermiso } from "@/lib/auth/rol-context";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type AplicacionAnticipoEntry = {
  id: string;
  montoAplicado: string;
  anticipo: {
    id: string;
    monto: string;
    fecha: string;
    tipoRecaudo: string;
    costoRecaudo: string;
    verificadoBanco: boolean;
    estado: EstadoMovimiento;
    soporteKey: string | null;
  };
};

type Cliente = { id: string; nombre: string; nit: string };

/** PATCH /api/anticipos/[id]/verificar exige ADMIN/OPERATIVO. */
const ROLES_VERIFICAR_ANTICIPO = ["ADMIN", "OPERATIVO"] as const;

function isRecordUnknown(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseBigIntInput(raw: string): string | null {
  const cleaned = raw
    .replace(/\./g, "")
    .replace(/,/g, "")
    .replace(/\$/g, "")
    .replace(/COP/g, "")
    .trim();
  if (!cleaned || cleaned === "-") return null;
  try {
    const v = BigInt(cleaned);
    if (v <= 0n) return null;
    return v.toString();
  } catch {
    return null;
  }
}

const tipoRecaudoLabel = (value: string): string =>
  TIPOS_RECAUDO.find((t) => t.value === value)?.label ?? value;

// ─── Modal: Registrar anticipo para este DO ─────────────────────────────────────

type RegistrarModalProps = {
  tramiteId: string;
  cliente: Cliente;
  onClose: () => void;
  onDone: () => void;
};

export function RegistrarAnticipoTramiteModal({
  tramiteId,
  cliente,
  onClose,
  onDone,
}: RegistrarModalProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [montoRaw, setMontoRaw] = useState("");
  const [aplicarTodo, setAplicarTodo] = useState(true);
  const [montoAplicarRaw, setMontoAplicarRaw] = useState("");

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

    const problema = validarArchivoSoporte(f);
    if (problema) {
      setUploadError(problema);
      return;
    }

    setUploading(true);
    try {
      const { storageKey, uploadUrl } = await solicitarUploadUrlSoporte({
        consecutivo: cliente.id,
        fileName: f.name,
        contentType: f.type,
        sizeBytes: f.size,
      });
      await subirComprobante(uploadUrl, f);
      setSoporteKey(storageKey);
      setFileName(f.name);
    } catch (caught) {
      setUploadError(describirError(caught, "Error al subir el comprobante."));
    } finally {
      setUploading(false);
    }
  }

  const montoBig = parseBigIntInput(montoRaw);
  const montoAplicarBig = aplicarTodo ? montoBig : parseBigIntInput(montoAplicarRaw);
  const sobreAplicando =
    !aplicarTodo &&
    montoBig !== null &&
    montoAplicarBig !== null &&
    BigInt(montoAplicarBig) > BigInt(montoBig);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!montoBig) {
      setError("El monto debe ser un número entero mayor a 0.");
      return;
    }

    const montoAplicar = aplicarTodo ? montoBig : montoAplicarBig;
    if (!montoAplicar) {
      setError("El monto a aplicar a este DO debe ser mayor a 0.");
      return;
    }
    if (sobreAplicando) {
      setError("El monto a aplicar no puede superar el monto del anticipo.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    const fecha = String(formData.get("fecha") ?? "").trim();
    const tipoRecaudo = String(formData.get("tipoRecaudo") ?? "") as TipoRecaudo;

    if (!fecha) {
      setError("La fecha es obligatoria.");
      return;
    }

    if (!soporteKey) {
      setError("Adjunta el comprobante del anticipo antes de continuar.");
      return;
    }

    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const anticipo = await createAnticipo({
        clienteId: cliente.id,
        monto: montoBig,
        fecha: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
        tipoRecaudo,
        verificadoBanco: false,
        soporteKey,
      });

      try {
        await aplicarAnticipo(anticipo.id, {
          tramiteId,
          montoAplicado: montoAplicar,
        });
      } catch (applyError) {
        // El anticipo quedó creado pero no se pudo aplicar al DO.
        const msg = describirError(applyError, "No se pudo aplicar al DO.");
        toast({
          title: "Anticipo registrado, pero no aplicado a este DO",
          description: `${msg} Puedes aplicarlo con "Aplicar existente".`,
          variant: "error",
        });
        onDone();
        return;
      }

      toast({
        title: "Anticipo registrado y aplicado",
        description: `${formatCOP(montoAplicar)} aplicados a este DO.`,
        variant: "success",
      });
      onDone();
    } catch (caught) {
      setError(describirError(caught, "Error al registrar el anticipo."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Registrar anticipo"
      description={`${cliente.nombre} · ${cliente.nit}`}
      size="lg"
      dismissible={!isSubmitting && !uploading}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Cliente fijo */}
          <div className="border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Cliente
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900">{cliente.nombre}</p>
            <p className="text-xs text-slate-500">{cliente.nit}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">Monto (COP) *</span>
              <input
                value={montoRaw}
                onChange={(e) => setMontoRaw(e.target.value)}
                placeholder="5.800.000"
                inputMode="numeric"
                autoFocus
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
              <label className="inline-flex h-10 cursor-pointer items-center gap-2 border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                <Paperclip className="h-4 w-4" aria-hidden="true" />
                Adjuntar archivo
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="hidden"
                  disabled={uploading}
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
            {uploadError ? (
              <p className="text-xs font-medium text-rose-600">{uploadError}</p>
            ) : null}
          </label>

          {/* Aplicación a este DO */}
          <div className="space-y-2 border-t border-slate-200 pt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={aplicarTodo}
                onChange={(e) => setAplicarTodo(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-cyan-600"
              />
              Aplicar todo el anticipo a este DO
            </label>
            {!aplicarTodo ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Monto a aplicar a este DO (COP) *
                </span>
                <input
                  value={montoAplicarRaw}
                  onChange={(e) => setMontoAplicarRaw(e.target.value)}
                  placeholder="2.000.000"
                  inputMode="numeric"
                  className={`h-10 w-full border px-3 text-sm outline-none focus:border-cyan-600 ${
                    sobreAplicando ? "border-rose-400 bg-rose-50" : "border-slate-300"
                  }`}
                />
                <p className="text-xs text-slate-500">
                  El resto queda como saldo del cliente para aplicar a otros DOs.
                </p>
              </label>
            ) : null}
          </div>

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
              disabled={isSubmitting}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || sobreAplicando || uploading || !soporteKey}
              className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Registrar y aplicar
            </button>
          </div>
        </form>
    </ModalShell>
  );
}

// ─── Modal: Aplicar anticipo existente del cliente ──────────────────────────────

type AplicarExistenteModalProps = {
  tramiteId: string;
  cliente: Cliente;
  onClose: () => void;
  onDone: () => void;
};

function AplicarExistenteModal({
  tramiteId,
  cliente,
  onClose,
  onDone,
}: AplicarExistenteModalProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [anticipos, setAnticipos] = useState<AnticipoRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [montoRaw, setMontoRaw] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAnticipos({ clienteId: cliente.id, conSaldo: true }, controller.signal)
      .then((rows) => {
        setAnticipos(rows);
        setLoadError(null);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(describirError(caught, "No se pudieron cargar los anticipos del cliente."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [cliente.id, reloadKey]);

  function reintentarCarga() {
    setLoading(true);
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  const selected = anticipos.find((a) => a.id === selectedId) ?? null;
  const restante = selected ? BigInt(selected.restante) : 0n;
  const montoBig = parseBigIntInput(montoRaw);
  const sobreAplicando =
    montoBig !== null && selected !== null && BigInt(montoBig) > restante;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!selected) {
      setError("Selecciona un anticipo.");
      return;
    }
    if (!montoBig) {
      setError("El monto a aplicar debe ser mayor a 0.");
      return;
    }
    if (sobreAplicando) {
      setError(`Monto excede el saldo disponible. Restante: ${formatCOP(selected.restante)}`);
      return;
    }

    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await aplicarAnticipo(selected.id, {
        tramiteId,
        montoAplicado: montoBig,
      });
      toast({
        title: "Anticipo aplicado",
        description: `${formatCOP(montoBig)} aplicados a este DO.`,
        variant: "success",
      });
      onDone();
    } catch (caught) {
      setError(describirError(caught, "Error al aplicar el anticipo."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Aplicar anticipo existente"
      description={cliente.nombre}
      size="md"
      dismissible={!isSubmitting}
    >
        <div>
          {loading ? (
            <ModuleState type="loading" title="Cargando anticipos del cliente…" />
          ) : loadError ? (
            <ModuleState
              type="error"
              title="No se pudieron cargar los anticipos"
              detail={loadError}
              action={{ label: "Reintentar", onClick: reintentarCarga }}
            />
          ) : anticipos.length === 0 ? (
            <p className="py-4 text-sm text-slate-600">
              Este cliente no tiene anticipos con saldo disponible. Usa{" "}
              <strong>Registrar anticipo</strong> para crear uno nuevo.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Anticipo *</span>
                <select
                  value={selectedId}
                  onChange={(e) => {
                    setSelectedId(e.target.value);
                    const a = anticipos.find((x) => x.id === e.target.value);
                    setMontoRaw(a ? a.restante : "");
                  }}
                  required
                  className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-600"
                >
                  <option value="">Seleccionar anticipo</option>
                  {anticipos.map((a) => (
                    <option key={a.id} value={a.id}>
                      {formatDate(a.fecha)} · {tipoRecaudoLabel(a.tipoRecaudo)} · saldo{" "}
                      {formatCOP(a.restante)}
                    </option>
                  ))}
                </select>
              </label>

              {selected ? (
                <p className="text-xs text-slate-500">
                  Monto del anticipo: {formatCOP(selected.monto)} · Saldo disponible:{" "}
                  <span className="font-semibold text-emerald-700">
                    {formatCOP(selected.restante)}
                  </span>
                </p>
              ) : null}

              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">
                  Monto a aplicar a este DO (COP) *
                </span>
                <input
                  value={montoRaw}
                  onChange={(e) => setMontoRaw(e.target.value)}
                  placeholder="5.800.000"
                  inputMode="numeric"
                  className={`h-10 w-full border px-3 text-sm outline-none focus:border-cyan-600 ${
                    sobreAplicando ? "border-rose-400 bg-rose-50" : "border-slate-300"
                  }`}
                />
                {sobreAplicando && selected ? (
                  <p className="text-xs font-medium text-rose-600">
                    Excede el saldo. Disponible: {formatCOP(selected.restante)}
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
                  disabled={isSubmitting}
                  className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || sobreAplicando}
                  className="inline-flex h-10 items-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Aplicar
                </button>
              </div>
            </form>
          )}
        </div>
    </ModalShell>
  );
}

// ─── Fila de aplicación: badge de verificación + acción Verificar + comprobante ─

type FilaAplicacionProps = {
  ap: AplicacionAnticipoEntry;
  /** PATCH /api/anticipos/[id]/verificar → ADMIN/OPERATIVO. */
  puedeVerificar: boolean;
  onVerificado: () => void;
};

function FilaAplicacion({ ap, puedeVerificar, onVerificado }: FilaAplicacionProps) {
  const { toast } = useToast();
  const [verificando, setVerificando] = useState(false);
  const [verificarError, setVerificarError] = useState<string | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [descargaError, setDescargaError] = useState<string | null>(null);

  const verificado = ap.anticipo.estado === "VERIFICADO";

  async function handleVerificar() {
    if (verificando) return;
    setVerificando(true);
    setVerificarError(null);
    try {
      const response = await fetch(`/api/anticipos/${ap.anticipo.id}/verificar`, {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ estado: "VERIFICADO" as EstadoMovimiento }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const msg =
          isRecordUnknown(payload) && typeof payload.error === "string"
            ? payload.error
            : `Error al verificar (${response.status}).`;
        setVerificarError(msg);
        toast({ title: "No se pudo verificar el anticipo", description: msg, variant: "error" });
        return;
      }
      toast({
        title: "Anticipo verificado",
        description: `${formatCOP(ap.anticipo.monto)} · ${formatDate(ap.anticipo.fecha)}`,
        variant: "success",
      });
      onVerificado();
    } catch (caught) {
      const msg = describirError(caught, "Error de red al verificar.");
      setVerificarError(msg);
      toast({ title: "No se pudo verificar el anticipo", description: msg, variant: "error" });
    } finally {
      setVerificando(false);
    }
  }

  async function handleDescargar() {
    if (!ap.anticipo.soporteKey || descargando) return;
    setDescargando(true);
    setDescargaError(null);
    try {
      const url = await obtenerUrlDescargaSoporte(ap.anticipo.soporteKey);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (caught) {
      setDescargaError(describirError(caught, "Error al obtener el comprobante."));
    } finally {
      setDescargando(false);
    }
  }

  return (
    <tr className="border-b border-slate-100 last:border-b-0">
      <td className="px-4 py-3 text-slate-600">{formatDate(ap.anticipo.fecha)}</td>
      <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900">
        {formatCOP(ap.anticipo.monto)}
      </td>
      <td className="px-4 py-3 text-right font-mono font-semibold text-cyan-700">
        {formatCOP(ap.montoAplicado)}
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">
        {tipoRecaudoLabel(ap.anticipo.tipoRecaudo)}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {verificado ? (
            <span className="inline-flex items-center gap-1 border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Verificado
            </span>
          ) : (
            <span className="inline-flex items-center border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
              Pendiente de verificar
            </span>
          )}
          {!verificado && puedeVerificar ? (
            <button
              type="button"
              onClick={() => void handleVerificar()}
              disabled={verificando}
              className="inline-flex h-6 items-center gap-1 border border-cyan-300 bg-cyan-50 px-2 text-[10px] font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50"
              title="Marcar como verificado"
              aria-label={`Marcar como verificado el anticipo del ${formatDate(ap.anticipo.fecha)}`}
            >
              {verificando ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : null}
              Verificar
            </button>
          ) : null}
        </div>
        {verificarError ? (
          <p className="mt-1 text-[10px] font-medium text-rose-600">{verificarError}</p>
        ) : null}
      </td>
      <td className="px-4 py-3">
        {ap.anticipo.soporteKey ? (
          <button
            type="button"
            onClick={() => void handleDescargar()}
            disabled={descargando}
            className="inline-flex h-6 items-center gap-1 border border-slate-300 bg-white px-2 text-[10px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            title="Ver comprobante"
            aria-label={`Ver comprobante del anticipo del ${formatDate(ap.anticipo.fecha)}`}
          >
            {descargando ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3 w-3" aria-hidden="true" />
            )}
            Ver
          </button>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
        {descargaError ? (
          <p className="mt-1 text-[10px] font-medium text-rose-600">{descargaError}</p>
        ) : null}
      </td>
    </tr>
  );
}

// ─── Sección Anticipos del DO (interactiva) ─────────────────────────────────────

type SeccionAnticiposTramiteProps = {
  tramiteId: string;
  cliente: Cliente;
  aplicaciones: AplicacionAnticipoEntry[];
  /**
   * Gate adicional del padre (p. ej. trámite cerrado). Registrar/aplicar
   * anticipos exige además ADMIN (`POST /api/anticipos`,
   * `POST /api/anticipos/[id]/aplicaciones`).
   */
  puedeEditar: boolean;
  onRefresh: () => void;
};

export function SeccionAnticiposTramite({
  tramiteId,
  cliente,
  aplicaciones,
  puedeEditar,
  onRefresh,
}: SeccionAnticiposTramiteProps) {
  const esAdmin = useEsAdmin();
  const puedeVerificar = usePermiso(ROLES_VERIFICAR_ANTICIPO);
  const puedeRegistrar = puedeEditar && esAdmin;
  const [modal, setModal] = useState<null | "crear" | "aplicar">(null);

  function handleDone() {
    setModal(null);
    onRefresh();
  }

  const acciones = puedeRegistrar ? (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setModal("aplicar")}
        className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
      >
        <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
        Aplicar existente
      </button>
      <button
        type="button"
        onClick={() => setModal("crear")}
        className="inline-flex h-8 items-center gap-1.5 bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Registrar anticipo
      </button>
    </div>
  ) : null;

  return (
    <>
      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">
            Anticipos del cliente ({aplicaciones.length})
          </p>
          {acciones}
        </div>

        {aplicaciones.length === 0 ? (
          <p className="px-4 py-5 text-sm text-slate-500">
            Sin anticipos aplicados a este DO.
            {puedeRegistrar
              ? ' Usa "Registrar anticipo" para agregar uno desde aquí.'
              : " Solo un ADMIN puede registrar o aplicar anticipos."}
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-3">Fecha</th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">
                  Monto anticipo
                </th>
                <th className="border-b border-slate-200 px-4 py-3 text-right">
                  Aplicado a este DO
                </th>
                <th className="border-b border-slate-200 px-4 py-3">Recaudo</th>
                <th className="border-b border-slate-200 px-4 py-3">Verificado</th>
                <th className="border-b border-slate-200 px-4 py-3">Comprobante</th>
              </tr>
            </thead>
            <tbody>
              {aplicaciones.map((ap) => (
                <FilaAplicacion
                  key={ap.id}
                  ap={ap}
                  puedeVerificar={puedeVerificar}
                  onVerificado={onRefresh}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal === "crear" && puedeRegistrar ? (
        <RegistrarAnticipoTramiteModal
          tramiteId={tramiteId}
          cliente={cliente}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      ) : null}

      {modal === "aplicar" && puedeRegistrar ? (
        <AplicarExistenteModal
          tramiteId={tramiteId}
          cliente={cliente}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      ) : null}
    </>
  );
}
