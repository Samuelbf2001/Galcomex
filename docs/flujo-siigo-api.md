# Flujo de facturación a Siigo (integración por API)

> Vigente desde Sprint 10 (2026-06-24). Reemplaza la estrategia de import por Excel
> (`siigo-import-strategy.md`, `importacion-siigo-archivo.md`), que queda como respaldo manual.

Galcomex crea la factura de venta **directamente en Siigo como borrador (DRAFT)** vía API. La
factura NO se factura electrónicamente desde Galcomex: un usuario superior la valida y la estampa
manualmente desde el portal de Siigo, y luego el sistema sincroniza el consecutivo definitivo.

## Dos tipos de factura, un solo canal de envío

La diferencia está en **cómo se calcula el borrador**, no en cómo se envía a Siigo. A Siigo
siempre se le mandan las **líneas de revisión** del borrador.

| Tipo de cliente (`TipoCliente`) | Cómo se calcula | Motor |
|---|---|---|
| **PROPIO** (cliente directo de Galcomex) | Motor clásico con 4x1000 condicional, costos bancarios, IVA comisión | `src/lib/calculations/motor-factura.ts` |
| **SOCIO_LM** (cliente del socio "Lucho") | Replica el Excel de Lucho: Σ(líneas terceros, incl. 4x1000) + comisión + IVA − retenciones, con reparto de saldo cliente/LM | `src/lib/calculations/total-lineas.ts` |

`src/lib/borradores/recalculo.ts` unifica ambos: **las líneas son la fuente de verdad del total**.
Con `montoLM=0` y `retenciones=0`, el cálculo por líneas coincide al peso con el motor PROPIO.

## Flujo paso a paso

Todo ocurre en el revisor de borrador (`src/components/facturacion/revisor-borrador.tsx`).

1. **BORRADOR → EN_REVISION** — "Enviar a revisión".
2. **EN_REVISION → APROBADO** — "Aprobar borrador" (rol REVISOR/ADMIN). Bloqueado si hay líneas observadas.
3. **Seleccionar forma de pago** (contado vs crédito) — obligatorio antes de enviar. Default
   `SIIGO_FORMA_PAGO_DEFAULT_ID`. Ruta `PATCH /api/borradores/[id]/forma-pago`.
4. **Enviar a SIIGO** (rol ADMIN) — `POST /api/borradores/[id]/siigo-enviar` →
   `enviarBorradorASiigo`. Valida en cadena (estado APROBADO, NIT cliente, forma de pago,
   parámetros, producto Siigo por línea, NIT de terceros) y crea la factura con `stamp.send=false`
   → queda como **DRAFT en Siigo**. Persiste `siigoDraftId` + `enviadoASiigoEn`. En fallo guarda
   `ultimoErrorSiigo` para reintento. El borrador **sigue en APROBADO**.
5. **Validación manual** — un superior valida y estampa la factura en el portal de Siigo; ahí
   recibe el consecutivo definitivo (ej. `BAQ-18453`).
6. **Sincronizar desde SIIGO** — `POST /api/borradores/[id]/siigo-sincronizar` →
   `GET /v1/invoices/{id}`. Si ya tiene consecutivo → borrador a **FACTURADO** + se crea `Factura`
   (alimenta cartera). Idempotente.

Alternativas: "Marcar facturado" manual (modal) y "Excel SIIGO" (respaldo de importación manual).

## Composición de los items enviados a Siigo

Orden: **TERCEROS → OPERACIONAL → comisión (con IVA)**.

- **Líneas TERCEROS** (ingresos recibidos para terceros): llevan `customer.identification` = NIT
  del beneficiario/proveedor (columna "Id. Tercero" en el PDF de Siigo).
- **4x1000** (`LineaRevision.tipoFija = IMPUESTO_4X1000`): se envía con el NIT de la DIAN
  (`SIIGO_NIT_DIAN`).
- **Costos bancarios** (`tipoFija = COSTOS_BANCARIOS`): **NO se envían** a Siigo — son costo
  operativo interno; solo afectan saldo/cartera y el PDF interno.
- **Comisión Galcomex** (OPERACIONAL): con su IVA resuelto desde `SiigoProductoImpuesto`.
- **Observaciones**: `comentariosCabecera` (formato Lucho) + bloque TOTAL FACTURA / VALOR ANTICIPO / SALDO.

## Configuración

### Credenciales de API (`.env`)
- `SIIGO_API_USERNAME`, `SIIGO_API_ACCESS_KEY`, `SIIGO_API_BASE_URL` (default `https://api.siigo.com`).

