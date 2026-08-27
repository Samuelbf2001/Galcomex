# Pendientes — Galcomex

> Registro vivo de lo que quedó **fuera de scope** o **diferido** al cierre de Sprint 11 (2026-06-25, entrega final flujo Lucho/SOCIO_LM). Cada item indica origen, decisión y siguiente acción cuando aplique.

---

## H. Ola 1 — Sprint orquestado 2026-08-25 (5 subagentes en paralelo) ✅ CERRADA

Gates de integración: `tsc` limpio · **335/336 tests** (único rojo = C2, decisión de negocio abierta) · lint 11 errores `react-hooks/set-state-in-effect` (10 pre-existentes + 1 nuevo en `tramites-workspace.tsx:93` que sigue el mismo patrón de la casa — deuda conocida, sanear todos juntos).

### H0. Reparación de línea base (pre-ola)
La BD local :5433 tenía la migración `20260619154718_npm_run_db_seed` FALLIDA a medio aplicar (rename destructivo `pago_id→pagoId` etc. que revienta con datos; en prod pasó porque la tabla estaba vacía) y 8 migraciones sin aplicar → 48 tests rojos. Fix: renames manuales preservando datos vía psql (`docker exec -i`), `migrate resolve --applied`, `migrate deploy` del resto. `migrate status` = up to date (27 migraciones).

### H1. Seguridad y auditoría (agente 1)
- **Rate limiting login** (cierra parte de G5): `src/lib/http/rate-limit.ts` nuevo — 5 intentos fallidos por IP+email / 15 min → 429 en español; éxito limpia contador. In-memory por proceso (suficiente single-instance). 9 tests.
- **AuditLog anticipos** (cierra G3): el hueco real era `usuarioId` OPCIONAL con audit condicional. Ahora obligatorio en `crearAnticipo`/`aplicarAnticipo`/`eliminarAplicacion`, audit SIEMPRE en la misma tx. Ídem `beneficiarios` crear/actualizar. Callers actualizados (tests + `scripts/importar-borrador-lucho.ts`).
- **Tests regresión IDOR** (cierra el pendiente de G1): `src/app/api/__tests__/idor-regresion.test.ts` — 9 tests, SOCIO recibe 403/404 en los 4 endpoints corregidos, incl. documento de otro trámite.
- G2 (open redirect) y C1 (test Excel portable) ya estaban resueltos en el código — verificados, sin cambios.

### H2. Filtros de trámites (agente 2) — pedido reunión 1-jul
- `listTramites(query, options)` nuevo en `src/lib/tramites/service.ts` centraliza el where; GET `/api/tramites` acepta `q` (número DO), `estado`, `ciudad`, `clienteId`, `tipoCliente` (PROPIO|SOCIO_LM), `facturado` (true/false).
- **Criterio "facturado"**: `estado ∈ {FACTURADO, PAGADO, CERRADO}` OR existe `BorradorFactura` en estado FACTURADO (la transición manual de estado y la factura real pueden desincronizarse — se cubren ambas).
- Scoping SOCIO se agrega SIEMPRE como condición AND extra (nunca se debilita; test explícito: SOCIO + `tipoCliente=PROPIO` → vacío).
- UI: barra de filtros server-side en `tramites-workspace.tsx` (búsqueda con debounce 300ms, selects, limpiar). Kanban hereda el filtrado. 10 tests nuevos (13/13 el archivo).

### H3. Checklist + botones muertos (agente 3) — G4 estaba PARCIALMENTE DESACTUALIZADA
- El checklist interactivo y los botones PDF/Excel de borradores YA existían (auditoría G4 obsoleta en esos puntos). El botón PDF de cartera también ya estaba cableado (verificado por agente 4).
- Mejoras reales: fetch del checklist extraído a `checklist-api.ts` nuevo; botones PDF/Excel de borrador ahora visibles-pero-deshabilitados con tooltip cuando el estado no permite descargar (antes se ocultaban).

