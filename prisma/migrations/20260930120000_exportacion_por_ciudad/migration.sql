-- Exportación por ciudad (decisión de Ernesto confirmada por María Camila, 30-sep-2026).
--
-- Los cinco contadores de Camila:
--   1. Importación Barranquilla + Bogotá + Buenaventura juntos  (ya estaba: 20260930100000)
--   2. Exportación Barranquilla (+ Bogotá y Buenaventura, supuesto nuestro) → DO.EXP26-0013…
--   3. Importación Cartagena aparte                              (ya estaba)
--   4. Exportación Cartagena aparte  → DO.EXP.CTG26-0001 (prefijo PROVISIONAL, dato de Camila)
--   5. Importación Santa Marta aparte                            (ya estaba)
--   (+ Exportación Santa Marta aparte → DO.EXP.SMR26-0001, supuesto nuestro)
--
-- Qué hace (aditiva, no toca ningún DO, no lanza error aunque haya datos):
--   a) Columna tipo_tramite.prefijoConsecutivoPorCiudad (mapa ciudad → prefijo, '{}' = ninguno).
--   b) Pasa el piso del contador por año ('EXPORTACION:AAAA') al contador de
--      Barranquilla, Bogotá y Buenaventura ('EXPORTACION:BAQ+BGT+BUN:AAAA'), que
--      sigue la misma serie DO.EXPAA. El piso nuevo es el MAYOR entre el piso
--      anterior y los números de exportación ya creados de CUALQUIER ciudad: todos
--      se imprimieron DO.EXPAA-NNNN, así que el grupo no puede volver a darlos.
--      Los pisos solo se insertan (la tabla es su propio historial): la fila
--      'piso-exportacion-2026' queda como historia (el código la sigue contando
--      para la serie DO.EXPAA: pisoCuentaParaContador).
--   c) EXPORTACION pasa a contador por ciudad y año, sin ciudad en el número,
--      con BAQ+BGT+BUN compartidos y prefijo propio para CTG y SMR.
--
-- Producción hoy: 0 DOs de tipo EXPORTACION (las 10 exportaciones históricas son
-- OTR26 de tipo OTRO y no se tocan) y piso 12 → la siguiente de Barranquilla es
-- DO.EXP26-0013. Si ya hubiera exportaciones de Cartagena o Santa Marta creadas
-- con DO.EXP26-NNNN, se quedan como están: su número entra en el piso del grupo
-- (Barranquilla no lo repite) y el contador propio de esa ciudad sigue desde su
-- número más alto, no desde 0001 (sin choques: imprime DO.EXP.CTG26-…).
--
-- El prefijo de Cartagena y Santa Marta y qué ciudades comparten contador son
-- DATOS (dudas de Camila): se cambian con UPDATE, sin programar, y el seed no
-- los pisa. createTramite no numera si dos contadores pudieran imprimir el mismo
-- número (validarConfigContador / problemasDeNumeracion).
--
-- Reversa (sin mover ningún DO; SQL completo en docs/NUMERACION.md, «Volver atrás»):
--   1. En la misma ventana, ANTES de arrancar la imagen anterior (ea1e3c0), insertar
--      un piso 'EXPORTACION:AAAA' con el mayor entre TODOS los pisos de exportación
--      del año y los números de sus DOs. El contador por año de esa imagen solo mira
--      esa clave: sin esto vuelve a dar números que se fijaron después en
--      'EXPORTACION:BAQ+BGT+BUN:AAAA' (carpetas de Camila).
--   2. La columna y el mapa pueden quedarse: el código anterior no los lee y su seed
--      deja EXPORTACION en ANIO con ciudades comunes [].
--   3. Volver a esta versión: el seed repone las ciudades comunes (y los prefijos,
--      si hace falta) cuando lo que hay en la base repetiría números, y el contador
--      del grupo cuenta el piso 'EXPORTACION:AAAA' y los DO.EXPAA-… creados en el
--      intermedio, de cualquier ciudad. No hace falta SQL a mano.

ALTER TABLE "tipo_tramite"
  ADD COLUMN IF NOT EXISTS "prefijoConsecutivoPorCiudad" JSONB NOT NULL DEFAULT '{}';

INSERT INTO "consecutivo_piso" ("id","clave","tipoTramiteCodigo","anio","ultimoNumero","motivo")
SELECT
  'piso-exportacion-baq-bgt-bun-' || s."anio"::text,
  'EXPORTACION:BAQ+BGT+BUN:' || s."anio"::text,
  'EXPORTACION',
  s."anio",
  s."ultimo",
  'Viene del contador de exportación por año (EXPORTACION:' || s."anio"::text || '), partido por ciudad el 30-sep-2026 '
    || '(migración 20260930120000, decisión de Ernesto confirmada por Camila): Barranquilla, Bogotá y Buenaventura '
    || 'siguen la serie DO.EXP' || RIGHT(s."anio"::text, 2) || '. Es el mayor entre el piso anterior y los números de '
    || 'exportación ya creados de cualquier ciudad, para no repetir ninguno. Cartagena y Santa Marta llevan su propio contador.'
FROM (
  SELECT u."anio", MAX(u."n") AS "ultimo"
  FROM (
    SELECT p."anio", p."ultimoNumero" AS "n"
      FROM "consecutivo_piso" p
     WHERE p."tipoTramiteCodigo" = 'EXPORTACION'
       AND p."anio" IS NOT NULL
       AND p."clave" = 'EXPORTACION:' || p."anio"::text
    UNION ALL
    SELECT d."anio", d."numero"
      FROM "tramite_do" d
     WHERE d."tipoTramiteCodigo" = 'EXPORTACION'
  ) u
  GROUP BY u."anio"
) s
WHERE s."ultimo" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "tipo_tramite"
   SET "secuenciaPor"                = 'CIUDAD_ANIO',
       "incluyeCiudadEnConsecutivo"  = false,
       "prefijoConsecutivo"          = 'DO.EXP',
       "ciudadesContadorComun"       = ARRAY['BAQ','BGT','BUN']::"Ciudad"[],
       "prefijoConsecutivoPorCiudad" = '{"CTG": "DO.EXP.CTG", "SMR": "DO.EXP.SMR"}'::jsonb,
       "descripcion"                 = 'Exportaciones de todos los clientes. La ciudad decide el contador; el número que tomará se ve al escogerla. Se abre sin pagos a proveedores y se manda a facturar directo, con la tarifa de exportación de la empresa o con el valor escrito a mano.',
       "updatedAt"                   = CURRENT_TIMESTAMP
 WHERE "codigo" = 'EXPORTACION';
