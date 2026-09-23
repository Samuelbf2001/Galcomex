-- Revisión de Ernesto (22-sep-2026, tanda 2): en CLASIFICACION las "Fechas
-- clave" del DO no aplican todas — esas fechas (aceptación de declaración,
-- levante, salida de carga) solo existen para trámites de importación
-- reales. Comportamiento por TIPO de trámite, siempre como dato (invariante
-- 7 del CLAUDE.md: cero ramas por `if (codigo === "CLASIFICACION")`).

ALTER TABLE "tipo_tramite" ADD COLUMN "fechasClave" TEXT[] NOT NULL DEFAULT ARRAY[
    'fechaAceptacionDeclaracion', 'fechaLevante', 'fechaEnviadoAFacturar', 'fechaDocumentosOk', 'fechaSalidaCarga'
]::TEXT[];

-- CLASIFICACION: solo "Documentos OK" y "Enviado a facturar" (fechas de
-- importación real ocultas). IMPORTACION y OTRO se quedan en el default
-- (las cinco, como siempre) — el UPDATE es explícito solo para
-- CLASIFICACION.
UPDATE "tipo_tramite"
SET "fechasClave" = ARRAY['fechaDocumentosOk','fechaEnviadoAFacturar']::TEXT[]
WHERE "codigo" = 'CLASIFICACION';
