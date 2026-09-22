import { normalizarCelular } from "./telefono";

/**
 * Aprobadores del código del token PSE: quiénes reciben el WhatsApp.
 *
 * Viven en el parámetro WHATSAPP_APROBADORES_PSE (editable por ADMIN en
 * Configuración → Parámetros) para que Galcomex los cambie sin un deploy.
 * Formato: "Nombre:celular" separados por ";".
 *   María Camila:3001234567; Guillermo:3009876543
 *
 * El valor sembrado es SIN_CONFIGURAR: nadie recibe mensajes hasta que un
 * humano escriba los números a propósito.
 */
export const CLAVE_APROBADORES_PSE = "WHATSAPP_APROBADORES_PSE";
export const SIN_CONFIGURAR = "SIN_CONFIGURAR";

export interface Aprobador {
  nombre: string;
  /** Normalizado E.164 sin "+": 573001234567. */
  telefono: string;
}

export type ResultadoAprobadores =
  | { ok: true; aprobadores: Aprobador[] }
  | { ok: false; error: string };

const MAX_APROBADORES = 5;

export function parsearAprobadores(valor: string): ResultadoAprobadores {
  const texto = valor.trim();
  if (texto === "" || texto.toUpperCase() === SIN_CONFIGURAR) return { ok: true, aprobadores: [] };

  const aprobadores: Aprobador[] = [];
  const vistos = new Set<string>();
  const entradas = texto.split(";").map((e) => e.trim()).filter(Boolean);

  for (const entrada of entradas) {
    const separador = entrada.lastIndexOf(":");
    if (separador <= 0) {
      return { ok: false, error: `"${entrada}" no tiene el formato Nombre:celular` };
    }
    const nombre = entrada.slice(0, separador).trim();
    const telefono = normalizarCelular(entrada.slice(separador + 1));
    if (nombre.length < 2 || nombre.length > 40) {
      return { ok: false, error: `El nombre "${nombre}" debe tener entre 2 y 40 caracteres` };
    }
    // Colombia: 57 + móvil de 10 dígitos que empieza por 3.
    if (!/^573\d{9}$/.test(telefono)) {
      return { ok: false, error: `El celular de ${nombre} no es un móvil colombiano válido (10 dígitos, empieza por 3)` };
    }
    if (vistos.has(telefono)) {
      return { ok: false, error: `El celular de ${nombre} está repetido` };
    }
    vistos.add(telefono);
    aprobadores.push({ nombre, telefono });
  }

  if (aprobadores.length > MAX_APROBADORES) {
    return { ok: false, error: `Máximo ${MAX_APROBADORES} aprobadores` };
  }
  return { ok: true, aprobadores };
}

/** Busca al aprobador por su teléfono ya normalizado. */
export function aprobadorPorTelefono(aprobadores: Aprobador[], telefono: string): Aprobador | null {
  return aprobadores.find((a) => a.telefono === telefono) ?? null;
}
