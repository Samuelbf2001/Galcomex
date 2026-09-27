-- ============================================================================
-- borradores-a-regenerar.sql — Asesoría NO SE COBRA (Ascinter) + CxP v2
-- ============================================================================
-- Qué es: consulta de SOLO LECTURA que lista los borradores de factura de venta
-- que todavía NO están facturados (BORRADOR / EN_REVISION / APROBADO) de DOs
-- que tienen pagos del libro enlazados a facturas de proveedor NO SE COBRA
-- (`factura_proveedor.repercutible = false`, la asesoría).
--
-- Por qué: antes del arreglo de la rama fix/ascinter-asesoria-siigo, el
-- borrador sumaba al total de pagos del cliente (y a sus costos bancarios y a
-- la base del 4x1000) lo que Galcomex pagó por la asesoría. Esos totales
-- quedaron congelados al generar el borrador: hay que REGENERARLOS después de
-- desplegar para que el cliente no pague la asesoría. Los FACTURADO no se
-- tocan (ya están en SIIGO; si alguno quedó mal se corrige con nota crédito).
--
-- IMPORTANTE:
--   * No escribe nada: todo va dentro de BEGIN READ ONLY … ROLLBACK.
--   * No depende de columnas de CxP v2 (sirve antes o después de la migración).
--   * Reglas del VPS (CLAUDE.md global): UNA sola sesión SSH, medir antes
--     `uptime`/steal, fuera de horario laboral si no es urgente, nunca en
--     paralelo con un deploy.
--
-- Cómo correrlo (local):
--   docker exec -i galcomex-app-postgres-1 psql -U galcomex -d <base> \
--     -v ON_ERROR_STOP=1 -f scripts/cxp/borradores-a-regenerar.sql
-- En producción (cuando Ernesto lo autorice), en UNA sesión SSH:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f borradores-a-regenerar.sql
--
-- Qué hacer con el resultado: por cada fila, ADMIN/REVISOR abre el DO en
-- Facturación y vuelve a generar el borrador (un APROBADO primero se devuelve).
-- El revisor verá el aviso «Pagos por revisar» si algún pago quedó dudoso.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;

-- Q1. Borradores no facturados de DOs con asesoría enlazada a pagos.
WITH asesoria_enlazada AS (
  SELECT p."tramiteId",
         COUNT(DISTINCT p.id)  AS pagos_con_asesoria,
         COUNT(DISTINCT f.id)  AS facturas_asesoria,
         -- Valor de las facturas NO SE COBRA enlazadas (referencia; lo que el
         -- borrador viejo pudo sumar de más depende de cuánto se les pagó).
         (SELECT COALESCE(SUM(f2.valor), 0)
            FROM "factura_proveedor" f2
           WHERE f2.id IN (
             SELECT ptf2."facturaId"
               FROM "pago_tramite_factura" ptf2
               JOIN "pago_tramite" p2 ON p2.id = ptf2."pagoId"
              WHERE p2."tramiteId" = p."tramiteId"
           )
             AND f2.repercutible = false) AS valor_asesoria
    FROM "pago_tramite" p
    JOIN "pago_tramite_factura" ptf ON ptf."pagoId" = p.id
    JOIN "factura_proveedor" f      ON f.id = ptf."facturaId"
   WHERE f.repercutible = false
   GROUP BY p."tramiteId"
)
SELECT t.consecutivo                  AS do,
       c.nombre                       AS cliente,
       b.id                           AS borrador_id,
       b.estado                       AS estado_borrador,
       b."formatoFactura"             AS formato,
       b."createdAt"                  AS generado_en,
       b."totalPagos"                 AS total_pagos_congelado,
       b."costosBancarios"            AS costos_bancarios_congelados,
       b."impuesto4x1000"             AS impuesto_4x1000_congelado,
       b."totalFactura"               AS total_factura_congelado,
       a.pagos_con_asesoria,
       a.facturas_asesoria,
       a.valor_asesoria
  FROM "borrador_factura" b
  JOIN asesoria_enlazada a ON a."tramiteId" = b."tramiteId"
  JOIN "tramite_do" t      ON t.id = b."tramiteId"
  JOIN "cliente" c         ON c.id = t."clienteId"
 WHERE b.estado IN ('BORRADOR', 'EN_REVISION', 'APROBADO')
 ORDER BY b.estado DESC, t.consecutivo, b."createdAt" DESC;

-- Q2. Conteo por estado (para el resumen a Ernesto).
SELECT b.estado, COUNT(*) AS borradores
  FROM "borrador_factura" b
 WHERE b.estado IN ('BORRADOR', 'EN_REVISION', 'APROBADO')
   AND EXISTS (
     SELECT 1
       FROM "pago_tramite" p
       JOIN "pago_tramite_factura" ptf ON ptf."pagoId" = p.id
       JOIN "factura_proveedor" f      ON f.id = ptf."facturaId"
      WHERE p."tramiteId" = b."tramiteId"
        AND f.repercutible = false
   )
 GROUP BY b.estado
 ORDER BY b.estado;

-- Q3. Pagos MIXTOS (transporte que se cobra + asesoría NO SE COBRA en el mismo
-- pago) que no alcanzan a cubrir sus facturas. Son los que la migración M3 tuvo
-- que repartir por su cuenta: desde el 25-sep llena primero la asesoría y el
-- borrador los trata como estimados (heurística de Ascinter + marca
-- ABONO_PARCIAL / BLOQUE_SIN_MONTOS). Correr ANTES de regenerar para saber
-- cuántos avisos «Pagos por revisar» va a ver el revisor. No usa columnas de
-- CxP v2 (sirve antes o después de la migración).
WITH por_pago AS (
  SELECT p.id, p."tramiteId", p.valor, p."grupoPagoId",
         SUM(f.valor)                                          AS valor_facturas,
         SUM(f.valor) FILTER (WHERE f.repercutible = false)    AS valor_asesoria,
         BOOL_OR(f.repercutible) AND BOOL_OR(NOT f.repercutible) AS mixto
    FROM "pago_tramite" p
    JOIN "pago_tramite_factura" ptf ON ptf."pagoId" = p.id
    JOIN "factura_proveedor" f      ON f.id = ptf."facturaId"
   GROUP BY p.id, p."tramiteId", p.valor, p."grupoPagoId"
)
SELECT t.consecutivo                           AS do,
       pp.id                                   AS pago_id,
       (pp."grupoPagoId" IS NOT NULL)          AS en_bloque,
       pp.valor                                AS valor_pago,
       pp.valor_facturas,
       pp.valor_asesoria,
       EXISTS (SELECT 1 FROM "borrador_factura" b
                WHERE b."tramiteId" = pp."tramiteId"
                  AND b.estado IN ('BORRADOR', 'EN_REVISION', 'APROBADO')) AS tiene_borrador_abierto
  FROM por_pago pp
  JOIN "tramite_do" t ON t.id = pp."tramiteId"
 WHERE pp.mixto AND pp.valor < pp.valor_facturas
 ORDER BY t.consecutivo, pp.id;

ROLLBACK;
