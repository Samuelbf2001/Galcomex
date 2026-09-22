/**
 * Histórico 2026 de TODOS los clientes (segunda entrega, 2026-09-21) — reglas
 * PURAS (sin disco, BD ni red) compartidas por `clasificar.ts`,
 * `clasificar-ia.ts` e `importar.ts`.
 *
 * En palabras simples: cada cliente ordena sus carpetas a su manera (Litoplas
 * por proveedor + IM + MOV, Coldex con su propio número entre paréntesis y el
 * cliente final, Sesderma por factura, Triplex por BL…). Aquí se decide, por
 * archivo, (1) a qué DO pertenece, (2) qué categoría le toca y (3) en qué
 * carpeta del bucket queda, CONSERVANDO las subcarpetas que el cliente ya usa:
 *
 *   tramites/<DO>/<CATEGORIA>/<subcarpetas del cliente>/<nombre original>
 *   clientes/<CLIENTE>/<ruta original>            (archivos fuera de un DO)
 *
 * Reutiliza las reglas de Litoplas (`../historico-litoplas/reglas.ts`) y el
 * clasificador por nombre de la app (`src/lib/documentos/clasificador-nombre.ts`).
 * Lo que ninguna regla resuelve queda en OTRO y lo decide la IA (`clasificar-ia.ts`).
 */

import { clasificarPorNombre } from "../../src/lib/documentos/clasificador-nombre";
import {
  carpetaDeConsecutivo,
  clasificar as clasificarLitoplas,
  nombreSeguro,
  parsearCarpetaDo,
  type Categoria as CategoriaLitoplas,
} from "../historico-litoplas/reglas";

/** Las 9 de Litoplas + las 4 que se agregaron el 2026-09-18 (`docs/CATALOGOS.md` §4). */
export type Categoria = CategoriaLitoplas | "CONTROL_TRAMITE" | "FICHA_TECNICA" | "CORRESPONDENCIA" | "ORDEN_COMPRA";

export type Accion = "SUBIR" | "SUBIR_SUELTO" | "DUPLICADO" | "DESCARTAR" | "OMITIR" | "YA_CARGADO";

/** Ciudades de la plataforma + BGT (Sesderma Bogotá; el enum `Ciudad` aún no la trae). */
export const RE_DO = /^DO\.? ?(BAQ|CTG|BUN|SMR|BGT)?(\d{2})-(\d{4}|0XXX)/i;

export type FilaManifiesto = {
  /** Carpeta raíz del cliente en la descarga (`COLDEX`, `POLYREC ZF`…). */
  cliente: string;
  /** Rama dentro del cliente (`AÑO 2026/NACIONALIZACION`, `IMPORTACIONES 2026/BOGOTA`…). */
  rama: string;
  carpetaDo: string;
  /** `DO.BAQ26-0107`; vacío si el archivo no está dentro de un DO o el DO es 0XXX. */
  consecutivo: string;
  ciudad: string;
  anio: number;
  numero: number;
  /** Lo que el cliente escribió después del consecutivo (IM, BL, FACT, NAC…). */
  referencia: string;
  im: string;
  mov: string;
  proveedor: string;
  oc: string;
  /** Subcarpetas dentro del DO (sin el archivo), separadas por `/`. */
  subcarpetas: string;
  /** Ruta relativa a la carpeta del cliente, con `/`. */
  rutaRelativa: string;
  nombre: string;
  ext: string;
  bytes: number;
  sha256: string;
  categoria: Categoria | "";
  regla: string;
  destinoKey: string;
  accion: Accion;
  nota: string;
};

// ─── Clientes ────────────────────────────────────────────────────────────────

export type ClienteCarpeta = {
  /** Texto que debe contener `cliente.nombre` en producción (ILIKE). */
  buscar: string;
  /** Nombre con el que se crearía si no existe. */
  nombre: string;
  agencia: "MOVIADUANAS" | "COLDEX";
  /** Es la agencia de aduanas actuando como cliente intermediario (sus DOs son de clientes finales). */
  intermediario?: boolean;
};

