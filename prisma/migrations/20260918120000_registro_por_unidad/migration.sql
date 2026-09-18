-- Elaboración de registro de importación: Litoplas paga por cada registro
-- elaborado (433.000 × 2 = 866.000 en las facturas reales de 2026). El motor ya
-- multiplica el valor FIJO por la cantidad del evento; solo faltaba permitir
-- capturar la cantidad. Aplicado a mano en producción el 2026-09-18.
UPDATE "catalogo_evento"
SET "permiteCantidad" = true,
    "descripcion" = 'Se elaboró el registro de importación en la VUCE. Se cobra por cada registro elaborado. Exige el registro y el comprobante del pago.'
WHERE "codigo" = 'ELABORACION_REGISTRO';
