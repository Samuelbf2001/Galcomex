/**
 * GET /api/cartera/alertas — Clientes con cartera bajo el umbral de alerta (C2)
 *
 * Agrega el saldo neto (WS-D) por cliente en las dos vistas (CLIENTE y LM) y
 * devuelve solo los clientes cuya deuda acumulada supera
 * `UMBRAL_CARTERA_CLIENTE_ALERTA` (reunión 1-jul-2026, 01:13:59–01:15:20).
 * Roles: ADMIN, REVISOR (mismos que /api/cartera)
 */

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getClientesEnAlertaCartera } from "@/lib/cartera/service";
import { jsonResponse } from "@/lib/http/json";

export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const clientes = await getClientesEnAlertaCartera();

  return jsonResponse({ clientes });
}
