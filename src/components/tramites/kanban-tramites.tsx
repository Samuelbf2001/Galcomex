"use client";

import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { type TramiteRow } from "@/components/tramites/tramites-api";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

// ─── Pipeline de estados ──────────────────────────────────────────────────────

const PIPELINE: string[] = [
  "SOLICITUD",
  "APERTURA",
  "EN_TRAMITE",
  "EN_PUERTO",
  "DESPACHADO",
  "ENVIADO_A_FACTURAR",
  "FACTURADO",
  "PAGADO",
  "CERRADO",
];

/** POST /api/tramites/[id]/estado exige ADMIN/REVISOR/OPERATIVO. */
const ROLES_MOVER_ESTADO = ["ADMIN", "REVISOR", "OPERATIVO"] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function columnColor(estado: string): {
  header: string;
  dot: string;
  card: string;
} {
  const n = estado.toLowerCase();
  if (n.includes("cerr") || n.includes("pagad")) {
    return {
      header: "bg-emerald-50 border-emerald-200",
      dot: "bg-emerald-400",
      card: "border-emerald-100",
    };
  }
  if (n.includes("factur")) {
    return {
      header: "bg-cyan-50 border-cyan-200",
      dot: "bg-cyan-400",
      card: "border-cyan-100",
    };
  }
  if (n.includes("despach") || n.includes("enviado")) {
    return {
      header: "bg-cyan-50 border-cyan-200",
      dot: "bg-cyan-400",
      card: "border-cyan-100",
    };
  }
  if (n.includes("puerto") || n.includes("tramite")) {
    return {
      header: "bg-amber-50 border-amber-200",
      dot: "bg-amber-400",
      card: "border-amber-100",
    };
  }
  if (n.includes("apertura")) {
    return {
      header: "bg-sky-50 border-sky-200",
      dot: "bg-sky-400",
      card: "border-sky-100",
    };
  }
  return {
    header: "bg-slate-50 border-slate-200",
    dot: "bg-slate-400",
    card: "border-slate-200",
  };
}

function formatKanbanDate(value: string): string {
  if (!value || value === "-") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

// ─── Tarjeta ──────────────────────────────────────────────────────────────────

function KanbanCard({
  tramite,
  cardBorder,
  puedeMover,
  onEstadoChanged,
}: {
  tramite: TramiteRow;
  cardBorder: string;
  puedeMover: boolean;
  onEstadoChanged?: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [selected, setSelected] = useState("");
  const [advError, setAdvError] = useState<string | null>(null);
  const { toast } = useToast();

  const otrosEstados = PIPELINE.filter((s) => s !== tramite.estado);

  async function handleMover(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!selected || moving) return;
    setMoving(true);
    setAdvError(null);
    try {
      const res = await fetch(`/api/tramites/${tramite.id}/estado`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ estado: selected }),
      });
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const msg =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : `Error ${res.status}`;
        setAdvError(msg);
        return;
      }
      toast({
        title: "Estado actualizado",
        description: `${tramite.doNumber} → ${selected.replace(/_/g, " ")}`,
        variant: "success",
      });
      setSelected("");
      onEstadoChanged?.();
    } catch (caught) {
      setAdvError(describirError(caught, "Sin conexión"));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className={`border ${cardBorder} bg-white shadow-sm transition hover:shadow-md hover:border-cyan-300`}>
      <Link href={`/tramites/${tramite.id}`} className="block p-3 text-sm">
        <p className="font-semibold text-cyan-700 hover:underline">{tramite.doNumber}</p>
        <p className="mt-1 truncate text-xs text-slate-600">{tramite.cliente}</p>
        {tramite.fechaApertura && tramite.fechaApertura !== "-" ? (
          <p className="mt-1 text-xs text-slate-500">
            ETA: {formatKanbanDate(tramite.fechaApertura)}
          </p>
        ) : null}
        {tramite.documentosPendientes !== null && tramite.documentosPendientes > 0 ? (
          <span className="mt-2 inline-flex items-center border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-600">
            {tramite.documentosPendientes} doc{tramite.documentosPendientes !== 1 ? "s" : ""} pendiente
            {tramite.documentosPendientes !== 1 ? "s" : ""}
          </span>
        ) : null}
      </Link>
      {puedeMover ? (
        <div className="border-t border-slate-100 px-2 pb-2 pt-1.5">
          <div className="flex items-center gap-1">
            <select
              value={selected}
              onChange={(e) => { setSelected(e.target.value); setAdvError(null); }}
              disabled={moving}
              onClick={(e) => e.preventDefault()}
              aria-label={`Mover ${tramite.doNumber} a otro estado`}
              className="h-6 min-w-0 flex-1 border border-slate-200 bg-white px-1 text-xs text-slate-600 outline-none focus:border-cyan-400 disabled:opacity-60"
            >
              <option value="">Mover a...</option>
              {otrosEstados.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={(e) => void handleMover(e)}
              disabled={moving || !selected}
              aria-label={`Confirmar cambio de estado de ${tramite.doNumber}`}
              title="Confirmar cambio de estado"
              className="inline-flex h-6 items-center border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-600 transition hover:border-cyan-400 hover:text-cyan-700 disabled:opacity-50"
            >
              {moving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            </button>
          </div>
          {advError ? (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-rose-600" role="alert">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              {advError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Columna ──────────────────────────────────────────────────────────────────

function KanbanColumn({
  estado,
  tarjetas,
  puedeMover,
  onEstadoChanged,
}: {
  estado: string;
  tarjetas: TramiteRow[];
  puedeMover: boolean;
  onEstadoChanged?: () => void;
}) {
  const colors = columnColor(estado);

  return (
    <div className="flex w-56 shrink-0 flex-col">
      {/* Encabezado columna */}
      <div className={`flex items-center gap-2 border ${colors.header} px-3 py-2`}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${colors.dot}`} aria-hidden="true" />
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-slate-700">
          {estado.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-xs font-bold text-slate-500">{tarjetas.length}</span>
      </div>

      {/* Tarjetas */}
      <div className="mt-2 flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: "72vh" }}>
        {tarjetas.length === 0 ? (
          <div className="border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">
            Sin DOs
          </div>
        ) : (
          tarjetas.map((t) => (
            <KanbanCard
              key={t.id}
              tramite={t}
              cardBorder={colors.card}
              puedeMover={puedeMover}
              onEstadoChanged={onEstadoChanged}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Tablero Kanban ───────────────────────────────────────────────────────────

type KanbanTramitesProps = {
  rows: TramiteRow[];
  onEstadoChanged?: () => void;
};

export function KanbanTramites({ rows, onEstadoChanged }: KanbanTramitesProps) {
  const puedeMover = usePermiso(ROLES_MOVER_ESTADO);

  // Group rows by estado; estados desconocidos van a una columna extra
  const grouped = new Map<string, TramiteRow[]>();

  for (const estado of PIPELINE) {
    grouped.set(estado, []);
  }

  for (const row of rows) {
    const key = PIPELINE.includes(row.estado) ? row.estado : "SOLICITUD";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  // Only show columns that exist in the pipeline (always show all for pipeline visibility)
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3" style={{ minWidth: `${PIPELINE.length * 236}px` }}>
        {PIPELINE.map((estado) => (
          <KanbanColumn
            key={estado}
            estado={estado}
            tarjetas={grouped.get(estado) ?? []}
            puedeMover={puedeMover}
            onEstadoChanged={onEstadoChanged}
          />
        ))}
      </div>
    </div>
  );
}
