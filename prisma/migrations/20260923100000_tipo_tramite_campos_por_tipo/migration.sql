-- Revisión de Ernesto (22-sep-2026, tanda 2): la clasificación arancelaria no
-- tiene DO de agencia/cliente, ni usa toda la base de cálculo del tarifario,
-- ni eventos. Comportamiento por TIPO de trámite, siempre como dato
-- (invariante 7 del CLAUDE.md: cero ramas por `if (codigo === "CLASIFICACION")`).

ALTER TABLE "tipo_tramite" ADD COLUMN "usaCamposDo" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "tipo_tramite" ADD COLUMN "camposBaseCalculo" TEXT[] NOT NULL DEFAULT ARRAY[
    'valorCif', 'tipoCarga', 'numContenedores', 'numDeclaraciones', 'numDocumentos', 'numItems'
]::TEXT[];

ALTER TABLE "tipo_tramite" ADD COLUMN "usaEventos" BOOLEAN NOT NULL DEFAULT true;

-- CLASIFICACION: sin DO agencia/cliente, la tarifa solo cuenta ítems
-- clasificados y no usa eventos. IMPORTACION y OTRO se quedan en el default
-- (todo encendido, como siempre) — el UPDATE es explícito solo para
-- CLASIFICACION.
UPDATE "tipo_tramite"
SET
    "usaCamposDo" = false,
    "camposBaseCalculo" = ARRAY['numItems']::TEXT[],
    "usaEventos" = false
WHERE "codigo" = 'CLASIFICACION';
