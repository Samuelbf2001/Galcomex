/**
 * Plantillas de tarifario — Galcomex (M2)
 *
 * Datos, no código: las tres propuestas comerciales 2026 que Guillermo firmó,
 * transcritas ítem por ítem, y la lista de conceptos de venta que se cruzó con
 * los productos Siigo que Camila mostró en la reunión (min 30:27 a 33:53).
 *
 * Sirven para (a) arrancar el tarifario de una empresa desde la ficha con un
 * clic y (b) el script de demo. Ninguna regla de precio vive fuera de aquí y
 * de la BD.
 *
 * Fuentes:
 *   · "TARIFAS GALCOMEX 2026 IMPO - EXPO.pdf"  → LITOPLAS S.A., 2-feb-2026 a 31-ene-2027
 *   · "TARIFAS GALCOMEX 2026.pdf"              → CW ASIA SAS, 11-mar-2026, IPC 5,29 %
 */

import type { TarifaItemInput } from "@/lib/validations/tarifas";

export type PlantillaTarifario = {
  codigo: string;
  /** Empresa cuya propuesta es esta plantilla (para el select "Arrancar desde", B2). */
  cliente: string;
  nombre: string;
  descripcion: string;
  alcance: "TRAMITE" | "CLASIFICACION" | "PLAN_VALLEJO" | "EXPORTACION" | "OTROS";
  fuente: string;
  items: TarifaItemInput[];
};

/**
 * Conceptos de venta cruzados con el catálogo REAL de productos Siigo que ya
 * está sincronizado en producción (83 productos, 14-sep-2026). Decisión de la
 * reunión del 10-sep (min 03:46): el nombre del concepto en la plataforma y
 * en la factura Siigo debe ser el mismo. Los marcados con `confirmar` no
 * tienen producto exacto en Siigo: se llevan al más cercano hasta que el
 * contador cree uno o Camila diga cuál usar.
 */
export const CONCEPTOS_VENTA_DEMO: {
  concepto: string;
  siigoCodigo: string;
  nombreSiigo: string;
  tipoCobro: "Fijo" | "Por unidad" | "Calculado" | "Circunstancial";
  iva: boolean;
  confirmar?: boolean;
}[] = [
  { concepto: "GASTOS_TRAMITE", siigoCodigo: "005", nombreSiigo: "GASTOS OPERATIVOS", tipoCobro: "Fijo", iva: true },
  { concepto: "SISTEMATIZACION", siigoCodigo: "004", nombreSiigo: "SISTEMATIZACIÓN", tipoCobro: "Fijo", iva: true },
  { concepto: "DOCUMENTACION", siigoCodigo: "002", nombreSiigo: "DOCUMENTACIÓN", tipoCobro: "Por unidad", iva: true },
  { concepto: "DOCUMENTOS_DESPACHO", siigoCodigo: "006", nombreSiigo: "LOGÍSTICA DE SUPERVISIÓN Y DESPACHO", tipoCobro: "Fijo", iva: true, confirmar: true },
  { concepto: "PAPELERIA", siigoCodigo: "003", nombreSiigo: "PAPELERÍA", tipoCobro: "Fijo", iva: true },
  { concepto: "REVISION_DESPACHO", siigoCodigo: "022", nombreSiigo: "LOGÍSTICA DE REVISIÓN", tipoCobro: "Circunstancial", iva: true },
  { concepto: "ENTREGA_DIRECTA", siigoCodigo: "007", nombreSiigo: "SERVICIO LOGÍSTICO", tipoCobro: "Circunstancial", iva: true, confirmar: true },
  { concepto: "ELABORACION_REGISTRO", siigoCodigo: "010", nombreSiigo: "ELABORACION REG IMP", tipoCobro: "Circunstancial", iva: true },
  { concepto: "MODIFICACION_REGISTRO", siigoCodigo: "010", nombreSiigo: "ELABORACION REG IMP", tipoCobro: "Circunstancial", iva: true, confirmar: true },
  { concepto: "CLASIFICACION", siigoCodigo: "015", nombreSiigo: "CLASIFICACIÓN PARTIDA ARANCELARIA", tipoCobro: "Por unidad", iva: true },
  { concepto: "SERVICIO_UNICO", siigoCodigo: "007", nombreSiigo: "SERVICIO LOGÍSTICO", tipoCobro: "Calculado", iva: true },
  { concepto: "DESPACHO_PARCIAL", siigoCodigo: "005", nombreSiigo: "GASTOS OPERATIVOS", tipoCobro: "Circunstancial", iva: true, confirmar: true },
  { concepto: "INGRESO_ZF", siigoCodigo: "007", nombreSiigo: "SERVICIO LOGÍSTICO", tipoCobro: "Circunstancial", iva: true, confirmar: true },
  { concepto: "ZONA_SECUNDARIA", siigoCodigo: "016", nombreSiigo: "ZONA SECUNDARIA", tipoCobro: "Circunstancial", iva: true },
  { concepto: "PAGO_REGISTRO", siigoCodigo: "24", nombreSiigo: "PAGO VUCE REG IMP", tipoCobro: "Calculado", iva: false },
  { concepto: "TRASLADO_ZF", siigoCodigo: "013", nombreSiigo: "LOGÍSTICA DE TRANSPORTE", tipoCobro: "Por unidad", iva: true, confirmar: true },
  { concepto: "PLAN_VALLEJO", siigoCodigo: "014", nombreSiigo: "PROGRAMA PLAN VALLEJO", tipoCobro: "Fijo", iva: true },
  { concepto: "SELLOS", siigoCodigo: "12", nombreSiigo: "SELLOS DE SEGURIDAD", tipoCobro: "Por unidad", iva: false },
];

