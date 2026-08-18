# Pendientes — Galcomex

> Registro vivo de lo que quedó **fuera de scope** o **diferido** al cierre de Sprint 11 (2026-06-25, entrega final flujo Lucho/SOCIO_LM). Cada item indica origen, decisión y siguiente acción cuando aplique.

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

## G. Hallazgos de la auditoría de la reunión 1-jul-2026

> Origen: `docs/reuniones/2026-07-01-auditoria-vs-codigo.md` — auditoría minuto a minuto de la demo contra el código real.
>
> **Estado (2026-08-17): G1 a G6 resueltos.** Sigue abierto G7 (falta especificación) y G9 (verificación con BD, bloqueante para go-live). Cada punto conserva abajo el contexto original y cierra con lo que se hizo.

### Variables de entorno nuevas (configurar antes de desplegar)

| Variable | Para qué | Si falta |
|---|---|---|
| `WEBHOOK_N8N_URL` | Destino de los 5 eventos firmados | No se emite nada (no-op silencioso) |
| `WEBHOOK_SECRET` | Secreto HMAC-SHA256 de la firma | No se emite nada |

El consumidor valida con la cabecera `X-Galcomex-Signature` (`sha256=<hex>`) y `X-Galcomex-Timestamp`, firmando `"<timestamp>.<body>"`. Ventana de tolerancia: 5 minutos.

`cartera.vencida` no se emite solo: n8n debe invocar `POST /api/cartera/alertas/notificar` en agenda (diaria basta).

### G1. 🔴 Solo ADMIN puede registrar anticipos — no hay separación de funciones
**Detalle:** `POST /api/anticipos` exige `requireRole(["ADMIN"])`. En la reunión (min 00:04) se demostró el flujo contrario: *"ellos pueden montar el anticipo, pero los que definen si entró a la cuenta son ustedes"*. Hoy quien crea el anticipo es el mismo rol que lo verifica → el control de cuatro ojos que motivó toda esa discusión no existe. Además **contradice la matriz de roles de `CLAUDE.md`**, que asigna "Registrar anticipos/pagos" también a OPERATIVO.
**Por qué no se cambió:** ampliar autorización es una frontera de seguridad y hay ambigüedad real sobre quién es "ellos" — existen dos cuentas (`lucho@` OPERATIVO y `luismartinez@` SOCIO) cuya relación ya estaba marcada como dudosa en A1.
**Siguiente acción:** Camila confirma (a) si Lucho y Luis Martínez son una persona o dos cuentas a propósito, y (b) qué rol debe poder registrar anticipos. Luego alinear código y matriz de `CLAUDE.md` (hoy discrepan).

**RESUELTO (2026-08-17).** Registrar un anticipo vuelve a ser ADMIN u OPERATIVO, alineado con la matriz de `CLAUDE.md`. La verificación NO se tocó: ya reservaba a ADMIN los clientes SOCIO_LM, que es donde importa el control de cuatro ojos — restringirla del todo habría sido una regresión para los clientes propios. Con eso el flujo del min 00:04 queda posible: OPERATIVO monta, ADMIN verifica los de Lucho. Se añadió además `AuditLog` a la creación de anticipos, que no lo tenía pese a ser movimiento de dinero.
**Sigue abierto (menor):** confirmar con Camila si `lucho@` y `luismartinez@` son la misma persona.

