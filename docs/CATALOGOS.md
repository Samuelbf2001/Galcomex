# Configuración → Catálogos

Un solo lugar para las listas que hoy viven repartidas entre migraciones, código y memoria
de Camila: **conceptos de venta**, **productos Siigo ↔ impuestos**, **eventos** y
**categorías de documento**. Fase 1 = modelo + backend (este doc); fase 2 = UI.

**En lenguaje simple:**
1. Antes el nombre que veía el cliente en la factura dependía de dónde se escribiera; ahora hay una lista única de "lo que Galcomex vende" (los conceptos).
2. Cada concepto sabe con qué producto de Siigo se factura y si lleva IVA, así el nombre en la plataforma y en la factura es el mismo siempre.
3. Los impuestos de cada producto ya no se escriben a mano: el sincronizador de Siigo se los trae solo, y lo que se puso a mano no se pisa.
4. Los eventos (revisión, entrega directa…) se editan desde la pantalla en vez de pedirle una migración al desarrollador.
5. Se agregan 4 carpetas nuevas de documentos y una regla por nombre de archivo que ordena sola el 89 % de lo que hoy cae en "Otro".

## 1. Conceptos de venta (`concepto_venta`)

`codigo` único (`GASTOS_TRAMITE`…, igual que `tarifa_item.concepto`) · `nombre` (el
que ve el cliente si no hay producto) · `siigoProductoId` nullable `SetNull` (producto
**por defecto**; si está, su `nombre` manda en la factura) · `aplicaIva` (default del
ítem y de la línea) · `tipoCalculoSugerido`/`unidadSugerida` (pistas para la UI, no
calculan nada) · `orden`, `activo`, `descripcion`, `notas`. Un concepto nunca se borra
(hay tarifarios apuntando): se da de baja con `activo = false`. `TarifaItem` gana
`conceptoId String?` (`SetNull`, indexado), enlazado solo cuando el `concepto` del ítem
coincide con un código del maestro. **Nada se rompe**: `concepto` y `siigoCodigo` siguen
siendo lo que usa el motor; `conceptoId` solo aporta producto, IVA y nombre por defecto.

### Regla de nombre en la factura (decisión de Camila, 10-sep)
`src/lib/catalogos/nombre-linea.ts` — `resolverLineaConcepto(...)`, **pura**: (1) producto
Siigo del ítem → (2) producto por defecto del concepto → (3) `concepto.nombre` →
(4) `nombrePublico` del ítem (lo de hoy). Se aplica en `generarBorrador` **solo a las
líneas que vienen del tarifario** (llevan `conceptoCodigo`): lo que un revisor escribe a
mano no se toca y, sin tarifario, nada cambia (casos dorados de `factura-conceptos.test.ts`
y `motor-factura*.test.ts` intactos). El producto de comisión sigue cubriendo solo a las
líneas sin producto.

### Endpoints

`GET /api/configuracion/catalogos/conceptos` (ADMIN y REVISOR; trae el producto resuelto
e `itemsEnlazados`, y `?activos=1` filtra) · `POST` y `PATCH` (`{ id, ...campos }`, el
`codigo` **no** se cambia) solo ADMIN. Zod en `src/lib/validations/catalogos.ts`,
servicio en `src/lib/catalogos/conceptos-service.ts`, `AuditLog ConceptoVenta
CREATE|UPDATE` con snapshot antes/después.

## 2. Productos Siigo ↔ impuestos

`sync-service.ts` ahora lee `taxes: [{id,name,type,percentage}]` de `/v1/products`
(el Zod del cliente los tolera ausentes) y llena `siigo_producto_impuesto`, que gana
`origen` (`SIIGO` | `MANUAL`, default `MANUAL`) y `sincronizadoEn`. La regla es que
el sync **solo** crea y borra filas `SIIGO`, y guardar desde la UI
(`PUT .../productos/{id}/impuestos`) deja **todas** las filas de ese producto en
`MANUAL` (quien edita toma el control). Un producto que viene sin `taxes` no pierde
nada (Siigo omite el bloque a veces) y un impuesto que no esté en `siigo_impuesto`
se crea desde el payload del producto, sin tocarlo si ya existe. Plan puro y
probado: `planImpuestosProducto()` en `src/lib/siigo/impuestos-producto.ts`.
En el armado de ítems (`items-factura.ts`, formato `CONCEPTOS_IVA`): `aplicaIva` decide
**si** la línea lleva IVA (es lo que liquidó el motor y lo que sostiene `payments.value`);
el producto decide **cuál** id se manda, y solo si su porcentaje coincide con la tasa del
motor (`ivaDelProducto`). Si no, se usa el IVA global — lo actual, con BAQ-18385 intacto.

## 3. Eventos (`catalogo_evento`)

