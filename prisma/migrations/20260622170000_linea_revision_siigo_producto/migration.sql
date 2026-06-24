-- AlterTable: vincular LineaRevision con SiigoProducto
ALTER TABLE "linea_revision" ADD COLUMN "siigoProductoId" TEXT;

ALTER TABLE "linea_revision"
  ADD CONSTRAINT "linea_revision_siigoProductoId_fkey"
  FOREIGN KEY ("siigoProductoId")
  REFERENCES "siigo_producto"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
