-- Servicio dentro del trámite normal (decisión de Ernesto, 30-sep-2026).
--
-- La nacionalización, el traslado y la DUTA son trámites de importación con un
-- servicio escogido (no «Otros»). La tarifa se busca por servicio también en la
-- línea de trámites. El servicio nunca cambia el número del DO. Aditiva: no
-- toca tramite_do ni tarifario.

CREATE TABLE "servicio_tramite" (
  "id"                  TEXT         NOT NULL,
  "tipoTramiteCodigo"   TEXT         NOT NULL,
  "conceptoCodigo"      TEXT,        -- null solo en el servicio «tarifa general» de IMPORTACION
  "nombre"              TEXT         NOT NULL,
  "tarifaGeneral"       BOOLEAN      NOT NULL DEFAULT false,
  "documentosNoAplican" "CategoriaDocumento"[] NOT NULL DEFAULT ARRAY[]::"CategoriaDocumento"[],
  "orden"               INTEGER      NOT NULL DEFAULT 0,
  "activo"              BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "servicio_tramite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "servicio_tramite_tipoTramiteCodigo_conceptoCodigo_key"
  ON "servicio_tramite"("tipoTramiteCodigo", "conceptoCodigo");
ALTER TABLE "servicio_tramite" ADD CONSTRAINT "servicio_tramite_tipoTramiteCodigo_fkey"
  FOREIGN KEY ("tipoTramiteCodigo") REFERENCES "tipo_tramite"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "servicio_tramite" ADD CONSTRAINT "servicio_tramite_conceptoCodigo_fkey"
  FOREIGN KEY ("conceptoCodigo") REFERENCES "concepto_venta"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Categoría de documento de cada ítem de checklist (para quitar el BL en la nacionalización).
ALTER TABLE "plantilla_checklist_item" ADD COLUMN "categoriaDocumento" "CategoriaDocumento";
ALTER TABLE "checklist_item"           ADD COLUMN "categoriaDocumento" "CategoriaDocumento";
UPDATE "plantilla_checklist_item" SET "categoriaDocumento" = 'BL'
 WHERE "plantillaId" = 'checklist-estandar' AND "descripcion" = 'BL (Bill of Lading)';
UPDATE "plantilla_checklist_item" SET "categoriaDocumento" = 'FACTURA_COMERCIAL'
 WHERE "plantillaId" = 'checklist-estandar' AND "descripcion" = 'Factura comercial';
UPDATE "plantilla_checklist_item" SET "categoriaDocumento" = 'PACKING_LIST'
 WHERE "plantillaId" = 'checklist-estandar' AND "descripcion" = 'Packing list';
UPDATE "checklist_item" SET "categoriaDocumento" = 'BL'
 WHERE "descripcion" = 'BL (Bill of Lading)' AND "categoriaDocumento" IS NULL;
UPDATE "checklist_item" SET "categoriaDocumento" = 'FACTURA_COMERCIAL'
 WHERE "descripcion" = 'Factura comercial' AND "categoriaDocumento" IS NULL;
UPDATE "checklist_item" SET "categoriaDocumento" = 'PACKING_LIST'
 WHERE "descripcion" = 'Packing list' AND "categoriaDocumento" IS NULL;

-- Conceptos de los servicios: solo si faltan (en producción ya existen; nunca se pisa el de Camila).
INSERT INTO "concepto_venta" ("id","codigo","nombre","aplicaIva","orden","activo","notas","updatedAt") VALUES
  ('concepto-traslado-zf','TRASLADO_ZF','Traslado de contenedor en zona franca',true,0,true,'Creado por la migración 20260930100100 porque faltaba. Producto Siigo: dato de Camila.',CURRENT_TIMESTAMP),
  ('concepto-nacionalizacion-zf','NACIONALIZACION_ZF','Nacionalización desde zona franca',true,0,true,'Creado por la migración 20260930100100 porque faltaba. Producto Siigo: dato de Camila.',CURRENT_TIMESTAMP),
  ('concepto-duta','DUTA','DUTA (tránsito aduanero)',true,0,true,'Creado por la migración 20260930100100 porque faltaba. Producto Siigo: dato de Camila.',CURRENT_TIMESTAMP)
ON CONFLICT ("codigo") DO NOTHING;

INSERT INTO "servicio_tramite" ("id","tipoTramiteCodigo","conceptoCodigo","nombre","tarifaGeneral","documentosNoAplican","orden","updatedAt") VALUES
  ('servicio-importacion-general','IMPORTACION',NULL,'Importación (tarifa general de la empresa)',true,ARRAY[]::"CategoriaDocumento"[],10,CURRENT_TIMESTAMP),
  ('servicio-importacion-traslado-zf','IMPORTACION','TRASLADO_ZF','Traslado de zona franca',false,ARRAY[]::"CategoriaDocumento"[],20,CURRENT_TIMESTAMP),
  ('servicio-importacion-nacionalizacion-zf','IMPORTACION','NACIONALIZACION_ZF','Nacionalización desde zona franca',false,ARRAY['BL']::"CategoriaDocumento"[],30,CURRENT_TIMESTAMP),
  ('servicio-importacion-duta','IMPORTACION','DUTA','DUTA (tránsito aduanero)',false,ARRAY[]::"CategoriaDocumento"[],40,CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
