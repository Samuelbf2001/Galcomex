-- Envío a Siigo sin duplicados (auditoría 25-sep-2026).
--
-- Cada POST /v1/invoices crea un documento en Siigo que, estampado, es una
-- factura electrónica ante la DIAN. Hasta ahora nada impedía que un reintento
-- (tras un timeout o un 5xx en el que Siigo SÍ alcanzó a crear la factura)
-- creara una segunda. Desde aquí el envío "reclama" el borrador con un UPDATE
-- condicional antes de llamar a Siigo, y el resultado queda en
-- `siigoEnvioEstado`:
--   ENVIANDO  llamada en curso (si pasa de 10 min se trata como INCIERTO)
--   ENVIADO   Siigo devolvió el id (siigoDraftId)
--   INCIERTO  no sabemos si Siigo la creó: bloqueado hasta que un ADMIN revise
--   ERROR     Siigo la rechazó sin crearla: se puede reintentar

CREATE TYPE "SiigoEnvioEstado" AS ENUM ('ENVIANDO', 'ENVIADO', 'INCIERTO', 'ERROR');

ALTER TABLE "borrador_factura"
  ADD COLUMN "siigoEnvioEstado" "SiigoEnvioEstado",
  ADD COLUMN "siigoEnvioIniciadoAt" TIMESTAMP(3),
  ADD COLUMN "siigoEnvioIntentoId" TEXT;

CREATE INDEX "borrador_factura_siigoEnvioEstado_idx" ON "borrador_factura"("siigoEnvioEstado");

-- ── Backfill ────────────────────────────────────────────────────────────────
-- 1. Todo borrador con id de Siigo ya está en Siigo.
UPDATE "borrador_factura"
SET "siigoEnvioEstado" = 'ENVIADO',
    "siigoEnvioIniciadoAt" = COALESCE("enviadoASiigoEn", "ultimoIntentoSiigo")
WHERE "siigoDraftId" IS NOT NULL;

-- 2. Sin id y sin facturar, pero con algún intento fallido cuyo resultado es
--    dudoso (timeout, red, 5xx, respuesta sin consecutivo…): INCIERTO. Solo es
--    definitivo (Siigo no la creó) un 400/401/403/404/422/429 del POST, un fallo
--    de autenticación o la falta de credenciales. Se mira el último error y
--    también el historial de AuditLog, porque un intento dudoso antiguo pudo
--    haber creado la factura aunque el último intento fuera un 400.
UPDATE "borrador_factura" b
SET "siigoEnvioEstado" = 'INCIERTO',
    "siigoEnvioIniciadoAt" = b."ultimoIntentoSiigo"
WHERE b."siigoDraftId" IS NULL
  AND b."estado" <> 'FACTURADO'
  AND (
    (
      b."ultimoErrorSiigo" IS NOT NULL
      AND b."ultimoErrorSiigo" !~ '^(Siigo POST /v1/invoices falló con HTTP (400|401|403|404|422|429)([^0-9]|$)|Siigo auth falló con HTTP|Variable de entorno Siigo no configurada)'
    )
    OR EXISTS (
      SELECT 1
      FROM "audit_log" a
      WHERE a."entidad" = 'BorradorFactura'
        AND a."entidadId" = b."id"
        AND a."accion" = 'SIIGO_ENVIAR_ERROR'
        AND COALESCE(a."despues"->>'error', '') !~ '^(Siigo POST /v1/invoices falló con HTTP (400|401|403|404|422|429)([^0-9]|$)|Siigo auth falló con HTTP|Variable de entorno Siigo no configurada)'
    )
  );

-- 3. Sin id, con un error definitivo y sin nada dudoso: ERROR (se puede reintentar).
UPDATE "borrador_factura"
SET "siigoEnvioEstado" = 'ERROR',
    "siigoEnvioIniciadoAt" = "ultimoIntentoSiigo"
WHERE "siigoDraftId" IS NULL
  AND "siigoEnvioEstado" IS NULL
  AND "ultimoErrorSiigo" IS NOT NULL;
