# CLAUDE.md — Galcomex Sistema de Gestión Operativa

Sistema interno single-tenant para Galcomex, agencia logística de importaciones (Barranquilla).
5 usuarios, un solo cliente/empresa, no multiempresa.
Desarrollado y mantenido por agentes IA (Claude Code) bajo supervisión de SixTeam.

## Stack tecnológico

- **Framework:** Next.js 15 (App Router) + TypeScript estricto (sin `any`)
- **BD:** PostgreSQL 16 + Prisma ORM
- **UI:** Tailwind CSS + shadcn/ui + TanStack Table
- **Auth:** Better Auth (email + password, 4 roles)
- **Storage:** bodega S3 — MinIO en local (docker-compose); Cloudflare R2 en producción (`docs/ALMACENAMIENTO-S3.md`)
- **PDF:** react-pdf / Puppeteer (en endpoints de servidor)
- **Excel export:** SheetJS (xlsx)
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Deploy:** servicio App de EasyPanel con el `Dockerfile` (proyecto `postgres`, servicio `galcomex-app`, Hostinger VPS); `docker-compose.yml` es solo para local
- **Automatización:** n8n (ya operado por SixTeam) vía webhooks

## Estructura de carpetas

```
galcomex-app/
├── src/
│   ├── app/
│   │   ├── (dashboard)/        # Rutas protegidas, layout con sidebar
│   │   │   ├── tramites/
│   │   │   ├── facturacion/
│   │   │   ├── cartera/
│   │   │   ├── anticipos/
│   │   │   ├── clientes/
│   │   │   └── configuracion/
│   │   ├── api/                # Route Handlers REST
│   │   │   ├── clientes/
│   │   │   ├── tramites/
│   │   │   ├── anticipos/
│   │   │   ├── pagos/
│   │   │   ├── facturas/
│   │   │   └── cartera/
│   │   └── auth/
│   ├── lib/
│   │   ├── db/                 # Cliente Prisma singleton
│   │   ├── auth/               # Config Better Auth
│   │   ├── storage/            # Cliente S3 (MinIO/R2), enlaces firmados, explorador
│   │   ├── calculations/       # Motor de cálculo PURO (sin BD)
│   │   │   └── motor-factura.ts  ← NÚCLEO CRÍTICO
│   │   ├── pdf/                # react-pdf templates
│   │   ├── excel/              # SheetJS exports
│   │   └── validations/        # Esquemas Zod
│   ├── components/
│   │   ├── ui/                 # shadcn/ui primitivos
│   │   ├── layout/             # Shell, Sidebar, Header
│   │   ├── tramites/
│   │   ├── facturacion/
│   │   ├── cartera/
│   │   ├── anticipos/
│   │   └── dashboard/
│   └── types/
├── prisma/
│   ├── schema.prisma           # Fuente de verdad del modelo
│   └── seed.ts                 # Matriz de pagos, parámetros, admin
├── scripts/
│   └── import-excel.ts         # Importador de datos históricos del Excel
├── docker-compose.yml
└── .env.example
```

## Reglas de negocio críticas

### Motor de cálculo de factura
Todo en `src/lib/calculations/motor-factura.ts`. **Función pura, sin BD.**

**Saldo corriente:** `saldo = Σ(anticipos_aplicados) − Σ(pagos)`

**Cálculo del borrador:**
1. `costosBancarios = Σ(pago.costoBancario)` — de tabla `MatrizRecaudoPago`
2. `ivaComision = comision × 19 / 100` (BigInt, truncado)
3. **4x1000 CONDICIONAL:** solo si `saldoPrevio − comision − iva − costos > 0` (saldo a favor)
   - Base = `totalAnticipoAplicado`, tarifa = 0.4%
   - Si queda a cargo del cliente → `impuesto4x1000 = 0`
4. `totalFactura = saldoPrevio − comision − iva − costos − 4x1000`
5. `saldoAFavor = max(totalFactura, 0)`, `saldoACargo = max(-totalFactura, 0)`

### Matriz de costos bancarios
| Canal | Costo COP |
|---|---|
| BANCOLOMBIA_SUCURSAL | 11.290 |
| BANCOLOMBIA_CAJERO | 5.200 |
| BANCOLOMBIA_CORRESPONSAL | 6.190 |
| BANCOLOMBIA_TRANSFERENCIA | 3.900 |
| OTROS_BANCOS_SUCURSAL | 2.200 |
| OTROS_BANCOS_TRANSFERENCIA | 7.300 |
| PSE | 0 |
| OTRO | 1.950 |

