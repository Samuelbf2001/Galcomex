# Sistema de Gestión Operativa — Galcomex
### Documento de funcionalidades y arquitectura
**Versión:** Sprint 11 (2026-06-25)

---

## 1. Visión general

Sistema web interno single-tenant desarrollado para **Galcomex**, agencia logística de importaciones con sede en Barranquilla. Reemplaza el flujo manual de Excel → SIIGO que operaba hasta ahora, centralizando la gestión de trámites aduaneros, facturación, anticipos, pagos y cartera en una sola plataforma.

**Usuarios:** 5 personas fijas (Camila, Papá/Revisor, Karina, Lucho/Operativo, Luis Martínez/Socio).
**Clientes de Galcomex:** dos tipos — propios (`PROPIO`) y el socio Luis Martínez (`SOCIO_LM`) con lógica financiera diferenciada.

---

## 2. Stack tecnológico

| Componente | Tecnología |
|---|---|
| Framework | Next.js 15 (App Router) + TypeScript estricto |
| Base de datos | PostgreSQL 16 + Prisma ORM |
| Interfaz | Tailwind CSS + shadcn/ui + TanStack Table |
| Autenticación | Better Auth (email + password, 4 roles) |
| Storage de archivos | Bodega S3: MinIO en local, Cloudflare R2 en producción (`docs/ALMACENAMIENTO-S3.md`) |
| PDF | react-pdf / Puppeteer |
| Export Excel | SheetJS (xlsx) |
| Testing | Vitest (unitarios) + Playwright (E2E) |
| Deploy | Docker Compose en EasyPanel/Hostinger VPS |
| Automatización | n8n (webhooks firmados HMAC-SHA256) |
| Facturación electrónica | Integración API SIIGO Nube |

---

## 3. Roles y permisos

El sistema tiene 4 roles con permisos diferenciados:

| Acción | ADMIN (Camila) | REVISOR (Papá) | OPERATIVO (Karina/Lucho) | SOCIO (Luis Martínez) |
|---|:---:|:---:|:---:|:---:|
| CRUD clientes y tarifas | ✅ | | | |
| Crear y editar trámites (DOs) | ✅ | ✅ | ✅ | |
| Checklist y documentos | ✅ | ✅ | ✅ | |
| Registrar anticipos y pagos | ✅ | | ✅ | |
| Aprobar borrador de factura | ✅ | ✅ | | |
| Marcar facturado + número SIIGO | ✅ | | | |
| Ver cartera | ✅ | ✅ | | |
| Ver solo sus trámites | | | | ✅ |
| Editar parámetros del sistema | ✅ | | | |
| Gestión de usuarios | ✅ | | | |
| Configuración SIIGO | ✅ | ✅ | | |

**Usuarios del sistema (seed inicial):**
- `camila@galcomex.com` / `Galcomex2026!` — ADMIN
- `papa@galcomex.com` / `Galcomex2026!` — REVISOR
- `karina@galcomex.com` / `Galcomex2026!` — OPERATIVO
- `lucho@galcomex.com` / `Galcomex2026!` — OPERATIVO
- `luismartinez@galcomex.com` / `Galcomex2026!` — SOCIO

---

## 4. Módulos de la aplicación

### 4.1 Dashboard operativo

Pantalla de inicio con indicadores clave en tiempo real:

- **DOs por estado:** conteo de trámites en cada etapa del pipeline (Solicitud, Apertura, En Trámite, En Puerto, Despachado, Enviado a Facturar, Facturado, Pagado, Cerrado).
- **Alerta SLA facturación:** trámites en estado "Enviado a Facturar" con más de 3 días sin facturar se marcan en rojo.
- **Cartera vencida:** facturas pendientes de cobro/devolución.
- **Anticipos con saldo disponible:** listado de anticipos que aún tienen fondos por aplicar.
- **Actividad reciente:** últimas acciones registradas en el sistema.
- Cada tarjeta del dashboard enlaza directamente al módulo correspondiente con los filtros preconfigurados.

