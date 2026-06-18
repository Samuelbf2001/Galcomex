/**
 * Generación de PDF — Estado de Cuenta de Cartera por Cliente — Galcomex
 * A3-T2: renderEstadoCuentaPdf() → Buffer (para endpoints Node)
 *
 * Usa @react-pdf/renderer (ya instalado, ^4.5.1).
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

import { formatCOP } from "./borrador-pdf";

// ─── Tipos de datos del DTO ───────────────────────────────────────────────────

export type FacturaEstadoCuentaDto = {
  id: string;
  numSiigo: string;
  consecutivoDO: string;
  fecha: Date;
  totalFactura: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
  saldoAFavorLM: bigint;
  saldoACargoLM: bigint;
  fechaPagoCliente: Date | null;
  fechaPagoLM: Date | null;
};

export type EstadoCuentaPdfDto = {
  nombreCliente: string;
  nitCliente: string;
  fechaEmision: Date;

  facturas: FacturaEstadoCuentaDto[];

  // Cruces totales (calculados por getCarteraCliente)
  cruceCliente: bigint;  // > 0 → cliente debe; < 0 → Galcomex debe
  cruceLM: bigint;       // > 0 → LM debe; < 0 → Galcomex debe a LM
  totalFacturas: number;
};

// ─── DTO preparado (strings) para render ─────────────────────────────────────

type FacturaRenderRow = {
  numSiigo: string;
  consecutivoDO: string;
  fechaStr: string;
  totalFacturaStr: string;
  saldoClienteStr: string;
  saldoClienteEsFavor: boolean;
  saldoLMStr: string;
  saldoLMEsFavor: boolean;
  pagadoCliente: string;
  pagadoLM: string;
};

export type EstadoCuentaRenderData = {
  nombreCliente: string;
  nitCliente: string;
  fechaEmisionStr: string;
  totalFacturas: number;

  filas: FacturaRenderRow[];

  cruceClienteStr: string;
  cruceClienteEsDeuda: boolean;   // true → cliente debe a Galcomex
  cruceLMStr: string;
  cruceLMEsDeuda: boolean;        // true → LM debe a Galcomex
};

// ─── Helper de formato de fecha ───────────────────────────────────────────────

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

// ─── Función pura de preparación de datos ────────────────────────────────────

/**
 * Convierte el DTO BigInt a strings COP. Función pura y testeable.
 */
