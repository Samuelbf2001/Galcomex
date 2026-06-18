/**
 * Captura pantallas de la app con el DO real DO.BUN26-0026 replicado del Excel.
 * Requiere: stack arriba (app en :3003) y `npx tsx scripts/replicar-grupo-e-papis.ts` ejecutado.
 * Uso: npx tsx scripts/capturas-demo.ts
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3003";
const OUT = path.resolve(__dirname, "..", "..", "capturas");
const EMAIL = "camila@galcomex.com";
const PASSWORD = "Galcomex2026!";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const shot = async (name: string) => {
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
    console.log(`📸 ${name}.png`);
  };

  // Login
  await page.goto(`${BASE}/auth/login`, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await shot("01-dashboard");

  // Trámites (lista)
  await page.goto(`${BASE}/tramites`, { waitUntil: "networkidle" });
  await shot("02-tramites-lista");

  // Detalle del DO replicado — pestaña Hoja (réplica del Excel)
  await page.click('a[href^="/tramites/"]:has-text("BUN26-0026")');
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await shot("03-do-hoja-excel");
  await page.screenshot({ path: path.join(OUT, "03b-do-hoja-excel-full.png"), fullPage: true });
  console.log("📸 03b-do-hoja-excel-full.png");

  // Pestaña Pagos (libro de pagos con saldo en vivo)
  await page.click('button:has-text("Pagos")');
  await page.waitForTimeout(1200);
  await shot("04-do-libro-pagos");

  // Pestaña Facturación del DO
  await page.click('button:has-text("Facturación")');
  await page.waitForTimeout(1200);
  await shot("05-do-facturacion");

  // Módulo Facturación (generador + revisor)
  await page.goto(`${BASE}/facturacion`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot("06-facturacion-modulo");

  // Cartera (seleccionando el cliente replicado)
  await page.goto(`${BASE}/cartera`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.selectOption("select", { label: "GRUPO E PAPIS" }).catch(async () => {
    const value = await page
      .locator("select option", { hasText: "GRUPO E PAPIS" })
      .first()
      .getAttribute("value");
    if (value) await page.selectOption("select", value);
  });
  await page.waitForTimeout(1500);
  await shot("07-cartera");

  // Anticipos
  await page.goto(`${BASE}/anticipos`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot("08-anticipos");

  await browser.close();
  console.log(`\n✅ Capturas en: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