---

### 4.2 Trámites / Documentos de Operación (DOs)

El módulo central del sistema. Un **Trámite DO** representa una importación completa.

**Formato del consecutivo:** `DO.{CIUDAD}{AA}-{NNNN}` — ej. `DO.CTG26-0124`
- Generado atómicamente en transacción de BD (sin duplicados bajo concurrencia)
- Único por ciudad + año

**Ciudades disponibles:** Barranquilla (BAQ), Cartagena (CTG), Buenaventura (BUN), Santa Marta (SMR)

**Agencias de aduanas:** MOVIADUANAS, COLDEX, AR_LOGISTY

**Pipeline de estados:**
```
SOLICITUD → APERTURA → EN_TRAMITE → EN_PUERTO → DESPACHADO
  → ENVIADO_A_FACTURAR → FACTURADO → PAGADO → CERRADO
```
- Cada transición queda registrada en `EstadoLog` con usuario y timestamp.
- La transición `APERTURA → EN_TRAMITE` se bloquea si hay ítems de checklist requeridos sin marcar.
- Toda transición genera entrada en `AuditLog` con snapshot antes/después.

**Datos que se guardan por trámite:**
- Consecutivo único, ciudad, año, número
- Cliente asociado
- Proveedor cliente (opcional)
- Agencia de aduanas + número DO de agencia
- DO del cliente
- ETA (fecha estimada de llegada) — solo para clientes PROPIO
- Estado actual + historial completo de estados
- Comentarios internos
- Fechas clave: aceptación de declaración, levante, envío a facturar, documentos OK, salida de carga
- Usuario que creó el trámite + timestamp

**Para clientes SOCIO_LM (Luis Martínez):**
- BL/Guía y Factura Comercial son obligatorios al crear el DO (bloquea el formulario si no se adjuntan).
- Campo ETA oculto en el formulario de creación.

**Vistas disponibles:**
- Tabla general con filtros y búsqueda
- Detalle del DO con pestañas: Resumen / Documentos / Pagos / Facturación / Historial
- Kanban por estado
- Edición inline de fechas clave y campo `doAgencia`

---

### 4.3 Checklist de apertura

Sistema de verificación documental antes de abrir un trámite operativamente.

- Plantillas de checklist reutilizables (`PlantillaChecklist`)
- Ítems configurables: descripción, requerido/opcional, orden
- Por trámite: cada ítem se marca como recibido, registrando quién lo validó y cuándo
- La transición `APERTURA → EN_TRAMITE` queda **bloqueada** mientras exista algún ítem requerido sin recibir

---

### 4.4 Gestión de documentos

Almacenamiento y visualización de archivos adjuntos a cada trámite.

**Categorías de documento:**
- Factura Comercial
- BL (Bill of Lading)
- Packing List
- Declaración DIAN
- Soporte de Facturación
- Foto de Reconocimiento
- Comprobante Bancario
- Factura Proveedor
- Otro

**Funcionamiento:**
- Subida y descarga con enlaces firmados por la app (≤ 15 min); el navegador nunca habla con la bodega
- Ruta en el bucket: `tramites/{consecutivo}/{categoria}/{uuid}.ext`
- URLs de descarga/visualización con expiración de 15 minutos
- Soft-delete: los documentos se marcan `eliminado = true`, nunca se borran físicamente
- Formatos soportados: PDF, JPG, PNG, XLSX (máximo 25 MB)
- UI con drag & drop, visor inline y galería de fotos
- Se registra quién subió cada archivo + timestamp

---

### 4.5 Anticipos

Gestión de fondos que los clientes depositan anticipadamente a Galcomex para cubrir los gastos de sus importaciones.

**Flujo:**
1. Se registra un anticipo con monto, fecha, tipo de recaudo y comprobante bancario
2. Se aplica a uno o más trámites (`AplicacionAnticipo`)
3. La validación impide sobre-aplicar (422 si el monto aplicado supera el saldo)
4. El anticipo puede revertirse

