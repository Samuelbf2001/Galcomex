-- Comisión por contenedor de un DO (caso LTRANS: $90.000 por contenedor en los
-- traslados de Polyrec ZF). Solo guarda cuántos contenedores del DO llevan
-- comisión de cada empresa; el valor unitario vive en la capacidad
-- `comision_por_evento` del que paga. Aditiva: no toca datos existentes.

-- CreateTable
CREATE TABLE "comision_tramite" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "unidades" INTEGER NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comision_tramite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comision_tramite_empresaId_idx" ON "comision_tramite"("empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "comision_tramite_tramiteId_empresaId_key" ON "comision_tramite"("tramiteId", "empresaId");

-- AddForeignKey
ALTER TABLE "comision_tramite" ADD CONSTRAINT "comision_tramite_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comision_tramite" ADD CONSTRAINT "comision_tramite_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comision_tramite" ADD CONSTRAINT "comision_tramite_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

