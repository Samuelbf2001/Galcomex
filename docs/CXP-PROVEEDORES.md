# Cuentas por pagar a proveedores (CxP v2)

Lo que Galcomex le debe a sus proveedores (Almacarga, Express, Tampa Cargo, VUCE…),
factura por factura, y cómo se paga sin pagar dos veces. Diseño completo:
`DISENO-CXP-V2.md` (v1.1, 2026-09-24). PRD: `PRD-ALMACARGA-CXP-PROVEEDOR.md`.

Dinero: COP enteros (`BigInt`), tolerancia 0 pesos. Centavos = fase aparte.

## 1. Reglas

| # | Regla |
|---|---|
| R1 | **Saldo** = `valor − Σ monto aplicado − Σ ajustes − montoCompensado`, con `0 ≤ saldo ≤ valor`. El **estado es una función del saldo** (`estadoDe`): saldo 0 → `PAGADA`; saldo = valor → `REGISTRADA`; si no → `PARCIAL`. En pantalla: **Pendiente / Abonada / Pagada**. Solo `recalcularEstadoFactura` (P1) escribe el estado. |
| R2 | Nunca se aplica más que el saldo: lo valida el dominio (`validarAplicaciones`) y lo garantiza la BD (guardián, §3). |
| R3 | **Abono**: aplicar menos que el saldo deja la factura Abonada; sigue en el pendiente con su saldo. |
| R3b | **Una factura, un cruce** de cuenta corriente: la factura guarda un solo `compensacionId` y el `montoCompensado` total, así que un segundo cruce se rechaza (`registrarCompensacion`, 422 "ya tiene un cruce") y no aparece entre los cruzables. Lo que le falte se paga por el libro, o se deshace el cruce y se vuelve a cruzar por el total. |
| R6 | Un pago va a **un** proveedor. "Proveedor" = clave `NIT:<nitBase>` de la ficha (o `BEN:<id>` si la ficha no tiene NIT colombiano): dos fichas del mismo NIT (varias cuentas bancarias) son el mismo proveedor. |
| R8 | Costo bancario del pago en bloque: **una vez**, en `PagoGrupo.costoBancario`. Por DO, `puedeAbsorber` = cliente sin `factura_conceptos_iva` y borrador ausente o en BORRADOR/EN_REVISION. Defecto `PRIMER_DO` (el primero que puede absorberlo); si ninguno puede → `GALCOMEX`. Opción `PRORRATEADO` (restos mayores, Σ exacta), con peso = lo que el bloque le cobra al cliente de cada DO (sus facturas que se cobran; la asesoría NO SE COBRA no atrae costo). El saldo del DO que usa CxP (`saldoTramite`: aviso «anticipo insuficiente», estado de cuenta, conciliación) es el del **cliente**: anticipo − parte cobrable de los pagos, la misma cifra del libro. |
| R9 | "Sin anticipo no hay pago" = `anticipos_cliente && pago_exige_anticipo` del cliente del DO (capacidad nueva, encendida por defecto). No aplica a costos propios no repercutibles, histórico ni cruce. |
| R12 | Una factura por proveedor: `@@unique([proveedorClave, numFacturaNormalizado])`. `numFacturaNormalizado` = mayúsculas y solo A-Z0-9 (`FE- 12481` → `FE12481`). |
| R17 | Fechas-calendario (factura, pago, TRM, cruce): 00:00 UTC del día, se muestran en UTC (`formatFechaCalendario`); "hoy" = día calendario en Bogotá (`hoyBogotaISO`). |

### NIT sin adivinar el DV

`cxp_nit_base` (SQL) / `nitBaseDe` (TS): quita `NIT`, puntos y espacios; el dígito de
verificación **solo** se separa si viene separado con guion (`800.154.017-8` → `800154017`).
Una cadena de solo dígitos se toma completa (`800154017` → `800154017`,
`8001540178` → `8001540178`, una cédula de 10 dígitos queda intacta). Con letras → `NULL`
(no es NIT colombiano; la clave cae a `BEN:<id>`). DV DIAN: `cxp_dv_nit` / `dvNit`
(Almacarga 800154017-**8**, Express 802011826-**3**, Tampa 890912462-**2**).

