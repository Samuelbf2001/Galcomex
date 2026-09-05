-- M4 del PLAN-CONFIGURABILIDAD: tipos de trámite configurables.
--
-- La clasificación arancelaria deja de ser un caso especial de Litoplas y pasa
-- a ser una fila de `tipo_tramite`, con su propio prefijo y su propio contador.
-- Todo lo existente queda como IMPORTACION, con el mismo formato de consecutivo
-- (DO.BAQ26-0001) y el mismo contador por ciudad y año: cero cambios visibles.

CREATE TYPE "SecuenciaTramite" AS ENUM ('CIUDAD_ANIO', 'ANIO', 'GLOBAL');

CREATE TABLE "tipo_tramite" (
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "prefijoConsecutivo" TEXT NOT NULL,
    "secuenciaPor" "SecuenciaTramite" NOT NULL DEFAULT 'CIUDAD_ANIO',
    "incluyeCiudadEnConsecutivo" BOOLEAN NOT NULL DEFAULT true,
    "lineaServicio" TEXT NOT NULL DEFAULT 'TRAMITE',
    "facturacionSeparada" BOOLEAN NOT NULL DEFAULT false,
    "capacidadRequerida" TEXT,
    "requiereAgenciaAduanas" BOOLEAN NOT NULL DEFAULT true,
    "agenciaAduanasPorDefecto" "AgenciaAduanas",
    "requiereEta" BOOLEAN NOT NULL DEFAULT true,
    "usaChecklist" BOOLEAN NOT NULL DEFAULT true,
    "etiquetaReferenciaExterna" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tipo_tramite_pkey" PRIMARY KEY ("codigo")
);

-- Catálogo inicial. IMPORTACION reproduce exactamente el comportamiento actual.
INSERT INTO "tipo_tramite" (
    "codigo", "nombre", "descripcion", "prefijoConsecutivo", "secuenciaPor",
    "incluyeCiudadEnConsecutivo", "lineaServicio", "facturacionSeparada",
    "capacidadRequerida", "requiereAgenciaAduanas", "agenciaAduanasPorDefecto",
    "requiereEta", "usaChecklist", "etiquetaReferenciaExterna", "orden", "activo", "updatedAt"
) VALUES
  ('IMPORTACION', 'Trámite de importación',
   'Trámite completo de importación. Consecutivo por ciudad y año.',
   'DO', 'CIUDAD_ANIO', true, 'TRAMITE', false,
   NULL, true, NULL, true, true, NULL, 10, true, CURRENT_TIMESTAMP),
  ('CLASIFICACION', 'Clasificación arancelaria',
   'Servicio de clasificación, previo e independiente del trámite. Consecutivo y facturación aparte.',
   'CLAS', 'ANIO', false, 'CLASIFICACION', true,
   'clasificacion_arancelaria', false, NULL, false, false, 'N° de informe de la clasificadora', 20, true, CURRENT_TIMESTAMP)
ON CONFLICT ("codigo") DO NOTHING;

-- ─── Trámites existentes ─────────────────────────────────────────────────────
ALTER TABLE "tramite_do" ADD COLUMN "tipoTramiteCodigo" TEXT NOT NULL DEFAULT 'IMPORTACION';
ALTER TABLE "tramite_do" ADD COLUMN "referenciaExterna" TEXT;

-- El contador pasa a ser por (tipo, ciudad, año): la clasificación no consume
-- consecutivos de importación.
DROP INDEX IF EXISTS "tramite_do_ciudad_anio_numero_key";

CREATE UNIQUE INDEX "tramite_do_tipoTramiteCodigo_ciudad_anio_numero_key"
    ON "tramite_do"("tipoTramiteCodigo", "ciudad", "anio", "numero");

CREATE INDEX "tramite_do_tipoTramiteCodigo_idx" ON "tramite_do"("tipoTramiteCodigo");

ALTER TABLE "tramite_do" ADD CONSTRAINT "tramite_do_tipoTramiteCodigo_fkey"
    FOREIGN KEY ("tipoTramiteCodigo") REFERENCES "tipo_tramite"("codigo")
    ON DELETE RESTRICT ON UPDATE CASCADE;