**Regla crítica:** un trámite NO puede registrar pagos si no tiene al menos una aplicación de anticipo. El botón "Nuevo pago" aparece deshabilitado con tooltip explicativo.

**Tipos de recaudo (con costo bancario):**
| Tipo | Costo |
|---|---|
| BANCOLOMBIA (digital) | $1.950 |
| OTROS_BANCOS (digital) | $2.200 |
| SUCURSAL (físico) | $11.290 |
| CORRESPONSAL (físico) | $6.190 |
| CAJERO (físico) | $5.200 |

**Estados del anticipo:** BORRADOR → REALIZADO → VERIFICADO

**Badge visual:** si `verificadoBanco = false` se muestra badge "Pendiente verificar" en la UI. Un anticipo no verificado sigue siendo aplicable (no bloquea el flujo).

**Vista:** tabla con columnas aplicado/restante, filtro con saldo, registro de anticipos y aplicación multi-DO con validación en vivo.

---

### 4.6 Libro de pagos (Pagos a proveedores)

Registro de todos los pagos que Galcomex hace en nombre del cliente (impuestos DIAN, costos portuarios, agencias, fletes, etc.) durante la tramitación de la importación.

**Datos por pago:**
- Concepto
- Número de soporte (declaración DIAN, factura, etc.)
- Documento adjunto (comprobante)
- Valor en COP
- Canal de pago + costo bancario automático desde la matriz
- Banco beneficiario (para 4x1000)
- Fecha real de pago
- Si fue via socio (`viaSocio`)
- Estado: BORRADOR / REALIZADO / VERIFICADO
- Beneficiarios (N↔N): un pago puede repartirse entre varios beneficiarios

**Canales de pago (con costo):**
| Canal | Costo |
|---|---|
| TRANSF_BANCOLOMBIA | $3.900 |
| PSE | $0 |
| TRANSF_OTROS_BANCOS | $7.300 |

**Saldo corriente en vivo:** `saldo = Σ(anticipos aplicados) − Σ(pagos)`. Se recalcula en el cliente con BigInt al modificar cualquier dato.

**Facturas de proveedor:** cada pago puede vincularse a facturas de proveedor (N↔N via `PagoTramiteFactura`), permitiendo que un pago cubra varias facturas y viceversa.

---

### 4.7 Facturas de proveedor

Registro de las facturas que los proveedores/terceros emiten a Galcomex en el contexto de cada trámite.

**Datos por factura:**
- Proveedor (nombre/NIT) o Beneficiario vinculado del catálogo
- Producto SIIGO asociado (combobox con búsqueda por nombre/código)
- Número de factura
- Concepto
- Valor en COP
- Fecha
- PDF adjunto (opcional)

**Estados:** REGISTRADA → PAGADA → FACTURADA_CLIENTE

**Unicidad:** no puede haber dos facturas con el mismo número para el mismo trámite.

---

### 4.8 Facturación (Borrador de factura de venta)

Módulo para generar y revisar las facturas que Galcomex emite a sus clientes al cerrar un trámite.

**Flujo del borrador:**

```
BORRADOR → EN_REVISION → APROBADO → FACTURADO
```

1. **Generar borrador:** se calculan automáticamente todos los valores financieros desde el libro de pagos y anticipos.
2. **Revisión split-screen:** el revisor (papá) ve el PDF/soporte a la izquierda y los valores/líneas a la derecha. Puede aprobar/observar línea por línea.
3. **Aprobación:** solo ADMIN o REVISOR pueden aprobar.
4. **Envío a SIIGO:** se crea como borrador (`stamp.send=false`) en el portal SIIGO vía API. El superior lo estampa manualmente en el portal.
5. **Sincronización:** tras el estampado en SIIGO, el sistema obtiene el consecutivo definitivo (ej. `BAQ-18288`) y actualiza el borrador a FACTURADO, creando la `Factura` en cartera.

