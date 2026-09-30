# PORTAR-NUMERACION.md — qué trae la numeración como Camila y qué deben portar las otras ramas

Rama `feat/numeracion-camila` (sobre `origin/master` 242da51). Decisiones de Ernesto del 30-sep-2026:
un solo contador para Barranquilla, Bogotá y Buenaventura; nacionalización, traslado y DUTA como
trámites de importación con servicio; tipo Exportación con serie `DO.EXP26` desde la 0013; nada
histórico se renumera; nunca se envía nada a Siigo. Diseño: `simulacion-camila-27sep/DISENO-NUMERACION.md`.

**Regla general:** esta rama no toca ninguna columna de dinero ni ningún cálculo del motor. Lo que
cambia es **qué tarifa se escoge** (por servicio), **con qué número nace un DO** y **qué documentos
se piden**. Una rama que toque los mismos archivos debe conservar esas tres cosas.

## Migraciones (orden) — ninguna con dinero, ninguna toca `tramite_do`

| Orden | Migración | Qué agrega |
|---|---|---|
| 1 | `20260930100000_contador_compartido` | `tipo_tramite.ciudadesContadorComun` (IMPORTACION = BAQ, BGT, BUN) y tabla `consecutivo_piso` |
| 2 | `20260930100100_servicio_tramite` | Tabla `servicio_tramite` (5 filas con la 3), `categoriaDocumento` en `plantilla_checklist_item` y `checklist_item`, conceptos TRASLADO_ZF / NACIONALIZACION_ZF / DUTA solo si faltan |
| 3 | `20260930100200_tipo_exportacion` | Concepto EXPORTACION (si falta), tipo `EXPORTACION`, su servicio y el piso `EXPORTACION:2026 = 12` |

Van después de `20260930090000_beneficiario_empresa_obligatoria`. Si otra rama agrega migraciones con
fecha posterior, no hay choque: estas son aditivas. `consecutivo_piso.ultimoNumero` es un número de
DO (INTEGER), no dinero.

## Centavos (#4)

La rama de centavos vive sin commits en `galcomex-wt-centavos` (respaldo en el stash `ba27040`) y toca
estos mismos archivos: `prisma/seed.ts`, `src/lib/tramites/service.ts`, `src/lib/tarifas/service.ts`,
`src/lib/borradores/service.ts`, `src/lib/validations/tramites.ts`, `src/lib/validations/tarifas.ts`,
`src/components/tramites/tramite-detalle.tsx`, `seccion-eventos-tramite.tsx`,
`src/components/clientes/seccion-tarifario.tsx` y `tarifas-api.ts`. Qué conservar al rebasar:

- **Dinero que pasa por lo nuevo (solo se pasa, no se calcula):**
  - `valorServicio` de un DO de Exportación (igual que un «Otros»: el valor a mano del flujo corto).
    Si #4 lo pasa a centavos, la Exportación hereda la conversión sin código nuevo.
  - `ServicioSinTarifaError` (`borradores/service.ts`) no mira montos: solo frena si
    `propuesta.servicio.claveTarifa` existe y no hay tarifa ni comisión a mano. Mantenerlo ANTES de
    caer en `params.comisionDefault`.
  - El script de datos (`servicios-tramite-datos.mjs`) compara `propuesta.resultado.total` como
    texto antes/después; con centavos la API devuelve `"300000.00"` en las dos fotos: la comparación
    sigue sirviendo.
- **Tests con pesos que #4 debe multiplicar por 100** (o leer con el formateador de centavos):
  - `src/lib/borradores/__tests__/servicio-tramite-dorados.test.ts` (13–19, 29–31: 407.000 / 472.730,
    539.000 / 626.048, 348.450, 580.750, 844.551 con 4x1000 1.051, 1.753.995, 441.370, 185.840,
    400.717, 433.000; la ReteIVA se redondea al peso).
  - `src/lib/borradores/__tests__/servicio-tramite-plata.test.ts` (22: 380.000 → 441.370, ReteIVA 10.830).
  - `src/lib/tarifas/__tests__/tramites-por-servicio.test.ts` (ítems de 240.000 / 250.000 / 300.000 / 500.000).
  - `src/app/api/tramites/__tests__/servicio-del-do.route.test.ts` (tarifas de 300.000; `valorServicio: "500000"`).
