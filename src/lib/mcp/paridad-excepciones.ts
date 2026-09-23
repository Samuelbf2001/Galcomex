/**
 * Excepciones de paridad API ↔ MCP.
 *
 * Dos tipos, y la diferencia importa:
 *
 *   INTENCIONAL — el endpoint no debe tener tool dedicada (auth, landings
 *                 públicas, binarios que ya cubre `exportar_archivo`, alias).
 *   PENDIENTE   — sí debería tenerla y todavía no. Es deuda visible: el reporte
 *                 la lista aparte y el test NO deja que crezca sin declararla.
 *
 * Para quitar un PENDIENTE: crear la tool y borrar la línea. El test avisa si
 * una excepción quedó obsoleta.
 */

import type { Excepcion } from "@/lib/mcp/paridad";

export type TipoExcepcion = "INTENCIONAL" | "PENDIENTE";

export interface ExcepcionTipada extends Excepcion {
  tipo: TipoExcepcion;
}

const intencional = (
  metodo: Excepcion["metodo"],
  ruta: string,
  razon: string,
): ExcepcionTipada => ({ metodo, ruta, razon, tipo: "INTENCIONAL" });

/** Exportado para que siga disponible (y sin warning de lint) mientras la lista de deuda esté vacía. */
export const pendiente = (
  metodo: Excepcion["metodo"],
  ruta: string,
  razon: string,
): ExcepcionTipada => ({ metodo, ruta, razon, tipo: "PENDIENTE" });

export const EXCEPCIONES_PARIDAD: ExcepcionTipada[] = [
  // ── Intencionales ───────────────────────────────────────────────────────────
  intencional("GET", "/api/auth/[param]", "Better Auth — el MCP hace login por aquí, no es una tool"),
  intencional("POST", "/api/auth/[param]", "Better Auth"),
  intencional("PATCH", "/api/auth/[param]", "Better Auth"),
  intencional("PUT", "/api/auth/[param]", "Better Auth"),
  intencional("DELETE", "/api/auth/[param]", "Better Auth"),
  intencional("POST", "/api/login", "Login legacy; el MCP usa Better Auth"),
  intencional("GET", "/api/pse/[param]", "Landing pública del código PSE (María Camila aprueba desde WhatsApp)"),
  intencional("POST", "/api/pse/[param]", "Landing pública del código PSE"),
  intencional("POST", "/api/whatsapp/kapso", "Webhook de Kapso (firmado HMAC): lo llama WhatsApp, no un usuario"),
  intencional("GET", "/api/tramites/[param]/pse-codigo", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("POST", "/api/tramites/[param]/pse-token", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("GET", "/api/compartir/[param]", "Enlace público de documento, sin sesión"),
  intencional("POST", "/api/solicitudes", "Formulario público para que un cliente pida apertura de DO"),
  intencional("GET", "/api/storage", "Listado interno de la bodega de archivos; documento_subir usa el POST por debajo"),
  intencional("POST", "/api/storage", "Enlaces firmados internos de subida/descarga"),
  intencional("GET", "/api/storage/objeto", "Enlace firmado de descarga; lo consumen documento_descargar y el navegador"),
  intencional("PUT", "/api/storage/objeto", "Enlace firmado de subida; lo consume documento_subir por debajo"),
  intencional("DELETE", "/api/storage", "Papelera interna de la bodega de archivos"),
  intencional("GET", "/api/borradores/[param]/pdf", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/borradores/[param]/export", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/borradores/[param]/siigo-import", "Binario XLSX — cubierto por exportar_archivo"),
  intencional("GET", "/api/cartera/pdf", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/cartera/export", "Binario — cubierto por exportar_archivo"),
  intencional("PUT", "/api/clientes/[param]", "Alias de PATCH; cliente_actualizar usa PATCH"),
  intencional("PUT", "/api/tramites/[param]", "Alias de PATCH; tramite_actualizar usa PATCH"),
  intencional("GET", "/api/configuracion/siigo/productos", "Duplicado de /api/siigo-productos, que sí tiene tool"),
  intencional("POST", "/api/importar/grupo-e-papis", "Migración histórica del Excel; se corre una vez, no es operación de agente"),
  intencional("GET", "/api/facturacion/borradores", "Lote de GET /api/tramites/[param]/borrador para la pantalla de facturación (elimina el N+1 del cliente); el MCP usa borrador_ver por trámite"),

  // ── Pendientes (deuda visible) ──────────────────────────────────────────────
  // Para declarar deuda nueva:
  //   pendiente("GET", "/api/ruta/[param]", "por qué debería tener tool y aún no"),
  //
  // Configuración → Catálogos (2026-09-18, fase 1 backend). Las tools del MCP
  // viven en otro repo (galcomex-mcp/server.mjs) y se agregan junto con la UI.
  pendiente("GET", "/api/configuracion/catalogos/conceptos", "Catálogos fase 1: falta tool conceptos_listar"),
  pendiente("POST", "/api/configuracion/catalogos/conceptos", "Catálogos fase 1: falta tool concepto_crear"),
  pendiente("PATCH", "/api/configuracion/catalogos/conceptos", "Catálogos fase 1: falta tool concepto_actualizar"),
  pendiente("GET", "/api/configuracion/catalogos/eventos", "Catálogos fase 1: eventos_catalogo solo lee los activos del flujo del DO"),
  pendiente("PATCH", "/api/configuracion/catalogos/eventos", "Catálogos fase 1: falta tool evento_catalogo_actualizar"),

  // Devolver borrador con observación (2026-09-22). La tool vive en el otro
  // repo (galcomex-mcp/server.mjs) y se agrega junto con el resto del módulo.
  pendiente(
    "POST",
    "/api/borradores/[param]/devolver",
    "Devolución del revisor: falta tool borrador_devolver",
  ),

  // Revisión de Ernesto (2026-09-22). Las tools van en galcomex-mcp/server.mjs.
  pendiente(
    "GET",
    "/api/tramites/requisitos",
    "Requisitos para abrir un DO (tarifa vigente, BL y factura): falta tool tramite_requisitos",
  ),
  pendiente(
    "GET",
    "/api/tarifarios",
    "Lista liviana de tarifarios de todas las empresas para «Arrancar desde»: falta tool tarifarios_listar_todos",
  ),
];