### H4. Alertas y cartera (agente 4) — pedidos reunión 1-jul
- 3 `Parametro` nuevos en seed (upsert idempotente): `UMBRAL_ALERTA_SALDO_TRAMITE_PROPIO=500000`, `UMBRAL_ALERTA_SALDO_TRAMITE_SOCIO=200000`, `UMBRAL_ALERTA_CARTERA_CLIENTE=-20000000`. Lector con fallback en `src/lib/alertas/umbrales.ts` (no lanza si falta la clave).
- Banner de alerta en la "Hoja" del trámite cuando `saldoTrasPagos` < umbral según tipo de cliente (GET `/api/tramites/[id]` ahora devuelve `umbralAlertaSaldo`).
- Dashboard: sección "Alertas de cartera" — clientes con saldo neto < umbral, en rojo, link a su cartera. 6 tests.
- Cartera: filtro por rango de fechas (client-side; la vista ya trae todo sin paginar). Las tarjetas de cruce muestran el saldo oficial completo, solo tabla y "Total real a LM" se acotan al rango.
- **Nota infra UI**: se crearon `src/lib/utils.ts` (cn) y `src/components/ui/alert.tsx` — primer componente en `src/components/ui/` (estaba vacío); paleta literal rose/amber, sin tokens shadcn.

### H5. Configuración editable (agente 5) — cierra WS3 + parte de G5
- `actualizarParametro` (bloquea claves `SIIGO_*` con error propio para no chocar con el flujo Siigo) + `src/lib/matrices/service.ts` nuevo (`actualizarCostoRecaudo`/`actualizarCostoPago`, rechaza negativos). Todo con AuditLog antes/después en la misma tx.
- Endpoints ADMIN-only: `PATCH /api/parametros/[clave]`, `PATCH /api/matrices/recaudo/[tipoRecaudo]`, `PATCH /api/matrices/pago/[canalPago]`.
- UI Configuración: tabla de parámetros editable inline + sección "Costos bancarios" (2 matrices). No-ADMIN sigue solo lectura. Los snapshots (`costoRecaudo`/`costoBancario` ya guardados) NO se recalculan. 42 tests.

---

## I. Ola 2 — Sprint orquestado 2026-08-26 (4 subagentes + cierre transversal)

Integración post-agentes: `tsc` limpio · **403/403 tests TODOS en verde** (C2 resuelto) · lint 13 errores `set-state-in-effect` (misma familia pre-existente; sanear todos juntos en pasada dedicada).

### I0. Decisiones de negocio CONFIRMADAS por el usuario (2026-08-26)
- **C2 CERRADO:** una FacturaProveedor PAGADA SÍ admite más pagos (abonos parciales); solo FACTURADA_CLIENTE bloquea. El test desactualizado se reescribió a la regla vigente.
- **Roles de documentos:** ADMIN/REVISOR eliminan y reemplazan cualquier documento; OPERATIVO sube y reemplaza SOLO lo suyo (subidoPorId), no elimina; SOCIO solo sube.

### I1. Migración `20260826120000_ola2_pagos_documentos` (aditiva, aplicada)
`PagoTramite.comprobanteComercioId` (FK Documento, relación "ComprobanteComercio") · `PagoTramite.grupoPagoId String?` (correlaciona pagos multi-DO) · `CategoriaDocumento.COMPROBANTE_COMERCIO` · modelo `DocumentoEnlace` (token único, expiraEn, revocado, creadoPor). Generada con `migrate diff` + `migrate deploy` porque `migrate dev` exige reset por la deuda vieja de `20260613200000` modificada post-aplicación (NO resetear: la BD local tiene datos). BD estaba caída (contenedores dormidos) — `docker compose start postgres minio`.

