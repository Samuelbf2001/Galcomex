/**
 * Consulta la API de SIIGO y lista los IDs candidatos para llenar las variables
 * SIIGO_INVOICE_* del .env (envío de borradores a /v1/invoices).
 *
 * Uso:
 *   npx tsx scripts/siigo-config-lookup.ts
 *
 * Requisitos:
 *   - SIIGO_API_USERNAME, SIIGO_API_ACCESS_KEY configurados en .env
 *   - Acceso a internet hacia api.siigo.com
 *
 * Imprime, para cada variable, la lista de opciones que SIIGO devuelve
 * (tipos de comprobante, vendedores, formas de pago, impuestos). Tú eliges
 * la fila apropiada y pegas el id en .env.
 *
 * NOTA: SIIGO_INVOICE_FALLBACK_CODE es el `code` (string) de un producto del
 * catálogo SIIGO — no es un id numérico. Para esa variable usa el módulo
 * "Configuración → Productos SIIGO" en la app (ya está sincronizado).
 */

import "dotenv/config";

import {
  getDocumentTypes,
  getPaymentTypes,
  getTaxes,
  getToken,
  getUsers,
  SiigoApiError,
  SiigoConfigError,
} from "../src/lib/siigo/client";

function imprimirTabla<T extends object>(
  titulo: string,
  envVar: string,
  filas: T[],
  columnas: Array<keyof T & string>,
): void {
  console.log("\n" + "═".repeat(80));
  console.log(`▶ ${titulo}`);
  console.log(`  → Pegar id en: ${envVar}`);
  console.log("═".repeat(80));

  if (filas.length === 0) {
    console.log("  (vacío — SIIGO no devolvió resultados)");
    return;
  }

  const anchos = new Map<string, number>();
  for (const c of columnas) {
    anchos.set(
      c,
      Math.max(
        c.length,
        ...filas.map((f) => String((f as Record<string, unknown>)[c] ?? "").length),
      ),
    );
  }

  const header = columnas.map((c) => c.padEnd(anchos.get(c)!)).join("  │  ");
  console.log("  " + header);
  console.log("  " + columnas.map((c) => "─".repeat(anchos.get(c)!)).join("──┼──"));
  for (const f of filas) {
    const row = columnas
      .map((c) =>
        String((f as Record<string, unknown>)[c] ?? "").padEnd(anchos.get(c)!),
      )
      .join("  │  ");
    console.log("  " + row);
  }
}

async function main(): Promise<void> {
  console.log("Conectando a SIIGO…");
  const token = await getToken();
  console.log("✓ Token obtenido\n");

  // ── 1. Tipos de comprobante (FV) ──────────────────────────────────────────
  const docs = await getDocumentTypes(token);
  imprimirTabla(
    "Tipos de comprobante (factura de venta)",
    "SIIGO_INVOICE_DOCUMENT_ID",
    docs,
    ["id", "code", "name", "type", "active"],
  );

  // ── 2. Vendedores / usuarios ──────────────────────────────────────────────
  const users = await getUsers(token);
  imprimirTabla(
    "Usuarios (posibles vendedores)",
    "SIIGO_INVOICE_SELLER_ID",
    users.map((u) => ({
      id: u.id,
      username: u.username,
      nombre: [u.first_name, u.last_name].filter(Boolean).join(" "),
      email: u.email,
      active: u.active,
    })),
    ["id", "username", "nombre", "email", "active"],
  );

  // ── 3. Formas de pago (FV) ────────────────────────────────────────────────
  const pagos = await getPaymentTypes(token);
  imprimirTabla(
    "Formas de pago",
    "SIIGO_INVOICE_PAYMENT_ID",
    pagos,
    ["id", "name", "type", "active"],
  );

  // ── 4. Impuestos ──────────────────────────────────────────────────────────
  const taxes = await getTaxes(token);
  imprimirTabla(
    "Impuestos (busca el IVA al 19% para la comisión)",
    "SIIGO_INVOICE_TAX_IVA_ID",
    taxes,
    ["id", "name", "type", "percentage", "active"],
  );

  console.log("\n" + "═".repeat(80));
  console.log("▶ SIIGO_INVOICE_FALLBACK_CODE");
  console.log("═".repeat(80));
  console.log(
    "  No es un id numérico — es el `code` (string) de un producto SIIGO.",
  );
  console.log(
    "  Abre /configuracion en la app y elige un producto contable genérico",
  );
  console.log(
    "  (típicamente uno de 'Servicios' o el que use contabilidad para las",
  );
  console.log("  líneas técnicas: comisión, IVA, 4x1000, costos bancarios).");
  console.log("\nListo. Copia los ids elegidos a tu .env y reinicia el servidor.");
}

main().catch((err: unknown) => {
  if (err instanceof SiigoConfigError) {
    console.error("\n✗ Configuración SIIGO incompleta:", err.message);
    console.error(
      "  Asegúrate de tener SIIGO_API_USERNAME y SIIGO_API_ACCESS_KEY en .env",
    );
    process.exit(2);
  }
  if (err instanceof SiigoApiError) {
    console.error(`\n✗ SIIGO API error (HTTP ${err.status}):`, err.message);
    process.exit(3);
  }
  console.error("\n✗ Error inesperado:", err);
  process.exit(1);
});
