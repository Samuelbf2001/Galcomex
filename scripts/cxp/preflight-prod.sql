-- ============================================================================
-- preflight-prod.sql — CxP proveedores v2 (Almacarga/Express) — Paquete P7a
-- ============================================================================
-- Qué es: 14 consultas de SOLO LECTURA (Q1–Q14) que detectan de antemano las
-- colisiones y rarezas que la migración CxP v2 tendría que resolver, para que
-- Ernesto y Camila las revisen ANTES del despliegue (§A.8 de
-- DISENO-CXP-V2.md).
--
-- IMPORTANTE:
--   * Este script NO escribe nada. Está pensado para correr dentro de una
--     transacción de solo lectura que termina siempre en ROLLBACK.
--   * En producción usa las funciones/columnas que la migración va a crear
--     (cxp_normalizar_num, cxp_nit_base, cxp_dv_nit, numFacturaNormalizado,
--     proveedorClave, pago_tramite_factura.monto, pago_grupo…) que TODAVÍA NO
--     EXISTEN antes de desplegar. Por eso cada consulta reescribe esa lógica
--     en línea con expresiones equivalentes (documentado en §A.8 y en las
--     migraciones M1–M3 de §A.7).
--   * Reglas del VPS (CLAUDE.md global): correr esto en producción en UNA
--     sola sesión SSH, después de medir `uptime`/steal, fuera de horario
--     laboral de Colombia si no es urgente, y jamás en paralelo con un
--     deploy. Este paquete (P7a) NO lo ejecuta en producción: solo lo deja
--     listo y probado contra `galcomex_sim_almacarga`.
--
-- Cómo correrlo (local, contra galcomex_sim_almacarga):
--   docker exec -i galcomex-app-postgres-1 psql -U galcomex -d galcomex_sim_almacarga \
--     -v ON_ERROR_STOP=1 -f scripts/cxp/preflight-prod.sql
--
-- Cómo correrlo en producción (cuando Ernesto lo autorice, §I del diseño):
--   UNA sesión SSH: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f preflight-prod.sql`
--   El script entero vive dentro de BEGIN READ ONLY … ROLLBACK: aunque algo
--   saliera mal, no puede dejar nada escrito.
-- ============================================================================

\pset pager off
\timing off

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- Q1 — Facturas repetidas del mismo proveedor
-- ----------------------------------------------------------------------------
-- Detecta: qué facturas chocarían con la llave nueva
-- @@unique([proveedorClave, numFacturaNormalizado]).
-- Qué pasa en la migración: la más antigua (por createdAt) conserva la llave;
-- las demás quedan con proveedorClave = NULL ("duplicado heredado, revisar")
-- y salen en este reporte.
\echo '=== Q1: facturas repetidas del mismo proveedor (misma llave NIT+número) ==='
WITH claves AS (
  SELECT
    f.id,
    f."tramiteId",
    f."beneficiarioId",
    f."numFactura",
    f.valor,
    f.estado,
    f."createdAt",
    -- nitBase aproximado: solo dígitos, sin ceros a la izquierda (sin separar DV,
    -- la función real cxp_nit_base todavía no existe en prod).
    NULLIF(ltrim(regexp_replace(COALESCE(b.nit, ''), '[^0-9]', '', 'g'), '0'), '') AS nitbase_aprox,
    -- número normalizado: mayúsculas, solo A-Z0-9 (igual a cxp_normalizar_num).
    NULLIF(upper(regexp_replace(COALESCE(f."numFactura", ''), '[^A-Za-z0-9]', '', 'g')), '') AS numnorm
  FROM factura_proveedor f
  LEFT JOIN beneficiario b ON b.id = f."beneficiarioId"
)
SELECT
  nitbase_aprox,
  numnorm,
  count(*) AS n_facturas,
  min(id) FILTER (WHERE rn = 1) AS id_conserva_llave,
  array_agg(id ORDER BY "createdAt", id) FILTER (WHERE rn > 1) AS ids_quedan_duplicado_heredado,
  sum(valor) AS suma_valor,
  array_agg(DISTINCT estado) AS estados
FROM (
  SELECT *,
         row_number() OVER (PARTITION BY nitbase_aprox, numnorm ORDER BY "createdAt", id) AS rn
  FROM claves
  WHERE nitbase_aprox IS NOT NULL AND numnorm IS NOT NULL
) x
GROUP BY nitbase_aprox, numnorm
HAVING count(*) > 1
ORDER BY n_facturas DESC, nitbase_aprox, numnorm;

-- ----------------------------------------------------------------------------
-- Q2 — Facturas PAGADA con pagos enlazados por debajo de su valor
-- ----------------------------------------------------------------------------
-- Simula las pasadas 1–2 del backfill de M3 (§A.7 M3, punto 2) para calcular
-- cuánto de cada pago se le podría atribuir a cada factura SIN la columna
-- `monto` (que hoy no existe en pago_tramite_factura: el puente es un pivot
-- sin monto). Qué pasa en la migración: si el total simulado no alcanza el
-- valor, se crea un ajuste LEGADO (el estado visible PAGADA no cambia).
\echo '=== Q2: facturas PAGADA cuyos pagos enlazados (simulados) no alcanzan el valor ==='
WITH base AS (
  SELECT
    ptf."pagoId", ptf."facturaId",
    p.valor AS pv, f.valor AS fv,
    SUM(f.valor) OVER (
      PARTITION BY ptf."pagoId" ORDER BY f.fecha, f."createdAt", f.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previas
  FROM pago_tramite_factura ptf
  JOIN pago_tramite p ON p.id = ptf."pagoId"
  JOIN factura_proveedor f ON f.id = ptf."facturaId"
),
-- pasada 1: cada pago reparte su valor entre sus facturas, en orden (fecha, createdAt, id)
p1 AS (
  SELECT "pagoId", "facturaId", fv,
         GREATEST(0, LEAST(fv, pv - COALESCE(previas, 0))) AS prov
  FROM base
),
-- pasada 2: cada factura acepta pagos por (fechaRealPago NULLS LAST, createdAt, id)
-- hasta su valor, partiendo del monto propuesto en la pasada 1
p2 AS (
  SELECT p1.*, p."fechaRealPago", p."createdAt" AS pago_createdAt,
         SUM(p1.prov) OVER (
           PARTITION BY p1."facturaId"
           ORDER BY p."fechaRealPago" NULLS LAST, p."createdAt", p.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS antes
  FROM p1 JOIN pago_tramite p ON p.id = p1."pagoId"
),
monto_simulado AS (
  SELECT "pagoId", "facturaId",
         GREATEST(0, LEAST(prov, fv - COALESCE(antes, 0))) AS monto
  FROM p2
),
por_factura AS (
  SELECT f.id, f."numFactura", f.valor, f."tramiteId",
         COALESCE(SUM(m.monto), 0) AS aplicado_simulado
  FROM factura_proveedor f
  LEFT JOIN monto_simulado m ON m."facturaId" = f.id
  WHERE f.estado = 'PAGADA'
  GROUP BY f.id, f."numFactura", f.valor, f."tramiteId"
)
SELECT id AS factura_id, "numFactura", "tramiteId", valor, aplicado_simulado,
       (valor - aplicado_simulado) AS faltante_estimado
FROM por_factura
WHERE aplicado_simulado < valor
ORDER BY faltante_estimado DESC;

-- ----------------------------------------------------------------------------
-- Q3 — Facturas REGISTRADA que ya tienen pagos enlazados
-- ----------------------------------------------------------------------------
-- Detecta: incoherencia heredada (factura sigue "REGISTRADA" en pantalla pero
-- ya tiene puente a pagos). Qué pasa en la migración: pasa a PARCIAL/PAGADA
-- según el saldo simulado y sale en el reporte.
\echo '=== Q3: facturas REGISTRADA con pagos ya enlazados (incoherencia heredada) ==='
SELECT
  f.id AS factura_id, f."numFactura", f."tramiteId", f.valor, f.estado,
  count(ptf."pagoId") AS n_pagos_enlazados,
  array_agg(ptf."pagoId") AS pago_ids
FROM factura_proveedor f
JOIN pago_tramite_factura ptf ON ptf."facturaId" = f.id
WHERE f.estado = 'REGISTRADA'
GROUP BY f.id, f."numFactura", f."tramiteId", f.valor, f.estado
ORDER BY f."createdAt";

-- ----------------------------------------------------------------------------
-- Q4 — Pagos con varias facturas: reparto simulado por AuditLog vs. FIFO
-- ----------------------------------------------------------------------------
-- Un pago hoy puede cubrir varias facturas (pivot sin monto). El backfill de
-- M3 usa dos fuentes: (0) el AuditLog del bloque, que guarda
-- antes->>'montoPagadoEnGrupo' en el evento UPDATE_ESTADO de la factura
-- (pagos/service.ts:1187-1207; entidad='FacturaProveedor', entidadId=facturaId,
-- tramiteId = trámite de esa factura), tomando la más reciente con tope en el
-- valor de la factura; (1) si falta, FIFO por (fecha, createdAt, id) de las
-- facturas del pago. Esta consulta muestra ambas, lado a lado, y si el pago
-- mezcla beneficiarios distintos entre sus facturas (la regla "un pago = un
-- proveedor" solo se exige a partir de P1; un pago viejo que mezcle queda
-- como está y sale aquí para el reporte).
\echo '=== Q4: pagos con varias facturas — reparto AuditLog vs. FIFO, y mezcla de proveedores ==='
WITH multi AS (
  SELECT "pagoId"
  FROM pago_tramite_factura
  GROUP BY "pagoId"
  HAVING count(*) > 1
),
audit_pass AS (
  -- La más reciente entrada de AuditLog con montoPagadoEnGrupo para esa factura,
  -- con tope en el valor de la factura (igual que pagos/service.ts:1204).
  SELECT DISTINCT ON (ptf."pagoId", ptf."facturaId")
    ptf."pagoId", ptf."facturaId",
    LEAST(f.valor, (a.antes ->> 'montoPagadoEnGrupo')::bigint) AS monto_audit,
    a."createdAt" AS audit_createdAt
  FROM pago_tramite_factura ptf
  JOIN multi m ON m."pagoId" = ptf."pagoId"
  JOIN factura_proveedor f ON f.id = ptf."facturaId"
  LEFT JOIN audit_log a
    ON a.entidad = 'FacturaProveedor'
   AND a."entidadId" = ptf."facturaId"
   AND a.accion = 'UPDATE_ESTADO'
   AND a."tramiteId" = f."tramiteId"
   AND a.antes ? 'montoPagadoEnGrupo'
  ORDER BY ptf."pagoId", ptf."facturaId", a."createdAt" DESC
),
base_fifo AS (
  SELECT
    ptf."pagoId", ptf."facturaId",
    p.valor AS pv, f.valor AS fv,
    SUM(f.valor) OVER (
      PARTITION BY ptf."pagoId" ORDER BY f.fecha, f."createdAt", f.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previas
  FROM pago_tramite_factura ptf
  JOIN multi m ON m."pagoId" = ptf."pagoId"
  JOIN pago_tramite p ON p.id = ptf."pagoId"
  JOIN factura_proveedor f ON f.id = ptf."facturaId"
),
fifo_pass AS (
  SELECT "pagoId", "facturaId",
         GREATEST(0, LEAST(fv, pv - COALESCE(previas, 0))) AS monto_fifo
  FROM base_fifo
),
proveedores_por_pago AS (
  SELECT ptf."pagoId", count(DISTINCT f."beneficiarioId") AS n_proveedores_distintos
  FROM pago_tramite_factura ptf
  JOIN multi m ON m."pagoId" = ptf."pagoId"
  JOIN factura_proveedor f ON f.id = ptf."facturaId"
  GROUP BY ptf."pagoId"
)
SELECT
  ap."pagoId", ap."facturaId", f."numFactura", f.valor AS valor_factura,
  ap.monto_audit, fp.monto_fifo,
  (ap.monto_audit IS DISTINCT FROM fp.monto_fifo) AS difieren,
  pp.n_proveedores_distintos,
  (pp.n_proveedores_distintos > 1) AS mezcla_proveedores
FROM audit_pass ap
JOIN fifo_pass fp ON fp."pagoId" = ap."pagoId" AND fp."facturaId" = ap."facturaId"
JOIN factura_proveedor f ON f.id = ap."facturaId"
JOIN proveedores_por_pago pp ON pp."pagoId" = ap."pagoId"
ORDER BY ap."pagoId", f.fecha, f."createdAt";

-- ----------------------------------------------------------------------------
-- Q5 — Facturas con más de un pago (dobles pagos heredados)
-- ----------------------------------------------------------------------------
-- Qué pasa en la migración: pasada 2 del backfill — el/los pagos que ya no
-- caben en el saldo de la factura quedan enlazados con monto 0 (nunca se
-- borran, solo dejan de sumar).
\echo '=== Q5: facturas con más de un pago (dobles pagos heredados) ==='
SELECT
  f.id AS factura_id, f."numFactura", f."tramiteId", f.valor, f.estado,
  count(ptf."pagoId") AS n_pagos,
  array_agg(ptf."pagoId" ORDER BY p."fechaRealPago" NULLS LAST, p."createdAt") AS pago_ids_en_orden,
  array_agg(p.valor ORDER BY p."fechaRealPago" NULLS LAST, p."createdAt") AS valores_de_pago
FROM factura_proveedor f
JOIN pago_tramite_factura ptf ON ptf."facturaId" = f.id
JOIN pago_tramite p ON p.id = ptf."pagoId"
GROUP BY f.id, f."numFactura", f."tramiteId", f.valor, f.estado
HAVING count(ptf."pagoId") > 1
ORDER BY n_pagos DESC;

-- ----------------------------------------------------------------------------
-- Q6 — Bloques existentes (grupoPagoId) y su costo bancario total
-- ----------------------------------------------------------------------------
-- Qué pasa en la migración: M3 crea una cabecera PagoGrupo por cada
-- grupoPagoId existente, con costoAsumidoPor = PRIMER_DO (comportamiento
-- actual de e5cd35b).
\echo '=== Q6: bloques existentes (grupoPagoId) — cuántos pagos, total y costo ==='
SELECT
  "grupoPagoId",
  count(*) AS n_pagos,
  sum(valor) AS total_aplicado,
  sum("costoBancario") AS costo_bancario_total,
  min("createdAt") AS creado_aprox,
  array_agg(DISTINCT "canalPago") AS canales,
  array_agg(DISTINCT "tramiteId") AS tramites_involucrados
FROM pago_tramite
WHERE "grupoPagoId" IS NOT NULL
GROUP BY "grupoPagoId"
ORDER BY min("createdAt");

-- ----------------------------------------------------------------------------
-- Q7 — Fichas de beneficiario con el mismo NIT base
-- ----------------------------------------------------------------------------
-- Detecta: varias fichas (beneficiario) que compartirían proveedorClave.
-- Es esperado (PRD §10: varias cuentas bancarias del mismo proveedor); solo
-- se reporta para que Camila confirme que de verdad son la misma empresa.
\echo '=== Q7: fichas de beneficiario con el mismo NIT base (aprox.) — comparten llave ==='
WITH claves AS (
  SELECT id, nombre, nit, "empresaId",
         NULLIF(ltrim(regexp_replace(COALESCE(nit, ''), '[^0-9]', '', 'g'), '0'), '') AS nitbase_aprox
  FROM beneficiario
)
SELECT nitbase_aprox, count(*) AS n_fichas,
       array_agg(id ORDER BY id) AS beneficiario_ids,
       array_agg(nombre ORDER BY id) AS nombres,
       array_agg(nit ORDER BY id) AS nits_originales
FROM claves
WHERE nitbase_aprox IS NOT NULL
GROUP BY nitbase_aprox
HAVING count(*) > 1
ORDER BY n_fichas DESC;

-- ----------------------------------------------------------------------------
-- Q8 — Facturas sin beneficiarioId (huérfanas)
-- ----------------------------------------------------------------------------
-- Qué pasa en la migración: quedan sin llave (proveedorClave NULL), no
-- pagables hasta que se les asigne proveedor.
\echo '=== Q8: facturas sin beneficiarioId (huérfanas, no pagables hasta asignar proveedor) ==='
SELECT
  f.id AS factura_id, f."numFactura", f."tramiteId", f."proveedorNombre", f."proveedorNit",
  f.valor, f.estado, f."createdAt"
FROM factura_proveedor f
WHERE f."beneficiarioId" IS NULL
ORDER BY f."createdAt";

-- ----------------------------------------------------------------------------
-- Q9 — Capacidad efectiva anticipos_cliente por empresa, antes/después de M4
-- ----------------------------------------------------------------------------
-- La migración M4 escribe una fila de EMPRESA pago_exige_anticipo=false SOLO
-- donde la capacidad efectiva anticipos_cliente (empresa → grupo → defecto)
-- ya es false hoy. Esta consulta calcula esa cascada y compara el
-- comportamiento efectivo de "exige anticipo" antes (solo anticipos_cliente,
-- como hoy en el código) contra después (anticipos_cliente AND
-- pago_exige_anticipo). La columna `cambia` debe salir SIEMPRE en false: si
-- alguna fila sale en true, algo en la migración está mal.
\echo '=== Q9: capacidad efectiva anticipos_cliente por empresa, antes/después de M4 (cambia debe ser siempre false) ==='
WITH cap AS (
  SELECT "porDefecto" FROM capacidad WHERE codigo = 'anticipos_cliente'
),
empresa_efectiva AS (
  SELECT
    c.id AS "empresaId", c.nombre, c."grupoEmpresaId",
    COALESCE(ec.habilitado, gc.habilitado, (SELECT "porDefecto" FROM cap)) AS anticipos_cliente_efectiva
  FROM cliente c
  LEFT JOIN empresa_capacidad ec ON ec."empresaId" = c.id AND ec.codigo = 'anticipos_cliente'
  LEFT JOIN grupo_empresa_capacidad gc ON gc."grupoId" = c."grupoEmpresaId" AND gc.codigo = 'anticipos_cliente'
)
SELECT
  "empresaId", nombre,
  anticipos_cliente_efectiva AS exige_anticipo_antes,
  -- después de M4: si la efectiva es false, M4 escribe la fila de empresa
  -- pago_exige_anticipo=false; si es true, no hay override (queda true por
  -- defecto del catálogo), así que el AND da el mismo valor de antes.
  (anticipos_cliente_efectiva AND (NOT (NOT anticipos_cliente_efectiva))) AS exige_anticipo_despues,
  (anticipos_cliente_efectiva IS DISTINCT FROM
     (anticipos_cliente_efectiva AND (NOT (NOT anticipos_cliente_efectiva)))) AS cambia
FROM empresa_efectiva
ORDER BY nombre;

-- ----------------------------------------------------------------------------
-- Q10 — Pagos con fechaRealPago = día siguiente al createdAt (Bogotá), ≥19:00
-- ----------------------------------------------------------------------------
-- Detecta el problema de fechas corridas del PRD (N2): un pago digitado
-- después de las 19:00 en Bogotá que terminó guardado con fecha del día
-- siguiente. Solo reporte para Camila; sin arreglo automático.
\echo '=== Q10: pagos con posible fecha corrida (creados >= 19:00 Bogotá, fechaRealPago = día siguiente) ==='
SELECT
  p.id AS pago_id, p."tramiteId", p.concepto, p.valor,
  p."createdAt" AS created_utc,
  (p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') AS created_bogota,
  p."fechaRealPago" AS fecha_real_pago,
  (date(p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') + 1) AS dia_siguiente_a_creado
FROM pago_tramite p
WHERE p."fechaRealPago" IS NOT NULL
  AND date(p."fechaRealPago") = date(p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') + 1
  AND (p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::time >= TIME '19:00'
ORDER BY p."createdAt" DESC;

-- ----------------------------------------------------------------------------
-- Q11 — Facturas de proveedor con fecha guardada con hora ≠ 00:00 UTC
-- ----------------------------------------------------------------------------
-- Solo reporte: son candidatas a mostrarse "un día antes" en pantalla si algo
-- las lee como fecha-calendario a medianoche Bogotá en vez de UTC.
\echo '=== Q11: factura_proveedor.fecha con hora distinta de 00:00 UTC ==='
SELECT
  f.id AS factura_id, f."numFactura", f."tramiteId", f.fecha,
  f.fecha::time AS hora_guardada
FROM factura_proveedor f
WHERE f.fecha::time <> TIME '00:00:00'
ORDER BY f.fecha;

-- ----------------------------------------------------------------------------
-- Q12 — Deuda (facturas sin saldo cero) en DOs ya CERRADOS
-- ----------------------------------------------------------------------------
-- Un DO cerrado no admite pagos en v2 (R10). Si ya tiene facturas con saldo
-- pendiente, hay que decidir caso por caso: solo reporte; la salida es que el
-- ADMIN reabra el DO (reapertura de emergencia existente) y pague o concilie.
-- No hay ajuste manual para esto en v2.
\echo '=== Q12: facturas con saldo pendiente (simulado) en DOs ya CERRADOS ==='
WITH base AS (
  SELECT
    ptf."pagoId", ptf."facturaId",
    p.valor AS pv, f.valor AS fv,
    SUM(f.valor) OVER (
      PARTITION BY ptf."pagoId" ORDER BY f.fecha, f."createdAt", f.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS previas
  FROM pago_tramite_factura ptf
  JOIN pago_tramite p ON p.id = ptf."pagoId"
  JOIN factura_proveedor f ON f.id = ptf."facturaId"
),
p1 AS (
  SELECT "pagoId", "facturaId", fv,
         GREATEST(0, LEAST(fv, pv - COALESCE(previas, 0))) AS prov
  FROM base
),
p2 AS (
  SELECT p1.*, p."fechaRealPago", p."createdAt" AS pago_createdAt,
         SUM(p1.prov) OVER (
           PARTITION BY p1."facturaId"
           ORDER BY p."fechaRealPago" NULLS LAST, p."createdAt", p.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ) AS antes
  FROM p1 JOIN pago_tramite p ON p.id = p1."pagoId"
),
monto_simulado AS (
  SELECT "pagoId", "facturaId",
         GREATEST(0, LEAST(prov, fv - COALESCE(antes, 0))) AS monto
  FROM p2
),
saldo_por_factura AS (
  SELECT f.id, f."numFactura", f."tramiteId", f.valor, f.estado,
         COALESCE(SUM(m.monto), 0) AS aplicado_simulado,
         f.valor - COALESCE(SUM(m.monto), 0) AS saldo_simulado
  FROM factura_proveedor f
  LEFT JOIN monto_simulado m ON m."facturaId" = f.id
  GROUP BY f.id, f."numFactura", f."tramiteId", f.valor, f.estado
)
SELECT
  t.consecutivo AS do_consecutivo, t.estado AS estado_do,
  s.id AS factura_id, s."numFactura", s.valor, s.estado AS estado_factura,
  s.aplicado_simulado, s.saldo_simulado
FROM saldo_por_factura s
JOIN tramite_do t ON t.id = s."tramiteId"
WHERE t.estado = 'CERRADO' AND s.saldo_simulado > 0
ORDER BY t.consecutivo;

-- ----------------------------------------------------------------------------
-- Q13 — Fichas de beneficiario con NIT ambiguo
-- ----------------------------------------------------------------------------
-- Cuatro rarezas que partirían la llave si no se corrigen a mano en
-- Configuración → Beneficiarios ANTES de la conciliación (D-4 del diseño):
--  (a) nit de solo dígitos con 10 cifras (¿base+DV pegado, o cédula de 10?)
--  (b) nitBase aprox. de 8 cifras (típico de "le quitaron el DV a mano")
--  (c) nitBase aprox. distinto del NIT base de su empresa (empresaId)
--  (d) pares de fichas donde una = la otra + su dígito de verificación (DIAN)
\echo '=== Q13a: fichas con NIT de solo dígitos y 10 cifras (¿base+DV pegado o cédula?) ==='
SELECT id, nombre, nit, "empresaId"
FROM beneficiario
WHERE nit ~ '^[0-9]{10}$'
ORDER BY nombre;

\echo '=== Q13b: fichas cuyo nitBase aproximado tiene 8 cifras (posible DV mal quitado) ==='
SELECT
  id, nombre, nit,
  NULLIF(ltrim(regexp_replace(COALESCE(nit, ''), '[^0-9]', '', 'g'), '0'), '') AS nitbase_aprox
FROM beneficiario
WHERE length(NULLIF(ltrim(regexp_replace(COALESCE(nit, ''), '[^0-9]', '', 'g'), '0'), '')) = 8
ORDER BY nombre;

\echo '=== Q13c: fichas cuyo nitBase (aprox.) no coincide con el NIT base de su empresa (empresaId) ==='
SELECT
  b.id AS beneficiario_id, b.nombre AS ficha_nombre, b.nit AS ficha_nit,
  c.id AS empresa_id, c.nombre AS empresa_nombre, c.nit AS empresa_nit,
  NULLIF(ltrim(regexp_replace(COALESCE(b.nit, ''), '[^0-9]', '', 'g'), '0'), '') AS ficha_nitbase_aprox,
  NULLIF(ltrim(regexp_replace(COALESCE(c.nit, ''), '[^0-9]', '', 'g'), '0'), '') AS empresa_nitbase_aprox
FROM beneficiario b
JOIN cliente c ON c.id = b."empresaId"
WHERE NULLIF(ltrim(regexp_replace(COALESCE(b.nit, ''), '[^0-9]', '', 'g'), '0'), '')
      IS DISTINCT FROM
      NULLIF(ltrim(regexp_replace(COALESCE(c.nit, ''), '[^0-9]', '', 'g'), '0'), '')
ORDER BY c.nombre;

\echo '=== Q13d: pares de fichas donde una = la otra + su dígito de verificación DIAN ==='
-- dv_de(base): algoritmo DIAN mod-11 con pesos [3,7,13,17,19,23,29,37,41,43,47,53,59,67,71]
-- (mismo que usará la función cxp_dv_nit de la migración M2).
WITH bases AS (
  SELECT id, nombre, nit,
         NULLIF(regexp_replace(COALESCE(nit, ''), '[^0-9]', '', 'g'), '') AS solo_digitos
  FROM beneficiario
),
con_dv AS (
  SELECT b.*,
    (SELECT CASE WHEN resto IN (0, 1) THEN resto ELSE 11 - resto END
     FROM (
       SELECT (sum(peso.p * digito.d)) % 11 AS resto
       FROM generate_series(1, length(b.solo_digitos)) AS gs(i)
       CROSS JOIN LATERAL (
         SELECT substr(b.solo_digitos, length(b.solo_digitos) - gs.i + 1, 1)::int AS d
       ) digito
       CROSS JOIN LATERAL (
         SELECT (ARRAY[3,7,13,17,19,23,29,37,41,43,47,53,59,67,71])[gs.i] AS p
       ) peso
     ) s
    ) AS dv
  FROM bases b
  WHERE b.solo_digitos IS NOT NULL
    AND b.solo_digitos ~ '^[0-9]{1,15}$'
    AND length(b.solo_digitos) <= 15
)
SELECT
  a.id AS ficha_base_id, a.nombre AS ficha_base_nombre, a.nit AS ficha_base_nit,
  a.solo_digitos AS ficha_base_digitos, a.dv AS dv_calculado,
  l.id AS ficha_larga_id, l.nombre AS ficha_larga_nombre, l.nit AS ficha_larga_nit
FROM con_dv a
JOIN con_dv l
  ON l.id <> a.id
 AND l.solo_digitos = a.solo_digitos || a.dv::text
ORDER BY a.nombre;

-- ----------------------------------------------------------------------------
-- Q14 — Pagos previos a Almacarga/Express sin puente a su factura
-- ----------------------------------------------------------------------------
-- Busca pagos cuyo beneficiario comparte el nitBase (aprox.) de Almacarga
-- (800154017) o Express (802011826) — DV verificados: Almacarga 8, Express 3
-- — o cuyo concepto/numSoporte contiene el número normalizado de alguna
-- factura de esos dos proveedores, y que NO tienen puente en
-- pago_tramite_factura hacia esa factura. Alimenta la categoría
-- PAGO_PREVIO_SIN_ENLAZAR de §E (conciliación, P7b).
\echo '=== Q14: pagos activos con posible relación a Almacarga/Express, sin puente a su factura ==='
WITH facturas_ae AS (
  SELECT
    f.id, f."numFactura", f."tramiteId", f.valor, f.estado, f."beneficiarioId",
    NULLIF(upper(regexp_replace(COALESCE(f."numFactura", ''), '[^A-Za-z0-9]', '', 'g')), '') AS numnorm
  FROM factura_proveedor f
  JOIN beneficiario b ON b.id = f."beneficiarioId"
  WHERE NULLIF(ltrim(regexp_replace(COALESCE(b.nit, ''), '[^0-9]', '', 'g'), '0'), '')
        IN ('800154017', '802011826')
),
pagos_por_beneficiario AS (
  SELECT DISTINCT p.id AS "pagoId", pb."beneficiario_id"
  FROM pago_tramite p
  JOIN pago_tramite_beneficiario pb ON pb.pago_id = p.id
  JOIN beneficiario b ON b.id = pb."beneficiario_id"
  WHERE NULLIF(ltrim(regexp_replace(COALESCE(b.nit, ''), '[^0-9]', '', 'g'), '0'), '')
        IN ('800154017', '802011826')
),
pagos_por_texto AS (
  SELECT DISTINCT p.id AS "pagoId", fae.id AS "facturaId_texto"
  FROM pago_tramite p
  JOIN facturas_ae fae ON (
    upper(regexp_replace(COALESCE(p.concepto, ''), '[^A-Za-z0-9]', '', 'g')) LIKE '%' || fae.numnorm || '%'
    OR upper(regexp_replace(COALESCE(p."numSoporte", ''), '[^A-Za-z0-9]', '', 'g')) LIKE '%' || fae.numnorm || '%'
  )
  WHERE fae.numnorm IS NOT NULL AND length(fae.numnorm) >= 4
),
candidatos AS (
  SELECT "pagoId" FROM pagos_por_beneficiario
  UNION
  SELECT "pagoId" FROM pagos_por_texto
)
SELECT
  p.id AS pago_id, p."tramiteId", p.concepto, p."numSoporte", p.valor,
  p."fechaRealPago", p.estado AS estado_movimiento, p."grupoPagoId",
  (SELECT array_agg(DISTINCT b2.nombre) FROM pago_tramite_beneficiario pb2
     JOIN beneficiario b2 ON b2.id = pb2."beneficiario_id" WHERE pb2.pago_id = p.id) AS beneficiarios_del_pago,
  (SELECT array_agg(fae.id || ':' || fae."numFactura")
     FROM pagos_por_texto pt
     JOIN facturas_ae fae ON fae.id = pt."facturaId_texto"
     WHERE pt."pagoId" = p.id) AS coincidencia_por_texto
FROM candidatos c
JOIN pago_tramite p ON p.id = c."pagoId"
WHERE NOT EXISTS (
  SELECT 1 FROM pago_tramite_factura ptf
  JOIN facturas_ae fae ON fae.id = ptf."facturaId"
  WHERE ptf."pagoId" = p.id
)
ORDER BY p."createdAt";

-- ----------------------------------------------------------------------------
-- Fin: nunca escribe. Revertimos siempre, incluso si todo salió bien.
-- ----------------------------------------------------------------------------
ROLLBACK;
