# Galcomex — Estado del Sprint

> **Actualizado 2026-06-24** — reconstrucción de los Sprints 8–10 (PSE, beneficiarios N↔N, líneas manuales e **integración Siigo por API**) a partir de migraciones, código y git log. Los gates de cada uno de estos sprints (tsc/lint/test/build) no se re-ejecutaron en esta actualización documental; verificar antes de go-live.
>
> Actualizado 2026-06-11 por el agente coordinador tras validación + Sprint 3 (backend).
> **Gates de calidad al cierre:** `tsc` limpio · `lint` limpio · **56/56 tests** (incl. concurrencia, test dorado de motor y end-to-end de borrador contra Postgres real) · `npm run build` exit 0 · migración aplicada y reproducible · stack Docker completo arriba (app:3003, postgres:5433, minio:9000).
>
> **✅ Prueba MVP (1 de 3):** `npx tsx scripts/replicar-grupo-e-papis.ts` carga el DO real DO.BUN26-0026 del Excel GRUPO E PAPIS en la BD viva vía los servicios y reconcilia **los 9 valores al peso** (total factura 41.868.042, saldo cliente 3.357.958, saldo LM 875.944). El DO queda visible en la app para inspección.

## Sprint 1 — COMPLETADO ✅
- [x] Next.js 15 + TypeScript estricto, stack completo instalado
- [x] **Esquema Prisma completo** (20 modelos, enums, constraints únicos) + migración `20260612005000_init` aplicada
- [x] Seed: 8 canales de matriz, 4 parámetros (COMISION_LM=150000, IVA=0.19, 4X1000=0.004, SLA=3), usuario admin
- [x] **A1-T1** Migración + seed validados
- [x] **A1-T2** API de clientes (CRUD, Zod, filtro `?tipo=`, tarifas)
- [x] **A1-T9** Better Auth + `requireRole` + middleware
- [x] **A2-T1** Layout dashboard con sidebar + login UI
- [x] **A3-T1** Servicio MinIO (`src/lib/storage/`)
- [x] Motor de cálculo `motor-factura.ts` (función pura, BigInt)

## Sprint 2 — backend COMPLETADO ✅ / UI parcial 🟡
- [x] **A1-T3** Trámites: consecutivo atómico (`pg_advisory_xact_lock` + retry), pipeline de estados, regla Litoplas, auditoría. **Test de concurrencia 20 simultáneas PASA contra Postgres.**
- [x] **A1-T4** Checklist de apertura (bloquea APERTURA→EN_TRAMITE si faltan requeridos)
- [x] **A2-T2** UI de trámites — tabla + crear + **detalle con pestañas** (Resumen/Documentos/Pagos/Facturación/Historial) + **kanban** por estado + **edición inline de fechas clave** (PATCH `/api/tramites/[id]`).
- [🟡] **A3-T4** Importador Excel — existe el parser `src/lib/excel/galcomex-workbook.ts`. Falta el comando de import idempotente + reporte de discrepancias.

## Sprint 3 — backend COMPLETADO ✅ / UI en progreso
- [x] **A1-T5** Anticipos + aplicación multi-DO (advisory lock, validación de sobre-aplicación → 422, `con_saldo`, reversa). API + tests verdes.
- [x] **A1-T6** Libro de pagos + saldo en vivo (costo bancario auto desde matriz, **test dorado saldoFinal=4.708.356 exacto**, recálculo en cascada al cambiar canal, canal inexistente → 400). API + tests verdes.
- [x] **A2-T5** Tabla editable del libro de pagos (`src/components/pagos/`, página `tramites/[id]`) — saldo corriente recalculado en vivo en cliente (BigInt), edición optimista con rollback.
- [x] **A2-T4** UI de anticipos (`src/components/anticipos/`) — tabla aplicado/restante, filtro con saldo, registro y aplicación multi-DO con validación en vivo.
- [x] **A2-T3** Documentos (full-stack): persistencia `Documento` + API (`/api/tramites/[id]/documentos`) sobre primitivas MinIO + UI (drag&drop, subida directa por URL prefirmada, visor, galería de fotos). 3 tests nuevos.
- [x] **A3-T2** Generación de PDF (`src/lib/pdf/`, `@react-pdf/renderer`): borrador de factura + estado de cuenta de cartera. Rutas `/api/borradores/[id]/pdf`, `/api/cartera/pdf`. Test dorado COP correcto + render `%PDF`.

