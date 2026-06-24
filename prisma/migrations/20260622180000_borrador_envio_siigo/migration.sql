-- AlterTable: trazabilidad de envío como borrador a la API de Siigo.
-- La factura se crea como DRAFT en Siigo (stamp.send = false); un usuario
-- superior la valida y la sella manualmente desde Siigo. El consecutivo real
-- llega después por el flujo manual de "Marcar facturado".
ALTER TABLE "borrador_factura"
  ADD COLUMN "siigoDraftId" TEXT,
  ADD COLUMN "enviadoASiigoEn" TIMESTAMP(3),
  ADD COLUMN "ultimoErrorSiigo" TEXT,
  ADD COLUMN "ultimoIntentoSiigo" TIMESTAMP(3);