### I2. Anticipos (agente F) — pedidos reunión 1-jul
- **Soporte obligatorio al crear** (`SoporteAnticipoRequeridoError` 400); UI exige adjuntar y sube a MinIO vía `/api/storage` existente. Registros viejos intactos. Scripts de import ya cumplían.
- **Chulo verificado en el trámite:** badge verde "Verificado"/ámbar "Pendiente de verificar" (alineado a `estado`, antes había inconsistencia con `verificadoBanco`), botón "Verificar" solo ADMIN en UI (el endpoint conserva su regla establecida ADMIN/OPERATIVO-según-tipo, replicada en 3 services — no se estrechó sin decisión de negocio), descarga del comprobante. 9/9 tests.
- ⚠️ **Hallazgo pre-existente SIN resolver:** `POST /api/anticipos` exige ADMIN pero la UI muestra "Registrar anticipo" a REVISOR/OPERATIVO (recibirían 403). Decidir: ¿abrir el POST a más roles o esconder el botón?

### I3. Pagos (agente G) — ★ multi-DO Karina/Occidente
- **C2 fix** (regla confirmada arriba). 42/42 tests del módulo.
- **Doble comprobante:** `crearPago`/`actualizarPago` aceptan `comprobanteComercioId` validando pertenencia al trámite; UI con 2 uploads opcionales ("Comprobante bancario (Bancolombia)" / "Comprobante de comercio"); el flujo PSE ahora registra su captura como Documento real (categoría COMPROBANTE_COMERCIO) en vez de storage suelto; badge ámbar "Pago sin comprobante bancario" (advierte, NO bloquea — decisión del cliente para Karina "al inicio no obligar").
- **"Sin anticipo no hay pagos":** ya estaba implementado (`SinAnticipoAplicadoError` + botón deshabilitado) — verificado.
- **★ Pago multi-DO:** `GET/POST /api/pagos/multi` + `crearPagoMultiDO`: un PagoTramite por DO (Σ montos de sus facturas), mismo `grupoPagoId` (randomUUID)/documentos compartidos, FPs→PAGADA, TODO en una tx con AuditLog por pago + grupo. **Costo bancario UNA vez** (primer pago del grupo, resto 0) para no inflar costos. Modal con facturas de todos los DOs del beneficiario agrupadas, montos parciales editables, DOs sin anticipo en ámbar/bloqueados. Badge "Pago multi-DO" con tooltip de los otros DOs (vía `grupoOtrosDOs`).
- ⚠️ **Gap conocido:** `generarPagoDesdeFactura` (botón de pago desde una FP individual) NO valida anticipo ni ofrece doble comprobante — camino alterno que bypassea la regla. Decidir si cerrarlo.

### I4. Facturación (agente H) — auditoría + huecos
- **Aprobar vs Enviar YA EXISTÍA correcto:** aprobar = REVISOR/ADMIN (doble aprobador), FACTURADO y envío a SIIGO = solo ADMIN, acciones separadas (verificado en rutas y service). Se construyó lo que faltaba: **banner "Aprobados pendientes de enviar a SIIGO"** (contador + lista clicable, solo ADMIN) en facturacion-workspace.
- **Panel "Validaciones" en el revisor:** cruce agregado POR PROVEEDOR (Σ FPs vs Σ pagos, check verde/dif ámbar) + "pagos sin factura vinculada". `src/lib/borradores/validaciones.ts` (función pura, 7 tests). El cruce por-factura pre-existente se conservó.
- **Comisión desplegable** $400.000/$800.000/"Otro valor…" en `ComisionEditable` (flujo Lucho). El campo de comisión del modal "Generar borrador" (default 150k, concepto distinto) se dejó libre a propósito.
- **Conceptos SIIGO: ya completo** (SiigoProductoSelect en líneas + combobox en FPs) — solo auditado.
- 94 tests verdes incl. dorados del motor a tolerancia 0.

