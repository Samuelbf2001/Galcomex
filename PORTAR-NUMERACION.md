# PORTAR-NUMERACION.md — qué trae la numeración como Camila y qué deben portar las otras ramas

Rama `feat/numeracion-camila` (sobre `origin/master` 242da51). Decisiones de Ernesto del 30-sep-2026:
un solo contador para Barranquilla, Bogotá y Buenaventura; nacionalización, traslado y DUTA como
trámites de importación con servicio; tipo Exportación con serie `DO.EXP26` desde la 0013; nada
histórico se renumera; nunca se envía nada a Siigo. Diseño: `simulacion-camila-27sep/DISENO-NUMERACION.md`.
Después, rama `feat/expo-por-ciudad`: Exportación por ciudad (ver la sección de abajo).

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

## Exportación por ciudad (rama `feat/expo-por-ciudad`, sobre ea1e3c0)

Decisión de Ernesto confirmada por María Camila el 30-sep-2026: **cinco contadores** — importación
BAQ+BGT+BUN juntos, exportación Barranquilla, importación Cartagena, exportación Cartagena e importación
Santa Marta. Supuestos nuestros (datos, cambiables sin programar): Bogotá y Buenaventura exportan con
Barranquilla; Santa Marta exporta con contador propio. Nada de dinero, ningún DO se renumera.

| Orden | Migración | Qué hace |
|---|---|---|
| 4 | `20260930120000_exportacion_por_ciudad` | Columna `tipo_tramite.prefijoConsecutivoPorCiudad` (Json `{}`); EXPORTACION pasa a `CIUDAD_ANIO` sin ciudad en el número, BAQ+BGT+BUN comunes, CTG → `DO.EXP.CTG`, SMR → `DO.EXP.SMR`; fila nueva de piso `EXPORTACION:BAQ+BGT+BUN:AAAA` = max(piso viejo `EXPORTACION:AAAA`, exportaciones ya creadas de cualquier ciudad). No lanza error con datos; no toca `tramite_do` |

Formatos: `DO.EXP26-0013` (Barranquilla, Bogotá, Buenaventura: exacto a las carpetas de Camila),
`DO.EXP.CTG26-0001` y `DO.EXP.SMR26-0001` (provisionales). Qué conservar al rebasar o fusionar:

- **`src/lib/tramites/consecutivo.ts`:** `formatConsecutivo` usa `raizConsecutivo` →
  `prefijoDeCiudad` (el mapa solo cuenta con `CIUDAD_ANIO`). `validarConfigContador(config, ciudades)`
  y `problemasDeNumeracion` rechazan configuraciones donde dos contadores (del mismo tipo o de dos
  tipos) imprimirían el mismo texto; un choque entre tipos frena solo esos dos contadores.
  `etiquetaContador` tiene un 4.º parámetro `nombrarTipo`.
- **`src/lib/tramites/service.ts`:** `createTramite` llama `problemaDeNumeracion(tipo, ciudad)` antes
  del candado y lanza `NumeracionMalConfiguradaError` (500, `NUMERACION_MAL_CONFIGURADA`);
  `etiquetaDelContador` (exportada, la usa `pisos.ts`); `EstadoContador.problema`. Una rama que toque
  `createTramite` debe conservar esa verificación ANTES de `alcanceContador`.
- **`prisma/seed.ts`:** `prefijoConsecutivoPorCiudad` (todos los tipos) y las `ciudadesContadorComun`
  de EXPORTACION se escriben SOLO al crear (`undefined` en el update): son datos de Camila. No volver a
  `update: tipo` a secas o el seed revertiría un cambio hecho con SQL. El piso del seed ahora es
  `piso-exportacion-baq-bgt-bun-2026` (solo si falta).
- **UI:** `TipoTramiteOption.numeroPorCiudad` (de `secuenciaPor`) decide si el formulario propone
  Barranquilla; en Exportación ya no la propone.
