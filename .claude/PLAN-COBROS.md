# Plan — Cobros de factura (abonos parciales) y devoluciones

> Origen: aclaración del usuario (2026-06-13). "Se hacen abonos, no necesariamente se paga
> toda la factura en una sola transacción; a veces sobra dinero y toca devolverlo."
> Resuelve el hueco: hoy el cobro en `cartera/service.ts` solo escribe `fechaPagoCliente/LM`
> (una fecha, sin monto, sin comprobante, sin pagos parciales).

## 1. Decisión de modelado (ya tomada)

NO reutilizar `Anticipo`. Anticipo = fondo PRE-trámite que se aplica a DOs y financia el libro
de pagos (pasivo: le debemos servicio). Cobro de factura = COBRO POST-factura que salda cartera
(activo: nos deben). Misma dirección de caja, contabilidad y ciclo opuestos. Entidad propia +
una vista unificada de "Ingresos / Libro de bancos" que los muestra juntos para conciliar banco.

## 2. Ledger unificado (la fórmula que lo resuelve todo)

Por cada `(factura, destino)` con destino ∈ {CLIENTE, LM}, convención **positivo = Galcomex debe** a esa parte:

```
saldoNeto = (saldoAFavor − saldoACargo) + Σ(ABONO) − Σ(DEVOLUCION)
```
- `saldoNeto > 0` → Galcomex debe → **pendiente de devolución** = saldoNeto
- `saldoNeto < 0` → la parte debe → **pendiente de cobro** = |saldoNeto|
- `saldoNeto = 0` → factura saldada para ese destino

Esto maneja en una sola fórmula: cobro normal, abonos parciales, sobrepago (abonos > saldo a
cargo genera saldoNeto>0 → toca devolver), y el saldo a favor original (golden case cliente
+3.357.958 → devolución de 3.357.958 lo salda).

**Invariante:** con 0 abonos y 0 devoluciones, `saldoNeto` = saldo a favor inicial → el cruce de
cartera actual (`Σ saldoACargo − Σ saldoAFavor`) debe seguir cuadrando. No romper el test dorado
ni los 194 tests.

## 3. WS-D — Backend (BLOQUEANTE; primero)

**Scope:** `prisma/schema.prisma` + migración, `src/lib/cartera/service.ts`, `src/lib/validations/cartera.ts` (nuevo),
`src/app/api/facturas/[id]/pagos/**` (nuevas rutas), `src/lib/ingresos/service.ts` (nuevo) + `src/app/api/ingresos/route.ts`, tests.
NO tocar: motor, borradores, anticipos service, componentes.

1. **Schema:** modelo `PagoFactura` { id, facturaId FK→Factura (onDelete: Restrict), destino `DestinoPago`
   (enum CLIENTE|LM), tipo `TipoPagoFactura` (enum ABONO|DEVOLUCION), monto BigInt, fecha DateTime,
   canalPago CanalPago, comprobanteKey String?, verificadoBanco Boolean @default(false),
   registradoPorId FK→User, createdAt }. Relación inversa `pagos PagoFactura[]` en Factura y en User.
   Conservar `fechaPagoCliente/fechaPagoLM` en Factura (se vuelven derivadas: se setean cuando el
   destino llega a saldoNeto 0; quedan para compat con PDF/cartera existente).

2. **`cartera/service.ts`:**
   - `registrarPagoFactura({ facturaId, destino, tipo, monto, fecha, canalPago, comprobanteKey?, verificadoBanco?, usuarioId })`:
     crea `PagoFactura`, recalcula saldoNeto del destino, si llega a 0 setea la `fechaPago{Cliente|LM}`
     (si se reabre por una devolución posterior, la limpia), audita. Validaciones: monto>0; ABONO solo si
     hay saldo a cobrar o se permite sobrepago (permitir, pero el resultado marca pendiente de devolución);
     DEVOLUCION no puede exceder el saldo a favor disponible (saldoNeto>0) → 422 si excede.
   - `eliminarPagoFactura(id, usuarioId)`: revierte (recalcula, reabre fechaPago si aplica), audita.
   - `getCarteraCliente`: enriquecer cada factura con `abonosCliente`, `devolucionesCliente`,
     `saldoNetoCliente`, `pendienteCobroCliente`, `pendienteDevolucionCliente` (y los 4 equivalentes LM),
     más la lista de `pagos`. `soloPendientes` ahora = `saldoNetoCliente != 0 OR saldoNetoLM != 0`
     (reemplaza el filtro por fecha). Mantener `cruceCliente`/`cruceLM` (ahora deben reflejar el neto con abonos/devoluciones).
   - `getFacturaConPagos(facturaId)`: detalle con su lista de PagoFactura.

