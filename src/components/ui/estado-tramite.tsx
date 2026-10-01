import { cn } from "@/lib/utils";

/**
 * Estado de un DO con el mismo nombre y el mismo color en todas las pantallas
 * (lista de trámites, ficha de la empresa, archivos, detalle, hoja). Antes cada
 * módulo pintaba el código crudo (EN_TRAMITE) con su propio color: FACTURADO
 * salía verde en un lado y morado en otro.
 */
export const ETIQUETA_ESTADO_TRAMITE: Record<string, string> = {
  SOLICITUD: "Solicitud",
  APERTURA: "Apertura",
  EN_TRAMITE: "En trámite",
  EN_PUERTO: "En puerto",
  DESPACHADO: "Despachado",
  ENVIADO_A_FACTURAR: "Enviado a facturar",
  FACTURADO: "Facturado",
  PAGADO: "Pagado",
  CERRADO: "Cerrado",
};

const COLOR_ESTADO_TRAMITE: Record<string, string> = {
  SOLICITUD: "border-slate-300 bg-white text-slate-700",
  APERTURA: "border-slate-300 bg-slate-50 text-slate-700",
  EN_TRAMITE: "border-sky-200 bg-sky-50 text-sky-800",
  EN_PUERTO: "border-sky-200 bg-sky-50 text-sky-800",
  // Despachado / enviado a facturar = falta facturar: ámbar porque pide acción.
  DESPACHADO: "border-amber-200 bg-amber-50 text-amber-800",
  ENVIADO_A_FACTURAR: "border-amber-200 bg-amber-50 text-amber-800",
  FACTURADO: "border-emerald-200 bg-emerald-50 text-emerald-800",
  PAGADO: "border-emerald-300 bg-emerald-100 text-emerald-900",
  CERRADO: "border-slate-300 bg-slate-100 text-slate-600",
};

export function etiquetaEstadoTramite(estado: string | null | undefined): string {
  if (!estado) return "—";
  return ETIQUETA_ESTADO_TRAMITE[estado] ?? humanizarCodigo(estado);
}

export function claseEstadoTramite(estado: string | null | undefined): string {
  return (estado && COLOR_ESTADO_TRAMITE[estado]) || "border-slate-200 bg-slate-50 text-slate-700";
}

export function EstadoTramiteBadge({
  estado,
  className,
}: {
  estado: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center whitespace-nowrap border px-2 text-xs font-semibold",
        claseEstadoTramite(estado),
        className,
      )}
    >
      {etiquetaEstadoTramite(estado)}
    </span>
  );
}

/**
 * Convierte un código interno (OTROS_BANCOS, CREATE_CHECKLIST_ITEM) en texto
 * legible ("Otros bancos") para cuando no hay una etiqueta escrita a mano.
 */
export function humanizarCodigo(codigo: string): string {
  const texto = codigo.replace(/[_-]+/g, " ").trim().toLowerCase();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : codigo;
}
