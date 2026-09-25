-- Factura de proveedor sobre la cuenta corriente de una contraparte (M5,
-- caso Coldex): hoy el único botón es "Registrar movimiento" con 7 campos
-- técnicos y ningún usuario entiende que ahí va la factura mensual del
-- proveedor. Aditiva: solo columnas NULLABLES sobre "movimiento_cuenta".

ALTER TABLE "movimiento_cuenta" ADD COLUMN "numeroFactura" TEXT;
ALTER TABLE "movimiento_cuenta" ADD COLUMN "numeroFacturaNorm" TEXT;
ALTER TABLE "movimiento_cuenta" ADD COLUMN "soporteKey" TEXT;
ALTER TABLE "movimiento_cuenta" ADD COLUMN "soporteNombre" TEXT;
ALTER TABLE "movimiento_cuenta" ADD COLUMN "soporteMime" TEXT;

-- Detectar "ya registraste esta factura" por empresa + rol (misma factura no
-- se registra dos veces como proveedor, pero no choca con la punta cliente).
CREATE INDEX "movimiento_cuenta_empresaId_rol_numeroFacturaNorm_idx"
    ON "movimiento_cuenta"("empresaId", "rol", "numeroFacturaNorm");
