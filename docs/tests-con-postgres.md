# Correr los tests de integración con PostgreSQL

Buena parte de la suite (unos 92 tests) toca base de datos de verdad: servicios de
pagos, facturas de proveedor, cartera, borradores, anticipos y documentos. Esos
tests **se saltan solos** si no encuentran `DATABASE_URL`, así que una corrida sin
base de datos dice "verde" habiendo verificado bastante menos de lo que parece.

Conviene mirar el número: sin base de datos son ~321 tests ejecutados; con base de
datos, ~413. Esa diferencia es justo la capa donde viven las transacciones, los
saldos y las reglas de estado — la parte cara de equivocarse.

## Levantar la base

En una máquina con PostgreSQL 16 instalado (Debian/Ubuntu):

```bash
pg_ctlcluster 16 main start

su postgres -c "psql -c \"CREATE USER galcomex WITH PASSWORD 'galcomex' SUPERUSER;\""
su postgres -c "psql -c 'CREATE DATABASE galcomex OWNER galcomex;'"
```

`SUPERUSER` es cómodo en local porque algunos tests usan advisory locks; en
producción el usuario de la aplicación no necesita ese privilegio.

Si prefieres Docker, `docker-compose.yml` ya define el servicio y lo expone en el
puerto 5433 — en ese caso ajusta el puerto en la URL de abajo.

## Preparar el esquema

```bash
export DATABASE_URL="postgresql://galcomex:galcomex@localhost:5432/galcomex"

npx prisma migrate deploy   # aplica las migraciones en orden
npm run db:seed             # matriz de pagos, parámetros, checklist y usuarios
```

El seed es idempotente: se puede volver a correr sin pisar contraseñas ya
cambiadas.

## Correr la suite

```bash
export DATABASE_URL="postgresql://galcomex:galcomex@localhost:5432/galcomex"
npm run test
```

Los tests de integración corren **en serie** a propósito (`fileParallelism: false`
en `vitest.config.ts`): comparten una sola base y algunos mutan datos de
referencia como la matriz de pagos, así que en paralelo se pisarían.

## Antes de un go-live

Correr la suite completa **con** base de datos es el chequeo que de verdad cubre
las rutas de integración. Una corrida sin `DATABASE_URL` sirve para el día a día
—compila, casos dorados, lógica pura— pero no alcanza para dar por verificado un
cambio que toque persistencia.