### I5. Documentos (agente I) — roles + enlace público
- Matriz de roles (decisión I0) en service (`DocumentoPermisoError` 403) + rutas con gates IDOR intactos (DELETE ahora ADMIN/REVISOR; antes OPERATIVO también podía). 21 tests de matriz.
- **Reemplazar = actualizar en sitio** (mismo id; nuevo storageKey/nombre/mime/tamaño) porque PagoTramite/FacturaProveedor referencian `documentoId` — un id nuevo rompería referencias. AuditLog "REPLACE"; archivo viejo a `deleted/` en MinIO. Flujo: presign → PUT MinIO → PUT confirmación.
- **Enlaces públicos:** token `randomBytes(32).base64url`, expiración 7 días (lee `Parametro DIAS_EXPIRACION_ENLACE_DOCUMENTO` si existe — NO está en seed, crearlo desde Configuración si se quiere otro valor), POST idempotente (devuelve el activo), DELETE revoca. Página pública `/compartir/[token]` (fuera del middleware) + `GET /api/compartir/[token]` → 404 genérico "Enlace no disponible" sin filtrar motivo; descarga por URL presignada del mecanismo existente. Modal "Compartir" con copiar/revocar. 26 tests de enlaces; IDOR de regresión verdes.

### I6. Bloqueo total de trámite CERRADO (agente J) ✅
- **Guard central** `src/lib/tramites/guard.ts`: `assertTramiteModificable(db, tramiteOrId)` → `TramiteCerradoError` 409 ("El trámite {consecutivo} está cerrado y no admite modificaciones"). Acepta id u objeto ya cargado (cero queries extra).
- **Protegidas:** pagos (crear/actualizar/eliminar/verificar/multi-DO — valida CADA DO del grupo), anticipos (aplicar/quitar aplicación; crear y verificar quedan libres a propósito — son por cliente/contables), facturas-proveedor (CRUD + generarPago), documentos (registrar/eliminar/reemplazar; enlaces públicos de lectura libres), borradores (generar/transicionar/comentarios/comisión + líneas vía chokepoint `cargarBorradorEditable`), checklist PATCH y edición de campos del DO (guard en ruta, no había service).
- **Reapertura:** desde CERRADO solo ADMIN (otros roles 403), AuditLog `REAPERTURA` distinto de `UPDATE_ESTADO`.
- **HTTP:** helpers genéricos `isDomainError`/`domainErrorResponse` en `src/lib/http/errors.ts` (cualquier error con `.status` numérico) cableados en los catch de las rutas tocadas, en vez de instanceof a mano en ~20 archivos.
- **UI:** banner "Trámite cerrado — solo lectura" + 4 botones de acción deshabilitados con tooltip en tramite-detalle; el selector de estado queda habilitado para que ADMIN pueda reabrir.
- **No protegido a propósito:** `solicitarFacturacion` (inalcanzable desde CERRADO), `solicitarSubida` (solo presign, la persistencia sí está protegida), forma-pago del borrador y rutas SIIGO de solo export.
- 15 tests nuevos (5 unit + 10 integración incl. multi-DO con un DO cerrado y reapertura ADMIN-sí/REVISOR-403).

### I7. Gates finales de la Ola 2 (2026-08-26)
`npx tsc --noEmit` limpio · `npm run test` **418/418** (32 archivos) · `npm run build` ✓ Compiled successfully, exit 0 · eslint limpio en archivos tocados (13 `set-state-in-effect` pre-existentes en archivos viejos, pasada dedicada pendiente).

**Siguiente paso para VER los cambios:** rebuild del contenedor de la app (`docker compose up -d --build app`) — la imagen viva de :3003 no incluye nada de las Olas 1-2. Los contenedores postgres/minio ya están arriba. Recordar patrón galcomex-deploy: verificar Prisma client no-stale en la imagen.

---

## A. Cierre de Sprint 11 — pasos manuales (no-código)

