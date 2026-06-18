---
name: financial-rules
description: Las 8 reglas del motor de cálculo de factura — fuente de verdad para el código y los tests
metadata:
  type: project
---

# Reglas de Cálculo Financiero — Galcomex

**Fuente de verdad:** Excel `GRUPO_E_PAPIS_2026.xlsm` (validado en reunión con Camila).
**Implementación:** `src/lib/calculations/motor-factura.ts` (función pura, sin BD).

## INVARIANTE CRÍTICA
**Todo valor monetario es `BigInt` (COP enteros). Cero flotantes. Tolerancia en tests = 0 pesos.**

## Las 8 reglas

### Regla 1 — Saldo corriente del DO
```
saldo = Σ(anticipos_aplicados) − Σ(pagos_del_trámite_en_orden)
```
Cada pago registrado descuenta del saldo. La columna SALDO del Excel es la referencia.

### Regla 2 — Comisión Galcomex/LM
- Valor fijo, parametrizable desde tabla `Parametro` (`COMISION_LM`)
- **Default: COP $150.000** — pero puede editarse por factura (el Excel muestra casos de $200.000)
- Se descuenta del saldo

### Regla 3 — IVA de la comisión
- `ivaComision = comision × IVA_COMISION` (parámetro, default 19%)
- `ivaComision = (comision × 19n) / 100n` — BigInt, truncado
- Se descuenta del saldo

### Regla 4 — Impuesto 4x1000 (CONDICIONAL — la más importante)
- **Base:** `totalAnticipoAplicado` (no el saldo final)
- **Tarifa:** `TASA_4X1000` = 0.004 (4/1000)
- **SE APLICA:** solo si el resultado después de comisión + IVA + costos bancarios queda con **saldo a FAVOR del cliente** (plata que Galcomex devuelve → banco cobra a Galcomex)
- **NO se aplica:** si queda saldo a CARGO del cliente (cliente paga a Galcomex, banco no cobra)

```typescript
const aplica4x1000 = (saldoPrevio - comision - ivaComision - costosBancarios) > 0n
const impuesto4x1000 = aplica4x1000
  ? (totalAnticipoAplicado * 400n) / 100_000n
  : 0n
```

### Regla 5 — Costos bancarios
- `costosBancarios = Σ(pago.costoBancario)` para todos los pagos del trámite
- Cada canal tiene su costo fijo en tabla `MatrizRecaudoPago`
- Se descuentan del saldo

### Regla 6 — Resultado de la factura
```
totalFactura = saldoPrevio − comision − ivaComision − costosBancarios − impuesto4x1000
saldoAFavorCliente = max(totalFactura, 0)
saldoACargoCliente = max(-totalFactura, 0)
```
Saldo cliente y saldo LM son **independientes** (LM aplica en facturación por terceros).

### Regla 7 — Cartera / cruce de cuentas
```
cruce = Σ(saldos_a_cargo) − Σ(saldos_a_favor)
```
Una factura **sale del cálculo de pendientes** cuando se registra su `fechaPagoCliente` o `fechaPagoLM` (independientes).

### Regla 8 — Recibo de caja previo
Debe existir anticipo registrado y verificado antes de generar el borrador de factura.

## Matriz de costos bancarios
| Canal (enum `CanalPago`) | Costo COP |
|---|---|
| BANCOLOMBIA_SUCURSAL | 11.290 |
| BANCOLOMBIA_CAJERO | 5.200 |
| BANCOLOMBIA_CORRESPONSAL | 6.190 |
| BANCOLOMBIA_TRANSFERENCIA | 3.900 |
| OTROS_BANCOS_SUCURSAL | 2.200 |
| OTROS_BANCOS_TRANSFERENCIA | 7.300 |
| PSE | 0 |
| OTRO | 1.950 |

## Caso dorado DO.BUN26-0026 (bloqueante de CI)
- Anticipo: 45.226.000
- Pagos: 1.000.000 + 2.011.341 + 30.854.000 + 2.216.233 + 760.283 + 175.787 + 3.500.000
- Comisión editada: 200.000
- 4x1000 = 180.904 (aplica, resultado a favor)
- Saldo a favor cliente: 3.357.958
- Saldo a favor LM: 875.944

**How to apply:** Antes de cualquier cambio al motor de cálculo, verificar que el caso dorado siga pasando. Si hay discrepancia, investigar contra el Excel original, no ajustar el test.