## 2. Modelo (Prisma)

- `FacturaProveedor`: `numFacturaNormalizado`, `proveedorClave` (los llena el trigger; no escribir a mano), `moneda` (`COP`/`USD`), `valorOrigenCentavos`, `trmCentavos`, `fechaTrm`, `montoCompensado`. Estado nuevo `PARCIAL`. `FACTURADA_CLIENTE` queda deprecado (nunca se escribe).
- `PagoTramiteFactura.monto`: cuánto de ese pago se aplica a esa factura (NOT NULL, `CHECK monto >= 0`).
- `AjusteFacturaProveedor` (`CHECK monto > 0`): en v2 solo `LEGADO` (lo crea la migración; ADMIN solo puede eliminarlo).
- `PagoGrupo`: cabecera del pago en bloque (`id` = `PagoTramite.grupoPagoId`, FK `ON DELETE RESTRICT`): concepto, canal, fecha, comprobantes, `totalAplicado`, `costoBancario` (una vez), `costoAsumidoPor`, estado `ACTIVO/ANULADO`, `esHistorico`, `claveIdempotencia` (única), `hashSolicitud`, anulación.
- `PagoTramite.claveIdempotencia` (única) + `hashSolicitud` para el pago simple.
- `Beneficiario`: `nombreCorto` ("ALMACARGA"), `nitBase` (trigger), `numFacturaConEspacio` ("FE 11298"), `conciliacionPendiente`, `carteraConciliadaEn`.

## 3. Triggers y funciones SQL (primera vez en el proyecto)

Prisma no los modela y `prisma migrate dev` no los borra. Hay escritores que no pasan por
los servicios (scripts de importación y simulación, fixtures de pruebas): con triggers la
llave anti-duplicado y el tope de saldo valen para todos.

| Objeto | Qué hace | Estado tras M3 |
|---|---|---|
| `cxp_normalizar_num(text)` | N° normalizado (espejo `normalizarNumeroFactura`) | — |
| `cxp_nit_base(text)` | NIT base sin adivinar DV (espejo `nitBaseDe`) | — |
| `cxp_dv_nit(text)` | DV DIAN (espejo `dvNit`) | — |
| `cxp_clave_proveedor(id)` | `NIT:<nitBase>` o `BEN:<id>` (espejo `claveProveedorDeFicha`) | — |
| `trg_beneficiario_nit_base` | BEFORE INSERT / UPDATE OF nit → `nitBase` | **activo** |
| `trg_factura_proveedor_claves` | BEFORE INSERT / UPDATE OF numFactura, beneficiarioId → llaves; en UPDATE solo si el número o la ficha cambian **de verdad** (`IS DISTINCT FROM`), así un duplicado heredado no recupera la clave al editar el concepto | **activo** |
| `trg_beneficiario_reclave` | AFTER UPDATE OF nit (si cambia `nitBase`) → re-clave de sus facturas (no toca las de clave NULL) | **activo** |
| índice único `(proveedorClave, numFacturaNormalizado)` | una factura por proveedor (los NULL no chocan) | **activo** |
| `cxp_verificar_saldo(fid)` | `FOR UPDATE` de la factura; si aplicado + ajustes + compensado > valor → `RAISE 'CXP_SOBREAPLICACION: …'` (ERRCODE P0001) | — |
| `trg_pago_factura_saldo` | CONSTRAINT TRIGGER AFTER INSERT/UPDATE en el puente | **apagado** (lo enciende M5, P1) |
| `trg_ajuste_saldo` | CONSTRAINT TRIGGER AFTER INSERT/UPDATE en ajustes | **apagado** (M5) |
| `trg_factura_valor_saldo` | CONSTRAINT TRIGGER AFTER UPDATE OF valor, montoCompensado | **apagado** (M5) |

El dominio traduce `CXP_SOBREAPLICACION` con `esErrorSobreaplicacion(e)` → `MontoExcedeSaldoError` (409).

Comprobar en una base: `SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal;`
(`O` = activo, `D` = apagado).

## 4. Migraciones