### Fixes de producción (Facturación 500 y rol)
- [x] **500 en Facturación:** `facturacion-api` pedía `/api/tramites?take=200` pero el schema topa `take`≤100 → `ZodError` no capturado en el GET → 500. Fix: GET de trámites captura `ZodError`→400 (endurecido), y Facturación usa `take=100`. Misma protección añadida al GET de clientes.
- [x] **Botones aprobar/facturar ocultos:** Facturación leía el rol de `/api/auth/session` (404); el endpoint real es `/api/auth/get-session`. Corregido → ADMIN/REVISOR ven sus botones.
- [x] **Replicación completa:** `scripts/replicar-grupo-e-papis.ts` ahora avanza el borrador hasta **FACTURADO (BAQ-18288)** → el DO real es visible en Trámites, Facturación y Cartera, cuadrando al peso.

### Fix de bugs reportados por el usuario
- [x] **Clientes — alta:** no tenía formulario (era solo lectura) → añadido `src/components/clientes/` con modal "Nuevo cliente" (POST `/api/clientes`, rol ADMIN). Login admin: camila@galcomex.com / `Galcomex2026!`.
- [x] **Clientes — ficha de detalle:** `clientes/[id]` con datos + tarifas (editar/agregar) + trámites/anticipos/facturas relacionados + editar cliente. Endpoint `GET/PATCH /api/clientes/[id]` ampliado.
- [x] **Facturación** ya NO es placeholder: `src/components/facturacion/` con generador de borrador + **revisor split-screen** (soporte a la izquierda, líneas+desglose a la derecha) + flujo de estados BORRADOR→EN_REVISION→APROBADO→FACTURADO con número SIIGO. (visor de soporte = placeholder, MinIO en A2-T3).

## Sprint 4 — backend en progreso
- [x] **A1-T7** Motor de cálculo de factura — **test dorado REAL DO.BUN26-0026 al peso** (total 41.868.042, saldo cliente 3.357.958, saldo LM 875.944, IVA 76.000, 4x1000 180.904, costos 17.550). Cobertura 100% ramas. Acepta `ivaComision`, `montoLM`, `costoRecaudoAnticipo` como inputs.
- [x] **A1-T8** Motor integrado con BD (`generarBorrador` arma DTO desde BD → motor → persiste `BorradorFactura` con snapshot) + ciclo de vida `BORRADOR→EN_REVISION→APROBADO→FACTURADO` (no facturar sin aprobar → 422) + cartera (cruce cliente/LM, fechas de pago). Helper `parametros/service.ts` convierte decimales del seed (0.19, 0.004) a enteros escalados (19n, 400n). API + tests verdes.
- [x] **A2-T6** Generador + revisor split-screen del borrador (CRÍTICO para el papá) — UI en `src/components/facturacion/`
- [x] **A2-T7** Módulo de cartera (UI) — `src/components/cartera/`: selector de cliente, cruce cliente/LM, filtro pendientes en URL, registrar pago desde la fila (re-fetch). Botón PDF placeholder (A3-T2).
- [x] **A3-T3** Export XLSX para SIIGO (`src/lib/export/siigo-xlsx.ts`): borrador (concepto/soporte/valor + totales, valores como NÚMERO) + relación de facturas. Rutas `/api/borradores/[id]/export`, `/api/cartera/export`. Test dorado verifica celdas numéricas.
- **A3-T5** Webhooks n8n

## Sprint 5 — hardening + go-live
- [x] **A2-T8 Dashboard operativo** — `src/components/dashboard/` + `/api/dashboard`: DOs por estado, pendientes de facturar con **alerta SLA > 3 días** (rojo), cartera vencida, anticipos con saldo, actividad reciente; cada tarjeta enlaza a su módulo filtrado. Función pura `calcularDiasYAlerta` + 9 tests.
- [x] **Archivo de importación a SIIGO** — `src/lib/export/siigo-import.ts` + `/api/borradores/[id]/siigo-import`: XLSX en formato oficial SIIGO Nube (columnas A–AE). Falta cargar los 5 códigos contables del usuario. Doc: `docs/importacion-siigo-archivo.md`.
- Pendiente: E2E Playwright completo, A3-T6 deploy prod/CI, A3-T7 auditoría UI/health, simulacro de restauración, rate-limit login, **marcar checklist desde la UI** (eslabón del flujo).

