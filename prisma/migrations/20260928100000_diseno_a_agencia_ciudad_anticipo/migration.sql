-- Diseño A (27-sep-2026): B1 (restar el agenciamiento de la agencia), B3
-- (tarifario por ciudad) y B8 (anticipo disponible una sola vez por DO).
-- Migración aditiva, sin columnas de dinero, sin backfill.

-- AlterTable
ALTER TABLE "tarifario" ADD COLUMN "ciudades" "Ciudad"[] NOT NULL DEFAULT ARRAY[]::"Ciudad"[];

-- AlterTable
ALTER TABLE "tarifa_item" ADD COLUMN "restaAgenciamiento" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tarifa_item" ADD COLUMN "minimoEsDelTotal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "borrador_factura" ADD COLUMN "anticipoManual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "borrador_factura" ADD COLUMN "anticipoMotivo" TEXT;
