-- Migration: pagofactura_recaudo_costo
-- Aditiva: agrega tipoRecaudo (nullable), costoBancario (default 0) y hace canalPago nullable.
-- NO borra ni modifica datos existentes.

-- 1. Añadir columna tipoRecaudo (nullable, referencia al enum TipoRecaudo)
ALTER TABLE "pago_factura" ADD COLUMN "tipoRecaudo" "TipoRecaudo";

-- 2. Añadir columna costoBancario con default 0 (snapshot del cobro)
ALTER TABLE "pago_factura" ADD COLUMN "costoBancario" BIGINT NOT NULL DEFAULT 0;

-- 3. Hacer canalPago nullable (filas existentes conservan su valor)
ALTER TABLE "pago_factura" ALTER COLUMN "canalPago" DROP NOT NULL;
