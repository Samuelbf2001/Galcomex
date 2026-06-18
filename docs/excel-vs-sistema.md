# De Excel al Sistema — Cómo cada función del Excel de Galcomex vive en la plataforma

**Para:** Camila y el equipo Galcomex
**Fuente:** `GRUPO E PAPIS 2026 (1).xlsm` (29 hojas: `MODELO 2026`, 26 hojas de DO como `BUN26-0026`, `ANTICIPOS`, `RELACION FACT 2026`)
**Prueba de fidelidad:** el DO real **DO.BUN26-0026** se cargó al sistema y **cuadra al peso** con el Excel (total factura 41.868.042, saldo cliente 3.357.958, saldo LM 875.944). Script: `npx tsx scripts/replicar-grupo-e-papis.ts`.

> Idea central: **todo lo que hoy haces a mano en cada hoja del Excel, el sistema lo hace solo y conectado**. El Excel tenía 26 hojas sueltas que no se cruzaban entre sí; aquí cada dato vive una sola vez y los módulos se alimentan unos a otros.

---

## 1. La hoja de cada DO (ej. `BUN26-0026`) → el Trámite y sus pestañas

Cada hoja del Excel era un trámite completo armado a mano. En el sistema es un **Trámite (DO)** con todo integrado.

| En el Excel (hoja del DO) | En el sistema | Dónde |
|---|---|---|
| Encabezado: CLIENTE, `DO.BUN26-0026`, factura `BAQ-18288` | Cabecera del trámite (cliente enlazado, consecutivo, factura SIIGO) | Trámites → detalle → **Resumen** |
| Consecutivo escrito a mano (CTG/BAQ/BUN/SMR + año + número) | **Consecutivo automático y único** por ciudad+año, sin choques aunque varios lo abran a la vez | `tramites/service.ts` (genera `DO.BUN26-0026`) |
| Fechas (aceptación declaración, levante, salida de carga…) | **Fechas clave editables** con un clic | Resumen → "Fechas clave" |
| Checklist de documentos impreso por Karina | **Checklist digital** que bloquea avanzar si falta algo obligatorio | Resumen → Checklist |
| Carpetas de archivos en el PC del servidor | **Repositorio de documentos** por categoría (factura, BL, declaración, fotos…) con visor | detalle → **Documentos** (MinIO) |
| Estado del trámite mentalmente / en columnas | **Pipeline de estados** (solicitud → … → facturado → pagado) + tablero **Kanban** | Trámites (vista Tabla/Kanban) |

---

## 2. Anticipo + "TIPO DE RECAUDO" → módulo de Anticipos

En el Excel, el anticipo y su costo de recaudo se anotaban arriba de cada hoja, y un mismo anticipo para varios DOs se desglosaba a mano en la hoja `ANTICIPOS`.

| En el Excel | En el sistema | Dónde |
|---|---|---|
| Anticipo (monto, fecha, banco) | Registro de anticipo con soporte y verificación bancaria | **Anticipos** |
| Un anticipo repartido entre varios DOs (hoja `ANTICIPOS`) | **Aplicación multi-DO** con validación: nunca puedes aplicar más de lo que queda | Anticipos → aplicar |
| Columna "queda / aplicado" calculada a mano | **Aplicado y restante en vivo**; filtro "con saldo" = la hoja ANTICIPOS | Anticipos (filtro con saldo) |
| Costo del recaudo (BANCOLOMBIA $1.950) | Se toma del canal y entra al cálculo de costos bancarios | automático en el motor |

---

## 3. Matriz "TIPO DE RECAUDO / PAGOS" → parámetro del sistema

La tablita de costos por canal que estaba en cada hoja (Bancolombia $1.950, Sucursal $11.290, Transf Bancolombia $3.900, PSE $0, etc.) ahora es **una sola tabla del sistema** (no se copia en cada hoja).

- En el sistema: **MatrizRecaudoPago** (8 canales, sembrada una vez) → visible en **Configuración**.
- Cada pago elige su canal y el sistema pone el costo solo.

---

## 4. El "libro de pagos" con SALDO → la pantalla que más usa Camila

El corazón de cada hoja: lista de pagos (concepto, soporte, valor) con la columna **SALDO** que ibas descontando a mano.

| En el Excel | En el sistema | Dónde |
|---|---|---|
| Filas de pago (concepto, nº soporte, valor) | Tabla editable tipo hoja de cálculo | detalle → **Pagos** |
| Columna SALDO descontada a mano | **Saldo corriente recalculado en vivo** al escribir | Pagos (instantáneo) |
| Costo bancario buscado en la tablita | Se calcula solo según el canal elegido | automático |
| Cambiar un canal y recalcular todo | Recalcula en cascada al instante | Pagos |

> Verificado: con los 7 pagos reales del BUN26-0026, el sistema llega al **saldo 4.708.356** exacto.

---

## 5. El bloque de cálculo (comisión, IVA, 4x1000, costos) → el motor de factura

