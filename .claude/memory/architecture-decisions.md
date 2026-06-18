---
name: architecture-decisions
description: Decisiones de arquitectura del stack y sus justificaciones
metadata:
  type: project
---

# Decisiones de Arquitectura — Galcomex

## Single-tenant por diseño
El sistema es para un solo cliente (Galcomex, 5 usuarios). No hay multiempresa.
**Why:** simplifica el modelo de datos, los permisos y el deploy. Evitar abstracciones multitenancy prematuras.
**How to apply:** No añadir campos `organizacionId` ni lógica de tenant isolation. Si en el futuro el cliente quiere escalar a múltiples empresas, eso es una reescritura, no un ajuste.

## Next.js 15 App Router (monorepo full-stack)
Un solo repo con SSR + API routes en vez de separar frontend/backend.
**Why:** menor fricción para agentes IA, un solo proceso de deploy, types compartidos automáticamente.
**How to apply:** Usar Route Handlers (`app/api/`) para la API REST. Server Components para páginas con datos iniciales. Client Components solo cuando hay interactividad real.

## BigInt para todo lo monetario
**Why:** COP son enteros, no hay centavos. Los flotantes de JavaScript/IEEE 754 pueden causar errores de redondeo que en una factura son inaceptables. El Excel mismo usa enteros.
**How to apply:** `BigInt` en Prisma schema, `BigInt` en los tipos TypeScript, `BigInt` en los tests. Formatear a string para la UI (`Intl.NumberFormat` o `toLocaleString`). NUNCA pasar por `Number()` para cálculos.

## Motor de cálculo como función pura
`calcularBorrador` en `motor-factura.ts` no toca la BD.
**Why:** testeable de forma aislada, determinista (mismo input → mismo output), sin mocks de BD necesarios, fácil de auditar.
**How to apply:** La BD solo se toca en los API routes. El motor recibe un DTO, devuelve un resultado.

## MinIO para documentos (reemplaza servidor local)
**Why:** El equipo tiene un PC encendido 24h que sirve de servidor de archivos — punto único de falla. MinIO en el mismo VPS da interfaz S3, URLs prefirmadas con expiración, y backup programable.
**How to apply:** Nunca servir archivos directamente desde la app — siempre URLs prefirmadas ≤15 min. Soft-delete (`eliminado = true`), jamás borrado físico desde el código.

## Better Auth (no NextAuth)
**Why:** self-hosted, sin dependencia de JWT externo, soporte de roles nativamente, API más simple para agentes IA.
**How to apply:** Configurar en `src/lib/auth/`. El middleware de Next.js valida la sesión y el rol antes de llegar al Route Handler.

## Vitest + Playwright (no Jest)
**Why:** Vitest es más rápido y tiene soporte nativo de ESM/TypeScript. Playwright para E2E con emulación de móvil (necesaria para flujo del Sr. Lucho).

## n8n para notificaciones (no código custom)
**Why:** SixTeam ya opera n8n en producción. Los webhooks firmados desacoplan la app de los canales de notificación (correo, WhatsApp en Fase 2).
**How to apply:** La app publica eventos; n8n enruta. No hardcodear lógica de correo en la app.

## Fase 2 — Fuera del MVP
- API SIIGO (creación automática de factura y recibo de caja)
- Formulario público para clientes/socio
- Ingestión automática de correos
- OCR de facturas de proveedor
- Notificaciones WhatsApp vía n8n

**How to apply:** No diseñar para Fase 2 en el MVP. Si algo "preparará el terreno", hacerlo solo si no añade complejidad al MVP.