### A1. Usuarios en BD de producción — automático vía seed
**Estado (2026-06-25):** ya NO requiere script manual. `docker-entrypoint.sh` corre `prisma migrate deploy` + `prisma/seed.ts` en cada arranque, y el seed provisiona los 5 usuarios fijos con contraseña `Galcomex2026!`:
`camila` (ADMIN), `papa` (REVISOR), `karina` (OPERATIVO), `lucho` (OPERATIVO), `luismartinez` (SOCIO).
**Idempotencia:** el seed solo crea la cuenta credencial si el usuario NO tiene una; nunca pisa contraseñas ya cambiadas. Reiniciar el contenedor es seguro.
**Ojo (naming):** el único socio es `luismartinez@galcomex.com` (rol SOCIO). Existe además `lucho@galcomex.com` como OPERATIVO — confirmar con Camila si "Lucho" y "Luis Martínez" son la misma persona o dos cuentas distintas a propósito. `scripts/crear-usuario-socio.ts` queda como respaldo, ya no es necesario en el flujo normal.

### A2. Push a EasyPanel
**Acción:** build Docker + push a EasyPanel/Hostinger VPS. Verificación previa: `docker compose up --build` localmente pasa.
**Estado:** decisión del usuario — paso final separado, no entra al sprint de código.

---

## B. Diferidos por decisión del usuario (plan 2026-06-24, sección "Alcance OUT")

### B1. Selector de tipo de importación + documentos condicionales (Galcomex)
**Origen:** plan 24-jun. **Decisión:** alcance "solo lo de Lucho" — no se implementa selector ni documentos condicionales para Galcomex; solo BL/Guía + Factura Comercial obligatorios para DO de Lucho (eso sí se hizo en Bloque A6).
**Siguiente acción:** cuando llegue el sprint Galcomex, definir matriz de documentos por tipo de importación.

### B2. Cuestionario inteligente de preguntas de carga
**Origen:** plan 24-jun. **Lo define el papá de Camila.** Pendiente de especificación.
**Siguiente acción:** esperar definición desde Galcomex.

### B3. Documentos opcionales globales
Fumigación, hoja de seguridad, ficha técnica, etc.
**Estado:** diferido hasta sprint Galcomex.

### B4. D1 abierto — ¿Lucho crea sus propios DOs o los crea Galcomex?
Hoy el rol SOCIO recibe 403 en `POST /api/tramites`. La obligatoriedad de documentos BL/Factura Comercial (Bloque A6) se aplica por `cliente.tipo === SOCIO_LM` sin importar quién crea el DO, así que el cambio aplica en ambos escenarios.
**Siguiente acción:** decisión de negocio (Camila/Jefferson) — si Lucho crea sus DOs, levantar el 403 en POST trámites para SOCIO (con cliente filtrado a sus propios SOCIO_LM).

### B5. Infraestructura correo/nube (Google Workspace vs Microsoft)
**Estado:** consultoría, no código. Fuera de este proyecto.

### B6. Devolución (anticipo > factura) — sólo verificar, no rehacer
Sprint 7 ya implementó `PagoFactura.tipo = DEVOLUCION` con el ledger unificado.
**Acción pendiente:** verificación manual con un caso real (probable: BAQ-18453 con saldo a favor cliente 1.946.500 → registrar devolución y confirmar que el ledger queda saldado). NO requiere código nuevo.

---

## C. Tests pre-existentes a sanear (no del Sprint 11)

Confirmado con `git stash` contra HEAD `be74724` que estas dos fallas **NO** fueron introducidas por el Sprint 11 — el sprint sumó 2 tests pasando (227→229) sin agregar fallas.

### C1. `src/lib/excel/__tests__/borrador-lucho.test.ts`
**Falla:** abre `C:\Users\samue\Galcomex\excel-lucho-1.xls` (ruta Windows del entorno de Samuel) — falla en cualquier otra máquina.
**Origen:** Sprint 6 (importador Lucho). El test sí pasa cuando se ejecuta en la máquina con esos archivos.
**Acción sugerida:** parametrizar con variable de entorno (`LUCHO_EXCEL_PATH`) o copiar los `.xls` a una ruta versionada (`documentos referencia /` ya contiene el BAQ-18453, falta el segundo). Marcar como `skip` si la ruta no existe.

