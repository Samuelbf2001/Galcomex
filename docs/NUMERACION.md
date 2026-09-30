# Numeración de los DO y servicio del trámite

Decisiones de Ernesto del 30-sep-2026. Diseño completo: `simulacion-camila-27sep/DISENO-NUMERACION.md`.
Dudas abiertas para Camila: `simulacion-camila-27sep/DUDAS-DO-PARA-CAMILA.md`.

## Contadores

El número depende solo de **tipo + ciudad + año**. El servicio nunca cambia el número.

Los cinco contadores de Camila (30-sep-2026) más los de siempre:

| Contador | Clave | Formato | Ciudades |
|---|---|---|---|
| 1 · Importación compartido | `IMPORTACION:BAQ+BGT+BUN:2026` | `DO.BAQ26-0282`, `DO.BGT26-0283`, `DO.BUN26-0284` | Barranquilla, Bogotá y Buenaventura (un solo número seguido) |
| 2 · Exportación Barranquilla | `EXPORTACION:BAQ+BGT+BUN:2026` | `DO.EXP26-0013` (sin ciudad, como las carpetas de Camila) | Barranquilla; Bogotá y Buenaventura con ella (**supuesto nuestro**) |
| 3 · Importación Cartagena | `IMPORTACION:CTG:2026` | `DO.CTG26-0251` | Cartagena |
| 4 · Exportación Cartagena | `EXPORTACION:CTG:2026` | `DO.EXP.CTG26-0001` (**prefijo provisional**) | Cartagena |
| 5 · Importación Santa Marta | `IMPORTACION:SMR:2026` | `DO.SMR26-0002` | Santa Marta (duda 2 para Camila) |
| Exportación Santa Marta | `EXPORTACION:SMR:2026` | `DO.EXP.SMR26-0001` (**provisional**) | Santa Marta (**supuesto nuestro**) |
| Clasificación | `CLASIFICACION:2026` | `CLAS26-0011` | cualquiera |
| Otros servicios | `OTRO:2026` | `OTR26-0019` | cualquiera |

- Siguiente = `max(último número del contador, piso) + 1`, dentro del candado
  `pg_advisory_xact_lock(hashtext('tramite-do:{clave}'))` (el mismo para las tres ciudades del grupo).
- Configuración (columnas de `tipo_tramite`): `secuenciaPor`, `incluyeCiudadEnConsecutivo`,
  `prefijoConsecutivo`, `ciudadesContadorComun` (IMPORTACION y EXPORTACION = `{BAQ,BGT,BUN}`) y
  `prefijoConsecutivoPorCiudad` (EXPORTACION = `{"CTG": "DO.EXP.CTG", "SMR": "DO.EXP.SMR"}`). Volver a
  un contador de importación por ciudad: `ciudadesContadorComun: []` en `prisma/seed.ts` y desplegar.
  Ningún DO cambia.
- Código: `src/lib/tramites/consecutivo.ts` (puro), `createTramite` en `src/lib/tramites/service.ts`.

## Exportación por ciudad (migración `20260930120000_exportacion_por_ciudad`)

Decisión de Ernesto confirmada por María Camila el 30-sep-2026. Exportación va por ciudad y año
igual que la importación, pero su número **no** lleva la ciudad: la ciudad escoge el contador y el
prefijo (`prefijoConsecutivoPorCiudad[ciudad] ?? prefijoConsecutivo`).

- **Qué hizo la migración:** agregó `prefijoConsecutivoPorCiudad` (Json, `{}`), dejó EXPORTACION en
  `CIUDAD_ANIO` con BAQ+BGT+BUN comunes y prefijos para CTG y SMR, e insertó el piso
  `piso-exportacion-baq-bgt-bun-2026` = el mayor entre el piso viejo `EXPORTACION:2026` (12) y las
  exportaciones ya creadas de cualquier ciudad (en producción 0 → 12 → la siguiente de Barranquilla es
  `DO.EXP26-0013`). La fila vieja `EXPORTACION:2026` queda como historia: ya no la usa ningún contador.
- **Caso borde:** si antes de desplegar se creara una exportación de Cartagena, sale `DO.EXP26-00NN`
  (serie vieja). Se queda así; su número entra en el piso del grupo (Barranquilla no lo repite) y el
  contador de Cartagena sigue desde ese número, no desde 0001 (sin choques: `DO.EXP.CTG26-…`).
- **Son datos, no código:** el prefijo de Cartagena y Santa Marta y qué ciudades comparten el contador
  de exportación se cambian con un `UPDATE` (el seed solo los escribe al crear el tipo, nunca los pisa).
  Ejemplos (ventana fuera de horario, con OK de Ernesto; después, `ver-contadores.ts`):

  ```sql
  -- Camila da el formato real de Cartagena (p. ej. DO.CTGEXP26-0001):
  UPDATE tipo_tramite SET "prefijoConsecutivoPorCiudad" = '{"CTG": "DO.CTGEXP", "SMR": "DO.EXP.SMR"}'
   WHERE codigo = 'EXPORTACION';
  -- Bogotá exporta aparte de Barranquilla (necesita su propio prefijo):
  UPDATE tipo_tramite SET "ciudadesContadorComun" = ARRAY['BAQ','BUN']::"Ciudad"[],
         "prefijoConsecutivoPorCiudad" = '{"CTG": "DO.EXP.CTG", "SMR": "DO.EXP.SMR", "BGT": "DO.EXP.BGT"}'
   WHERE codigo = 'EXPORTACION';
  ```

  Ojo: si cambian las ciudades del grupo cambia la clave del contador (`EXPORTACION:BAQ+BUN:2026`) y el
  piso viejo deja de contar: volver a fijarlo con `fijar-piso.ts`. Un DO ya creado nunca cambia.