## Sprint 6 — Corrección de flujos: facturas de proveedor + portal de Lucho (2026-06-12) ✅
> Origen: aclaración de Camila sobre la confusión facturas/pagos/anticipos. Plan: `.claude/PLAN-FLUJO-LUCHO.md` (glosario corregido + evidencia de los Excel de Lucho). Ejecutado con 3 subagentes (WS-A backend, WS-B frontend, WS-C importador) + fixes de integración del orquestador.
> **Gates al cierre: 194/194 tests · tsc limpio · lint limpio · build exit 0 · BUN26-0026 9/9 al peso · imports Lucho al peso e idempotentes.**

- [x] **WS-A** Entidad `FacturaProveedor` (proveedor→Galcomex, ciclo REGISTRADA→PAGADA→FACTURADA_CLIENTE, única por trámite+numFactura) + `PagoTramite.facturaProveedorId`/`viaSocio` + `BorradorFactura.retenciones`/`conceptosOperacionales`. Migración `20260612232526_add_factura_proveedor_retenciones`. Motor acepta `retenciones` (aumenta saldo a favor; con 0n output idéntico). **2 casos dorados nuevos al peso:** BAQ-18453 (total 33.128.000) y BAQ-18512 (total 1.322.230, reteIVA 3.990). APIs: facturas-proveedor CRUD, generar-pago, solicitar-facturacion (SOCIO solo en clientes SOCIO_LM).
- [x] **WS-B** Pestaña "F. Proveedor" en el DO (tabla+alta+adjunto PDF+botón Pagar), badges factura/vía-Lucho en libro de pagos, banner "Solicitar facturación" para SOCIO, retenciones+desglose de conceptos en generador de borrador, línea "MENOS RETENCIONES" en la Hoja, terminología corregida ("Pagos a proveedores", "Facturas de venta").
- [x] **WS-C** Parser `src/lib/excel/borrador-lucho.ts` (detección PSE por fondo azul 99CCFF, extracción de referencias de factura del concepto) + CLI `scripts/importar-borrador-lucho.ts` (idempotente, reconcilia al peso) + 43 tests contra los 2 .xls reales (copias en `C:\Users\samue\Galcomex\excel-lucho-{1,2}.xls`).
- [x] **Integración (orquestador):** Zod del borrador acepta retenciones/conceptos (la ruta los pasaba por alto), GET libro de pagos incluye `facturaProveedor.numFactura`, permisos SOCIO en GET pagos/borradores y POST documentos (helper compartido `src/lib/auth/tramite-acceso.ts`), import marca facturas PAGADA y no duplica borradores, usuario `lucho@galcomex.com` (SOCIO) creado vía `scripts/crear-usuario-socio.ts`.
- Deuda Sprint 6: (1) el 4x1000 del Excel de Lucho se calcula sobre los pagos (no anticipo×0.004 del motor) — el import corrige el borrador post-generación; valorar flag en el motor en Fase 2. (2) `solicitarFacturacion` exige estado DESPACHADO (pipeline) — los DOs importados quedan en SOLICITUD y el botón mostrará el 422 hasta avanzar el estado. (3) SOCIO ve el botón "Crear DO" (el backend lo rechaza con 403; pulir render condicional). (4) Canal del anticipo en imports asumido PSE.

## Sprint 7 — Cobros (abonos parciales) y devoluciones (2026-06-13) ✅
> Origen: aclaración del usuario — "se hacen abonos, no necesariamente se paga toda la factura en una sola transacción; a veces sobra dinero y toca devolverlo". Resuelve el hueco: antes el cobro solo escribía una fecha (`fechaPagoCliente/LM`), sin monto/comprobante/parciales. Plan: `.claude/PLAN-COBROS.md`. Ejecutado con 2 subagentes (WS-D backend, WS-E frontend) + fix de integración del orquestador.
> **Gates al cierre: 215/215 tests · tsc limpio · lint limpio · build exit 0 · BUN26-0026 9/9 al peso.**

