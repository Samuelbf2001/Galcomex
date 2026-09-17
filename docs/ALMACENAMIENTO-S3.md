# Almacenamiento de documentos: de MinIO en el VPS a una "bodega" S3 externa

> **En palabras simples.** Hoy los documentos de Galcomex se guardan en el mismo
> computador donde corre la app (el VPS de Hostinger, compartido con otros
> clientes de Sixteam). Ese computador tiene un solo disco y no hay copia de
> los documentos por fuera. Para el histórico 2026 (~100 GB) conviene alquilar
> una bodega aparte, hecha solo para guardar archivos (Cloudflare R2 o
> Backblaze B2). La app ya sabe hablar con esa bodega: solo cambia una
> dirección y unas llaves. Y la pestaña **Archivos** del menú deja entrar a ver
> qué hay guardado, carpeta por carpeta, como la consola de MinIO.

## Qué quedó preparado en el código (2026-09-15)

| Pieza | Dónde | Para qué |
|---|---|---|
| Configuración genérica S3 | `src/lib/storage/config.ts` | Mismas variables `MINIO_*`; detecta el proveedor por el host (`r2`, `b2`, `s3`, `minio`), asume puerto 443 con SSL, región `auto` para R2, `MINIO_PATH_STYLE`. |
| Cliente con path-style | `src/lib/storage/client.ts` | R2 y B2 funcionan con `https://host/bucket/clave`. |
| Explorador de archivos (backend) | `src/lib/storage/explorador.ts`, `GET /api/archivos` | Lista UNA carpeta por llamada (nunca los 100 GB), cruza con la BD para mostrar nombre real, categoría, DO y quién subió. |
| Pantalla **Archivos** | `/archivos` (`src/components/archivos/`) | Carpetas, migas de pan, filtro, atajo "Ir al DO", Ver / Descargar. Roles ADMIN, REVISOR, OPERATIVO. La papelera `deleted/` solo ADMIN. |
| Nombre real al descargar | `GET /api/storage/objeto?…&nombre=` | El archivo baja con su nombre y no con el uuid. Los cargados por fuera sin tipo se abren por extensión. |
| Tool MCP | `archivos_listar` | Un agente puede navegar el bucket igual que la UI. |
| Script de verificación | `scripts/verificar-storage.ts` | Hace cada operación que la app usa contra el bucket, con las mismas funciones: subir (buffer y streaming), stat, descargar y comparar, 404, mover de carpeta, papelera `deleted/`, listar recursivo y por nivel, borrar. `--grande` agrega una subida por partes de 70 MB. |

Nada de esto cambia el comportamiento actual si las variables siguen apuntando
a MinIO. El cambio de proveedor es **solo configuración**.

## Dónde usa el sistema la bodega (revisado 2026-09-16)

Todo pasa por `src/lib/storage/` con el cliente S3 (`minio-js`); **ningún otro
módulo habla con la bodega**, así que cambiar las variables cambia todo a la vez.

| Quién | Cómo llega a la bodega | Operaciones |
|---|---|---|
| Documentos del DO (subir, reemplazar, recategorizar, eliminar, ver), comprobantes de pagos, facturas de proveedor y adjuntos al crear DO | `/api/tramites/[id]/documentos` → `lib/documentos/service.ts` → `lib/storage/service.ts` | enlace firmado PUT/GET, `copyObject`+`removeObject` (mover y papelera) |
| Soportes de anticipos y comprobantes de cobros en cartera | `POST /api/storage` (`uploadUrl` / `downloadUrl`) | enlace firmado PUT/GET |
| Subida y descarga real de bytes | `/api/storage/objeto` (proxy firmado, `lib/storage/proxy.ts`) | `putObject` en streaming, `statObject`, `getObject`; 404 si no existe |
| Enlace público de documento | `/api/compartir/[token]` | enlace firmado GET |
| Pantalla Archivos y tool MCP `archivos_listar` | `GET /api/archivos` → `lib/storage/explorador.ts` | `listObjectsV2` por nivel |
| MCP `documento_subir` / `documento_actualizar` / `documento_descargar` | vía API de la app (nunca directo) | lo mismo que la UI |
| Importador histórico Litoplas | `scripts/historico-litoplas/importar.ts` desde el PC, directo al bucket | `putObject` (por partes > 64 MB), `statObject` |