| Archivo | Contenido | Dueño |
|---|---|---|
| `20260925100000_cxp_v2_tipos` | enums (`PARCIAL` va solo: no se puede usar en la misma transacción) | P0 |
| `20260925100100_cxp_v2_estructura` | columnas, tablas, índices, FKs de tablas nuevas, funciones SQL. `monto` nace NULL | P0 |
| `20260925100200_cxp_v2_backfill` | llaves, `monto` (pasadas 0–2), beneficiario de pagos huérfanos, cruces, ajustes `LEGADO`, estado, cabeceras `PagoGrupo`, FK del grupo, índice único, triggers (guardianes apagados) | P0 |
| `20260925100300_cxp_v2_capacidad_datos` | capacidad `pago_exige_anticipo` + filas `false` donde `anticipos_cliente` efectiva es `false`; `nombreCorto`/`numFacturaConEspacio`/`conciliacionPendiente` de Almacarga, Express y Tampa por `nitBase` | P0 |
| `20260925100400_cxp_v2_guardian` | `ENABLE TRIGGER` de los tres guardianes | P1 |

Todas **aditivas** y **no pueden fallar** con datos reales (sin `RAISE`, todo con
`GREATEST/LEAST/COALESCE`): el `docker-entrypoint.sh` corre `prisma migrate deploy` con `set -e`.

**Backfill de `monto`** (determinista, nunca sobre-aplica):
- Pasada 0: enlaces de pagos en bloque → el `montoPagadoEnGrupo` del AuditLog del bloque (el más cercano en el tiempo al pago), con tope en el valor de la factura.
- Pasada 1: cada pago reparte su valor entre sus facturas en orden (NO SE COBRA primero, fecha, createdAt, id): en un pago mixto que no alcanza, la asesoría se llena primero (regla de Ascinter) y nunca se le cobra al cliente. Aun así, los montos de un pago **mixto heredado** son una estimación: `pagos-cobrables` los reparte con la heurística de Ascinter y los marca por revisar (ver `montosSonEstimados`).
- Pasada 2: cada factura acepta pagos en orden (fechaRealPago NULLS LAST, createdAt, id) hasta su valor. Un doble pago viejo queda enlazado con monto 0 (sale como "pago que no cubre ninguna factura").

**No cambia el estado visible**: una factura `PAGADA` (o `FACTURADA_CLIENTE`) cuyos pagos no
alcanzan su valor recibe un ajuste `LEGADO` por el faltante ("Pagada con ajuste"; ADMIN puede
quitarlo y la factura se reabre). Una `REGISTRADA` con enlaces pasa a `PARCIAL`/`PAGADA`.

## 5. Módulo `src/lib/cxp/`

| Archivo | Tipo | Dueño |
|---|---|---|
| `saldos.ts` | puro: saldo/estado/etiqueta, `validarAplicaciones`, `repartirFIFO`, `prorratearExacto`, `costoPorPago`, `reglaCostoPorDefecto`, `puedeAbsorberCosto`, `resumenProveedor`, número/NIT/DV/clave, USD | P0 |
| `pagabilidad.ts` | puro: `evaluarPagabilidad` (listar = registrar) y advertencias | P0 |
| `errores.ts` | errores tipados (`CxpError`: `status`, `codigo`, mensaje exacto, `detalles`), `errorDeAplicacion`, `cuerpoErrorCxp`, `esErrorSobreaplicacion`; las 6 clases heredadas de `facturas-proveedor/service.ts` | P0 |
| `tipos.ts`, `contratos-api.ts` | tipos de dominio y JSON (importables desde el cliente) | P0 |
| `bloqueos.ts` | `bloquearTramites(tx, ids)` | P0 |
| `aplicar.ts`, `estado-cuenta.ts`, `pagabilidad-bd.ts` | BD: `aplicarSaldo`, `revertirSaldo`, `recalcularEstadoFactura`, estado de cuenta, `exigeAnticipoDelDo` | P1 |
| `conciliacion.ts`, `invariantes.ts` | conciliación con el Excel, invariantes I1–I7 | P7b |

