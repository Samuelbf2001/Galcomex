-- ════════════════════════════════════════════════════════════════════════════
-- CxP v2 — RE-AVANCE (volver a v2 después de `reversa-v2.sql`)
-- docs/CXP-PROVEEDORES.md § Reversa y re-avance · diseño §I
--
-- Mientras corrió el código de e5cd35b pudo: crear enlaces pago↔factura SIN
-- monto, crear grupos de pago en bloque SIN cabecera, cruzar/deshacer cruces
-- sin tocar montoCompensado, marcar PAGADA con pagos menores y borrar o editar
-- pagos de un bloque. Sin este script los enlaces con monto NULL contarían 0 y
-- las facturas PAGADA volverían a ser pagables (doble pago).
--
-- Qué hace (una sola transacción, todo o nada):
--   1. Cruces: compensacionId NULL → montoCompensado 0 (deshecho por el código viejo).
--   2. Completa `monto` de los enlaces NULL con las pasadas 0–2 de M3,
--      RESPETANDO los montos que ya existen (tope por pago y por factura).
--   3. Cruces nuevos del código viejo (compensacionId con montoCompensado 0) → por el resto.
--   4. monto vuelve a NOT NULL.
--   5. Pagos con facturas y sin beneficiario → el de su factura (igual que M3 2b).
--   6. PAGADA con faltante → ajuste LEGADO (no cambia el estado visible).
--   7. Estado de todas las facturas = función del saldo.
--   8. Cabeceras PagoGrupo para los grupoPagoId nuevos (PRIMER_DO); bloques
--      ACTIVO: totalAplicado = Σ valor de sus pagos; sin pagos → ANULADO.
--  8b. Bloques de la carga histórica (lote HIST-PLATA-…, sin comprobante ni
--      costo) → esHistorico, igual que 20260925100250_cxp_v2_bloques_lote_historicos.
--   9. Vuelve a crear la FK pago_tramite.grupoPagoId → pago_grupo.
--  10. Guardianes de saldo: se ENCIENDEN solo si M5 (20260925100400_cxp_v2_guardian)
--      ya está aplicada; si no, quedan como los dejó M3 (apagados).
--  11. Verificación: si alguna factura queda sobre-aplicada (I2) o con estado
--      distinto de su saldo (I4) → ERROR y no se guarda nada. Pagos con
--      Σ montos > valor (I3) se listan (no bloquean: los decide administración).
--
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cxp/re-avance-v2.sql
-- Después: desplegar v2 y correr scripts/cxp/verificar-invariantes.ts (P7b).
-- Idempotente: una segunda corrida no cambia nada.
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

BEGIN;

-- 1. Cruces deshechos por el código viejo (eliminarCompensacion dejó compensacionId NULL).
UPDATE "factura_proveedor"
SET "montoCompensado" = 0
WHERE "compensacionId" IS NULL AND "montoCompensado" > 0;

