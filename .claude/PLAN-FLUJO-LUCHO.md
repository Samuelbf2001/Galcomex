# Plan de corrección de flujos — Facturas de proveedor y portal de Lucho

> Origen: aclaración de Camila (2026-06-12) + análisis de los 2 Excel reales de Lucho:
> `C:\Users\samue\Galcomex\excel-lucho-1.xls` (BAQ-18453, GRUPO E PAPIS / LUTOSA, DO.CTG26-0118)
> `C:\Users\samue\Galcomex\excel-lucho-2.xls` (BAQ-18512, LITOPLAS / OPP FILM, DO.26-0113)

## 1. Glosario corregido (la fuente de la confusión)

| Término | Qué es realmente | Dirección | Estado en plataforma |
|---|---|---|---|
| **Anticipo** | Plata que el cliente envía para que Galcomex pague su trámite | Cliente → Galcomex | ✅ Correcto (`Anticipo` + `AplicacionAnticipo`) |
| **Pago** (libro de pagos) | Pago que Galcomex hace a un **proveedor** con plata del anticipo | Galcomex → Proveedor | 🟡 Existe (`PagoTramite`) pero sin vínculo a la factura del proveedor |
| **Factura de proveedor** | Factura que el proveedor le emite **a Galcomex** (la "referencia" FACT FESP..., FL..., NVS... del Excel). Lucho la envía por correo con los comprobantes | Proveedor → Galcomex | ❌ NO existe como entidad — solo categoría de documento y texto libre en `numSoporte` |
| **Factura de venta** | Factura de Galcomex **al cliente** (BAQ-XXXXX en SIIGO) | Galcomex → Cliente | ✅ Correcto (`BorradorFactura` + `Factura`) |
| **Pago del cliente** | El cliente paga la factura de venta → cartera | Cliente → Galcomex | ✅ Correcto (`fechaPagoCliente/LM`) |
| **Sobregiro** | Pagos > anticipo → el extra se le cobra al cliente (saldo a cargo) | — | ✅ El motor lo maneja |
| **Retenciones** | RETE IVA / RETE FTE / RETE ICA que el cliente descuenta del total | — | ❌ NO existen en el motor |

Dos "Luchos" distintos: **Sr. Lucho** (operario puerto, fotos) ≠ **Lucho/Luis Martínez (LM)** = socio, rol `SOCIO`. Este plan es sobre el **socio LM**, que gestiona facturas de proveedor y paga en efectivo a proveedores cuando recibe transferencias.

## 2. Evidencia de los Excel de Lucho (formato del borrador de venta)

Estructura (ambos archivos, hoja "Hoja1"):
- Cabecera: cliente, NIT, fecha, **N° factura BAQ-XXXXX**, descripción del DO (factura comercial, contenedor, BL).
- Sección **"INGRESOS RECIBIDOS PARA TERCEROS"**: una línea por pago a proveedor, con la **referencia de la factura del proveedor** embebida en el concepto. Fondo azul `99CCFF` = pagado por **PSE** directo desde cuenta Galcomex; sin fondo = **transferencia a Lucho** que paga en efectivo. Incluye línea de 4x1000.
- Sección **"INGRESOS OPERACIONALES"**: la comisión, a veces desglosada en varios conceptos (ej. LITOPLAS: REVISION DOCUMENTOS 20.000 + SISTEMATIZACION 20.000 + LOGISTICA OPERATIVA 100.000) + 19% IVA.
- **MENOS retenciones**: RETE IVA 0,15×IVA (LITOPLAS); plantilla antigua: RETE IVA 0,5×IVA, RETE FTE 11%, RETE ICA 0,8%.
- Totales: `TOTAL FACTURA = total terceros + operacionales + IVA − retenciones`; `SALDO = ANTICIPO − TOTAL FACTURA` (negativo = a favor del cliente).

**Casos dorados nuevos (tolerancia 0 pesos):**
- BAQ-18453: terceros 32.652.000 (incl. 4x1000 130.088) + comisión 400.000 + IVA 76.000 = **total 33.128.000**; anticipo 35.074.500 → **saldo a favor 1.946.500**.
- BAQ-18512: terceros 1.159.620 (incl. 4x1000 4.620) + operacionales 140.000 + IVA 26.600 − reteIVA 3.990 = **total 1.322.230**; anticipo 1.572.000 → **saldo a favor 249.770**.

## 3. Flujo TO-BE (Lucho dentro de la plataforma)

1. Lucho (rol `SOCIO`) entra → ve **sus** trámites (clientes `SOCIO_LM`).
2. Sube **facturas de proveedor** (PDF + datos: proveedor, n° factura, valor, fecha) y **comprobantes de pago** al DO.
3. De cada factura registra/genera el **pago** correspondiente (canal PSE directo o efectivo vía Lucho) — queda vinculado `PagoTramite ↔ FacturaProveedor`.
4. Cuando el DO está completo, Lucho **solicita facturación** → el DO pasa a `ENVIADO_A_FACTURAR`.
5. Camila revisa (cada línea con su factura de proveedor al lado), genera el borrador (motor), papá aprueba, Camila factura en SIIGO → **Factura de venta** vinculada a las facturas de proveedor vía sus líneas/pagos.
6. Cartera registra el pago del cliente.

