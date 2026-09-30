-- Numeración como Camila (decisión de Ernesto, 30-sep-2026). Aditiva: no toca tramite_do.
--
-- Barranquilla, Bogotá y Buenaventura comparten UN solo contador de DO (las
-- carpetas de Camila cubren del 1 al 281 sin repetir entre las tres ciudades).
-- Cartagena y Santa Marta llevan cada una el suyo. El número se sigue
-- imprimiendo con la ciudad (DO.BGT26-0282): no se renombra ningún DO.
-- Reversa: ver DISENO-NUMERACION.md §3.4 (DROP TABLE consecutivo_piso,
-- DROP COLUMN ciudadesContadorComun). Los DOs creados conservan su número.

ALTER TABLE "tipo_tramite"
  ADD COLUMN "ciudadesContadorComun" "Ciudad"[] NOT NULL DEFAULT ARRAY[]::"Ciudad"[];

CREATE TABLE "consecutivo_piso" (
  "id"                TEXT         NOT NULL,
  "clave"             TEXT         NOT NULL,  -- 'IMPORTACION:BAQ+BGT+BUN:2026', 'EXPORTACION:2026'
  "tipoTramiteCodigo" TEXT         NOT NULL,
  "anio"              INTEGER,
  "ultimoNumero"      INTEGER      NOT NULL,
  "motivo"            TEXT         NOT NULL,
  "creadoPorId"       TEXT,                   -- null = migración o seed
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consecutivo_piso_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "consecutivo_piso_clave_idx" ON "consecutivo_piso"("clave");
ALTER TABLE "consecutivo_piso" ADD CONSTRAINT "consecutivo_piso_tipoTramiteCodigo_fkey"
  FOREIGN KEY ("tipoTramiteCodigo") REFERENCES "tipo_tramite"("codigo") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consecutivo_piso" ADD CONSTRAINT "consecutivo_piso_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "tipo_tramite"
   SET "ciudadesContadorComun" = ARRAY['BAQ','BGT','BUN']::"Ciudad"[], "updatedAt" = CURRENT_TIMESTAMP
 WHERE "codigo" = 'IMPORTACION';
