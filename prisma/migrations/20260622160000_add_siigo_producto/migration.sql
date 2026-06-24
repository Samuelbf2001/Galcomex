-- CreateTable
CREATE TABLE "siigo_producto" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "grupoContableId" INTEGER NOT NULL,
    "grupoContableNombre" TEXT NOT NULL,
    "clasificacionIva" TEXT NOT NULL,
    "sincronizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "siigo_producto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "siigo_producto_codigo_key" ON "siigo_producto"("codigo");
