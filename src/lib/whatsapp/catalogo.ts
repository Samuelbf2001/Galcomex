/**
 * CATÁLOGO DE MENSAJES DE WHATSAPP DE GALCOMEX — la lista cerrada de lo que la
 * plataforma manda y de las respuestas que entiende. Nada sale por WhatsApp si
 * no está aquí. Documentado para el equipo en docs/WHATSAPP-APROBACIONES.md.
 *
 * Por qué hay DOS clases de mensaje:
 *  - PLANTILLA: el primer aviso llega "en frío" (el aprobador no ha escrito en
 *    las últimas 24 h), y fuera de esa ventana Meta SOLO admite plantillas
 *    aprobadas. Un texto libre ahí falla con 131047.
 *  - TEXTO LIBRE: las confirmaciones. Siempre responden a algo que la persona
 *    acaba de escribir, así que la ventana está abierta.
 *
 * Aislamiento: todo payload de botón empieza por "gx_" y lleva el id de la
 * solicitud. El webhook ignora cualquier botón que no sea suyo.
 */

// ─── Respuestas que se entienden ─────────────────────────────────────────────

export const PREFIJO_BOTON = "gx_";
/** Botón de respuesta rápida de la plantilla. Payload: "gx_pse_no_puedo:<solicitudId>". */
export const BOTON_NO_PUEDO = "gx_pse_no_puedo";

export function payloadNoPuedo(solicitudId: string): string {
  return `${BOTON_NO_PUEDO}:${solicitudId}`;
}

export function leerPayloadBoton(payload: string): { accion: "NO_PUEDO"; solicitudId: string } | null {
  const [accion, solicitudId, ...resto] = payload.split(":");
  if (resto.length > 0 || !solicitudId || !/^[a-z0-9]{10,40}$/.test(solicitudId)) return null;
  if (accion === BOTON_NO_PUEDO) return { accion: "NO_PUEDO", solicitudId };
  return null;
}

/**
 * El código del token tal como lo escribe la persona: "482913", "482 913",
 * "E11027". Se compactan espacios y guiones; tiene que quedar alfanumérico de
 * 4 a 12 caracteres con al menos un dígito ("gracias" u "ok" no son códigos).
 */
export function extraerCodigo(texto: string): string | null {
  const compacto = texto.trim().replace(/[\s-]/g, "");
  if (!/^[A-Za-z0-9]{4,12}$/.test(compacto) || !/\d/.test(compacto)) return null;
  return compacto.toUpperCase();
}

// ─── 1. PLANTILLA: pedir el código del token (PSE_CODIGO) ────────────────────

/**
 * Definición que se registra en Meta (scripts/whatsapp-plantilla-pse.ts). Sin
 * tildes a propósito, como en Mizar: menos rechazos de revisión y ningún
 * cliente viejo que las pinte mal. El ORDEN de las variables {{1}}..{{5}} es
 * contrato con `parametrosPlantillaPse` más abajo.
 */
export const TEXTO_PLANTILLA_PSE =
  "Hola {{1}}. {{2}} necesita el codigo del token para un pago PSE.\n\n" +
  "DO: {{3}}\nBeneficiario: {{4}}\nValor: {{5}}\n\n" +
  "Responde a este mensaje solo con el codigo, o usa el boton Abrir enlace.";

export function definicionPlantillaPse(nombre: string, idioma: string, urlApp: string) {
  return {
    name: nombre,
    language: idioma,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: TEXTO_PLANTILLA_PSE,
        example: { body_text: [["Maria Camila", "Karina", "DO.BAQ26-0142", "Almacenes Almacarga", "$4.233.902"]] },
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "No puedo ahora" },
          { type: "URL", text: "Abrir enlace", url: `${urlApp}/pse/{{1}}`, example: [`${urlApp}/pse/3f9a6c21d4e8`] },
        ],
      },
    ],
  };
}

