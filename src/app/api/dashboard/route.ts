/**
 * GET /api/dashboard — Datos operativos del dashboard
 * Roles: ADMIN, REVISOR, OPERATIVO
 */

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/dashboard/service";
import { jsonResponse } from "@/lib/http/json";

export async function GET() {
  const session = await requireRole(["ADMIN", "REVISOR", "OPERATIVO"]);

  if (session instanceof NextResponse) {
    return session;
  }

  const data = await getDashboardData();

  return jsonResponse(data);
}