### Parámetros del sistema (tabla `Parametro`)
- `COMISION_LM` = 150.000 COP (editable por factura — en DOs concretos se ha visto 400.000, p.ej. BAQ-18453)
- `IVA_COMISION` = 0.19 (19%)
- `TASA_4X1000` = 0.004
- `DIAS_SLA_FACTURA` = 3 días (alerta roja en dashboard)
- `NIT_BANCO_4X1000` = `890300279` (Banco de Occidente — tercero fijo del 4x1000 en facturas Siigo, Sprint 11)

### Flujo SOCIO_LM (cliente Lucho) — diferencias clave vs PROPIO
- Las líneas fijas **COMISION** y **COSTOS_BANCARIOS** NO se materializan como `LineaRevision` (deducciones internas únicamente; se reflejan en el cruce LM). `IVA_COMISION` sí (ingreso operacional).
- Dos cálculos de 4x1000: el **interno** (base = anticipo, para cruce LM) sigue en `motor-factura.ts`; el **de factura** (base = Σ líneas TERCEROS, round-half-up `(base×4+500)/1000`) materializa la línea `IMPUESTO_4X1000` que se envía a Siigo.
- Tercero del 4x1000 SIEMPRE Banco de Occidente (NIT `890300279`) — `resolverNit4x1000` lo retorna de forma incondicional.
- Observación de cabecera "NO PRACTICAR RETEFUENTE NI RETEICA" se siembra automáticamente en `comentariosCabecera` al generar borrador SOCIO_LM (sale en col AE del export Excel y en `observations` del envío Siigo).
- BL/Guía + Factura Comercial son obligatorios al crear el DO para clientes SOCIO_LM.
- Detalle implementado en `src/lib/borradores/lineas-fijas.ts`, `src/lib/calculations/total-lineas.ts` y `src/lib/siigo/envio-factura-service.ts`.

### Formato de factura CONCEPTOS_IVA (Galcomex propio) — función `factura_conceptos_iva`
Verificado contra 331 facturas reales 2026 leídas de Siigo (Litoplas, Polyrec, Polyrec ZF, CW ASIA, Sesderma, Coldex). Se fija por borrador en `BorradorFactura.formatoFactura` al generarlo; los borradores viejos quedan en `"COMISION"`.
- **Conceptos:** cada ítem del tarifario (o concepto manual) es una línea OPERACIONAL con su producto Siigo y `LineaRevision.aplicaIva`. No hay línea COMISION ni COSTOS_BANCARIOS.
- **Terceros:** nacen de las facturas de proveedor repercutibles del trámite ("ALMACENAJE ALMACARGA FACT. FE-11298"), sin IVA, con el NIT del proveedor.
- **Líneas calculadas:** IVA_COMISION ("IVA 19%") = Σ IVA por ítem redondeado al peso; IMPUESTO_4X1000 = 0,4 % de Σ terceros (redondeo al peso; sin terceros no hay 4x1000). Las recalcula `sincronizarLineasDerivadas` dentro de `recalcularTotalBorrador` cada vez que cambian las líneas.
- **ReteIVA:** `% de la función × IVA` (15 % por defecto, snapshot en `BorradorFactura.reteIvaPorcentaje`); con null las retenciones son manuales.
- **Siigo:** la línea de IVA no se envía; los ítems gravados llevan `taxes: [{id: IVA 19%}]`, la ReteIVA va en `retentions`, `payments.value` = total. Armador puro en `src/lib/siigo/items-factura.ts`.
- **Observaciones:** "NO PRACTICAR RETEFUENTE NI RETEICA" + "DO… IM… PROVEEDOR" + totales con "SALDO A FAVOR/A CARGO" (sin "SU").
- **Casos dorados:** BAQ-18385 (terceros + 4x1000 + ReteIVA, total 1.487.623, a cargo 69.623) y BAQ-18357 (sin terceros, a favor 11.400) en `src/lib/calculations/__tests__/factura-conceptos.test.ts`.

## Capacidades por empresa (M1) — cómo se configura el comportamiento

Toda diferencia de comportamiento **entre empresas** es dato, no código. Vive en
`src/lib/capacidades/`:

- `catalogo.ts` — fuente de verdad de los códigos (`CodigoCapacidad`). Agregar una
  capacidad es agregar una entrada aquí + su consumidor + su fila en el seed.
- `resolver.ts` — **función pura, sin BD**. Cascada
  `Capacidad.porDefecto → GrupoEmpresaCapacidad → EmpresaCapacidad`.
  `habilitado` y `config` se resuelven por separado: cada uno toma el nivel más
  específico que lo define.
