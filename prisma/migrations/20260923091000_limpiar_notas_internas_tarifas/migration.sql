-- Limpieza de notas internas que quedaron mezcladas con notas de cliente
-- (B4/B5, 22-sep-2026). Dos casos:
--
--   1. `tarifa_item.notas` SE imprime en el PDF (nota para el cliente). Cuatro
--      ítems de las plantillas traían recordatorios internos para Camila que
--      nunca debieron salir ahí (ver `src/lib/tarifas/plantillas.ts`, ya
--      corregido para no volver a sembrarlos). Se copian byte a byte antes de
--      nulearlos; las notas legítimas de cliente (p. ej. "Valor inicial y por
--      renovación cada mes") NO se tocan.
--   2. `tarifario.notas` es SIEMPRE interna (nunca se imprime). Las que
--      arrancaban con "[PLANTILLA " las escribía `scripts/configurar-clientes-
--      reunion.ts` (ya corregido para no volver a escribirlas).

UPDATE "tarifa_item"
SET "notas" = NULL
WHERE "notas" IN (
  'La propuesta dice 20.000; en la práctica se cobran 10.000 por declaración (min 13:33). Confirmar con Camila.',
  'Cuando no sea mínimo: 30.000 por cada 5.000 caracteres (mismo valor que cobra Mincomex). Ajustar a mano.',
  'Ingreso de tercero: se cobra lo mismo que se pagó en la página (min 78:14 a 79:04).',
  'El precio del tramo aplica a todos los contenedores del trámite: 2 contenedores = 500.000, no 550.000.'
);

UPDATE "tarifario"
SET "notas" = NULL
WHERE "notas" LIKE '[PLANTILLA %';
