-- Formato de factura de Galcomex propio (facturas reales de Litoplas, Polyrec,
-- CW ASIA, Sesderma y Coldex 2026 leídas de Siigo): cada concepto del tarifario
-- es un ítem con IVA 19 %, los terceros salen de las facturas de proveedor, el
-- 4x1000 se liquida sobre los terceros y la ReteIVA 15 % va a nivel de factura.
-- Aditiva: los borradores existentes quedan en el formato "COMISION".

ALTER TABLE "borrador_factura" ADD COLUMN "formatoFactura" TEXT NOT NULL DEFAULT 'COMISION';
ALTER TABLE "borrador_factura" ADD COLUMN "reteIvaPorcentaje" INTEGER;
ALTER TABLE "linea_revision" ADD COLUMN "aplicaIva" BOOLEAN NOT NULL DEFAULT false;

INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'factura_conceptos_iva',
    'Factura con conceptos e IVA por ítem',
    'La factura de venta lleva cada concepto del tarifario como ítem con su IVA, los pagos a terceros desde las facturas de proveedor, el 4x1000 sobre esos terceros y la ReteIVA del cliente. Es el formato de las facturas de Galcomex; sin activarla se usa el formato de comisión de Lucho.',
    'Facturacion', 'EMPRESA', false,
    '{"reteIvaPorcentaje": 15, "observacionNoRetenciones": true}',
    105, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO NOTHING;
