-- CxP v2 · M3 — Backfill, restricciones y triggers (docs/CXP-PROVEEDORES.md)
--
-- Reglas: (1) aditiva; (2) NO puede fallar con datos reales: sin RAISE, todo
-- con GREATEST/LEAST/COALESCE; (3) no cambia ningún estado visible: una factura
-- PAGADA cuyos pagos no alcanzan su valor recibe un ajuste LEGADO (visible y
-- reversible por ADMIN) en vez de volver a quedar pendiente.
--
-- Los guardianes de saldo (paso 9) se crean y quedan DISABLE: los enciende M5
-- (`20260925100400_cxp_v2_guardian`, paquete P1) junto con el dominio que los
-- respeta. Los triggers de llaves (paso 8) y el índice único (paso 7) sí quedan
-- activos desde aquí.

-- ─── 1. Llaves derivadas ─────────────────────────────────────────────────────
UPDATE "beneficiario" SET "nitBase" = cxp_nit_base("nit");

UPDATE "factura_proveedor" SET "numFacturaNormalizado" = cxp_normalizar_num("numFactura");

-- La más antigua de cada (proveedor, número) conserva la llave; las repetidas
-- quedan con proveedorClave NULL = "duplicado heredado, revisar" (reporte P7).
WITH c AS (
  SELECT id,
         cxp_clave_proveedor("beneficiarioId") AS clave,
         row_number() OVER (
           PARTITION BY cxp_clave_proveedor("beneficiarioId"), "numFacturaNormalizado"
           ORDER BY "createdAt", id
         ) AS n
  FROM "factura_proveedor"
  WHERE "beneficiarioId" IS NOT NULL AND "numFacturaNormalizado" IS NOT NULL
)
UPDATE "factura_proveedor" f
SET "proveedorClave" = c.clave
FROM c
WHERE f.id = c.id AND c.n = 1;

