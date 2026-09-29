/**
 * PDF "Cotización / solicitud de fondos" de un DO (B7, Diseño B, 29-sep-2026).
 *
 * Lo que Galcomex le manda al cliente para que gire los fondos y haga su orden
 * de compra (Camila, nota de voz 3, 27-sep): los conceptos de la propuesta del
 * tarifario con su IVA, los pagos a terceros ya registrados en el DO, el 4x1000,
 * la ReteIVA y el TOTAL A GIRAR — la misma cuenta que la factura de venta
 * (`lib/cotizacion/calculo.ts`) —, más el "valor para su orden de compra (sin
 * impuestos)" y la nota de la orden de compra aparte de la agencia de aduanas.
 *
 * Mismo estilo que `tarifario-pdf.tsx`; usa @react-pdf/renderer.
 */

import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import React from "react";

import type { CotizacionDto } from "@/lib/cotizacion/service";

/** Lo que el PDF necesita de la cotización (`CotizacionDto` lo cumple). */
export type CotizacionPdfDto = Pick<
  CotizacionDto,
  | "fecha"
  | "tramite"
  | "empresa"
  | "tarifario"
  | "conceptos"
  | "terceros"
  | "baseConceptos"
  | "iva"
  | "baseTerceros"
  | "impuesto4x1000"
  | "reteIvaPorcentaje"
  | "reteIvaManual"
  | "retenciones"
  | "totalAGirar"
  | "valorParaOc"
  | "usaOrdenCompra"
  | "textoNotaAgencia"
>;

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function fechaCarta(d: Date): string {
  return `${MESES[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")} de ${d.getUTCFullYear()}`;
}

