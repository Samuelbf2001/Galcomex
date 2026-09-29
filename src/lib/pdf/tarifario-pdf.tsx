/**
 * PDF del tarifario — la propuesta comercial que Guillermo manda por correo,
 * generada desde los datos (M2). Reproduce la forma del Word:
 * membrete, "REF: COTIZACIÓN SERVICIOS DE ASESORÍA Y LOGÍSTICA…", vigencia,
 * lista de ítems con su valor y la nota de pagos a terceros.
 *
 * Usa @react-pdf/renderer, igual que `estado-cuenta-pdf.tsx`.
 */

import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import React from "react";

export type TarifaItemPdfDto = {
  nombrePublico: string;
  tipoCalculo: "FIJO" | "POR_UNIDAD" | "PORCENTAJE_MIN" | "PRIMERO_MAS_ADICIONAL" | "ESPEJO_DE_COSTO" | "POR_TRAMO";
  disparador: "SIEMPRE" | "EVENTO" | "MANUAL";
  unidad: "TRAMITE" | "CONTENEDOR" | "DECLARACION" | "DOCUMENTO" | "ITEM" | "MES";
  valor: bigint;
  valorAdicional: bigint | null;
  porcentajeBps: number | null;
  minimos: { SUELTA?: string; CONTENEDOR_20?: string; CONTENEDOR_40?: string } | null;
  conceptoCosto: string | null;
  tramos: { hasta: number | null; valor: string }[] | null;
  aplicaIva: boolean;
  notas: string | null;
  /** B1 (Diseño A) — resta el agenciamiento estándar de la agencia del DO. */
  restaAgenciamiento: boolean;
  /**
   * B1 (Diseño A) — solo con `restaAgenciamiento` y mínimo: si el mínimo
   * configurado es lo que paga el cliente en TOTAL (Galcomex + agencia,
   * `true`) o lo que cobra Galcomex en NETO (`false`, default). BAJO 3
   * (revisión de código, 28-sep-2026): distingue la nota del PDF.
   */
  minimoEsDelTotal: boolean;
};

export type TarifarioPdfDto = {
  empresaNombre: string;
  empresaNit: string;
  /** Ciudad de la empresa; se omite la línea si no está (B3, 22-sep). */
  empresaCiudad: string | null;
  contactoNombre: string | null;
  nombre: string;
  alcance: string;
  version: number;
  estado: string;
  vigenteDesde: Date;
  vigenteHasta: Date;
  fechaEmision: Date;
  items: TarifaItemPdfDto[];
  /** B3 (Diseño A) — ciudades a las que aplica; vacío = general (todas). */
  ciudades: string[];
};

const CIUDAD_PDF_TXT: Record<string, string> = {
  BAQ: "Barranquilla",
  CTG: "Cartagena",
  BUN: "Buenaventura",
  SMR: "Santa Marta",
  BGT: "Bogotá",
};

const ALCANCE_REF: Record<string, string> = {
  TRAMITE: "PARA IMPORTACIONES",
  CLASIFICACION: "PARA CLASIFICACIÓN ARANCELARIA",
  PLAN_VALLEJO: "PARA PLAN VALLEJO",
  EXPORTACION: "PARA EXPORTACIONES",
  OTROS: "PARA OTROS SERVICIOS",
};

const UNIDAD_PLURAL_TXT: Record<TarifaItemPdfDto["unidad"], string> = {
  TRAMITE: "trámites",
  CONTENEDOR: "contenedores",
  DECLARACION: "declaraciones",
  DOCUMENTO: "documentos",
  ITEM: "ítems",
  MES: "meses",
};

const UNIDAD_TXT: Record<TarifaItemPdfDto["unidad"], string> = {
  TRAMITE: "trámite",
  CONTENEDOR: "contenedor",
  DECLARACION: "declaración",
  DOCUMENTO: "documento",
  ITEM: "ítem",
  MES: "mes",
};

const CARGA_TXT: Record<string, string> = {
  SUELTA: "carga suelta",
  CONTENEDOR_20: "contenedor de 20",
  CONTENEDOR_40: "contenedor de 40 o HQ",
};

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function formatCOPTarifa(valor: bigint): string {
  return `${valor.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},00`;
}