-- ─── 2. Monto del puente pago ↔ factura (determinista, nunca sobre-aplica) ───
-- Pasada 0: enlaces de pagos en bloque → monto propuesto = el que registró el
--   AuditLog del bloque (FacturaProveedor / UPDATE_ESTADO / tramiteId del pago,
--   antes->>'montoPagadoEnGrupo'), el más cercano en el tiempo al pago, con
--   tope en el valor de la factura. Si no hay AuditLog: el valor de la factura.
-- Pasada 1: cada pago reparte su valor entre sus facturas en orden
--   (NO SE COBRA primero, fecha, createdAt, id) con tope acumulado = valor
--   del pago. La asesoría (repercutible = false) va primero, como la regla de
--   Ascinter («primero lo no cobrable»): en un pago mixto que no alcanza para
--   todas sus facturas, lo que falta queda en lo que SÍ se cobra y nunca se le
--   cobra asesoría al cliente. `pagos-cobrables` además trata estos montos de
--   pagos mixtos heredados como estimados (heurística + marca por revisar).
-- Pasada 2: cada factura acepta pagos en orden (fechaRealPago NULLS LAST,
--   createdAt, id) con tope acumulado = valor de la factura.
-- Tope secuencial ≡ GREATEST(0, LEAST(propuesto, tope − Σ propuestos previos)).
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
  ORDER BY ptf."pagoId", ptf."facturaId",
           abs(extract(epoch FROM (a."createdAt" - p."createdAt"))), a."createdAt" DESC, a.id DESC
),
base AS (
  SELECT ptf."pagoId", ptf."facturaId", p.valor AS pv, f.valor AS fv,
         f.repercutible AS frep, f.fecha AS ffecha, f."createdAt" AS fcreado,
         GREATEST(0, LEAST(COALESCE(au.monto, f.valor), f.valor)) AS p0
  FROM "pago_tramite_factura" ptf
  JOIN "pago_tramite" p ON p.id = ptf."pagoId"
  JOIN "factura_proveedor" f ON f.id = ptf."facturaId"
  LEFT JOIN audit au ON au."pagoId" = ptf."pagoId" AND au."facturaId" = ptf."facturaId"
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
WHERE t."pagoId" = p2."pagoId" AND t."facturaId" = p2."facturaId";

-- Red de seguridad (no debería quedar ninguno: todo enlace pasa por el UPDATE de arriba).
UPDATE "pago_tramite_factura" SET "monto" = 0 WHERE "monto" IS NULL;

ALTER TABLE "pago_tramite_factura" ALTER COLUMN "monto" SET NOT NULL;
ALTER TABLE "pago_tramite_factura" ADD CONSTRAINT "pago_tramite_factura_monto_ck" CHECK ("monto" >= 0);

-- ─── 2b. Pagos con facturas y sin beneficiario → el de su factura ────────────
-- (generarPagoDesdeFactura no creaba PagoTramiteBeneficiario; el libro admite
-- beneficiarioIds vacío.) Así el filtro por proveedor de /pagos y "Pagos
-- realizados" los ven.
INSERT INTO "pago_tramite_beneficiario" ("pago_id", "beneficiario_id")
SELECT DISTINCT ptf."pagoId", f."beneficiarioId"
FROM "pago_tramite_factura" ptf
JOIN "factura_proveedor" f ON f.id = ptf."facturaId"
WHERE f."beneficiarioId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "pago_tramite_beneficiario" pb WHERE pb."pago_id" = ptf."pagoId")
ON CONFLICT DO NOTHING;

-- ─── 3. Cruce de cuenta corriente (hoy siempre por el total) ─────────────────
UPDATE "factura_proveedor" f
SET "montoCompensado" = GREATEST(0, f.valor - COALESCE(
      (SELECT SUM(x."monto") FROM "pago_tramite_factura" x WHERE x."facturaId" = f.id), 0))
WHERE f."compensacionId" IS NOT NULL;

-- ─── 4. No cambiar el estado visible: pagada con faltante → ajuste LEGADO ────
-- FACTURADA_CLIENTE (0 filas en prod) se trata como pagada: nunca se vuelve pagable.
INSERT INTO "ajuste_factura_proveedor" ("id", "facturaId", "tipo", "monto", "motivo", "usuarioId", "createdAt")
SELECT 'mig-cxp-v2-' || f.id, f.id, 'LEGADO', s.faltante,
       'Migración CxP v2: estaba marcada pagada con pagos por ' || s.aplicado || ' de ' || f.valor
         || '. Revisar con el extracto.',
       NULL, CURRENT_TIMESTAMP
FROM "factura_proveedor" f
JOIN LATERAL (
  SELECT COALESCE(SUM(x."monto"), 0) AS aplicado,
         f.valor - COALESCE(SUM(x."monto"), 0) - f."montoCompensado" AS faltante
  FROM "pago_tramite_factura" x
  WHERE x."facturaId" = f.id
) s ON true
WHERE f.estado IN ('PAGADA', 'FACTURADA_CLIENTE') AND s.faltante > 0
ON CONFLICT ("id") DO NOTHING;

-- ─── 5. Estado derivado del saldo ────────────────────────────────────────────
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
WHERE f.id = t.id;

-- ─── 6. Cabeceras de los bloques existentes (costo como hoy = PRIMER_DO) ─────
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
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "pago_tramite" ADD CONSTRAINT "pago_tramite_grupoPagoId_fkey"
  FOREIGN KEY ("grupoPagoId") REFERENCES "pago_grupo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 7. Unicidad (proveedor, número). Los duplicados heredados tienen clave NULL → no chocan ──
CREATE UNIQUE INDEX "factura_proveedor_proveedorClave_numFacturaNormalizado_key"
  ON "factura_proveedor"("proveedorClave", "numFacturaNormalizado");

-- ─── 8. Triggers de llaves (activos) ─────────────────────────────────────────

-- 8a. Beneficiario: nitBase siempre derivado de nit.
CREATE OR REPLACE FUNCTION cxp_trg_beneficiario_nit_base() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."nitBase" := cxp_nit_base(NEW."nit");
  RETURN NEW;
END $$;

CREATE TRIGGER trg_beneficiario_nit_base
  BEFORE INSERT OR UPDATE OF "nit" ON "beneficiario"
  FOR EACH ROW EXECUTE FUNCTION cxp_trg_beneficiario_nit_base();

-- 8b. Factura: número normalizado y clave de proveedor. En UPDATE solo recalcula
-- si cambió de verdad el número o la ficha (la pantalla manda ambos campos en
-- cada PATCH): así un duplicado heredado (clave NULL) no recupera la clave al
-- editar solo el concepto.
CREATE OR REPLACE FUNCTION cxp_trg_factura_proveedor_claves() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."numFactura" IS DISTINCT FROM OLD."numFactura"
     OR NEW."beneficiarioId" IS DISTINCT FROM OLD."beneficiarioId" THEN
    NEW."numFacturaNormalizado" := cxp_normalizar_num(NEW."numFactura");
    NEW."proveedorClave" := CASE
      WHEN NEW."beneficiarioId" IS NULL THEN NULL
      ELSE cxp_clave_proveedor(NEW."beneficiarioId")
    END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_factura_proveedor_claves
  BEFORE INSERT OR UPDATE OF "numFactura", "beneficiarioId" ON "factura_proveedor"
  FOR EACH ROW EXECUTE FUNCTION cxp_trg_factura_proveedor_claves();

-- 8c. Si cambia el NIT base de una ficha, sus facturas cambian de clave (salvo
-- los duplicados heredados, que siguen en NULL). Si choca con otra factura del
-- mismo proveedor, la edición del NIT falla por la unicidad (P2 lo traduce).
CREATE OR REPLACE FUNCTION cxp_trg_beneficiario_reclave() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "factura_proveedor"
  SET "proveedorClave" = CASE WHEN NEW."nitBase" IS NOT NULL THEN 'NIT:' || NEW."nitBase" ELSE 'BEN:' || NEW."id" END
  WHERE "beneficiarioId" = NEW."id" AND "proveedorClave" IS NOT NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_beneficiario_reclave
  AFTER UPDATE OF "nit" ON "beneficiario"
  FOR EACH ROW
  WHEN (NEW."nitBase" IS DISTINCT FROM OLD."nitBase")
  EXECUTE FUNCTION cxp_trg_beneficiario_reclave();

-- ─── 9. Guardián de saldo (defensa en profundidad; se crea APAGADO) ──────────
-- aplicado (Σ puente) + ajustes + compensado nunca puede superar el valor.
-- Bloquea la fila de la factura (FOR UPDATE) antes de sumar.
CREATE OR REPLACE FUNCTION cxp_verificar_saldo(fid text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v bigint; c bigint; a bigint; j bigint;
BEGIN
  SELECT f.valor, f."montoCompensado" INTO v, c
  FROM "factura_proveedor" f WHERE f.id = fid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(SUM(x."monto"), 0) INTO a FROM "pago_tramite_factura" x WHERE x."facturaId" = fid;
  SELECT COALESCE(SUM(y."monto"), 0) INTO j FROM "ajuste_factura_proveedor" y WHERE y."facturaId" = fid;
  IF a + j + c > v THEN
    RAISE EXCEPTION 'CXP_SOBREAPLICACION: factura % valor % aplicado % ajustes % compensado %', fid, v, a, j, c
      USING ERRCODE = 'P0001';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cxp_trg_verificar_saldo_factura_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cxp_verificar_saldo(NEW."facturaId");
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION cxp_trg_verificar_saldo_factura() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cxp_verificar_saldo(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_pago_factura_saldo
  AFTER INSERT OR UPDATE ON "pago_tramite_factura"
  NOT DEFERRABLE
  FOR EACH ROW EXECUTE FUNCTION cxp_trg_verificar_saldo_factura_id();

CREATE CONSTRAINT TRIGGER trg_ajuste_saldo
  AFTER INSERT OR UPDATE ON "ajuste_factura_proveedor"
  NOT DEFERRABLE
  FOR EACH ROW EXECUTE FUNCTION cxp_trg_verificar_saldo_factura_id();

CREATE CONSTRAINT TRIGGER trg_factura_valor_saldo
  AFTER UPDATE OF "valor", "montoCompensado" ON "factura_proveedor"
  NOT DEFERRABLE
  FOR EACH ROW EXECUTE FUNCTION cxp_trg_verificar_saldo_factura();

-- Apagados hasta M5 (P1): el código de e5cd35b permite doble pago por diseño y
-- sus pruebas (it.fails) lo documentan; el guardián se enciende junto con el
-- dominio que lo respeta.
ALTER TABLE "pago_tramite_factura" DISABLE TRIGGER trg_pago_factura_saldo;
ALTER TABLE "ajuste_factura_proveedor" DISABLE TRIGGER trg_ajuste_saldo;
ALTER TABLE "factura_proveedor" DISABLE TRIGGER trg_factura_valor_saldo;