export interface DatosPlantillaPse {
  nombreAprobador: string;
  operador: string;
  consecutivo: string;
  beneficiario: string | null;
  valor: bigint | null;
}

/**
 * Meta rechaza parámetros vacíos, con saltos de línea, tabs o más de 4 espacios
 * seguidos. Se limpian aquí para que un dato raro no tumbe el aviso.
 */
function parametroSeguro(texto: string | null | undefined, porDefecto = "Sin especificar"): string {
  const limpio = (texto ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return limpio === "" ? porDefecto : limpio;
}

export function formatoPesos(valor: bigint): string {
  const negativo = valor < 0n;
  const digitos = (negativo ? -valor : valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "-" : ""}$${digitos}`;
}

export function parametrosPlantillaPse(d: DatosPlantillaPse): string[] {
  return [
    parametroSeguro(d.nombreAprobador),
    parametroSeguro(d.operador, "El equipo de Galcomex"),
    parametroSeguro(d.consecutivo),
    parametroSeguro(d.beneficiario),
    d.valor !== null ? formatoPesos(d.valor) : "Sin especificar",
  ];
}

/** Cuerpo Cloud API del envío. Los índices de botón siguen el orden de la definición. */
export function mensajePlantillaPse(input: {
  to: string;
  plantilla: string;
  idioma: string;
  datos: DatosPlantillaPse;
  solicitudId: string;
  token: string;
}) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.plantilla,
      language: { code: input.idioma },
      components: [
        {
          type: "body",
          parameters: parametrosPlantillaPse(input.datos).map((text) => ({ type: "text", text })),
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: payloadNoPuedo(input.solicitudId) }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "1",
          parameters: [{ type: "text", text: input.token }],
        },
      ],
    },
  };
}

// ─── 2..7. TEXTO LIBRE: confirmaciones (ventana de 24 h abierta) ─────────────

export type TipoRespuesta =
  | "PSE_RECIBIDO"
  | "PSE_NO_PUEDO_OK"
  | "PSE_YA_ATENDIDA"
  | "PSE_CERRADA"
  | "PSE_FORMATO"
  | "PSE_AMBIGUA"
  | "PSE_SIN_SOLICITUD";

export interface DatosRespuesta {
  nombre?: string;
  consecutivo?: string;
  operador?: string;
  quien?: string;
  consecutivos?: string[];
}

export function textoRespuesta(tipo: TipoRespuesta, d: DatosRespuesta = {}): string {
  const operador = d.operador ?? "el operario";
  switch (tipo) {
    case "PSE_RECIBIDO":
      return `Listo${d.nombre ? `, ${d.nombre}` : ""}. Recibimos el código${d.consecutivo ? ` del DO ${d.consecutivo}` : ""} y ${operador} ya lo tiene en pantalla.`;
    case "PSE_NO_PUEDO_OK":
      return `Entendido. Le avisamos a ${operador} que no puedes en este momento.`;
    case "PSE_YA_ATENDIDA":
      return `Ese código ya lo envió ${d.quien ?? "otra persona"}. No hace falta nada más.`;
    case "PSE_CERRADA":
      return "Esa solicitud ya venció o fue reemplazada por una más nueva. Si hace falta otro código te llegará un mensaje nuevo.";
    case "PSE_FORMATO":
      return "No reconocí el código. Responde solo con los números del token, por ejemplo 482913.";
    case "PSE_AMBIGUA":
      return `Tienes ${d.consecutivos?.length ?? "varias"} solicitudes abiertas (${(d.consecutivos ?? []).join(", ")}). Responde citando el mensaje del DO al que corresponde el código: mantén presionado el mensaje y toca Responder.`;
    case "PSE_SIN_SOLICITUD":
      return "No tienes solicitudes de código abiertas en este momento.";
  }
}

export function mensajeTexto(to: string, cuerpo: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: cuerpo, preview_url: false },
  };
}
