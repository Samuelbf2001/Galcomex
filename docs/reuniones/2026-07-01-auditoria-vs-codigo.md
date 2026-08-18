# Auditoría minuto a minuto — Reunión 1-jul-2026 vs. código real

> **Fuente:** `docs/reuniones/2026-07-01-demo-modulos-sistema.md` (1h58m51s, demo con pantalla compartida)
> **Código auditado:** rama `claude/latest-meeting-transcript-c52ydo`, base `0f1d06e` (idéntica a `master`)
> **Fecha de auditoría:** 2026-08-17

## Método

La reunión fue una demo en vivo módulo por módulo. Al auditar, lo decisivo no es *si el tema se mencionó*, sino **en qué modo verbal se afirmó**. Se clasificó cada afirmación en tres categorías, porque el riesgo de cada una es distinto:

| Modo | Ejemplo textual | Riesgo |
|---|---|---|
| **DEMOSTRADO** — presente, mostrado en pantalla | "mira que yo trato de crear un DO y no me deja avanzar" | **Alto.** El cliente cree que ya lo tiene. Si no está en código, es una brecha de expectativa. |
| **PROMETIDO** — futuro, ofrecido | "podríamos alertar a María Camila", "se puede hacer" | Medio. Es alcance comprometido, no entregado. |
| **ABIERTO** — se dejó a decisión | "eso va más de una política que ustedes establecen" | Bajo, pero bloquea si nadie decide. |

Cada afirmación se verificó leyendo el código, no la documentación del proyecto. Donde `CLAUDE.md` y el código discrepan, **manda el código** y la discrepancia se reporta.

---

## Resumen ejecutivo

De los 12 módulos/temas recorridos, el sistema cumple lo demostrado en la gran mayoría. Los problemas se concentran en **tres brechas estructurales** que no se ven en una demo:

| # | Hallazgo | Severidad | Estado |
|---|---|---|---|
| 1 | Solo ADMIN puede registrar anticipos → la separación de funciones "uno monta, otro verifica" que se demostró verbalmente **no existe** | 🔴 Crítico | Escalado a decisión |
| 2 | De 5 webhooks documentados, **existe 1** (PSE) y va **sin firma HMAC** → las alertas prometidas a Guillermo y Camila **no tienen canal de entrega** | 🔴 Crítico | Escalado |
| 3 | La exigencia de BL + Factura Comercial vive **solo en el cliente React** → bypasseable por API | 🔴 Crítico | Corregido este sprint |
| 4 | Un pago no puede cubrir facturas de dos DOs distintos (`PagoTramite.tramiteId` obligatorio) → el pedido de Karina requiere cambio de modelo de datos, no de UI | 🟠 Alto | Escalado |
| 5 | "Enlace público" de documentos no existe; el storage tope duro a 15 min por invariante de seguridad | 🟠 Alto | Escalado |
| 6 | No hay vista documental **por cliente**; los documentos se indexan solo por trámite | 🟠 Alto | Escalado |
| 7 | Vigencia del código PSE: se demostró "30 segundos", el código lo dejaba visible indefinidamente | 🟡 Medio | Corregido este sprint |

---

## Auditoría minuto a minuto

