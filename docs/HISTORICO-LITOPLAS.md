# Histórico Litoplas 2026 — cómo cargarlo a la plataforma

> **En palabras simples.** Litoplas entregó en Drive las carpetas de sus 162
> trámites del 2026. Cada carpeta se convierte en un trámite de la plataforma
> marcado como **Histórico** (tiene su carpeta y sus documentos, pero no la
> parte de plata), y cada archivo queda en la bodega de documentos con su
> categoría. Dos scripts hacen todo: uno **clasifica en seco** y produce un
> manifiesto que Camila revisa; el otro **sube y registra** a partir de ese
> manifiesto, y se puede repetir sin duplicar nada.

Análisis previo con la estructura del Drive y las decisiones pendientes:
`Galcomex/historico-litoplas-2026-analisis.md`.

## Dónde quedan los documentos

En el bucket de documentos de producción, **Cloudflare R2** (bucket `galcomex`, ver
`docs/ALMACENAMIENTO-S3.md`), con la **misma forma que los documentos nuevos**:

```
tramites/<consecutivo-saneado>/<CATEGORIA>/<nombre original>
tramites/DO-BAQ26-0107/FACTURA_COMERCIAL/FACTURA. N. 83.pdf
tramites/DO-BAQ26-0107/DECLARACION_DIAN/DIMS Y DAVS FIRMADAS.pdf
tramites/DO-BAQ26-0107/OTRO/PO_OC38071_0.pdf
```

Por eso se ven igual en la pestaña **Archivos** (explorador del bucket) y en la
pestaña **Documentos** de cada DO, y un cambio de categoría mueve el archivo de
carpeta en ambos lados.

## Qué queda en la base de datos

Por cada carpeta de DO, un `TramiteDO` con:

| Campo | Valor |
|---|---|
| `consecutivo` | El real de la carpeta (`DO.26-0107` → `DO.BAQ26-0107`; `DO.CTG26-0003` igual) |
| `esHistorico` | `true` (distintivo ámbar "Histórico" en la lista y en la ficha) |
| `doCliente` y `referenciaExterna` | Número de importación de Litoplas (`IM036-26`) |
| `doAgencia` | Expediente de Moviaduanas (`I26050290`) |
| `proveedorCliente` | Proveedor extranjero (`ATF`) |
| `ordenCompraNumero` | OC de Litoplas si aparece en la carpeta o en el PDF `PO_OC…` |
| `agenciaAduanas` | `MOVIADUANAS` |
| `estado` | `FACTURADO` si hay factura de venta `BAQ-1xxxx` en la carpeta; si no, `EN_TRAMITE` |
| `comentarios` | Carpeta y rama de origen en el Drive |
| `creadoPor` | Usuario `importacion@galcomex.com` ("Importación histórico", rol OPERATIVO, sin clave conocida) |

Y un `Documento` por archivo subido (categoría, nombre original, clave en el
bucket, tipo y tamaño). No se crean anticipos, pagos ni facturas: eso es la
fase 2 y depende de la decisión de cartera.

**Seguridad de numeración.** Como el contador de la plataforma es
`max(numero) + 1` por ciudad y año, al crear los DOs históricos hasta el 0276
(BAQ) y 0248 (CTG) el contador queda automáticamente por delante. Si un
consecutivo ya existe y NO es histórico, el importador lo reporta como
**CONFLICTO** y no lo toca (hoy en producción: `DO.BAQ26-0005`).

## Paso a paso

1. **Descargar y dejar las partes de Drive** en `C:\Users\samue\Downloads`
   (`LITOPLAS-20260916T021913Z-1-00` … `-006`). Otra ubicación: `--partes "D:\a;D:\b"`.
2. **Clasificar en seco** (no sube nada, tarda unos minutos por la huella SHA-256):
   ```bash
   npx tsx scripts/historico-litoplas/clasificar.ts
   ```
   Deja `Galcomex/historico-litoplas-2026/manifiesto.csv` (una fila por archivo)
   y `resumen-dos.csv` (una fila por DO). Resultado del 2026-09-16: 162 DOs,
   10.786 archivos a subir (11,5 GB), 354 duplicados, 185 basura, 24 % en OTRO.
3. **Revisar con Camila** el resumen y, si hace falta, editar el manifiesto:
   cambiar `categoria`/`destino_key` de una fila, o poner `accion=OMITIR` para no
   subirla. Los `OTRO` también se pueden reordenar después desde la app.
4. **Probar con pocos DOs** contra el entorno local:
   ```bash
   npx tsx scripts/historico-litoplas/importar.ts --dry --solo DO.BAQ26-0107,DO.CTG26-0003
   npx tsx scripts/historico-litoplas/importar.ts --solo DO.BAQ26-0107,DO.CTG26-0003 --cliente-id <id>
   ```
   `--cliente-id` solo hace falta cuando hay más de una empresa cuyo nombre
   contiene "LITOPLAS" (en local existe una de demo).
