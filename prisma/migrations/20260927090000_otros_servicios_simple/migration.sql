-- «Otros servicios» simple (decisión de Ernesto, 26-sep-2026).
--
-- El tipo de trámite OTRO (OTR26-…, Plan Vallejo, sellos, coordinación
-- logística) no es un trámite estándar: se abre sin tarifa, se manda a
-- facturar directo (sin pasar por los estados de puerto) y se factura por
-- servicio + valor escrito a mano. Todo se gobierna por datos del tipo de
-- trámite y por la config por defecto de la capacidad `do_exige_tarifa_vigente`
-- — invariante 7 del CLAUDE.md: cero ramas por `if (codigo === "OTRO")`.

-- ─── Esquema ──────────────────────────────────────────────────────────────────

ALTER TABLE "tipo_tramite" ADD COLUMN "flujoCorto" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tramite_do" ADD COLUMN "valorServicio" BIGINT;
ALTER TABLE "tramite_do" ADD COLUMN "conceptoServicioCodigo" TEXT;

ALTER TABLE "tramite_do"
  ADD CONSTRAINT "tramite_do_conceptoServicioCodigo_fkey"
  FOREIGN KEY ("conceptoServicioCodigo") REFERENCES "concepto_venta"("codigo")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tramite_do_conceptoServicioCodigo_idx" ON "tramite_do"("conceptoServicioCodigo");

-- ─── Datos: OTRO pasa a flujo corto ──────────────────────────────────────────
-- Sin agencia, sin ETA, sin checklist (ya así); ahora además sin campos de DO
-- de agencia/cliente, sin base de cálculo del tarifario ni eventos — un
-- servicio suelto se abre y se factura, no se "opera". Solo queda la fecha
-- "Enviado a facturar": no hay declaración, levante ni salida de carga.
UPDATE "tipo_tramite"
SET
    "flujoCorto" = true,
    "usaCamposDo" = false,
    "camposBaseCalculo" = ARRAY[]::TEXT[],
    "usaEventos" = false,
    "fechasClave" = ARRAY['fechaEnviadoAFacturar']::TEXT[]
WHERE "codigo" = 'OTRO';

-- ─── Datos: tarifa vigente ya no exige OTRO ──────────────────────────────────
-- Los "Otros" se abren sin tarifa (facturan por valor escrito a mano). Por
-- defecto la regla sigue protegiendo IMPORTACION y CLASIFICACION.
UPDATE "capacidad"
SET "configPorDefecto" = '{"tiposTramite": ["IMPORTACION", "CLASIFICACION"]}'::jsonb
WHERE "codigo" = 'do_exige_tarifa_vigente';

-- Overrides por empresa/grupo que hayan copiado "OTRO" en su config también
-- lo pierden (no debería haber ninguno hoy — la única fila existente pone
-- config en NULL para SOCIO_LM — pero esto no falla si no hay filas).
UPDATE "empresa_capacidad"
SET "config" = jsonb_set("config", '{tiposTramite}', (("config" -> 'tiposTramite') - 'OTRO'))
WHERE "codigo" = 'do_exige_tarifa_vigente'
  AND "config" IS NOT NULL
  AND "config" ? 'tiposTramite'
  AND ("config" -> 'tiposTramite') ? 'OTRO';

UPDATE "grupo_empresa_capacidad"
SET "config" = jsonb_set("config", '{tiposTramite}', (("config" -> 'tiposTramite') - 'OTRO'))
WHERE "codigo" = 'do_exige_tarifa_vigente'
  AND "config" IS NOT NULL
  AND "config" ? 'tiposTramite'
  AND ("config" -> 'tiposTramite') ? 'OTRO';
