-- Cruce de saldos (compensación) en la cuenta corriente por contraparte (M5).
--
-- Lo que Camila hace hoy a mano: "meto esa factura aquí y la cruzo con lo que
-- ellos nos deben, para no hacer doble transferencia" (reunión, min 68:45).
-- Una compensación salda el mismo importe en las dos puntas sin plata y cada
-- punta se registra donde su módulo la lee: abono en la factura de venta,
-- factura de proveedor a PAGADA, o el libro manual. Todo aditivo.

ALTER TYPE "OrigenMovimientoCuenta" ADD VALUE 'COMPENSACION';

ALTER TABLE "movimiento_cuenta" ADD COLUMN "compensacionId" TEXT;
CREATE INDEX "movimiento_cuenta_compensacionId_idx" ON "movimiento_cuenta"("compensacionId");

ALTER TABLE "pago_factura" ADD COLUMN "compensacionId" TEXT;
CREATE INDEX "pago_factura_compensacionId_idx" ON "pago_factura"("compensacionId");

ALTER TABLE "factura_proveedor" ADD COLUMN "compensacionId" TEXT;