`GET /api/configuracion/catalogos/eventos` (ADMIN y REVISOR; incluye inactivos y cuántos
tarifarios/trámites dependen de cada uno) y `PATCH` (ADMIN): `{ codigo, nombre?,
descripcion?, documentosRequeridos?, permiteCantidad?, orden?, activo? }`. El **`codigo`
es inmutable** (FK de `tarifa_item` y `tramite_evento`). Cambiar `documentosRequeridos`
afecta solo a los trámites que marquen el evento después. `AuditLog CatalogoEvento/UPDATE`.

## 4. Categorías de documento

Cuatro valores nuevos en el enum `CategoriaDocumento`: `CONTROL_TRAMITE`,
`FICHA_TECNICA`, `CORRESPONDENCIA`, `ORDEN_COMPRA` (análisis de los 2.662 "Otro" de
Litoplas, `../litoplas-flujo-vs-plataforma.md` §10). Se actualizan el Zod de documentos
(`nativeEnum`: sale gratis), `CATEGORIA_KEYWORDS`, `CATEGORIAS_DOCUMENTO` —que alimenta
también el explorador de la bodega vía `etiquetaCategoria`— y el filtro del workspace
de trámites, más el label que faltaba de `COMPROBANTE_COMERCIO`.

**Migración:** `ALTER TYPE … ADD VALUE IF NOT EXISTS`, una sentencia por valor. PostgreSQL
≥ 12 lo admite dentro de transacción mientras el valor **no se use** en la misma migración
(por eso no inserta ni compara con los nuevos); si un motor viejo se queja, el archivo trae
cómo aplicarlo con `psql -f` + `prisma migrate resolve`.
`src/lib/documentos/clasificador-nombre.ts` — `clasificarPorNombre(nombre, ext,
rutaRelativa?)`, **pura**, reglas ordenadas (lo específico primero); `null` = se queda
en OTRO. Medido contra el manifiesto: 2.380 de 2.662 (89 %).
`scripts/reclasificar-otros.ts` recorre `documento` con `categoria = OTRO` y **por
defecto simula** (tabla categoría→conteo + 10 ejemplos); con `--aplicar` actualiza por
lotes en transacción y deja `AuditLog Documento/RECLASIFICAR`. **No mueve objetos en
la bodega**: la `storageKey` conserva `…/OTRO/…`, aceptable porque la clave es un
identificador opaco (la app sirve los archivos por enlace firmado desde la fila de
`documento`, nunca listando carpetas) y mover miles de objetos en R2 es copy+delete.

## Migración de datos

1. `20260918130000_categorias_documento` + `20260918130100_catalogos_conceptos`.
2. `npx tsx scripts/seed-conceptos-venta.ts` (idempotente, `--dry-run`): crea los 18
   conceptos desde `plantillas.ts` y **enlaza por backfill** los `tarifa_item` cuyo
   `concepto` coincida. Corre también dentro de `prisma/seed.ts`.
3. `POST /api/configuracion/siigo/sync`: trae los productos **con** sus impuestos.
   Opcional: `npx tsx scripts/reclasificar-otros.ts` (primero sin `--aplicar`).

## Riesgos

- **Cambian los nombres en factura**: los borradores nuevos con tarifario usan el del
  producto Siigo. Revisar con Camila los conceptos marcados `confirmar` en `plantillas.ts`.
- **`taxes` de Siigo**: un producto con IVA distinto al del motor NO se usa (los totales
  no cuadrarían); queda el IVA global y el `AuditLog` del sync.
- **Enum vs tabla**: las categorías siguen siendo enum (tipado fuerte); una quinta sigue
  exigiendo migración. Pasarlas a tabla es deuda.
- **Reclasificar** solo se deshace con el `AuditLog`: correr primero sin `--aplicar`.

## Pendiente — fase 2 (UI)

Sección `Configuración → Catálogos`, solo-lectura para REVISOR y editable por ADMIN
(`useRol()`, `ModalShell`, `useToast`, `useConfirm`, `TableSkeleton`/`ModuleState`):
**Conceptos** (tabla + modal contra `GET/POST/PATCH .../catalogos/conceptos`, selector
de producto contra `GET /api/siigo-productos`, avisar `itemsEnlazados` antes de
desactivar) · **Eventos** (tabla editable contra `GET/PATCH .../catalogos/eventos`,
código de solo lectura, editor de lista para `documentosRequeridos`) · **Productos ↔
impuestos** (mostrar `origen` en la pantalla que ya existe y advertir que guardar a
mano congela el producto frente al sync). Falta además registrar la ruta en
`RUTAS_DASHBOARD` + `exigirAccesoPagina` y las tools del MCP (deuda declarada en
`src/lib/mcp/paridad-excepciones.ts`).
