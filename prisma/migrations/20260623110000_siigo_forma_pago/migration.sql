-- Tabla de formas de pago de Siigo (espejo de GET /v1/payment-types).
-- La forma de pago se selecciona por borrador (contado vs crédito varía por
-- trámite), por eso el FK va en borrador_factura en lugar de ser global.

CREATE TABLE "siigo_forma_pago" (
  "id"             INTEGER NOT NULL,
  "nombre"         TEXT    NOT NULL,
  "tipo"           TEXT,
  "activo"         BOOLEAN NOT NULL DEFAULT true,
  "sincronizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "siigo_forma_pago_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "borrador_factura"
  ADD COLUMN "formaPagoSiigoId" INTEGER;

ALTER TABLE "borrador_factura"
  ADD CONSTRAINT "borrador_factura_formaPagoSiigoId_fkey"
  FOREIGN KEY ("formaPagoSiigoId")
  REFERENCES "siigo_forma_pago"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
