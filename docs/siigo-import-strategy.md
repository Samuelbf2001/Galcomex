# Estrategia puente SIIGO sin API

Fecha: 2026-06-12

## Decision

Mientras SIIGO no entregue credenciales API, el MVP debe generar archivos Excel importables por SIIGO Nube para facturas de venta. La API queda como fase posterior; el export Excel es el camino critico para reducir digitacion desde el primer go-live.

## Fuente SIIGO

SIIGO documenta importacion masiva de facturas de venta por:

`Configuracion -> Contabilidad -> Importacion -> Comprobantes contables -> Facturas`

Articulo oficial:
https://siigonube.portaldeclientes.siigo.com/subir-desde-excel-facturas-de-venta/

Puntos relevantes:

- Se descarga una plantilla Excel desde SIIGO y no se deben modificar, eliminar ni adicionar columnas.
- Maximo 500 registros por archivo; si supera eso, se debe fraccionar.
- Antes de importar deben existir/configurarse: tipo de comprobante, terceros, centros de costo si aplican, vendedores, bodegas si aplican, productos/servicios, impuestos y formas de pago.
- La factura puede tener varias lineas de producto; las columnas de forma de pago se llenan una sola vez para la factura, no en todas las lineas.
- La fecha de factura electronica debe coincidir con la fecha de envio a DIAN, segun FAQ SIIGO.

## Columnas clave de la plantilla SIIGO

Segun el articulo oficial de facturas desde Excel:

- A: Tipo de comprobante
- B: Consecutivo
- C: Identificacion tercero
- D: Sucursal
- E: Centro/subcentro de costos
- F: Fecha de elaboracion
- G: Sigla moneda
- H: Tasa de cambio
- I: Nombre contacto
- J: Email contacto
- K: Orden de compra
- L: Orden de entrega
- M: Fecha orden de entrega
- N: Codigo producto
- O: Descripcion producto
- P: Identificacion vendedor
- Q: Codigo de bodega
- R: Cantidad producto
- S: Valor unitario
- T: Valor descuento
- U: Base AIU
- V: Identificacion ingreso para terceros
- W: Codigo impuesto cargo
- X: Codigo impuesto cargo dos
- Y: Codigo impuesto retencion
- Z: Codigo ReteICA
- AA: Codigo ReteIVA
- AB: Codigo forma de pago
- AC: Valor forma de pago
- AD: Fecha vencimiento
- AE: Observaciones

## Mapeo Galcomex -> SIIGO

Export minimo para probar con Camila:

- Tipo de comprobante: parametro configurable por ambiente/cliente.
- Consecutivo: numero SIIGO reservado o sugerido; no debe ser el DO.
- Identificacion tercero: NIT del cliente.
- Fecha elaboracion: fecha actual de envio/importacion, no fecha historica, para evitar rechazo DIAN.
- Producto/servicio: usar codigos SIIGO preconfigurados para cada concepto facturable.
- Cantidad: 1 por concepto.
- Valor unitario: valor exacto COP entero.
- Impuesto: codigo SIIGO configurable por concepto.
- Forma de pago: credito o contado segun configuracion SIIGO. Desde 2025 la API y ventas manejan contado/credito; validar igual en plantilla real.
- Valor forma de pago: total neto de la factura.
- Observaciones: incluir DO, soportes y resumen corto. Maximo 300 caracteres.

## Pre-requisitos para levantar de inmediato

Pedirle a Camila/SixTeam una plantilla real descargada desde la cuenta SIIGO de Galcomex. Guardarla en:

`templates/siigo/facturas-venta-template.xlsx`

Tambien pedir una captura/listado de:

- Codigo del tipo de comprobante de factura.
- Ultimo consecutivo SIIGO y regla de numeracion.
- NIT exacto de los clientes en SIIGO.
- Codigos de productos/servicios para conceptos usados en Galcomex.
- Cedula/identificacion del vendedor SIIGO.
- Codigo forma de pago credito/contado.
- Codigos de impuestos aplicables.

## Implementacion sugerida

1. Crear tabla/parametros `SiigoExportConfig` o usar `Parametro` al inicio:
   - `SIIGO_TIPO_COMPROBANTE_FACTURA`
   - `SIIGO_IDENTIFICACION_VENDEDOR`
   - `SIIGO_FORMA_PAGO_CREDITO`
   - `SIIGO_FORMA_PAGO_CONTADO`
   - `SIIGO_CODIGO_PRODUCTO_DEFAULT`
   - `SIIGO_CODIGO_IVA_COMISION`
2. Crear modulo `src/lib/excel/siigo-facturas.ts`.
3. Exportar desde `BorradorFactura` aprobado, nunca desde datos editables sin aprobar.
4. Escribir sobre copia de la plantilla real para preservar columnas y estilos.
5. Generar endpoint:
   - `GET /api/facturacion/borradores/{id}/export-siigo`
6. Validar antes de descargar:
   - cliente con NIT
   - borrador aprobado
   - numero SIIGO/consecutivo definido
   - fecha factura = fecha actual
   - todas las lineas tienen codigo SIIGO o default permitido
7. Registrar auditoria con snapshot del XLSX generado.

## Resultado esperado

Camila ya no copia linea por linea en SIIGO. El sistema genera el archivo, ella entra a SIIGO, importa, revisa la previsualizacion, termina la carga y luego registra el numero SIIGO final en Galcomex.

## Riesgos

- La plantilla de SIIGO puede variar por cuenta/configuracion. No generar un Excel "inventado"; usar siempre la plantilla descargada de Galcomex.
- Si terceros/productos/impuestos no existen en SIIGO, la importacion falla. Hay que tener una pantalla de configuracion/validacion.
- Para facturas electronicas, la fecha debe ser la del dia de envio a DIAN.
- Anticipos: SIIGO permite cruzar anticipos al elaborar factura, pero hay que validar si la importacion Excel soporta el cruce exactamente como Camila lo hace. Si no, se importa la factura y se deja el cruce/recibo de caja como paso manual o segundo archivo contable.