**Componentes del borrador:**
- Comisión de Galcomex (default $150.000, editable por factura — puede llegar a $400.000 en DOs concretos como BAQ-18453)
- IVA sobre comisión (19%)
- Impuesto 4x1000 (condicional — ver regla financiera)
- Costos bancarios totales
- Total anticipo aplicado
- Total pagos
- Total factura
- Saldo a favor/cargo del cliente
- Saldo a favor/cargo de LM (para SOCIO_LM)

**Líneas de revisión:** cada concepto del libro de pagos se convierte en una línea de revisión, pudiendo ser:
- **AUTO:** generadas automáticamente desde el libro de pagos
- **MANUAL:** escritas a mano por el revisor (especialmente para trámites del socio)

Cada línea tiene:
- Concepto + número de soporte
- Valor
- Sección: TERCEROS (ingresos pass-through) u OPERACIONAL (propios de Galcomex)
- Producto SIIGO asociado
- NIT del tercero (si aplica)
- Facturas de proveedor vinculadas (N↔N)

**Comentarios de cabecera:** formato Lucho, exportados como `observations` en SIIGO. Para SOCIO_LM se siembra automáticamente "NO PRACTICAR RETEFUENTE NI RETEICA".

**Panel de cruce pagos vs factura proveedor:** el revisor puede ver si cada factura de proveedor cuadra con los pagos registrados. Verde "Cuadra" si diferencia = 0; ámbar "Desfase" con cifras si hay diferencia. Informativo, no bloquea la aprobación.

**Snapshot de auditoría:** al aprobar, se guarda un JSON inmutable (`snapshotCalculo`) con todos los valores del cálculo para auditoría futura.

---

### 4.9 Motor de cálculo financiero

El núcleo del sistema. Función pura sin acceso a BD que replica exactamente el Excel de Galcomex.

**Reglas de cálculo (PROPIO):**
1. `costosBancarios = costoRecaudoAnticipo + Σ(costo de cada pago)`
2. `ivaComision = comision × 19 / 100` (BigInt, truncado)
3. **4x1000 CONDICIONAL:** solo si el saldo queda a favor del cliente
   - Si hay saldo a favor: base = `totalAnticipoAplicado`, tarifa = 0.4% → `impuesto4x1000 = base × 0.004`
   - Si queda a cargo del cliente: `impuesto4x1000 = 0`
4. `totalFactura = saldoPrevio − comision − ivaComision − costosBancarios − impuesto4x1000`
5. `saldoAFavorCliente = max(totalFactura, 0)`
6. `saldoACargoCliente = max(-totalFactura, 0)`

**Reglas de cálculo (SOCIO_LM — Luis Martínez):**
- Las líneas COMISION y COSTOS_BANCARIOS **no se materializan** como `LineaRevision` (deducciones internas)
- `IVA_COMISION` sí se materializa (ingreso operacional de Galcomex)
- Dos cálculos del 4x1000:
  - **Interno** (base = anticipo × 0.4%) → para el cruce con LM
  - **De factura** (base = Σ líneas TERCEROS, fórmula `(base × 4 + 500) / 1000` — BigInt round-half-up) → esta línea se envía a SIIGO
- Tercero del 4x1000 siempre es **Banco de Occidente** (NIT `890300279`)

**Todo dinero es `BigInt` (pesos colombianos enteros). Cero flotantes en cálculos financieros.**

**Tests dorados (bloqueantes en CI, tolerancia 0 pesos):**
- `DO.BUN26-0026` (PROPIO): anticipo $45.226.000, total factura $41.868.042, saldo cliente $3.357.958
- `DO.CTG26-0118 / BAQ-18453` (SOCIO_LM): anticipo $35.074.500, total factura $33.128.000, saldo cliente $1.946.500, saldo LM −$429.734

---

### 4.10 Cartera

Módulo para gestionar el cobro de facturas emitidas y las devoluciones a clientes.