### 00:00–00:05 · Trámites: estados, filtros, checklist, roles

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:00 | "cada trámite pueda tener un estado que pueda ser modificado… de enviado a facturar pasarlo a facturado" | DEMOSTRADO | `EstadoTramite` (9 estados) + `EstadoLog` con usuario y timestamp, `schema.prisma:139-203` | ✅ Cumple |
| 00:00 | "esta vista tablero es lo que acabo de mostrar" | DEMOSTRADO | `components/tramites/kanban-tramites.tsx` | ✅ Cumple |
| 00:00 | Filtros "por estados, clientes, ciudades, tipo de importación, si ya está facturado" | PROMETIDO | `estado`/`ciudad`/`clienteId`/`q` ya existían. **`facturado` se agregó este sprint.** `tipo de importación` no existe como campo. | 🔧 Parcial |
| 00:01 | "trato de crear un DO y no me deja avanzar" sin BL ni Factura Comercial | **DEMOSTRADO** | La regla estaba **solo en React** (`tramites-workspace.tsx:254-265`); `tramiteCreateSchema` no la tenía y un POST directo la evadía. **Corregido este sprint** con `faltanDocumentosObligatorios` (`lib/tramites/service.ts:114`), aplicada en la **transición de estado** junto al checklist y la regla Litoplas, y **no** evadible con `bypassChecklist`. **Matiz:** el gate del servidor actúa un paso después que el de la UI — un POST directo todavía crea el DO "cascarón", pero este no puede salir de APERTURA. Defendible (permite adjuntar los documentos al DO ya creado), pero no es paridad exacta con lo demostrado. | 🔴→✅ con matiz |
| 00:01 | "Sí, **para todos**. Para todos" (extender BL+FC a todo cliente, no solo socio) | Pedido explícito de Guillermo | Hoy aplica solo a `SOCIO_LM`. **No implementado a propósito**: extenderlo bloquearía el flujo diario de Camila con clientes PROPIO, y ella no fue quien lo pidió. | ⚠️ Decisión |
| 00:01 | "ahí queda como tarea definir esas pregunticas" (cuestionario que determina documentos por tipo de importación) | ABIERTO, autodeclarado tarea | No existe. Ya estaba diferido en `PENDIENTES.md` B2 ("lo define el papá de Camila"). En min 01:51 se repite la ambigüedad: Ernesto afirma "los documentos que se requieran **ya están definidos**" y en la misma frase le corrigen "**Esa es la tarea que tenemos**". La lista sigue sin definirse. | ⏸️ Bloqueado por especificación |
| 00:02 | "acá abajito me dice usuario administrador" | DEMOSTRADO | `components/layout/sidebar.tsx:123` "Rol activo: {rol}" + nav filtrada por rol (`:93`) | ✅ Cumple |
| 00:02 | "a la vista de Luis no va a permitir crear un DO de un cliente de Galcomex" | DEMOSTRADO | Scoping SOCIO en `api/tramites/route.ts:62,73` y `[id]/route.ts:33` | ✅ Cumple |
| 00:02 | "él no va a poder [aprobar borradores] porque tiene que pasar una aprobación de Camila" | DEMOSTRADO | `api/borradores/[id]/route.ts:48` → aprobar exige `["REVISOR","ADMIN"]`; SOCIO excluido | ✅ Cumple |

### 00:03–00:07 · Anticipos: verificación bancaria y flujo de aprobación

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:03 | "estos anticipos también van a tener un verificado" | DEMOSTRADO | `Anticipo.verificadoBanco` + `POST /api/anticipos/[id]/verificar` | ✅ Cumple |
| 00:04 | **"ellos pueden montar el anticipo, pero los que definen si entró a la cuenta son ustedes"** | **DEMOSTRADO** como flujo vigente | `POST /api/anticipos:42` → **`requireRole(["ADMIN"])`**. Ni SOCIO ni OPERATIVO pueden crear un anticipo. Verificar es ADMIN/OPERATIVO. **Quien crea es el mismo rol que verifica: no hay separación de funciones.** Además contradice la matriz de `CLAUDE.md`, que da a OPERATIVO "Registrar anticipos/pagos". | 🔴 **No cumple** |
| 00:04 | "hay anticipos que no tienen soporte… sería una obligación de que se suba el soporte para poder continuar" | PROMETIDO, luego matizado | `soporteKey` era opcional sin control. **Este sprint:** obligatoriedad conmutable vía parámetro `ANTICIPO_SOPORTE_OBLIGATORIO` (arranca en `false`, como se acordó). | 🔧 Implementado |
| 00:05 | "yo lo verifico por el número de la cuenta o el nombre… simplemente pongo verificar" | DEMOSTRADO (proceso humano) | Correcto por diseño: el sistema guarda el flag, no automatiza la conciliación bancaria. | ✅ Cumple |
| 00:06 | "es un flujo como de aprobación, como si fuera un pago. Yo lo monto y allá otro lo aprueba" | PROMETIDO | Estructuralmente imposible hoy por el hallazgo #1 (solo ADMIN crea). | 🔴 Bloqueado |
| 00:07 | "aplicación de anticipos a uno o más trámites… anticipo de 10 millones, a este DO solo 5" | DEMOSTRADO | `AplicacionAnticipo` con `montoAplicado` (`schema.prisma:332-342`) | ✅ Cumple |

