-- ════════════════════════════════════════════════════════════════════════════
-- CxP v2 — REVERSA (volver a correr el código de e5cd35b sobre una BD con M1–M5)
-- docs/CXP-PROVEEDORES.md § Reversa y re-avance · diseño §I
--
-- Qué hace (una sola transacción, todo o nada):
--   0. Lista las facturas ABONADAS con su saldo real ("pagar solo el saldo"):
--      el código viejo las va a mostrar como pendientes por el valor COMPLETO.
--   1. PARCIAL → REGISTRADA (el cliente Prisma de e5cd35b no conoce PARCIAL y
--      se caería al leer cualquier factura en ese estado: DO, ficha y /pagos).
--   2. Quita la FK pago_tramite.grupoPagoId → pago_grupo (el código viejo crea
--      el grupoPagoId sin cabecera).
--   3. pago_tramite_factura.monto vuelve a admitir NULL (el código viejo crea el
--      puente sin monto).
--   4. Apaga los tres guardianes de saldo (el código viejo permite doble pago
--      por diseño y el guardián lo convertiría en error 500).
-- Qué NO toca (a propósito): columnas y tablas nuevas (incluida la marca
-- esHistorico que 20260925100250_cxp_v2_bloques_lote_historicos pone a los
-- bloques de la carga histórica: el código viejo no lee pago_grupo), triggers
-- de llaves e índice único (proveedor, número). Siguen al día para volver con
-- `re-avance-v2.sql`. Consecuencia aceptada: en el código viejo una factura
-- duplicada del mismo proveedor da un error genérico en vez de guardarse.
--
-- Uso (local o en el VPS, UNA sesión, fuera de horario):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cxp/reversa-v2.sql
-- Después: desplegar la imagen de e5cd35b. Su `prisma migrate deploy` no
-- intenta deshacer M1–M5 (solo aplica migraciones pendientes que conoce).
-- Para volver a v2: scripts/cxp/re-avance-v2.sql y luego desplegar v2.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 0. Abonadas: pagar SOLO el saldo mientras corra el código viejo.
\echo '=== Facturas ABONADAS (el código viejo las mostrará por el valor completo): pagar solo el SALDO ==='
SELECT t."consecutivo"                                   AS "DO",
       f."numFactura"                                    AS "Factura",
       COALESCE(b."nombreCorto", b."nombre", f."proveedorNombre") AS "Proveedor",
       f."valor"                                         AS "Valor",
       f."valor"
         - COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
         - COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
         - f."montoCompensado"                           AS "Saldo (pagar solo esto)"
FROM "factura_proveedor" f
JOIN "tramite_do" t ON t.id = f."tramiteId"
LEFT JOIN "beneficiario" b ON b.id = f."beneficiarioId"
WHERE f."estado" = 'PARCIAL'
ORDER BY t."consecutivo", f."numFactura";

-- 1. El enum viejo no tiene PARCIAL.
UPDATE "factura_proveedor" SET "estado" = 'REGISTRADA' WHERE "estado" = 'PARCIAL';

-- 2. El código viejo genera grupoPagoId sin cabecera PagoGrupo.
ALTER TABLE "pago_tramite" DROP CONSTRAINT IF EXISTS "pago_tramite_grupoPagoId_fkey";

-- 3. El código viejo crea el puente sin monto (la CHECK monto >= 0 deja pasar NULL).
ALTER TABLE "pago_tramite_factura" ALTER COLUMN "monto" DROP NOT NULL;

-- 4. Guardianes de saldo apagados (idempotente: DISABLE sobre uno ya apagado no falla).
ALTER TABLE "pago_tramite_factura" DISABLE TRIGGER trg_pago_factura_saldo;
ALTER TABLE "ajuste_factura_proveedor" DISABLE TRIGGER trg_ajuste_saldo;
ALTER TABLE "factura_proveedor" DISABLE TRIGGER trg_factura_valor_saldo;

\echo '=== Reversa CxP v2 aplicada. Ya se puede desplegar e5cd35b. Para volver: re-avance-v2.sql ==='

COMMIT;