**Ledger unificado por (factura, destino):**
- Destinos: CLIENTE o LM (Luis Martínez)
- `saldoNeto = (saldoAFavor − saldoACargo) + Σabonos − Σdevoluciones`
- `> 0`: Galcomex debe devolver
- `< 0`: la parte debe pagar a Galcomex
- `= 0`: saldado

**Tipos de movimiento en cartera:**
- **ABONO:** pago recibido del cliente (reduce deuda)
- **DEVOLUCION:** devolución al cliente (reduce saldo a favor)

**Por cada abono/devolución se registra:**
- Monto + fecha
- Canal (TipoRecaudo o CanalPago según dirección del dinero)
- Costo bancario (snapshot al momento del registro)
- Comprobante bancario en MinIO
- Si fue verificado contra el banco
- Usuario que lo registró

**Vista de cartera:** selector de cliente, tabla con chip de estado (Saldada / Cobrar / Devolver), valores por fila, modal "Registrar abono", botón "Registrar devolución" (solo si hay saldo a favor).

**Estados derivados:** `fechaPagoCliente` y `fechaPagoLM` se actualizan automáticamente cuando el saldo neto llega a 0.

---

### 4.11 Ingresos / Libro de bancos

Vista unificada de todos los movimientos de caja:
- Entradas: anticipos recibidos + abonos de cartera
- Salidas: devoluciones
- Saldo corrido por cliente
- Filtros por cliente y rango de fechas (en URL, compartible)

---

### 4.12 Clientes

Gestión del catálogo de clientes de Galcomex.

**Datos por cliente:**
- Nombre y NIT (único)
- Tipo: PROPIO o SOCIO_LM
- Contacto: nombre, email, teléfono
- Si maneja anticipo
- Activo/inactivo

**Tarifas por cliente:**
- Una o más tarifas por año
- Tipos: `por_contenedor`, `fijo`, `porcentaje_cif`
- Valor en COP (BigInt)

**Vista de detalle:** datos del cliente + tarifas (editar/agregar) + trámites, anticipos y facturas relacionados.

**Permisos:** solo ADMIN puede crear o editar clientes.

---

### 4.13 Configuración del sistema

Módulo administrativo con varios submódulos:

**Parámetros del sistema** (editables desde la UI por ADMIN):
| Parámetro | Valor |
|---|---|
| `COMISION_LM` | $150.000 COP (default; editable por factura) |
| `IVA_COMISION` | 19% |
| `TASA_4X1000` | 0.4% |
| `DIAS_SLA_FACTURA` | 3 días (alerta roja en dashboard) |
| `NIT_BANCO_4X1000` | 890300279 (Banco de Occidente) |
| + parámetros de SIIGO | IDs de productos, vendedor, comprobante, forma de pago |

**Gestión de usuarios** (ADMIN):
- Lista de usuarios del sistema
- Restablecer contraseña de cualquier usuario (cierra sesiones activas)
- Audita acción `RESET_PASSWORD` con snapshot

**Cambio de contraseña propio:** cualquier usuario puede cambiar su contraseña desde el ícono en el header (`/cambiar-password`).

---

### 4.14 Integración SIIGO

Integración directa con la API de SIIGO Nube para emisión de facturas electrónicas.

**Catálogos sincronizados desde SIIGO:**
- Productos (`SiigoProducto`) — con clasificación IVA y grupo contable
- Impuestos (`SiigoImpuesto`) — IVA 19%, ReteIVA, ReteICA, Retefuente, etc.
- Tipos de comprobante (`SiigoTipoComprobante`) — Factura Electrónica de Venta, POS, etc.
- Vendedores (`SiigoVendedor`)
- Formas de pago (`SiigoFormaPago`) — Contado, Crédito 30 días, etc.

**Flujo de envío:**
1. Borrador en estado APROBADO
2. Seleccionar forma de pago (contado vs crédito — varía por trámite)
3. Clic "Enviar a SIIGO" → `POST /v1/invoices` con `stamp.send=false` (crea borrador en SIIGO)
4. Superior lo estampa manualmente en el portal SIIGO
5. Clic "Sincronizar desde SIIGO" → `GET /v1/invoices/{id}` → trae consecutivo definitivo (ej. `BAQ-18288`) + fecha → borrador pasa a FACTURADO + crea `Factura` en cartera

