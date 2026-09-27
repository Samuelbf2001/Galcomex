-- CxP v2 · M5 — Enciende los guardianes de saldo (docs/CXP-PROVEEDORES.md, diseño §A.7).
--
-- M3 creó los tres CONSTRAINT TRIGGER y los dejó DISABLE para que P0 no cambiara
-- ningún comportamiento. Esta migración los enciende junto con el dominio que los
-- respeta (P1: `aplicarSaldo` / `revertirSaldo` como única puerta de saldo).
--
-- Qué garantizan (aunque el que escriba sea un script o un fixture de pruebas):
--   aplicado (Σ pago_tramite_factura.monto) + ajustes + montoCompensado <= valor
--   · trg_pago_factura_saldo   AFTER INSERT OR UPDATE ON pago_tramite_factura
--   · trg_ajuste_saldo         AFTER INSERT OR UPDATE ON ajuste_factura_proveedor
--   · trg_factura_valor_saldo  AFTER UPDATE OF valor, "montoCompensado" ON factura_proveedor
-- Si se viola, `cxp_verificar_saldo` lanza 'CXP_SOBREAPLICACION: …' (SQLSTATE P0001);
-- el dominio lo traduce a MONTO_EXCEDE_SALDO (409) con `esErrorSobreaplicacion`.
--
-- No puede fallar con datos reales: M3 dejó I2 (aplicado+ajustes+compensado <= valor)
-- cierto para todas las facturas (montos del puente con tope, LEGADO solo por el
-- faltante). ENABLE TRIGGER no revalida filas existentes.
--
-- Reversa: scripts/cxp/reversa-v2.sql (los vuelve a apagar).

ALTER TABLE "pago_tramite_factura" ENABLE TRIGGER trg_pago_factura_saldo;
ALTER TABLE "ajuste_factura_proveedor" ENABLE TRIGGER trg_ajuste_saldo;
ALTER TABLE "factura_proveedor" ENABLE TRIGGER trg_factura_valor_saldo;
