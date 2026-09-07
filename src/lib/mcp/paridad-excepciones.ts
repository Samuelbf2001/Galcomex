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

const pendiente = (
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
  intencional("GET", "/api/tramites/[param]/pse-codigo", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("POST", "/api/tramites/[param]/pse-token", "Flujo PSE con token de 30s, no apto para agentes"),
  intencional("GET", "/api/compartir/[param]", "Enlace público de documento, sin sesión"),
  intencional("POST", "/api/solicitudes", "Formulario público para que un cliente pida apertura de DO"),
  intencional("GET", "/api/storage", "Presign interno de MinIO; documento_subir lo usa por debajo"),
  intencional("POST", "/api/storage", "Presign interno de MinIO"),
  intencional("DELETE", "/api/storage", "Presign interno de MinIO"),
  intencional("GET", "/api/borradores/[param]/pdf", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/borradores/[param]/export", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/borradores/[param]/siigo-import", "Binario XLSX — cubierto por exportar_archivo"),
  intencional("GET", "/api/cartera/pdf", "Binario — cubierto por exportar_archivo"),
  intencional("GET", "/api/cartera/export", "Binario — cubierto por exportar_archivo"),
  intencional("PUT", "/api/clientes/[param]", "Alias de PATCH; cliente_actualizar usa PATCH"),
  intencional("PUT", "/api/tramites/[param]", "Alias de PATCH; tramite_actualizar usa PATCH"),
  intencional("GET", "/api/configuracion/siigo/productos", "Duplicado de /api/siigo-productos, que sí tiene tool"),
  intencional("POST", "/api/importar/grupo-e-papis", "Migración histórica del Excel; se corre una vez, no es operación de agente"),

  // ── Pendientes (deuda visible) ──────────────────────────────────────────────
  pendiente("GET", "/api/pagos/multi", "Pago en bloque multi-DO: listar facturas elegibles de un beneficiario"),
  pendiente("POST", "/api/pagos/multi", "Pago en bloque multi-DO: un comprobante cubre facturas de varios DOs"),
  pendiente("GET", "/api/liquidacion-lm", "Liquidación del socio Lucho"),
  pendiente("POST", "/api/cartera/conciliar-lote", "Conciliar varias facturas de cartera de una vez"),
  pendiente("GET", "/api/borradores/[param]/cruce-facturas", "Panel de validaciones del revisor (cruce facturas ↔ pagos)"),
  pendiente("PATCH", "/api/borradores/[param]/comision-interna-lm", "Comisión interna LM del borrador"),
  pendiente("POST", "/api/borradores/[param]/siigo-enviar", "Enviar la factura a Siigo como borrador"),
  pendiente("POST", "/api/borradores/[param]/siigo-sincronizar", "Traer el consecutivo estampado desde Siigo"),
  pendiente("GET", "/api/tramites/[param]/pagos", "Libro de pagos de un trámite (hoy se lee vía tramite_ver / pagos_listar global)"),
  pendiente("PUT", "/api/tramites/[param]/documentos/[param]", "Reemplazar un documento"),
  pendiente("POST", "/api/tramites/[param]/documentos/[param]/enlace", "Crear enlace público de un documento"),
  pendiente("DELETE", "/api/tramites/[param]/documentos/[param]/enlace", "Revocar enlace público"),
  pendiente("GET", "/api/configuracion/siigo/parametros", "Parámetros de la integración Siigo"),
  pendiente("PUT", "/api/configuracion/siigo/parametros", "Editar parámetros de la integración Siigo"),
  pendiente("GET", "/api/configuracion/siigo/formas-pago", "Catálogo Siigo: formas de pago"),
  pendiente("POST", "/api/configuracion/siigo/formas-pago/sync", "Sincronizar formas de pago"),
  pendiente("GET", "/api/configuracion/siigo/impuestos", "Catálogo Siigo: impuestos"),
  pendiente("POST", "/api/configuracion/siigo/impuestos/sync", "Sincronizar impuestos"),
  pendiente("PUT", "/api/configuracion/siigo/productos/[param]/impuestos", "Asociar impuestos a un producto Siigo"),
  pendiente("GET", "/api/configuracion/siigo/tipos-comprobante", "Catálogo Siigo: tipos de comprobante"),
  pendiente("POST", "/api/configuracion/siigo/tipos-comprobante/sync", "Sincronizar tipos de comprobante"),
  pendiente("GET", "/api/configuracion/siigo/vendedores", "Catálogo Siigo: vendedores"),
  pendiente("POST", "/api/configuracion/siigo/vendedores/sync", "Sincronizar vendedores"),
];
