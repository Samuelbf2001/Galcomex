"use client";

import { FileText, Loader2 } from "lucide-react";
import { useState } from "react";

import { describirError, useToast } from "@/components/ui/toast";

/**
 * B7 — "Cotización (PDF)" del DO: descarga la solicitud de fondos con la misma
 * cuenta que la factura (`GET /api/tramites/[id]/cotizacion/pdf`; ADMIN,
 * REVISOR y OPERATIVO, los mismos que ven la propuesta del tarifario). Solo se
 * muestra cuando la propuesta no tiene pendientes; si el servidor aun así
 * responde 422 (p. ej. la empresa factura con el formato de comisión), el
 * motivo sale en un aviso.
 */
export function BotonCotizacionPdf({ tramiteId, consecutivo }: { tramiteId: string; consecutivo?: string }) {
  const { toast } = useToast();
  const [descargando, setDescargando] = useState(false);

  async function descargar() {
    if (descargando) return;
    setDescargando(true);
    try {
      const respuesta = await fetch(`/api/tramites/${encodeURIComponent(tramiteId)}/cotizacion/pdf`, {
        cache: "no-store",
      });
      if (!respuesta.ok) {
        let mensaje = `Error ${respuesta.status}`;
        try {
          const cuerpo: unknown = await respuesta.json();
          if (typeof cuerpo === "object" && cuerpo !== null && "error" in cuerpo && typeof cuerpo.error === "string") {
            mensaje = cuerpo.error;
          }
        } catch {
          /* sin cuerpo */
        }
        throw new Error(mensaje);
      }
      const url = URL.createObjectURL(await respuesta.blob());
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `cotizacion-${consecutivo ?? tramiteId}.pdf`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (caught) {
      toast({ title: "No se pudo generar la cotización", description: describirError(caught), variant: "error" });
    } finally {
      setDescargando(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void descargar()}
      disabled={descargando}
      className="inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
    >
      {descargando ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <FileText className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Cotización (PDF)
    </button>
  );
}
