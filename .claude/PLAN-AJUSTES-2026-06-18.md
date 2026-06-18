# Plan de ajustes — 2026-06-18

Puntos de mejora levantados por el usuario (Camila/SixTeam). **Contexto general:** son ajustes
del **flujo Lucho** principalmente, pero los **objetos y relaciones de tabla son generales**
(aplican a todo el sistema, no solo al portal del socio). Ver `PLAN-FLUJO-LUCHO.md`,
`PLAN-COBROS.md` y la memoria `simulacion-flujo-lucho`.

Leyenda de alcance: **[DATA]** = modelo/relación general · **[UI]** = interfaz · **[FLUJO]** = lógica de flujo Lucho.

---

## 1. Creador de trámites: documentos obligatorios para los otros roles  [UI/FLUJO]
- En el **creador de DO/trámite**, los **documentos** deben ser **obligatorios** para los demás roles
  (no-admin): no se puede crear/avanzar el trámite sin adjuntarlos.
- **A definir con Camila:** ¿qué documentos exactos son obligatorios y para qué roles
  (OPERATIVO/REVISOR/SOCIO)? ¿Bloquea la creación o el avance de estado?

## 2. Estados en anticipos y pagos (ciclo borrador → realizado → verificado)  [DATA + UI]
- Agregar **estado** con 3 valores a las tres entidades de dinero:
  - **Anticipo** (cliente → Galcomex)
  - **PagoFactura** (pago a facturas de cliente / abonos-cobros)
  - **Pago de cliente** (cartera)
  - *(Evaluar incluir también `PagoTramite` — pagos a proveedor — por consistencia.)*
- Enum nuevo, p. ej. `EstadoMovimiento { BORRADOR, REALIZADO, VERIFICADO }`.
- **Regla de verificación:** **solo Camila (ADMIN)** puede pasar a `VERIFICADO` los movimientos
  **que son de Lucho** (trámites con cliente `SOCIO_LM`). Definir quién verifica los del flujo propio.
- **Impacto:** migración Prisma + backfill (todo lo existente → `REALIZADO` o `VERIFICADO`),
  badges de estado en UI, filtros, y guard de permiso en el `service`.

## 3. Proveedores como tabla gestionada (crear-inline)  [DATA + UI]
- Los **proveedores** de las facturas de proveedor deben ser una **tabla** (modelo `Proveedor`),
  no un string libre.
- En el formulario de factura de proveedor: al **tipear un proveedor nuevo**, permitir
  **agregarlo ahí mismo** (combobox buscar + crear-inline).
- **Reutilizar el patrón ya existente de `Beneficiario`** (`beneficiario-combobox.tsx`,
  endpoints GET/POST `/api/beneficiarios`) como referencia directa. Ver memoria `simulacion-flujo-lucho` R3.
- **A definir:** campos del proveedor (NIT, nombre, ¿banco/cuenta?) y si `Proveedor` y `Beneficiario`
  se unifican o quedan separados.

## 4. Archivo obligatorio al montar factura de proveedor  [DATA + UI]
- Para **crear una factura de proveedor es obligatorio adjuntar el archivo** de la factura
  (PDF, imagen u otros formatos).
- Subida a MinIO (ver memoria `minio-presigned-split-horizon` — usar endpoint público al presignar).
- Validación tanto en UI como en backend (no aceptar la factura sin documento).

## 5. Campo "Concepto" en factura de proveedor  [DATA + UI]
- Nuevo campo **Concepto** en la factura de proveedor.
- Migración + input en el formulario + mostrarlo en la tabla/detalle.

## 6. Multiselección de facturas al registrar un pago  [DATA + UI]
- Al crear un pago, la **selección de la(s) factura(s)** a las que aplica el pago debe ser
  **multiselección** (un pago puede saldar varias facturas).
- **Impacto en modelo:** hoy `PagoTramite.facturaProveedorId` es 1→N (una factura → muchos pagos).
  Para que **un pago** cubra **varias facturas** se necesita relación **N↔N**
  (tabla pivote `PagoFactura[]` o similar) — revisar contra la lógica actual de
  `crearPago` / `generarPagoDesdeFactura` y el marcado de estado `PAGADA`.