function fechaLarga(d: Date): string {
  return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

function fechaCarta(d: Date): string {
  return `${MESES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} de ${d.getUTCFullYear()}`;
}

/** La línea de ciudad del bloque "Señores" se omite si la empresa no la tiene (B3). */
export function debeImprimirCiudad(ciudad: string | null): boolean {
  return Boolean(ciudad && ciudad.trim());
}

/** Filas de texto (concepto → valor) como en la propuesta. Un ítem puede dar varias. */
export function filasDeItem(item: TarifaItemPdfDto): { concepto: string; valor: string }[] {
  const iva = item.aplicaIva ? "" : "";
  switch (item.tipoCalculo) {
    case "FIJO":
      return [{ concepto: item.nombrePublico, valor: formatCOPTarifa(item.valor) + iva }];
    case "POR_UNIDAD":
      return [{ concepto: `${item.nombrePublico} (por ${UNIDAD_TXT[item.unidad]})`, valor: formatCOPTarifa(item.valor) }];
    case "PORCENTAJE_MIN": {
      const pct = ((item.porcentajeBps ?? 0) / 100).toFixed(2).replace(".", ",");
      const filas = [{ concepto: `${item.nombrePublico}`, valor: `${pct} % sobre el valor en Aduana` }];
      for (const [k, v] of Object.entries(item.minimos ?? {})) {
        if (v) filas.push({ concepto: `Tarifa mínima por ${CARGA_TXT[k] ?? k.toLowerCase()}`, valor: formatCOPTarifa(BigInt(v)) });
      }
      return filas;
    }
    case "PRIMERO_MAS_ADICIONAL":
      return [
        { concepto: item.nombrePublico, valor: `${formatCOPTarifa(item.valor)}${item.aplicaIva ? " + IVA" : ""}` },
        { concepto: `${item.nombrePublico} por ${UNIDAD_TXT[item.unidad]} adicional`, valor: `${formatCOPTarifa(item.valorAdicional ?? item.valor)}${item.aplicaIva ? " + IVA" : ""}` },
      ];
    case "ESPEJO_DE_COSTO":
      return [{ concepto: item.nombrePublico, valor: "Al costo, con soporte" }];
    case "POR_TRAMO": {
      const tramos = [...(item.tramos ?? [])].sort((a, b) => (a.hasta ?? Infinity) - (b.hasta ?? Infinity));
      const plural = UNIDAD_PLURAL_TXT[item.unidad];
      return tramos.map((t, i) => {
        const anterior = i > 0 ? tramos[i - 1]!.hasta ?? 0 : 0;
        const rango =
          t.hasta === null
            ? `${anterior + 1} o más ${plural}`
            : t.hasta === 1
              ? `1 ${UNIDAD_TXT[item.unidad]}`
              : `de ${anterior + 1} a ${t.hasta} ${plural}`;
        return { concepto: `${item.nombrePublico} (${rango}, por ${UNIDAD_TXT[item.unidad]})`, valor: `${formatCOPTarifa(BigInt(t.valor))}${item.aplicaIva ? " + IVA" : ""}` };
      });
    }
  }
}

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 60, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  membrete: { alignItems: "center", marginBottom: 18 },
  empresa: { fontFamily: "Helvetica-Bold", fontSize: 13 },
  empresaSub: { fontSize: 7.5, color: "#475569", marginTop: 1 },
  fecha: { marginTop: 14, marginBottom: 12 },
  destinatario: { marginBottom: 12, lineHeight: 1.4 },
  bold: { fontFamily: "Helvetica-Bold" },
  ref: { fontFamily: "Helvetica-Bold", marginBottom: 10, lineHeight: 1.4 },
  parrafo: { lineHeight: 1.45, marginBottom: 10, textAlign: "justify" },
  fila: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: "#e2e8f0" },
  filaConcepto: { flex: 1, paddingRight: 12 },
  filaValor: { width: 150, textAlign: "right", fontFamily: "Helvetica-Bold" },
  seccion: { fontFamily: "Helvetica-Bold", fontSize: 8.5, color: "#475569", marginTop: 10, marginBottom: 3, textTransform: "uppercase" },
  nota: { fontSize: 8.5, color: "#475569", lineHeight: 1.4, marginTop: 10, textAlign: "justify" },
  firma: { marginTop: 26 },
  pie: { position: "absolute", bottom: 28, left: 60, right: 60, borderTopWidth: 0.5, borderTopColor: "#cbd5e1", paddingTop: 4, fontSize: 7, color: "#64748b", flexDirection: "row", justifyContent: "space-between" },
});

/**
 * Nota de resta de agenciamiento para UN ítem (B1, Diseño A). Sin número
 * (Camila cambia el agenciamiento en Parámetros sin tener que reimprimir la
 * propuesta). BAJO 3 (revisión de código, 28-sep-2026): en modo NETO el
 * "Tarifa mínima" que imprime la tabla (p. ej. 305.000, `filasDeItem`) YA es
 * lo que cobra Galcomex, con la agencia restada — decir "menos el
 * agenciamiento" ahí se lee como una resta pendiente (un cliente podría leer
 * "mínimo 305.000 menos agenciamiento" = 160.000). En modo TOTAL el mínimo
 * impreso SÍ es el total (Galcomex + agencia): ahí la resta sigue siendo
 * correcta tal como estaba. Solo PORCENTAJE_MIN imprime un "Tarifa mínima" en
 * la tabla; las demás formas de cálculo muestran su valor por unidad/fijo tal
 * cual, así que ahí la nota genérica sigue aplicando.
 */