**Trazabilidad:** se guardan `siigoDraftId`, `enviadoASiigoEn`, `ultimoErrorSiigo`, `ultimoIntentoSiigo`. Si hay error, la UI muestra el mensaje para que el ADMIN reintente.

---

### 4.15 Solicitudes PSE

Flujo para solicitar al banco el código PSE de un trámite de manera segura.

- Se genera un token único y un link para María Camila
- El código PSE se almacena cifrado en la base de datos (**AES-256-GCM**: `iv:authTag:ciphertext`)
- El link tiene fecha de expiración
- Se registra cuándo fue respondida la solicitud

---

## 5. Modelo de base de datos

### Tablas principales

| Tabla | Descripción |
|---|---|
| `user` | Usuarios del sistema (5 fijos) |
| `session` | Sesiones activas (Better Auth) |
| `account` | Cuentas de autenticación |
| `verification` | Tokens de verificación |
| `cliente` | Clientes de Galcomex |
| `tarifa_cliente` | Tarifas por cliente, año y tipo |
| `tramite_do` | Trámites de importación (DO) |
| `estado_log` | Historial de cambios de estado del DO |
| `plantilla_checklist` | Plantillas de checklist reutilizables |
| `plantilla_checklist_item` | Ítems de cada plantilla |
| `checklist_item` | Ítems del checklist por trámite |
| `documento` | Archivos adjuntos (referencia a MinIO) |
| `anticipo` | Anticipos de clientes |
| `aplicacion_anticipo` | Vinculación anticipo ↔ trámite |
| `beneficiario` | Proveedores y terceros (catálogo) |
| `factura_proveedor` | Facturas de proveedor por trámite |
| `pago_tramite` | Pagos realizados durante la operación |
| `pago_tramite_beneficiario` | Pivot N↔N pago ↔ beneficiario |
| `pago_tramite_factura` | Pivot N↔N pago ↔ factura proveedor |
| `borrador_factura` | Borrador de factura de venta |
| `linea_revision` | Líneas del borrador (conceptos) |
| `linea_revision_factura` | Pivot N↔N línea ↔ factura proveedor |
| `factura` | Factura aprobada y facturada |
| `pago_factura` | Abonos y devoluciones de cartera |
| `pse_solicitud` | Solicitudes PSE por trámite |
| `parametro` | Parámetros editables del sistema |
| `matriz_recaudo` | Costos de recaudo (entra dinero) |
| `matriz_pago` | Costos de pago (sale dinero) |
| `siigo_producto` | Catálogo de productos SIIGO (espejo) |
| `siigo_impuesto` | Catálogo de impuestos SIIGO (espejo) |
| `siigo_producto_impuesto` | Pivot N↔N producto ↔ impuesto |
| `siigo_tipo_comprobante` | Tipos de comprobante SIIGO (espejo) |
| `siigo_vendedor` | Vendedores SIIGO (espejo) |
| `siigo_forma_pago` | Formas de pago SIIGO (espejo) |
| `audit_log` | Registro completo de auditoría |

### Enums

