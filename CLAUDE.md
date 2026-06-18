# CLAUDE.md — Galcomex Sistema de Gestión Operativa

Sistema interno single-tenant para Galcomex, agencia logística de importaciones (Barranquilla).
5 usuarios, un solo cliente/empresa, no multiempresa.
Desarrollado y mantenido por agentes IA (Claude Code) bajo supervisión de SixTeam.

## Stack tecnológico

- **Framework:** Next.js 15 (App Router) + TypeScript estricto (sin `any`)
- **BD:** PostgreSQL 16 + Prisma ORM
- **UI:** Tailwind CSS + shadcn/ui + TanStack Table
- **Auth:** Better Auth (email + password, 4 roles)
- **Storage:** MinIO (S3-compatible, mismo VPS)
- **PDF:** react-pdf / Puppeteer (en endpoints de servidor)
- **Excel export:** SheetJS (xlsx)
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Deploy:** Docker Compose en EasyPanel/Hostinger VPS
- **Automatización:** n8n (ya operado por SixTeam) vía webhooks

## Estructura de carpetas

```
galcomex-app/
├── src/
│   ├── app/
│   │   ├── (dashboard)/        # Rutas protegidas, layout con sidebar
│   │   │   ├── tramites/
│   │   │   ├── facturacion/
│   │   │   ├── cartera/
│   │   │   ├── anticipos/
│   │   │   ├── clientes/
│   │   │   └── configuracion/
│   │   ├── api/                # Route Handlers REST
│   │   │   ├── clientes/
│   │   │   ├── tramites/
│   │   │   ├── anticipos/
│   │   │   ├── pagos/
│   │   │   ├── facturas/
│   │   │   └── cartera/
│   │   └── auth/
│   ├── lib/
│   │   ├── db/                 # Cliente Prisma singleton
│   │   ├── auth/               # Config Better Auth
│   │   ├── storage/            # MinIO, URLs prefirmadas
│   │   ├── calculations/       # Motor de cálculo PURO (sin BD)
│   │   │   └── motor-factura.ts  ← NÚCLEO CRÍTICO
│   │   ├── pdf/                # react-pdf templates
│   │   ├── excel/              # SheetJS exports
│   │   └── validations/        # Esquemas Zod
│   ├── components/
│   │   ├── ui/                 # shadcn/ui primitivos
│   │   ├── layout/             # Shell, Sidebar, Header
│   │   ├── tramites/
│   │   ├── facturacion/
│   │   ├── cartera/
│   │   ├── anticipos/
│   │   └── dashboard/
│   └── types/
├── prisma/
│   ├── schema.prisma           # Fuente de verdad del modelo
│   └── seed.ts                 # Matriz de pagos, parámetros, admin
├── scripts/
│   └── import-excel.ts         # Importador de datos históricos del Excel
├── docker-compose.yml
└── .env.example
```

## Reglas de negocio críticas

### Motor de cálculo de factura
Todo en `src/lib/calculations/motor-factura.ts`. **Función pura, sin BD.**

**Saldo corriente:** `saldo = Σ(anticipos_aplicados) − Σ(pagos)`

**Cálculo del borrador:**
1. `costosBancarios = Σ(pago.costoBancario)` — de tabla `MatrizRecaudoPago`
2. `ivaComision = comision × 19 / 100` (BigInt, truncado)
3. **4x1000 CONDICIONAL:** solo si `saldoPrevio − comision − iva − costos > 0` (saldo a favor)
   - Base = `totalAnticipoAplicado`, tarifa = 0.4%
   - Si queda a cargo del cliente → `impuesto4x1000 = 0`
4. `totalFactura = saldoPrevio − comision − iva − costos − 4x1000`
5. `saldoAFavor = max(totalFactura, 0)`, `saldoACargo = max(-totalFactura, 0)`

### Matriz de costos bancarios
| Canal | Costo COP |
|---|---|
| BANCOLOMBIA_SUCURSAL | 11.290 |
| BANCOLOMBIA_CAJERO | 5.200 |
| BANCOLOMBIA_CORRESPONSAL | 6.190 |
| BANCOLOMBIA_TRANSFERENCIA | 3.900 |
| OTROS_BANCOS_SUCURSAL | 2.200 |
| OTROS_BANCOS_TRANSFERENCIA | 7.300 |
| PSE | 0 |
| OTRO | 1.950 |

