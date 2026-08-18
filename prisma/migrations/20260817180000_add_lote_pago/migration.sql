-- CreateTable
CREATE TABLE "lote_pago" (
    "id" TEXT NOT NULL,
    "referencia" TEXT,
    "fechaPago" TIMESTAMP(3) NOT NULL,
    "canalPago" "CanalPago" NOT NULL,
    "documentoId" TEXT,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lote_pago_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "pago_tramite" ADD COLUMN     "loteId" TEXT;

-- AddForeignKey
ALTER TABLE "lote_pago" ADD CONSTRAINT "lote_pago_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lote_pago" ADD CONSTRAINT "lote_pago_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "lote_pago"("id") ON DELETE SET NULL ON UPDATE CASCADE;
