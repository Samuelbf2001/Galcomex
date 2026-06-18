-- CreateTable: Beneficiario (proveedor/tercero receptor de pagos)
CREATE TABLE "beneficiario" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nit" TEXT,
    "banco" TEXT,
    "numCuenta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beneficiario_pkey" PRIMARY KEY ("id")
);

-- AlterTable pago_tramite: reemplazar columna beneficiario (texto libre) por FK
ALTER TABLE "pago_tramite" DROP COLUMN IF EXISTS "beneficiario";
ALTER TABLE "pago_tramite" ADD COLUMN "beneficiarioId" TEXT;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_beneficiarioId_fkey"
    FOREIGN KEY ("beneficiarioId") REFERENCES "beneficiario"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