3. **Validaciones Zod** `src/lib/validations/cartera.ts`: `registrarPagoFacturaSchema` (destino, tipo, monto coerce bigint>0, fecha, canalPago, comprobanteKey?, verificadoBanco?).

4. **Rutas API:**
   - `GET/POST /api/facturas/[id]/pagos` (POST = registrar abono/devolución; rol ADMIN).
   - `DELETE /api/facturas/[id]/pagos/[pagoId]` (rol ADMIN).
   - Reemplazar el viejo `POST /api/facturas/[id]/pago` (fecha) → o dejarlo como deprecado que delega.
     Preferible: migrar la UI al nuevo; marca el viejo como deprecado pero no lo borres aún (lo hace WS-E).

5. **Ingresos / Libro de bancos** `src/lib/ingresos/service.ts` + `GET /api/ingresos?clienteId=&desde=&hasta=`:
   union de `Anticipo` (entrada) + `PagoFactura` tipo ABONO (entrada) + tipo DEVOLUCION (salida),
   ordenado por fecha, con saldo de caja corrido por cliente. Cada fila: tipo, origen (ANTICIPO/ABONO/DEVOLUCION),
   referencia (DO o factura), monto con signo, canal, verificadoBanco. Rol ADMIN/REVISOR.

6. **Tests:** abono parcial reduce pendiente; varios abonos hasta saldar setea fechaPago; sobrepago marca
   pendiente de devolución; devolución del saldo a favor (golden case) salda; devolución que excede → 422;
   eliminar pago revierte; getCarteraCliente con abonos calcula cruce correcto; ingresos union ordenada.
   Actualizar el test de cartera existente si cambia la firma (mantener su intención).

**Gates WS-D:** migración aplicada (`prisma migrate dev`), `npm run test` todos verdes (194 previos + nuevos),
`tsc --noEmit` limpio, `replicar-grupo-e-papis.ts` 9/9 al peso.

## 4. WS-E — Frontend (tras WS-D)

**Scope:** `src/components/cartera/**`, nueva página/sección `Ingresos`, `src/components/layout/sidebar.tsx`.
1. En cada fila de factura: mostrar saldoNeto (cobrar/devolver/saldada), barra/lista de abonos con su comprobante,
   botón **"Registrar abono"** (monto, fecha, canal, adjuntar comprobante por URL prefirmada como anticipos,
   check verificado) y botón **"Registrar devolución"** (cuando saldoNeto>0). Validación en vivo del pendiente.
2. Sustituir el modal de "fecha de pago" por el de abonos. Mantener cruce cliente/LM arriba.
3. Nueva vista **"Ingresos"** (sidebar): tabla unificada anticipos + abonos (entradas) + devoluciones (salidas)
   con saldo de caja corrido y filtro por cliente/fechas — el "todo es plata que entra/sale" que pidió el usuario.
4. Terminología: "Abonos", "Devoluciones", "Pendiente de cobro/devolución".

**Gates WS-E:** `tsc` limpio, `lint` sin errores nuevos, `test` 194+ verdes, `build` exit 0.

## 5. Criterio de aceptación global
- E2E manual: facturar un DO con saldo a cargo → registrar 2 abonos parciales → pendiente baja → 3er abono salda
  → fechaPago se setea. Factura con saldo a favor → registrar devolución → saldada. Sobrepago → genera pendiente de devolución.
- Vista Ingresos concilia anticipos + abonos − devoluciones por cliente.
- Golden case BUN26-0026 y los imports de Lucho siguen al peso.
