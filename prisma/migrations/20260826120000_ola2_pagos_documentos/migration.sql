-- AlterEnum
ALTER TYPE "CategoriaDocumento" ADD VALUE 'COMPROBANTE_COMERCIO';

-- AlterTable
ALTER TABLE "pago_tramite" ADD COLUMN     "comprobanteComercioId" TEXT,
ADD COLUMN     "grupoPagoId" TEXT;

-- CreateTable
CREATE TABLE "documento_enlace" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "expiraEn" TIMESTAMP(3) NOT NULL,
    "revocado" BOOLEAN NOT NULL DEFAULT false,
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documento_enlace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documento_enlace_token_key" ON "documento_enlace"("token");

-- AddForeignKey
ALTER TABLE "documento_enlace" ADD CONSTRAINT "documento_enlace_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documento_enlace" ADD CONSTRAINT "documento_enlace_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_comprobanteComercioId_fkey" FOREIGN KEY ("comprobanteComercioId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

