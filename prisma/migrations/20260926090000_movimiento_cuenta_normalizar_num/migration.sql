-- Recalcula "numeroFacturaNorm" de las filas de movimiento_cuenta que ya
-- existían antes de esta rama con la normalización VIEJA de cuenta corriente
-- (solo quitaba espacios, puntos y guiones). Desde el 26-sep-2026 el código
-- usa `cxp_normalizar_num` (CxP v2), que quita CUALQUIER carácter que no sea
-- A-Z0-9 — la misma que ya usa `factura_proveedor."numFacturaNormalizado"`.
--
-- Sin este backfill, una factura registrada a mano ANTES de este despliegue
-- con '/', '_', '#', '°', 'º', ',' o una letra con tilde en el número queda
-- con una llave vieja: ni el chequeo de duplicado dentro de la cuenta
-- corriente (registrarMovimientoCuenta) ni el cruce con FacturaProveedor
-- (verificarNoRegistradaEnCuentaCorriente) la vuelven a encontrar, y la misma
-- factura se puede terminar contando dos veces.
UPDATE "movimiento_cuenta"
SET "numeroFacturaNorm" = cxp_normalizar_num("numeroFactura")
WHERE "numeroFactura" IS NOT NULL;
