/**
 * Aviso de la orden de compra en la revisión del borrador (B4, Diseño B).
 *
 * El servidor evalúa la OC (`lib/borradores/orden-compra.ts`) y manda en
 * `borrador.ordenCompra` el N°, el valor, la config de la empresa y los DOs
 * hermanos de una OC compartida. Aquí la cuenta se REPITE con las líneas
 * actuales del borrador (misma función pura), así el aviso sigue en vivo cuando
 * el revisor edita líneas — las respuestas de esas ediciones no traen
 * `ordenCompra` (lección M1 del anticipo: si el aviso dependiera de recargar,
 * desaparecería tras la primera acción).
 *
 * Verde: cuadra. Rojo: no cuadra o falta el valor, y no se puede aprobar
 * (solo la administradora, con motivo). Nada de esto va a comentariosCabecera.
 */

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  formatCOP,
  type EvaluacionOcDto,
  type LineaRevisionRow,
  type OrdenCompraBorradorDto,
} from "@/components/facturacion/facturacion-api";
import { desgloseParaOc, evaluarOrdenCompra, explicacionBaseOc } from "@/lib/borradores/orden-compra";

/**
 * Evaluación con las líneas ACTUALES. Solo cuando el servidor ya dijo
 * CUADRA/NO_CUADRA (trae valor de la OC y config); SIN_VALOR y SIN_OC no
 * dependen de las líneas.
 */
export function evaluacionEnVivo(
  oc: OrdenCompraBorradorDto,
  lineas: readonly Pick<LineaRevisionRow, "valor" | "seccion" | "tipoFija">[],
): EvaluacionOcDto {
  const ev = oc.evaluacion;
  if (ev.estado !== "CUADRA" && ev.estado !== "NO_CUADRA") return ev;

  const vivo = evaluarOrdenCompra({
    numero: ev.numero,
    valorOc: BigInt(ev.valorOc),
    desglose: desgloseParaOc(lineas.map((l) => ({ valor: BigInt(l.valor), seccion: l.seccion, tipoFija: l.tipoFija }))),
    config: ev.config,
  });
  if (vivo.estado !== "CUADRA" && vivo.estado !== "NO_CUADRA") return ev;

  return {
    estado: vivo.estado,
    numero: vivo.numero,
    valorOc: vivo.valorOc.toString(),
    base: vivo.base.toString(),
    diferencia: vivo.diferencia.toString(),
    desglose: {
      servicio: vivo.desglose.servicio.toString(),
      terceros: vivo.desglose.terceros.toString(),
      cuatroXMil: vivo.desglose.cuatroXMil.toString(),
    },
    config: vivo.config,
  };
}

/** «$439.000 (DO.BAQ26-0080)», con «sin valor» si el DO hermano no tiene el valor de su parte. */
function textoHermano(h: { consecutivo: string; valorOc: string | null }): string {
  return `${h.consecutivo} (${h.valorOc === null ? "sin valor" : formatCOP(h.valorOc)})`;
}

function listaHermanos(hermanos: OrdenCompraBorradorDto["hermanos"]): string {
  const textos = hermanos.map(textoHermano);
  if (textos.length <= 1) return textos.join("");
  return `${textos.slice(0, -1).join(", ")} y ${textos[textos.length - 1]}`;
}

export function AvisoOrdenCompra({
  oc,
  lineas,
}: {
  oc: OrdenCompraBorradorDto | null | undefined;
  lineas: readonly Pick<LineaRevisionRow, "valor" | "seccion" | "tipoFija">[];
}) {
  if (!oc || oc.evaluacion.estado === "SIN_OC") return null;
  const ev = evaluacionEnVivo(oc, lineas);
  if (ev.estado === "SIN_OC") return null;

  const bloquea = oc.config.bloqueaAprobacion;

  let tono: "ok" | "error" | "aviso";
  let titulo: string;
  let detalle: string;

  if (ev.estado === "SIN_VALOR") {
    tono = bloquea ? "error" : "aviso";
    titulo = `Orden de compra N° ${ev.numero} (sin valor registrado en el DO)`;
    detalle = bloquea
      ? "Escribe el valor de la OC en el Resumen del DO (o quita el número) para poder aprobar."
      : "Registra el valor de la OC en el Resumen del DO para contrastarla aquí.";
  } else if (ev.estado === "CUADRA") {
    tono = "ok";
    titulo = `Cuadra con la orden de compra ${ev.numero} por ${formatCOP(ev.valorOc)}`;
    const partes =
      ev.config.base === "SERVICIO_Y_TERCEROS"
        ? `servicio ${formatCOP(ev.desglose.servicio)} + reembolsos ${formatCOP(ev.desglose.terceros)}`
        : `solo el servicio ${formatCOP(ev.desglose.servicio)}`;
    detalle = `${partes}${ev.config.incluye4x1000 ? ` + 4x1000 ${formatCOP(ev.desglose.cuatroXMil)}` : "; el 4x1000 no entra"}. El número ya va en la cabecera.`;
  } else {
    const dif = BigInt(ev.diferencia);
    const absoluta = (dif < 0n ? -dif : dif).toString();
    tono = bloquea ? "error" : "aviso";
    titulo = `No cuadra con la orden de compra ${ev.numero}: ${dif < 0n ? "faltan" : "sobran"} ${formatCOP(absoluta)}`;
    detalle = `La factura suma ${formatCOP(ev.base)} (${explicacionBaseOc(ev.config)}) y la OC es de ${formatCOP(ev.valorOc)}. ${
      bloquea
        ? "No se puede aprobar: corrígela, devuélvela o pide una OC nueva. Solo la administradora puede aprobarla así, con un motivo."
        : "Revisa antes de aprobar."
    }`;
  }

  const clases =
    tono === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tono === "error"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : "border-amber-200 bg-amber-50 text-amber-800";
  const Icono = tono === "ok" ? CheckCircle2 : AlertTriangle;

  return (
    <div role={tono === "ok" ? "status" : "alert"} className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${clases}`}>
      <Icono className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">{titulo}</p>
        <p className="text-xs">{detalle}</p>
        {oc.hermanos.length > 0 ? (
          <p className="mt-1 text-xs">
            Esta OC también está en {listaHermanos(oc.hermanos)}
            {oc.sumaHermanos !== null ? `: las partes suman ${formatCOP(oc.sumaHermanos)}. Compáralo con el PDF de la OC.` : "."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