/** Carpeta de la descarga → empresa de la plataforma. */
export const CLIENTES: Record<string, ClienteCarpeta> = {
  LITOPLAS: { buscar: "LITOPLAS", nombre: "LITOPLAS SA", agencia: "MOVIADUANAS" },
  COLDEX: { buscar: "COLDEX", nombre: "AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS", agencia: "COLDEX", intermediario: true },
  "CW ASIA": { buscar: "CW ASIA", nombre: "CW ASIA SAS", agencia: "COLDEX" },
  "POLYREC SAS": { buscar: "POLYREC S.A.S", nombre: "POLYREC S.A.S.", agencia: "COLDEX" },
  "POLYREC ZF": { buscar: "POLYREC ZONA FRANCA", nombre: "POLYREC ZONA FRANCA S.A.S", agencia: "COLDEX" },
  SESDERMA: { buscar: "SESDERMA", nombre: "SESDERMA COLOMBIA S.A.", agencia: "COLDEX" },
  // Nombres y NITs tal como están en Siigo (consultados el 2026-09-21); Tapicero no aparece en Siigo.
  PIERCO: { buscar: "PIERCO", nombre: "PIERCO S.A.S.", agencia: "COLDEX" },
  ORTHOFRACT: { buscar: "ORTHOFRACT", nombre: "ORTHOFRACT SAS", agencia: "COLDEX" },
  "INVERSIONES TRIPLEX": { buscar: "TRIPLEX", nombre: "INVERSIONES TRIPLEX Y DECORACIONES S.A.S.", agencia: "COLDEX" },
  "INVERSIONES KASANA": { buscar: "INVERSIONES KASANA", nombre: "INVERSIONES KASANA SAS", agencia: "COLDEX" },
  "DISTRIBUIDORA EL TAPICERO": { buscar: "TAPICERO", nombre: "DISTRIBUIDORA EL TAPICERO S.A.S.", agencia: "COLDEX" },
};

// ─── Carpeta del DO ──────────────────────────────────────────────────────────

export type DatosCarpeta = {
  consecutivo: string;
  ciudad: string;
  anio: number;
  numero: number;
  referencia: string;
  im: string;
  mov: string;
  proveedor: string;
  oc: string;
};

/**
 * Descompone el nombre de la carpeta del DO. Litoplas conserva su parser
 * (IM/MOV/proveedor/OC); para los demás se guarda TODO lo que sigue al
 * consecutivo como `referencia` (BL, factura, número de Coldex, NAC…), que va
 * a `referenciaExterna` del trámite. `DO.26-` sin ciudad = Barranquilla.
 */
export function parsearCarpeta(cliente: string, nombreCarpeta: string): DatosCarpeta | null {
  const m = nombreCarpeta.match(RE_DO);
  if (!m) return null;
  const ciudad = (m[1] ?? "BAQ").toUpperCase();
  const anio = 2000 + Number(m[2]);
  const numero = /^\d{4}$/.test(m[3]) ? Number(m[3]) : 0;
  const consecutivo = numero > 0 ? `DO.${ciudad}${m[2]}-${m[3]}` : "";
  const referencia = nombreCarpeta.replace(RE_DO, "").replace(/^\s*[-–]?\s*/, "").replace(/\s+/g, " ").trim();

  if (cliente === "LITOPLAS") {
    const d = parsearCarpetaDo(nombreCarpeta, anio);
    if (d) return { consecutivo, ciudad, anio, numero, referencia, im: d.im, mov: d.mov, proveedor: d.proveedor, oc: d.oc };
  }
  const oc = nombreCarpeta.match(/\bOC\s?(\d{5})/i);
  return { consecutivo, ciudad, anio, numero, referencia, im: "", mov: "", proveedor: "", oc: oc ? `OC${oc[1]}` : "" };
}

// ─── Clasificación ───────────────────────────────────────────────────────────

