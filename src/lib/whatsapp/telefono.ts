/**
 * Normalización de celulares colombianos para WhatsApp.
 *
 * Meta entrega el remitente en E.164 sin "+" ("573001234567") y exige el mismo
 * formato en el destinatario. Si se guarda "3001234567" y se manda así, Kapso
 * acepta la llamada y devuelve un wamid, pero Meta descarta el mensaje después
 * (medido en Mizar el 2026-09-11). Por eso destino e identidad pasan por la
 * MISMA función: un número válido para recibir tiene que ser reconocible al
 * responder.
 *
 * Un móvil local de 10 dígitos se homologa anteponiendo 57; cualquier otro largo
 * se deja tal cual (solo dígitos). Si está mal, que lo rechace Meta y se vea, en
 * vez de inventarle un indicativo y escribirle a otra persona.
 */
export function normalizarCelular(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  return digitos.length === 10 ? `57${digitos}` : digitos;
}

/** "573001234567" → "+57 300 123 4567" para mostrar sin exponer el número completo en logs. */
export function celularVisible(normalizado: string): string {
  if (normalizado.length !== 12 || !normalizado.startsWith("57")) return normalizado;
  return `+57 ${normalizado.slice(2, 5)} ${normalizado.slice(5, 8)} ${normalizado.slice(8)}`;
}
