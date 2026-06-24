-- CreateTable: catálogo de impuestos Siigo
CREATE TABLE "siigo_impuesto" (
    "id" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "porcentaje" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "sincronizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "siigo_impuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable: pivot N↔N producto ↔ impuesto
CREATE TABLE "siigo_producto_impuesto" (
    "productoId" TEXT NOT NULL,
    "impuestoId" INTEGER NOT NULL,

    CONSTRAINT "siigo_producto_impuesto_pkey" PRIMARY KEY ("productoId", "impuestoId")
);

-- AddForeignKey
ALTER TABLE "siigo_producto_impuesto"
  ADD CONSTRAINT "siigo_producto_impuesto_productoId_fkey"
  FOREIGN KEY ("productoId") REFERENCES "siigo_producto"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "siigo_producto_impuesto"
  ADD CONSTRAINT "siigo_producto_impuesto_impuestoId_fkey"
  FOREIGN KEY ("impuestoId") REFERENCES "siigo_impuesto"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