function siigoDe(concepto: string): string | null {
  return CONCEPTOS_VENTA_DEMO.find((c) => c.concepto === concepto)?.siigoCodigo ?? null;
}

function item(parcial: Partial<TarifaItemInput> & Pick<TarifaItemInput, "concepto" | "nombrePublico" | "tipoCalculo">): TarifaItemInput {
  return {
    siigoCodigo: siigoDe(parcial.concepto),
    disparador: "SIEMPRE",
    eventoCodigo: null,
    unidad: "TRAMITE",
    valor: 0n,
    valorAdicional: null,
    porcentajeBps: null,
    minimos: null,
    conceptoCosto: null,
    tramos: null,
    aplicaIva: true,
    notas: null,
    orden: 0,
    ...parcial,
  };
}

/** LITOPLAS S.A. — importaciones y exportaciones aéreas y marítimas por BAQ y CTG. */
export const PLANTILLA_LITOPLAS_IMPO: PlantillaTarifario = {
  codigo: "LITOPLAS_IMPO_2026",
  cliente: "Litoplas",
  nombre: "Tarifas 2026 importaciones",
  descripcion: "Propuesta Litoplas 2-feb-2026 → 31-ene-2027: gastos fijos por embarque, documentación por declaración y los circunstanciales (revisión, entrega directa, registro).",
  alcance: "TRAMITE",
  fuente: "TARIFAS GALCOMEX 2026 IMPO - EXPO.pdf (pág. 1)",
  items: [
    item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por embarque", tipoCalculo: "FIJO", valor: 100_000n, orden: 10 }),
    item({ concepto: "REVISION_DESPACHO", nombrePublico: "Servicios logísticos de revisión e inventario en despacho", tipoCalculo: "FIJO", valor: 180_000n, disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 20 }),
    item({ concepto: "ENTREGA_DIRECTA", nombrePublico: "Servicios logísticos de despacho entrega directa", tipoCalculo: "FIJO", valor: 200_000n, disparador: "EVENTO", eventoCodigo: "ENTREGA_DIRECTA", orden: 30 }),
    item({ concepto: "SISTEMATIZACION", nombrePublico: "Sistematización", tipoCalculo: "FIJO", valor: 20_000n, orden: 40 }),
    item({ concepto: "DOCUMENTACION", nombrePublico: "Documentación", tipoCalculo: "POR_UNIDAD", unidad: "DECLARACION", valor: 10_000n, orden: 50 }),
    item({ concepto: "DOCUMENTOS_DESPACHO", nombrePublico: "Documentos de despacho", tipoCalculo: "FIJO", valor: 20_000n, orden: 60 }),
    item({ concepto: "PAPELERIA", nombrePublico: "Papelería", tipoCalculo: "FIJO", valor: 10_000n, orden: 70 }),
    item({ concepto: "ELABORACION_REGISTRO", nombrePublico: "Elaboración de registro de importación", tipoCalculo: "FIJO", valor: 433_000n, disparador: "EVENTO", eventoCodigo: "ELABORACION_REGISTRO", orden: 80 }),
  ],
};