- `service.ts` — `capacidadesDeEmpresa(empresaId)`, `setCapacidadesEmpresa(...)`
  (transaccional + `AuditLog` por capacidad tocada).

Uso en dominio:

```ts
const capacidades = await capacidadesDeEmpresa(tramite.clienteId);
if (tiene(capacidades, "base_cif")) { ... }
const config = configDe<{ valor: string }>(capacidades, "umbral_saldo_tramite");
```

UI: pestaña **Funciones** en la ficha de empresa (`seccion-capacidades.tsx`),
editable solo por ADMIN. API: `GET|PUT /api/clientes/[id]/capacidades`.

`Cliente.manejaAnticipo` quedó **deprecado**: se mantiene en espejo con la
capacidad `anticipos_cliente` hasta retirar la columna. Plan completo y orden de
fases en `.claude/PLAN-CONFIGURABILIDAD.md`.

## Tarifario y eventos (M2 + M3) — la propuesta comercial como datos

- **Motor puro:** `src/lib/tarifas/motor.ts` (`calcularLineasTarifa(items, ctx)`),
  sin BD, BigInt, tolerancia 0. Seis formas de cálculo (`FIJO`, `POR_UNIDAD`,
  `PORCENTAJE_MIN` con mínimos por tipo de carga, `PRIMERO_MAS_ADICIONAL`,
  `ESPEJO_DE_COSTO`, `POR_TRAMO` = precio unitario según cuántas unidades haya,
  Polyrec ZF: 1 contenedor 300.000, 2 o más 250.000 c/u) y tres disparadores
  (`SIEMPRE`, `EVENTO`, `MANUAL`). Si falta un dato de la base de cálculo
  devuelve `pendientes`, nunca un cero.
- **Datos:** `Tarifario` (por empresa y `alcance` = línea de servicio, con
  vigencia real y versión; BORRADOR → VIGENTE → VENCIDO | REEMPLAZADO) +
  `TarifaItem`. Solo se editan ítems de un BORRADOR; para cambiar precios se
  duplica (con incremento opcional, p. ej. IPC) y se publica. Plantillas de las
  propuestas 2026 en `src/lib/tarifas/plantillas.ts`.
- **Eventos:** `CatalogoEvento` (global) + `TramiteEvento`. Marcar un evento
  crea sus documentos en el checklist y habilita el ítem del tarifario que lo
  cobra. Base de cálculo del DO: `valorCif`, `tipoCarga`, `numContenedores`,
  `numDeclaraciones`, `numDocumentos`, `numItems`.
- **Facturación:** `generarBorrador` usa el tarifario vigente como desglose de
  la comisión SOLO si la empresa tiene `tarifario_propio` y no se pasó comisión
  ni conceptos a mano; con pendientes lanza `TarifaIncompletaError` (422). Sin
  tarifario, nada cambia (casos dorados intactos). `BorradorFactura.tarifarioId`
  registra con qué versión se calculó.
- **Capacidades que lo gobiernan:** `tarifario_propio`, `eventos_facturables`,
  `base_cif`. Sin ellas los endpoints responden 422 y la UI no muestra las
  secciones.
- **Orden de compra** (`orden_compra_en_revision`, caso Polyrec): el DO guarda
  `ordenCompraNumero` y `ordenCompraValor` (COP sin IVA); `generarBorrador`
  siembra "ORDEN DE COMPRA N° …" en `comentariosCabecera` y el revisor muestra
  si la factura sin IVA cuadra con la OC.
- **Tipos de trámite:** `IMPORTACION` (DO.BAQ26-0001), `CLASIFICACION`
  (CLAS26-0001, exige `clasificacion_arancelaria`) y `OTRO` (OTR26-0001:
  Plan Vallejo, sellos, coordinación logística; sin agencia, ETA ni checklist,
  factura aparte, línea de cartera `OTROS`). Agencias: Moviaduanas, Coldex,
  AR Logisty, Cortes.
- UI: sección "Tarifario" en la ficha (`seccion-tarifario.tsx`), panel "Base de
  cálculo y eventos" en el Resumen del DO (`seccion-eventos-tramite.tsx`),
  PDF en `GET /api/tarifarios/[id]/pdf`. Demo: `npx tsx scripts/demo-tarifario.ts`.

## Invariantes de código — NUNCA violar