| Enum | Valores |
|---|---|
| `Rol` | ADMIN, REVISOR, OPERATIVO, SOCIO |
| `TipoCliente` | PROPIO, SOCIO_LM |
| `Ciudad` | BAQ, CTG, BUN, SMR |
| `AgenciaAduanas` | MOVIADUANAS, COLDEX, AR_LOGISTY |
| `EstadoTramite` | SOLICITUD, APERTURA, EN_TRAMITE, EN_PUERTO, DESPACHADO, ENVIADO_A_FACTURAR, FACTURADO, PAGADO, CERRADO |
| `CategoriaDocumento` | FACTURA_COMERCIAL, BL, PACKING_LIST, DECLARACION_DIAN, SOPORTE_FACTURACION, FOTO_RECONOCIMIENTO, COMPROBANTE_BANCARIO, FACTURA_PROVEEDOR, OTRO |
| `TipoRecaudo` | BANCOLOMBIA, OTROS_BANCOS, SUCURSAL, CORRESPONSAL, CAJERO |
| `EstadoMovimiento` | BORRADOR, REALIZADO, VERIFICADO |
| `CanalPago` | TRANSF_BANCOLOMBIA, PSE, TRANSF_OTROS_BANCOS |
| `EstadoFacturaProveedor` | REGISTRADA, PAGADA, FACTURADA_CLIENTE |
| `EstadoBorrador` | BORRADOR, EN_REVISION, APROBADO, FACTURADO |
| `LineaRevisionOrigen` | AUTO, MANUAL |
| `SeccionLinea` | TERCEROS, OPERACIONAL |
| `DestinoPago` | CLIENTE, LM |
| `TipoPagoFactura` | ABONO, DEVOLUCION |

---

## 6. Storage (S3: MinIO / Cloudflare R2)

Almacenamiento de archivos compatible con S3, corriendo en el mismo VPS.

**Estructura de rutas:**
```
tramites/{consecutivo}/{categoria}/{uuid}.ext
```

**Ejemplos:**
```
tramites/DO.CTG26-0124/BL/a3f2b1c0-uuid.pdf
tramites/DO.CTG26-0124/COMPROBANTE_BANCARIO/9d8e7f6a-uuid.jpg
```

**Acceso:** URLs prefirmadas con expiración ≤ 15 minutos. Los archivos nunca se borran físicamente (soft-delete con campo `eliminado`).

---

## 7. Auditoría

Todo cambio crítico queda registrado en la tabla `audit_log`:

- Entidad afectada (DO, BorradorFactura, etc.) + ID
- Acción (CREATE, UPDATE, APPROVE, FACTURAR, RESET_PASSWORD, etc.)
- Usuario que realizó la acción
- Trámite relacionado (si aplica)
- Snapshot JSON del estado **antes** y **después**
- Timestamp

Índices por `(entidad, entidadId)`, por `usuarioId` y por `tramiteId` para consultas eficientes.

---

## 8. Webhooks (n8n)

Eventos que disparan notificaciones hacia flujos de automatización en n8n, firmados con HMAC-SHA256:

| Evento | Cuándo se dispara |
|---|---|
| `do.creado` | Al crear un nuevo trámite |
| `do.enviado_a_facturar` | Al cambiar estado a ENVIADO_A_FACTURAR |
| `factura.aprobada` | Al aprobar un borrador |
| `factura.facturada` | Al registrar el número SIIGO |
| `cartera.vencida` | Al detectar cartera vencida |

---

## 9. API REST — Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| GET/POST | `/api/clientes` | Listar y crear clientes |
| GET/PATCH | `/api/clientes/[id]` | Detalle y edición de cliente |
| GET/POST | `/api/tramites` | Listar y crear trámites |
| GET/PATCH | `/api/tramites/[id]` | Detalle y actualización |
| GET/POST | `/api/tramites/[id]/documentos` | Documentos del trámite |
| GET/POST | `/api/tramites/[id]/pagos` | Libro de pagos |
| GET/POST | `/api/anticipos` | Listar y registrar anticipos |
| GET/POST | `/api/anticipos/[id]/aplicaciones` | Aplicar anticipo a trámite |
| POST | `/api/anticipos/[id]/verificar` | Verificar anticipo contra banco |
| GET/POST | `/api/tramites/[id]/facturas-proveedor` | Facturas de proveedor |
| GET/POST | `/api/borradores` | Borradores de factura |
| PATCH | `/api/borradores/[id]` | Actualizar borrador |
| POST | `/api/borradores/[id]/aprobar` | Aprobar borrador |
| POST | `/api/borradores/[id]/facturar` | Registrar número SIIGO |
| GET | `/api/borradores/[id]/cruce-facturas` | Cruce pagos vs facturas proveedor |
| POST | `/api/borradores/[id]/siigo-enviar` | Enviar borrador a SIIGO API |
| POST | `/api/borradores/[id]/siigo-sincronizar` | Sincronizar consecutivo desde SIIGO |
| GET | `/api/borradores/[id]/export` | Export XLSX para respaldo |
| GET | `/api/borradores/[id]/pdf` | Generar PDF del borrador |
| GET | `/api/cartera` | Cartera de clientes |
| POST | `/api/facturas/[id]/pagos` | Registrar abono/devolución |
| GET | `/api/dashboard` | Indicadores del dashboard |
| GET | `/api/ingresos` | Libro de bancos/ingresos |
| GET | `/api/siigo-productos` | Catálogo de productos SIIGO |
| GET/POST | `/api/configuracion/siigo/*` | Configuración y sincronización SIIGO |
| GET/PATCH | `/api/configuracion/parametros` | Parámetros del sistema |
| POST | `/api/usuarios/[id]/reset-password` | Restablecer contraseña (ADMIN) |