### G2. 🔴 Webhooks: existe 1 de 5, sin firma HMAC
**Detalle:** `CLAUDE.md` documenta 5 eventos firmados HMAC-SHA256 (`do.creado`, `do.enviado_a_facturar`, `factura.aprobada`, `factura.facturada`, `cartera.vencida`). En todo el repo existe **un solo** webhook: el de PSE (`api/tramites/[id]/pse-token/route.ts`). `createHmac`/`HMAC`/`sha256` **no aparecen en ningún archivo** fuera de `node_modules`. La URL de n8n está hardcodeada como fallback en el fuente y el envío es fire-and-forget.
**Impacto:** las alertas de saldo de trámite y cartera por cliente ya calculan y exponen el dato tras este sprint, pero **no tienen canal de entrega**. Las promesas de la reunión de alertar a Camila (min 00:59) y a Guillermo (min 01:14) no se cumplen hoy: solo se ven entrando a la aplicación, que es justo lo que Guillermo quería evitar.
**Siguiente acción:** decidir canal (WhatsApp vía n8n / correo / solo in-app), y si se implementan webhooks, agregar la firma HMAC que la documentación ya promete y sacar la URL a variable de entorno sin fallback hardcodeado.

**RESUELTO (2026-08-17).** Infraestructura propia en `src/lib/webhooks/`: firma HMAC-SHA256 sobre `"<timestamp>.<body>"` (anti-replay), comparación en tiempo constante, URL y secreto desde entorno sin fallback hardcodeado, y no-op silencioso si no hay configuración. Los 5 eventos se emiten desde su punto real, siempre fuera de transacción. El webhook PSE pasó a usarla conservando la forma de su payload (hay un flujo n8n en producción esperándolo).

### G3. 🟠 Un pago no puede cubrir facturas de dos DOs — límite de modelo de datos
**Detalle:** pedido de Karina (min 00:48–00:50): ver *todas* las facturas impagas de un cliente y pagar varias de DOs distintos en una sola transacción. Hoy `listarPorTramite(id)` es la única vía y **`PagoTramite.tramiteId` es obligatorio**: un pago pertenece a exactamente un trámite. No es un ajuste de UI.
**Opciones de rediseño (elegir una, ambas requieren migración):**
1. Hacer `tramiteId` opcional y derivar los trámites desde las facturas vinculadas — impacta todos los cálculos de saldo por trámite y el motor de factura.
2. Introducir un concepto de "lote de pago" que agrupe pagos por trámite bajo un mismo comprobante.

**RESUELTO (2026-08-17).** Se eligió la opción 2 (lote de pago). `LotePago` + `PagoTramite.loteId`: se sigue creando un pago por trámite —los saldos por DO no se mueven, y los casos dorados lo confirman— y el lote comparte comprobante, fecha, canal y referencia bancaria. El costo bancario se cobra una sola vez. Incluye listado de facturas impagas por cliente y el flujo de UI de Karina.

### G4. 🟠 "Enlace público" de documentos no existe (y no debería construirse sin decisión)
**Detalle:** en min 01:29 se mostró "descargar, compartir o en un **enlace público**". El storage solo emite URLs prefirmadas con **tope duro de 15 minutos** (`MAX_PRESIGNED_URL_EXPIRY_SECONDS`; `normalizeExpiry` lanza si se excede). Un enlace público permanente violaría la invariante de seguridad del proyecto.
**Siguiente acción:** definir si basta el prefirmado corto o se quiere un enlace durable, y con qué control de acceso y caducidad.

**RESUELTO (2026-08-17).** En vez de un enlace público permanente, enlace con token propio: al abrirlo se valida vigencia y revocación y recién ahí se emite una URL prefirmada corta. Caduca solo (7 días por defecto, 30 de techo), se revoca, cuenta aperturas y registra quién lo creó. La ruta de apertura es el único endpoint sin autenticación y responde igual ante token inexistente, expirado o revocado.

### G5. 🟠 No hay vista documental por cliente
**Detalle:** requisito explícito de Guillermo (min 01:15): *"va a poder acceder **por cada cliente** cuáles son los documentos"*. Los documentos se indexan **solo por trámite** (`api/tramites/[id]/documentos/`); no hay API ni vista agregada por cliente. Se llega a ellos navegando trámite por trámite.
**Relacionado:** en min 01:29 el propio Ernesto reconoció que falta replicar la nomenclatura y estructura de carpetas de Galcomex. Sigue pendiente que Camila comparta esa estructura.

