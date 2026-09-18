/**
 * Clasificador de documentos por nombre de archivo — función PURA, sin BD.
 *
 * Sale del análisis de los 2.662 archivos que el histórico de Litoplas dejó en
 * la categoría "Otro" (11.524 archivos en total, `historico-litoplas-2026/
 * manifiesto.csv`). Las reglas están ORDENADAS: lo específico primero, porque
 * varios nombres cumplen más de una (p. ej. "CERTIFICADO DE ORIGEN" es
 * DECLARACION_DIAN y no FICHA_TECNICA, aunque diga "CERTIFICADO").
 *
 * Cobertura medida sobre esos 2.662: 2.380 (89 %) quedan clasificados y 282
 * devuelven `null` (escaneos con nombre numérico y misceláneos) — esos se dejan
 * en OTRO para revisión manual o para un modelo pequeño más adelante.
 *
 * Detalle y decisión de Ernesto (2026-09-18) en `docs/CATALOGOS.md` §4 y en
 * `../litoplas-flujo-vs-plataforma.md` §10.
 */

import type { CategoriaDocumento } from "@prisma/client";

/** MAYÚSCULAS sin tildes: así están escritas todas las reglas. */
function normalizar(texto: string): string {
  return texto
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Quita la extensión final ("ACTA PREVIA I26.docx" → "ACTA PREVIA I26"). */
function sinExtension(nombre: string): string {
  return nombre.replace(/\.[^.]+$/, "");
}

type Regla =
  | { categoria: CategoriaDocumento; nombre: RegExp }
  | { categoria: CategoriaDocumento; extension: RegExp };

/**
 * ORDEN CRÍTICO. No reordenar sin volver a medir contra el manifiesto: cada
 * regla se escribió sabiendo qué absorbieron las anteriores.
 */
const REGLAS: readonly Regla[] = [
  // Fotos del reconocimiento (inspección física de la carga).
  { categoria: "FOTO_RECONOCIMIENTO", nombre: /FOTO|PICTURES/ },
  // Giros al exterior: SWIFT (y su errata "SWITF") y anticipos.
  { categoria: "COMPROBANTE_BANCARIO", nombre: /SWIFT|SWITF|ANTICIPO/ },
  // Pagos hechos en portales de comercio exterior (VUCE, licencias, Plan Vallejo).
  {
    categoria: "COMPROBANTE_COMERCIO",
    nombre: /SALDOS? REGISTRO|LICENCIA|^LIC-|REGISTRO (DE )?IMP|PLAN VALLEJO|REPOSICION|REPO-/,
  },
  // Transporte: carta de porte, HBL, booking.
  { categoria: "BL", nombre: /CARTA DE PORTE|\bHBL\b|BOOKING/ },
  { categoria: "PACKING_LIST", nombre: /PACKING|LISTA DE EMPAQU/ },
  // Todo lo aduanero: levante, DIM sueltas, planilla de envío, actas de previa
  // e inspección, certificado de origen/seguro, comodato, mandato, prórroga.
  {
    categoria: "DECLARACION_DIAN",
    nombre:
      /LEVANTAD|^DIM\s?\d|DIM#?\d|PLANILLAS? ?ENVIO|NO RECONOCIMIENTO|ACTA DE RECONOCIMIENTO|CERT.*ORIGEN|\bC\.?O\b|COMODATO|CERTIFICADO (DE )?SEGURO|POLIZA|MANDATO|ACTA PREVIA|ACTA I\d|ACTA DE INSPECCION|INSP(ECCION)? PREVIA|^PREVIA|DOC(UMENTOS)? SOPORTES? EN IB|DOCUMENTOS SOPORTE|EUR1|PRORROGA/,
  },
  // Orden de compra del cliente al proveedor y confirmaciones de pedido.
  {
    categoria: "ORDEN_COMPRA",
    nombre:
      /^PO[_ ]?OC|ORDEN DE COMPRA|ORDEN DE CONFIRMACION|ORDEN DE VENTA|^OC\d|COTIZACION|CONTRATO DE VENTA|PURCHASE ORDER/,
  },
  // Correos impresos, rastreos de courier, avisos de arribo.
  {
    categoria: "CORRESPONDENCIA",
    nombre:
      /OUTLOOK|BANDEJA DE ENTRADA|CORREO|^RE[_: ]|^RV[_: ]|^FW[_: ]|RESPUESTA|RASTREO|TRACKING|ARRIBO|NUEVA IMPORTACION|DEVOLUCION DE CONT|PROGRAMACION/,
  },
  // Un .eml/.msg siempre es un correo, se llame como se llame.
  { categoria: "CORRESPONDENCIA", extension: /^(eml|msg)$/ },
  // Control del trámite: relaciones y radicados a la agencia, check list,
  // Excel de trabajo (Moviaduanas/Siscomex), TRM y conversores.
  {
    categoria: "CONTROL_TRAMITE",
    nombre:
      /DOCUMENTOS PARA ACEPTACION|DODUCMENTOS|DOC(UMENTOS)? ENVIADOS|RELACION DE DOC|RADICADO|DOCUMENTOS ORIGINALES|DOCUMENTOS ENTREGADOS|CHECK ?LIST|EXCEL{1,2} ?MO?VIAD|MOVIADNS|MOVIAD|EXCEL MOV|SISCOMEX|^TRM\b|CONVERSOR|TIPOS DE CAMBIO|CAMBIO DE RUPIA|ARBOL DE DOC|FLETES|FLETE\b|CERTIFICACION DE GASTOS|DOCUMTS/,
  },
  // Documentación técnica del producto: análisis, composición, tratamiento,
  // hojas de seguridad, fichas técnicas, descripciones mínimas, partida.
  {
    categoria: "FICHA_TECNICA",
    nombre:
      /CERTIFICADOS? DE ANALISIS|COMPOSICION|TRATAMIENTO|HOJA DE SEGURIDAD|HOJA SEGUR|FICHA SEGURIDAD|FICHA DE SEGURIDAD|MSDS|\bSDS\b|FICHA TEC|FICAH TEC|\bFT[E]? |^FT\b|\bFS \d|HOJA DE DATOS|DATOS TECNICOS|DATASHEET|DESCRIP(CION|CIION|CIONES)?(ES)? ?MINIM|FORMATO DESCR|FORMATO DM|\bFDM\b|^DESCRIP|PARTIDA|CLASIFICACION|CLASIFCAC|ARANCEL|CATALOGO|KATALOG|CERTIFICACION PROVEEDOR|CERTIFICACION KAMPF|CERTIFICADO|CERTIFICATE|\bPDS\b|MANUAL|CARTA DE MEDIDAS|CARTA ORIGINAL DE ROLLOS|MEDIDAS DE ROLLOS|INFORMACION DE LA PIEZA|PIEZAS DETALLADAS|TERMORESISTENCIA|RESISTENCIA|TERMOSTATO|MODULO DE POTENCIA|GARANTIA/,
  },
];

/**
 * Último recurso: la carpeta de origen. Solo las tres subcarpetas reales que
 * usa Litoplas (el 97 % de los archivos está en la raíz del DO, sin carpeta).
 * No se usan patrones sueltos: el nombre de la carpeta del DO trae el nombre
 * del proveedor y produciría falsos positivos.
 */
const REGLAS_CARPETA: readonly { categoria: CategoriaDocumento; carpeta: RegExp }[] = [
  { categoria: "FOTO_RECONOCIMIENTO", carpeta: /FOTOS? (DE )?RECONOCIMIENTO/ },
  { categoria: "SOPORTE_FACTURACION", carpeta: /SOPORTES? (DE )?FACTURACION/ },
  { categoria: "CONTROL_TRAMITE", carpeta: /DOCUMENTOS MOVIADUANAS/ },
];

/**
 * Categoría sugerida para un archivo a partir de su nombre. `null` = ninguna
 * regla aplica (se queda en OTRO).
 *
 * @param nombre        Nombre del archivo con o sin extensión.
 * @param ext           Extensión sin punto ("pdf", "eml"). Se compara en minúsculas.
 * @param rutaRelativa  Ruta de origen, opcional. Solo se mira si el nombre no
 *                      alcanzó para decidir.
 */
export function clasificarPorNombre(
  nombre: string,
  ext: string,
  rutaRelativa?: string,
): CategoriaDocumento | null {
  const base = normalizar(sinExtension(nombre));
  const extension = ext.replace(/^\./, "").toLowerCase();

  for (const regla of REGLAS) {
    if ("extension" in regla) {
      if (regla.extension.test(extension)) return regla.categoria;
    } else if (regla.nombre.test(base)) {
      return regla.categoria;
    }
  }

  if (rutaRelativa) {
    // Solo la carpeta contenedora; el nombre del archivo ya se evaluó arriba.
    const carpeta = normalizar(rutaRelativa.replace(/\\/g, "/").split("/").slice(0, -1).join("/"));
    for (const regla of REGLAS_CARPETA) {
      if (regla.carpeta.test(carpeta)) return regla.categoria;
    }
  }

  return null;
}