export function prepararDatosEstadoCuentaPdf(
  dto: EstadoCuentaPdfDto,
): EstadoCuentaRenderData {
  const filas: FacturaRenderRow[] = dto.facturas.map((f) => {
    // Saldo neto cliente por factura: cargo - favor
    const saldoNeto = f.saldoACargoCliente - f.saldoAFavorCliente;
    const esFavor = saldoNeto <= 0n;
    const saldoAbsoluto = esFavor ? -saldoNeto : saldoNeto;

    // Saldo neto LM por factura
    const saldoNetoLM = f.saldoACargoLM - f.saldoAFavorLM;
    const esFavorLM = saldoNetoLM <= 0n;
    const saldoAbsLM = esFavorLM ? -saldoNetoLM : saldoNetoLM;

    return {
      numSiigo: f.numSiigo,
      consecutivoDO: f.consecutivoDO,
      fechaStr: formatDate(f.fecha),
      totalFacturaStr: formatCOP(f.totalFactura),
      saldoClienteStr: formatCOP(saldoAbsoluto),
      saldoClienteEsFavor: esFavor,
      saldoLMStr: formatCOP(saldoAbsLM),
      saldoLMEsFavor: esFavorLM,
      pagadoCliente: f.fechaPagoCliente ? formatDate(f.fechaPagoCliente) : "Pendiente",
      pagadoLM: f.fechaPagoLM ? formatDate(f.fechaPagoLM) : "Pendiente",
    };
  });

  // cruceCliente > 0 → cliente debe; < 0 → Galcomex debe
  const clienteDeuda = dto.cruceCliente > 0n;
  const lmDeuda = dto.cruceLM > 0n;

  return {
    nombreCliente: dto.nombreCliente,
    nitCliente: dto.nitCliente,
    fechaEmisionStr: formatDate(dto.fechaEmision),
    totalFacturas: dto.totalFacturas,
    filas,
    cruceClienteStr: formatCOP(
      dto.cruceCliente < 0n ? -dto.cruceCliente : dto.cruceCliente,
    ),
    cruceClienteEsDeuda: clienteDeuda,
    cruceLMStr: formatCOP(dto.cruceLM < 0n ? -dto.cruceLM : dto.cruceLM),
    cruceLMEsDeuda: lmDeuda,
  };
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

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
    fontSize: 8,
    color: colors.text,
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 36,
    backgroundColor: colors.white,
  },

  // Membrete
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  companyName: {
    fontSize: 20,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
    letterSpacing: 2,
  },
  companySubtitle: {
    fontSize: 7,
    color: colors.textLight,
    marginTop: 2,
  },
  docTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: colors.accent,
    textAlign: "right",
  },
  docSubtitle: {
    fontSize: 7,
    color: colors.textLight,
    textAlign: "right",
    marginTop: 2,
  },

  // Info cliente
  infoBox: {
    flexDirection: "row",
    backgroundColor: colors.lightGray,
    borderRadius: 4,
    padding: 8,
    marginBottom: 12,
    gap: 12,
  },
  infoGroup: {
    flexDirection: "column",
    flex: 1,
  },
  infoLabel: {
    fontSize: 6,
    fontFamily: "Helvetica-Bold",
    color: colors.textLight,
    textTransform: "uppercase",
    marginBottom: 1,
  },
  infoValue: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: colors.primary,
  },
  infoValueNormal: {
    fontSize: 8,
    color: colors.text,
  },

  // Tabla
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
    paddingHorizontal: 5,
  },
  thCell: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    color: colors.white,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowEven: {
    backgroundColor: colors.lightGray,
  },
  tdCell: {
    fontSize: 7,
    color: colors.text,
  },
  // Columnas
  colSiigo: { width: "13%" },
  colDO: { width: "14%" },
  colFecha: { width: "11%" },
  colTotal: { width: "14%", textAlign: "right" },
  colSaldoCli: { width: "14%", textAlign: "right" },
  colSaldoLM: { width: "13%", textAlign: "right" },
  colPagoCli: { width: "11%", textAlign: "center" },
  colPagoLM: { width: "10%", textAlign: "center" },

  // Colores de saldo
  saldoFavor: { color: colors.green },
  saldoCargo: { color: colors.red },

  // Resumen de cruces
  sectionTitle: {
    fontSize: 8,
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
  cruceBox: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  cruceCard: {
    flex: 1,
    borderRadius: 4,
    padding: 10,
    alignItems: "center",
    gap: 4,
  },
  cruceCardDeuda: {
    backgroundColor: "#fee2e2",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  cruceCardFavor: {
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: "#86efac",
  },
  cruceLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    color: colors.textLight,
    textAlign: "center",
  },
  cruceValue: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
  },
  cruceValueDeuda: { color: colors.red },
  cruceValueFavor: { color: colors.green },
  cruceDesc: {
    fontSize: 7,
    color: colors.textLight,
    textAlign: "center",
  },

  // Footer
  footer: {
    position: "absolute",
    bottom: 20,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 5,
  },
  footerText: {
    fontSize: 6,
    color: colors.mediumGray,
  },
});

// ─── Componente PDF ───────────────────────────────────────────────────────────

type Props = { data: EstadoCuentaRenderData };

