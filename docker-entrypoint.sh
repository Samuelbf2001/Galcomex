#!/bin/sh
set -e

echo "--- Galcomex: aplicando migraciones ---"
npx prisma migrate deploy

echo "--- Galcomex: sembrando datos iniciales ---"
npx tsx prisma/seed.ts || echo "Seed omitido (ya aplicado o falló de forma no bloqueante)"

echo "--- Galcomex: iniciando servidor ---"
exec "$@"
