# HANDOFF — Galcomex Sistema de Gestión Operativa
**Fecha:** 2026-06-11 (actualizado tras validación + Sprint 3 backend)
**Sprint:** 1 y 2 completados; Sprint 3 con backend completo, UI pendiente
**Para:** Próximo agente IA que retome este proyecto

> **Gates de calidad verificados al cierre de esta sesión:** `npx tsc --noEmit` limpio · `npm run lint` limpio · **25/25 tests** verdes (incluyen concurrencia de 20 trámites y test dorado de saldo, ambos contra Postgres real en :5433) · `npm run build` exit 0 · migración aplicada y al día.

---

## Lo que tienes delante

Sistema de gestión interna para **Galcomex**, agencia logística en Barranquilla. Reemplaza un flujo manual de Excel → SIIGO. Single-tenant, 5 usuarios, no multiempresa.

El proyecto está en `C:\Users\samue\Galcomex\galcomex-app\`. El documento de requerimientos completo (con criterios de aceptación detallados por tarea) está en `C:\Users\samue\Galcomex\galcomex-sistema-requerimientos.md` — **léelo antes de implementar cualquier módulo**.

---

## Estado actual — qué está hecho (resumen ejecutivo)

| Tarea | Estado |
|---|---|
| A1-T1 migración + seed | ✅ aplicada y reproducible |
| A1-T2 API clientes | ✅ |
| A1-T3 trámites (consecutivo atómico, pipeline) | ✅ test concurrencia 20 simultáneas verde |
| A1-T4 checklist apertura | ✅ |
| A1-T5 anticipos + aplicación multi-DO | ✅ |
| A1-T6 libro de pagos + saldo en vivo | ✅ test dorado saldo=4.708.356 |
| A1-T7 motor de factura | ✅ **test dorado REAL al peso** (total 41.868.042, cliente 3.357.958, LM 875.944), 100% ramas |
| A1-T8 motor+BD (borrador) + ciclo de vida + cartera | ✅ + `parametros/service.ts` (convierte decimales seed→enteros) |
| A1-T9 auth + roles + middleware | ✅ |
| A2-T1 layout + login | ✅ |
| A2-T2 UI trámites | 🟡 parcial (crear+tabla+enlace a detalle; falta kanban/edición inline) |
| A2-T4 UI anticipos | ✅ (multi-DO, filtro con saldo) |
| A2-T5 UI libro de pagos editable | ✅ (saldo en vivo BigInt, página `tramites/[id]`) |
| Clientes (alta) | ✅ fix: formulario "Nuevo cliente" añadido (era solo lectura) |
| A3-T1 MinIO storage | ✅ |
| A3-T4 importador Excel | 🟡 parser listo + `scripts/replicar-grupo-e-papis.ts` (1 DO end-to-end); falta import masivo idempotente |
| Resto (A2-T3, A2-T6/T7/T8, A3-T2/T3/T5/T6/T7) | ⬜ pendiente |

**✅ Prueba MVP (1/3):** `npx tsx scripts/replicar-grupo-e-papis.ts` carga el DO real DO.BUN26-0026 desde el Excel en la BD viva y reconcilia los 9 valores **al peso**.
**Gate al cierre:** tsc/lint limpios · 56/56 tests · build exit 0 · Docker arriba (app:3003, postgres:5433, minio:9000).

### Infraestructura y base
- **Proyecto Next.js 15** inicializado con TypeScript estricto
- **Todas las dependencias instaladas:** Prisma, Better Auth, TanStack Table/Query, MinIO, Vitest, SheetJS, react-pdf, Radix UI, Zod, Tailwind, shadcn/ui
- **`docker-compose.yml`** listo: PostgreSQL 16 + MinIO + App + init automático del bucket
- **`.env.example`** con todas las variables documentadas

### Modelo de datos
- **`prisma/schema.prisma` COMPLETO** — 20 modelos, todos los enums, constraints únicos
  - `TramiteDO` con consecutivo único por ciudad+año (`@@unique([ciudad, anio, numero])`)
  - `BorradorFactura` con snapshot JSON inmutable para auditoría
  - `AuditLog` con antes/después en toda mutación crítica
  - `MatrizRecaudoPago` con los 8 canales de pago
  - `Parametro` para valores editables (comisión, IVA, 4x1000)
- **`prisma/seed.ts`** listo: matriz de 8 canales, parámetros del sistema, usuario admin inicial (camila@galcomex.com / `Galcomex2026!`)
- **✅ Migración aplicada y al día** (`prisma migrate status` → up to date). Seed cargado (8 canales, 4 params, admin).

### Motor de cálculo (NÚCLEO CRÍTICO)
- **`src/lib/calculations/motor-factura.ts`** — función pura, sin BD, replica el Excel al peso (ver A1-T7). Acepta `ivaComision`, `montoLM`, `costoRecaudoAnticipo`.
- **`src/lib/calculations/__tests__/motor-factura.test.ts`** — test dorado REAL DO.BUN26-0026, cobertura 100% ramas.
- `npm run test` → **56/56 verde** (incl. integración contra Postgres).

### Documentación del agente
- **`CLAUDE.md`** — toda la arquitectura, reglas, invariantes y comandos para este proyecto
- **`.claude/SPRINT.md`** — estado completo de los 5 sprints con tareas por agente
- **`.claude/memory/`** — 6 archivos de memoria: negocio, reglas, usuarios, decisiones de arquitectura, estado del sprint

---

## Lo que hay que hacer AHORA

Backend completo hasta A1-T8 + motor validado al peso + UI Sprint 3 (pagos/anticipos) + alta de clientes. Lo siguiente, en orden de valor:

### 🔴 Prioridad 1 — A2-T6: Generador y revisor de borrador (CRÍTICO para el papá)
Botón "Generar borrador" en el detalle del DO → vista previa con líneas, comisión editable, desglose (4x1000, IVA, costos) y saldos cliente/LM. **Vista de revisión split-screen** (soporte PDF a la izquierda, valores a la derecha) con aprobar/observar por línea. API ya lista: `POST /api/tramites/[id]/borrador`, `PATCH /api/borradores/[id]` (transición/aprobar/facturar). El revisor (rol REVISOR) no debe ver botones de edición de operativo.

### 🟡 Prioridad 2 — A2-T7 (cartera UI) y A2-T3 (documentos)
- **A2-T7** Vista de cartera por cliente con cruce cliente/LM y registro de pago. API: `GET /api/cartera?clienteId=&pendientes=true`, `POST /api/facturas/[id]/pago`.
- **A2-T3** UI de documentos (drag & drop, visor) — storage MinIO en `src/lib/storage/`.

### 🟡 Prioridad 3 — A3-T2 (PDFs), A3-T3 (export SIIGO), cerrar A2-T2/A3-T4
- **A3-T2** PDF de borrador + estado de cuenta. **A3-T3** export XLSX para SIIGO.
- **A2-T2** detalle del DO con pestañas + kanban + edición inline de fechas.
- **A3-T4** import masivo idempotente de los 26 DOs del Excel (hay base en `scripts/replicar-grupo-e-papis.ts` que ya hace 1 DO end-to-end).

### Validación end-to-end disponible
`npx tsx scripts/replicar-grupo-e-papis.ts` — carga el DO real del Excel en la BD viva y reconcilia al peso. Úsalo para validar regresiones del motor/servicios y para sembrar datos reales en la app.

### Patrones a seguir (NO reinventar)
- Auth: `requireRole([...])` de `src/lib/auth/session.ts` (devuelve `NextResponse` en fallo).
- JSON con BigInt: `jsonResponse(...)` de `src/lib/http/json.ts`.
- Errores Zod: `validationError(...)` de `src/lib/http/errors.ts`.
- Dinero en Zod: `z.coerce.bigint().refine(v => v >= 0n)`.
- Concurrencia: `pg_advisory_xact_lock(hashtext(${lockKey}))` dentro de `prisma.$transaction` (ver `tramites/service.ts`, `anticipos/service.ts`).
- Tests de integración: patrón de `src/lib/tramites/__tests__/service.test.ts` (TEST_PREFIX único, cleanup, `ensureDb` con skip si no hay BD, gated en `DATABASE_URL`).

---

## Contexto que NO puedes olvidar

### 1. Dinero = BigInt siempre
```typescript
// ✅ CORRECTO
const comision = 150_000n;
const iva = (comision * 19n) / 100n; // 28500n

