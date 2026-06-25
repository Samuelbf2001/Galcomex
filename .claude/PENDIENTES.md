# Pendientes — Galcomex

> Registro vivo de lo que quedó **fuera de scope** o **diferido** al cierre de Sprint 11 (2026-06-25, entrega final flujo Lucho/SOCIO_LM). Cada item indica origen, decisión y siguiente acción cuando aplique.

---

## A. Cierre de Sprint 11 — pasos manuales (no-código)

### A1. Crear usuario Lucho en BD de producción
**Acción:** ejecutar `npx tsx scripts/crear-usuario-socio.ts` contra la BD de producción durante el deploy a EasyPanel.
**Credenciales acordadas:** `lucho@galcomex.com` / `Galcomex2026!`, rol `SOCIO`.
**Estado:** ya está creado en local; falta replicar en prod.
**Responsable:** quien ejecute el deploy.

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
