-- B2 (Diseño B, 29-sep-2026): una tarifa de «Otros servicios» por SERVICIO (DUTA, nacionalizacion...).
-- Aditiva: sin columnas de dinero; todo lo existente queda NULL = comportamiento de hoy.
ALTER TABLE "tarifario" ADD COLUMN "conceptoServicioCodigo" TEXT;

ALTER TABLE "tarifario" ADD CONSTRAINT "tarifario_conceptoServicioCodigo_fkey"
  FOREIGN KEY ("conceptoServicioCodigo") REFERENCES "concepto_venta"("codigo") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tarifario_empresaId_alcance_conceptoServicioCodigo_idx" ON "tarifario"("empresaId", "alcance", "conceptoServicioCodigo");
