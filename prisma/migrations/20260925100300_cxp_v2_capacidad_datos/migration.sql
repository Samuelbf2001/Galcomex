-- CxP v2 · M4 — Capacidad "Sin anticipo no hay pago" y datos iniciales de fichas
-- (docs/CXP-PROVEEDORES.md). Solo datos: no cambia el esquema.

-- ─── Capacidad pago_exige_anticipo (espejo de src/lib/capacidades/catalogo.ts) ──
-- El seed vuelve a sincronizar textos y valores por defecto en cada arranque.
INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'pago_exige_anticipo',
    'Sin anticipo no hay pago',
    'No deja registrar pagos a terceros (ni pagarlos en bloque) desde un DO de esta empresa si el DO no tiene un anticipo aplicado. No aplica a costos propios que no se le cobran al cliente. Apágala si Galcomex paga con su plata y luego lo cobra (por ejemplo, el almacenaje de Almacarga cuando Litoplas aún no ha girado el fondo).',
    'Cartera', 'EMPRESA', true,
    NULL,
    12, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO NOTHING;

-- Comportamiento idéntico el día 1. Regla efectiva nueva:
--     exigeAnticipo = anticipos_cliente && pago_exige_anticipo
-- No se copian filas: se calcula la capacidad EFECTIVA de anticipos_cliente de
-- cada empresa (empresa → grupo → defecto del catálogo; `activa = false` la
-- apaga) y se escribe una fila de EMPRESA pago_exige_anticipo = false donde la
-- efectiva es false. Una empresa con anticipos_cliente = true propio y grupo en
-- false sigue exigiendo anticipo.
INSERT INTO "empresa_capacidad" ("empresaId", "codigo", "habilitado", "config", "updatedAt")
SELECT c."id", 'pago_exige_anticipo', false, NULL, CURRENT_TIMESTAMP
FROM "cliente" c
LEFT JOIN "empresa_capacidad" ec
       ON ec."empresaId" = c."id" AND ec."codigo" = 'anticipos_cliente'
LEFT JOIN "grupo_empresa_capacidad" gc
       ON gc."grupoId" = c."grupoEmpresaId" AND gc."codigo" = 'anticipos_cliente'
LEFT JOIN "capacidad" cap
       ON cap."codigo" = 'anticipos_cliente'
WHERE NOT (
        COALESCE(ec."habilitado", gc."habilitado", cap."porDefecto", true)
    AND COALESCE(cap."activa", true)
)
ON CONFLICT ("empresaId", "codigo") DO NOTHING;

-- ─── Datos iniciales de fichas de pago (por nitBase; sin efecto donde no existan) ──
-- Almacarga y Express: nombre corto, N° "FE 11298" y cartera pendiente de
-- conciliar con el Excel de Camila (RF-23; el script de conciliación P7 lo apaga).
UPDATE "beneficiario"
SET "nombreCorto" = COALESCE("nombreCorto", 'ALMACARGA'),
    "numFacturaConEspacio" = true,
    "conciliacionPendiente" = true
WHERE "nitBase" = '800154017';

UPDATE "beneficiario"
SET "nombreCorto" = COALESCE("nombreCorto", 'EXPRESS'),
    "numFacturaConEspacio" = true,
    "conciliacionPendiente" = true
WHERE "nitBase" = '802011826';

UPDATE "beneficiario"
SET "nombreCorto" = COALESCE("nombreCorto", 'TAMPA CARGO')
WHERE "nitBase" = '890912462';
