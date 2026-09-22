/**
 * Puesta en marcha del canal WhatsApp de Galcomex en Kapso. Todo lo que se
 * configuró "por pantalla" queda aquí, reproducible y revisable.
 *
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts numeros
 *       Lista las líneas del proyecto Kapso (id, número, estado). Sirve para
 *       confirmar el KAPSO_PHONE_NUMBER_ID de Galcomex y que NO es un número
 *       de pruebas de Meta (+1 555…, limitado a ~5 destinatarios).
 *
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts plantilla            # imprime la definición
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts plantilla --crear    # la manda a revisión de Meta
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts plantilla --estado   # APPROVED / PENDING / REJECTED + idioma real
 *       Si Meta bloquea la creación por API ("Advanced Access"), crearla a mano en
 *       app.kapso.ai → Templates copiando la definición impresa.
 *
 *   webhook: con la pasarela de Sixteam NO se usa (el webhook de la línea es de la pasarela).
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts webhook --directo [--crear|--listar]
 *       Solo si Galcomex tuviera línea propia en Kapso, sin pasarela.
 *
 *   npx tsx --env-file=.env.kapso scripts/whatsapp-kapso.ts probar 3001234567 --si-enviar
 *       Manda UNA plantilla de prueba (datos ficticios) a ese celular. Es un
 *       WhatsApp real: sin --si-enviar solo imprime lo que mandaría.
 *
 * Variables: KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, KAPSO_WABA_ID (plantilla),
 * KAPSO_WEBHOOK_SECRET y opcional KAPSO_WEBHOOK_TOKEN (webhook), NEXT_PUBLIC_APP_URL.
 * El archivo .env.kapso NO se commitea (está cubierto por .env* en .gitignore).
 */
import { definicionPlantillaPse, mensajePlantillaPse } from "../src/lib/whatsapp/catalogo";
import { HEADER_TOKEN_WEBHOOK, PLANTILLA_PSE_POR_DEFECTO, PROXY_POR_DEFECTO, kapsoConfig, urlPublicaApp } from "../src/lib/whatsapp/config";
import { enviarWhatsapp } from "../src/lib/whatsapp/kapso-cliente";
import { normalizarCelular } from "../src/lib/whatsapp/telefono";

const PLATFORM = "https://api.kapso.ai/platform/v1";

function requerida(nombre: string): string {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`${nombre} no está configurada`);
  return valor;
}

function proxy(): string {
  return (process.env.KAPSO_META_PROXY_URL?.trim() || PROXY_POR_DEFECTO).replace(/\/+$/, "");
}

function imprimir(valor: unknown): void {
  process.stdout.write(`${JSON.stringify(valor, null, 2)}\n`);
}

async function llamar(url: string, init: RequestInit = {}): Promise<unknown> {
  const respuesta = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", "X-API-Key": requerida("KAPSO_API_KEY"), ...(init.headers ?? {}) },
  });
  const cuerpo: unknown = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    process.stderr.write(`HTTP ${respuesta.status}\n`);
    process.exitCode = 1;
  }
  return cuerpo;
}

async function numeros(): Promise<void> {
  const cuerpo = (await llamar(`${PLATFORM}/whatsapp/phone_numbers`)) as { data?: Array<Record<string, unknown>> };
  const filas = (cuerpo.data ?? []).map((n) => ({
    phone_number_id: n.phone_number_id ?? n.id,
    numero: n.display_phone_number ?? n.phone_number,
    nombre: n.verified_name ?? n.name,
    estado: n.status,
    calidad: n.quality_rating,
    waba: n.business_account_id ?? n.waba_id,
  }));
  imprimir(filas.length ? filas : cuerpo);
  process.stdout.write("\nOjo: un número +1 555… es de pruebas de Meta (máx. ~5 destinatarios verificados). Galcomex necesita uno propio.\n");
}

async function plantilla(args: string[]): Promise<void> {
  const nombre = process.env.KAPSO_PLANTILLA_PSE?.trim() || PLANTILLA_PSE_POR_DEFECTO;
  if (args.includes("--estado")) {
    const waba = requerida("KAPSO_WABA_ID");
    imprimir(await llamar(`${proxy()}/${waba}/message_templates?name=${nombre}&fields=name,status,language,category,rejected_reason`));
    process.stdout.write("\nUsa el campo `language` tal cual en KAPSO_PLANTILLA_IDIOMA (en 2brain Meta la registró como \"en\").\n");
    return;
  }
  const definicion = definicionPlantillaPse(nombre, "es", urlPublicaApp());
  if (!args.includes("--crear")) {
    imprimir(definicion);
    return;
  }
  const waba = requerida("KAPSO_WABA_ID");
  imprimir(await llamar(`${proxy()}/${waba}/message_templates`, { method: "POST", body: JSON.stringify(definicion) }));
}

