-- Sprint 8 — Ajustes 2026-06-18
-- p.2  EstadoMovimiento en Anticipo, PagoTramite, PagoFactura
-- p.3  beneficiarioId en FacturaProveedor (unificación con Beneficiario)
-- p.5  campo concepto en FacturaProveedor
-- p.6  tabla pivot PagoTramiteFactura (N↔N PagoTramite ↔ FacturaProveedor)
--       + drop de factura_proveedor_id en pago_tramite

-- ─── 1. Nuevo enum EstadoMovimiento ─────────────────────────────────────────
CREATE TYPE "EstadoMovimiento" AS ENUM ('BORRADOR', 'REALIZADO', 'VERIFICADO');

-- ─── 2. Agregar estado a anticipo ────────────────────────────────────────────
ALTER TABLE "anticipo" ADD COLUMN "estado" "EstadoMovimiento" NOT NULL DEFAULT 'REALIZADO';

-- ─── 3. Agregar estado a pago_tramite ────────────────────────────────────────
-- Primero se quita la columna fecha_esperada_pago (p.8 — eliminada del modelo)
ALTER TABLE "pago_tramite" DROP COLUMN IF EXISTS "fecha_esperada_pago";
ALTER TABLE "pago_tramite" ADD COLUMN "estado" "EstadoMovimiento" NOT NULL DEFAULT 'REALIZADO';

-- ─── 4. Agregar estado a pago_factura ────────────────────────────────────────
ALTER TABLE "pago_factura" ADD COLUMN "estado" "EstadoMovimiento" NOT NULL DEFAULT 'REALIZADO';

-- ─── 5. Nuevos campos en factura_proveedor ───────────────────────────────────
ALTER TABLE "factura_proveedor" ADD COLUMN "concepto" TEXT;
ALTER TABLE "factura_proveedor" ADD COLUMN "beneficiario_id" TEXT;

ALTER TABLE "factura_proveedor"
  ADD CONSTRAINT "factura_proveedor_beneficiario_id_fkey"
  FOREIGN KEY ("beneficiario_id") REFERENCES "beneficiario"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 6. Tabla pivot PagoTramiteFactura ───────────────────────────────────────
CREATE TABLE "pago_tramite_factura" (
  "pago_id"    TEXT NOT NULL,
  "factura_id" TEXT NOT NULL,
  CONSTRAINT "pago_tramite_factura_pkey" PRIMARY KEY ("pago_id", "factura_id")
);

-- Backfill: migrar relación 1→N existente al pivot N↔N
-- El bloque condicional protege bases de datos limpias donde la columna nunca existió.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pago_tramite' AND column_name = 'facturaProveedorId'
  ) THEN
    INSERT INTO "pago_tramite_factura" ("pago_id", "factura_id")
    SELECT "id", "facturaProveedorId"
    FROM   "pago_tramite"
    WHERE  "facturaProveedorId" IS NOT NULL;
  END IF;
END $$;

-- FK del pivot hacia pago_tramite (CASCADE: si se borra el pago, se borra el vínculo)
ALTER TABLE "pago_tramite_factura"
  ADD CONSTRAINT "pago_tramite_factura_pago_id_fkey"
  FOREIGN KEY ("pago_id") REFERENCES "pago_tramite"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK del pivot hacia factura_proveedor (RESTRICT: no borrar factura con pagos)
ALTER TABLE "pago_tramite_factura"
  ADD CONSTRAINT "pago_tramite_factura_factura_id_fkey"
  FOREIGN KEY ("factura_id") REFERENCES "factura_proveedor"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 7. Drop columna antigua (ya migrada al pivot) ───────────────────────────
ALTER TABLE "pago_tramite"
  DROP CONSTRAINT IF EXISTS "pago_tramite_facturaProveedorId_fkey";
ALTER TABLE "pago_tramite" DROP COLUMN IF EXISTS "facturaProveedorId";