- Conecta con el punto 9 (alerta del 10% se calcula sobre el **total de las facturas seleccionadas**).

## 7. Flujo de pago PSE con token (pop-up de 3 pasos)  [FLUJO + UI + backend]
Rediseño del modal "Agregar pago" **cuando el canal de pago es PSE**:

- **Página 1 — Datos del pago:**
  - El botón ya **no es "Guardar pago"**: si el canal es **PSE**, el botón es **"Solicitar token de pago"**.
    (Para canales no-PSE el flujo sigue siendo guardar normal.)
  - **Eliminar el campo "Fecha esperada de pago".**
  - **"Fecha real de pago"** queda con valor **predeterminado = hoy** (editable, pero default hoy).
- **Página 2 — Token:**
  - Al solicitar el token aparece un **código** que Camila ingresará en una **landing**.
  - **Webhook:** al entrar a ingresar el token se dispara un **webhook que notifica a Camila**.
  - El token tiene **30 segundos de visibilidad**. Pasados los 30s, se puede **volver a solicitar**,
    lo que **re-dispara el webhook** y Camila ingresa el **nuevo** token.
- **Página 3 — Soporte:**
  - Una vez completado el proceso, es **obligatorio adjuntar el documento de soporte de pago**
    antes de finalizar.
- **A definir con Camila / SixTeam:**
  - URL/forma de la **landing** donde Camila ingresa el token y endpoint que la sirve.
  - **Destino y payload del webhook** (¿n8n? — ver A3-T5 webhooks pendiente en `pendientes-galcomex`).
  - Generación, almacenamiento y **expiración (30s)** del token; estado del pago mientras tanto.
  - Integración real PSE (¿hay API/proveedor?) o si es semi-manual con la landing.

## 8. Pop-up de pago — fechas (parte de la pág. 1)  [UI]
- *(Incluido en el punto 7, página 1)*: eliminar "fecha esperada de pago"; "fecha real de pago"
  default = hoy, editable. Aplica al modal de pago en general.

## 9. Alerta de revisión por desviación del 10%  [FLUJO + UI]
- Mostrar **alerta de revisión** cuando el monto del pago se desvía **±10%** respecto al total de
  las **facturas seleccionadas** (ver punto 6).
- Definir si es solo **alerta visual** (warning) o un **bloqueo blando** que requiere confirmación.

---

## Orden sugerido de ejecución
1. **[DATA] base de modelos** (no rompe UI todavía): `Proveedor` (p.3), `Concepto` (p.5),
   `EstadoMovimiento` en anticipos/pagos (p.2), pivote N↔N pago-factura (p.6).
   Todo con migración + backfill, preservando los **tests dorados** (tolerancia 0 pesos).
2. **[UI] formularios**: combobox proveedor crear-inline (p.3), archivo obligatorio (p.4),
   campo concepto (p.5), multiselección de facturas (p.6), badges/filtros de estado (p.2).
3. **[FLUJO] reglas**: verificación solo-Camila para movimientos de Lucho (p.2),
   documentos obligatorios por rol en creador de trámite (p.1), alerta del 10% (p.9).
4. **[FLUJO PSE] el más grande**: pop-up de 3 pasos + token 30s + webhook + landing (p.7/8).
   Hacerlo al final porque depende de decisiones externas (landing, webhook, integración PSE).

## Decisiones abiertas para Camila / SixTeam (bloqueantes)
- **p.1** Qué documentos son obligatorios y para qué roles; ¿bloquea creación o avance?
- **p.2** ¿`PagoTramite` (pagos a proveedor) también lleva estados? ¿Quién verifica los del flujo propio?
- **p.3** Campos del proveedor; ¿unificar `Proveedor` con `Beneficiario`?
- **p.7** Landing del token, destino/payload del webhook, mecánica e integración real de PSE.
- **p.9** ¿Alerta visual o bloqueo blando con confirmación?
