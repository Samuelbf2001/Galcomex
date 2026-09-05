# PLAN — Configurabilidad por empresa (tarifario, eventos, contrapartes)

**Origen:** reunión Camila Grisales × Samuel Burgos (96 min, transcripción `reunioncompletav2.json`).
**Principio rector (dicho en la reunión, min 50:36):** _"lo que uno hace es que la función esté ahí
lista y solamente activamos o desactivamos para los clientes"_.

> **Regla de oro de este plan:** ninguna diferencia entre empresas puede vivir en el código.
> Toda diferencia es **dato de configuración**. Dar de alta una empresa nueva = cargar su
> configuración, cero commits.

Documento visual para el cliente: `../analisis-reunion-tarifario-un-sistema-muchas-empresas.html`

---

## Estado de ejecución (2026-09-05)

| Bloque | Estado | Detalle |
|---|---|---|
| **M1 Capacidades** | ✅ Implementado | Catálogo (12 capacidades), resolver puro, servicio, API, UI, migración |
| **M5 cimientos** | ✅ Implementado | `esCliente`/`esProveedor`/`grupoEmpresaId` + `GrupoEmpresa` + overrides de grupo |
| **M6 Repercusión** | ✅ Implementado | `FacturaProveedor.repercutible` + guard en líneas + cruce + UI |
| **M4 Tipos de trámite** | ✅ Implementado | `TipoTramite` + consecutivo parametrizado + `referenciaExterna` + gate por capacidad |
| **Regla de Litoplas** | ✅ Migrada | Era `if (nombre.includes("litoplas"))`; ahora es la capacidad `regla_agencia_fija` con config |
| **M2 Tarifario** | ⬜ Pendiente | Bloqueado por el catálogo Siigo depurado (Camila + contador) |
| **M3 Eventos** | ⬜ Pendiente | Requiere M2 |
| **M5 Cartera bidireccional** | ✅ Implementado | Ledger `MovimientoCuenta` + cuenta corriente cruzada + cargos manuales + comisiones. El pago en bloque multi-DO YA existía (`/api/pagos/multi`) |

### Archivos entregados

```
src/lib/capacidades/catalogo.ts          # fuente de verdad de los códigos
src/lib/capacidades/resolver.ts          # cascada, FUNCIÓN PURA
src/lib/capacidades/service.ts           # BD + AuditLog + espejo manejaAnticipo
src/lib/capacidades/__tests__/resolver.test.ts        # 15 tests puros
src/lib/validations/capacidades.ts
src/app/api/clientes/[id]/capacidades/route.ts        # GET (todos) / PUT (ADMIN)
src/app/api/clientes/[id]/capacidades/__tests__/route.test.ts  # 12 tests de integración
src/components/clientes/capacidades-api.ts
src/components/clientes/seccion-capacidades.tsx       # pestaña "Funciones"
prisma/migrations/20260905120000_capacidades_empresa/migration.sql
prisma/migrations/20260905130000_factura_proveedor_repercutible/migration.sql
```

```
src/lib/tramites/consecutivo.ts          # formato y alcance del contador, PURO
src/lib/tramites/reglas.ts               # validateReglaAgenciaFija, PURO
src/lib/tramites/__tests__/consecutivo.test.ts        # 9 tests
src/lib/tramites/__tests__/reglas.test.ts             # 10 tests (paridad con la regla vieja)
src/app/api/tipos-tramite/route.ts       # solo los tipos que la empresa puede abrir
prisma/migrations/20260905140000_tipos_tramite/migration.sql
prisma/migrations/20260905150000_regla_agencia_capacidad/migration.sql
scripts/demo-configurabilidad.ts         # demo end-to-end contra la BD
../demo-funciones-por-empresa.html       # demo clickeable, sin BD
```

```
src/lib/cuenta-corriente/calculo.ts      # saldo cruzado, FUNCIÓN PURA
src/lib/cuenta-corriente/service.ts      # asientos desde BD + movimientos manuales
src/lib/cuenta-corriente/__tests__/calculo.test.ts    # 13 tests, tolerancia 0 pesos
src/lib/validations/cuenta-corriente.ts
src/app/api/clientes/[id]/cuenta/route.ts             # GET (ADMIN/REVISOR) / POST (ADMIN)
src/components/clientes/cuenta-api.ts
src/components/clientes/seccion-cuenta-corriente.tsx  # sección en la ficha
prisma/migrations/20260905160000_cuenta_corriente/migration.sql
```