El navegador y el MCP **nunca** hablan con la bodega: la app firma sus propios
enlaces. Por eso R2 no necesita CORS ni acceso público. Solo si alguien activa
`STORAGE_DIRECT_PRESIGN=true` harían falta `MINIO_PUBLIC_*` y una regla CORS.

**Resultado contra R2 (2026-09-16):** 12/12 ✅ con `--grande` (70 MB por partes en
4,7 s) y también con `MINIO_REGION=us-east-1`, el valor que tiene hoy producción
(R2 lo acepta como alias de `auto`; igual conviene cambiarlo).

## Producción hoy (medido 2026-09-16)

- App: servicio **App** de EasyPanel `galcomex-app` en el proyecto `postgres`
  (se construye con el `Dockerfile`; `docker-compose.yml` no se usa en producción).
- MinIO: servicio `postgres_minio`, **solo lo usa Galcomex**; ~5 MB.
- Variables de almacenamiento actuales de la app: `MINIO_ENDPOINT=postgres_minio`,
  `MINIO_PORT=9000`, `MINIO_USE_SSL=false`, `MINIO_REGION=us-east-1`,
  `MINIO_BUCKET=galcomex`, `MINIO_PUBLIC_ENDPOINT=storage.sixteam.pro`,
  `MINIO_PUBLIC_PORT=443`, `MINIO_PUBLIC_USE_SSL=true`, más las dos llaves.
- El código desplegado (master) ya funciona con R2 cambiando solo variables:
  lee `MINIO_REGION` y `MINIO_PORT`, y `minio-js` usa path-style por defecto.

## Paso a paso: pasar producción a Cloudflare R2

**Quién:** la cuenta es de Sixteam (`samuel@sixteam`, Account ID
`234925b30e7a81da84715ab12edeb906`). Tarjeta y facturación quedan a su nombre.

1. ✅ **Cuenta y bucket** (2026-09-16): bucket `galcomex`, ubicación *Automatic*,
   clase *Standard*, sin acceso público.
2. ✅ **Llaves**: *Manage API tokens → Create Account API token* `galcomex-app`,
   permiso **Object Read & Write** solo sobre `galcomex`, TTL *Forever*.
   - Guardar *Access Key ID* y *Secret Access Key* en el gestor de contraseñas y
     en `Galcomex/r2-llaves.env` (fuera del repo). Nunca en memoria, CLAUDE.md ni
     capturas de pantalla. Si una llave se expuso: token → **Roll** (cambia el
     secret, el Access Key ID sigue igual) y actualizar donde esté.
3. ✅ **Probar desde el PC** sin tocar el `.env` local (el entorno de desarrollo
   nunca apunta al bucket de producción):
   ```bash
   npx tsx --env-file=../r2-llaves.env scripts/verificar-storage.ts --grande
   ```
   Debe salir todo ✅. Si el primer paso falla es endpoint, bucket o llaves.
4. **Copiar lo que ya hay en MinIO de producción** (~5 MB). Fuera de horario, en
   UNA sesión SSH, justo antes del paso 5 (así no queda nada subido entre la copia
   y el cambio). La imagen `minio/minio` trae `mc` y ya tiene sus credenciales en
   `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`; las de R2 entran por un archivo
   temporal, no por la línea de comandos:
   ```bash
   # docker --env-file no quita comillas: se mandan sin ellas, por stdin, en la misma sesión
   sed 's/"//g' r2-llaves.env | ssh -i <clave> root@72.60.67.214 '
     umask 077; cat > /root/r2.env
     C=$(docker ps --format "{{.Names}}" | grep "^postgres_minio\." | head -1)
     docker exec --env-file /root/r2.env "$C" sh -c "
       mc alias set viejo http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" &&
       mc alias set r2 https://\$MINIO_ENDPOINT \"\$MINIO_ACCESS_KEY\" \"\$MINIO_SECRET_KEY\" &&
       mc mirror --preserve viejo/galcomex r2/galcomex && mc du viejo/galcomex && mc du r2/galcomex"
     rm -f /root/r2.env'
   ```
   (Verificar al ejecutar que `mc` exista en la imagen; si no, `minio/mc` en la
   red del proyecto de EasyPanel.)