- **Decisión de modelado:** NO reutilizar `Anticipo` (anticipo = fondo PRE-trámite que se aplica a DOs; cobro = COBRO POST-factura que salda cartera; misma caja, contabilidad opuesta). Entidad propia `PagoFactura` + vista unificada de Ingresos.
- **Ledger unificado (corazón):** por (factura, destino∈{CLIENTE,LM}), `saldoNeto = (saldoAFavor − saldoACargo) + Σabonos − Σdevoluciones`. `>0` Galcomex debe (devolver); `<0` la parte debe (cobrar); `0` saldada. Maneja en una fórmula: cobro normal, abonos parciales, sobrepago (genera devolución) y saldo a favor.
- [x] **WS-D** Modelo `PagoFactura` (enums `DestinoPago` CLIENTE|LM, `TipoPagoFactura` ABONO|DEVOLUCION; monto BigInt, fecha, canal, comprobanteKey, verificadoBanco). Migración `20260613132509_add_pago_factura`. `cartera/service.ts`: `calcularSaldoNeto` (pura), `registrarPagoFacturaAbono` (advisory lock por factura+destino, DEVOLUCION>saldo a favor → 422, setea/limpia fechaPago derivada), `eliminarPagoFactura`, `getCarteraCliente` enriquecido (saldoNeto/pendienteCobro/pendienteDevolucion cliente+LM, soloPendientes = saldoNeto≠0). Servicio `ingresos` (union anticipos+abonos entradas − devoluciones salidas, saldo de caja corrido). Rutas `/api/facturas/[id]/pagos`, `.../pagos/[pagoId]`, `/api/ingresos`. Viejo `/pago` deprecado. +21 tests.
- [x] **WS-E** Cartera: chip de estado del ledger por fila (Saldada/Cobrar/Devolver), modal "Registrar abono" (monto+fecha+canal+comprobante MinIO+verificado), botón "Registrar devolución" (solo si saldoNeto>0, valida 422), lista expandible de pagos con "Anular". Nueva vista **Ingresos / Libro de bancos** (`/ingresos`, sidebar) con entradas/salidas y saldo corrido, filtro cliente+fechas en URL.
- [x] **Fix integración (orquestador):** la tarjeta de cruce y subtítulos de cartera tenían el signo invertido respecto a la nueva convención del ledger (mostraba "Galcomex le debe" cuando el cliente debía). Corregido `cruceLabel`/`cruceLabelColor` + subtítulos cliente/LM en `cartera-workspace.tsx`.
- **Demo:** `scripts/demo-cobros.ts` (factura A CARGO BAQ-19009 con 2 abonos parciales → pendiente 638.000; devolución parcial cliente + total LM sobre BUN26-0026). Capturas `capturas/15..19`.
- Deuda Sprint 7: (1) sin botón para descargar/previsualizar el comprobante adjunto de un pago (existe `downloadUrl` en storage; falta el botón). (2) Saldo de caja en Ingresos es por cliente, no global multi-cliente. (3) Falta paginación server-side en cartera a escala.

## Sprint 8 — Ajustes de movimientos + unificación de beneficiarios (2026-06-18/19) ✅
> Migraciones `20260618000000_ajustes_sprint8`, `20260613200000_separar_recaudo_pago`, `20260613220000_add_beneficiario`, `20260613230000_pagofactura_recaudo_costo`.

- [x] **Estados de movimiento** — enum `EstadoMovimiento` (BORRADOR | REALIZADO | VERIFICADO) añadido a `Anticipo`, `PagoTramite` y `PagoFactura`. Permite marcar un movimiento como verificado contra el banco (campo `verificadoBanco` en `PagoFactura`).
- [x] **Matriz separada recaudo/pago** — `MatrizRecaudo` (entra plata, `TipoRecaudo`) vs `MatrizPago` (sale plata, `CanalPago`). `PagoFactura` lleva exactamente uno de `tipoRecaudo`/`canalPago`; el `costoBancario` es snapshot al registrar.
- [x] **Entidad `Beneficiario`** (proveedores/terceros a quienes se paga: nombre, NIT, banco, nº cuenta). `FacturaProveedor.beneficiarioId` la unifica (los campos `proveedorNombre/proveedorNit` quedan legacy). Campo `concepto` añadido a `FacturaProveedor`.
- [x] **Pivot N↔N `PagoTramiteFactura`** — un pago cubre varias facturas de proveedor y viceversa (reemplaza la FK 1→N `pago_tramite.factura_proveedor_id`, con backfill).