-- 2. Enlaces sin monto (creados por el código viejo). Mismas pasadas que M3,
--    con tope = lo que aún cabe en el pago y en la factura.
WITH audit AS (
  SELECT DISTINCT ON (ptf."pagoId", ptf."facturaId")
         ptf."pagoId", ptf."facturaId",
         (a."antes" ->> 'montoPagadoEnGrupo')::bigint AS monto
  FROM "pago_tramite_factura" ptf
  JOIN "pago_tramite" p ON p.id = ptf."pagoId" AND p."grupoPagoId" IS NOT NULL
  JOIN "audit_log" a
    ON a."entidad" = 'FacturaProveedor'
   AND a."accion" = 'UPDATE_ESTADO'
   AND a."entidadId" = ptf."facturaId"
   AND a."tramiteId" = p."tramiteId"
   AND (a."antes" ->> 'montoPagadoEnGrupo') ~ '^[0-9]{1,18}$'
  WHERE ptf."monto" IS NULL
  ORDER BY ptf."pagoId", ptf."facturaId",
           abs(extract(epoch FROM (a."createdAt" - p."createdAt"))), a."createdAt" DESC, a.id DESC
),
ya_pago AS (
  SELECT "pagoId", SUM("monto") AS s FROM "pago_tramite_factura" WHERE "monto" IS NOT NULL GROUP BY 1
),
ya_factura AS (
  SELECT f.id,
         COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id AND x."monto" IS NOT NULL), 0)
       + COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
       + f."montoCompensado" AS s
  FROM "factura_proveedor" f
),
base AS (
  SELECT ptf."pagoId", ptf."facturaId",
         p.valor - COALESCE(yp.s, 0) AS pv,
         f.valor - yf.s AS fv,
         f.repercutible AS frep, f.fecha AS ffecha, f."createdAt" AS fcreado,
         GREATEST(0, LEAST(COALESCE(au.monto, f.valor), f.valor)) AS p0
  FROM "pago_tramite_factura" ptf
  JOIN "pago_tramite" p ON p.id = ptf."pagoId"
  JOIN "factura_proveedor" f ON f.id = ptf."facturaId"
  JOIN ya_factura yf ON yf.id = f.id
  LEFT JOIN ya_pago yp ON yp."pagoId" = ptf."pagoId"
  LEFT JOIN audit au ON au."pagoId" = ptf."pagoId" AND au."facturaId" = ptf."facturaId"
  WHERE ptf."monto" IS NULL
),
p1 AS (
  SELECT "pagoId", "facturaId", fv,
         GREATEST(0, LEAST(p0, pv - COALESCE(SUM(p0) OVER (
           PARTITION BY "pagoId" ORDER BY frep, ffecha, fcreado, "facturaId"
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS prov
  FROM base
),
p2 AS (
  SELECT p1."pagoId", p1."facturaId", p1.fv, p1.prov,
         SUM(p1.prov) OVER (
           PARTITION BY p1."facturaId"
           ORDER BY p."fechaRealPago" NULLS LAST, p."createdAt", p.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS antes
  FROM p1
  JOIN "pago_tramite" p ON p.id = p1."pagoId"
)
UPDATE "pago_tramite_factura" t
SET "monto" = GREATEST(0, LEAST(p2.prov, p2.fv - COALESCE(p2.antes, 0)))
FROM p2
WHERE t."pagoId" = p2."pagoId" AND t."facturaId" = p2."facturaId" AND t."monto" IS NULL;

UPDATE "pago_tramite_factura" SET "monto" = 0 WHERE "monto" IS NULL;

-- 3. Cruces hechos por el código viejo (compensacionId sin montoCompensado).
UPDATE "factura_proveedor" f
SET "montoCompensado" = GREATEST(0, f.valor
      - COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
      - COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0))
WHERE f."compensacionId" IS NOT NULL AND f."montoCompensado" = 0;

-- 4. monto obligatorio otra vez.
ALTER TABLE "pago_tramite_factura" ALTER COLUMN "monto" SET NOT NULL;

-- 5. Pagos con facturas y sin beneficiario → el de su factura.
INSERT INTO "pago_tramite_beneficiario" ("pago_id", "beneficiario_id")
SELECT DISTINCT ptf."pagoId", f."beneficiarioId"
FROM "pago_tramite_factura" ptf
JOIN "factura_proveedor" f ON f.id = ptf."facturaId"
WHERE f."beneficiarioId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "pago_tramite_beneficiario" pb WHERE pb."pago_id" = ptf."pagoId")
ON CONFLICT DO NOTHING;

-- 6. PAGADA con faltante → LEGADO (id único por corrida; el faltante ya descuenta ajustes previos).
INSERT INTO "ajuste_factura_proveedor" ("id", "facturaId", "tipo", "monto", "motivo", "usuarioId", "createdAt")
SELECT 'reavance-cxp-v2-' || f.id || '-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'),
       f.id, 'LEGADO', s.faltante,
       'Re-avance CxP v2: el código anterior la dejó pagada con pagos por ' || s.aplicado || ' de ' || f.valor
         || '. Revisar con el extracto.',
       NULL, CURRENT_TIMESTAMP
FROM "factura_proveedor" f
JOIN LATERAL (
  SELECT COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0) AS aplicado,
         f.valor
           - COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
           - COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
           - f."montoCompensado" AS faltante
) s ON true
WHERE f.estado IN ('PAGADA', 'FACTURADA_CLIENTE') AND s.faltante > 0;

-- 7. Estado = función del saldo.
WITH t AS (
  SELECT f.id, f.valor,
         COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
       + COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
       + f."montoCompensado" AS saldado
  FROM "factura_proveedor" f
)
UPDATE "factura_proveedor" f
SET estado = CASE
    WHEN t.valor - t.saldado <= 0 THEN 'PAGADA'::"EstadoFacturaProveedor"
    WHEN t.saldado = 0 THEN 'REGISTRADA'::"EstadoFacturaProveedor"
    ELSE 'PARCIAL'::"EstadoFacturaProveedor"
  END
FROM t
WHERE f.id = t.id
  AND f.estado IS DISTINCT FROM CASE
    WHEN t.valor - t.saldado <= 0 THEN 'PAGADA'::"EstadoFacturaProveedor"
    WHEN t.saldado = 0 THEN 'REGISTRADA'::"EstadoFacturaProveedor"
    ELSE 'PARCIAL'::"EstadoFacturaProveedor"
  END;

-- 8. Cabeceras de bloques nuevos y totales de los activos.
INSERT INTO "pago_grupo" ("id", "beneficiarioId", "concepto", "canalPago", "fechaRealPago", "documentoId",
  "comprobanteComercioId", "totalAplicado", "costoBancario", "costoAsumidoPor", "estado", "esHistorico",
  "creadoPorId", "createdAt", "updatedAt")
SELECT g.gid,
  (SELECT pb."beneficiario_id" FROM "pago_tramite_beneficiario" pb
    WHERE pb."pago_id" = pr.id ORDER BY pb."beneficiario_id" LIMIT 1),
  pr.concepto, pr."canalPago", pr."fechaRealPago", pr."documentoId", pr."comprobanteComercioId",
  g.total, g.costo, 'PRIMER_DO', 'ACTIVO', false,
  (SELECT a."usuarioId" FROM "audit_log" a
    WHERE a."entidad" = 'PagoTramiteGrupo' AND a."entidadId" = g.gid AND a."accion" = 'CREATE'
    ORDER BY a."createdAt" LIMIT 1),
  g.creado, CURRENT_TIMESTAMP
FROM (
  SELECT "grupoPagoId" AS gid, SUM(valor) AS total, SUM("costoBancario") AS costo, MIN("createdAt") AS creado
  FROM "pago_tramite"
  WHERE "grupoPagoId" IS NOT NULL
  GROUP BY 1
) g
CROSS JOIN LATERAL (
  SELECT * FROM "pago_tramite" p WHERE p."grupoPagoId" = g.gid ORDER BY p."createdAt", p.id LIMIT 1
) pr
WHERE NOT EXISTS (SELECT 1 FROM "pago_grupo" x WHERE x.id = g.gid);

UPDATE "pago_grupo" g
SET "totalAplicado" = s.total, "updatedAt" = CURRENT_TIMESTAMP
FROM (SELECT "grupoPagoId" AS gid, SUM(valor) AS total FROM "pago_tramite"
      WHERE "grupoPagoId" IS NOT NULL GROUP BY 1) s
WHERE g.id = s.gid AND g."estado" = 'ACTIVO' AND g."totalAplicado" <> s.total;

UPDATE "pago_grupo" g
SET "estado" = 'ANULADO',
    "motivoAnulacion" = 'Re-avance CxP v2: el código anterior borró todos los pagos de este bloque.',
    "anuladoEn" = CURRENT_TIMESTAMP,
    "snapshotAnulacion" = jsonb_build_object('origen', 're-avance-v2', 'totalAplicado', g."totalAplicado"::text),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE g."estado" = 'ACTIVO'
  AND NOT EXISTS (SELECT 1 FROM "pago_tramite" p WHERE p."grupoPagoId" = g.id);

-- 8b. Bloques de la carga histórica = históricos. MISMO UPDATE que la migración
--     20260925100250_cxp_v2_bloques_lote_historicos (ver sus criterios): cubre
--     los bloques del lote a los que el paso 8 acaba de crear cabecera.
UPDATE "pago_grupo" g
SET "esHistorico" = true,
    "costoAsumidoPor" = 'GALCOMEX',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE g."esHistorico" = false
  AND g."estado" = 'ACTIVO'
  AND g."hashSolicitud" IS NULL
  AND g."claveIdempotencia" IS NULL
  AND g."documentoId" IS NULL
  AND g."costoBancario" = 0
  AND EXISTS (SELECT 1 FROM "pago_tramite" p WHERE p."grupoPagoId" = g.id)
  AND NOT EXISTS (
    SELECT 1
    FROM "pago_tramite" p
    WHERE p."grupoPagoId" = g.id
      AND (
        p."documentoId" IS NOT NULL
        OR p."costoBancario" <> 0
        OR NOT EXISTS (
          SELECT 1
          FROM "audit_log" a
          WHERE a."entidad" = 'PagoTramite'
            AND a."entidadId" = p.id
            AND a."despues" ->> '_lote' LIKE 'HIST-PLATA-%'
            AND a."despues" ->> 'grupoPagoId' = g.id
        )
      )
  );

-- 9. FK de vuelta (idempotente).
ALTER TABLE "pago_tramite" DROP CONSTRAINT IF EXISTS "pago_tramite_grupoPagoId_fkey";
ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_grupoPagoId_fkey"
  FOREIGN KEY ("grupoPagoId") REFERENCES "pago_grupo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 10. Guardianes: solo si M5 ya está aplicada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "_prisma_migrations"
             WHERE "migration_name" = '20260925100400_cxp_v2_guardian' AND "finished_at" IS NOT NULL
               AND "rolled_back_at" IS NULL) THEN
    ALTER TABLE "pago_tramite_factura" ENABLE TRIGGER trg_pago_factura_saldo;
    ALTER TABLE "ajuste_factura_proveedor" ENABLE TRIGGER trg_ajuste_saldo;
    ALTER TABLE "factura_proveedor" ENABLE TRIGGER trg_factura_valor_saldo;
    RAISE NOTICE 'Guardianes de saldo ENCENDIDOS (M5 aplicada).';
  ELSE
    RAISE NOTICE 'M5 (cxp_v2_guardian) no está aplicada: los guardianes siguen apagados como los dejó M3.';
  END IF;
END $$;

-- 11. Verificación (I2, I4 bloquean; I3 se lista).
\echo '=== I3: pagos cuyo Σ montos aplicados supera su valor (revisar con administración) ==='
SELECT p.id AS "Pago", t."consecutivo" AS "DO", p.valor AS "Valor", SUM(x."monto") AS "Aplicado"
FROM "pago_tramite" p
JOIN "pago_tramite_factura" x ON x."pagoId" = p.id
JOIN "tramite_do" t ON t.id = p."tramiteId"
GROUP BY p.id, t."consecutivo", p.valor
HAVING SUM(x."monto") > p.valor;

DO $$
DECLARE i2 int; i4 int;
BEGIN
  SELECT count(*) INTO i2 FROM "factura_proveedor" f
  WHERE COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
      + COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
      + f."montoCompensado" > f.valor;
  SELECT count(*) INTO i4 FROM "factura_proveedor" f
  CROSS JOIN LATERAL (SELECT f.valor
      - COALESCE((SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0)
      - COALESCE((SELECT SUM(a."monto") FROM "ajuste_factura_proveedor" a WHERE a."facturaId" = f.id), 0)
      - f."montoCompensado" AS saldo) s
  WHERE f.estado IS DISTINCT FROM CASE
      WHEN s.saldo <= 0 THEN 'PAGADA'::"EstadoFacturaProveedor"
      WHEN s.saldo = f.valor THEN 'REGISTRADA'::"EstadoFacturaProveedor"
      ELSE 'PARCIAL'::"EstadoFacturaProveedor" END;
  IF i2 > 0 OR i4 > 0 THEN
    RAISE EXCEPTION 'Re-avance CxP v2 abortado: % facturas sobre-aplicadas (I2) y % con estado distinto del saldo (I4). No se guardó nada.', i2, i4;
  END IF;
  RAISE NOTICE 'Re-avance CxP v2: I2 = 0, I4 = 0.';
END $$;

\echo '=== Re-avance CxP v2 aplicado. Desplegar v2 y correr verificar-invariantes. ==='

COMMIT;
