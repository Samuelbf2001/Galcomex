---
name: sprint-state
description: Estado actual del sprint — tareas completadas, en curso y pendientes por agente IA
metadata:
  type: project
---

# Estado del Sprint — Galcomex (actualizado 2026-06-11, tras validación + Sprint 3 backend)

## Completado y verificado ✅
Gates al cierre: `tsc` limpio, `lint` limpio, **25/25 tests** (incl. concurrencia 20 simultáneas + test dorado de saldo contra Postgres real), `build` exit 0, migración aplicada.

- **Sprint 1:** A1-T1 (migración+seed), A1-T2 (API clientes), A1-T9 (auth+roles+middleware), A2-T1 (layout+login), A3-T1 (MinIO). Esquema Prisma completo (20 modelos). Motor de cálculo base.
- **Sprint 2 (backend):** A1-T3 (trámites, consecutivo atómico con `pg_advisory_xact_lock`, pipeline, regla Litoplas), A1-T4 (checklist).
- **Sprint 3 (backend):** A1-T5 (anticipos + aplicación multi-DO), A1-T6 (libro de pagos + saldo en vivo, test dorado saldoFinal=4.708.356).
- **Sprint 4 (motor+BD):** A1-T7 motor de factura — **test dorado REAL DO.BUN26-0026 al peso** (decodificado del Excel: total 41.868.042, saldo cliente 3.357.958, saldo LM 875.944, IVA 76.000 manual, 4x1000 180.904, costos 17.550 = 1.950 recaudo + 4×3.900). Cobertura 100% ramas. A1-T8 motor integrado con BD (`generarBorrador`) + ciclo de vida borrador + cartera + `parametros/service.ts` (convierte decimales seed→enteros escalados).
- **UI Sprint 3:** A2-T5 (libro de pagos editable, saldo en vivo BigInt), A2-T4 (anticipos multi-DO).
- **A2-T6 Facturación UI:** generador + revisor split-screen del borrador (CRÍTICO papá) en `src/components/facturacion/`, flujo BORRADOR→EN_REVISION→APROBADO→FACTURADO.
- **Clientes:** formulario de alta + **ficha de detalle** `clientes/[id]` (relacionados, editar, tarifas). Endpoint `/api/clientes/[id]` ampliado (GET con relacionados + PATCH).
- **A2-T7 Cartera UI:** `src/components/cartera/` (cruce cliente/LM, filtro pendientes en URL, registrar pago desde fila).
- **A2-T3 Documentos (full-stack):** `Documento` + API `/api/tramites/[id]/documentos` sobre MinIO (URL prefirmada, subida directa, visor, galería) + 3 tests → 59 total.
- **A3-T3 Export XLSX SIIGO** (`src/lib/export/`, valores como número) + **A3-T2 PDFs** (`src/lib/pdf/`, borrador + estado de cuenta). Rutas `/api/borradores/[id]/{export,pdf}`, `/api/cartera/{export,pdf}`.
- Gate al cierre del ciclo cron (22:55): tsc/lint limpios, **86/86 tests**, build exit 0, replicación cuadra al peso.
- **Tests A1-T9 (permisos) + A1-T2 (clientes)** → 104 tests. A2-T2 detalle con pestañas+kanban+edición inline.
- **Fixes de producción (verificados en contenedor en vivo):** (1) 500 en Facturación = `take=200` > máx 100 sin try/catch en GET trámites → ahora GET captura ZodError→400 y Facturación usa take=100; (2) botones aprobar/facturar ocultos porque leía `/api/auth/session` (404) en vez de `/api/auth/get-session`. Contenedor reconstruido (`docker compose up -d --build app`).
- **Replicación a FACTURADO:** `scripts/replicar-grupo-e-papis.ts` avanza el borrador a FACTURADO (BAQ-18288); DO.BUN26-0026 visible en Trámites/Facturación/Cartera al peso. Login: camila@galcomex.com / Galcomex2026!.
- **Historial + relaciones del trámite:** GET `/api/tramites/[id]` usa `tramiteDetalleInclude` (estadoLogs, auditLogs con usuario, aplicacionesAnticipo→anticipo, borradores→factura). El detalle muestra Historial real (quién/cuándo), cliente enlazado a su ficha, anticipos que financian el DO, y facturas con nº SIIGO enlazando a cartera.
- **Doc explicativo:** `docs/excel-vs-sistema.md` mapea cada función del Excel (hojas de DO, ANTICIPOS, RELACION FACT, matriz, libro de pagos, cálculo) al módulo del sistema.
- ⚠️ Contenedor corre `npm start` (build): tras cambios de código hay que reconstruir con `docker compose up -d --build app` para verlos en :3003. Cron de auto-continuación detenido a petición del usuario.
- **✅ Prueba MVP (1/3):** `scripts/replicar-grupo-e-papis.ts` carga el DO real desde el Excel en la BD viva vía servicios y reconcilia los 9 valores al peso. 56/56 tests, build verde, stack Docker arriba (app:3003).

## Parcial 🟡
- A2-T2 UI trámites (existe `tramites-workspace.tsx`; falta detalle/kanban/edición inline)
- A3-T4 importador Excel (parser `galcomex-workbook.ts` listo; falta import idempotente + reporte)

## Próximo
1. **A1-T8** motor integrado con BD (`calcularBorrador` desde DTO del DO) + ciclo de vida del borrador + cartera. ⚠️ Al leer `Parametro` convertir decimales del seed (0.19, 0.004) a enteros escalados del motor (19n, 400n).
2. UI Sprint 3: A2-T5 (libro de pagos editable, la pantalla más usada), A2-T4 (anticipos), A2-T3 (documentos).
3. A2-T6 (revisor split-screen, crítico para el papá), A3-T3 (export SIIGO).

## Deuda restante (no bloqueante)
- `montoLM` del motor es input, no derivable de los pagos (en el Excel sale de la celda TOTAL FACTURA que Camila ajusta). Derivación automática = Fase 2.

## Riesgos activos
1. Resistencia del papá al cambio → la vista de revisión debe ser split-screen documento/valor.
2. Los casos dorados del Excel son bloqueantes de CI — cualquier discrepancia > 0 pesos es un bug.

**Why:** El criterio de salida del MVP es que Camila procese 3 trámites reales de punta a punta sin discrepancias vs. Excel.

**How to apply:** Antes de cerrar cualquier sprint, verificar `tsc`/`lint`/`test`/`build` en verde. Antes de A1-T7, extraer ground-truth de la hoja BUN26-0026 del Excel. Actualizar este archivo al inicio de cada conversación de desarrollo.