**Orden único de bloqueo** (sin deadlocks): (1) cabecera de idempotencia, (2)
`bloquearTramites` (orden por id), (3) `bloquearFacturas` (orden por id). Siempre DOs antes que facturas.

## 6. Invariantes (P7b los verifica en BD; P8 en pruebas)

- I1 por proveedor: `Σ valor = pendiente + pagado + ajustado + cruzado` (`resumenProveedor` lanza si no).
- I2 por factura: `aplicado + ajustes + compensado ≤ valor` (guardián).
- I3 por pago: `Σ monto ≤ valor` (= valor si se creó con v2).
- I4 `estado = estadoDe(partes)`.
- I5 por bloque activo: `Σ PagoTramite.costoBancario = 0` si `GALCOMEX`, `= costoBancario` si `PRIMER_DO`/`PRORRATEADO`.
- I6 `totalAplicado = Σ valor` del bloque activo.
- I7 todo pago con puente tiene beneficiario y es del proveedor de sus facturas (salvo heredados del reporte Q4).

## 7. Reversa y re-avance (runbook)

- `scripts/cxp/reversa-v2.sql`: para volver a correr `e5cd35b` sobre una BD con M1–M5. Lista las Abonadas con su saldo ("pagar solo el saldo"), `PARCIAL → REGISTRADA`, quita la FK del grupo, `monto` admite NULL, apaga guardianes. Deja activos las llaves y el índice único (un duplicado da error genérico en el código viejo). El `prisma migrate deploy` de `e5cd35b` no falla con M1–M5 ya aplicadas (ensayado).
- `scripts/cxp/re-avance-v2.sql`: para volver a v2. Completa `monto` NULL con las pasadas de M3 respetando lo ya aplicado; arregla cruces hechos/deshechos por el código viejo; `LEGADO` para pagadas con faltante; recalcula estados; cabeceras de bloques nuevos; bloques activos sin pagos → ANULADO; FK de vuelta; enciende guardianes **solo si M5 está aplicada**; aborta (no guarda nada) si queda alguna factura sobre-aplicada (I2) o con estado distinto del saldo (I4). Idempotente.

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cxp/reversa-v2.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/cxp/re-avance-v2.sql
```

## 8. Traspaso P0 (lista cerrada; P8 la verifica vacía)

Pruebas y archivos que P0 tocó mecánicamente y cambian de dueño:

| Archivo | Qué hizo P0 | Nuevo dueño |
|---|---|---|
| `src/lib/pagos/__tests__/cxp-proveedor-almacarga.test.ts` | usa los fixtures de `src/lib/cxp/__tests__/fixtures/almacarga.ts`; CA-02/15/18/28 salieron del archivo. CA-07/09/10/13/14/30 siguen `it.fails` | P1 |
| `src/lib/facturas-proveedor/__tests__/cxp-facturas-almacarga.test.ts` | CA-02, CA-15, CA-18, CA-28 movidos tal cual (siguen `it.fails`; el `it` verde de CA-28 también) | P2 |
| `src/lib/pagos/service.ts` | errores desde `cxp/errores`; `monto` en los dos `pagoTramiteFactura.create` (tope = saldo actual, misma regla que M3); cabecera `PagoGrupo` en `crearPagoMultiDO` (la exige la FK) | P1 |
| `src/lib/pagos/generar-desde-factura.ts` | `generarPagoDesdeFactura` movido tal cual + `monto: factura.valor` | P1 |
| `src/lib/facturas-proveedor/service.ts` | re-exporta errores y `generarPagoDesdeFactura` | P2 |
| `scripts/importar-borrador-lucho.ts` | `monto` en los dos `upsert` | P1 |
| `src/lib/capacidades/__tests__/resolver.test.ts` | espera `pago_exige_anticipo` entre las capacidades encendidas por defecto | (arreglado por P0) |

Pruebas existentes que el índice único o los triggers de llaves rompieron: **ninguna**
(suite medida con M1–M4 aplicadas). Scripts rotos por `monto` obligatorio y que son de P2:
`scripts/sim-almacarga/cargar-caso-real.ts:629`, `scripts/sim-almacarga/reparar-pago-vuce-226.ts:77`.