## Sprint 9 — Pagos N↔N beneficiarios + flujo PSE + líneas manuales (2026-06-19) ✅
> Migraciones `20260619000000_pago_beneficiario_nn`, `20260619100000_pse_solicitud`, `20260619175118_lineas_manuales_factura`. Commit `feat: pagos N↔N beneficiarios, flujo PSE y ajustes libro pagos`.

- [x] **Pagos N↔N beneficiarios** — pivot `PagoTramiteBeneficiario`: un pago puede repartirse entre varios beneficiarios y un beneficiario aparece en varios pagos.
- [x] **Flujo PSE** — `PseSolicitud` (token único para link a María Camila, `codigoPseEnc` cifrado **AES-256-GCM** `iv:authTag:ciphertext`, `expiresAt`, `respondidaAt`). Var de entorno `PSE_ENCRYPTION_KEY` (añadida también a docker-compose). Flag `viaSocio` en `PagoTramite`.
- [x] **Líneas manuales de factura** — `LineaRevision.origen` (AUTO | MANUAL): además de las líneas auto-generadas desde el libro de pagos, el revisor puede escribir líneas a mano (caso portal del socio). `recalculo.ts` recalcula total y saldos desde las líneas como fuente de verdad.

## Sprint 10 — Integración Siigo por API + módulo de revisión (2026-06-22/24) ✅
> Migraciones `20260622140000`…`20260623130000` (comentarios cabecera, secciones, siigo_producto, envío siigo, impuestos, forma de pago, tipo fija, tipos comprobante + vendedores). Commits `cambios lucho`, `integracion siigo y modulo de revision en clientes glacomex`. **Reemplaza** la estrategia de import por Excel de los Sprints 4–5 (ver `docs/flujo-siigo-api.md`).