- **Conflictos de texto esperables** y cómo resolverlos:
  - `tramites/service.ts`: `createTramite` (numeración con `alcanceContador` + piso, servicio con
    `resolverServicio`, checklist por id `checklist-estandar` sin los ítems que no aplican),
    `verificarServicioDelDo` (reemplaza a `verificarServicioFlujoCorto`, que queda como alias),
    `tarifaParaDo` / `verificarTarifaVigente` (+ servicio), `transitionTramite` (D1/D2/checklist por
    servicio), `requisitosDeDo` (+ servicio, + numeración), `estadoContadores`, include del detalle
    (+ `servicios`). Quedarse con ambas cosas: la parte de dinero de #4 y la de servicio/numeración de aquí.
  - `tarifas/service.ts`: `servicioValidoDeTarifa` usa `reglaServicioDeAlcance`;
    `propuestaParaTramite` busca por `resolverServicioGuardado` y devuelve `servicio`.
  - `prisma/seed.ts`: IMPORTACION con `ciudadesContadorComun`, tipo EXPORTACION, conceptos,
    `servicio_tramite`, piso y plantilla con `categoriaDocumento`.
  - `seccion-tarifario.tsx`: `alcancesFlujoCorto` desaparece; se usa `reglaServicio(alcance)`.

## Otras ramas abiertas

- **Cualquier rama que cree DOs en tests con `createTramite` y año actual:** desde aquí la ciudad del
  grupo comparte contador y el checklist sale de `checklist-estandar` (BL, factura comercial y packing
  list requeridos). Un test que espere los ítems de su propia plantilla o que BAQ y BUN numeren aparte
  en el mismo año debe cambiar de expectativa o de año.
- **Rutas que llamen `POST /api/tramites` con `anio`:** solo ADMIN (422 `ANIO_SOLO_ADMIN`). Las cargas
  históricas por API deben ir con sesión ADMIN (ya lo hacen).
- **Quien toque `GET /api/tramites/requisitos`:** el contrato trae `servicio` y `numeracion`
  (opcionales) y acepta `&servicio=`.
- **MCP compartido (`galcomex-mcp`, no se tocó):** después de desplegar, agregar la tool
  `consecutivos_ver` (`GET /api/tramites/consecutivos`) y borrar su línea `pendiente` de
  `src/lib/mcp/paridad-excepciones.ts`. `tramite_crear` puede mandar `conceptoServicioCodigo`
  (TRASLADO_ZF, NACIONALIZACION_ZF, DUTA) en IMPORTACION y el tipo `EXPORTACION`.

## Datos (no código) — solo en la ventana y con OK de Ernesto

- `simulacion-camila-27sep/servicios-tramite-datos.mjs`: pasa las tarifas de Polyrec ZF de
  nacionalización y DUTA de «Otros» a «Trámites» con servicio, la de traslados a `TRASLADO_ZF`, pone el
  servicio a los traslados abiertos que se indiquen y el producto 007 a EXPORTACION. Probado en la
  copia local (logs `servicios-datos-copia-local-*.log`). Nunca se corrió en producción.
- Mientras no se despliegue: no crear DOs de Bogotá ni Buenaventura (darían 0278 y 0242, repetidos);
  la nacionalización y la DUTA se siguen creando como «Otros».
- Antes del primer DO real 0282 de Barranquilla: vaciar en R2 los prefijos `tramites/DO-BAQ26-0282/` …
  `0316/` que dejó el borrado de pruebas del 30-sep.