## 4. Workstreams

### WS-A — Backend: entidad FacturaProveedor + retenciones en el motor (BLOQUEANTE)
**Scope de archivos:** `prisma/schema.prisma` + migración, `src/lib/facturas-proveedor/**` (nuevo), `src/lib/calculations/motor-factura.ts` (SOLO aditivo), `src/lib/borradores/service.ts`, `src/lib/validations/**`, `src/app/api/**` (rutas nuevas), tests.
1. Modelo `FacturaProveedor`: `tramiteId`, `proveedorNombre`, `proveedorNit?`, `numFactura`, `valor BigInt`, `fecha`, `estado` (`REGISTRADA → PAGADA → FACTURADA_CLIENTE`), `documentoId?` (archivo en MinIO), `subidaPorId`, timestamps. Única por `(tramiteId, numFactura)`.
2. `PagoTramite`: agregar `facturaProveedorId?` (FK opcional — pagos como impuestos DIAN no tienen factura) y `viaSocio Boolean @default(false)` (transferencia a Lucho que paga en efectivo).
3. Motor: input opcional `retenciones?: bigint` (total RETE IVA+FTE+ICA). Efecto: `totalFactura −= retenciones` y el saldo del cliente aumenta en la misma cantidad (el cliente paga menos pero la retención es plata que Galcomex recupera vía DIAN — replicar EXACTO el Excel: ambos casos dorados al peso). NO romper el caso dorado BUN26-0026 (sin retenciones → comportamiento idéntico).
4. `BorradorFactura`: columnas `retenciones BigInt @default(0)` y `conceptosOperacionales Json?` (desglose de la comisión: `[{concepto, valor}]`, suma = comisión).
5. APIs: CRUD `/api/tramites/[id]/facturas-proveedor` (+ PATCH/DELETE por id), `POST /api/facturas-proveedor/[id]/generar-pago` (crea PagoTramite vinculado, hereda valor/beneficiario/numSoporte), `POST /api/tramites/[id]/solicitar-facturacion` (rol SOCIO o ADMIN: valida pagos>0, pasa estado a ENVIADO_A_FACTURAR con auditoría).
6. Permisos SOCIO: ve/crea facturas de proveedor y documentos SOLO en trámites de clientes `SOCIO_LM`; no aprueba ni factura. Tests de matriz 403.
7. Tests: 2 casos dorados nuevos del motor (sección 2), CRUD, generar-pago, permisos, sin regresión (117 existentes verdes).

### WS-B — Frontend: portal SOCIO + UI facturas de proveedor (tras WS-A)
**Scope:** `src/components/**`, `src/app/(dashboard)/**`, sin tocar `src/lib/calculations` ni schema.
1. Pestaña/sección **"Facturas proveedor"** en el detalle del DO: tabla (proveedor, n° factura, valor, estado, archivo), subir archivo, botón "Generar pago".
2. Libro de pagos: columna/badge con la factura de proveedor vinculada y si fue vía Lucho (efectivo).
3. **Portal SOCIO**: al entrar con rol SOCIO ve solo sus trámites; en el DO puede subir facturas/comprobantes y botón **"Solicitar facturación"**.
4. Revisor split-screen: para cada línea, mostrar el archivo de la factura de proveedor vinculada (ya hay visor de documentos).
5. Borrador: editor del desglose de conceptos operacionales + campo retenciones, recálculo en vivo coherente con el motor.
6. Terminología en toda la UI: "Pagos a proveedores" (libro), "Anticipos de clientes", "Facturas de venta" vs "Facturas de proveedor".

### WS-C — Importador del Excel de Lucho (paralelo a WS-B)
**Scope:** `src/lib/excel/borrador-lucho.ts` (nuevo), `scripts/importar-borrador-lucho.ts`, tests.
1. Parser del formato .xls de Lucho: cabecera (cliente, factura BAQ, fecha, DO), líneas de terceros con referencia de factura de proveedor extraída del concepto, color `99CCFF` → PSE / sin color → vía Lucho, operacionales, IVA, retenciones, totales. Usar `XLSX.readFile(f, { cellStyles: true })`.
2. Script CLI idempotente: crea/encuentra cliente y DO, crea facturas de proveedor + pagos + borrador con los valores del Excel, reporta reconciliación al peso.
3. Test de reconciliación contra los 2 archivos reales (copias en `C:\Users\samue\Galcomex\`).

## 5. Criterio de aceptación global
- `npm run test` verde (117 existentes + nuevos), `tsc` limpio, `npm run build` exit 0.
- Importar `excel-lucho-1.xls` y `excel-lucho-2.xls` reproduce TOTAL FACTURA y SALDO al peso.
- E2E manual: login como SOCIO → subir factura proveedor → generar pago → solicitar facturación → Camila genera borrador → valores correctos.
- El caso dorado BUN26-0026 sigue cuadrando (réplica + test).
