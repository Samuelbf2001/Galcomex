-- M2 + M3 del PLAN-CONFIGURABILIDAD: tarifario versionado por empresa y
-- eventos del trámite.
--
-- La propuesta comercial (Word con incisos) pasa a ser datos: un tarifario por
-- empresa y alcance, con vigencia real y una lista de ítems con su forma de
-- cálculo. Los "circunstanciales" de la reunión (se abrió el contenedor, hubo
-- entrega directa, se elaboró el registro) son filas de `catalogo_evento` que
-- se marcan en el trámite y disparan el ítem del tarifario. Todo aditivo: los
-- trámites y borradores existentes no cambian.

-- CreateEnum
CREATE TYPE "EstadoTarifario" AS ENUM ('BORRADOR', 'VIGENTE', 'VENCIDO', 'REEMPLAZADO');

-- CreateEnum
CREATE TYPE "TipoCalculoTarifa" AS ENUM ('FIJO', 'POR_UNIDAD', 'PORCENTAJE_MIN', 'PRIMERO_MAS_ADICIONAL', 'ESPEJO_DE_COSTO');

-- CreateEnum
CREATE TYPE "DisparadorTarifa" AS ENUM ('SIEMPRE', 'EVENTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "UnidadTarifa" AS ENUM ('TRAMITE', 'CONTENEDOR', 'DECLARACION', 'DOCUMENTO', 'ITEM', 'MES');

-- CreateEnum
CREATE TYPE "TipoCarga" AS ENUM ('SUELTA', 'CONTENEDOR_20', 'CONTENEDOR_40');

-- AlterTable
ALTER TABLE "borrador_factura" ADD COLUMN     "tarifarioId" TEXT;

-- AlterTable
ALTER TABLE "tramite_do" ADD COLUMN     "numContenedores" INTEGER,
ADD COLUMN     "numDeclaraciones" INTEGER,
ADD COLUMN     "numDocumentos" INTEGER,
ADD COLUMN     "numItems" INTEGER,
ADD COLUMN     "tipoCarga" "TipoCarga",
ADD COLUMN     "valorCif" BIGINT;

-- CreateTable
CREATE TABLE "tarifario" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "alcance" TEXT NOT NULL DEFAULT 'TRAMITE',
    "vigenteDesde" TIMESTAMP(3) NOT NULL,
    "vigenteHasta" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoTarifario" NOT NULL DEFAULT 'BORRADOR',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notas" TEXT,
    "pdfKey" TEXT,
    "enviadoAt" TIMESTAMP(3),
    "creadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tarifario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tarifa_item" (
    "id" TEXT NOT NULL,
    "tarifarioId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "concepto" TEXT NOT NULL,
    "nombrePublico" TEXT NOT NULL,
    "siigoCodigo" TEXT,
    "tipoCalculo" "TipoCalculoTarifa" NOT NULL,
    "disparador" "DisparadorTarifa" NOT NULL DEFAULT 'SIEMPRE',
    "eventoCodigo" TEXT,
    "unidad" "UnidadTarifa" NOT NULL DEFAULT 'TRAMITE',
    "valor" BIGINT NOT NULL DEFAULT 0,
    "valorAdicional" BIGINT,
    "porcentajeBps" INTEGER,
    "minimos" JSONB,
    "conceptoCosto" TEXT,
    "aplicaIva" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,

    CONSTRAINT "tarifa_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogo_evento" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "documentosRequeridos" JSONB NOT NULL DEFAULT '[]',
    "permiteCantidad" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "catalogo_evento_pkey" PRIMARY KEY ("codigo")
);

-- CreateTable
CREATE TABLE "tramite_evento" (
    "id" TEXT NOT NULL,
    "tramiteId" TEXT NOT NULL,
    "eventoCodigo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 1,
    "observacion" TEXT,
    "marcadoPorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tramite_evento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tarifario_empresaId_estado_idx" ON "tarifario"("empresaId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "tarifario_empresaId_alcance_version_key" ON "tarifario"("empresaId", "alcance", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tarifa_item_tarifarioId_concepto_key" ON "tarifa_item"("tarifarioId", "concepto");

-- CreateIndex
CREATE UNIQUE INDEX "tramite_evento_tramiteId_eventoCodigo_key" ON "tramite_evento"("tramiteId", "eventoCodigo");

-- AddForeignKey
ALTER TABLE "borrador_factura" ADD CONSTRAINT "borrador_factura_tarifarioId_fkey" FOREIGN KEY ("tarifarioId") REFERENCES "tarifario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarifario" ADD CONSTRAINT "tarifario_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarifario" ADD CONSTRAINT "tarifario_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarifa_item" ADD CONSTRAINT "tarifa_item_tarifarioId_fkey" FOREIGN KEY ("tarifarioId") REFERENCES "tarifario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarifa_item" ADD CONSTRAINT "tarifa_item_eventoCodigo_fkey" FOREIGN KEY ("eventoCodigo") REFERENCES "catalogo_evento"("codigo") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tramite_evento" ADD CONSTRAINT "tramite_evento_tramiteId_fkey" FOREIGN KEY ("tramiteId") REFERENCES "tramite_do"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tramite_evento" ADD CONSTRAINT "tramite_evento_eventoCodigo_fkey" FOREIGN KEY ("eventoCodigo") REFERENCES "catalogo_evento"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tramite_evento" ADD CONSTRAINT "tramite_evento_marcadoPorId_fkey" FOREIGN KEY ("marcadoPorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Catálogo inicial de eventos: los que Camila describió en la reunión
-- (min 12:43-14:48 y 47:34-49:45) más los de las propuestas 2026 de Litoplas y
-- CW ASIA. El precio NO vive aquí: lo pone el tarifario de cada empresa.
INSERT INTO "catalogo_evento" ("codigo", "nombre", "descripcion", "documentosRequeridos", "permiteCantidad", "orden", "activo") VALUES
  ('REVISION_DESPACHO', 'Revisión e inventario en despacho',
   'La carga llegó y hubo que abrirla: fue el operador a la revisión (inspección). Se cobra aparte del gasto fijo del trámite.',
   '["Fotos de la revisión de la carga"]', false, 10, true),
  ('ENTREGA_DIRECTA', 'Despacho con entrega directa',
   'La carga salió sin revisión, normalmente aéreas. Solo se marca; no exige documentos.',
   '[]', false, 20, true),
  ('DESPACHO_PARCIAL', 'Despacho parcial',
   'El cliente retira la carga en varias salidas. Se cobra por cada despacho parcial.',
   '[]', true, 30, true),
  ('ELABORACION_REGISTRO', 'Elaboración de registro de importación',
   'Se elaboró el registro de importación en la VUCE. Exige el registro y el comprobante del pago.',
   '["Registro de importación (VUCE)", "Comprobante de pago del registro"]', false, 40, true),
  ('MODIFICACION_REGISTRO', 'Modificación de registro de importación',
   'Cada modificación del registro ya elaborado. Hoy se factura reutilizando el ítem de elaboración; aquí queda como concepto propio.',
   '["Registro de importación modificado"]', true, 50, true),
  ('INGRESO_ZF', 'Ingreso a zona franca',
   'Trámite de ingreso de contenedores a zona franca. Se cobra por contenedor.',
   '[]', true, 60, true),
  ('ZONA_SECUNDARIA', 'Zona secundaria aduanera',
   'Exportaciones terrestres: valor inicial y renovación mensual.',
   '[]', true, 70, true);
