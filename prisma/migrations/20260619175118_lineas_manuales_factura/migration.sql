-- CreateEnum
CREATE TYPE "LineaRevisionOrigen" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "borrador_factura" ADD COLUMN     "totalFacturaLineas" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "linea_revision" ADD COLUMN     "origen" "LineaRevisionOrigen" NOT NULL DEFAULT 'AUTO';

-- CreateTable
CREATE TABLE "linea_revision_factura" (
    "lineaId" TEXT NOT NULL,
    "facturaId" TEXT NOT NULL,

    CONSTRAINT "linea_revision_factura_pkey" PRIMARY KEY ("lineaId","facturaId")
);

-- AddForeignKey
ALTER TABLE "linea_revision_factura" ADD CONSTRAINT "linea_revision_factura_lineaId_fkey" FOREIGN KEY ("lineaId") REFERENCES "linea_revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linea_revision_factura" ADD CONSTRAINT "linea_revision_factura_facturaId_fkey" FOREIGN KEY ("facturaId") REFERENCES "factura_proveedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: totalFacturaLineas para borradores existentes.
-- Fórmula de referencia: Σ(líneas) + comisión + IVA comisión − retenciones.
-- Es solo valor de referencia (la promoción a totalFactura solo ocurre en SOCIO_LM).
-- El pivot linea_revision_factura arranca vacío a propósito: el cruce histórico
-- por string (numSoporte == numFactura) NO se migra para no crear vínculos falsos.
UPDATE "borrador_factura" b
SET "totalFacturaLineas" =
  COALESCE((SELECT SUM(l."valor") FROM "linea_revision" l WHERE l."borradorId" = b."id"), 0)
  + b."comision" + b."ivaComision" - b."retenciones";
