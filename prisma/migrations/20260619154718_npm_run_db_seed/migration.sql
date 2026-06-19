/*
  Warnings:

  - You are about to drop the column `beneficiario_id` on the `factura_proveedor` table. All the data in the column will be lost.
  - You are about to drop the column `facturaProveedorId` on the `pago_tramite` table. All the data in the column will be lost.
  - You are about to drop the column `fechaEsperadaPago` on the `pago_tramite` table. All the data in the column will be lost.
  - The primary key for the `pago_tramite_factura` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `factura_id` on the `pago_tramite_factura` table. All the data in the column will be lost.
  - You are about to drop the column `pago_id` on the `pago_tramite_factura` table. All the data in the column will be lost.
  - Added the required column `facturaId` to the `pago_tramite_factura` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pagoId` to the `pago_tramite_factura` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "factura_proveedor" DROP CONSTRAINT "factura_proveedor_beneficiario_id_fkey";

-- DropForeignKey
ALTER TABLE "pago_tramite" DROP CONSTRAINT "pago_tramite_facturaProveedorId_fkey";

-- DropForeignKey
ALTER TABLE "pago_tramite_factura" DROP CONSTRAINT "pago_tramite_factura_factura_id_fkey";

-- DropForeignKey
ALTER TABLE "pago_tramite_factura" DROP CONSTRAINT "pago_tramite_factura_pago_id_fkey";

-- AlterTable
ALTER TABLE "factura_proveedor" DROP COLUMN "beneficiario_id",
ADD COLUMN     "beneficiarioId" TEXT;

-- AlterTable
ALTER TABLE "pago_tramite" DROP COLUMN "facturaProveedorId",
DROP COLUMN "fechaEsperadaPago";

-- AlterTable
ALTER TABLE "pago_tramite_factura" DROP CONSTRAINT "pago_tramite_factura_pkey",
DROP COLUMN "factura_id",
DROP COLUMN "pago_id",
ADD COLUMN     "facturaId" TEXT NOT NULL,
ADD COLUMN     "pagoId" TEXT NOT NULL,
ADD CONSTRAINT "pago_tramite_factura_pkey" PRIMARY KEY ("pagoId", "facturaId");

-- AddForeignKey
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_beneficiarioId_fkey" FOREIGN KEY ("beneficiarioId") REFERENCES "beneficiario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite_factura" ADD CONSTRAINT "pago_tramite_factura_pagoId_fkey" FOREIGN KEY ("pagoId") REFERENCES "pago_tramite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite_factura" ADD CONSTRAINT "pago_tramite_factura_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "factura_proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
