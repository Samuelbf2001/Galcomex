-- AlterTable
ALTER TABLE "borrador_factura" ADD COLUMN     "canalPagoComisionInternaLM" "CanalPago",
ADD COLUMN     "costoComisionInternaLM" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tipoRecaudoComisionInternaLM" "TipoRecaudo";
