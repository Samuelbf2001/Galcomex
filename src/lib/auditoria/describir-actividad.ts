/**
 * Traducción de un registro de auditoría (`entidad` + `accion`) a una frase
 * en lenguaje natural, sin el nombre de quien lo hizo: "creó el DO",
 * "registró un anticipo". La usan la "Actividad reciente" del Dashboard y el
 * Historial del DO, para que nunca se vean códigos como CREATE_CHECKLIST_ITEM.
 *
 * Los códigos vienen de los `AuditLog` que escriben los servicios
 * (`grep -rn "accion:" src/lib`): CREATE/UPDATE/DELETE son genéricos y solo
 * tienen sentido junto a la entidad, por eso la clave compuesta va primero y
 * `ACCIONES_GENERICAS` es el segundo intento.
 */
const ACTIVIDAD_POR_ENTIDAD: Record<string, string> = {
  // Trámites (DO)
  "TramiteDO:CREATE": "creó el DO",
  "TramiteDO:CREATE_TRAMITE": "creó el DO",
  "TramiteDO:CREAR_TRAMITE": "creó el DO",
  "TramiteDO:UPDATE": "editó el DO",
  "TramiteDO:UPDATE_ESTADO": "cambió el estado del DO",
  "TramiteDO:CAMBIO_ESTADO": "cambió el estado del DO",
  "TramiteDO:REAPERTURA": "reabrió el DO",
  "TramiteDO:OMITIR_REQUISITOS": "avanzó el DO con requisitos pendientes (excepción de ADMIN)",
  "TramiteDO:FORZAR_FACTURADO": "marcó el DO como facturado sin factura emitida (excepción de ADMIN)",
  "TramiteDO:SET_EVENTOS_TRAMITE": "marcó los eventos del DO",
  // Borradores de factura de venta
  "BorradorFactura:CREATE": "generó un borrador de factura",
  "BorradorFactura:UPDATE": "actualizó un borrador de factura",
  "BorradorFactura:UPDATE_ESTADO": "cambió el estado de un borrador de factura",
  "BorradorFactura:APPROVE": "aprobó un borrador de factura",
  "BorradorFactura:FACTURAR": "marcó como facturado un borrador",
  "BorradorFactura:DEVOLVER": "devolvió un borrador con una observación",
  "BorradorFactura:UPDATE_COMISION": "actualizó la comisión de un borrador",
  "BorradorFactura:UPDATE_COMISION_INTERNA_LM": "actualizó la comisión interna LM de un borrador",
  "BorradorFactura:UPDATE_COMENTARIOS": "editó las observaciones de un borrador",
  "BorradorFactura:REEMPLAZO_TERCEROS_SIIGO": "cargó las líneas de terceros tal como están en Siigo",
  "BorradorFactura:AJUSTE_RETEIVA_HISTORICO": "ajustó la ReteIVA de una factura histórica",
  "BorradorFactura:RECALCULAR_ANTICIPO": "recalculó el anticipo de un borrador",
  "BorradorFactura:ASIGNAR_ANTICIPO": "asignó a mano el anticipo de un borrador",
  "BorradorFactura:APROBAR_SIN_CUADRE_OC": "aprobó un borrador que no cuadra con la orden de compra (excepción de ADMIN)",
  "BorradorFactura:SIIGO_ENVIAR_OK": "envió una factura a SIIGO",
  "BorradorFactura:SIIGO_ENVIAR_ERROR": "intentó enviar una factura a SIIGO (falló)",
  "BorradorFactura:SIIGO_ENVIAR_INCIERTO": "envió una factura a SIIGO sin confirmación",
  "BorradorFactura:SIIGO_SINCRONIZAR": "sincronizó una factura desde SIIGO",
  "LineaRevision:CREATE": "agregó una línea al borrador",
  "LineaRevision:UPDATE": "editó una línea del borrador",
  "LineaRevision:DELETE": "eliminó una línea del borrador",
  // Cartera
  "Factura:UPDATE": "actualizó una factura",
  "PagoFactura:CREATE": "registró un abono o devolución de factura",
  "PagoFactura:CREATE_PAGO": "registró un abono o devolución de factura",
  "PagoFactura:DELETE": "anuló un pago de factura",
  "PagoFactura:VERIFICAR": "verificó en banco un pago de factura",
  "ConciliacionBatchCartera:CREATE": "concilió un lote de cartera",
  // Anticipos
  "Anticipo:CREATE": "registró un anticipo",
  "Anticipo:CREATE_ANTICIPO": "registró un anticipo",
  "Anticipo:VERIFICAR": "verificó en banco un anticipo",
  "AplicacionAnticipo:APLICAR_ANTICIPO": "aplicó un anticipo al DO",
  "AplicacionAnticipo:ELIMINAR_APLICACION_ANTICIPO": "quitó la aplicación de un anticipo",
  // Pagos a proveedores / facturas de proveedor
  "PagoTramite:CREATE": "registró un pago a proveedor",
  "PagoTramite:CREATE_PAGO": "registró un pago a proveedor",
  "PagoTramite:UPDATE": "editó un pago a proveedor",
  "PagoTramite:DELETE": "eliminó un pago a proveedor",
  "PagoTramiteGrupo:CREATE": "registró un pago en bloque a proveedores",
  "PagoTramiteGrupo:ANULAR_PAGO_GRUPO": "anuló un pago en bloque",
  "FacturaProveedor:CREATE": "registró una factura de proveedor",
  "FacturaProveedor:UPDATE": "editó una factura de proveedor",
  "FacturaProveedor:DELETE": "eliminó una factura de proveedor",
  "FacturaProveedor:UPDATE_ESTADO": "actualizó el estado de pago de una factura de proveedor",
  "FacturaProveedor:REEXPRESAR_USD": "re-expresó en pesos una factura en dólares",
  // Beneficiarios y cuenta corriente
  "Beneficiario:CREATE_BENEFICIARIO": "creó un beneficiario",
  "Beneficiario:UPDATE_BENEFICIARIO": "editó un beneficiario",
  "MovimientoCuenta:CREATE_MOVIMIENTO_CUENTA": "registró un movimiento de cuenta corriente",
  "MovimientoCuenta:DELETE_MOVIMIENTO_CUENTA": "eliminó un movimiento de cuenta corriente",
  // Documentos y checklist
  "Documento:CREATE": "subió un documento",
  "Documento:DELETE": "eliminó un documento",
  "Documento:REPLACE": "reemplazó un documento",
  "ChecklistItem:CREATE_CHECKLIST_ITEM": "agregó un ítem al checklist",
  "ChecklistItem:UPDATE_CHECKLIST_ITEM": "marcó o desmarcó un ítem del checklist",
  "DocumentoEnlace:CREATE": "creó un enlace para compartir un documento",
  "DocumentoEnlace:REVOKE": "revocó un enlace de documento",
  // Avisos
  "Notificacion:NOTIFICAR_WHATSAPP": "envió un aviso por WhatsApp",
  // Configuración
  "EmpresaCapacidad:SET_CAPACIDAD_EMPRESA": "activó o desactivó una función de la empresa",
  "EmpresaCapacidad:RESET_CAPACIDAD_EMPRESA": "restableció una función de la empresa",
  "Parametro:UPDATE": "editó un parámetro del sistema",
  "MatrizRecaudo:UPDATE": "editó la matriz de recaudo",
  "MatrizPago:UPDATE": "editó la matriz de pagos",
  "SiigoProducto:SYNC": "sincronizó los productos de SIIGO",
  "SiigoImpuesto:SYNC": "sincronizó los impuestos de SIIGO",
  "SiigoFormaPago:SYNC": "sincronizó las formas de pago de SIIGO",
  "SiigoTipoComprobante:SYNC": "sincronizó los tipos de comprobante de SIIGO",
  "SiigoVendedor:SYNC": "sincronizó los vendedores de SIIGO",
  "SiigoProductoImpuesto:UPDATE": "asoció impuestos a un producto de SIIGO",
  "User:RESET_PASSWORD": "restableció la contraseña de un usuario",
};

