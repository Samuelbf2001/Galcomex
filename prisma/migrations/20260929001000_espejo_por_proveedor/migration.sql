-- B6 (Diseño B, 29-sep-2026): registro VUCE "el mayor entre el mínimo y lo pagado", por registro.
-- Un ítem ESPEJO_DE_COSTO puede espejar cada factura de proveedor de un NIT (y producto Siigo)
-- en vez de buscar un texto. Aditiva: sin columnas de dinero; todo lo existente queda NULL.
ALTER TABLE "tarifa_item" ADD COLUMN "nitProveedorCosto" TEXT;
ALTER TABLE "tarifa_item" ADD COLUMN "productoCosto" TEXT;
