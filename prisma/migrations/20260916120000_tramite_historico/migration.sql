-- Trámites cargados desde el archivo histórico (Drive 2026)
ALTER TABLE "tramite_do" ADD COLUMN "esHistorico" BOOLEAN NOT NULL DEFAULT false;
