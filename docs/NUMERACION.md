# Numeración de los DO y servicio del trámite

Decisiones de Ernesto del 30-sep-2026. Diseño completo: `simulacion-camila-27sep/DISENO-NUMERACION.md`.
Dudas abiertas para Camila: `simulacion-camila-27sep/DUDAS-DO-PARA-CAMILA.md`.

## Contadores

El número depende solo de **tipo + ciudad + año**. El servicio nunca cambia el número.

| Contador | Clave | Formato | Ciudades |
|---|---|---|---|
| Importación compartido | `IMPORTACION:BAQ+BGT+BUN:2026` | `DO.BAQ26-0282`, `DO.BGT26-0283`, `DO.BUN26-0284` | Barranquilla, Bogotá y Buenaventura (un solo número seguido) |
| Importación Cartagena | `IMPORTACION:CTG:2026` | `DO.CTG26-0251` | Cartagena |
| Importación Santa Marta | `IMPORTACION:SMR:2026` | `DO.SMR26-0002` | Santa Marta (duda 2 para Camila) |
| Exportación | `EXPORTACION:2026` | `DO.EXP26-0013` | cualquiera (no sale en el número) |
| Clasificación | `CLASIFICACION:2026` | `CLAS26-0011` | cualquiera |
| Otros servicios | `OTRO:2026` | `OTR26-0019` | cualquiera |

- Siguiente = `max(último número del contador, piso) + 1`, dentro del candado
  `pg_advisory_xact_lock(hashtext('tramite-do:{clave}'))` (el mismo para las tres ciudades del grupo).
- Configuración: `tipo_tramite.ciudadesContadorComun` (IMPORTACION = `{BAQ,BGT,BUN}`). Volver a un
  contador por ciudad: `ciudadesContadorComun: []` en `prisma/seed.ts` y desplegar. Ningún DO cambia.
- Código: `src/lib/tramites/consecutivo.ts` (puro), `createTramite` en `src/lib/tramites/service.ts`.

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

- Con cualquier ciudad del grupo (BAQ, BGT o BUN) el piso es el del grupo.
- Rechaza un piso menor o igual a lo que el contador ya tiene y un motivo de menos de 10 caracteres.
- La migración `20260930100200_tipo_exportacion` deja `EXPORTACION:2026 = 12`: la siguiente es la 0013
  sin mover las 10 exportaciones históricas (siguen como OTR26).
- `GET /api/tramites/consecutivos` (ADMIN, REVISOR) muestra la misma tabla.

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
2. Tener el último número de Camila de cada contador (duda 3); cargar esos DOs o fijar un piso.
3. Desplegar (3 migraciones + seed).
4. `simulacion-camila-27sep/servicios-tramite-datos.mjs`: simulacro, revisar, `--aplicar` con OK.
5. Verificar con `ver-contadores.ts` / `GET /api/tramites/consecutivos` y las consultas S1–S6 del diseño.
6. Descongelar.
