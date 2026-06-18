/**
 * Capturas del flujo nuevo de facturas de proveedor / portal SOCIO (Lucho).
 * Requiere: stack arriba (:3003), imports de excel-lucho-1/2 ejecutados,
 * usuario SOCIO creado (scripts/crear-usuario-socio.ts).
 * Uso: npx tsx scripts/capturas-flujo-lucho.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3003";
const OUT = path.resolve(__dirname, "..", "..", "capturas");

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/auth/login`, { waitUntil: "networkidle" });
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  const shot = async (page: Page, name: string, fullPage = false) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
    console.log(`📸 ${name}.png`);
  };

  // ── Sesión Camila (ADMIN) ────────────────────────────────────────────────
  const camila = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await login(camila, "camila@galcomex.com", "Galcomex2026!");

  // DO importado del Excel de Lucho 1 (CTG26-0118): pestaña F. Proveedor
  await camila.goto(`${BASE}/tramites`, { waitUntil: "networkidle" });
  await camila.click('a[href^="/tramites/"]:has-text("CTG26-0118")');
  await camila.waitForLoadState("networkidle");
  await camila.waitForTimeout(1500);
  await camila.click('button:has-text("F. Proveedor")');
  await camila.waitForTimeout(1500);
  await shot(camila, "10-facturas-proveedor", true);

  // Libro de pagos a proveedores con badges (factura proveedor / vía Lucho)
  await camila.click('button:has-text("Pagos a proveedores")');
  await camila.waitForTimeout(1500);
  await shot(camila, "11-pagos-proveedores-badges", true);

  // DO con retenciones (BAQ26-0113, del Excel de Lucho 2): Hoja
  await camila.goto(`${BASE}/tramites`, { waitUntil: "networkidle" });
  await camila.click('a[href^="/tramites/"]:has-text("BAQ26-0113")');
  await camila.waitForLoadState("networkidle");
  await camila.waitForTimeout(1800);
  await shot(camila, "12-hoja-con-retenciones", true);
  await camila.close();

  // ── Sesión Lucho (SOCIO) ─────────────────────────────────────────────────
  const lucho = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await login(lucho, "lucho@galcomex.com", "Galcomex2026!");

  await lucho.goto(`${BASE}/tramites`, { waitUntil: "networkidle" });
  await shot(lucho, "13-portal-socio-tramites");

  await lucho.click('a[href^="/tramites/"]:has-text("CTG26-0118")').catch(async () => {
    console.log("⚠️ SOCIO no ve CTG26-0118 en la lista");
  });
  await lucho.waitForLoadState("networkidle");
  await lucho.waitForTimeout(1800);
  await shot(lucho, "14-portal-socio-detalle-do");
  await lucho.close();

  await browser.close();
  console.log(`\n✅ Capturas en: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