// ❌ NUNCA HACER ESTO
const comision = 150000;
const iva = comision * 0.19; // flotante → bug de redondeo en factura
```

### 2. El 4x1000 es condicional (la regla más difícil)
Solo se aplica si el saldo queda **a favor del cliente** (Galcomex devuelve plata → banco cobra a Galcomex).
Si el cliente le debe a Galcomex → NO se cobra 4x1000.
Ver `motor-factura.ts:40-44` para la implementación exacta.

### 3. Consecutivo de DO es atómico
`DO.CTG26-0124` — generado en transacción DB sin race condition.
El test de concurrencia (20 creaciones simultáneas sin duplicados) está en A1-T3 y es **bloqueante de CI**.

### 4. El papá es el usuario más frágil
El revisor (papá de Camila) es resistente al cambio. La vista de revisión del borrador de factura **debe** ser split-screen: soporte PDF a la izquierda, valores de línea a la derecha. No añadir pasos extra a su flujo.

### 5. Tests dorados = bloqueantes de CI
Los valores del Excel `GRUPO E PAPIS 2026 (1).xlsm` son la fuente de verdad.
Si hay discrepancia entre el código y el Excel, el código está mal (no el test).

---

## Comandos de referencia rápida

```bash
npm run dev          # servidor de desarrollo (puerto 3000)
npm run test         # Vitest unit tests — deben pasar SIEMPRE
npm run test:watch   # watch mode durante desarrollo
npm run db:migrate   # nueva migración (pide nombre)
npm run db:reset     # reset completo de la BD (solo dev)
npm run db:studio    # Prisma Studio (explorador visual)
npm run db:seed      # seed de datos iniciales
docker compose up -d # levantar PostgreSQL + MinIO en background
```

---

## Archivos clave por módulo

| Módulo | Archivo(s) |
|---|---|
| Motor de cálculo (CRÍTICO) | `src/lib/calculations/motor-factura.ts` |
| Tests del motor | `src/lib/calculations/__tests__/motor-factura.test.ts` |
| Esquema de BD | `prisma/schema.prisma` |
| Seed | `prisma/seed.ts` |
| Auth config | `src/lib/auth/` (por crear) |
| Storage MinIO | `src/lib/storage/` (por crear) |
| API routes | `src/app/api/` |
| Componentes UI | `src/components/` |
| Variables de entorno | `.env.example` → copiar a `.env` |
| Docker | `docker-compose.yml` |

---

## Orden de implementación recomendado

```
Sprint 1 (ahora):
  A1-T1 → migración + seed
  A1-T9 → Better Auth + middleware
  A1-T2 → API clientes
  A2-T1 → Layout + login

