/**
 * Capturas del flujo de cobros: abonos parciales, devoluciones y vista Ingresos.
 * Requiere: stack arriba (:3003) y `npx tsx scripts/demo-cobros.ts` ejecutado.
 * Uso: npx tsx scripts/capturas-cobros.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3003";
const OUT = path.resolve(__dirname, "..", "..", "capturas");

async function login(page: Page) {
  await page.goto(`${BASE}/auth/login`, { waitUntil: "networkidle" });
  await page.fill("#email", "camila@galcomex.com");
  await page.fill("#password", "Galcomex2026!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

async function selectClientByText(page: Page, sub: string) {
  const value = await page
    .locator("select option", { hasText: sub })
    .first()
    .getAttribute("value");
  if (value) await page.selectOption("select", value);
  await page.waitForTimeout(1500);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const shot = async (name: string, full = false) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
    console.log(`📸 ${name}.png`);
  };

  await login(page);

  // ── Cartera: factura A CARGO con abonos parciales ──────────────────────────
  await page.goto(`${BASE}/cartera`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await selectClientByText(page, "DEMO COBROS");
  // Expandir los pagos de la factura
  await page.click('button[title="Ver pagos"]').catch(() => {});
  await page.waitForTimeout(1000);
  await shot("15-cartera-abonos", true);

  // Modal de registrar abono
  await page.click('button:has-text("Abono")').catch(() => {});
  await page.waitForTimeout(1000);
  await shot("16-cartera-abono-modal");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  // ── Cartera: devolución sobre BUN26-0026 (saldo a favor) ───────────────────
  await page.goto(`${BASE}/cartera`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await selectClientByText(page, "GRUPO E PAPIS");
  await page.click('button[title="Ver pagos"]').catch(() => {});
  await page.waitForTimeout(1000);
  await shot("17-cartera-devolucion", true);

  // Vista LM (debe verse saldado)
  await page.click('button:has-text("LM")').catch(() => {});
  await page.waitForTimeout(1200);
  await shot("18-cartera-lm-saldado", true);

  // ── Ingresos / Libro de bancos ─────────────────────────────────────────────
  await page.goto(`${BASE}/ingresos`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await selectClientByText(page, "DEMO COBROS").catch(() => {});
  await page.waitForTimeout(1200);
  await shot("19-ingresos", true);

  await browser.close();
  console.log(`\n✅ Capturas en: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