function cuerpoWebhook(ocultarSecreto: boolean) {
  const token = process.env.KAPSO_WEBHOOK_TOKEN?.trim();
  return {
    whatsapp_webhook: {
      url: `${urlPublicaApp()}/api/whatsapp/kapso`,
      secret_key: ocultarSecreto ? "•••(KAPSO_WEBHOOK_SECRET)•••" : requerida("KAPSO_WEBHOOK_SECRET"),
      kind: "kapso",
      payload_version: "v2",
      events: [
        "whatsapp.message.received",
        "whatsapp.message.sent",
        "whatsapp.message.delivered",
        "whatsapp.message.read",
        "whatsapp.message.failed",
      ],
      active: true,
      // Sin lotes: cada mensaje llega solo (el parser igual tolera lotes).
      buffer_enabled: false,
      ...(token ? { headers: { [HEADER_TOKEN_WEBHOOK]: ocultarSecreto ? "•••(KAPSO_WEBHOOK_TOKEN)•••" : token } } : {}),
    },
  };
}

async function webhook(args: string[]): Promise<void> {
  const linea = requerida("KAPSO_PHONE_NUMBER_ID");
  const url = `${PLATFORM}/whatsapp/phone_numbers/${linea}/webhooks`;
  if (args.includes("--listar")) {
    const cuerpo = (await llamar(url)) as { data?: Array<Record<string, unknown>> };
    imprimir((cuerpo.data ?? []).map((w) => ({ id: w.id, url: w.url, kind: w.kind, events: w.events, active: w.active })));
    return;
  }
  if (!args.includes("--crear")) {
    imprimir(cuerpoWebhook(true));
    return;
  }
  const creado = (await llamar(url, { method: "POST", body: JSON.stringify(cuerpoWebhook(false)) })) as { data?: Record<string, unknown> };
  imprimir(creado.data ? { id: creado.data.id, url: creado.data.url, events: creado.data.events, active: creado.data.active } : creado);
}

async function probar(args: string[]): Promise<void> {
  const celular = args.find((a) => /\d{7,}/.test(a));
  if (!celular) throw new Error("Falta el celular: probar 3001234567 --si-enviar");
  const config = kapsoConfig();
  if (!config) throw new Error("Faltan KAPSO_API_KEY / KAPSO_PHONE_NUMBER_ID / KAPSO_WEBHOOK_SECRET");
  const cuerpo = mensajePlantillaPse({
    to: normalizarCelular(celular),
    plantilla: config.plantillaPse,
    idioma: config.idiomaPlantilla,
    solicitudId: "cprueba0000000000000000000",
    token: "prueba-sin-efecto",
    datos: { nombreAprobador: "Prueba", operador: "Sixteam", consecutivo: "DO.PRUEBA", beneficiario: "Prueba de canal", valor: 1000n },
  });
  if (!args.includes("--si-enviar")) {
    imprimir(cuerpo);
    process.stdout.write("\nNo se envió nada. Agrega --si-enviar para mandar este WhatsApp real.\n");
    return;
  }
  imprimir(await enviarWhatsapp(config, cuerpo));
}

async function main(): Promise<void> {
  const [comando, ...args] = process.argv.slice(2);
  if (comando === "numeros") return numeros();
  if (comando === "plantilla") return plantilla(args);
  if (comando === "webhook") {
    // Con la pasarela de Sixteam, el webhook de Kapso de la línea compartida es de ELLA.
    if (!args.includes("--directo")) {
      process.stdout.write(
        [
          "El webhook de Kapso de la línea Sixteam.pro lo registra la pasarela (sixteam-whatsapp-gateway: node dist/cli/kapso.js webhook-crear --si).",
          "Galcomex es un inquilino: su URL se da de alta con node dist/cli/tenant.js alta --id galcomex ...",
          "Usa --directo solo si Galcomex tuviera línea propia, sin pasarela.",
          "",
        ].join("\n"),
      );
      return;
    }
    return webhook(args);
  }
  if (comando === "probar") return probar(args);
  process.stdout.write("Uso: whatsapp-kapso.ts numeros | plantilla [--crear|--estado] | webhook --directo [--crear|--listar] | probar <celular> [--si-enviar]\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
