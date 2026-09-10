/**
 * Agregados del dashboard contra la BD local (Postgres :5433).
 *
 * Los totales del dashboard se calculan en SQL (SUM/COUNT + ::bigint). Este
 * test los compara, sobre los datos reales de la BD, con la implementación
 * de referencia en memoria (la que existía antes del cambio): findMany de
 * todo + reduce con BigInt. Tolerancia 0 pesos.
 *
 * Se omite si DATABASE_URL no está definida o la BD no responde.
 */

import "dotenv/config";

import { DestinoPago, EstadoBorrador, EstadoTramite, TipoPagoFactura } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { calcularSaldoNeto } from "@/lib/cartera/service";
import { prisma } from "@/lib/db/prisma";

import {
  LIMITE_LISTAS_DASHBOARD,
  calcularDiasYAlerta,
  getAnticiposConSaldo,
  getDashboardData,
  getSaldosNetoPorCliente,
} from "../service";

let dbDisponible = false;
let motivo = "DATABASE_URL no está definida; se omiten los agregados del dashboard";

function requiereDb(ctx: { skip: (note?: string) => void }) {
  if (!dbDisponible) {
    ctx.skip(motivo);
    throw new Error("Test omitido porque la BD local no está disponible");
  }
}

describe("dashboard: agregados SQL vs referencia en memoria", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbDisponible = true;
    } catch (error) {
      motivo = `BD local no disponible: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  it("saldo neto por cliente: SUM en SQL == Σ calcularSaldoNeto por factura", async (ctx) => {
    requiereDb(ctx);

    const clientes = await prisma.cliente.findMany({
      select: {
        id: true,
        nombre: true,
        facturas: {
          select: {
            saldoAFavorCliente: true,
            saldoACargoCliente: true,
            pagos: {
              where: { destino: DestinoPago.CLIENTE },
              select: { tipo: true, monto: true },
            },
          },
        },
      },
    });

    const referencia = new Map<string, bigint>();
    for (const cliente of clientes) {
      const saldoNeto = cliente.facturas.reduce((acc, f) => {
        const abonos = f.pagos
          .filter((p) => p.tipo === TipoPagoFactura.ABONO)
          .reduce((sum, p) => sum + p.monto, 0n);
        const devoluciones = f.pagos
          .filter((p) => p.tipo === TipoPagoFactura.DEVOLUCION)
          .reduce((sum, p) => sum + p.monto, 0n);
        return (
          acc +
          calcularSaldoNeto({
            saldoAFavor: f.saldoAFavorCliente,
            saldoACargo: f.saldoACargoCliente,
            abonos,
            devoluciones,
          })
        );
      }, 0n);
      referencia.set(cliente.id, saldoNeto);
    }

    const agregado = await getSaldosNetoPorCliente();

    // Misma población (todos los clientes, con o sin facturas) ...
    expect(new Set(agregado.map((c) => c.clienteId))).toEqual(new Set(referencia.keys()));
    // ... y mismo saldo, peso a peso, siempre como bigint.
    for (const c of agregado) {
      expect(typeof c.saldoNeto).toBe("bigint");
      expect(c.saldoNeto, `cliente ${c.clienteNombre}`).toBe(referencia.get(c.clienteId));
    }
  });

  it("anticipos con saldo: COUNT/SUM en SQL == recorrido en memoria", async (ctx) => {
    requiereDb(ctx);

    const anticipos = await prisma.anticipo.findMany({
      select: { monto: true, aplicaciones: { select: { montoAplicado: true } } },
    });

    let cantidad = 0;
    let totalRestante = 0n;
    for (const anticipo of anticipos) {
      const aplicado = anticipo.aplicaciones.reduce((sum, ap) => sum + ap.montoAplicado, 0n);
      const restante = anticipo.monto - aplicado;
      if (restante > 0n) {
        cantidad += 1;
        totalRestante += restante;
      }
    }

    const resumen = await getAnticiposConSaldo();
    expect(resumen.cantidad).toBe(cantidad);
    expect(resumen.totalRestante).toBe(totalRestante.toString());
  });

  it("pendientes de facturar y cartera vencida: página recortada + contadores/totales completos", async (ctx) => {
    requiereDb(ctx);

    const hoy = new Date();
    const data = await getDashboardData();

    // ── Pendientes de facturar ──────────────────────────────────────────────
    const pendientesRef = await prisma.tramiteDO.findMany({
      where: {
        estado: { in: [EstadoTramite.DESPACHADO, EstadoTramite.ENVIADO_A_FACTURAR] },
        borradores: { none: { estado: EstadoBorrador.FACTURADO } },
      },
      select: { id: true, fechaSalidaCarga: true, fechaEnviadoAFacturar: true },
    });
    const idsRef = new Set(pendientesRef.map((t) => t.id));
    const conAlertaRef = pendientesRef.filter(
      (t) => calcularDiasYAlerta(t.fechaSalidaCarga ?? t.fechaEnviadoAFacturar, hoy).alerta,
    ).length;

    expect(data.cantidadPendientesFacturar).toBe(pendientesRef.length);
    expect(data.cantidadPendientesConAlerta).toBe(conAlertaRef);
    expect(data.pendientesFacturar.length).toBe(
      Math.min(LIMITE_LISTAS_DASHBOARD, pendientesRef.length),
    );
    for (const fila of data.pendientesFacturar) {
      expect(idsRef.has(fila.id)).toBe(true);
    }
    // Más urgentes primero: `dias` no crece a lo largo de la página.
    for (let i = 1; i < data.pendientesFacturar.length; i += 1) {
      expect(data.pendientesFacturar[i - 1]!.dias).toBeGreaterThanOrEqual(
        data.pendientesFacturar[i]!.dias,
      );
    }

    // ── Cartera vencida ─────────────────────────────────────────────────────
    const vencidasRef = await prisma.factura.findMany({
      where: { saldoACargoCliente: { gt: 0n }, fechaPagoCliente: null },
      select: { id: true, saldoACargoCliente: true },
      orderBy: [{ fecha: "asc" }, { id: "asc" }],
    });
    const totalRef = vencidasRef.reduce((sum, f) => sum + f.saldoACargoCliente, 0n);

    expect(data.totalCarteraVencida).toBe(totalRef.toString());
    expect(data.cantidadFacturasVencidas).toBe(vencidasRef.length);
    expect(data.carteraVencida.map((f) => f.id)).toEqual(
      vencidasRef.slice(0, LIMITE_LISTAS_DASHBOARD).map((f) => f.id),
    );
  });
});
