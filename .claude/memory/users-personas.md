---
name: users-personas
description: Los 5 usuarios del sistema, sus roles, flujos diarios y frustraciones
metadata:
  type: project
---

# Usuarios y Personas — Galcomex

## 1. Camila — ADMIN
**Rol en el sistema:** admin (acceso total)
**Trabajo diario:** facturación, anticipo, revisión de DOs, envío de facturas al cliente
**Dolor principal:** pasa todos los días copiando de Excel a SIIGO, concepto por concepto
**Expectativa del sistema:** generar el borrador automáticamente con los pagos ya registrados; el export XLSX debe ser 1:1 con lo que hoy copia a SIIGO
**Patrón de uso:** desktop, opera datos densos, flujo lineal, similar a hoja de cálculo

## 2. Papá de Camila — REVISOR
**Rol en el sistema:** revisor
**Trabajo diario:** revisa cada factura contra los soportes físicos antes de que Camila la transcriba
**Dolor principal:** revisa todo uno por uno; resistente al cambio de plataforma
**Expectativa del sistema:** vista split-screen (soporte PDF al lado del valor de la línea); mínimo fricción; solo aprobar o poner observación
**RESTRICCIÓN CULTURAL:** "si complicamos algo en una plataforma, no va a entrar" — confirmado en reunión
**How to apply:** La vista de revisión es el módulo más crítico de UX. Nunca añadir pasos extra al flujo del papá.

## 3. Karina — OPERATIVO
**Rol en el sistema:** operativo
**Trabajo diario:** apertura de DOs, checklist documental, contacto con agencias de aduanas
**Dolor principal:** checklist manual impreso, documentos dispersos en servidor local
**Expectativa del sistema:** formulario de apertura de DO, checklist digital, subida de documentos por categoría, notificación cuando el DO avanza de estado
**Patrón de uso:** desktop principalmente, eventualmente tablet

## 4. Sr. Lucho (operario de puerto) — OPERATIVO
**Rol en el sistema:** operativo
**Trabajo diario:** subida de fotos de reconocimiento de carga en el puerto
**Dolor principal:** hoy manda fotos por WhatsApp a Karina
**Expectativa del sistema:** interfaz simple para subir fotos desde celular (viewport 375px, sin login complicado)
**How to apply:** La subida de fotos debe funcionar en móvil — probar en Playwright con emulación de 375px

## 5. Socio Luis Martínez / "Lucho" — SOCIO
**Rol en el sistema:** socio (acceso limitado)
**Trabajo diario:** genera solicitudes de facturación; es "cliente" de Galcomex para la facturación por terceros
**Dolor principal:** facturas pendientes desde el año anterior por el cuello de botella manual
**Expectativa del sistema:** ver solo sus trámites y solicitar facturación; NO puede ver clientes propios de Galcomex (403 si lo intenta)
**Comisión:** Galcomex le cobra $150.000 COP por cada factura emitida en su nombre

## Secuencia de operación (AS-IS → TO-BE)
1. Karina abre el DO (checklist documental)
2. Sr. Lucho sube fotos y soportes desde el puerto
3. Karina registra pagos de proveedor (puerto, naviera, DIAN) y solicita fondos (anticipo)
4. Camila registra el anticipo y lo aplica al DO
5. Camila genera el borrador de factura
6. Papá revisa en split-screen y aprueba
7. Camila transcribe a SIIGO (con export XLSX como puente; API en Fase 2)
8. Camila envía la factura al cliente