- **Defensa:** `validarConfigContador` / `problemasDeNumeracion` rechazan cualquier configuración en la
  que dos contadores distintos (del mismo tipo o de dos tipos) imprimirían el mismo número, p. ej. sin
  prefijo propio de Santa Marta (`DO.EXP26-…` como Barranquilla) o Cartagena con `DO.CTG` (el de la
  importación). Con eso `createTramite` no numera ese contador (500 `NUMERACION_MAL_CONFIGURADA`, sin
  gastar número); los demás siguen. `ver-contadores.ts` y `GET /api/tramites/consecutivos` lo muestran
  en `problema`.
- **Formulario «Crear trámite»:** en Exportación la ciudad ya no viene puesta (decide el contador) y la
  vista previa muestra «contador de exportación de Cartagena» y el número que tomará.
- **Ojo con las cargas históricas** (revisión adversarial, 30-sep-2026): el importador de Grupo E
  Papis (`POST /api/importar/grupo-e-papis`) y los scripts que escriben `tramite_do` directo
  (`scripts/historico-*`, `importar-status-lucho.ts`, `importar-borrador-lucho.ts`) ponen el número
  que traen, sin el candado y sin mirar el grupo: la base deja pasar `DO.BUN26-0282` aunque ya exista
  `DO.BAQ26-0282`. Después de cualquier carga, correr la consulta S2 del diseño (números repetidos
  del grupo; hoy solo deben salir el 0098 y el 0277).

## Pisos

Un piso dice «el último número de este contador es por lo menos N» (p. ej. Camila abrió DOs fuera de
la plataforma). Solo se insertan; la tabla `consecutivo_piso` es su propio historial.

```bash
# Ver cómo van los contadores (solo lectura)
npx tsx scripts/consecutivos/ver-contadores.ts --anio 2026

# Simulacro: qué número seguiría con el piso
npx tsx scripts/consecutivos/fijar-piso.ts --tipo IMPORTACION --anio 2026 --ciudad BGT \
  --ultimo 290 --motivo "Camila abrió hasta el DO.BGT26-0290 fuera de la plataforma"

# Aplicar (ADMIN; deja AuditLog FIJAR_PISO_CONSECUTIVO)
npx tsx scripts/consecutivos/fijar-piso.ts … --aplicar --admin camila@galcomex.com
```

- Con cualquier ciudad del grupo (BAQ, BGT o BUN) el piso es el del grupo, en Importación y en
  Exportación. Exportación pide `--ciudad` (Cartagena y Santa Marta tienen el suyo):
  `--tipo EXPORTACION --anio 2026 --ciudad CTG --ultimo 7 --motivo "…"` → `DO.EXP.CTG26-0008`.
- Rechaza un piso menor o igual a lo que el contador ya tiene, un motivo de menos de 10 caracteres y
  un tipo con la numeración mal configurada.
- La migración `20260930100200_tipo_exportacion` dejó `EXPORTACION:2026 = 12`; la `20260930120000` lo
  pasó a `EXPORTACION:BAQ+BGT+BUN:2026` (fila nueva): la siguiente de Barranquilla es la 0013 sin mover
  las 10 exportaciones históricas (siguen como OTR26).
- `GET /api/tramites/consecutivos` (ADMIN, REVISOR) muestra la misma tabla, con `problema` por fila.

## Servicio del trámite

| Tipo | Servicio | Concepto | Tarifa | No pide |
|---|---|---|---|---|
| Importación | Importación (tarifa general de la empresa) | — | la general de «Trámites» | — |
| Importación | Traslado de zona franca | `TRASLADO_ZF` | la de ese servicio | — |
| Importación | Nacionalización desde zona franca | `NACIONALIZACION_ZF` | la de ese servicio | BL |
| Importación | DUTA (tránsito aduanero) | `DUTA` | la de ese servicio | — |
| Exportación | Exportación | `EXPORTACION` | la general de «Exportación» | — |

- Un servicio sin tarifa propia **nunca** se cobra con otra tarifa ni con la comisión por defecto:
  D1 frena al crear (o al cambiar el servicio) y `generarBorrador` pide la comisión a mano (422
  `SERVICIO_SIN_TARIFA`).
- Las tarifas de «Trámites» pueden declarar servicio (vacío = la general); las de «Otros» lo exigen y
  no pueden usar los de arriba (422 `SERVICIO_RESERVADO`).
- El catálogo lo siembran la migración `20260930100100_servicio_tramite` y el seed (sin pantalla).
- Código: `src/lib/tramites/servicios.ts` (puro), `catalogo-servicios.ts`, `requisitos.ts`.

## Puesta en marcha (una sola ventana, fuera de horario)

1. Congelar la creación de DOs.
2. Tener el último número de Camila de cada contador (duda 3), incluida la exportación de Cartagena
   de 2026; cargar esos DOs o fijar un piso.
3. Desplegar (migraciones + seed; la de exportación por ciudad es `20260930120000`).
4. `simulacion-camila-27sep/servicios-tramite-datos.mjs`: simulacro, revisar, `--aplicar` con OK.
5. Verificar con `ver-contadores.ts` / `GET /api/tramites/consecutivos` y las consultas S1–S6 del diseño
   (exportación: `DO.EXP26-0013`, `DO.EXP.CTG26-0001`, `DO.EXP.SMR26-0001`, ningún `problema`).
6. Descongelar.
