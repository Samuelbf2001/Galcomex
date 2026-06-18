/**
 * Generación de PDF — Borrador de Factura Galcomex
 * A3-T2: renderBorradorPdf() → Buffer (para endpoints Node)
 *
 * Usa @react-pdf/renderer (ya instalado, ^4.5.1).
 * Este archivo DEBE ser .tsx porque los componentes son JSX de react-pdf.
 */

import {
  Document,
  Font,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import React from "react";

// ─── Tipos de datos del DTO ───────────────────────────────────────────────────

export type LineaPdfDto = {
  orden: number;
  concepto: string;
  numSoporte: string | null;
  valor: bigint;
};

export type BorradorPdfDto = {
  // Identificación del trámite
  consecutivoDO: string;
  nombreCliente: string;
  numFacturaSiigo: string | null;
  fechaEmision: Date;
  estado: string;

  // Líneas de revisión (pagos)
  lineas: LineaPdfDto[];

  // Valores calculados
  totalAnticipo: bigint;
  totalPagos: bigint;
  comision: bigint;
  ivaComision: bigint;
  costosBancarios: bigint;
  impuesto4x1000: bigint;
  totalFactura: bigint;

  // Saldos
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
};

// ─── DTO preparado (strings COP) para render ─────────────────────────────────

export type BorradorPdfRenderData = {
  consecutivoDO: string;
  nombreCliente: string;
  numFacturaSiigo: string;
  fechaEmision: string;
  estado: string;

  lineas: {
    orden: number;
    concepto: string;
    numSoporte: string;
    valorStr: string;
  }[];

  totalAnticipoStr: string;
  totalPagosStr: string;
  comisionStr: string;
  ivaComisionStr: string;
  costosBancariosStr: string;
  impuesto4x1000Str: string;
  totalFacturaStr: string;

  saldoAFavorClienteStr: string;
  saldoACargoClienteStr: string;
  saldoAFavorLMStr: string;
  saldoACargoLMStr: string;
};

// ─── Helpers de formato ───────────────────────────────────────────────────────

const COP_FMT = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formatea un BigInt de COP a string: "$45.226.000"
 * Función pura — testeable sin render.
 */
export function formatCOP(value: bigint): string {
  return COP_FMT.format(Number(value));
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

// ─── Función pura de preparación de datos (testeable) ────────────────────────

/**
 * Convierte el DTO con BigInt a un objeto con strings COP listos para render.
 * Función pura — no toca BD, no hace I/O, completamente testeable.
 */
export function prepararDatosBorradorPdf(dto: BorradorPdfDto): BorradorPdfRenderData {
  return {
    consecutivoDO: dto.consecutivoDO,
    nombreCliente: dto.nombreCliente,
    numFacturaSiigo: dto.numFacturaSiigo ?? "Pendiente",
    fechaEmision: formatDate(dto.fechaEmision),
    estado: dto.estado,

    lineas: dto.lineas.map((l) => ({
      orden: l.orden,
      concepto: l.concepto,
      numSoporte: l.numSoporte ?? "—",
      valorStr: formatCOP(l.valor),
    })),

    totalAnticipoStr: formatCOP(dto.totalAnticipo),
    totalPagosStr: formatCOP(dto.totalPagos),
    comisionStr: formatCOP(dto.comision),
    ivaComisionStr: formatCOP(dto.ivaComision),
    costosBancariosStr: formatCOP(dto.costosBancarios),
    impuesto4x1000Str: formatCOP(dto.impuesto4x1000),
    totalFacturaStr: formatCOP(dto.totalFactura),

    saldoAFavorClienteStr: formatCOP(dto.saldoAFavorCliente),
    saldoACargoClienteStr: formatCOP(dto.saldoACargoCliente),
    saldoAFavorLMStr: formatCOP(dto.saldoAFavorLM),
    saldoACargoLMStr: formatCOP(dto.saldoACargoLM),
  };
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

// Evitar advertencias de fuente faltante registrando Helvetica como fallback
Font.registerHyphenationCallback((word) => [word]);

const colors = {
  primary: "#1a3a5c",
  accent: "#2563eb",
  lightGray: "#f1f5f9",
  mediumGray: "#94a3b8",
  border: "#e2e8f0",
  white: "#ffffff",
  text: "#1e293b",
  textLight: "#64748b",
  green: "#16a34a",
  red: "#dc2626",
};

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: colors.text,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    backgroundColor: colors.white,
  },

  // ── Membrete ──
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  headerLeft: {
    flexDirection: "column",
  },
  companyName: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
    letterSpacing: 2,
  },
  companySubtitle: {
    fontSize: 8,
    color: colors.textLight,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: "column",
    alignItems: "flex-end",
  },
  docTitle: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: colors.accent,
  },
  docSubtitle: {
    fontSize: 8,
    color: colors.textLight,
    marginTop: 2,
  },

  // ── Metadatos del DO ──
  metaBox: {
    flexDirection: "row",
    backgroundColor: colors.lightGray,
    borderRadius: 4,
    padding: 10,
    marginBottom: 16,
    gap: 16,
  },
  metaGroup: {
    flexDirection: "column",
    flex: 1,
  },
  metaLabel: {
    fontSize: 7,
    color: colors.textLight,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    marginBottom: 2,
  },
  metaValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
  },
  metaValueNormal: {
    fontSize: 9,
    color: colors.text,
  },

  // ── Sección general ──
  sectionTitle: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 12,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },

  // ── Tabla de líneas ──
  table: {
    flexDirection: "column",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: colors.primary,
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableHeaderCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    color: colors.white,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRowEven: {
    backgroundColor: colors.lightGray,
  },
  tableCell: {
    fontSize: 8,
    color: colors.text,
  },
  colOrd: { width: "6%" },
  colConcepto: { width: "54%" },
  colSoporte: { width: "22%" },
  colValor: { width: "18%", textAlign: "right" },

  // ── Bloque de cálculos ──
  calcBox: {
    marginTop: 12,
    flexDirection: "row",
    gap: 12,
  },
  calcColumn: {
    flex: 1,
    flexDirection: "column",
    gap: 4,
  },
  calcRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  calcRowHighlight: {
    backgroundColor: colors.lightGray,
    borderRadius: 2,
  },
  calcLabel: {
    fontSize: 8,
    color: colors.textLight,
  },
  calcValue: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: colors.text,
  },
  calcRowTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.primary,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 3,
    marginTop: 4,
  },
  calcLabelTotal: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: colors.white,
  },
  calcValueTotal: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: colors.white,
  },

  // ── Saldos ──
  saldosBox: {
    marginTop: 12,
    flexDirection: "row",
    gap: 8,
  },
  saldoCard: {
    flex: 1,
    borderRadius: 4,
    padding: 10,
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  saldoCardFavor: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#86efac",
  },
  saldoCardCargo: {
    backgroundColor: "#fee2e2",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  saldoCardNeutral: {
    backgroundColor: colors.lightGray,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saldoLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: colors.textLight,
    textAlign: "center",
  },
  saldoValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
  },
  saldoValueFavor: {
    color: colors.green,
  },
  saldoValueCargo: {
    color: colors.red,
  },
  saldoSubLabel: {
    fontSize: 7,
    color: colors.textLight,
    textAlign: "center",
  },

  // ── Footer ──
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
  footerText: {
    fontSize: 7,
    color: colors.mediumGray,
  },
});

