/**
 * POST /api/cartera/alertas/notificar — Emite `cartera.vencida` hacia n8n.
 *
 * A diferencia de los otros cuatro eventos, `cartera.vencida` no lo dispara una
 * acción de usuario sino una CONDICIÓN acumulada: la cartera de un cliente cae
 * bajo el umbral. Evaluar eso en cada pago sería caro y ruidoso (el mismo
 * cliente cruzaría el umbral de ida y vuelta varias veces al día), así que la
 * evaluación se expone como un endpoint que n8n invoca en agenda — n8n ya lo
 * opera Galcomex y es donde corresponde vivir la periodicidad.
 *
 * Emite un evento por cada cliente en alerta. Si no hay ninguno, no emite nada
 * y responde 200: "sin novedad" es una respuesta válida, no un error.
 *
 * Origen: reunión 1-jul-2026, min 01:14 — "vamos a alertar cuando ya el cliente
 * esté bajo menos 20 millones… vamos a mandarla al señor Guillermo".
 *
 * AUTORIZACIÓN: quien llama esto en la práctica es el workflow programado de
 * n8n, no una persona con sesión de navegador — `requireRole` por sí solo
 * habría dejado el endpoint inalcanzable para la propia automatización que
 * necesita invocarlo. Acepta CUALQUIERA de los dos caminos: un ADMIN con
 * sesión (para disparar la evaluación a mano) o el secreto de servicio
 * `CARTERA_ALERTAS_SERVICE_TOKEN` vía `Authorization: Bearer <secreto>` (para
 * la agenda de n8n). Sin ese secreto configurado, la ruta de servicio
 * simplemente nunca autoriza — no hay fallback inseguro.
 */

import { NextRequest, NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { tieneTokenDeServicioValido } from "@/lib/auth/service-token";
import {
  getClientesEnAlertaCartera,
  type ClienteEnAlertaCarteraRow,
} from "@/lib/cartera/service";
import { jsonResponse } from "@/lib/http/json";
import {
  CLAVES_UMBRAL,
  DEFAULTS_UMBRAL,
  getParametroBigInt,
} from "@/lib/parametros/service";
import { dispatchWebhookEvent } from "@/lib/webhooks";

/**
 * Deuda real de un cliente a partir de sus dos acumulados, en la convención de
 * signo de `evaluarAlertaCarteraCliente`: negativo ⇒ la parte le debe a
 * Galcomex. Se toma la vista que efectivamente disparó la alerta; si ambas lo
 * hicieron, la de mayor deuda, que es la que Guillermo necesita ver primero.
 */
function saldoQueDisparoLaAlerta(fila: ClienteEnAlertaCarteraRow): bigint {
  const candidatos: bigint[] = [];
  if (fila.alertaCliente) candidatos.push(BigInt(fila.saldoNetoCliente));
  if (fila.alertaLM) candidatos.push(BigInt(fila.saldoNetoLM));
  if (candidatos.length === 0) return 0n;
  return candidatos.reduce((peor, actual) => (actual < peor ? actual : peor));
}

export async function POST(request: NextRequest) {
  const autorizadoPorServicio = tieneTokenDeServicioValido(
    request.headers.get("authorization"),
    process.env.CARTERA_ALERTAS_SERVICE_TOKEN,
  );

  if (!autorizadoPorServicio) {
    const session = await requireRole(["ADMIN"]);
    if (session instanceof NextResponse) {
      return session;
    }
  }

  const clientes = await getClientesEnAlertaCartera();
  const umbral = await getParametroBigInt(
    CLAVES_UMBRAL.carteraCliente,
    DEFAULTS_UMBRAL.carteraCliente,
  );

  let emitidos = 0;

  for (const fila of clientes) {
    const saldo = saldoQueDisparoLaAlerta(fila);
    const deuda = saldo < 0n ? -saldo : 0n;

    const resultado = await dispatchWebhookEvent("cartera.vencida", {
      clienteId: fila.clienteId,
      clienteNombre: fila.clienteNombre,
      saldoNetoAcumulado: saldo.toString(),
      deuda: deuda.toString(),
      umbral: umbral.toString(),
    });

    if (resultado.ok) emitidos += 1;
  }

  return jsonResponse({
    clientesEnAlerta: clientes.length,
    eventosEmitidos: emitidos,
  });
}
