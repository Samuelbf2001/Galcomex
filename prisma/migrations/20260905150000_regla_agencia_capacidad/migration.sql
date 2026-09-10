-- M1 aplicado a una regla real: la "regla de Litoplas" deja de estar escrita
-- contra el nombre de la empresa.
--
-- Antes, en src/lib/tramites/service.ts:
--     if (clienteNombre.toLowerCase().includes("litoplas")) { ... }
-- Ahora es la capacidad `regla_agencia_fija` con config, y Litoplas es
-- simplemente la primera empresa que la tiene encendida.
--
-- La agencia de aduanas pasa a ser opcional en el trámite: los tipos que no la
-- piden (clasificación arancelaria) ya no tienen que inventar un valor.

ALTER TABLE "tramite_do" ALTER COLUMN "agenciaAduanas" DROP NOT NULL;

INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'regla_agencia_fija',
    'Agencia de aduanas obligatoria',
    'La empresa solo puede operar con una agencia concreta y su DO de agencia debe cumplir un formato. Reemplaza la regla que estaba escrita contra el nombre de Litoplas.',
    'Operacion', 'EMPRESA', false,
    '{"agencia": "MOVIADUANAS", "formatoDoAgencia": "^I\\d{8}$"}',
    65, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO NOTHING;

-- Backfill: encender la regla exactamente en las empresas que hoy la sufren,
-- para que el comportamiento sea idéntico al del `if` que se retira.
INSERT INTO "empresa_capacidad" ("empresaId", "codigo", "habilitado", "config", "updatedAt")
SELECT
    "id",
    'regla_agencia_fija',
    true,
    '{"agencia": "MOVIADUANAS", "formatoDoAgencia": "^I\\d{8}$", "mensajeAgencia": "Litoplas debe operar con Moviaduanas", "mensajeFormato": "Litoplas requiere DO de agencia con formato I########"}',
    CURRENT_TIMESTAMP
FROM "cliente"
WHERE LOWER("nombre") LIKE '%litoplas%'
ON CONFLICT ("empresaId", "codigo") DO NOTHING;