function normalizar(texto: string): string {
  return texto.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Reglas por SUBCARPETA del cliente (última palabra antes de OTRO). Salen del
 * inventario de las 11 carpetas (2026-09-21). Solo se miran cuando el nombre
 * del archivo no alcanzó para decidir.
 */
const REGLAS_SUBCARPETA: readonly { categoria: Categoria; re: RegExp }[] = [
  { categoria: "FOTO_RECONOCIMIENTO", re: /FOTO|FOTOGRAFIC|ARCHIVO FOTOS|VACIADO/ },
  { categoria: "COMPROBANTE_BANCARIO", re: /^RECIBOS?$|^PAGOS? |^PAGOS?$|SWIFT|SIWFT|SOPORTES? DE FACTURACION PAGADAS/ },
  { categoria: "COMPROBANTE_COMERCIO", re: /\bROP\b|^REGISTROS?( |$|-)|^REGISTRO FACT|\bRIM\b|LICENCIA|REGISTRO DE IMP|REGISTRO COPAS/ },
  { categoria: "FACTURA_PROVEEDOR", re: /^FACTURAS (MSC|PUERTO)|FACTURAS PUERTO/ },
  { categoria: "FICHA_TECNICA", re: /CATALOGO|FICHAS? TEC|FORMATO DM|CLASIFICACION|NOTIF(ICA)?CIONES SANITARIAS|NSOC/ },
  { categoria: "CORRESPONDENCIA", re: /CORREO/ },
  { categoria: "CONTROL_TRAMITE", re: /PEDIDOS? ANTERIOR|PED ANTERIOR|PROCESO ANTERIOR|DOC PEDIDO|DOCMTS PEDS|CUMPLIDOS|COT\.|DOCUMENTOS (PARA |PLANILLA|ENVIADOS|ESTE DESPACHO|INSPECTOR)|DOCUMNTS PLANILLA|DCMTS PARA CREACION|DOCUMENTOS, FACT/ },
  {
    categoria: "DECLARACION_DIAN",
    re: /\bDIMS?\b|\bDIIM\b|\bDAVS?\b|MANDATO|PLANILLA|IMPECCION FISICA|INSPECCION FISICA|FISCALIZACION|\bNAC DO\.|CORRECCION BULTOS|FORMULARIOS DE SALIDA|ERROR EN TRANSMISION|ACTA DE RECONOCIMIENTO|LEVANTE|ESTADO 50|ESTAD 50/,
  },
];

/**
 * Reglas por NOMBRE que van ANTES de las de Litoplas: corrigen falsos positivos
 * conocidos (facturas de navieras/puertos que decían "FACTURA", el "ARBOL DE
 * DOC") y cubren los patrones de los otros clientes (puertos de Cartagena,
 * zona franca, ROP, EDI de la DIAN…). Salen de los 1.072 OTRO del primer
 * recorrido (2026-09-21).
 */
const REGLAS_NOMBRE_PREVIAS: readonly { categoria: Categoria; re: RegExp; regla: string }[] = [
  // Facturas de proveedores locales (navieras, puertos, transportadores, agencia).
  {
    categoria: "FACTURA_PROVEEDOR",
    re: /FACTURA (DE )?(MANEJO|FLETES?)|FACTURA (MSC|COREMAR|COMPAS|CONTECAR|SPRB|SPRC|ALMACARGA|DHL|FEDEX|UPS|COLDEX|GALCOMEX|ALONSO|ALG\d|MAERSK|HAPAG|CMA|EVERGREEN|COSCO|ONE\b|TRANSPORT|EXPRESS|LTRANS|ASCINTER)|^\d+ ?(ALMACENAJE|USO|VACIOS?|MOVILIZACION|CARGUE A CAMION|PESAJE|INSPECCION)\b|^ALMACENAJE HASTA|^gr_FLP\d|^FLP\d+_MSC|\bFLP\d{6}\b/i,
    regla: "factura de proveedor local (naviera/puerto/transporte)",
  },
  // Recibo Oficial de Pago (impuestos DIAN), instrucciones de pago, cartas a MinCIT, registros.
  {
    categoria: "COMPROBANTE_COMERCIO",
    re: /\bROP\b|RECIBO OFICIAL|INST(RUCCION|RUCCIONES)? DE PAGO|MCIT|MINCIT|^P(A)?GO? IMPUESTOS|^REGISTRO\b|CODIGOS REGISTROS|^BORRADOR REG\b/,
    regla: "ROP / impuestos / registro de importación / MinCIT",
  },
  // Zona franca y aduana: certificados de integración, FMM, preinspección, EDI de la DIAN, valoración.
  {
    categoria: "DECLARACION_DIAN",
    re: /CERT\S* INTEGRACION|\bFMM\b|PRE-?APROBADO|PREINSPECCION|^DOC(S|TS)? SOPORTES?\b|DCTS SOPORTE|DOCUMENTOS INSPECTOR|^DAVS?\d|^DIMS?\d|NO SE AUTORIZA|FORMULARIO (DE )?INGRESO|VALORACION POR PERITO/,
    regla: "documento aduanero / zona franca",
  },
  // Control del trámite: inventarios de ZF, documentos recibidos, datos de ingreso, paquetes de documentos.
  {
    categoria: "CONTROL_TRAMITE",
    re: /CONSULTA DE INVENTARIO|DOCUMENTOS RECIBIDOS|DATOS INGRESO|FORMATO INGRESO|^ARBOL DE DOC|^DOC$|^D(O)?C(TO)?S (BELLA|ENVIADOS)|^DOCUMENTOS (BELLA|COMPLETOS)/,
    regla: "control del trámite",
  },
  // Notas y facturas de conciliación del cliente (PZFN = Polyrec ZF, FN = Polyrec).
  { categoria: "SOPORTE_FACTURACION", re: /^PZFN[ -]?\d|^FN-?\d{3,}|CONCILIACION/, regla: "nota/factura de conciliación" },
  // Conceptos técnicos, circulares regulatorias y certificados del producto (MinJusticia cosméticos, ANLA, NSOC, MTC).
  {
    categoria: "FICHA_TECNICA",
    re: /\bMJD-|CIRCULAR N|CONCPT TECNC|CONCEPTO TECNICO|\bANLA\b|\bNSOC\b|SPECIFICATION SHEET|^MTC\b|MILL TEST|CERTIF\S* GENOX|^CERTIF\b/,
    regla: "concepto/circular/certificado técnico del producto",
  },
  { categoria: "COMPROBANTE_COMERCIO", re: /PAGO ?PSE|COMPROBANTE_PAGO/, regla: "comprobante PSE" },
  { categoria: "COMPROBANTE_BANCARIO", re: /^PAGO (DE |A )?[A-Z]|^COMPROBANTE (DE )?PAGO|^SOPORTE (DE )?PAGO|TRANSFERENCIA/, regla: "pago / comprobante bancario" },
  { categoria: "FACTURA_PROVEEDOR", re: /SERVICIO A LA CARGA|^\d{6,} (SERVICIO|ALMACENAJE|USO|VACIO)/, regla: "factura de puerto" },
  { categoria: "PACKING_LIST", re: /^PL\b(?! ?\d)|^PL DETALLADA|PACKING/, regla: "packing list" },
  { categoria: "FACTURA_COMERCIAL", re: /^CI \+ PL|^CI\b|COMMERCIAL INVOICE/, regla: "factura comercial" },
  { categoria: "DECLARACION_DIAN", re: /^INSURANCE|\bPOLIZA\b|CERTIFICADO DE SEGURO/, regla: "póliza / seguro" },
  { categoria: "BL", re: /CLEARANCE DOC|LOADING INFO|\bMBL\b|\bHBL\b/, regla: "documento de embarque" },
  { categoria: "CORRESPONDENCIA", re: /ARRIVAL ?NOTICE|AVISO DE LLEGADA/, regla: "aviso de arribo" },
  { categoria: "ORDEN_COMPRA", re: /^PEDIDO \d|^ORDEN OC\d|COTIZ(ACION|CN)/, regla: "pedido / orden / cotización" },
  { categoria: "BL", re: /SHIPPING DO[CX]|LIBERACION|TELEX RELEASE|_HBL\b|\bHBL_/, regla: "documentos de embarque / liberación" },
];

/**
 * Categoría de un archivo. Orden:
 *   0. correcciones y patrones nuevos por nombre (REGLAS_NOMBRE_PREVIAS) y extensión EDI;
 *   1. reglas de Litoplas (subcarpeta FOTOS/MOVIADUANAS/SOPORTES manda; luego nombre);
 *   2. clasificador por nombre de la app (las 4 categorías nuevas y lo aduanero suelto);
 *   3. subcarpeta del cliente;
 *   4. OTRO → lo decide la IA.
 */
export function clasificarArchivo(subcarpetas: string[], nombre: string, ext: string): { categoria: Categoria; regla: string } {
  const N = normalizar(nombre.replace(/\.[^.]+$/, ""));
  const enSubcarpetaFacturas = subcarpetas.some((s) => /^FACTURAS (MSC|PUERTO)/.test(normalizar(s)));
  if (enSubcarpetaFacturas) return { categoria: "FACTURA_PROVEEDOR", regla: "subcarpeta FACTURAS <proveedor>" };
  for (const regla of REGLAS_NOMBRE_PREVIAS) {
    if (regla.re.test(N)) return { categoria: regla.categoria, regla: regla.regla };
  }
  if (ext === "edi") return { categoria: "DECLARACION_DIAN", regla: "archivo EDI de la DIAN" };

  const r1 = clasificarLitoplas(subcarpetas, nombre);
  if (r1.categoria !== "OTRO") return r1;

  const r2 = clasificarPorNombre(nombre, ext, [...subcarpetas, nombre].join("/"));
  if (r2 && r2 !== "OTRO") return { categoria: r2 as Categoria, regla: "clasificarPorNombre" };

  for (const s of subcarpetas) {
    const S = normalizar(s);
    for (const regla of REGLAS_SUBCARPETA) {
      if (regla.re.test(S)) return { categoria: regla.categoria, regla: `subcarpeta "${s}"` };
    }
  }
  return { categoria: "OTRO", regla: "sin regla" };
}

// ─── Claves del bucket ───────────────────────────────────────────────────────

/** Segmento apto para clave (sin barras ni caracteres de control, espacios colapsados). */
export function segmentoSeguro(s: string): string {
  return nombreSeguro(s);
}

/**
 * `tramites/<DO>/<CATEGORIA>/<sub1>/<sub2>/<nombre>` — las subcarpetas del
 * cliente se conservan debajo de la categoría. Sufijo ` (n)` si el nombre ya
 * se usó en esa misma carpeta.
 */
export function claveTramite(consecutivo: string, categoria: string, subcarpetas: string[], nombre: string, usados: Set<string>): string {
  const carpeta = carpetaDeConsecutivo(consecutivo);
  const subs = subcarpetas.map(segmentoSeguro).filter(Boolean);
  const original = segmentoSeguro(nombre);
  const punto = original.lastIndexOf(".");
  const base = punto > 0 ? original.slice(0, punto) : original;
  const extN = punto > 0 ? original.slice(punto) : "";
  const prefijo = ["tramites", carpeta, categoria, ...subs].join("/");
  let key = `${prefijo}/${original}`;
  let n = 2;
  while (usados.has(key.toLowerCase())) {
    key = `${prefijo}/${base} (${n})${extN}`;
    n += 1;
  }
  usados.add(key.toLowerCase());
  return key;
}

/** `clientes/<CLIENTE>/<ruta original>` para lo que está fuera de un DO. */
export function claveSuelta(cliente: string, rutaRelativa: string): string {
  const partes = rutaRelativa.split("/").map(segmentoSeguro).filter(Boolean);
  return ["clientes", carpetaDeConsecutivo(cliente), ...partes].join("/");
}

/** Rama = carpetas entre el cliente y el DO (o hasta el archivo si no hay DO). */
export function ramaDe(segmentos: string[], idxDo: number): string {
  const fin = idxDo >= 0 ? idxDo : segmentos.length - 1;
  return segmentos.slice(0, fin).join("/");
}

/** Extensiones que no aportan nada (basura de sistema). */
export function esBasuraExtra(nombre: string): string | null {
  const n = nombre.toLowerCase();
  if (n.endsWith(".lnk")) return "acceso directo de Windows";
  if (n.endsWith(".db")) return "archivo de sistema";
  return null;
}