- [x] **Cliente de API Siigo** (`src/lib/siigo/client.ts`) — auth `POST /auth/token`, `GET /v1/products` (paginado), lookups `document-types`/`users`/`payment-types`/`taxes`, `POST /v1/invoices` y `GET /v1/invoices/{id}`. Errores tipados `SiigoConfigError`/`SiigoApiError` con propagación del body de validación.
- [x] **Catálogos espejo** — modelos `SiigoProducto`, `SiigoImpuesto`, `SiigoTipoComprobante`, `SiigoVendedor`, `SiigoFormaPago` (sincronizados desde Siigo) + pivot manual `SiigoProductoImpuesto` (IVA por producto, ya que `/v1/products` no lo expone). Servicios `sync-*-service.ts` y rutas `/api/configuracion/siigo/{productos,impuestos,formas-pago,tipos-comprobante,vendedores,sync}`.
- [x] **Líneas de revisión enriquecidas** — `seccion` (TERCEROS = ingresos recibidos para terceros | OPERACIONAL = ingresos propios), `siigoProductoId` (producto a facturar), `tipoFija` (IMPUESTO_4X1000 | COSTOS_BANCARIOS) para conceptos auto-fijos. Pivot `LineaRevisionFactura` (línea ↔ facturas de proveedor que la respaldan, para el NIT del tercero).
- [x] **Comentarios de cabecera** — `BorradorFactura.comentariosCabecera` (Json, formato Lucho) → se vuelcan en `observations` de Siigo junto al bloque TOTAL FACTURA / VALOR ANTICIPO / SALDO. Ruta `/api/borradores/[id]/comentarios`.
- [x] **Envío como BORRADOR (DRAFT)** — `enviarBorradorASiigo` (`src/lib/siigo/envio-factura-service.ts`): valida estado APROBADO + NIT cliente + forma de pago + parámetros + productos por línea + NIT de terceros, arma items (TERCEROS→OPERACIONAL→comisión con IVA; 4x1000 con NIT DIAN; costos bancarios NO se envían), `POST /v1/invoices` con `stamp.send=false`. Persiste `siigoDraftId`/`enviadoASiigoEn`/`ultimoErrorSiigo`. Ruta `/api/borradores/[id]/siigo-enviar` (rol ADMIN). UI en `revisor-borrador.tsx` (botón "Enviar/Reenviar a SIIGO", chip de estado, errores).
- [x] **Forma de pago por borrador** — `BorradorFactura.formaPagoSiigoId` (contado vs crédito, default `SIIGO_FORMA_PAGO_DEFAULT_ID`). Ruta `/api/borradores/[id]/forma-pago`.
- [x] **Sincronización desde Siigo** — `sincronizarFacturaDesdeSiigo`: tras el estampado manual de un superior en el portal Siigo, `GET /v1/invoices/{id}` trae el consecutivo definitivo (BAQ-XXXXX) + fecha → transiciona el borrador a FACTURADO y crea `Factura` (alimenta cartera). Idempotente. Ruta `/api/borradores/[id]/siigo-sincronizar`.
- [x] **Parámetros Siigo en BD + UI** — `SIIGO_TIPO_COMPROBANTE_ID`, `SIIGO_VENDEDOR_ID`, `SIIGO_PRODUCTO_COMISION_ID`, `SIIGO_FORMA_PAGO_DEFAULT_ID`, `SIIGO_PRODUCTO_4X1000_ID`, `SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID` (+ `SIIGO_NIT_DIAN` opcional). UI `src/components/configuracion/` + ruta `/api/configuracion/siigo/parametros` (rol ADMIN/REVISOR). Credenciales de API (`SIIGO_API_USERNAME`/`SIIGO_API_ACCESS_KEY`/`SIIGO_API_BASE_URL`) en `.env`. Script `scripts/siigo-config-lookup.ts` para descubrir los IDs.
- [x] **Dos tipos de factura de venta** — `TipoCliente` PROPIO (Galcomex, motor `motor-factura.ts` con 4x1000 condicional) vs SOCIO_LM (socio "Lucho", `total-lineas.ts` que replica su Excel: Σ líneas terceros + comisión + IVA − retenciones, con reparto de saldo cliente/LM). Ambos comparten el mismo canal de envío a Siigo (las líneas).
- Deuda Sprint 10: (1) el envío a Siigo no distingue PROPIO/SOCIO_LM (envía las líneas tal cual; la diferencia está solo en cómo se calcula el borrador). (2) Costos bancarios no se facturan en Siigo (costo operativo interno). (3) El estampado/validación final sigue siendo manual en el portal Siigo (`stamp.send=false`); no hay webhook de Siigo → la sincronización es por pull manual.

## Lógica financiera real (decodificada del Excel BUN26-0026 — fuente de verdad)
Fórmulas verificadas celda por celda (ver `motor-factura.ts`):
- `costosBancarios = costoRecaudoAnticipo + Σ(costo pagos)` = 1.950 + 4×3.900 = **17.550** (Excel `SUM(F23:F37)+D18`).
- `ivaComision` es **celda manual** en el Excel (76.000), NO 19%×comisión → el motor lo acepta como override.
- `4x1000` condicional: a favor → `anticipo×0.004`; a cargo → `(anticipo+|saldoACargo|)×0.004` = **180.904**.
- `saldoFinal = saldoTrasPagos − comisión − iva − 4x1000 − costos` = **4.233.902**.
- `saldoAFavorCliente = saldoFinal − montoLM` = **3.357.958**; `saldoAFavorLM = montoLM` = **875.944**.
- `totalFactura = anticipo − saldoAFavorCliente` = **41.868.042**.

### Deuda restante (no bloqueante)
1. **`montoLM` es un input** (no derivable de los pagos). En el Excel sale de la celda "TOTAL FACTURA" que Camila ajusta. La derivación automática del monto LM desde la clasificación de pagos "LUIS" es Fase 2.
2. **Mapeo de parámetros en A1-T8:** el seed guarda decimales (`IVA=0.19`, `4X1000=0.004`) pero el motor espera enteros escalados (`tasaIva=19n`, `tasa4x1000=400n`). La capa de integración (A1-T8) debe convertir al leer `Parametro`.

## Criterio de salida del MVP
Camila procesa 3 trámites reales de punta a punta en el sistema, en paralelo con el Excel, y ambos cuadran al peso.
