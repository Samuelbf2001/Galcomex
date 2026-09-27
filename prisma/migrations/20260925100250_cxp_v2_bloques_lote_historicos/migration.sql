-- CxP v2 · M3b — Bloques de la carga histórica D0 = históricos (docs/CXP-PROVEEDORES.md)
--
-- La carga histórica de plata (lote HIST-PLATA-2026-09-23) creó pagos de
-- cartera SIN comprobante (canal supuesto PSE, sin costo) desde los Excel de
-- cartera de Almacarga y Express y les puso un grupoPagoId (UUIDv5) por fecha
-- de pago. M3 (paso 6) les creó la cabecera PagoGrupo como cualquier bloque:
-- esHistorico = false y PRIMER_DO. Así se verían «Activos» con «Anular bloque»
-- (que devolvería el saldo de facturas de DOs ya FACTURADOS) en vez de
-- «Histórico · Conciliado con el Excel». M3 no se edita (cambiaría su checksum
-- en las bases ya migradas): esta migración corrige esas cabeceras.
--
-- Un bloque se marca histórico solo si TODO se cumple:
--   · no lo creó la app: sin hashSolicitud ni claveIdempotencia (la app v2
--     siempre guarda el hash; las cabeceras de M3 y del re-avance no);
--   · cabecera ACTIVA, sin comprobante y sin costo bancario;
--   · tiene pagos y CADA pago del bloque: sin comprobante, sin costo bancario y
--     con un AuditLog del lote (entidad PagoTramite, despues._lote HIST-PLATA-…)
--     que le asignó ESE grupoPagoId (en el CREATE o en el UPDATE del lote).
-- Los bloques del mismo lote CON comprobante (facturas compartidas entre dos
-- DOs, pagadas con soporte) no cumplen y quedan como bloques normales.
--
-- Qué cambia en esos bloques (igual que un bloque histórico creado por la app,
-- `crearPagoMultiDO` con esHistorico): esHistorico = true y costoAsumidoPor =
-- GALCOMEX (el costo es 0: no cambia ningún valor). No toca pagos ni facturas.
--
-- Idempotente: una segunda corrida no encuentra bloques (ya son históricos).
-- Reversa: no hace falta (el código de e5cd35b no lee pago_grupo).
-- Re-avance: scripts/cxp/re-avance-v2.sql repite este UPDATE (paso 8b) para
-- los bloques que el código viejo haya dejado sin cabecera.
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
