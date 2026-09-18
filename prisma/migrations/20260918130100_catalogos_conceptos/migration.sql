-- Configuración → Catálogos (fase 1). Ver docs/CATALOGOS.md.
--   · `concepto_venta`: maestro único de "lo que Galcomex vende". El nombre del
--     concepto en la plataforma y en la factura Siigo debe ser el mismo
--     (decisión de Camila, reunión 10-sep-2026).
--   · `tarifa_item.conceptoId`: enlace opcional al maestro; nada se rompe, los
--     ítems viejos siguen resolviéndose por `concepto` + `siigoCodigo`.
--   · `siigo_producto_impuesto.origen`: distingue lo que trae el sync de Siigo
--     (`taxes` de /v1/products) de lo que se puso a mano, para no pisarlo.

-- ─── 1. Origen de la asociación producto ↔ impuesto ──────────────────────────
CREATE TYPE "OrigenImpuestoProducto" AS ENUM ('SIIGO', 'MANUAL');

-- Las filas que ya existen se pusieron a mano desde la UI: quedan MANUAL.
ALTER TABLE "siigo_producto_impuesto"
  ADD COLUMN "origen" "OrigenImpuestoProducto" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sincronizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ─── 2. Maestro de conceptos de venta ────────────────────────────────────────
CREATE TABLE "concepto_venta" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "siigoProductoId" TEXT,
    "aplicaIva" BOOLEAN NOT NULL DEFAULT true,
    "tipoCalculoSugerido" "TipoCalculoTarifa",
    "unidadSugerida" "UnidadTarifa",
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "concepto_venta_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "concepto_venta_codigo_key" ON "concepto_venta"("codigo");
CREATE INDEX "concepto_venta_activo_orden_idx" ON "concepto_venta"("activo", "orden");

ALTER TABLE "concepto_venta"
  ADD CONSTRAINT "concepto_venta_siigoProductoId_fkey"
  FOREIGN KEY ("siigoProductoId") REFERENCES "siigo_producto"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. Enlace del tarifario al maestro ──────────────────────────────────────
ALTER TABLE "tarifa_item" ADD COLUMN "conceptoId" TEXT;

CREATE INDEX "tarifa_item_conceptoId_idx" ON "tarifa_item"("conceptoId");

ALTER TABLE "tarifa_item"
  ADD CONSTRAINT "tarifa_item_conceptoId_fkey"
  FOREIGN KEY ("conceptoId") REFERENCES "concepto_venta"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- El backfill de datos (crear los conceptos desde plantillas.ts y enlazar los
-- tarifa_item existentes por `concepto`) NO va aquí: vive en
-- `npx tsx scripts/seed-conceptos-venta.ts`, que es idempotente y tiene --dry-run.