### 00:07–00:15 · Libro de pagos, pago sin factura, Lucho como proveedor

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:07 | Proveedores como catálogo, creables al vuelo | DEMOSTRADO | `Beneficiario` + `POST /api/beneficiarios` (ADMIN/OPERATIVO) | ✅ Cumple |
| 00:08 | "el concepto puede estar relacionado a estos ítems que son los de Siigo" | DEMOSTRADO | `FacturaProveedor.siigoProductoId` → `SiigoProducto` | ✅ Cumple |
| 00:08 | "primero se monta la factura y luego se va al pago" (factura ≠ pago) | DEMOSTRADO | `FacturaProveedor` y `PagoTramite` separados, unidos por pivote N↔N `PagoTramiteFactura` | ✅ Cumple |
| 00:09 | "va a haber un parámetro" de tolerancia por pagos en dólares | PROMETIDO | Existía `±10%` **hardcoded y solo en cliente** (`libro-pagos.tsx:~821`). **Este sprint:** parámetro `UMBRAL_DESVIACION_PAGO_PCT` + validación server-side. | 🔧 Implementado |
| 00:10 | "van a aparecer todas las facturas que ya registraron… seleccionarla una, dos, tres del mismo proveedor" | DEMOSTRADO | Multiselect real (`libro-pagos.tsx:636`), pero **acotado a un solo trámite** (`listarPorTramite`) | ⚠️ Parcial — ver 00:48 |
| 00:10 | "en el caso de socio Luis permite crear un pago sin factura" | DEMOSTRADO | `PagoTramiteFactura` es pivote opcional + `PagoTramite.viaSocio` | ✅ Cumple |
| 00:11 | "si las facturas son de 100.000 y trato de pagar 150.000, me alerta" | DEMOSTRADO | Ver 00:09 — ahora sí es regla de servidor, no solo diálogo de UI | 🔧 Reforzado |
| 00:12–00:14 | Lucho tratado como proveedor para desligar su anticipo de las facturas que paga desde su cuenta | DEMOSTRADO | `viaSocio` + pivote opcional; documentado en `CLAUDE.md` | ✅ Cumple |

### 00:15–00:20 · PSE: token, WhatsApp, comprobantes

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:16 | "les va a salir el token y les va a decir: esto tiene una duración de 60 segundos… aquí no son 60, **son 30**" | **DEMOSTRADO** | El **enlace** expiraba a 30 **minutos** (`pse-token/route.ts:16`) y el **código**, una vez recibido, quedaba en pantalla **sin expirar** (`libro-pagos.tsx:653-667`, sin countdown). Lo demostrado no existía. **Este sprint:** vigencia real del código con countdown, parámetro `PSE_CODIGO_VIGENCIA_SEGUNDOS` (30s). | 🟡→✅ |
| 00:16 | Notificación por WhatsApp con link para aprobar el pago | DEMOSTRADO | `pse-token/route.ts:43` → POST a webhook n8n. **Sin firma HMAC** y con URL de n8n **hardcodeada** como fallback (`:10-12`). | ⚠️ Cumple con reservas |
| 00:17 | "el enlace es único, un enlace por cada solicitud. Si se venció tiene que volver a mandar otro" | DEMOSTRADO | `PseSolicitud.token` único + `respondidaAt` invalida reuso (`api/pse/[token]/route.ts:32-34,66-68`) + expiración (`:28-30`) | ✅ Cumple |
| 00:18 | "triple encriptación: WhatsApp, el token y el enlace" | DEMOSTRADO | Código PSE cifrado AES-256-GCM (`lib/crypto/pse`, campo `codigoPseEnc`) | ✅ Cumple |
| 00:19–00:20 | Dos comprobantes (banco + comercio); se acuerda que el de comercio quede **opcional** | ABIERTO → resuelto en reunión | `documentoId` nullable; el wizard PSE sí exige soporte antes de cerrar (`libro-pagos.tsx:1097`) | ✅ Coherente con lo acordado |

### 00:20–00:27 · Facturas en dólares y TRM

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:22 | "lo que estamos contabilizando es lo que **realmente se pagó**, no lo que dice la factura" | DEMOSTRADO como criterio | `PagoTramite.valor` (BigInt COP) es independiente del `FacturaProveedor.valor` | ✅ Cumple |
| 00:24 | "**abren un campo y se coloca la tasa con que se pagó**" | PROMETIDO explícito | No existía ningún campo de TRM. **Este sprint:** `moneda` + `valorDivisa` (BigInt, centavos) + `tasaCambio` (string, precisión exacta), validados en conjunto. `valor` COP sigue siendo la fuente de verdad. | 🔧 Implementado |
| 00:26 | "tú subes la factura… y cuando subes el comprobante tienes que poner cuánto pagó" | DEMOSTRADO | El valor del pago siempre fue capturado aparte del de la factura | ✅ Cumple |
| 00:27 | "queda esa definición cuando yo tenga todo el tema de TRMs claro" | ABIERTO, autodeclarado | Los campos quedan listos; la política de TRM la define Galcomex | ⏸️ Correctamente abierto |

