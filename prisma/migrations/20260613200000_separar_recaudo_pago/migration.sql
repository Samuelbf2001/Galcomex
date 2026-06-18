-- CreateEnum
CREATE TYPE "TipoRecaudo" AS ENUM ('BANCOLOMBIA', 'OTROS_BANCOS', 'SUCURSAL', 'CORRESPONSAL', 'CAJERO');

-- Step 1: Add tipoRecaudo (with temp default) and costoRecaudo to anticipo
ALTER TABLE "anticipo" ADD COLUMN "tipoRecaudo" "TipoRecaudo" NOT NULL DEFAULT 'BANCOLOMBIA';
ALTER TABLE "anticipo" ADD COLUMN "costoRecaudo" BIGINT NOT NULL DEFAULT 0;

-- Step 2: Backfill tipoRecaudo and costoRecaudo from old canalPago
UPDATE "anticipo" SET
  "tipoRecaudo" = CASE "canalPago"
    WHEN 'OTRO' THEN 'BANCOLOMBIA'::"TipoRecaudo"
    WHEN 'OTROS_BANCOS_SUCURSAL' THEN 'OTROS_BANCOS'::"TipoRecaudo"
    WHEN 'BANCOLOMBIA_SUCURSAL' THEN 'SUCURSAL'::"TipoRecaudo"
    WHEN 'BANCOLOMBIA_CORRESPONSAL' THEN 'CORRESPONSAL'::"TipoRecaudo"
    WHEN 'BANCOLOMBIA_CAJERO' THEN 'CAJERO'::"TipoRecaudo"
    ELSE 'BANCOLOMBIA'::"TipoRecaudo"
  END,
  "costoRecaudo" = CASE "canalPago"
    WHEN 'OTRO' THEN 1950
    WHEN 'OTROS_BANCOS_SUCURSAL' THEN 2200
    WHEN 'BANCOLOMBIA_SUCURSAL' THEN 11290
    WHEN 'BANCOLOMBIA_CORRESPONSAL' THEN 6190
    WHEN 'BANCOLOMBIA_CAJERO' THEN 5200
    ELSE 1950
  END;

-- Step 3: Remove temporary default on tipoRecaudo
ALTER TABLE "anticipo" ALTER COLUMN "tipoRecaudo" DROP DEFAULT;

-- Step 4: Drop old canalPago from anticipo
ALTER TABLE "anticipo" DROP COLUMN "canalPago";

-- Step 5: Drop old matrix table FIRST (it depends on old CanalPago enum)
DROP TABLE "matriz_recaudo_pago";

-- Step 6: Handle CanalPago enum reduction
-- Create new enum with 3 values
CREATE TYPE "CanalPago_new" AS ENUM ('TRANSF_BANCOLOMBIA', 'PSE', 'TRANSF_OTROS_BANCOS');

-- Migrate pago_tramite
ALTER TABLE "pago_tramite" ALTER COLUMN "canalPago" DROP DEFAULT;
ALTER TABLE "pago_tramite" ALTER COLUMN "canalPago" TYPE "CanalPago_new" USING (
  CASE "canalPago"::text
    WHEN 'BANCOLOMBIA_TRANSFERENCIA' THEN 'TRANSF_BANCOLOMBIA'::"CanalPago_new"
    WHEN 'OTROS_BANCOS_TRANSFERENCIA' THEN 'TRANSF_OTROS_BANCOS'::"CanalPago_new"
    WHEN 'PSE' THEN 'PSE'::"CanalPago_new"
    ELSE 'TRANSF_BANCOLOMBIA'::"CanalPago_new"
  END
);

-- Migrate pago_factura
ALTER TABLE "pago_factura" ALTER COLUMN "canalPago" DROP DEFAULT;
ALTER TABLE "pago_factura" ALTER COLUMN "canalPago" TYPE "CanalPago_new" USING (
  CASE "canalPago"::text
    WHEN 'BANCOLOMBIA_TRANSFERENCIA' THEN 'TRANSF_BANCOLOMBIA'::"CanalPago_new"
    WHEN 'OTROS_BANCOS_TRANSFERENCIA' THEN 'TRANSF_OTROS_BANCOS'::"CanalPago_new"
    WHEN 'PSE' THEN 'PSE'::"CanalPago_new"
    ELSE 'TRANSF_BANCOLOMBIA'::"CanalPago_new"
  END
);

-- Drop old enum, rename new
DROP TYPE "CanalPago";
ALTER TYPE "CanalPago_new" RENAME TO "CanalPago";

-- Step 7: Create new matrices
CREATE TABLE "matriz_recaudo" (
  "id" TEXT NOT NULL,
  "tipoRecaudo" "TipoRecaudo" NOT NULL,
  "grupo" TEXT NOT NULL,
  "descripcion" TEXT NOT NULL,
  "costoFijo" BIGINT NOT NULL,
  CONSTRAINT "matriz_recaudo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "matriz_recaudo_tipoRecaudo_key" ON "matriz_recaudo"("tipoRecaudo");

CREATE TABLE "matriz_pago" (
  "id" TEXT NOT NULL,
  "canalPago" "CanalPago" NOT NULL,
  "descripcion" TEXT NOT NULL,
  "costoFijo" BIGINT NOT NULL,
  CONSTRAINT "matriz_pago_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "matriz_pago_canalPago_key" ON "matriz_pago"("canalPago");

-- Seed initial data
INSERT INTO "matriz_recaudo" ("id", "tipoRecaudo", "grupo", "descripcion", "costoFijo") VALUES
  (gen_random_uuid()::text, 'BANCOLOMBIA', 'DIGITAL', 'Bancolombia (digital)', 1950),
  (gen_random_uuid()::text, 'OTROS_BANCOS', 'DIGITAL', 'Otros Bancos (digital)', 2200),
  (gen_random_uuid()::text, 'SUCURSAL', 'FISICO', 'Sucursal Bancolombia', 11290),
  (gen_random_uuid()::text, 'CORRESPONSAL', 'FISICO', 'Corresponsal Bancolombia', 6190),
  (gen_random_uuid()::text, 'CAJERO', 'FISICO', 'Cajero Bancolombia', 5200);

INSERT INTO "matriz_pago" ("id", "canalPago", "descripcion", "costoFijo") VALUES
  (gen_random_uuid()::text, 'TRANSF_BANCOLOMBIA', 'Transferencia Bancolombia', 3900),
  (gen_random_uuid()::text, 'PSE', 'PSE', 0),
  (gen_random_uuid()::text, 'TRANSF_OTROS_BANCOS', 'Transferencia Otros Bancos', 7300);
