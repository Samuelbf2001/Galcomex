-- Sprint: Beneficiarios N↔N por pago (2026-06-19)
-- Reemplaza la FK única beneficiarioId en pago_tramite con tabla pivot.

-- 1. Crear tabla pivot
CREATE TABLE "pago_tramite_beneficiario" (
  "pago_id"         TEXT NOT NULL,
  "beneficiario_id" TEXT NOT NULL,
  CONSTRAINT "pago_tramite_beneficiario_pkey" PRIMARY KEY ("pago_id", "beneficiario_id")
);

-- 2. Migrar datos existentes de la columna única al pivot
INSERT INTO "pago_tramite_beneficiario" ("pago_id", "beneficiario_id")
SELECT "id", "beneficiarioId"
FROM   "pago_tramite"
WHERE  "beneficiarioId" IS NOT NULL;

-- 3. FK hacia pago_tramite (CASCADE: borrar vínculo cuando se borra el pago)
ALTER TABLE "pago_tramite_beneficiario"
  ADD CONSTRAINT "pago_tramite_beneficiario_pago_id_fkey"
  FOREIGN KEY ("pago_id") REFERENCES "pago_tramite"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. FK hacia beneficiario (RESTRICT: no borrar beneficiario con pagos vinculados)
ALTER TABLE "pago_tramite_beneficiario"
  ADD CONSTRAINT "pago_tramite_beneficiario_beneficiario_id_fkey"
  FOREIGN KEY ("beneficiario_id") REFERENCES "beneficiario"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Eliminar columna antigua (datos ya migrados al pivot)
ALTER TABLE "pago_tramite" DROP COLUMN IF EXISTS "beneficiarioId";
