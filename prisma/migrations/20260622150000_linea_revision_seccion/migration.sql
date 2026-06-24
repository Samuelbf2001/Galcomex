-- Subsección de la factura de venta: separa "ingresos para terceros" (pass-through)
-- de "costos operacionales" (propios del prestador del servicio).
-- Los registros existentes se mantienen como TERCEROS para preservar el comportamiento previo.

-- CreateEnum
CREATE TYPE "SeccionLinea" AS ENUM ('TERCEROS', 'OPERACIONAL');

-- AlterTable
ALTER TABLE "linea_revision" ADD COLUMN "seccion" "SeccionLinea" NOT NULL DEFAULT 'TERCEROS';
