-- CreateEnum
CREATE TYPE "EstadoFacturaProveedor" AS ENUM ('REGISTRADA', 'PAGADA', 'FACTURADA_CLIENTE');

-- AlterTable
ALTER TABLE "borrador_factura" ADD COLUMN     "conceptosOperacionales" JSONB,
ADD COLUMN     "retenciones" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pago_tramite" ADD COLUMN     "facturaProveedorId" TEXT,
ADD COLUMN     "viaSocio" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "factura_proveedor" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "proveedorNombre" TEXT NOT NULL,
    "proveedorNit" TEXT,
    "numFactura" TEXT NOT NULL,
    "valor" BIGINT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoFacturaProveedor" NOT NULL DEFAULT 'REGISTRADA',
    "documentoId" TEXT,
    "subidaPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factura_proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "factura_proveedor_tramiteId_numFactura_key" ON "factura_proveedor"("tramiteId", "numFactura");

-- AddForeignKey
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "documento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_proveedor" ADD CONSTRAINT "factura_proveedor_subidaPorId_fkey" FOREIGN KEY ("subidaPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_facturaProveedorId_fkey" FOREIGN KEY ("facturaProveedorId") REFERENCES "factura_proveedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