### C2. `src/lib/pagos/__tests__/service.test.ts` — "crearPago con facturaProveedorId de una FP ya PAGADA lanza FacturaProveedorNoModificableError"
**Falla:** el test espera que un segundo pago sobre una FP ya `PAGADA` lance `FacturaProveedorNoModificableError`.
**Causa:** en commit `788d65a` ("fix pagos, anticipos y enlace pse") la regla se cambió de `fp.estado !== REGISTRADA → throw` a `fp.estado === FACTURADA_CLIENTE → throw` (ahora se permiten múltiples pagos sobre una FP `PAGADA`, p.ej. abonos parciales). El test quedó desactualizado.
**Acción sugerida:** o bien (a) ajustar el test para reflejar la regla nueva (segundo pago sobre `PAGADA` se acepta y queda en estado `PAGADA`), o (b) si se quiere prohibir el segundo pago sobre `PAGADA`, restaurar la condición `!== REGISTRADA` y revisar abonos parciales. **Decisión de negocio**: ¿una FP `PAGADA` admite más pagos? Si SÍ → corregir test; si NO → restaurar regla.

---

## D. Deuda de sprints anteriores (consolidada, no resuelta en Sprint 11)

### D1. Sprint 6 — importador Lucho
- El 4x1000 del Excel de Lucho se calcula sobre los pagos (no `anticipo × 0.004` del motor). El import corrige post-generación; **Sprint 11 implementó la versión correcta para SOCIO_LM**: el 4x1000 de factura usa base = Σ terceros (round-half-up) y el 4x1000 interno usa base = anticipo. Falta cerrar el flag en motor cuando el `motor-factura.ts` clásico vea trámites SOCIO_LM (hoy el código orquesta correctamente por separado).
- `solicitarFacturacion` exige estado DESPACHADO; los DOs importados quedan en SOLICITUD y el botón mostrará 422 hasta avanzar el estado.
- SOCIO ve el botón "Crear DO" (el backend lo rechaza con 403; pulir render condicional). **Relacionado con D1 abierto (B4).**
- Canal del anticipo en imports asumido PSE.

### D2. Sprint 7 — cobros/devoluciones
- Sin botón para descargar/previsualizar el comprobante adjunto de un pago (existe `downloadUrl` en storage; falta el botón).
- Saldo de caja en Ingresos es por cliente, no global multi-cliente.
- Falta paginación server-side en cartera a escala.

### D3. Sprint 10 — integración Siigo API
- El envío a Siigo no distinguía PROPIO/SOCIO_LM (enviaba las líneas tal cual). **Sprint 11 lo resuelve indirectamente**: las líneas COMISION/COSTOS_BANCARIOS ya no se materializan para SOCIO_LM, así que el envío sigue siendo línea-a-línea pero con el set correcto.
- Costos bancarios no se facturan en Siigo (costo operativo interno) — sigue así.
- El estampado/validación final sigue siendo manual en el portal Siigo (`stamp.send=false`); no hay webhook de Siigo → sincronización es pull manual desde el sistema.

---

## E. Reconciliación documentada (informativa)

El plan 24-jun reportaba para BAQ-18453: `restanteInterno = 1.766.766` y `saldoLM = −179.734`. **El Excel real muestra `restanteInterno = 1.516.766` y `saldoLM = −429.734`**. Delta = 250.000 = diferencia entre la comisión default (`COMISION_LM = 150.000`) y la comisión real del DO (400.000, ver `Hoja1` C40/I40 del .xls). Los tests dorados y el motor reflejan los valores del Excel (fuente de verdad). Sin acción técnica — confirmar con Camila para que no haya sorpresa al revisar el cruce LM en el revisor.

---

## F. Roles y autorización

