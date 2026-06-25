"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plus,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  TIPOS_RECAUDO,
  type AnticipoRow,
  type TipoRecaudo,
  AnticiposApiError,
  aplicarAnticipo,
  createAnticipo,
  fetchAnticipos,
  formatCOP,
  formatDate,
} from "@/components/anticipos/anticipos-api";

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
  };
};

type Cliente = { id: string; nombre: string; nit: string };

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [montoRaw, setMontoRaw] = useState("");
  const [aplicarTodo, setAplicarTodo] = useState(true);
  const [montoAplicarRaw, setMontoAplicarRaw] = useState("");

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

    setIsSubmitting(true);
    try {
      const anticipo = await createAnticipo({
        clienteId: cliente.id,
        monto: montoBig,
        fecha: new Date(`${fecha}T00:00:00.000Z`).toISOString(),
        tipoRecaudo,
        verificadoBanco: false,
      });

      try {
        await aplicarAnticipo(anticipo.id, {
          tramiteId,
          montoAplicado: montoAplicar,
        });
      } catch (applyError) {
        // El anticipo quedó creado pero no se pudo aplicar al DO.
        const msg =
          applyError instanceof AnticiposApiError
            ? applyError.message
            : "No se pudo aplicar al DO.";
        setError(
          `El anticipo se registró pero no se pudo aplicar a este DO (${msg}). ` +
            `Puedes aplicarlo con "Aplicar anticipo existente".`,
        );
        onDone();
        return;
      }

      onDone();
    } catch (caught) {
      setError(
        caught instanceof AnticiposApiError
          ? caught.message
          : "Error al registrar el anticipo.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-xl border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-950">Registrar anticipo</h2>
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
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
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
              Registrar y aplicar
            </button>
          </div>
        </form>
      </div>
    </div>
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setLoadError(
          caught instanceof AnticiposApiError
            ? caught.message
            : "No se pudieron cargar los anticipos del cliente.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [cliente.id]);

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

    setIsSubmitting(true);
    try {
      await aplicarAnticipo(selected.id, {
        tramiteId,
        montoAplicado: montoBig,
      });
      onDone();
    } catch (caught) {
      setError(
        caught instanceof AnticiposApiError
          ? caught.message
          : "Error al aplicar el anticipo.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-lg border border-slate-300 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Aplicar anticipo existente</h2>
            <p className="mt-0.5 text-sm text-slate-500">{cliente.nombre}</p>
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

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-slate-600">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
              Cargando anticipos del cliente…
            </div>
          ) : loadError ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {loadError}
            </div>
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
                  className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
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
      </div>
    </div>
  );
}

// ─── Sección Anticipos del DO (interactiva) ─────────────────────────────────────

type SeccionAnticiposTramiteProps = {
  tramiteId: string;
  cliente: Cliente;
  aplicaciones: AplicacionAnticipoEntry[];
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
  const [modal, setModal] = useState<null | "crear" | "aplicar">(null);

  function handleDone() {
    setModal(null);
    onRefresh();
  }

  const acciones = puedeEditar ? (
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
            {puedeEditar
              ? ' Usa "Registrar anticipo" para agregar uno desde aquí.'
              : ""}
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
              </tr>
            </thead>
            <tbody>
              {aplicaciones.map((ap) => (
                <tr key={ap.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-3 text-slate-600">
                    {formatDate(ap.anticipo.fecha)}
                  </td>
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
                    {ap.anticipo.verificadoBanco ? (
                      <CheckCircle2
                        className="h-4 w-4 text-emerald-600"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="inline-flex items-center border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                        Pendiente verificar
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal === "crear" ? (
        <RegistrarAnticipoTramiteModal
          tramiteId={tramiteId}
          cliente={cliente}
          onClose={() => setModal(null)}
          onDone={handleDone}
        />
      ) : null}

      {modal === "aplicar" ? (
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
