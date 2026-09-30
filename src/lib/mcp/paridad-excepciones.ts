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
  intencional("POST", "/api/usuarios/rol-simulado", "Solo interfaz: «Probar como otro rol» de la administradora es una cookie de navegador, no una operación de agente"),
  intencional("DELETE", "/api/usuarios/rol-simulado", "Solo interfaz: vuelve de «Probar como otro rol» (borra la cookie del navegador)"),
  intencional("GET", "/api/pse/[param]", "Landing pública del código PSE (María Camila aprueba desde WhatsApp)"),
  intencional("POST", "/api/pse/[param]", "Landing pública del código PSE"),
  intencional("POST", "/api/whatsapp/kapso", "Webhook de Kapso (firmado HMAC): lo llama WhatsApp, no un usuario"),
  intencional("GET", "/api/tramites/[param]/pse-codigo", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("POST", "/api/tramites/[param]/pse-token", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("GET", "/api/compartir/[param]", "Enlace público de documento, sin sesión"),
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

  // Explorador de documentos «Por cliente» (feat/archivos-por-cliente-v2, 2026-09-22).
  pendiente(
    "GET",
    "/api/archivos/clientes",
    "Explorador por cliente (clientes con sus DOs y conteo de documentos): falta tool archivos_por_cliente",
  ),
  pendiente(
    "GET",
    "/api/archivos/clientes/[param]",
    "Detalle del explorador por cliente: falta tool archivos_cliente_ver",
  ),

  // Enlazar ficha de pago + "Registrar factura de <proveedor>" (M5, caso
  // Coldex, 2026-09-24). Las tools van en galcomex-mcp/server.mjs.
  pendiente(
    "POST",
    "/api/clientes/[param]/beneficiario/enlazar",
    "Enlazar con un clic el beneficiario de una empresa: falta tool beneficiario_enlazar_empresa",
  ),
  pendiente(
    "POST",
    "/api/clientes/[param]/cuenta/soporte",
    "URL prefirmada del PDF de una factura de proveedor en la cuenta corriente: falta tool cuenta_soporte_subir",
  ),
  pendiente(
    "GET",
    "/api/clientes/[param]/cuenta/movimientos/[param]/soporte",
    "Descarga del PDF de soporte de un movimiento de cuenta corriente: falta tool cuenta_soporte_descargar",
  ),
  pendiente(
    "GET",
    "/api/tramites/[param]/comisiones",
    "Comisión por contenedor del DO (caso LTRANS): falta tool tramite_comisiones_ver",
  ),
  pendiente(
    "PUT",
    "/api/tramites/[param]/comisiones",
    "Contenedores con comisión de una empresa en el DO (caso LTRANS): falta tool tramite_comision_registrar",
  ),
  pendiente(
    "GET",
    "/api/clientes/[param]/comisiones",
    "Comisiones por contenedor por facturar de la empresa que paga (LTRANS): falta tool comisiones_empresa_ver",
  ),

  // Eliminar movimiento manual de la cuenta corriente (ajustes M5, 2026-09-26).
  pendiente(
    "DELETE",
    "/api/clientes/[param]/cuenta/movimientos/[param]",
    "Quitar un movimiento manual registrado por error: falta tool cuenta_movimiento_eliminar",
  ),

  // Diseño A — B8, anticipo disponible por DO (2026-09-27/28). La tool
  // borrador_asignar_anticipo se agrega al MCP compartido (galcomex-mcp/server.mjs)
  // después de desplegar A (paso 10 del diseño); borrar esta línea entonces.
  pendiente(
    "PATCH",
    "/api/borradores/[param]/anticipo",
    "Excepción ADMIN para asignar a mano el anticipo de una factura: falta tool borrador_asignar_anticipo",
  ),
  intencional(
    "GET",
    "/api/borradores/[param]",
    "Recargar un borrador tras el 409 ANTICIPO_ACTUALIZADO (B8); el MCP ya lee el borrador vía tramite_ver/borrador_ver por trámite",
  ),

  // Envío a Siigo sin duplicados (fix/siigo-envio-idempotente, 2026-09-25).
  // Las tools van en galcomex-mcp/server.mjs (y borrador_siigo_enviar debe
  // dejar de ofrecer `reenviar`, que ahora responde 400).
  pendiente(
    "POST",
    "/api/borradores/[param]/siigo-revisar",
    "«Revisar en SIIGO» un envío sin confirmar: falta tool borrador_siigo_revisar",
  ),
  pendiente(
    "POST",
    "/api/borradores/[param]/siigo-liberar",
    "«Liberar para reenviar» un envío sin confirmar: falta tool borrador_siigo_liberar",
  ),

  // Gestión de usuarios por el ADMIN (feat/usuarios-admin, 2026-09-24). Las
  // tools van en galcomex-mcp/server.mjs; hoy solo existe usuario_reset_password.
  pendiente("GET", "/api/usuarios", "Usuarios con estado (activo, clave temporal): falta tool usuarios_listar"),
  pendiente("POST", "/api/usuarios", "Alta de usuario con clave temporal: falta tool usuario_crear"),
  pendiente(
    "PATCH",
    "/api/usuarios/[param]",
    "Cambiar rol / desactivar / reactivar usuario: falta tool usuario_actualizar",
  ),

  // Diseño B — B10, "Facturar comisiones" de LTRANS (2026-09-29). La tool
  // comisiones_facturar se agrega al MCP compartido (galcomex-mcp/server.mjs)
  // después de desplegar B; borrar esta línea entonces.
  pendiente(
    "POST",
    "/api/clientes/[param]/comisiones/liquidar",
    "Facturar comisiones por contenedor (crea un «Otros» a nombre de la empresa que paga): tool comisiones_facturar se agrega al MCP compartido tras desplegar B",
  ),
  // M3 (revisión INTEG-B): deshacer la liquidación. Tool comisiones_deshacer al MCP
  // compartido después de desplegar; borrar esta línea entonces.
  pendiente(
    "DELETE",
    "/api/clientes/[param]/comisiones/liquidaciones/[param]",
    "Deshacer una liquidación de comisiones (las comisiones vuelven a por facturar y el «Otros» queda anulado, solo ADMIN con motivo): tool comisiones_deshacer se agrega al MCP compartido tras desplegar",
  ),

  // Diseño B — B7, cotización / solicitud de fondos por DO (2026-09-29). Las
  // tools tramite_cotizacion_ver / tramite_cotizacion_pdf se agregan al MCP
  // compartido (galcomex-mcp/server.mjs) después de desplegar B; borrar estas
  // líneas entonces.
  pendiente(
    "GET",
    "/api/tramites/[param]/cotizacion",
    "Cotización / solicitud de fondos del DO en JSON (misma cuenta que la factura, valor para la OC, nota de la agencia): falta tool tramite_cotizacion_ver",
  ),
  pendiente(
    "GET",
    "/api/tramites/[param]/cotizacion/pdf",
    "Cotización / solicitud de fondos del DO en PDF: falta tool tramite_cotizacion_pdf (binario; ver exportar_archivo)",
  ),
];