### F1. Scoping de SOCIO por `userId` (no por tipo de cliente)
**Estado:** funciona correctamente HOY, se vuelve bug con un segundo socio.
**Detalle:** el rol SOCIO filtra trámites por `cliente.tipo === SOCIO_LM` (ver filtro en `/api/tramites`), no por el usuario dueño. Con un único socio (Luis Martínez / Lucho) el conjunto "clientes SOCIO_LM" === "clientes de Lucho", así que se comporta bien. El día que entre un segundo socio, ambos verían los trámites del otro.
**Siguiente acción (cuando aparezca el 2º socio):** agregar relación `User.clientes Cliente[]` (o `Cliente.socioId`) en el schema y cambiar los filtros de `tipo: SOCIO_LM` a `socioId: session.user.id` en el handler de trámites (y cualquier otro endpoint que liste por SOCIO).
**Origen:** revisión de roles 2026-06-25.

### F2. Reset de contraseña por email (autoservicio)
**Estado:** fuera de scope. Requeriría SMTP configurado. Para single-tenant interno con 5 usuarios sobra.
**Mitigación ya implementada (2026-06-25):** cualquier usuario cambia su propia contraseña en `/cambiar-password` (ícono en el header) y el ADMIN restablece la de cualquier usuario desde Configuración → Usuarios (`POST /api/usuarios/[id]/reset-password`, audita `RESET_PASSWORD` y cierra sesiones).

---

## G. Auditoría 2026-08-24 (revisión de pruebas, bugs y módulos sin terminar)

Corrida tras sincronizar con `origin/master` (`8d4cf1d`). Gates locales: `tsc` limpio, `lint` 10 errores no-bloqueantes (todos `react-hooks/set-state-in-effect`), suite completa contra Postgres real **272/273** (el único fallo es C2, decisión de negocio pendiente).

> **Actualización 2026-08-25 (estado combinado de 3 sesiones).** Este working tree fue trabajado en paralelo por 3 sesiones Galcomex. Estado consolidado: **tsc 0, suite 335/336** (único rojo = C2). Resueltos desde esta auditoría: G1 (fix + tests de regresión `idor-regresion.test.ts`, 9 tests verdes), G2 (open redirect), G3 (AuditLog anticipos/beneficiarios), G4 (botones PDF/Excel + UI checklist), G5 edición de parámetros (otra sesión: `/api/parametros/[clave]` + `parametros-config.tsx`) y además edición de matrices de costos (`/api/matrices/*` + `matrices-config.tsx`), G6 `.env.example`, G7 test saneado. **Pendiente real:** deploy a producción (sin hacer, working tree compartido — coordinar), webhooks n8n HMAC y Playwright E2E (no hechos), códigos `SIIGO_IMPORT_*` y decisión C2 (Camila).

### G1. IDOR de SOCIO — CORREGIDOS EN LOCAL 2026-08-24 (falta deploy)
Cuatro endpoints permitían al rol SOCIO leer/modificar datos de clientes ajenos (no SOCIO_LM). Fix aplicado siguiendo el patrón `resolverTramiteConPermiso` ya usado en `comision/route.ts`:
- **`GET/POST/DELETE /api/storage`** — solo pedía `requireSession()`; cualquier sesión listaba TODO `tramites/` y generaba URLs de descarga de cualquier archivo. Fix: `requireRole(["ADMIN","REVISOR","OPERATIVO"])` (esos roles ya ven todo por diseño; SOCIO no usa este endpoint — solo cartera y libro de pagos, ambos fuera de su alcance).
- **`GET /api/tramites/[id]/documentos`** — admitía SOCIO sin `resolverTramiteConPermiso` (el POST del mismo archivo sí lo tenía). Fix: gate agregado.
- **`GET /api/tramites/[id]/documentos/[documentoId]`** — `refrescarUrlDescarga` sin verificar trámite ni pertenencia del documento. Fix: gate de permiso + verificación `doc.tramiteId === id`.
- **`PUT /api/borradores/[id]/comentarios`** — el comentario decía "validado en service" pero `actualizarComentariosCabecera` solo valida estado, no tipo de cliente. Fix: gate agregado en la ruta.
**Siguiente acción:** deploy a producción (los IDOR están vivos en `galcomex.sixteam.pro`). Idealmente añadir tests de regresión que un SOCIO reciba 403/404 en estos 4 endpoints.

