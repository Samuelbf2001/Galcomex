/**
 * Escenario de demo para cobros (abonos parciales) y devoluciones.
 *  1. Crea un DO con saldo A CARGO del cliente (anticipo < pagos) → factura → 2 abonos parciales.
 *  2. Sobre la factura real BUN26-0026 (saldo a favor) registra una devolución parcial al cliente
 *     y la devolución total a LM.
 * Idempotente. Uso: npx tsx scripts/demo-cobros.ts
 */
import {
  AgenciaAduanas,
  CanalPago,
  Ciudad,
  DestinoPago,
  EstadoBorrador,
  Rol,
  TipoCliente,
  TipoPagoFactura,
  TipoRecaudo,
} from "@prisma/client";

import { generarBorrador, transicionarBorrador } from "../src/lib/borradores/service";
import { registrarPagoFacturaAbono } from "../src/lib/cartera/service";
import { prisma } from "../src/lib/db/prisma";
import { crearPago } from "../src/lib/pagos/service";

const CONSECUTIVO = "DO.CTG26-9009";
const NIT_DEMO = "DEMO-COBROS-NIT";
const MARKER = "DEMO:COBROS";

function fmt(n: bigint): string {
  return new Intl.NumberFormat("es-CO").format(n);
}

async function limpiarPrevio() {
  const existing = await prisma.tramiteDO.findUnique({
    where: { consecutivo: CONSECUTIVO },
    select: { id: true },
  });
  if (existing) {
    const tramiteId = existing.id;
    const borradores = await prisma.borradorFactura.findMany({
      where: { tramiteId },
      select: { id: true },
    });
    const facturas = await prisma.factura.findMany({
      where: { borradorId: { in: borradores.map((b) => b.id) } },
      select: { id: true },
    });
    await prisma.pagoFactura.deleteMany({ where: { facturaId: { in: facturas.map((f) => f.id) } } });
    await prisma.factura.deleteMany({ where: { borradorId: { in: borradores.map((b) => b.id) } } });
    await prisma.borradorFactura.deleteMany({ where: { tramiteId } });
    await prisma.pagoTramite.deleteMany({ where: { tramiteId } });
    await prisma.aplicacionAnticipo.deleteMany({ where: { tramiteId } });
    await prisma.auditLog.deleteMany({ where: { tramiteId } });
    await prisma.estadoLog.deleteMany({ where: { tramiteId } });
    await prisma.tramiteDO.delete({ where: { id: tramiteId } });
  }
  await prisma.anticipo.deleteMany({ where: { soporteKey: MARKER } });
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { rol: Rol.ADMIN }, select: { id: true } });
  if (!admin) throw new Error("No hay usuario ADMIN (corre el seed).");

  await limpiarPrevio();

  // ── 1. DO con saldo A CARGO ────────────────────────────────────────────────
  const cliente = await prisma.cliente.upsert({
    where: { nit: NIT_DEMO },
    update: {},
    create: { nombre: "DEMO COBROS S.A.S.", nit: NIT_DEMO, tipo: TipoCliente.PROPIO },
  });

  const tramite = await prisma.tramiteDO.create({
    data: {
      consecutivo: CONSECUTIVO,
      ciudad: Ciudad.CTG,
      anio: 2026,
      numero: 9009,
      clienteId: cliente.id,
      agenciaAduanas: AgenciaAduanas.COLDEX,
      creadoPorId: admin.id,
      comentarios: MARKER,
    },
  });

  const anticipoMonto = 5_000_000n;
  const anticipo = await prisma.anticipo.create({
    data: {
      clienteId: cliente.id,
      monto: anticipoMonto,
      fecha: new Date("2026-05-02"),
      tipoRecaudo: TipoRecaudo.BANCOLOMBIA,
      costoRecaudo: 1_950n,
      soporteKey: MARKER,
      verificadoBanco: true,
    },
  });
  await prisma.aplicacionAnticipo.create({
    data: { anticipoId: anticipo.id, tramiteId: tramite.id, montoAplicado: anticipoMonto },
  });

  // Pagos > anticipo → sobregiro → saldo a cargo del cliente
  await crearPago({
    tramiteId: tramite.id,
    concepto: "IMPUESTOS DE ADUANAS DIAN",
    numSoporte: "DECL-9009",
    valor: 7_000_000n,
    canalPago: CanalPago.PSE,
    usuarioId: admin.id,
  });

  const borrador = await generarBorrador({
    tramiteId: tramite.id,
    comision: 200_000n,
    usuarioId: admin.id,
  });

  for (const estado of [EstadoBorrador.EN_REVISION, EstadoBorrador.APROBADO, EstadoBorrador.FACTURADO] as const) {
    const res = await transicionarBorrador({
      borradorId: borrador.id,
      nuevoEstado: estado,
      usuarioId: admin.id,
      ...(estado === EstadoBorrador.FACTURADO
        ? { numFacturaSiigo: "BAQ-19009", fechaFactura: new Date("2026-05-13") }
        : {}),
    });
    if (!res.ok) throw new Error(`No se pudo transicionar a ${estado}: ${res.message}`);
  }

  const factura = await prisma.factura.findFirst({
    where: { borrador: { tramiteId: tramite.id } },
    select: { id: true, saldoACargoCliente: true, numSiigo: true },
  });
  if (!factura) throw new Error("No se creó la factura de demo");

  console.log(`\n✅ Factura A CARGO ${factura.numSiigo}: cliente debe ${fmt(factura.saldoACargoCliente)}`);

  // Dos abonos parciales del cliente
  for (const [i, monto] of [800_000n, 800_000n].entries()) {
    const res = await registrarPagoFacturaAbono({
      facturaId: factura.id,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.ABONO,
      monto,
      fecha: new Date(`2026-05-${20 + i}`),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      verificadoBanco: true,
      usuarioId: admin.id,
    });
    if (!res.ok) throw new Error(`Abono falló: ${res.message}`);
    console.log(`   ✚ Abono ${i + 1}: ${fmt(monto)}`);
  }
  const pendiente = factura.saldoACargoCliente - 1_600_000n;
  console.log(`   → Pendiente de cobro: ${fmt(pendiente)} (parcial)`);

  // ── 2. Devolución sobre la factura real BUN26-0026 (saldo a favor) ──────────
  const facturaBun = await prisma.factura.findFirst({
    where: { numSiigo: "BAQ-18288" },
    select: { id: true, saldoAFavorCliente: true, saldoAFavorLM: true },
  });
  if (facturaBun) {
    // Limpia devoluciones de demo previas para idempotencia
    await prisma.pagoFactura.deleteMany({
      where: { facturaId: facturaBun.id, tipo: TipoPagoFactura.DEVOLUCION },
    });

    const devCliente = await registrarPagoFacturaAbono({
      facturaId: facturaBun.id,
      destino: DestinoPago.CLIENTE,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: 1_000_000n,
      fecha: new Date("2026-04-01"),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      verificadoBanco: true,
      usuarioId: admin.id,
    });
    if (!devCliente.ok) throw new Error(`Devolución cliente falló: ${devCliente.message}`);
    console.log(`\n✅ BAQ-18288: devolución parcial al cliente 1.000.000 (de ${fmt(facturaBun.saldoAFavorCliente)})`);

    const devLM = await registrarPagoFacturaAbono({
      facturaId: facturaBun.id,
      destino: DestinoPago.LM,
      tipo: TipoPagoFactura.DEVOLUCION,
      monto: facturaBun.saldoAFavorLM,
      fecha: new Date("2026-04-01"),
      canalPago: CanalPago.TRANSF_BANCOLOMBIA,
      verificadoBanco: true,
      usuarioId: admin.id,
    });
    if (!devLM.ok) throw new Error(`Devolución LM falló: ${devLM.message}`);
    console.log(`   ✚ Devolución total a LM ${fmt(facturaBun.saldoAFavorLM)} → LM saldado`);
  }

  console.log(`\n🎉 Escenario de demo listo. Cliente DEMO COBROS S.A.S. y factura BAQ-18288.\n`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
