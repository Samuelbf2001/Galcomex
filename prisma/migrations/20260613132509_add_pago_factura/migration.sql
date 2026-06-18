-- CreateEnum
CREATE TYPE "DestinoPago" AS ENUM ('CLIENTE', 'LM');

-- CreateEnum
CREATE TYPE "TipoPagoFactura" AS ENUM ('ABONO', 'DEVOLUCION');

-- CreateTable
CREATE TABLE "pago_factura" (
    "id" TEXT NOT NULL,
    "facturaId" TEXT NOT NULL,
    "destino" "DestinoPago" NOT NULL,
    "tipo" "TipoPagoFactura" NOT NULL,
    "monto" BIGINT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "canalPago" "CanalPago" NOT NULL,
    "comprobanteKey" TEXT,
    "verificadoBanco" BOOLEAN NOT NULL DEFAULT false,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pago_factura_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "pago_factura" ADD CONSTRAINT "pago_factura_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "factura"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago_factura" ADD CONSTRAINT "pago_factura_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