**RESUELTO (2026-08-17).** `GET /api/clientes/[id]/documentos` agrega los documentos de todos los trámites del cliente, con su DO de origen, filtros y paginación, más la vista en el detalle del cliente. El scoping del rol SOCIO reutiliza el criterio ya existente.

### G6. ⚠️ ¿BL + Factura Comercial para todos los clientes?
**Detalle:** en min 00:01 Guillermo pidió extenderlo más allá del socio: *"Sí, **para todos**. Para todos."*. Se implementó server-side **solo para SOCIO_LM** deliberadamente: extenderlo a clientes PROPIO bloquearía el flujo diario de Camila, y ella no fue quien lo pidió.
**Matiz técnico:** el gate del servidor actúa en la **transición de estado** (junto al checklist y Litoplas), no en la creación. Un POST directo crea el DO "cascarón" pero este no puede salir de APERTURA. La UI sí bloquea al crear.
**Siguiente acción:** decisión de Camila + Guillermo juntos.

**RESUELTO (2026-08-17).** El alcance es ahora el parámetro `DOCUMENTOS_OBLIGATORIOS_ALCANCE` (`SOCIO_LM` por defecto, `TODOS` para lo que pidió Guillermo). Queda listo para activarse sin tocar código cuando Camila y Guillermo lo decidan juntos.

### G7. ⏸️ Reglas de revisión por cliente (caso Polired / orden de compra)
**Detalle:** min 00:56 — con Polired la factura se revisa contra la orden de compra, no contra los pagos. **"Polired" no aparece en ningún archivo del código** y no existe modelo de datos de orden de compra ni reglas de revisión por cliente.
**Bloqueado por:** falta especificar de dónde sale la orden de compra y qué se compara exactamente.

### G8. Valores finales de los umbrales sembrados
Los 4 umbrales quedaron como **parámetros editables** con defaults tomados de lo discutido, no como constantes. Galcomex debe fijar los definitivos desde Configuración:
| Parámetro | Default sembrado |
|---|---|
| `UMBRAL_DESVIACION_PAGO_PCT` | 10 |
| `UMBRAL_SALDO_TRAMITE_ALERTA` | 200.000 COP |
| `UMBRAL_CARTERA_CLIENTE_ALERTA` | 20.000.000 COP |
| `ANTICIPO_SOPORTE_OBLIGATORIO` | `false` |
| `PAGO_COMPROBANTE_OBLIGATORIO` | `false` |
| `PSE_TOKEN_VIGENCIA_SEGUNDOS` | 1800 (enlace) |
| `PSE_CODIGO_VIGENCIA_SEGUNDOS` | 30 (código) |

### G9. Verificación de integración pendiente (BLOQUEANTE para go-live)
**Detalle:** el sprint se desarrolló **sin PostgreSQL disponible**. De 330 tests, **92 se auto-skipean** por requerir BD, y cubren justo los servicios modificados: `facturas-proveedor` (20 skip / 0 pass), `cartera` (19/6), `pagos` (14/0), `borradores` (6/0), `anticipos` (4/2), `documentos` (3/0).
**Verificado sí:** tsc limpio, lint sin regresión, casos dorados 79/79 con tolerancia 0, y los tests unitarios puros nuevos de cada regla (+67 tests).
**Siguiente acción obligatoria:** correr la suite completa con PostgreSQL levantado antes de go-live.

### G10. Lección de proceso — trabajo concurrente en un working tree compartido
Durante este sprint un `git stash` ejecutado por un proceso concurrente revirtió 27 archivos (1520 líneas) de golpe. Se recuperó del stash sin pérdida y se blindó con un commit checkpoint inmediato.
**Regla para futuros sprints multi-agente:** aislar cada línea de trabajo en su propio git worktree, o prohibir explícitamente todo comando git que modifique árbol o índice (`checkout`, `restore`, `stash`, `reset`, `clean`). "Revertir" debe significar reescribir el archivo, nunca usar git.