1. **Dinero SIEMPRE como `BigInt` (COP enteros).** Cero flotantes en cálculos financieros.
2. Sin `any` en TypeScript — el build falla si hay `any`.
3. Validación Zod en TODOS los endpoints API (entrada).
4. Autorización en middleware, no en componentes React.
5. Toda mutación crítica (DOs, pagos, borradores, facturas) genera registro en `AuditLog` con snapshot JSON antes/después.
6. Tests de cálculo con tolerancia **0 pesos** (exactos, sin redondeos).
7. **Cero ramas por empresa.** Prohibido ramificar por `TipoCliente`, por NIT o
   por nombre de empresa para decidir comportamiento de negocio: eso es una
   capacidad (ver arriba). Tampoco se agrega un tercer valor a `TipoCliente`.
   El enum queda como dato descriptivo mientras se migran las 131 ramas vivas.

## Roles y permisos

| Acción | ADMIN | REVISOR | OPERATIVO | SOCIO |
|---|---|---|---|---|
| CRUD clientes/tarifas | ✓ | | | |
| Crear/editar DOs | ✓ | ✓ | ✓ | |
| Checklist/documentos | ✓ | ✓ | ✓ | |
| Registrar anticipos | ✓ | | ✓ | |
| Registrar pagos | ✓ | | ✓ | |
| Verificar anticipos/pagos | ✓ | | ✓ (solo clientes propios) | |
| Aprobar borrador factura | ✓ | ✓ | | |
| Marcar facturado (+ num SIIGO) | ✓ | | | |
| Ver cartera | ✓ | ✓ | | |
| Ver solo sus trámites | | | | ✓ |
| Editar parámetros del sistema | ✓ | | | |

## Consecutivo automático de DO

Formato: `DO.{CIUDAD}{AA}-{NNNN}` — ej. `DO.CTG26-0124`
- Generado atómicamente en transacción DB (sin race conditions)
- Único por ciudad + año (constraint `@@unique([ciudad, anio, numero])`)
- Litoplas SIEMPRE requiere `agenciaAduanas = MOVIADUANAS` y `doAgencia` con formato `I########`

## Transiciones de estado del DO

`SOLICITUD → APERTURA → EN_TRAMITE → EN_PUERTO → DESPACHADO → ENVIADO_A_FACTURAR → FACTURADO → PAGADO → CERRADO`

- **APERTURA → EN_TRAMITE:** bloqueado si hay `ChecklistItem` requerido sin marcar
- Toda transición queda en `EstadoLog` con usuario y timestamp

## Storage (bodega S3: MinIO local / Cloudflare R2)

Ruta: `tramites/{consecutivo}/{categoria}/{uuid}.{ext}`
- Enlaces firmados por la app (`/api/storage/objeto`, `lib/storage/proxy.ts`) con expiración ≤ 15 minutos; el navegador nunca habla con la bodega
- Tipos (`ALLOWED_STORAGE_FILE_TYPES` en `lib/storage/config.ts`): PDF, JPG, PNG, XLSX/XLS, DOCX/DOC, ZIP, RAR, EML, MP4 (máx 25 MB). La lista sale de lo que manda Litoplas de verdad (histórico 2026); los inputs usan `ACCEPTED_FILE_EXTENSIONS_ATTR`
- Soft-delete (`eliminado = true`), nunca borrado físico

## Tests — Casos dorados (BLOQUEANTES en CI)

Los tests del archivo real están en `src/lib/calculations/__tests__/`.

**DO.BUN26-0026 (PROPIO, fuente: GRUPO E PAPIS 2026):**
- Anticipo: 45.226.000 · 7 pagos · Comisión: 200.000 · 4x1000 = 180.904 · Saldo a favor cliente: 3.357.958

**DO.CTG26-0118 / BAQ-18453 (SOCIO_LM, fuente: `documentos referencia /BAQ-18453 ... .xls`):**
- Anticipo: 35.074.500 · Σ pagos: 32.931.686 · Comisión: 400.000 + IVA 76.000
- 4x1000 factura: 130.088 (base Σ terceros 32.521.912, round-half-up)
- 4x1000 interno: 140.298 (base anticipo)
- Total factura: 33.128.000 · Saldo a favor cliente: 1.946.500
- Restante interno: 1.516.766 · **Saldo LM: −429.734** (Lucho debe a Galcomex)

CI falla si estos tests no pasan. Tolerancia = 0 pesos.

## WhatsApp (Kapso) — código del token PSE