### Parámetros del sistema (tabla `Parametro`)
- `COMISION_LM` = 150.000 COP (editable por factura)
- `IVA_COMISION` = 0.19 (19%)
- `TASA_4X1000` = 0.004
- `DIAS_SLA_FACTURA` = 3 días (alerta roja en dashboard)

## Invariantes de código — NUNCA violar

1. **Dinero SIEMPRE como `BigInt` (COP enteros).** Cero flotantes en cálculos financieros.
2. Sin `any` en TypeScript — el build falla si hay `any`.
3. Validación Zod en TODOS los endpoints API (entrada).
4. Autorización en middleware, no en componentes React.
5. Toda mutación crítica (DOs, pagos, borradores, facturas) genera registro en `AuditLog` con snapshot JSON antes/después.
6. Tests de cálculo con tolerancia **0 pesos** (exactos, sin redondeos).

## Roles y permisos

| Acción | ADMIN | REVISOR | OPERATIVO | SOCIO |
|---|---|---|---|---|
| CRUD clientes/tarifas | ✓ | | | |
| Crear/editar DOs | ✓ | ✓ | ✓ | |
| Checklist/documentos | ✓ | ✓ | ✓ | |
| Registrar anticipos/pagos | ✓ | | ✓ | |
| Aprobar borrador factura | ✓ | ✓ | | |
| Marcar facturado (+ num SIIGO) | ✓ | | | |
| Ver cartera | ✓ | ✓ | | |
| Ver solo sus trámites | | | | ✓ |
| Editar parámetros del sistema | ✓ | | | |

## Consecutivo automático de DO

Formato: `DO.{CIUDAD}{AA}-{NNNN}` — ej. `DO.CTG26-0124`
- Generado atómicamente en transacción DB (sin race conditions)
- Único por ciudad + año (constraint `@@unique([ciudad, anio, numero])`)
- Litoplas SIEMPRE requiere `agenciaAduanas = MOVIADUANAS` y `doAgencia` con formato `I########`

## Transiciones de estado del DO

`SOLICITUD → APERTURA → EN_TRAMITE → EN_PUERTO → DESPACHADO → ENVIADO_A_FACTURAR → FACTURADO → PAGADO → CERRADO`

- **APERTURA → EN_TRAMITE:** bloqueado si hay `ChecklistItem` requerido sin marcar
- Toda transición queda en `EstadoLog` con usuario y timestamp

## MinIO — Storage

Ruta: `tramites/{consecutivo}/{categoria}/{uuid}.{ext}`
- URLs prefirmadas con expiración ≤ 15 minutos
- Tipos: PDF, JPG, PNG, XLSX (máx 25 MB)
- Soft-delete (`eliminado = true`), nunca borrado físico

## Tests — Casos dorados (BLOQUEANTES en CI)

Los tests del archivo real están en `src/lib/calculations/__tests__/`.

**DO.BUN26-0026 (datos reales del Excel 2026):**
- Anticipo: 45.226.000
- 7 pagos totales (ver test file)
- Comisión: 200.000
- 4x1000 = 180.904
- Saldo a favor cliente: 3.357.958

CI falla si estos tests no pasan. Tolerancia = 0 pesos.

## Webhooks n8n

Eventos (firmados HMAC-SHA256): `do.creado`, `do.enviado_a_facturar`, `factura.aprobada`, `factura.facturada`, `cartera.vencida`

## Comandos de desarrollo

```bash
npm run dev                              # Servidor dev
npm run test                             # Vitest unit tests
npm run test:e2e                         # Playwright E2E
npx prisma studio                        # Explorador BD
npx prisma migrate dev --name nombre     # Nueva migración
npx prisma migrate reset                 # Reset completo (dev)
docker compose up --build               # Stack completo
```

## Sprint actual y progreso

Ver `.claude/SPRINT.md` para el estado actual de tareas por agente.

**Fuente de verdad del plan:** `../galcomex-sistema-requerimientos.md` (en raíz de `/Galcomex`)
**Excels de referencia:** `../GRUPO E PAPIS 2026 (1).xlsm` y `../MODELO RELACION SIXTEAM (1).xlsm`