5. **Producción, fase subir** (desde el PC, directo a R2; no pasa por la app ni
   carga el VPS). Las llaves de R2 van en `Galcomex/r2-llaves.env` (fuera del repo);
   **no** se edita el `.env` local, para que el entorno de desarrollo nunca apunte
   al bucket de producción:
   ```bash
   npx tsx --env-file=../r2-llaves.env scripts/verificar-storage.ts --grande   # antes: 12/12 ✅
   npx tsx --env-file=../r2-llaves.env scripts/historico-litoplas/importar.ts --fase subir
   ```
   Se puede cortar y relanzar: los objetos que ya están con el mismo tamaño se saltan.
   Los 3 archivos de más de 64 MB (hasta ~1 GB) suben por partes; probado contra R2
   con `verificar-storage.ts --grande`.

   **Orden obligatorio:** la fase registrar solo después de que la app de producción
   ya use R2 (`docs/ALMACENAMIENTO-S3.md`, paso 5). Si se registra mientras la app
   sigue en MinIO, los documentos quedan en la BD apuntando a archivos que la app no ve.
6. **Producción, fase registrar** (dentro del contenedor de la app, que sí ve la BD):
   copiar `manifiesto.csv` al contenedor y correr
   ```bash
   docker cp manifiesto.csv <contenedor-app>:/app/manifiesto.csv
   docker exec <contenedor-app> npx tsx scripts/historico-litoplas/importar.ts --fase registrar --manifiesto /app/manifiesto.csv
   ```
   Antes hay que resolver los CONFLICTOS que reporte (borrar o renumerar los DOs
   de prueba). Recordar la regla del VPS: una sola sesión, sin martillar.
7. **Verificar**: abrir tres DOs históricos (lista → distintivo Histórico →
   pestaña Documentos) y la pestaña Archivos → `tramites/<DO>/`.

## Cómo ordenan los agentes (o Camila) lo que quedó en OTRO

Los agentes de IA usan la misma API que la pantalla, así que pueden recorrer y
corregir las carpetas de cada trámite:

| Acción | Endpoint | Tool MCP |
|---|---|---|
| Ver el bucket carpeta por carpeta | `GET /api/archivos?prefix=tramites/DO-BAQ26-0107/` | `archivos_listar` |
| Listar documentos de un DO por categoría | `GET /api/tramites/{id}/documentos` | `documentos_listar` |
| Subir un archivo a un DO | `POST /api/tramites/{id}/documentos` (uploadUrl + register) | `documento_subir` |
| Descargar | `GET /api/tramites/{id}/documentos/{docId}` | `documento_descargar` |
| **Renombrar o cambiar de categoría** (mueve el archivo de carpeta) | `PATCH /api/tramites/{id}/documentos/{docId}` `{ nombreArchivo?, categoria? }` | `documento_editar` |
| Reemplazar el archivo | `PUT /api/tramites/{id}/documentos/{docId}` | `documento_actualizar` |
| Eliminar (a la papelera `deleted/`) | `DELETE /api/tramites/{id}/documentos/{docId}` | `documento_eliminar` |

Roles: ADMIN y REVISOR sobre cualquier documento; OPERATIVO solo sobre los que
subió; SOCIO solo lee sus trámites. Un trámite en estado CERRADO no admite
cambios de documentos (los históricos quedan en FACTURADO o EN_TRAMITE, así que
sí se pueden ordenar).

## Reglas de clasificación

Están en `scripts/historico-litoplas/reglas.ts` (funciones puras, con tests en
`src/lib/historico/__tests__/reglas-litoplas.test.ts`). La subcarpeta manda
(`DOCUMENTOS MOVIADUANAS` → Declaración DIAN, `FOTOS…` → Foto de
reconocimiento, `SOPORTES DE FACTURACION` → soporte/comprobante/factura de
proveedor según el nombre, `REGISTRO`/`RIM` → comprobante comercio); en la raíz
deciden las palabras del nombre (factura comercial, BL/HBL/guía, packing,
DIM/DAV/mandato/póliza, fondos, REG/VUCE). Lo demás cae en OTRO.

## Pendiente (no bloquea)

- Fase 2: anticipos, pagos y facturas históricos a partir de `SOL DE FONDOS.xls`, `BAQ-1xxxx` y `FESP…`.
- Descomprimir los ZIP/RAR de fotos dentro de `FOTO_RECONOCIMIENTO/` y recomprimir fotos y los 9 PDFs de más de 20 MB (hoy se suben tal cual).
- Los 3 DOs en curso sin número (`0XXX`) y los 199 archivos sueltos a nivel de proveedor quedan fuera hasta que tengan DO.