/** Segundo intento: solo por acción (para entidades nuevas o no listadas). */
const ACCIONES_GENERICAS: Record<string, string> = {
  CREATE: "creó",
  CREAR: "creó",
  CREATE_TRAMITE: "creó el DO",
  CREAR_TRAMITE: "creó el DO",
  UPDATE: "editó",
  UPDATE_ESTADO: "cambió el estado de",
  CAMBIO_ESTADO: "cambió el estado de",
  DELETE: "eliminó",
  REPLACE: "reemplazó",
  REVOKE: "revocó",
  SYNC: "sincronizó",
  VERIFICAR: "verificó",
  APPROVE: "aprobó",
  FACTURAR: "marcó como facturado",
  DEVOLVER: "devolvió",
  REAPERTURA: "reabrió",
  ACTIVAR: "activó",
  DESACTIVAR: "desactivó",
  REACTIVAR: "reactivó",
  CREATE_PAGO: "registró un pago",
  CREATE_ANTICIPO: "registró un anticipo",
  APLICAR_ANTICIPO: "aplicó un anticipo",
  ELIMINAR_APLICACION_ANTICIPO: "quitó la aplicación de un anticipo",
  SET_CAPACIDAD_EMPRESA: "activó o desactivó una función de la empresa",
  RESET_CAPACIDAD_EMPRESA: "restableció una función de la empresa",
  RESET_PASSWORD: "restableció una contraseña",
  CAMBIAR_PASSWORD: "cambió su contraseña",
  PUBLICAR_TARIFARIO: "publicó un tarifario",
  DUPLICAR_TARIFARIO: "duplicó un tarifario",
  LIQUIDAR_COMISIONES: "facturó comisiones",
  DESHACER_LIQUIDACION: "deshizo una facturación de comisiones",
  COMPENSACION: "cruzó saldos de cuenta corriente",
  DESHACER_COMPENSACION: "deshizo un cruce de cuenta corriente",
  CONCILIAR_CARTERA: "concilió cartera",
  PROBAR_ROL_INICIO: "empezó a probar la plataforma con otro rol",
  PROBAR_ROL_FIN: "volvió a su rol de administradora",
};