Sprint 2:
  A1-T3 → API trámites (consecutivo atómico, pipeline de estados)
  A1-T4 → Checklist documental
  A2-T2 → UI tabla de DOs + detalle
  A3-T1 → Servicio MinIO
  A3-T4 → Importador de Excel histórico (con schema estable)

Sprint 3:
  A1-T5 → Anticipos y aplicación multi-DO
  A1-T6 → Libro de pagos + saldo en vivo
  A2-T3 → UI documentos (drag & drop, visor)
  A2-T4 → UI anticipos
  A2-T5 → Tabla editable libro de pagos (pantalla más usada por Camila)
  A3-T2 → PDFs (borrador factura + estado de cuenta)

Sprint 4:
  A1-T7 → Motor integrado con BD (endpoint → calcularBorrador)
  A1-T8 → Ciclo de vida borrador + cartera
  A2-T6 → Generador + revisor split-screen (CRÍTICO para el papá)
  A2-T7 → Módulo de cartera
  A3-T3 → Export XLSX para SIIGO
  A3-T5 → Webhooks n8n

Sprint 5 (hardening):
  E2E Playwright completo
  A2-T8 → Dashboard operativo
  A3-T6 → Deploy producción
  A3-T7 → Auditoría + logs
  Simulacro de restauración
```

---

## Criterio de salida del MVP (go-live)

Camila procesa **3 trámites reales de punta a punta** en el sistema (apertura → anticipo → pagos → borrador → revisión del papá → número SIIGO → cartera) en paralelo con su Excel, y ambos cuadran al peso. Sin discrepancias.

---

*Ver `.claude/SPRINT.md` para el estado actualizado y `CLAUDE.md` para la documentación completa del stack.*