export function EstadoCuentaPDF({ data }: Props) {
  return (
    <Document
      title={`Estado de Cuenta — ${data.nombreCliente}`}
      author="Galcomex"
      creator="Galcomex Sistema Operativo"
    >
      <Page size="A4" orientation="landscape" style={styles.page}>
        {/* ── Membrete ── */}
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.companyName}>GALCOMEX</Text>
            <Text style={styles.companySubtitle}>
              Agencia Logística de Importaciones — Barranquilla
            </Text>
          </View>
          <View>
            <Text style={styles.docTitle}>ESTADO DE CUENTA DE CARTERA</Text>
            <Text style={styles.docSubtitle}>Emitido: {data.fechaEmisionStr}</Text>
          </View>
        </View>

        {/* ── Info cliente ── */}
        <View style={styles.infoBox}>
          <View style={styles.infoGroup}>
            <Text style={styles.infoLabel}>Cliente</Text>
            <Text style={styles.infoValue}>{data.nombreCliente}</Text>
          </View>
          <View style={styles.infoGroup}>
            <Text style={styles.infoLabel}>NIT</Text>
            <Text style={styles.infoValueNormal}>{data.nitCliente}</Text>
          </View>
          <View style={styles.infoGroup}>
            <Text style={styles.infoLabel}>Total Facturas</Text>
            <Text style={styles.infoValueNormal}>{data.totalFacturas}</Text>
          </View>
          <View style={styles.infoGroup}>
            <Text style={styles.infoLabel}>Fecha de Emisión</Text>
            <Text style={styles.infoValueNormal}>{data.fechaEmisionStr}</Text>
          </View>
        </View>

        {/* ── Tabla de facturas ── */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.thCell, styles.colSiigo]}>Nº Siigo</Text>
            <Text style={[styles.thCell, styles.colDO]}>Trámite DO</Text>
            <Text style={[styles.thCell, styles.colFecha]}>Fecha</Text>
            <Text style={[styles.thCell, styles.colTotal, { textAlign: "right" }]}>
              Total Factura
            </Text>
            <Text style={[styles.thCell, styles.colSaldoCli, { textAlign: "right" }]}>
              Saldo Cliente
            </Text>
            <Text style={[styles.thCell, styles.colSaldoLM, { textAlign: "right" }]}>
              Saldo LM
            </Text>
            <Text style={[styles.thCell, styles.colPagoCli, { textAlign: "center" }]}>
              Pago Cliente
            </Text>
            <Text style={[styles.thCell, styles.colPagoLM, { textAlign: "center" }]}>
              Pago LM
            </Text>
          </View>

          {data.filas.map((fila, idx) => (
            <View
              key={fila.numSiigo}
              style={[styles.tableRow, idx % 2 === 1 ? styles.rowEven : {}]}
            >
              <Text style={[styles.tdCell, styles.colSiigo]}>{fila.numSiigo}</Text>
              <Text style={[styles.tdCell, styles.colDO]}>{fila.consecutivoDO}</Text>
              <Text style={[styles.tdCell, styles.colFecha]}>{fila.fechaStr}</Text>
              <Text style={[styles.tdCell, styles.colTotal]}>
                {fila.totalFacturaStr}
              </Text>
              <Text
                style={[
                  styles.tdCell,
                  styles.colSaldoCli,
                  fila.saldoClienteEsFavor ? styles.saldoFavor : styles.saldoCargo,
                ]}
              >
                {fila.saldoClienteEsFavor ? "+" : "-"}
                {fila.saldoClienteStr}
              </Text>
              <Text
                style={[
                  styles.tdCell,
                  styles.colSaldoLM,
                  fila.saldoLMEsFavor ? styles.saldoFavor : styles.saldoCargo,
                ]}
              >
                {fila.saldoLMEsFavor ? "+" : "-"}
                {fila.saldoLMStr}
              </Text>
              <Text style={[styles.tdCell, styles.colPagoCli]}>
                {fila.pagadoCliente}
              </Text>
              <Text style={[styles.tdCell, styles.colPagoLM]}>
                {fila.pagadoLM}
              </Text>
            </View>
          ))}
        </View>

        {/* ── Cruces totales ── */}
        <Text style={styles.sectionTitle}>Cruce Total de Cartera</Text>
        <View style={styles.cruceBox}>
          <View
            style={[
              styles.cruceCard,
              data.cruceClienteEsDeuda ? styles.cruceCardDeuda : styles.cruceCardFavor,
            ]}
          >
            <Text style={styles.cruceLabel}>Cruce Cliente</Text>
            <Text
              style={[
                styles.cruceValue,
                data.cruceClienteEsDeuda
                  ? styles.cruceValueDeuda
                  : styles.cruceValueFavor,
              ]}
            >
              {data.cruceClienteStr}
            </Text>
            <Text style={styles.cruceDesc}>
              {data.cruceClienteEsDeuda
                ? "El cliente debe a Galcomex"
                : "Galcomex debe al cliente"}
            </Text>
          </View>

          <View
            style={[
              styles.cruceCard,
              data.cruceLMEsDeuda ? styles.cruceCardDeuda : styles.cruceCardFavor,
            ]}
          >
            <Text style={styles.cruceLabel}>Cruce LM</Text>
            <Text
              style={[
                styles.cruceValue,
                data.cruceLMEsDeuda ? styles.cruceValueDeuda : styles.cruceValueFavor,
              ]}
            >
              {data.cruceLMStr}
            </Text>
            <Text style={styles.cruceDesc}>
              {data.cruceLMEsDeuda
                ? "LM debe a Galcomex"
                : "Galcomex debe a LM"}
            </Text>
          </View>
        </View>

        {/* ── Footer ── */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            GALCOMEX — Documento generado automáticamente — Confidencial
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
 * Renderiza el PDF de estado de cuenta a un Buffer listo para servir como
 * `Content-Type: application/pdf`.
 *
 * @param dto  DTO con los datos del estado de cuenta (BigInt para dinero).
 */
export async function renderEstadoCuentaPdf(dto: EstadoCuentaPdfDto): Promise<Buffer> {
  const renderData = prepararDatosEstadoCuentaPdf(dto);
  const uint8 = await renderToBuffer(<EstadoCuentaPDF data={renderData} />);
  return Buffer.from(uint8);
}