- **Tests que asumían Exportación por año** (ya ajustados aquí; otra rama que agregue uno debe usar
  la clave `EXPORTACION:BAQ+BGT+BUN:AAAA` y pasar la ciudad): caso 6 de
  `numeracion-compartida.integration.test.ts`, `pisos.integration.test.ts`, dorado 18 de
  `servicio-tramite-dorados.test.ts`, `GET /api/tramites/consecutivos` en
  `servicio-del-do.route.test.ts`. Nuevos: `consecutivo-exportacion-ciudad.test.ts` (puro) y
  `exportacion-por-ciudad.integration.test.ts` (años 2088–2091).
- **Centavos (#4):** no toca dinero; los conflictos esperables son de texto en `service.ts`
  (`createTramite`, sección «Numeración») y `seed.ts` (bucle de `tiposTramite`).
- **MCP (`galcomex-mcp`):** `tramite_crear` con `EXPORTACION` debe mandar la ciudad real de la
  exportación (antes daba igual cuál: ahora decide el contador); la tool pendiente `consecutivos_ver`
  verá tres filas de exportación y el campo `problema`.
- **Datos pendientes de Camila:** formato real de la exportación de Cartagena, si Bogotá y Buenaventura
  exportan con Barranquilla y el último número real de exportación de Cartagena 2026 (si ya abrió
  alguna fuera de la plataforma: fijar piso con `--tipo EXPORTACION --ciudad CTG`). Cómo cambiarlos
  con SQL: `docs/NUMERACION.md` § «Exportación por ciudad».
- **Revisión (30-sep-2026), qué conservar:**
  - `ultimoYPisoDelContador` (`service.ts`, exportada) es el ÚNICO cálculo de «último + piso»: lo usan
    `createTramite`, la vista previa, `estadoContadores` y el tope de `fijarPisoConsecutivo` (`pisos.ts`
    ya no tiene el suyo). En un tipo cuyo número no lleva la ciudad mira la serie impresa
    (`filtroDelContador`: `DO.EXP26-` de cualquier ciudad) y los pisos de claves anteriores
    (`pisoCuentaParaContador`); así, cambiar las ciudades del grupo con SQL no repite números ni pierde
    el piso 12. Importación, Clasificación y Otros: mismo resultado que antes.
  - `createTramite` revisa dentro del candado que el consecutivo no exista (`consecutivoOcupado`) y
    lanza `NumeracionMalConfiguradaError` diciendo cuál; se reintenta como un P2002 (por si lo tomó una
    carga sin candado) y solo el último intento lo deja salir. `estadoContadores` lo pone en `problema`.
  - `prisma/seed.ts` usa `numeracionParaSeed` (puro, `consecutivo.ts`): respeta ciudades comunes y
    prefijos de la base salvo que repitan números (vuelta de ea1e3c0, reversa SQL o una ciudad nueva en
    el enum), y entonces repone lo mínimo del seed que lo arregle (primero solo el prefijo de las
    ciudades que la base no nombra); si nada lo arregla, deja la base y avisa con `⚠`. Una rama que
    toque el bucle de `tiposTramite` debe conservarlo.
  - `pisoCuentaParaContador`: una ciudad que entra a un grupo trae el piso de su clave propia
    (`EXPORTACION:SMR:AAAA`), con o sin prefijo propio (2.ª ronda de revisión).
  - La migración `20260930120000` solo cambió comentarios y la descripción (sin cambio de esquema); la
    descripción de Exportación ya no nombra ciudades ni números. Reversa completa: `docs/NUMERACION.md`
    § «Volver atrás».
  - `ver-contadores.ts --json` también sale con código 2 si hay `problema`.
  - Tests nuevos: bloque «cambiar las ciudades del grupo…» y `numeracionParaSeed` en
    `consecutivo-exportacion-ciudad.test.ts`; bloque «cambiar las ciudades del grupo de exportación…»
    en `exportacion-por-ciudad.integration.test.ts` (años 2072–2078).

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