5. **Cambiar las variables en EasyPanel** (`postgres` → `galcomex-app` → Environment):
   - `MINIO_ENDPOINT=234925b30e7a81da84715ab12edeb906.r2.cloudflarestorage.com`
   - `MINIO_PORT=443` (explícito: el código de master no lo deduce)
   - `MINIO_USE_SSL=true`
   - `MINIO_REGION=auto`
   - `MINIO_BUCKET=galcomex`
   - `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` = llaves de R2 (las pega una persona)
   - **Borrar** `MINIO_PUBLIC_ENDPOINT`, `MINIO_PUBLIC_PORT`, `MINIO_PUBLIC_USE_SSL`
     (apuntan a `storage.sixteam.pro`, el MinIO viejo).

   Redeploy **uno solo**, fuera de horario laboral.
6. **Verificar en producción**
   - Abrir un DO con documentos y descargar uno (prueba que la copia del paso 4 llegó).
   - Subir un documento a un DO de prueba, descargarlo y eliminarlo.
   - Opcional, dentro del contenedor: `npx tsx scripts/verificar-storage.ts`.
   - Cuando llegue el deploy con la pantalla **Archivos**: el chip de arriba debe
     decir *Cloudflare R2 · bucket galcomex*.
7. **Después de una semana sin problemas**: apagar el servicio `postgres_minio`
   (no borrarlo todavía) y luego retirar el dominio `storage.sixteam.pro`.

### Variante Backblaze B2

Igual, con: bucket privado, *Application Key* limitada al bucket,
`MINIO_ENDPOINT="s3.<region>.backblazeb2.com"`, `MINIO_PORT=443`,
`MINIO_REGION="<region>"` (la región sale del endpoint que muestra B2, p. ej.
`us-west-004`).

## Cómo subir el histórico 2026 (~100 GB) sin pasar por la app

La pantalla de documentos de la app tiene tope de 25 MB por archivo y cada byte
pasa por el servidor. Para 100 GB se sube **directo a la bodega** desde el PC
donde están los archivos, con `rclone` (gratis, Windows/Mac/Linux):

1. Instalar rclone y configurarlo una vez (`rclone config`): tipo *s3*, proveedor
   *Cloudflare*, las mismas llaves, endpoint `https://<AccountID>.r2.cloudflarestorage.com`.
2. Organizar el histórico en carpetas por DO, por ejemplo
   `HISTORICO-2026\DO.BUN26-0026\factura.pdf`.
3. Subir (reanudable, se puede cortar y volver a lanzar):
   ```bash
   rclone copy "D:\HISTORICO-2026" r2:galcomex/historico/2026 --transfers 4 --checkers 8 --bwlimit 8M --progress
   ```
   `--bwlimit 8M` evita saturar el internet de la oficina; quitarlo de noche.
4. Al terminar, verificar que no falte nada:
   ```bash
   rclone check "D:\HISTORICO-2026" r2:galcomex/historico/2026 --one-way
   ```
5. En la app, **Archivos → historico → 2026** muestra las carpetas tal cual se
   subieron, con Ver / Descargar. No hace falta registrar nada en la base de datos
   para poder consultarlos.

**Pendiente (si se quiere):** un script que enlace `historico/2026/<DO>/…` con
el trámite correspondiente en la BD para que aparezcan también dentro de la
pestaña Documentos del DO. Hoy se ven solo desde Archivos.

## Por qué la bodega externa y no el disco del VPS

- El VPS es compartido con ~12 proyectos; 100 GB se comen la mitad del espacio libre.
- Las copias de seguridad de Hostinger son del disco completo: crecen 100 GB y
  restaurar tarda horas para todos los clientes.
- Hoy no existe copia de los documentos fuera del VPS; R2/B2 replican solos.
- Costo: ~1,5 USD/mes en R2 por 100 GB (descargas gratis) frente a subir de plan
  de VPS para todos.

Desventajas a tener en cuenta: una cuenta y una factura más (en dólares), los
datos quedan en un tercero fuera de Colombia, y si el proveedor cae los
documentos no se ven aunque la app funcione.
