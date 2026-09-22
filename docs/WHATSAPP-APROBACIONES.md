# WhatsApp de aprobaciones (Kapso) — código del token PSE

## En simple

Cuando Karina (u otro operario) va a hacer un pago por PSE, el banco pide el
código del token, y ese token lo tiene María Camila. Antes había que escribirle
por fuera. Ahora:

1. Karina elige canal **PSE** en "Agregar pago" y pulsa continuar.
2. La plataforma le manda a los aprobadores un WhatsApp **desde la línea
   Sixteam.pro**: "Karina necesita el código del token para un pago PSE — DO,
   beneficiario, valor".
3. El aprobador contesta **en el mismo chat solo con el código** (o toca "Abrir
   enlace", o "No puedo ahora").
4. El código aparece en la pantalla de Karina en segundos. El aprobador recibe
   "Listo, Karina ya lo tiene en pantalla".

Es como un timbre con intercomunicador: la plataforma toca, la persona contesta
por el mismo aparato, y nadie más escucha la conversación.

## Por dónde sale: la pasarela de Sixteam

La línea es **Sixteam.pro · +1 555-333-6233** (`phone_number_id` 1441307479057660),
compartida por varias plataformas de Sixteam (Galcomex, alertas de otros clientes y
número de contacto). Galcomex **no** habla con Kapso directo: habla con la pasarela
`sixteam-whatsapp-gateway` (`wa.sixteam.pro`), que es la única registrada en Kapso.

- **Salida:** Galcomex envía a `https://wa.sixteam.pro/v1/1441307479057660/messages`
  con su llave de inquilino. La pasarela solo le deja usar plantillas `galcomex_…`.
- **Entrada:** la pasarela decide de quién es cada mensaje y a Galcomex solo le reenvía
  lo suyo (firmado con su secreto, mismo formato que Kapso):
  - la respuesta que cita o toca un botón de un mensaje de Galcomex,
  - los botones `gx_…`,
  - lo que escriba un aprobador SIN citar mientras la solicitud está viva: al pedir el
    código, Galcomex envía `X-Gateway-Espera-Respuesta: 1800` (afinidad 30 min).
    Las confirmaciones no lo llevan, así no le "roban" respuestas a otra plataforma.

**Por qué no el número de 2brain:** Kapso entrega cada mensaje a TODOS los webhooks
de un número, y 2brain guarda en su base todo texto entrante antes de filtrar: el
código del token quedaría en claro allá. La línea Sixteam.pro es otra y su único
webhook es la pasarela.

**⚠ +1 555:** esos números suelen ser de prueba de Meta (solo ~5 destinatarios
verificados). Antes de salir en vivo confirmar `account_mode = LIVE` con
`node dist/cli/kapso.js linea` en la pasarela.

## Catálogo de mensajes (la lista cerrada)

Fuente de verdad: `src/lib/whatsapp/catalogo.ts`. Nada sale por WhatsApp si no está ahí.

### Lo que manda la plataforma

| # | Clave | Tipo | Cuándo | Texto |
|---|---|---|---|---|
| 1 | `PSE_CODIGO` | **Plantilla** `galcomex_codigo_pse` (Utility) | El operario pide el código | "Hola {aprobador}. {operario} necesita el codigo del token para un pago PSE. DO / Beneficiario / Valor. Responde a este mensaje solo con el codigo, o usa el boton Abrir enlace." + botones **No puedo ahora** y **Abrir enlace** |
| 2 | `PSE_RECIBIDO` | Texto libre | Llegó un código válido | "Listo, {nombre}. Recibimos el código del DO {do} y {operario} ya lo tiene en pantalla." |
| 3 | `PSE_NO_PUEDO_OK` | Texto libre | Tocó "No puedo ahora" | "Entendido. Le avisamos a {operario} que no puedes en este momento." |
| 4 | `PSE_YA_ATENDIDA` | Texto libre | Otro aprobador respondió primero | "Ese código ya lo envió {quien}. No hace falta nada más." |
| 5 | `PSE_CERRADA` | Texto libre | La solicitud venció o fue reemplazada | "Esa solicitud ya venció o fue reemplazada por una más nueva…" |
| 6 | `PSE_FORMATO` | Texto libre | Escribió algo que no es un código | "No reconocí el código. Responde solo con los números del token, por ejemplo 482913." |
| 7 | `PSE_AMBIGUA` | Texto libre | Tiene 2+ solicitudes abiertas y no citó | "Tienes N solicitudes abiertas (DO…, DO…). Responde citando el mensaje del DO…" |
| 8 | `PSE_SIN_SOLICITUD` | Texto libre | Mandó un código sin nada pendiente | "No tienes solicitudes de código abiertas en este momento." |

El #1 es plantilla porque llega "en frío": fuera de la ventana de 24 h Meta solo
acepta plantillas aprobadas. Los #2–#8 siempre contestan algo que la persona
acaba de escribir, así que la ventana está abierta y va texto libre.

### Lo que entiende de vuelta

| Respuesta del aprobador | Qué hace la plataforma |
|---|---|
| El código (`482913`, `482 913`, `E11027`) | Lo guarda **cifrado** en la solicitud, lo muestra al operario, responde #2 |
| Botón **No puedo ahora** | Marca la solicitud; el operario ve "{nombre} no puede en este momento"; responde #3 |
| Botón **Abrir enlace** | Abre `/pse/{token}` (la página de siempre) |
| Texto que no es código ("ya voy") con algo abierto | Responde #6 |
| Cualquier cosa sin nada abierto ("gracias") | Silencio |
| Cualquier mensaje de un número que **no** es aprobador | Silencio total, siempre |

## Aislamiento (reglas que el código garantiza)

En `src/lib/whatsapp/decidir.ts` (función pura, con pruebas):

1. **Solo aprobadores.** Un número que no está en `WHATSAPP_APROBADORES_PSE`
   jamás recibe respuesta, ni un "no entiendo".
2. **Solo nuestra línea.** Lo que llegue marcado con otro `phone_number_id` se descarta.
3. **Solo nuestros botones.** Todo botón empieza por `gx_` y lleva el id de la solicitud.
4. **Nunca se adivina.** Un código va a la solicitud citada o a la única abierta;
   con varias abiertas se pide citar.
5. **Una solicitud viva por DO.** Pedir otro código anula la anterior: un código
   tardío no se pega al pago equivocado.
6. **El primero gana.** Si Camila y Guillermo responden a la vez, vale el primero
   (actualización condicionada en BD); al otro se le avisa.
7. **El cuerpo no se guarda.** `whatsapp_entrante` solo tiene wamid, remitente,
   tipo y resultado. El código va cifrado (AES-256-GCM) en `pse_solicitud`.
8. **Firma obligatoria.** El webhook exige `X-Webhook-Signature` (HMAC-SHA256
   del cuerpo crudo). Con la pasarela, dejar `KAPSO_WEBHOOK_TOKEN` vacío: ese
   segundo cerrojo lo pone la pasarela frente a Kapso, no frente a Galcomex.
9. **Sin reintentos a ciegas.** Un envío fallido se registra y el operario ve
   "Copiar enlace"; no se reenvía solo (Kapso no es idempotente: duplicaría).

## Variables de entorno (EasyPanel → galcomex-app)

Los nombres son KAPSO_* porque la pasarela imita a Kapso; los valores son de la pasarela.

| Variable | Valor |
|---|---|
| `KAPSO_META_PROXY_URL` | `https://wa.sixteam.pro/v1` |
| `KAPSO_API_KEY` | `GATEWAY_API_KEY` del alta del inquilino `galcomex` |
| `KAPSO_PHONE_NUMBER_ID` | `1441307479057660` |
| `KAPSO_WEBHOOK_SECRET` | `GATEWAY_WEBHOOK_SECRET` del alta del inquilino `galcomex` |
| `KAPSO_PLANTILLA_IDIOMA` | Idioma **real** con que Meta aprobó `galcomex_codigo_pse` (si no es `es`) |
| `KAPSO_PLANTILLA_PSE` | Opcional (por defecto `galcomex_codigo_pse`) |

Sin las obligatorias el canal queda apagado: la solicitud se crea igual y el operario
ve **Copiar enlace**. `WEBHOOK_PSE_URL` (n8n) ya no se usa.

**Secretos:** EasyPanel pasa las variables como `--build-arg` en cada build (se ven
en `ps` del VPS). Es la misma exposición que ya tienen Siigo y R2 en esta app. La
llave de Kapso de verdad vive solo en la pasarela; Galcomex solo tiene la suya de
inquilino, revocable con `tenant.js rotar-llave`.

## Puesta en marcha (en orden)

| # | Quién | Paso |
|---|---|---|
| 1 | Desarrollo | En la pasarela: `kapso.js linea` → confirmar `account_mode=LIVE` de Sixteam.pro. Si es SANDBOX, la línea no sirve para producción. |
| 2 | Desarrollo | Desplegar la pasarela (`wa.sixteam.pro`) y `kapso.js webhook-crear --si`; `kapso.js webhooks` debe mostrar solo el suyo. |
| 3 | Desarrollo | Alta del inquilino: `tenant.js alta --id galcomex --nombre Galcomex --webhook https://galcomex.sixteam.pro/api/whatsapp/kapso --plantillas galcomex_ --botones gx_ --palabras galcomex --guardar-en /tmp/galcomex.cred`. |
| 4 | Desarrollo | Plantilla `galcomex_codigo_pse` en la WABA de Sixteam.pro: `scripts/whatsapp-kapso.ts plantilla --crear` (con la llave de Kapso, no la de inquilino) o en app.kapso.ai → Templates. Esperar APPROVED y anotar el idioma real. |
| 5 | Desarrollo | Variables de la tabla de arriba en EasyPanel. Deploy **fuera de horario laboral**, una sola build. La migración `20260921120000_whatsapp_kapso_pse` es aditiva. |
| 6 | Camila (ADMIN) | Configuración → Parámetros → `WHATSAPP_APROBADORES_PSE` = `María Camila:3001234567; Guillermo:3009876543`. |
| 7 | Desarrollo | `scripts/whatsapp-kapso.ts probar <celular de Camila> --si-enviar` (sale por la pasarela). |
| 8 | Karina + Camila | Piloto con un pago pequeño: pedir código, contestar por WhatsApp, ver que aparece, adjuntar soporte. |

## Qué ve el operario

En el paso 2 del pago PSE:

- Por aprobador: **Enviado → Entregado → Leído**, o **No llegó** (con el código
  del fallo al pasar el mouse), o **No puede ahora**.
- **Copiar enlace**: siempre disponible, por si el WhatsApp no sale.
- **Reenviar solicitud** tras 30 s: crea una nueva y anula la anterior.
- Al llegar el código: "Código PSE recibido de María Camila por WhatsApp".

## Diagnóstico

- ¿Llegó el webhook? `select resultado, count(*) from whatsapp_entrante group by 1;`
- ¿Salieron los avisos? `select tipo, estado, error, count(*) from whatsapp_mensaje group by 1,2,3;`
- `error = KAPSO_HTTP_400_131047`: fuera de ventana de 24 h (se mandó texto libre
  a quien no ha escrito). `132001`: plantilla inexistente o idioma equivocado → revisar
  `KAPSO_PLANTILLA_IDIOMA`.
- Kapso **pausa** el webhook si acumula entregas fallidas (≥10 y ≥85 % en 15 min).
  Revisar en app.kapso.ai → Webhooks → deliveries y reactivar (`active: true`).
- Un acuse `sent` puede llegar antes de que se guarde el wamid del envío: se
  ignora como "acuse_ajeno" y los siguientes (delivered/read) lo corrigen.

## Archivos

- `src/lib/whatsapp/catalogo.ts` — mensajes y respuestas (la lista cerrada)
- `src/lib/whatsapp/decidir.ts` — reglas de enrutamiento y aislamiento (puro)
- `src/lib/whatsapp/entrante.ts` — lectura del payload de Kapso (v2, lotes, Meta cruda)
- `src/lib/whatsapp/pse-service.ts` — orquestación con BD
- `src/app/api/whatsapp/kapso/route.ts` — webhook
- `src/app/api/tramites/[id]/pse-token/route.ts` / `pse-codigo/route.ts` — pedir / consultar
- `scripts/whatsapp-kapso.ts` — plantilla y envío de prueba
- Pasarela: `C:Userssamuesixteam-whatsapp-gateway` (README con reglas de ruteo y operación)