export function notaAgenciamientoDeItem(item: TarifaItemPdfDto): string {
  return item.tipoCalculo === "PORCENTAJE_MIN" && !item.minimoEsDelTotal
    ? `${item.nombrePublico}: el mínimo es después de restar el agenciamiento que la agencia de aduanas le factura directamente.`
    : `${item.nombrePublico}: menos el agenciamiento que la agencia de aduanas le factura directamente.`;
}

export function TarifarioPDF({ data }: { data: TarifarioPdfDto }) {
  const siempre = data.items.filter((i) => i.disparador === "SIEMPRE");
  const eventos = data.items.filter((i) => i.disparador !== "SIEMPRE");
  const notasItems = data.items.filter((i) => i.notas).map((i) => `${i.nombrePublico}: ${i.notas}`);
  const notasAgenciamiento = data.items.filter((i) => i.restaAgenciamiento).map(notaAgenciamientoDeItem);
  const ciudadesTxt = data.ciudades.map((c) => CIUDAD_PDF_TXT[c] ?? c).join(", ");

  return (
    <Document title={`Tarifas ${data.empresaNombre}`} author="Galcomex" creator="Galcomex Sistema Operativo">
      <Page size="LETTER" style={styles.page}>
        <View style={styles.membrete}>
          <Text style={styles.empresa}>GALCOMEX S.A.S.</Text>
          <Text style={styles.empresaSub}>GRISALES ASESORÍA Y LOGÍSTICA EN COMERCIO EXTERIOR S.A.S · NIT 900.219.446-8</Text>
          <Text style={styles.empresaSub}>Cra 53 # 64 – 72 Oficina 304 · Barranquilla, Colombia · Móvil 3002624201 – 3157532907</Text>
          <Text style={styles.empresaSub}>ggrisales@galcomex.com.co – auxiliar@galcomex.com.co</Text>
        </View>

        <Text style={styles.fecha}>Barranquilla, {fechaCarta(data.fechaEmision)}</Text>

        <View style={styles.destinatario}>
          <Text>Señores</Text>
          <Text style={styles.bold}>{data.empresaNombre}</Text>
          {data.contactoNombre ? <Text>Atn. {data.contactoNombre}</Text> : null}
          <Text>NIT {data.empresaNit}</Text>
          {debeImprimirCiudad(data.empresaCiudad) ? <Text>{data.empresaCiudad}</Text> : null}
        </View>

        <Text style={styles.ref}>REF: COTIZACIÓN SERVICIOS DE ASESORÍA Y LOGÍSTICA EN COMERCIO EXTERIOR {ALCANCE_REF[data.alcance] ?? ""}</Text>

        <Text style={styles.parrafo}>
          Nos permitimos poner a su disposición las tarifas por servicios de asesoría y logística en Comercio Exterior, vigentes desde el {fechaLarga(data.vigenteDesde)} hasta el {fechaLarga(data.vigenteHasta)}.
          {ciudadesTxt ? ` Aplica a: ${ciudadesTxt}.` : ""}
        </Text>

        {siempre.length > 0 ? (
          <View>
            {siempre.flatMap((item, i) =>
              filasDeItem(item).map((f, j) => (
                <View key={`${i}-${j}`} style={styles.fila}>
                  <Text style={styles.filaConcepto}>{f.concepto}</Text>
                  <Text style={styles.filaValor}>{f.valor}</Text>
                </View>
              )),
            )}
          </View>
        ) : null}

        {eventos.length > 0 ? (
          <View>
            <Text style={styles.seccion}>Servicios que se cobran solo cuando aplican</Text>
            {eventos.flatMap((item, i) =>
              filasDeItem(item).map((f, j) => (
                <View key={`e${i}-${j}`} style={styles.fila}>
                  <Text style={styles.filaConcepto}>{f.concepto}</Text>
                  <Text style={styles.filaValor}>{f.valor}</Text>
                </View>
              )),
            )}
          </View>
        ) : null}

        <Text style={styles.nota}>
          Los pagos a terceros por manejos prestados a la carga durante transporte, cargue, descargue, inspecciones y manipulación de bultos se cobran al costo del mercado y serán debidamente soportados con su orden de trabajo o factura del proveedor.
        </Text>
        {notasItems.map((n, i) => (
          <Text key={i} style={styles.nota}>
            {n}
          </Text>
        ))}
        {notasAgenciamiento.map((n, i) => (
          <Text key={`ag${i}`} style={styles.nota}>
            {n}
          </Text>
        ))}

        <Text style={[styles.parrafo, { marginTop: 14 }]}>Agradeciendo la atención y en espera de su respuesta, nos suscribimos.</Text>
        <Text>Cordialmente,</Text>
        <View style={styles.firma}>
          <Text style={styles.bold}>GUILLERMO GRISALES CRUZ</Text>
          <Text>Gerente</Text>
        </View>

        <View style={styles.pie} fixed>
          <Text>
            {data.nombre} · versión {data.version} · {data.estado}
          </Text>
          <Text>Generado por Galcomex Sistema Operativo</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderTarifarioPdf(data: TarifarioPdfDto): Promise<Buffer> {
  return renderToBuffer(<TarifarioPDF data={data} />);
}