### G2. Open redirect en login (MEDIO, sin corregir)
`src/app/api/login/route.ts:34-35` — `callbackURL.startsWith("/")` acepta `//evil.com` y `/\evil.com` (URLs protocolo-relativas) → redirige a dominio externo tras autenticar. **Acción:** rechazar `callbackURL` que empiece por `//` o `/\`.

### G3. Mutaciones financieras sin AuditLog (viola invariante #5, sin corregir)
`src/lib/anticipos/service.ts` — `crearAnticipo` (:63), `aplicarAnticipo` (:84) y `eliminarAplicacion` (:141) no escriben `AuditLog`; los anticipos son input del saldo corriente. También `src/lib/beneficiarios/service.ts` (crear/actualizar). **Acción:** añadir `auditLog.create` dentro de la misma transacción.

### G4. Endpoints backend listos pero SIN botón en UI (código muerto alcanzable)
- `GET /api/cartera/pdf` — hay un botón **deshabilitado** en `cartera-workspace.tsx:1056` con tooltip "Disponible en A3-T2" que **miente** (A3-T2 ya está hecho). Solo falta cablear el `href`.
- `GET /api/cartera/export`, `GET /api/borradores/[id]/pdf`, `GET /api/borradores/[id]/export` — ~50 KB de código PDF/XLSX probado, inaccesible desde la app.
- `PATCH /api/tramites/[id]/checklist/[itemId]` — backend completo, pero **no hay UI para marcar el checklist**, y el checklist BLOQUEA la transición APERTURA→EN_TRAMITE. Eslabón roto del flujo principal.

### G5. Módulos documentados como hechos pero inexistentes
- **Webhooks n8n HMAC** (CLAUDE.md:171) — 0 líneas de código. `N8N_WEBHOOK_*` nunca se leen. Único webhook real (`pse-token/route.ts`) es fire-and-forget SIN firma y con URL de n8n de producción hardcodeada.
- **Playwright E2E** — `test:e2e` en package.json pero no hay `playwright.config.ts` ni un solo `.spec.ts`. `npm run test:e2e` falla en seco.
- ~~Rate limiting en login~~ — **SÍ está implementado** (`src/lib/http/rate-limit.ts`, activo en `login/route.ts:31-42`, bloquea con 429 tras N intentos). La auditoría del 2026-08-24 se equivocó en este punto.
- **Edición de parámetros del sistema** (CLAUDE.md:132 dice que ADMIN puede) — la tabla es solo lectura; no existe endpoint de escritura para `Parametro` no-Siigo. Hoy solo vía `prisma studio`/SQL.

### G6. Configuración de despliegue incompleta
- `.env.example` (31 líneas) NO documenta 9 variables que el código sí lee: `SIIGO_API_USERNAME/ACCESS_KEY`, `PSE_ENCRYPTION_KEY` (sin ella el flujo PSE lanza excepción), `SIIGO_IMPORT_*` (5 códigos contables), `MINIO_REGION`, `WEBHOOK_PSE_URL`.
- **Importador SIIGO por Excel:** el módulo está completo y cableado (2 botones), pero los 5 códigos contables (`SIIGO_IMPORT_*`) no están seteados → el Excel sale con literales `<TIPO_FV>`/`<COD_PRODUCTO>` y SIIGO Nube lo rechaza. Camila debe entregar los 5 códigos (ya registrado en [[siigo-import-excel]]).

### G7. Test con rutas absolutas de la máquina de Samuel (ya conocido C1)
`src/lib/excel/__tests__/borrador-lucho.test.ts:20` — hardcodea `C:\Users\samue\Galcomex\excel-lucho-*.xls`. Sin guardia `existsSync` → falla en CI y en cualquier otra máquina. Parametrizar con env var + skip si no existe.