/** LITOPLAS S.A. — clasificación arancelaria, se factura aparte (tipo de trámite CLASIFICACION). */
export const PLANTILLA_LITOPLAS_CLASIFICACION: PlantillaTarifario = {
  codigo: "LITOPLAS_CLAS_2026",
  cliente: "Litoplas",
  nombre: "Tarifas 2026 clasificación arancelaria",
  descripcion: "380.000 + IVA el primer ítem y 180.000 + IVA cada ítem adicional del mismo informe.",
  alcance: "CLASIFICACION",
  fuente: "TARIFAS GALCOMEX 2026 IMPO - EXPO.pdf (pág. 1)",
  items: [
    item({ concepto: "CLASIFICACION", nombrePublico: "Clasificación arancelaria", tipoCalculo: "PRIMERO_MAS_ADICIONAL", unidad: "ITEM", valor: 380_000n, valorAdicional: 180_000n, orden: 10 }),
  ],
};

/** LITOPLAS S.A. — exportaciones terrestres a Venezuela. */
export const PLANTILLA_LITOPLAS_EXPO: PlantillaTarifario = {
  codigo: "LITOPLAS_EXPO_2026",
  cliente: "Litoplas",
  nombre: "Tarifas 2026 exportaciones terrestres",
  descripcion: "Propuesta Litoplas para exportaciones terrestres a Venezuela, misma vigencia.",
  alcance: "EXPORTACION",
  fuente: "TARIFAS GALCOMEX 2026 IMPO - EXPO.pdf (pág. 2)",
  items: [
    item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por embarque", tipoCalculo: "FIJO", valor: 100_000n, orden: 10 }),
    item({ concepto: "REVISION_DESPACHO", nombrePublico: "Servicios logísticos de revisión e inventario en despacho", tipoCalculo: "FIJO", valor: 200_000n, disparador: "EVENTO", eventoCodigo: "REVISION_DESPACHO", orden: 20 }),
    item({ concepto: "SISTEMATIZACION", nombrePublico: "Sistematización", tipoCalculo: "FIJO", valor: 20_000n, orden: 30 }),
    item({ concepto: "DOCUMENTACION", nombrePublico: "Documentación", tipoCalculo: "FIJO", valor: 20_000n, orden: 40 }),
    item({ concepto: "DOCUMENTOS_DESPACHO", nombrePublico: "Documentos de despacho", tipoCalculo: "FIJO", valor: 20_000n, orden: 50 }),
    item({ concepto: "PAPELERIA", nombrePublico: "Papelería", tipoCalculo: "FIJO", valor: 30_000n, orden: 60 }),
    item({ concepto: "ZONA_SECUNDARIA", nombrePublico: "Zona secundaria (inicial y renovación mensual)", tipoCalculo: "POR_UNIDAD", unidad: "MES", valor: 350_000n, disparador: "EVENTO", eventoCodigo: "ZONA_SECUNDARIA", orden: 70 }),
  ],
};

