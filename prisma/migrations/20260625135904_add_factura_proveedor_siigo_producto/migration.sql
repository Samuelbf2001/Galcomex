-- AlterTable
ALTER TABLE "factura_proveedor" ADD COLUMN     "siigoProductoId" TEXT;

-- AddForeignKey
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_siigoProductoId_fkey" FOREIGN KEY ("siigoProductoId") REFERENCES "siigo_producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
