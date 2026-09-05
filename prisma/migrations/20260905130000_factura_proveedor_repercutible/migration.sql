-- M6 del PLAN-CONFIGURABILIDAD: repercusión al cliente de la factura de proveedor.
--
-- `true` (caso normal, y el valor de todo lo ya registrado): el gasto se paga
-- por cuenta del cliente y se le traslada en la factura de venta.
-- `false`: la factura va a nombre de Galcomex y el cliente no debe verla
-- (caso Ascinter: asesoría). Se registra en el trámite para pagarla y cruzarla,
-- pero no genera línea en la factura de venta ni cuenta como desviación.
--
-- Aditiva y con default: no cambia el comportamiento de ninguna factura existente.

ALTER TABLE "factura_proveedor"
    ADD COLUMN "repercutible" BOOLEAN NOT NULL DEFAULT true;
