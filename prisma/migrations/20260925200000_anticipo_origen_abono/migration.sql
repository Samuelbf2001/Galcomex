-- Tope del abono (decisión de Ernesto, 25-sep-2026): el sobrante de un abono de
-- cartera se guarda como anticipo del cliente, enlazado al abono que lo originó.
-- Aditiva: los anticipos existentes quedan con NULL (registrados directamente).

-- AlterTable
ALTER TABLE "anticipo" ADD COLUMN "pagoFacturaOrigenId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "anticipo_pagoFacturaOrigenId_key" ON "anticipo"("pagoFacturaOrigenId");

-- AddForeignKey
ALTER TABLE "anticipo" ADD CONSTRAINT "anticipo_pagoFacturaOrigenId_fkey" FOREIGN KEY ("pagoFacturaOrigenId") REFERENCES "pago_factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