/** "$ 1.606.500" (COP enteros, punto de miles). */
export function pesosCotizacion(valor: bigint): string {
  const negativo = valor < 0n;
  const digitos = (negativo ? -valor : valor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "−" : ""}$ ${digitos}`;
}

export type FilaCotizacion = {
  tipo: "concepto" | "subtotal" | "tercero" | "impuesto" | "retencion" | "total";
  texto: string;
  valor: string;
};

/**
 * Las filas de dinero del PDF, en orden: conceptos (con "+ IVA" si lo llevan),
 * subtotal e IVA, terceros, 4x1000, ReteIVA y TOTAL A GIRAR. Pura: es lo que se
 * verifica en los tests (el contenido del PDF va comprimido).
 */
export function filasCotizacion(c: CotizacionPdfDto): FilaCotizacion[] {
  const filas: FilaCotizacion[] = [];
  for (const item of c.conceptos) {
    filas.push({ tipo: "concepto", texto: item.concepto, valor: `${pesosCotizacion(item.valor)}${item.aplicaIva ? "" : " (sin IVA)"}` });
  }
  filas.push({ tipo: "subtotal", texto: "Subtotal servicios", valor: pesosCotizacion(c.baseConceptos) });
  filas.push({ tipo: "impuesto", texto: "IVA", valor: pesosCotizacion(c.iva) });
  for (const t of c.terceros) {
    filas.push({ tipo: "tercero", texto: t.concepto, valor: pesosCotizacion(t.valor) });
  }
  if (c.impuesto4x1000 > 0n) {
    filas.push({ tipo: "impuesto", texto: "Impuesto 4x1000 sobre los pagos a terceros", valor: pesosCotizacion(c.impuesto4x1000) });
  }
  if (c.retenciones > 0n) {
    filas.push({
      tipo: "retencion",
      texto: c.reteIvaPorcentaje !== null ? `ReteIVA (${c.reteIvaPorcentaje} % del IVA)` : "ReteIVA",
      valor: `− ${pesosCotizacion(c.retenciones)}`,
    });
  }
  filas.push({ tipo: "total", texto: "TOTAL A GIRAR", valor: pesosCotizacion(c.totalAGirar) });
  return filas;
}

/** Texto de la línea "Valor para su orden de compra", o null si la empresa no usa orden de compra. */
export function textoValorOc(c: CotizacionPdfDto): { titulo: string; valor: string; detalle: string } | null {
  if (!c.usaOrdenCompra) return null;
  const oc = c.valorParaOc;
  const partes = [`servicios ${pesosCotizacion(oc.servicio)}`];
  if (oc.base === "SERVICIO_Y_TERCEROS") partes.push(`pagos a terceros ${pesosCotizacion(oc.terceros)}`);
  if (oc.incluye4x1000) partes.push(`4x1000 ${pesosCotizacion(oc.cuatroXMil)}`);
  return {
    titulo: "Valor para su orden de compra (sin impuestos)",
    valor: pesosCotizacion(oc.valor),
    detalle: `${partes.join(" + ")}. No incluye IVA, ReteIVA${oc.incluye4x1000 ? "" : " ni 4x1000"}.`,
  };
}

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 60, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  membrete: { alignItems: "center", marginBottom: 18 },
  empresa: { fontFamily: "Helvetica-Bold", fontSize: 13 },
  empresaSub: { fontSize: 7.5, color: "#475569", marginTop: 1 },
  fecha: { marginTop: 14, marginBottom: 12 },
  destinatario: { marginBottom: 12, lineHeight: 1.4 },
  bold: { fontFamily: "Helvetica-Bold" },
  ref: { fontFamily: "Helvetica-Bold", marginBottom: 4, lineHeight: 1.4 },
  refDetalle: { fontSize: 9, color: "#334155", lineHeight: 1.4 },
  parrafo: { lineHeight: 1.45, marginTop: 10, marginBottom: 10, textAlign: "justify" },
  fila: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: "#e2e8f0" },
  filaTotal: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, marginTop: 4, borderTopWidth: 1, borderTopColor: "#0f172a", borderBottomWidth: 1, borderBottomColor: "#0f172a" },
  filaConcepto: { flex: 1, paddingRight: 12 },
  filaValor: { width: 150, textAlign: "right", fontFamily: "Helvetica-Bold" },
  seccion: { fontFamily: "Helvetica-Bold", fontSize: 8.5, color: "#475569", marginTop: 10, marginBottom: 3, textTransform: "uppercase" },
  cajaOc: { marginTop: 14, padding: 8, borderWidth: 0.75, borderColor: "#94a3b8", backgroundColor: "#f8fafc" },
  cajaOcTitulo: { flexDirection: "row", justifyContent: "space-between" },
  cajaOcDetalle: { fontSize: 8.5, color: "#475569", marginTop: 3, lineHeight: 1.4 },
  nota: { fontSize: 8.5, color: "#475569", lineHeight: 1.4, marginTop: 10, textAlign: "justify" },
  notaAgencia: { fontSize: 9, marginTop: 10, padding: 6, borderWidth: 0.75, borderColor: "#cbd5e1", lineHeight: 1.4 },
  firma: { marginTop: 26 },
  pie: { position: "absolute", bottom: 28, left: 60, right: 60, borderTopWidth: 0.5, borderTopColor: "#cbd5e1", paddingTop: 4, fontSize: 7, color: "#64748b", flexDirection: "row", justifyContent: "space-between" },
});

export function CotizacionPDF({ data }: { data: CotizacionPdfDto }) {
  const filas = filasCotizacion(data);
  const oc = textoValorOc(data);
  const detalleDo = [
    data.tramite.doCliente ? `DO cliente: ${data.tramite.doCliente}` : null,
    data.tramite.proveedorCliente ? `Proveedor: ${data.tramite.proveedorCliente}` : null,
    data.tramite.referenciaExterna ? `Servicio: ${data.tramite.referenciaExterna}` : null,
    data.tramite.ordenCompraNumero ? `Orden de compra N° ${data.tramite.ordenCompraNumero}` : null,
  ].filter((t): t is string => t !== null);

  return (
    <Document title={`Cotización ${data.tramite.consecutivo}`} author="Galcomex" creator="Galcomex Sistema Operativo">
      <Page size="LETTER" style={styles.page}>
        <View style={styles.membrete}>
          <Text style={styles.empresa}>GALCOMEX S.A.S.</Text>
          <Text style={styles.empresaSub}>GRISALES ASESORÍA Y LOGÍSTICA EN COMERCIO EXTERIOR S.A.S · NIT 900.219.446-8</Text>
          <Text style={styles.empresaSub}>Cra 53 # 64 – 72 Oficina 304 · Barranquilla, Colombia · Móvil 3002624201 – 3157532907</Text>
          <Text style={styles.empresaSub}>ggrisales@galcomex.com.co – auxiliar@galcomex.com.co</Text>
        </View>

        <Text style={styles.fecha}>Barranquilla, {fechaCarta(data.fecha)}</Text>

        <View style={styles.destinatario}>
          <Text>Señores</Text>
          <Text style={styles.bold}>{data.empresa.nombre}</Text>
          {data.empresa.contactoNombre ? <Text>Atn. {data.empresa.contactoNombre}</Text> : null}
          <Text>NIT {data.empresa.nit}</Text>
          {data.empresa.ciudad?.trim() ? <Text>{data.empresa.ciudad}</Text> : null}
        </View>

        <Text style={styles.ref}>REF: COTIZACIÓN / SOLICITUD DE FONDOS — {data.tramite.consecutivo}</Text>
        {detalleDo.map((t, i) => (
          <Text key={i} style={styles.refDetalle}>
            {t}
          </Text>
        ))}

        <Text style={styles.parrafo}>
          Nos permitimos presentar la cotización de los servicios de asesoría y logística en Comercio Exterior para este trámite, con los valores que se facturarán, y el total a girar.
        </Text>

        <View>
          {filas.map((f, i) =>
            f.tipo === "total" ? (
              <View key={i} style={styles.filaTotal}>
                <Text style={[styles.filaConcepto, styles.bold]}>{f.texto}</Text>
                <Text style={styles.filaValor}>{f.valor}</Text>
              </View>
            ) : (
              <View key={i} style={styles.fila}>
                <Text style={styles.filaConcepto}>{f.texto}</Text>
                <Text style={styles.filaValor}>{f.valor}</Text>
              </View>
            ),
          )}
        </View>

        {oc ? (
          <View style={styles.cajaOc}>
            <View style={styles.cajaOcTitulo}>
              <Text style={styles.bold}>{oc.titulo}</Text>
              <Text style={styles.bold}>{oc.valor}</Text>
            </View>
            <Text style={styles.cajaOcDetalle}>{oc.detalle}</Text>
          </View>
        ) : null}

        {data.textoNotaAgencia ? <Text style={styles.notaAgencia}>{data.textoNotaAgencia}</Text> : null}

        {data.reteIvaManual ? (
          <Text style={styles.nota}>Las retenciones de este cliente se liquidan a mano en la factura: no están incluidas en este total.</Text>
        ) : null}
        <Text style={styles.nota}>
          Los pagos a terceros por manejos prestados a la carga durante transporte, cargue, descargue, inspecciones y manipulación de bultos se cobran al costo del mercado y serán debidamente soportados con su orden de trabajo o factura del proveedor.
        </Text>

        <Text style={[styles.parrafo, { marginTop: 14 }]}>Agradeciendo la atención y en espera de su respuesta, nos suscribimos.</Text>
        <Text>Cordialmente,</Text>
        <View style={styles.firma}>
          <Text style={styles.bold}>GUILLERMO GRISALES CRUZ</Text>
          <Text>Gerente</Text>
        </View>

        <View style={styles.pie} fixed>
          <Text>
            {data.tramite.consecutivo}
            {data.tarifario ? ` · ${data.tarifario.nombre} v${data.tarifario.version}` : ""}
          </Text>
          <Text>Generado por Galcomex Sistema Operativo</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderCotizacionPdf(data: CotizacionPdfDto): Promise<Buffer> {
  return renderToBuffer(<CotizacionPDF data={data} />);
}
