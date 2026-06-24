-- AlterTable
ALTER TABLE "pago_tramite" ADD COLUMN     "bancoBeneficiarioId" TEXT;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_bancoBeneficiarioId_fkey" FOREIGN KEY ("bancoBeneficiarioId") REFERENCES "beneficiario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
