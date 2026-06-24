-- Comentarios de cabecera del borrador (formato Lucho).
-- Array JSON de strings; cada uno es una fila descriptiva visible en la factura.
-- Al exportar a SIIGO se unen con saltos de línea en columna AE Observaciones.
ALTER TABLE "borrador_factura" ADD COLUMN "comentariosCabecera" JSONB;