/** Nombre legible de la entidad, para las acciones genéricas y el fallback. */
const ENTIDAD_LEGIBLE: Record<string, string> = {
  TramiteDO: "el DO",
  BorradorFactura: "un borrador de factura",
  LineaRevision: "una línea de borrador",
  Factura: "una factura",
  PagoFactura: "un pago de factura",
  ConciliacionBatchCartera: "un lote de cartera",
  Anticipo: "un anticipo",
  AplicacionAnticipo: "una aplicación de anticipo",
  PagoTramite: "un pago a proveedor",
  PagoTramiteGrupo: "un pago en bloque",
  FacturaProveedor: "una factura de proveedor",
  Beneficiario: "un beneficiario",
  MovimientoCuenta: "un movimiento de cuenta corriente",
  Documento: "un documento",
  DocumentoEnlace: "un enlace de documento",
  ChecklistItem: "un ítem del checklist",
  EmpresaCapacidad: "una función de la empresa",
  Parametro: "un parámetro",
  MatrizRecaudo: "la matriz de recaudo",
  MatrizPago: "la matriz de pagos",
  Tarifario: "un tarifario",
  Cliente: "una empresa",
  Notificacion: "un aviso",
  User: "un usuario",
};

/** "SET_CAPACIDAD_EMPRESA" → "Set capacidad empresa". */
function humanizarCodigo(codigo: string): string {
  const texto = codigo.replace(/_/g, " ").trim().toLowerCase();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : codigo;
}

/** "CARGA HISTÓRICA DE PLATA · VERDE" → "Carga histórica de plata · verde". */
function aOracion(texto: string): string {
  const minus = texto.trim().toLowerCase();
  return minus ? minus.charAt(0).toUpperCase() + minus.slice(1) : texto;
}

/**
 * Frase para la actividad, sin el nombre del usuario: "creó el DO",
 * "registró un anticipo", …  Orden: entidad+acción → acción+entidad legible →
 * nota escrita a mano por un script (acción con espacios) → fallback legible.
 */
export function describirActividad(row: { accion: string; entidad: string }): string {
  const porEntidad = ACTIVIDAD_POR_ENTIDAD[`${row.entidad}:${row.accion}`];
  if (porEntidad) return porEntidad;

  const generica = ACCIONES_GENERICAS[row.accion];
  const entidad = ENTIDAD_LEGIBLE[row.entidad];
  if (generica && entidad) {
    // "creó" + "un anticipo" → "creó un anticipo"; "cambió el estado de" + "el DO"
    return `${generica} ${entidad}`;
  }
  if (generica) return `${generica} ${humanizarCodigo(row.entidad).toLowerCase()}`;

  // Las cargas históricas escriben la acción como una nota ("CARGA HISTÓRICA
  // DE PLATA · VERDE"): se muestra como nota, no como código.
  if (/\s/.test(row.accion.trim())) return `registró «${aOracion(row.accion)}»`;

  const accion = humanizarCodigo(row.accion).toLowerCase();
  return entidad ? `${accion} · ${entidad}` : `${accion} · ${humanizarCodigo(row.entidad)}`;
}