### 00:27–00:33 · Alertas de saldo por trámite y cruce entre DOs

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:27 | "anticipo 34.172 pero se han pagado 34.884… costo bancario… cuánto queda" | DEMOSTRADO | `motor-factura.ts` + libro de pagos; costos desde `MatrizPago`/`MatrizRecaudo` | ✅ Cumple |
| 00:27 | "yo podría tener una alerta ahí… a este trámite se le acabó la plata" | PROMETIDO | No existía. **Este sprint:** alerta de saldo por trámite con umbral `UMBRAL_SALDO_TRAMITE_ALERTA` (default 200.000 COP). | 🔧 Implementado |
| 00:29 | "le ponemos un rango… **eso va más de una política que ustedes establecen**" | **ABIERTO** | Por eso se implementó como **parámetro editable**, no constante. El número final lo fija Galcomex. | ✅ Diseño correcto |
| 00:28–00:30 | El sistema **no** reasigna anticipos entre trámites; respeta lo que el cliente destinó a cada uno | DEMOSTRADO como regla | `AplicacionAnticipo` exige monto explícito por trámite; no hay reasignación automática | ✅ Cumple |
| 00:32 | "me voy a cartera, selecciono grupo de papis, puedo seleccionar fecha y veo el saldo" | DEMOSTRADO | Módulo cartera con filtro por cliente y rango de fechas | ✅ Cumple |

### 00:33–00:43 · Facturación: conceptos Siigo, envío, restricción de tercero

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:34 | "estas facturas van a poderse cargar directamente a Siigo. María Camila presiona un botón y aparece en Siigo como borrador" | DEMOSTRADO/PROMETIDO | `POST /v1/invoices` con `stamp.send=false` (`lib/siigo/client.ts:265-269`) + `siigoDraftId`/`enviadoASiigoEn` | ✅ Cumple |
| 00:34 | "conceptos de Siigo con su nomenclatura y su código" | DEMOSTRADO | `SiigoProducto` (código, grupo contable, clasificación IVA) + pivote de impuestos | ✅ Cumple |
| 00:40 | "aquí mire que **no me permite, me sale un bloqueo**… porque el proveedor es distinto" | **DEMOSTRADO en vivo** | `lib/borradores/lineas-service.ts:64` — "Una línea solo puede vincular facturas del mismo proveedor/beneficiario" | ✅ **Cumple exactamente** |
| 00:41 | "el 4x1000 lo calculamos nosotros y **siempre va al Banco de Occidente**, indicación de Jorge" | DEMOSTRADO como regla | `resolverNit4x1000` retorna NIT `890300279` de forma incondicional; parámetro `NIT_BANCO_4X1000`; beneficiario sembrado | ✅ Cumple |
| 00:42 | "estos son los ingresos para tercero. Acá los ingresos operacionales" | DEMOSTRADO | `SeccionLinea { TERCEROS, OPERACIONAL }` en `LineaRevision` | ✅ Cumple |
| 00:46 | "las dos comisiones que él coloca" (400.000 de factura vs. mínima del acuerdo) | DEMOSTRADO | Separación real: `BorradorFactura.comision` (factura) vs `comisionInternaLM` (cruce interno). Caso dorado BAQ-18453 lo cubre. | ✅ Cumple |

### 00:43–00:53 · Resistencia al cambio y pago multi-factura (pedido de Karina)

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:45 | "con el proceso de él no se puede, por el tema de que él divide la factura" (no se automatiza el borrador de Lucho) | Limitación **asumida** en reunión | Coherente: el sistema no infiere el desglose manual de Lucho | ✅ Honesto y cumplido |
| 00:48–00:50 | "podemos habilitar que en pagos no solo aparezcan las facturas de un trámite, sino **todas las facturas no pagadas de un cliente**… que seleccione las de dos DOs distintos y se carguen en un solo pago" | PROMETIDO ("se puede trabajar algo") | **No existe.** `listarPorTramite(id)` es la única vía. Y `PagoTramite.tramiteId` es **obligatorio**: un pago que cubra facturas de dos DOs es **estructuralmente imposible** sin cambiar el modelo de datos. No es ajuste de UI. | 🟠 **No cumple — requiere rediseño** |