### Cómo se arma el saldo cruzado (M5)

Una sola convención de signo en todo el módulo: **positivo = la empresa nos debe**,
negativo = le debemos. Los asientos salen de tres fuentes y **no se duplica
contabilidad**:

| Fuente | Qué entra | Por qué así |
|---|---|---|
| Lado cliente | Saldo pendiente de cada factura de venta + sus abonos y devoluciones | Sale de los mismos campos que usa cartera, con el signo invertido una sola vez, para no divergir de ese módulo |
| Lado proveedor | Facturas de proveedor en estado `REGISTRADA` | Las `PAGADA` ya están saldadas y netearían cero. Incluye las no repercutibles: al proveedor se le debe igual |
| Manual | `MovimientoCuenta` | Lo que no nace de un trámite: mensualidad de Coldex, comisión de Eltrans, ajustes |

El puente al lado proveedor es `Beneficiario.empresaId` (FK nuevo, backfill por
NIT en la migración). Sin ese enlace la empresa simplemente no tiene lado
proveedor — no falla, no inventa.

### Demo

```bash
npx tsx scripts/demo-configurabilidad.ts            # siembra 7 empresas y demuestra
npx tsx scripts/demo-configurabilidad.ts --limpiar  # borra todo lo DEMO-
```

Crea el grupo Polired con dos empresas, la matriz de la reunión, un DO de
importación y una clasificación (`CLAS26-0001`), muestra el rechazo de un tipo
no habilitado, la regla de agencia bloqueando una transición, y el cruce con una
factura que no se le cobra al cliente.

### Gates verificados

- `npx tsc --noEmit` limpio.
- `eslint` limpio en todo lo tocado (quedan 1 error + 1 warning **pre-existentes**
  en `editor-lineas.tsx:372` y `borradores/service.ts:24`, idénticos en HEAD).
- **142/142 tests puros** verdes, incluidos los 79 casos dorados del motor de
  factura (tolerancia 0 pesos) — el refactor no tocó la matemática.

### ⚠️ Pendiente de aplicar (requiere Postgres arriba)

Docker Desktop estaba abajo durante la implementación, así que **las seis
migraciones no se han aplicado** y los tests de integración quedan en `skip`.
Al levantar el stack:

```bash
docker compose up -d postgres
npx prisma migrate deploy
npm run db:seed          # sincroniza el catálogo de capacidades
npm run test             # la suite completa, incl. los 12 tests de capacidades
```

El test de capacidades se auto-omite con un mensaje explícito si el catálogo
está vacío, para que un olvido de `migrate deploy` no pase como verde.

---

## 0. Diagnóstico

| Hecho | Evidencia |
|---|---|
| El comportamiento de negocio ya se ramifica por tipo de cliente | 131 refs a `SOCIO_LM` en 41 archivos (`src/`), 91 refs / 33 archivos fuera de tests |
| El modelo de tarifas actual no representa ninguna tarifa real | `TarifaCliente(anio, tipo:"fijo"\|"por_contenedor"\|"porcentaje_cif", valor)` — un solo valor, sin producto, sin vigencia, sin mínimos |
| Nadie lo usa | La ficha de Litoplas en la demo mostraba `Tarifas (0)`; `TarifaCliente` no aparece en `lib/calculations` ni en `lib/borradores` |
| No hay de dónde generar los ingresos propios | Las líneas del borrador se generan desde el libro de pagos (TERCEROS) + 4 líneas fijas. Los servicios propios (gastos operativos, papelería, sistematización, documentación) no tienen origen |
| Ya existe el patrón correcto, pero suelto | `Cliente.manejaAnticipo` es un feature flag por empresa que funciona; no escala como columna por función |

---

## 1. M1 — Capacidades por empresa

### Modelo