---

## 10. Estado del proyecto (Sprint 11 — 2026-06-25)

### Completado ✅

- Sistema de autenticación y roles completo
- Gestión completa de trámites con pipeline de estados y checklist
- Gestión de documentos con MinIO (drag & drop, visor, galería)
- Anticipos y aplicación multi-trámite con validación en vivo
- Libro de pagos editable con saldo corriente en tiempo real
- Facturas de proveedor con estados y vinculación a pagos
- Motor de cálculo financiero replicando el Excel al peso (BigInt, tolerancia 0)
- Generador de borrador de factura + revisor split-screen
- Ciclo de vida completo del borrador (BORRADOR → FACTURADO)
- Integración API SIIGO: envío como draft + sincronización de consecutivo
- Catálogos SIIGO sincronizados (productos, impuestos, formas de pago, etc.)
- Cartera con ledger unificado (abonos parciales y devoluciones)
- Dashboard operativo con alertas SLA
- Vista de Ingresos / Libro de bancos
- Flujo SOCIO_LM completo (Luis Martínez): DOs, pagos, motor diferenciado, 4x1000 correcto
- Beneficiarios N↔N (un pago a múltiples destinatarios)
- Flujo PSE con cifrado AES-256-GCM
- Auditoría completa (AuditLog con snapshots)
- Webhooks n8n firmados
- 229 tests verdes (motor, integración, cálculos financieros)
- Docker Compose completo (app + PostgreSQL 16 + MinIO)
- Export Excel respaldo (SheetJS)
- Generación de PDF (react-pdf)

### Pendiente / diferido

- **B4:** Decisión si el SOCIO puede crear sus propios DOs (hoy lo hace OPERATIVO/ADMIN)
- **B1:** Selector de tipo de importación y documentos condicionales para Galcomex (fase 2)
- **D2:** Botón de descarga de comprobante adjunto en pagos de cartera
- **D3:** El estampado en SIIGO sigue siendo manual (sin webhook entrante de SIIGO)
- **C1/C2:** Dos tests pre-existentes a sanear (ruta Windows hardcoded + regla de negocio a confirmar)
- Deploy a producción (EasyPanel/Hostinger) — paso manual aprobado por el usuario

---

## 11. Invariantes de arquitectura

1. **Dinero siempre como `BigInt` (COP enteros).** Cero flotantes en cálculos financieros.
2. Sin `any` en TypeScript — el build falla si hay.
3. Validación Zod en todos los endpoints API.
4. Autorización en middleware, no en componentes React.
5. Toda mutación crítica genera registro en `AuditLog` con snapshot JSON.
6. Tests de cálculo con tolerancia 0 pesos — si falla el test, el código está mal (no el test).
7. Concurrencia de DO: generado con `pg_advisory_xact_lock` en transacción — imposible duplicar.

---

*Documento generado automáticamente desde el código fuente y la documentación del proyecto. Sprint 11 — 2026-06-25.*