### 00:53–01:02 · Revisión del borrador y aprobación

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 00:54 | "se hace el análisis de los cruces… me estás pagando cero y lo facturado fue 246, por proveedor" | DEMOSTRADO | `lib/borradores/cruce-facturas.ts` + `api/borradores/[id]/cruce-facturas` + UI revisor | ✅ Cumple |
| 00:55 | "eso debe dar siempre cero" | DEMOSTRADO como criterio | El cruce compara Σ facturas vs Σ pagos por proveedor | ✅ Cumple |
| 00:55 | "se selecciona aquí forma de pago" | DEMOSTRADO | `SiigoFormaPago` por borrador (`formaPagoSiigoId`), porque varía por trámite | ✅ Cumple |
| 00:57 | "este ítem ya lo cuadré, está checo. Este ítem hay observaciones" | DEMOSTRADO | `LineaRevision.aprobada` + `observacion` por línea | ✅ Cumple |
| 00:56 | "con Polired la revisión es contra la orden de compra que ellos mandan" | PROMETIDO ("literal pequeñitas cosas de cada cliente") | **"Polired" no aparece en ningún archivo del código.** No hay reglas de revisión por cliente ni modelo de orden de compra. | ⏸️ No existe — subespecificado |
| 00:58 | "puede haber dos aprobadores… Camila principal, pero [Guillermo] podría entrar y aprobar" | PROMETIDO | **Ya existía:** `requireRole(["REVISOR","ADMIN"])` permite a ambos aprobar, con trazabilidad en `aprobadoPorId`/`fechaAprobacion` | ✅ Ya cumplía |
| 00:58 | "se gasta un consecutivo" al aprobar (preocupación de Guillermo) | Preocupación planteada | **Preocupación infundada por diseño:** `stamp.send=false` crea un DRAFT; el consecutivo definitivo llega cuando un superior estampa en el portal y se sincroniza (`sincronizar-factura-service.ts`). Aprobar no quema consecutivo DIAN. | ✅ Resuelto por diseño |
| 00:59–01:01 | "podríamos **alertar a María Camila**"; "en el grupo me pone facturas revisadas, hay observaciones" | PROMETIDO | **No existe canal.** Ver hallazgo #2: el único webhook del sistema es el de PSE. | 🔴 No cumple |

### 01:02–01:10 · Comprobante obligatorio y caso Banco de Occidente

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 01:02 | Estudio de tiempos: 15–20 min por factura hoy, meta ~5 min | Dato de negocio | No verificable por código (métrica operativa) | — |
| 01:04 | "el pago va relacionado sí o sí con el documento que monten" | DEMOSTRADO | **Inexacto:** `documentoId` es nullable y la validación Zod lo tenía `optional()`. **Este sprint:** parámetro `PAGO_COMPROBANTE_OBLIGATORIO` (default `false`) + marca consultable de "pago sin comprobante". | 🟡→🔧 |
| 01:05–01:07 | Karina paga por Occidente: proceso de 3 pasos entre dos personas, sin "toque" equivalente | ABIERTO, autodeclarado "tendremos que mirarlo a detalle" | No hay lógica diferenciada por banco. Correctamente abierto. | ⏸️ Pendiente de análisis |
| 01:08 | Tres caminos para que Karina no posponga el comprobante; **se elige no obligar al inicio** | ABIERTO → resuelto | Implementado como alerta conmutable, exactamente como se decidió | ✅ Coherente |