```prisma
model Capacidad {
  codigo       String  @id            // "tarifario_propio", "base_cif", ...
  nombre       String
  descripcion  String?
  ambito       AmbitoCapacidad        // EMPRESA | GLOBAL
  porDefecto   Boolean @default(false)
  configSchema Json?                  // JSON Schema del `config` esperado
  empresas     EmpresaCapacidad[]
  @@map("capacidad")
}

model EmpresaCapacidad {
  empresaId  String
  empresa    Cliente   @relation(fields: [empresaId], references: [id], onDelete: Cascade)
  codigo     String
  capacidad  Capacidad @relation(fields: [codigo], references: [codigo], onDelete: Cascade)
  habilitado Boolean
  config     Json?
  updatedAt  DateTime  @updatedAt
  @@id([empresaId, codigo])
  @@map("empresa_capacidad")
}
```

### Resolución en cascada

`porDefecto` → `grupoEconomico` (si existe override de grupo) → `EmpresaCapacidad`.

```ts
// src/lib/capacidades/service.ts
export async function capacidadesDe(empresaId: string): Promise<MapaCapacidades>
export function tiene(mapa: MapaCapacidades, codigo: CodigoCapacidad): boolean
export function configDe<T>(mapa: MapaCapacidades, codigo: CodigoCapacidad): T | null
```

`CodigoCapacidad` es un union type derivado del seed → autocompletado y `tsc` protege typos.
Cachear por request (los endpoints ya cargan el cliente del trámite).

### Capacidades del seed inicial

`anticipos_cliente`, `tarifario_propio`, `base_cif`, `clasificacion_arancelaria`,
`eventos_facturables`, `contenedores_obligatorio`, `comision_por_evento`,
`cargos_manuales_contraparte`, `orden_compra_en_revision`, `grupo_economico`,
`docs_bl_factura_obligatorios`, `factura_multi_do`.

### UI

Pestaña **Funciones** en la ficha de empresa (junto a Tarifas / Trámites / Anticipos), solo ADMIN,
con `AuditLog` en cada toggle.

### Migración de lo que ya existe

- `Cliente.manejaAnticipo` → capacidad `anticipos_cliente` (backfill 1:1, mantener la columna un
  sprint como shadow read y luego borrarla).
- `TipoCliente` **NO se borra todavía**: durante la transición deriva las capacidades por defecto
  (`SOCIO_LM` ⇒ `docs_bl_factura_obligatorios: true`, etc.). Se migra módulo por módulo
  (ver §7) y al final queda como dato descriptivo.

---

## 2. M2 — Tarifario versionado + motor de tarifas

### Modelo

```prisma
model Tarifario {
  id             String          @id @default(cuid())
  empresaId      String
  empresa        Cliente         @relation(fields: [empresaId], references: [id], onDelete: Restrict)
  nombre         String          // "Tarifas 2026"
  vigenteDesde   DateTime        // 2026-02-02  ← NO es año calendario ni fiscal
  vigenteHasta   DateTime        // 2027-01-31
  estado         EstadoTarifario // BORRADOR | VIGENTE | VENCIDO | REEMPLAZADO
  version        Int             @default(1)
  pdfKey         String?         // PDF generado, en MinIO
  enviadoAt      DateTime?       // cuándo se le mandó al cliente
  enviadoPorId   String?
  items          TarifaItem[]
  @@unique([empresaId, version])
  @@map("tarifario")
}

model TarifaItem {
  id              String        @id @default(cuid())
  tarifarioId     String
  tarifario       Tarifario     @relation(fields: [tarifarioId], references: [id], onDelete: Cascade)
  siigoProductoId String?       // código contable real, NO se toca
  siigoProducto   SiigoProducto? @relation(fields: [siigoProductoId], references: [id], onDelete: SetNull)
  etiquetaPublica String        // lo que ve el cliente en el PDF y en la factura
  seccion         SeccionLinea  // TERCEROS | OPERACIONAL (reusa el enum existente)
  tipoCalculo     TipoCalculo
  params          Json          // ver §2.2
  disparador      Disparador    // SIEMPRE | EVENTO | MANUAL
  eventoCodigo    String?       // requerido si disparador = EVENTO
  aplicaIva       Boolean       @default(true)  // los precios de la propuesta son "+ IVA"
  orden           Int           @default(0)
  activo          Boolean       @default(true)
  @@map("tarifa_item")
}

enum TipoCalculo {
  FIJO
  POR_UNIDAD
  PORCENTAJE_MIN
  PRIMERO_MAS_ADICIONAL
  ESPEJO_DE_COSTO
}
```