/** CW ASIA SAS — tarifa única sobre el valor en aduana con mínimos por tipo de carga. */
export const PLANTILLA_CW_ASIA: PlantillaTarifario = {
  codigo: "CW_ASIA_2026",
  cliente: "CW Asia",
  nombre: "Tarifas 2026 (IPC 5,29 %)",
  descripcion: "Propuesta CW ASIA 11-mar-2026: 0,37 % sobre el valor en aduana con mínimos (suelta 370.000 · 20′ 498.000 · 40′/HQ 554.000), gastos por contenedor y circunstanciales.",
  alcance: "TRAMITE",
  fuente: "TARIFAS GALCOMEX 2026.pdf",
  items: [
    item({
      concepto: "SERVICIO_UNICO",
      nombrePublico: "Tarifa única de servicio (0,37 % sobre el valor en aduana)",
      tipoCalculo: "PORCENTAJE_MIN",
      porcentajeBps: 37,
      minimos: { SUELTA: "370000", CONTENEDOR_20: "498000", CONTENEDOR_40: "554000" },
      orden: 10,
    }),
    item({ concepto: "ELABORACION_REGISTRO", nombrePublico: "Elaboración registro de importación en VUCE (mínimo)", tipoCalculo: "FIJO", valor: 280_000n, disparador: "EVENTO", eventoCodigo: "ELABORACION_REGISTRO", orden: 20 }),
    item({ concepto: "MODIFICACION_REGISTRO", nombrePublico: "Modificación de registro de importación", tipoCalculo: "POR_UNIDAD", valor: 100_000n, disparador: "EVENTO", eventoCodigo: "MODIFICACION_REGISTRO", orden: 30 }),
    item({ concepto: "GASTOS_TRAMITE", nombrePublico: "Gastos de trámite por contenedor", tipoCalculo: "POR_UNIDAD", unidad: "CONTENEDOR", valor: 100_000n, orden: 40 }),
    item({ concepto: "DESPACHO_PARCIAL", nombrePublico: "Gastos de trámite por despacho parcial", tipoCalculo: "POR_UNIDAD", valor: 50_000n, disparador: "EVENTO", eventoCodigo: "DESPACHO_PARCIAL", orden: 50 }),
    item({ concepto: "SISTEMATIZACION", nombrePublico: "Sistematización de archivos", tipoCalculo: "FIJO", valor: 30_000n, orden: 60 }),
    item({ concepto: "DOCUMENTACION", nombrePublico: "Revisión y clasificación documental por archivo", tipoCalculo: "POR_UNIDAD", unidad: "DOCUMENTO", valor: 20_000n, orden: 70 }),
    item({ concepto: "INGRESO_ZF", nombrePublico: "Servicio trámite de ingreso ZF por contenedor", tipoCalculo: "POR_UNIDAD", valor: 166_000n, disparador: "EVENTO", eventoCodigo: "INGRESO_ZF", orden: 80 }),
    item({ concepto: "PAGO_REGISTRO", nombrePublico: "Pago del registro de importación (VUCE)", tipoCalculo: "ESPEJO_DE_COSTO", conceptoCosto: "registro", aplicaIva: false, orden: 90 }),
  ],
};

/**
 * POLYREC ZONA FRANCA S.A.S — traslados de contenedores (reunión 10-sep-2026,
 * min 83:31): "si es un contenedor son 300; si son dos o más, 250 cada
 * contenedor". Sin carpeta de documentos: solo la factura. La nacionalización
 * de Polyrec S.A.S. es otro tarifario que Camila aún no ha dictado.
 */
export const PLANTILLA_POLYREC_ZF: PlantillaTarifario = {
  codigo: "POLYREC_ZF_2026",
  cliente: "Polyrec Zona Franca",
  nombre: "Traslados zona franca 2026",
  descripcion: "Traslado de contenedores en zona franca: 300.000 si es un contenedor; 250.000 por contenedor si son dos o más.",
  alcance: "TRAMITE",
  fuente: "Reunión 10-sep-2026 (Camila, min 83:31). Sin propuesta escrita: confirmar valores.",
  items: [
    item({
      concepto: "TRASLADO_ZF",
      nombrePublico: "Traslado de contenedor en zona franca",
      tipoCalculo: "POR_TRAMO",
      unidad: "CONTENEDOR",
      tramos: [
        { hasta: 1, valor: "300000" },
        { hasta: null, valor: "250000" },
      ],
      orden: 10,
    }),
  ],
};

export const PLANTILLAS_TARIFARIO: PlantillaTarifario[] = [
  PLANTILLA_LITOPLAS_IMPO,
  PLANTILLA_LITOPLAS_CLASIFICACION,
  PLANTILLA_LITOPLAS_EXPO,
  PLANTILLA_CW_ASIA,
  PLANTILLA_POLYREC_ZF,
];

export function plantillaPorCodigo(codigo: string): PlantillaTarifario | null {
  return PLANTILLAS_TARIFARIO.find((p) => p.codigo === codigo) ?? null;
}
