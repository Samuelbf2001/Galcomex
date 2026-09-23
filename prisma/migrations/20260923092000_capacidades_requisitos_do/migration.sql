-- Requisitos para abrir y avanzar un DO (revisión de Ernesto, 22-sep-2026).
-- Las dos reglas son capacidades por empresa (invariante 7 del CLAUDE.md: cero
-- ramas por tipo de cliente). Espejo de src/lib/capacidades/catalogo.ts; el
-- seed vuelve a sincronizar textos y valores por defecto en cada arranque.
--
-- Solo datos: no cambia el esquema.

-- ─── D1 · DO solo con tarifa vigente ─────────────────────────────────────────
-- Encendida por defecto: toda empresa nueva de Galcomex queda cubierta sin
-- que nadie se acuerde de activarla. Una empresa nueva del socio choca con un
-- aviso claro y se apaga en su ficha (preferible a abrir DOs sin tarifa en
-- silencio).
INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'do_exige_tarifa_vigente',
    'DO solo con tarifa vigente',
    'No deja crear un DO si la empresa no tiene una tarifa vigente para esa línea de servicio. Las solicitudes que llegan de afuera sí entran, pero no se pueden abrir hasta que la tarifa esté publicada.',
    'Comercial', 'EMPRESA', true,
    '{"tiposTramite": ["IMPORTACION", "CLASIFICACION", "OTRO"]}',
    25, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO NOTHING;

-- Los clientes del socio Luis Martínez se facturan por comisión y no llevan
-- tarifa: la regla queda apagada para ellos. Se elige por `tipo` solo aquí, en
-- la carga de datos; el código nunca pregunta por el tipo. Una empresa del
-- socio creada después hereda el defecto (encendida) y se apaga en su ficha.
INSERT INTO "empresa_capacidad" ("empresaId", "codigo", "habilitado", "config", "updatedAt")
SELECT "id", 'do_exige_tarifa_vigente', false, NULL, CURRENT_TIMESTAMP
FROM "cliente"
WHERE "tipo" = 'SOCIO_LM'
ON CONFLICT ("empresaId", "codigo") DO NOTHING;

-- ─── D2 · BL y factura comercial obligatorios ────────────────────────────────
-- Pasa a estar encendida por defecto para todas las empresas y se configura
-- por tipo de trámite (por defecto solo importación: la clasificación y los
-- otros servicios no tienen BL). Las filas propias que ya existen (Litoplas,
-- PRUEBA SOCIO) se conservan tal cual: siguen encendidas y heredan la config.
-- No se toca `activa` (interruptor de emergencia del ADMIN).
INSERT INTO "capacidad" (
    "codigo", "nombre", "descripcion", "grupo", "ambito", "porDefecto",
    "configPorDefecto", "orden", "activa", "updatedAt"
) VALUES (
    'docs_bl_factura_obligatorios',
    'BL y factura comercial obligatorios',
    'Al crear el DO se piden el BL (o guía) y la factura comercial, y el DO no pasa de Apertura a En trámite si no están adjuntos. Aplica solo a los tipos de trámite marcados.',
    'Documentos', 'EMPRESA', true,
    '{"tiposTramite": ["IMPORTACION"]}',
    120, true, CURRENT_TIMESTAMP
)
ON CONFLICT ("codigo") DO UPDATE SET
    "nombre" = EXCLUDED."nombre",
    "descripcion" = EXCLUDED."descripcion",
    "porDefecto" = EXCLUDED."porDefecto",
    "configPorDefecto" = EXCLUDED."configPorDefecto",
    "updatedAt" = CURRENT_TIMESTAMP;