`CONDICIONAL` no es un tipo de cálculo: es `disparador = EVENTO` sobre cualquier tipo.

### 2.2 Forma de `params` por tipo

```jsonc
// FIJO — gastos operativos Litoplas
{ "valor": "100000" }

// POR_UNIDAD — revisión documental $10.000 por documento
{ "valor": "10000", "unidad": "DOCUMENTO" }   // DOCUMENTO|DECLARACION|CONTENEDOR|ITEM|DIA

// PORCENTAJE_MIN — servicio logístico CW Express
{ "base": "CIF", "porcentaje": "0.37",
  "minimos": [ { "tramo": "CARGA_SUELTA", "valor": "370000" },
               { "tramo": "CONT_20",      "valor": "498000" },
               { "tramo": "CONT_40",      "valor": "?" } ] }   // ⚠ ver §8

// PRIMERO_MAS_ADICIONAL — clasificación arancelaria
{ "primero": "380000", "adicional": "180000", "unidad": "ITEM" }

// ESPEJO_DE_COSTO — elaboración de registro en CW (se cobra lo que costó el registro)
{ "conceptoCompra": "PAGO_VUCE_REG_IMP", "markup": "0", "minimo": "83800" }
```

**Todos los montos van como string decimal** y se convierten a `BigInt` en el motor
(invariante #1 del CLAUDE.md: cero flotantes).

### 2.3 Motor

`src/lib/calculations/motor-tarifas.ts` — **función pura, sin BD**, misma disciplina que
`motor-factura.ts`:

```ts
export function calcularLineasTarifario(
  items: TarifaItemSnapshot[],
  ctx: ContextoTramite,   // { cif, contenedores, tamañoContenedor, declaraciones, items, eventos, costosVinculados }
): LineaPropuesta[]
```

Tests dorados obligatorios (tolerancia 0 pesos), reconstruyendo facturas reales de Litoplas y
CW Express que Camila debe entregar.

### 2.4 Entregables de UI

- Editor de tarifario en la ficha de empresa (hoy: `Tarifas (0)` + botón `+ Agregar tarifa`).
- **Botón "Exportar tarifario"** → PDF con el formato de la propuesta comercial de Guillermo
  (encabezado `REF: COTIZACIÓN SERVICIOS DE ASESORÍA Y LOGÍSTICA...` + vigencia + tabla + "+ IVA").
- Alerta al crear trámite si la empresa no tiene tarifario vigente (el problema real: se hacen
  trámites antes de mandar la propuesta oficial y "luego sale clavado").
- Aviso de vencimiento próximo con acción "duplicar tarifario a nueva vigencia".

---

## 3. M3 — Eventos y atributos del trámite

```prisma
model CatalogoEvento {
  codigo            String  @id     // "CONTENEDOR_ABIERTO", "ENTREGA_DIRECTA", "DESPACHO_PARCIAL", "REGISTRO_ELABORADO"
  nombre            String
  requiereDocumento CategoriaDocumento?  // fotos del contenedor, registro
  capturaAtributos  String[]             // códigos de AtributoDefinicion a pedir al marcar
  activo            Boolean @default(true)
  @@map("catalogo_evento")
}

model TramiteEvento {
  id           String    @id @default(cuid())
  tramiteId    String
  tramite      TramiteDO @relation(fields: [tramiteId], references: [id], onDelete: Cascade)
  eventoCodigo String
  marcadoPorId String
  marcadoAt    DateTime  @default(now())
  @@unique([tramiteId, eventoCodigo])
  @@map("tramite_evento")
}

model AtributoDefinicion {
  codigo   String @id       // "CIF", "NUM_CONTENEDORES", "TAMANO_CONTENEDOR", "NUM_DECLARACIONES", "NUM_ITEMS"
  etiqueta String
  tipo     TipoAtributo     // ENTERO | MONEDA | OPCION | TEXTO | BOOLEANO
  opciones String[]
  @@map("atributo_definicion")
}

model TramiteAtributo {
  tramiteId String
  codigo    String
  valor     String          // se parsea según tipo; MONEDA → BigInt
  @@id([tramiteId, codigo])
  @@map("tramite_atributo")
}
```

**Por qué atributos declarados y no columnas:** el CIF, el nº de contenedores y el nº de ítems son
tres campos hoy; en la próxima reunión serán cinco. Una tabla de definiciones evita una migración
por cada pregunta nueva del negocio.

**Qué eventos ve un trámite:** los referenciados por el tarifario vigente de su empresa
(`TarifaItem.eventoCodigo`) más los globales activos. Al marcar un evento se agrega la línea
correspondiente al borrador y se exige el documento asociado.

**Dónde va en la UI:** sección nueva en la pestaña **Resumen** del detalle del trámite
(fue explícito en el min 45:24 — "debe ir en resumen, porque también estamos hablando de dejar
el reguero de carpetas a un lado").

---

## 4. M4 — Tipos de trámite configurables

```prisma
model TipoTramite {
  codigo             String   @id      // "IMPORTACION", "CLASIFICACION", "PLAN_VALLEJO"
  nombre             String
  prefijoConsecutivo String              // "DO" | "CLAS"
  secuenciaPor       SecuenciaTramite    // CIUDAD_ANIO | ANIO | GLOBAL
  lineaServicio      LineaServicio
  facturacionSeparada Boolean @default(false)
  camposVisibles     String[]            // "eta", "agenciaAduanas", "doCliente", ...
  documentosRequeridos CategoriaDocumento[]
  capacidadRequerida String?             // "clasificacion_arancelaria"
  activo             Boolean @default(true)
  @@map("tipo_tramite")
}
```

`TramiteDO` gana `tipoTramiteCodigo` (default `IMPORTACION`, backfill trivial) y
`referenciaExterna String?` (el nº que asigna la clasificadora: 2110, 2117, 2140 — no es
consecutivo de Galcomex, hoy solo existe en el Excel de cartera).

El generador de consecutivo atómico se parametriza por `prefijoConsecutivo` + `secuenciaPor`
(hoy hardcodea `DO.{CIUDAD}{AA}-{NNNN}` con `@@unique([ciudad, anio, numero])`; pasa a
`@@unique([tipoTramiteCodigo, ciudad, anio, numero])`).

---

## 5. M5 — Contraparte única con cuenta corriente

1. `Cliente` → `Empresa` (rename lógico; mantener `@@map("cliente")` para no romper datos), con
   `esCliente Boolean`, `esProveedor Boolean` y `grupoEmpresaId String?`.
   Casos reales: Ascinter, Coldex y Eltrans son ambas cosas; Polired y Polired Zona Franca son un
   grupo; `Beneficiario` debe converger con `Empresa` (hoy son tablas distintas).
2. `MovimientoCuenta(empresaId, rol, lineaServicio, tipo CARGO|ABONO, origen, refId, valor, fecha)`.
   Un solo ledger que sirve para: cartera de clientes, cartera de proveedores, cargos mensuales de
   Coldex (~4M variables, incluidas quincenas y primas de Lucho y Karina), comisión por contenedor
   de Eltrans y las carteras separadas por línea de servicio (trámites / clasificación / Plan Vallejo).
3. **Pago en bloque:** ya existe `PagoTramite.grupoPagoId` y `PagoTramiteFactura` (N↔N) del caso
   Karina/Occidente. Falta **exponerlo desde la ficha del proveedor**: listar todas las facturas
   `REGISTRADA` del proveedor en todos los DOs, seleccionar, un comprobante, un pago.
4. **Comisión por evento:** `comision_por_evento` con `config = { unidad: "CONTENEDOR", valor: "..." }`
   genera un `MovimientoCuenta` a favor de Galcomex al cerrar cada DO del cliente correspondiente.

---

## 6. M6 — Conceptos de compra y repercusión

- Catálogo de compra propio (o `SiigoProducto.usoCompra/usoVenta`): hoy la factura de proveedor
  elige del catálogo de productos **de venta** de Galcomex, que no aplica ("estos son servicios que
  yo doy", min 65:59).
- `ConceptoCompra.repercutible Boolean` (default) + `FacturaProveedor.repercutible Boolean?`
  (override por factura). Si `false`, la factura se registra en el trámite pero **no genera línea**
  en la factura de venta.
  Caso de prueba: asesoría de Ascinter facturada a nombre de Galcomex → no la ve el cliente;
  transporte de Ascinter → sí se traslada.

**Este bloque es pequeño y desbloquea a Camila ya; puede adelantarse a la Fase 1.**

---

## 7. Refactor `TipoCliente` → capacidades

Invertir la pregunta: donde el código pregunta _"¿de qué tipo es este cliente?"_ debe preguntar
_"¿esta empresa tiene esta capacidad?"_.

Orden sugerido (de menor a mayor riesgo), un PR por bloque, 418 tests verdes como red:

1. `lib/auth/tramite-acceso.ts` + rutas de API (scoping del rol SOCIO) — **no tocar**: eso es
   permiso por rol, no capacidad por empresa. Se queda como está.
2. `lib/anticipos/service.ts`, `lib/alertas/umbrales.ts` → capacidades + config de umbral.
3. `lib/tramites/service.ts` (documentos obligatorios) → `docs_bl_factura_obligatorios`.
4. `lib/borradores/lineas-fijas.ts`, `lib/calculations/total-lineas.ts` → capacidades
   `materializa_comision`, `materializa_costos_bancarios`, `base_4x1000`.
   ⚠️ Aquí viven los casos dorados (BUN26-0026 y BAQ-18453). Cambio puramente mecánico:
   los valores por defecto derivados de `TipoCliente` deben dar exactamente el mismo resultado.
5. UI (`components/clientes`, `components/tramites`) → leer capacidades del cliente cargado.

---

## 8. Bloqueantes que NO resuelve desarrollo

| # | Quién | Qué |
|---|---|---|
| 1 | Camila + contador | Catálogo Siigo depurado: de 83 productos, cuáles quedan, con qué nombre, marcados fijo/calculado/circunstancial. **Bloquea la Fase 1 completa.** Se acordó en la reunión que no se monta ninguno hasta recibir la lista |
| 2 | Camila | Mínimo de servicio logístico contenedor 40′ en CW: transcrito como $154.000, por debajo del de 20′ ($498.000). Casi seguro error de transcripción — confirmar contra la propuesta |
| 3 | Guillermo | ¿Clasificación arancelaria facturada aparte solo para Litoplas o regla general? |
| 4 | Guillermo | ¿Ascinter vuelve a ser cliente este año o queda solo como proveedor? |
| 5 | Camila | "Documentación" ($20.000 en la propuesta) vs "revisión y clasificación documental" ($10.000 por declaración en la facturación real). Cuál es el concepto vivo y su tarifa |
| 6 | Camila | Vigencia del tarifario: ¿renovación manual o propuesta automática al vencer? |
| 7 | Camila / Guillermo | ¿El sistema envía el tarifario por correo y registra el envío, o solo genera el PDF? |
| 8 | Camila | Validar la matriz de capacidades por empresa del documento HTML (celdas con "?") |
| 9 | Camila | Facturas reales de Litoplas y CW Express para los casos dorados del motor de tarifas |

---

## 9. Anti-patrones prohibidos

- ✗ Un módulo, pantalla, endpoint o carpeta con nombre de empresa.
- ✗ Ramificar por NIT o por nombre de empresa. Un NIT literal en el código es configuración disfrazada.
- ✗ Una columna nueva por cada campo que pida un cliente (para eso está `AtributoDefinicion`).
- ✗ Mostrarle al cliente el nombre del producto Siigo. `etiquetaPublica` y `siigoProductoId` son
  campos distintos; el código contable no se toca nunca.
- ✗ Ampliar `TipoCliente` con un tercer valor. Cada valor nuevo del enum multiplica las 131 ramas.