El operario pide el código del token desde el pago PSE; los aprobadores de
`WHATSAPP_APROBADORES_PSE` (Parametro, ADMIN) reciben la plantilla
`galcomex_codigo_pse` por la línea compartida **Sixteam.pro** y contestan en el
chat. Galcomex no habla con Kapso: habla con la pasarela `sixteam-whatsapp-gateway`
(`wa.sixteam.pro`, imita al proxy de Kapso) que rutea la línea entre plataformas. Catálogo cerrado de mensajes en `src/lib/whatsapp/catalogo.ts`, reglas
de aislamiento (solo aprobadores, solo nuestra línea, botones `gx_`, nunca
adivinar) en `decidir.ts` (puro), webhook firmado en `/api/whatsapp/kapso`.
No usar el número de 2brain (guarda todo texto entrante). Guía y puesta en
marcha: `docs/WHATSAPP-APROBACIONES.md`; script: `scripts/whatsapp-kapso.ts`.

## Webhooks n8n

Eventos (firmados HMAC-SHA256): `do.creado`, `do.enviado_a_facturar`, `factura.aprobada`, `factura.facturada`, `cartera.vencida`

## Comandos de desarrollo

```bash
npm run dev                              # Servidor dev
npm run test                             # Vitest unit tests
npm run test:e2e                         # Playwright E2E
npx prisma studio                        # Explorador BD
npx prisma migrate dev --name nombre     # Nueva migración
npx prisma migrate reset                 # Reset completo (dev)
docker compose up --build               # Stack completo
```

## Convenciones de UI (desde la auditoría 2026-09-07)

- **Acceso por rol a módulos:** un solo mapa `RUTAS_DASHBOARD` en `src/lib/auth/rutas-roles.ts` alimenta el sidebar, el guard de página y la redirección tras login. Cada `page.tsx` del dashboard empieza con `await exigirAccesoPagina("/ruta")` (`src/lib/auth/page-guard.ts`); si el rol no puede, va a `/sin-acceso`. El middleware solo comprueba que exista cookie. Al añadir un módulo: entrada en el mapa + guard en su page.
- **Rol en cliente:** `useRol()` / `usePermiso([...])` de `src/lib/auth/rol-context.tsx` (provisto por el layout). Prohibido `fetch("/api/auth/get-session")` en componentes. Un botón solo se muestra si el `requireRole` del endpoint que llama admite el rol.
- **Feedback de mutaciones:** `useToast()` (`src/components/ui/toast.tsx`) para éxito y error (`describirError(e)`); toda mutación va en `try/catch/finally` y el estado pendiente siempre vuelve a `false`.
- **Acciones destructivas:** `useConfirm()` (`src/components/ui/confirm-dialog.tsx`, `variant: "danger"`). Prohibido `window.confirm`.
- **Modales:** `ModalShell` (`src/components/ui/modal-shell.tsx`, `<dialog>` nativo con foco, Escape y `aria-labelledby`). No crear overlays `fixed inset-0` nuevos.
- **Estados:** carga inicial con `TableSkeleton`/`CardsSkeleton` (reservan altura, evitan CLS); error con `ModuleState type="error" action={{ label: "Reintentar" }}`; vacío con `type="empty"` y CTA cuando el rol pueda actuar.
- **Rutas especiales:** `(dashboard)/loading.tsx`, `error.tsx`, `not-found.tsx` y `sin-acceso/page.tsx` ya existen; `app/not-found.tsx`, `error.tsx`, `global-error.tsx` cubren fuera del dashboard. Textos en español con tildes.
- **Sesión:** `getCurrentSession` está envuelto en `React.cache` y Better Auth usa `cookieCache` (5 min): no volver a consultar la sesión a mano.

## Sprint actual y progreso

Ver `.claude/SPRINT.md` para el estado actual de tareas por agente.

**Integración Siigo (vigente):** la factura de venta se crea directamente en Siigo como borrador vía API (`POST /v1/invoices`, `stamp.send=false`), un superior la estampa en el portal y el sistema sincroniza el consecutivo. Flujo completo en `docs/flujo-siigo-api.md`. El export Excel queda como respaldo manual.

**Fuente de verdad del plan:** `../galcomex-sistema-requerimientos.md` (en raíz de `/Galcomex`)
**Excels de referencia:** `../GRUPO E PAPIS 2026 (1).xlsm` y `../MODELO RELACION SIXTEAM (1).xlsm`. Para el caso SOCIO_LM Lucho (Sprint 11): `documentos referencia /BAQ-18453 ... .xls` y `documentos referencia /GRUPO E PAPIS 2026.xlsm`.

**Pendientes/diferidos:** ver `.claude/PENDIENTES.md` (alcance OUT, pasos de deploy manual, tests pre-existentes a sanear).
