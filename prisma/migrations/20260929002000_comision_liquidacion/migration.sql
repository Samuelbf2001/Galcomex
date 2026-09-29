-- AlterTable
ALTER TABLE "comision_tramite" ADD COLUMN     "liquidacionTramiteId" TEXT,
ADD COLUMN     "liquidadaEn" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "comision_tramite_empresaId_liquidacionTramiteId_idx" ON "comision_tramite"("empresaId", "liquidacionTramiteId");

-- AddForeignKey
ALTER TABLE "comision_tramite" ADD CONSTRAINT "comision_tramite_liquidacionTramiteId_fkey" FOREIGN KEY ("liquidacionTramiteId") REFERENCES "tramite_do"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
