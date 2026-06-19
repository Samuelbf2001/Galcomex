#!/bin/sh
set -e

echo "--- Galcomex: esperando conexión a postgres ---"
until npx prisma db execute --stdin <<'SQL' 2>/dev/null
SELECT 1;
SQL
do
  echo "Postgres no disponible aún, reintentando en 2s..."
  sleep 2
done

echo "--- Galcomex: aplicando migraciones ---"
npx prisma migrate deploy

echo "--- Galcomex: sembrando datos iniciales ---"
npx tsx prisma/seed.ts || echo "Seed omitido (ya aplicado o falló de forma no bloqueante)"

echo "--- Galcomex: iniciando servidor ---"
exec "$@"