### 01:10–01:15 · Cartera, conciliación y alertas

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 01:10 | "que quede rastreado… Camila cambió el estado tal día a tal hora" | DEMOSTRADO | `EstadoLog` + `AuditLog` con snapshots antes/después | ✅ Cumple |
| 01:11 | "coger todos los DOs del mismo cliente y realizar el cruce" | DEMOSTRADO | `lib/cartera/service.ts` + estado de cuenta | ✅ Cumple |
| 01:12 | Dos vistas: contra el cliente y contra Luis | DEMOSTRADO | `VistaMode = "cliente" \| "lm"` (`cartera-workspace.tsx:49`) + saldos separados en `Factura` | ✅ Cumple |
| 01:12 | Seleccionar dos DOs, conciliar en un trámite, adjuntar comprobante y verificar banco | DEMOSTRADO | `conciliar-lote-modal.tsx` + `api/cartera/conciliar-lote` + tests dedicados | ✅ Cumple |
| 01:13 | "cuando ya se concilie… dice ya está conciliado / saldada" | DEMOSTRADO | `fechaPagoCliente`/`fechaPagoLM` se setean al llegar el saldo neto a 0 | ✅ Cumple |
| 01:12 | "cuando se le pide una relación de cartera" (exportable) | DEMOSTRADO | `api/cartera/export` (Excel) + `api/cartera/pdf` + `estado-cuenta-pdf.tsx` | ✅ Cumple |
| 01:14 | "**alertar cuando el cliente esté bajo menos 20 millones**… mandarla al señor Guillermo" | PROMETIDO | Cálculo **implementado este sprint** (umbral `UMBRAL_CARTERA_CLIENTE_ALERTA`, default 20.000.000 COP) + `api/cartera/alertas`. **Pero el envío a Guillermo no tiene canal** (hallazgo #2). | 🔧 Calculado / 🔴 sin entrega |

### 01:15–01:31 · Documentos, nube y cierre de alcance

| Min | Afirmación | Modo | Código | Veredicto |
|---|---|---|---|---|
| 01:15 | "cada trámite tiene su carpeta, igual que como lo tiene físico" | DEMOSTRADO | Ruta MinIO `tramites/{consecutivo}/{categoria}/{uuid}.ext` + `CategoriaDocumento` | ✅ Cumple |
| 01:15 | "lo bueno es que usted va a poder acceder **por cada cliente** cuáles son los documentos" | **DEMOSTRADO/PROMETIDO** | **No existe.** Documentos solo por trámite (`api/tramites/[id]/documentos/`). No hay API ni vista documental por cliente. | 🟠 **No cumple** |
| 01:29 | "el archivo que puedo descargar, compartir o **en un enlace público**" | **DEMOSTRADO** | **No existe.** El storage emite solo URLs prefirmadas con **tope duro de 15 min** (`MAX_PRESIGNED_URL_EXPIRY_SECONDS`, `normalizeExpiry` lanza si se excede). Un enlace público permanente **violaría** la invariante de seguridad del proyecto. | 🟠 **No cumple — y no debe construirse sin decisión** |
| 01:29 | "aquí **lo que falta** es la nomenclatura y el sistema de carpetas que ustedes tienen" | Autodeclarado pendiente | Correcto: falta replicar la estructura física de Galcomex | ⏸️ Pendiente (honesto) |
| 01:30 | "puedo visualizarlo o puedo eliminarlo… y subo nuevamente el BL" | DEMOSTRADO | Soft-delete (`Documento.eliminado`), nunca borrado físico | ✅ Cumple |
| 01:31 | "se puede restringir que el que suba para eliminar no tiene que ser cualquier persona" | PROMETIDO | **Ya cumplía:** subir permite `ADMIN/OPERATIVO/SOCIO`; eliminar solo `ADMIN/OPERATIVO`. Lucho (SOCIO) puede subir pero **no** eliminar — exactamente la asimetría pedida. | ✅ Ya cumplía |
| 01:31 | "**si el trámite se cerró no pueden modificar nada**… nadie lo puede modificar" | **DEMOSTRADO como regla** | **No existía ningún chequeo de estado `CERRADO`.** **Corregido este sprint.** | 🔴→✅ |
| 01:31 | "hasta ahí incluimos el alcance de esta primera fase" | Cierre de alcance | — | — |

### 01:32–01:58 · Infraestructura, comercial y datos históricos

Este tramo es consultoría y negociación, no funcionalidad. Se audita solo lo que toca al sistema:

| Min | Afirmación | Modo | Veredicto |
|---|---|---|---|
| 01:09–01:22 | Backup en nube (Microsoft/Google), servidor virtual, 3 copias | PROMETIDO (infra) | Fuera del código. Ya diferido en `PENDIENTES.md` B5. ⏸️ |
| 01:40 | "en esta implementación se cargaría desde 2026" | ABIERTO → decidido | Corte de datos confirmado. Existe `scripts/import-excel.ts` + `api/borradores/[id]/siigo-import`. ✅ |
| 01:41–01:44 | Cartera de Lucho 2022–2025 **fuera** del sistema; se cierra por acuerdo de pago aparte | Decidido en reunión | Correcto que no esté en el sistema. ✅ |
| 01:36 | Implementación 4.000.000 COP + 450.000/mes | Comercial | — |

---

## Hallazgos que no se ven en la tabla

### 🔴 1. Separación de funciones en anticipos: inexistente

`POST /api/anticipos:42` exige `["ADMIN"]`. Consecuencias:

- El flujo demostrado en 00:04–00:06 ("ellos montan, ustedes verifican") **no se puede ejecutar**: ni SOCIO ni OPERATIVO pueden crear un anticipo.
- Quien crea es el mismo rol que verifica → el control de "cuatro ojos" que motivó toda la discusión no existe.
- **Contradice la matriz de roles de `CLAUDE.md`**, que asigna "Registrar anticipos/pagos" también a OPERATIVO.

**Por qué no lo cambié:** ampliar autorización es una frontera de seguridad, y hay ambigüedad real sobre quién es "ellos" — el proyecto tiene dos cuentas (`lucho@` como OPERATIVO y `luismartinez@` como SOCIO) cuya relación ya estaba marcada como dudosa en `PENDIENTES.md` A1. Requiere confirmación de Camila antes de tocarlo.

### 🔴 2. Webhooks: 1 de 5, sin firmar

`CLAUDE.md` documenta 5 eventos firmados con HMAC-SHA256 (`do.creado`, `do.enviado_a_facturar`, `factura.aprobada`, `factura.facturada`, `cartera.vencida`). En todo `src/` existe **un solo** webhook: el de PSE, y además:

- **No hay firma HMAC en ninguna parte del repositorio.** `createHmac`, `HMAC` y `sha256` no aparecen en ningún `.ts`/`.tsx`/`.yml` fuera de `node_modules`. La cadena `n8n` aparece en **un solo archivo**.
- La URL de n8n está **hardcodeada** como fallback en el fuente (`pse-token/route.ts:10-12`).
- Es fire-and-forget: si n8n falla, solo se escribe en consola.

**Impacto directo:** las alertas prometidas (a Camila al aprobar, min 00:59; a Guillermo por cartera, min 01:14) tienen el cálculo listo tras este sprint pero **ningún canal de entrega**. Sin resolver esto, las alertas solo se ven entrando a la aplicación — que es exactamente lo que Guillermo quería evitar.

### 🟠 3. Pago multi-DO: límite de modelo de datos

El pedido de Karina (00:48–00:50) no es un cambio de UI. `PagoTramite.tramiteId` es un campo **obligatorio**: un pago pertenece a exactamente un trámite. Para que un solo pago cubra facturas de dos DOs hace falta una de dos decisiones de diseño:

1. Hacer `tramiteId` opcional y derivar los trámites desde las facturas vinculadas (impacta todos los cálculos de saldo por trámite y el motor de factura), o
2. Introducir un concepto nuevo de "lote de pago" que agrupe pagos por trámite bajo un mismo comprobante.

Ambas requieren análisis y migración. **No se debe improvisar.**

---

## Lo desarrollado en este sprint

Todo bajo los invariantes del proyecto: dinero en `BigInt`, sin `any`, Zod en endpoints, umbrales como parámetros editables y no constantes.

**Base compartida:**
- Migración `20260817120000_add_divisa_pago_tramite` — campos `moneda`/`valorDivisa`/`tasaCambio` en `PagoTramite`.
- 7 parámetros nuevos sembrados en `prisma/seed.ts` con los valores discutidos en la reunión como punto de partida.
- Lectores genéricos `getParametro` / `getParametroBigInt` / `getParametroNumero` / `getParametroBool` en `lib/parametros/service.ts`, tolerantes a BD sin sembrar.

**Pagos, TRM y PSE:**
- `lib/pagos/desviacion.ts` — `calcularDesviacionPct` / `excedeUmbralDesviacion`, puras y en BigInt. Preservan **exactamente** la fórmula que ya usaba el cliente, para que UI y servidor no divergan.
- Validación **server-side** de la desviación en `crearPago`, con flag explícito `confirmarDesviacion` para el caso confirmado por el operario. Antes la regla era solo un diálogo de React, evadible por API.
- `lib/pagos/divisa.ts` — regla todo-o-nada de los tres campos de divisa + `esDecimalValido`. `valor` (COP) sigue siendo la única fuente de verdad contable; la TRM solo documenta su origen.
- Vigencia real del código PSE con cuenta regresiva visible (`PSE_CODIGO_VIGENCIA_SEGUNDOS`, 30 s), incluido el caso borde de un código que el servidor ya reporta vencido.
- Marca de "pago sin comprobante" consultable, con obligatoriedad conmutable (`PAGO_COMPROBANTE_OBLIGATORIO`, arranca en `false` como se acordó).

**Trámites, documentos y anticipos:**
- Filtro `facturado` en `GET /api/tramites`, respetando el scoping del rol SOCIO.
- Documentos inmutables en trámite `CERRADO`: 409 tanto al subir como al eliminar.
- `faltanDocumentosObligatorios` (BL + Factura Comercial para SOCIO_LM), server-side y no evadible con `bypassChecklist`.
- Soporte de anticipo obligatorio conmutable (`ANTICIPO_SOPORTE_OBLIGATORIO`, arranca en `false`) y anticipos sin soporte identificables.

**Alertas:**
- `evaluarAlertaSaldoTramite` — déficit por trámite en BigInt (`deficit = max(0, pagos − anticipos)`), umbral `UMBRAL_SALDO_TRAMITE_ALERTA`. Nueva sección en el dashboard.
- `evaluarAlertaCarteraCliente` + `getClientesEnAlertaCartera()` y `GET /api/cartera/alertas` (ADMIN/REVISOR). Aplica a **ambas** vistas (cliente y LM).
- **Convención de signo:** se reutilizó la ya existente de `calcularSaldoNeto` — positivo = Galcomex debe; negativo = la parte debe a Galcomex. "Cliente bajo menos 20 millones" se implementó como `saldoNeto < -umbral`, **no** como valor absoluto: un cliente con saldo a favor nunca dispara la alerta, por grande que sea. Cubre el caso literal de los 22 M mencionado en el minuto 00:32.

### Gates al cierre

| Gate | Baseline | Ahora |
|---|---|---|
| `npx tsc --noEmit` | limpio | **limpio (exit 0)** |
| `npm run test` | 171 pass · 90 skip · 1 falla pre-existente | **238 pass · 92 skip · 1 falla pre-existente** (+67 tests) |
| `npm run lint` | 11 errores · 13 warnings | **11 errores · 13 warnings — cero regresión** |
| Casos dorados | 79/79 | **79/79, tolerancia 0 pesos** |

### Incidente de proceso

A mitad del sprint, un `git stash` ejecutado sobre el working tree compartido revirtió 27 archivos (1520 líneas) de golpe. Se recuperó completo del stash y se commiteó de inmediato como checkpoint (`e7e9b64`). **Causa raíz:** la instrucción "si rompes algo, revierte" se interpretó como revertir vía git en un árbol compartido por varios procesos. Para trabajo concurrente futuro: aislar cada línea de trabajo en su propio worktree, o prohibir explícitamente los comandos git que modifican el árbol.

---

## Limitación importante de esta verificación

**No hay PostgreSQL en el entorno de auditoría.** De 261 tests, **90 se auto-skipean** por requerir BD, y cubren precisamente los servicios modificados:

| Suite | Sin BD |
|---|---|
| `lib/facturas-proveedor/service` | 20 skip / **0 pass** |
| `lib/cartera/service` | 19 skip / 6 pass |
| `lib/pagos/service` | 14 skip / **0 pass** |
| `lib/borradores/service` | 6 skip / **0 pass** |
| `lib/anticipos/service` | 4 skip / 2 pass |
| `lib/documentos/service` | 3 skip / **0 pass** |

Lo que **sí** se verificó: compilación estricta de TypeScript, ausencia de regresión en lint, los casos dorados del motor de cálculo (DO.BUN26-0026 y BAQ-18453, tolerancia 0 pesos) y los tests unitarios puros nuevos de cada regla.

Lo que **no** se pudo verificar: las rutas de integración contra BD real de lo construido en este sprint. **Antes de go-live hay que correr la suite completa con PostgreSQL levantado.**

`src/lib/excel/__tests__/borrador-lucho.test.ts` sigue fallando por una ruta Windows hardcodeada — falla pre-existente ya registrada en `PENDIENTES.md` C1, ajena a este sprint.

---

## Decisiones pendientes de Galcomex

Ninguna de estas es técnica; todas bloquean o condicionan trabajo:

1. **¿Quién puede registrar un anticipo?** (hallazgo #1) — y aclarar si "Lucho" y "Luis Martínez" son una persona o dos cuentas a propósito.
2. **¿Se extiende la exigencia de BL + Factura Comercial a los clientes PROPIO?** Guillermo lo pidió ("para todos"); afectaría el flujo diario de Camila.
3. **Canal de alertas:** ¿WhatsApp vía n8n, correo, o solo dentro de la aplicación? Sin esto las alertas nuevas no llegan a nadie.
4. **Valores finales de los 4 umbrales** sembrados con defaults (desviación de pago, saldo de trámite, cartera por cliente, y si se activan las obligatoriedades de comprobante).
5. **"Enlace público" de documentos:** hoy el tope es 15 min por invariante de seguridad. ¿Se acepta el prefirmado corto, o se quiere un enlace durable (y con qué control de acceso)?
6. **Pago multi-DO:** cuál de las dos opciones de rediseño se toma.
7. **Reglas de revisión por cliente** (caso Polired / orden de compra): falta el modelo de datos de la orden de compra.
8. **Cuestionario de documentos por tipo de importación:** sigue pendiente de definición del papá de Camila (`PENDIENTES.md` B2).