// ─── Componente PDF ───────────────────────────────────────────────────────────

type Props = { data: BorradorPdfRenderData };

export function BorradorFacturaPDF({ data }: Props) {
  return (
    <Document
      title={`Borrador ${data.consecutivoDO}${data.numFacturaSiigo !== "Pendiente" ? ` — ${data.numFacturaSiigo}` : ""}`}
      author="Galcomex"
      creator="Galcomex Sistema Operativo"
    >
      <Page size="A4" style={styles.page}>
        {/* ── Membrete ── */}
        <View style={styles.header} fixed>
          <View style={styles.headerLeft}>
            <Text style={styles.companyName}>GALCOMEX</Text>
            <Text style={styles.companySubtitle}>
              Agencia Logística de Importaciones — Barranquilla
            </Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.docTitle}>BORRADOR DE FACTURA</Text>
            <Text style={styles.docSubtitle}>Estado: {data.estado}</Text>
          </View>
        </View>

        {/* ── Metadatos del DO ── */}
        <View style={styles.metaBox}>
          <View style={styles.metaGroup}>
            <Text style={styles.metaLabel}>Trámite (DO)</Text>
            <Text style={styles.metaValue}>{data.consecutivoDO}</Text>
          </View>
          <View style={styles.metaGroup}>
            <Text style={styles.metaLabel}>Cliente</Text>
            <Text style={styles.metaValueNormal}>{data.nombreCliente}</Text>
          </View>
          <View style={styles.metaGroup}>
            <Text style={styles.metaLabel}>Número Siigo</Text>
            <Text style={styles.metaValueNormal}>{data.numFacturaSiigo}</Text>
          </View>
          <View style={styles.metaGroup}>
            <Text style={styles.metaLabel}>Fecha de Emisión</Text>
            <Text style={styles.metaValueNormal}>{data.fechaEmision}</Text>
          </View>
        </View>

        {/* ── Tabla de líneas ── */}
        <Text style={styles.sectionTitle}>Detalle de Pagos y Gastos</Text>
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.colOrd]}>#</Text>
            <Text style={[styles.tableHeaderCell, styles.colConcepto]}>Concepto</Text>
            <Text style={[styles.tableHeaderCell, styles.colSoporte]}>Nº Soporte</Text>
            <Text style={[styles.tableHeaderCell, styles.colValor, { textAlign: "right" }]}>
              Valor
            </Text>
          </View>
          {data.lineas.map((linea, idx) => (
            <View
              key={linea.orden}
              style={[styles.tableRow, idx % 2 === 1 ? styles.tableRowEven : {}]}
            >
              <Text style={[styles.tableCell, styles.colOrd]}>{linea.orden}</Text>
              <Text style={[styles.tableCell, styles.colConcepto]}>{linea.concepto}</Text>
              <Text style={[styles.tableCell, styles.colSoporte]}>{linea.numSoporte}</Text>
              <Text style={[styles.tableCell, styles.colValor]}>{linea.valorStr}</Text>
            </View>
          ))}
        </View>

        {/* ── Bloque de cálculos ── */}
        <Text style={styles.sectionTitle}>Resumen de Cálculos</Text>
        <View style={styles.calcBox}>
          {/* Columna izquierda: ingresos */}
          <View style={styles.calcColumn}>
            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Anticipo Total Aplicado</Text>
              <Text style={styles.calcValue}>{data.totalAnticipoStr}</Text>
            </View>
            <View style={[styles.calcRow, styles.calcRowHighlight]}>
              <Text style={styles.calcLabel}>Total Pagos y Gastos</Text>
              <Text style={styles.calcValue}>{data.totalPagosStr}</Text>
            </View>
          </View>

          {/* Columna derecha: deducciones */}
          <View style={styles.calcColumn}>
            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Comisión Galcomex</Text>
              <Text style={styles.calcValue}>{data.comisionStr}</Text>
            </View>
            <View style={[styles.calcRow, styles.calcRowHighlight]}>
              <Text style={styles.calcLabel}>IVA Comisión (19%)</Text>
              <Text style={styles.calcValue}>{data.ivaComisionStr}</Text>
            </View>
            <View style={styles.calcRow}>
              <Text style={styles.calcLabel}>Impuesto 4×1000</Text>
              <Text style={styles.calcValue}>{data.impuesto4x1000Str}</Text>
            </View>
            <View style={[styles.calcRow, styles.calcRowHighlight]}>
              <Text style={styles.calcLabel}>Costos Bancarios</Text>
              <Text style={styles.calcValue}>{data.costosBancariosStr}</Text>
            </View>
          </View>
        </View>

        {/* Total factura */}
        <View style={styles.calcRowTotal}>
          <Text style={styles.calcLabelTotal}>TOTAL FACTURA</Text>
          <Text style={styles.calcValueTotal}>{data.totalFacturaStr}</Text>
        </View>

        {/* ── Saldos ── */}
        <Text style={styles.sectionTitle}>Saldos</Text>
        <View style={styles.saldosBox}>
          {/* Saldo a favor cliente */}
          <View
            style={[
              styles.saldoCard,
              data.saldoAFavorClienteStr !== formatCOP(0n)
                ? styles.saldoCardFavor
                : styles.saldoCardNeutral,
            ]}
          >
            <Text style={styles.saldoLabel}>Saldo a Favor Cliente</Text>
            <Text style={[styles.saldoValue, styles.saldoValueFavor]}>
              {data.saldoAFavorClienteStr}
            </Text>
            <Text style={styles.saldoSubLabel}>Galcomex devuelve al cliente</Text>
          </View>

          {/* Saldo a cargo cliente */}
          <View
            style={[
              styles.saldoCard,
              data.saldoACargoClienteStr !== formatCOP(0n)
                ? styles.saldoCardCargo
                : styles.saldoCardNeutral,
            ]}
          >
            <Text style={styles.saldoLabel}>Saldo a Cargo Cliente</Text>
            <Text style={[styles.saldoValue, styles.saldoValueCargo]}>
              {data.saldoACargoClienteStr}
            </Text>
            <Text style={styles.saldoSubLabel}>Cliente debe a Galcomex</Text>
          </View>

          {/* Saldo a favor LM */}
          <View
            style={[
              styles.saldoCard,
              data.saldoAFavorLMStr !== formatCOP(0n)
                ? styles.saldoCardFavor
                : styles.saldoCardNeutral,
            ]}
          >
            <Text style={styles.saldoLabel}>Saldo a Favor LM</Text>
            <Text style={[styles.saldoValue, styles.saldoValueFavor]}>
              {data.saldoAFavorLMStr}
            </Text>
            <Text style={styles.saldoSubLabel}>Galcomex devuelve a LM</Text>
          </View>

          {/* Saldo a cargo LM */}
          <View
            style={[
              styles.saldoCard,
              data.saldoACargoLMStr !== formatCOP(0n)
                ? styles.saldoCardCargo
                : styles.saldoCardNeutral,
            ]}
          >
            <Text style={styles.saldoLabel}>Saldo a Cargo LM</Text>
            <Text style={[styles.saldoValue, styles.saldoValueCargo]}>
              {data.saldoACargoLMStr}
            </Text>
            <Text style={styles.saldoSubLabel}>LM debe a Galcomex</Text>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            GALCOMEX — Documento generado automáticamente
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Página ${pageNumber} de ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

// ─── Render a Buffer ──────────────────────────────────────────────────────────

/**
 * Renderiza el PDF del borrador a un Buffer listo para servir como
 * `Content-Type: application/pdf`.
 *
 * @param dto  DTO con los datos del borrador (BigInt para dinero).
 */
export async function renderBorradorPdf(dto: BorradorPdfDto): Promise<Buffer> {
  const renderData = prepararDatosBorradorPdf(dto);
  const uint8 = await renderToBuffer(<BorradorFacturaPDF data={renderData} />);
  return Buffer.from(uint8);
}
