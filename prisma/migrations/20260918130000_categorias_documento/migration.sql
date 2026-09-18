-- Cuatro categorías nuevas de documento (Ernesto, 2026-09-18), salidas del
-- análisis de los 2.662 archivos "Otro" del histórico de Litoplas.
-- Ver docs/CATALOGOS.md §4 y ../litoplas-flujo-vs-plataforma.md §10.
--
-- CÓMO APLICARLA: `npx prisma migrate deploy` basta en PostgreSQL >= 12, que
-- admite ALTER TYPE ... ADD VALUE dentro de una transacción siempre que el
-- valor nuevo NO se use en la misma transacción (esta migración solo declara,
-- no inserta ni compara). Si el motor fuera anterior a 12 y respondiera
-- "ALTER TYPE ... ADD VALUE cannot run inside a transaction block", aplicar el
-- archivo a mano fuera de transacción:
--     psql "$DATABASE_URL" -f prisma/migrations/20260918130000_categorias_documento/migration.sql
-- y luego marcarla como aplicada con
--     npx prisma migrate resolve --applied 20260918130000_categorias_documento
-- Una sentencia por valor: ADD VALUE no acepta listas.
ALTER TYPE "CategoriaDocumento" ADD VALUE IF NOT EXISTS 'CONTROL_TRAMITE';
ALTER TYPE "CategoriaDocumento" ADD VALUE IF NOT EXISTS 'FICHA_TECNICA';
ALTER TYPE "CategoriaDocumento" ADD VALUE IF NOT EXISTS 'CORRESPONDENCIA';
ALTER TYPE "CategoriaDocumento" ADD VALUE IF NOT EXISTS 'ORDEN_COMPRA';
