# Archivo de importación de facturas a SIIGO

> ℹ️ **Respaldo manual (2026-06-24).** El camino principal hoy es la **integración por API** (`docs/flujo-siigo-api.md`): el sistema envía la factura como borrador a Siigo sin Excel. Este archivo XLSX se mantiene como **plan B** (importación manual desde el portal Siigo) cuando la API no esté disponible.

Genera un archivo **XLSX en el formato oficial de importación de facturas de venta de SIIGO Nube**
("Subir desde Excel – Facturas de venta", columnas A–AE) a partir de un borrador del sistema.

- Endpoint: `GET /api/borradores/{id}/siigo-import` → descarga `siigo-import-<factura>.xlsx`.
- Código: `src/lib/export/siigo-import.ts` (formato puro) + la ruta.
- Fuente del formato: https://siigonube.portaldeclientes.siigo.com/subir-desde-excel-facturas-de-venta/

## Columnas que emite (orden exacto A–AE, SIIGO NO permite modificar columnas)
A Tipo de comprobante · B Consecutivo · C Identificación tercero · D Sucursal · E Centro de costos ·
F Fecha (DD/MM/AAAA) · G Moneda (COP) · H Tasa · I Nombre contacto · J Email · K Orden compra ·
L Orden entrega · M Fecha orden · **N Código producto** · O Descripción · P Id vendedor · Q Bodega ·
R Cantidad · **S Valor unitario** · T Descuento · U Base AIU · V Id ingreso terceros · **W Código IVA** ·
X Cargo 2 · Y Retención · Z ReteICA · AA ReteIVA · **AB Forma de pago** · AC Valor forma de pago ·
AD Fecha vencimiento · AE Observaciones.

## Códigos propios de tu cuenta SIIGO (variables de entorno)
El archivo se llena solo, pero estos códigos dependen de TU configuración contable en SIIGO.
Mientras no estén definidos se emiten como marcadores (`<TIPO_FV>`, `<COD_PRODUCTO>`).

| Variable (.env) | Columna | Qué es |
|---|---|---|
| `SIIGO_IMPORT_TIPO_COMPROBANTE` | A | Código del tipo de comprobante de Factura de Venta (ej. 1) |
| `SIIGO_IMPORT_COD_PRODUCTO` | N | Código del producto/servicio en tu catálogo SIIGO |
| `SIIGO_IMPORT_ID_VENDEDOR` | P | Cédula del vendedor (opcional) |
| `SIIGO_IMPORT_COD_IVA` | W | Código del impuesto IVA (se aplica a la comisión) |
| `SIIGO_IMPORT_COD_FORMA_PAGO` | AB | Código de la forma de pago |

Los obtienes en SIIGO: **Configuración → Contabilidad → Importación** (descarga su plantilla oficial
para ver los códigos válidos de tu empresa).

## Cómo usarlo
1. Define las 5 variables en `.env` con los códigos de tu SIIGO.
2. Genera un borrador y descarga el archivo desde `/api/borradores/{id}/siigo-import`.
3. En SIIGO: **Configuración → Importación → Facturas de venta → Subir desde Excel**.
4. Máx. 500 registros por archivo; no modifiques las columnas.

## Pendiente de confirmar contigo (para que importe perfecto)
- Los 5 códigos de arriba.
- **Composición de líneas:** hoy el archivo emite una línea por cada concepto del borrador
  + comisión (con IVA) + 4x1000 + costos bancarios. Falta confirmar cómo facturas hoy
  cada concepto en SIIGO y el tratamiento del IVA (como impuesto en col W vs. valor explícito).
- Ideal: comparte la **plantilla oficial de SIIGO** descargada y **un ejemplo de una factura ya
  transcrita** para alinear columnas y composición 1:1.