Esta es la parte más delicada que hacías con fórmulas. El sistema la replica **al peso** y la deja lista para revisar.

| Regla del Excel | En el sistema |
|---|---|
| Comisión Galcomex/LM (editable por factura, ej. $200.000) | Editable al generar el borrador |
| IVA de la comisión | Parametrizable / editable (el Excel lo tenía manual: $76.000) |
| **Impuesto 4x1000 condicional** (solo si queda saldo a favor) | Misma regla exacta (`anticipo × 0,4%`) |
| Costos bancarios = recaudo + Σ pagos ($1.950 + 4×$3.900 = $17.550) | Sumados automáticamente |
| Total factura, saldo a favor/cargo del **cliente** y de **Luis Martínez** | Calculados y guardados |

- Dónde vive: `src/lib/calculations/motor-factura.ts` (función probada con **tolerancia 0 pesos**).
- El dinero se maneja como **entero** (sin decimales flotantes) → nunca hay errores de redondeo de centavos.

---

## 6. Armar el borrador y que el papá lo revise → módulo Facturación

Antes: armabas el borrador en Excel y el papá lo revisaba contra los soportes, valor por valor.

| En el Excel | En el sistema | Dónde |
|---|---|---|
| Borrador armado a mano | **"Generar borrador"** desde los pagos ya registrados | **Facturación** |
| El papá revisa soporte vs valor | **Revisor split-screen**: soporte a la izquierda, valores a la derecha, aprobar/observar por línea | Facturación → Revisar |
| Pasar el número SIIGO (`BAQ-18288`) | "Marcar facturado" captura el número y la fecha | Facturación |
| Transcribir concepto por concepto a SIIGO | **Export XLSX** con concepto/soporte/valor (valores como número, no texto) | botón Exportar / `/api/borradores/[id]/export` |
| Imprimir/enviar el PDF | **PDF del borrador** con membrete | `/api/borradores/[id]/pdf` |

> El flujo de aprobación respeta los roles: solo el **revisor** (papá) aprueba; solo **admin** (Camila) marca facturado.

---

## 7. Hoja `RELACION FACT` → módulo de Cartera

La relación de facturas por cliente con saldos, cruce y fechas de pago, que filtrabas a mano.

| En el Excel (`RELACION FACT`) | En el sistema | Dónde |
|---|---|---|
| Facturas del cliente (DO, factura, anticipo, total, saldo) | Tabla de cartera por cliente | **Cartera** |
| Saldo a cargo / a favor del cliente y de LM | Calculado por separado (cliente y LM) | Cartera (cruce arriba) |
| Cruce de cuentas (a cargo − a favor) | **Cruce automático** cliente y LM | Cartera |
| Filtrar las no pagadas | Filtro "solo pendientes" | Cartera |
| Registrar fecha de pago para sacarla de pendientes | Registrar pago desde la fila (saca de pendientes, conserva histórico) | Cartera |
| PDF mensual de cobro | **Estado de cuenta PDF** | `/api/cartera/pdf` |

---

## 8. Lo que el Excel NO podía y el sistema sí (las mejoras)

- **Un solo dato, no 26 hojas:** el cliente, el anticipo y los pagos se escriben una vez y alimentan trámite, factura y cartera **conectados** (en el Excel las hojas no se cruzaban).
- **Sin doble digitación de consecutivos:** el DO se numera solo.
- **Sin errores de redondeo:** dinero entero, fórmulas verificadas al peso.
- **Trazabilidad:** cada cambio (crear, editar, aprobar, facturar) queda en el **Historial** del trámite (quién y cuándo).
- **Roles y permisos:** cada quien ve y hace solo lo suyo (el socio LM solo sus trámites; el operativo no aprueba facturas).
- **Documentos en la nube** (MinIO), no en un PC encendido 24 h.

---

## 9. Lo que sigue igual por ahora (Fase 2)

- **Transcripción a SIIGO:** sigue siendo manual en el MVP, pero el sistema te da el **XLSX 1:1** para minimizar el copy/paste. La creación automática de factura y recibo de caja vía API SIIGO es Fase 2.
- **Notificaciones** (correo/WhatsApp vía n8n), ingestión automática de correos, OCR de facturas y migración masiva de las 26 hojas históricas: Fase 2.

---

## 10. Para validarlo tú mismo

1. Entra a la plataforma con **camila@galcomex.com / `Galcomex2026!`**.
2. Ve a **Trámites → DO.BUN26-0026** (cliente GRUPO E PAPIS). Verás sus pagos, documentos y la factura `BAQ-18288`.
3. Compara cualquier valor con la hoja `BUN26-0026` del Excel: **debe coincidir al peso**.
4. En **Cartera**, elige GRUPO E PAPIS: verás la factura con sus saldos cliente/LM.

*Si algún valor no cuadra contra el Excel, el Excel manda: es un bug del sistema y se corrige (los casos reales del Excel son pruebas bloqueantes).*