### Parámetros de facturación (tabla `Parametro`, UI Configuración → Siigo, rol ADMIN/REVISOR)
| Clave | Qué es |
|---|---|
| `SIIGO_TIPO_COMPROBANTE_ID` | Tipo de comprobante (factura de venta) |
| `SIIGO_VENDEDOR_ID` | Vendedor (usuario Siigo) |
| `SIIGO_PRODUCTO_COMISION_ID` | Producto Siigo de la línea de comisión |
| `SIIGO_FORMA_PAGO_DEFAULT_ID` | Forma de pago por defecto del borrador |
| `SIIGO_PRODUCTO_4X1000_ID` | Producto Siigo del 4x1000 |
| `SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID` | Producto Siigo de costos bancarios |
| `SIIGO_NIT_DIAN` (opcional) | NIT de la DIAN como tercero de la línea 4x1000 |

### Catálogos espejo (sincronizados desde Siigo)
Modelos `SiigoProducto`, `SiigoImpuesto`, `SiigoTipoComprobante`, `SiigoVendedor`, `SiigoFormaPago`
+ pivot manual `SiigoProductoImpuesto` (IVA por producto, no expuesto por `/v1/products`). Se
refrescan vía `/api/configuracion/siigo/{productos,impuestos,formas-pago,tipos-comprobante,vendedores,sync}`.
Para descubrir los IDs numéricos: `scripts/siigo-config-lookup.ts`.

## Archivos clave
- `src/lib/siigo/client.ts` — cliente HTTP + schemas Zod + tipos del DTO.
- `src/lib/siigo/envio-factura-service.ts` — armado del DTO y envío como DRAFT.
- `src/lib/siigo/sincronizar-factura-service.ts` — pull del consecutivo definitivo → FACTURADO.
- `src/lib/siigo/sync-*-service.ts` — sincronización de catálogos.
- `src/app/api/borradores/[id]/{siigo-enviar,siigo-sincronizar,forma-pago,comentarios}/route.ts`
- `src/app/api/configuracion/siigo/**` — configuración y catálogos.
- `src/components/facturacion/revisor-borrador.tsx` — orquestación en la UI.
- `src/components/configuracion/` — UI de parámetros y productos Siigo.

## Dinero con centavos (fase CENTAVOS, 2026-09)

- **`price` y `payments[].value` viajan en pesos con hasta 2 decimales**
  (`502801.45`), armados con `numeroDeCentavos` desde los centavos del borrador.
- **IVA y ReteIVA al centavo (D-1).** Siigo liquida el IVA de cada ítem gravado y
  la ReteIVA al centavo, mitad hacia arriba (181 facturas de 2026: 16 IVA y 107
  ReteIVA con centavos, 0 al peso). Ejemplos: FV-2-18702, ítem 6.632.007 → IVA
  1.260.081,33; FV-2-18772, IVA 208.050 → ReteIVA 31.207,50. El motor
  (`calculations/factura-conceptos.ts`: `PRECISION_IVA`, `PRECISION_RETEIVA`) y la
  comprobación de envío (`PRECISION_IVA_SIIGO`) usan la MISMA constante.
- **4x1000 al peso** (mitad arriba): es un ítem que escribimos nosotros (49/49
  facturas 2026 al peso).
- **Comprobación que corta el envío** (`verificarCuadreSiigo`): sobre el payload
  exacto, Σ ítems + IVA por ítem − retenciones que viajan = `payments.value` al
  centavo. Si no cuadra, NO se hace el POST y el usuario ve los dos valores. En el
  formato COMISION las retenciones no viajan: un borrador COMISION con retenciones
  > 0 se bloquea antes de enviar.
- **Sincronización (D-7):** si el total (o, en CONCEPTOS_IVA, el IVA/retenciones)
  que devolvió Siigo no es igual al centavo al del borrador, la ruta responde
  **409 `SIIGO_TOTAL_DISTINTO`** con `totalSiigo`, `totalBorrador` y
  `diferencias[]`; no se crea la Factura y el borrador sigue APROBADO. La pantalla
  lo muestra con el título «SIIGO liquidó un total distinto al del borrador».
- **Primer envío y primera sincronización reales:** con Camila mirando el
  borrador DRAFT en Siigo (la forma del GET de Siigo no se probó contra la API
  viva).

## Limitaciones conocidas
1. El envío no distingue PROPIO/SOCIO_LM (manda las líneas tal cual).
2. El estampado/validación final es manual en el portal Siigo (`stamp.send=false`); no hay webhook
   de Siigo, por lo que la sincronización es por pull manual ("Sincronizar desde SIIGO").
3. Reenviar recrea la factura en Siigo (genera un nuevo draft).
