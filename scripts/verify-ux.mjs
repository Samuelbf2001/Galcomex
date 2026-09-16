// Browser checks against real UI components with synthetic data; no database writes.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";

const root = process.cwd();
const out = path.join(root, "coverage", "ux-browser");
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "index.html"), '<html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await writeFile(path.join(out, "navigation.ts"), 'export const usePathname = () => "/clientes"; export const useRouter = () => ({push() {}, refresh() {}});');
await writeFile(path.join(out, "link.tsx"), 'import React from "react"; export default function Link({children, ...props}: React.AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props}>{children}</a>; }');
await writeFile(path.join(out, "main.tsx"), `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import { AppShell } from "@/components/layout/app-shell";
import { ModuleState } from "@/components/layout/module-state";
import { WorkspaceFallback } from "@/components/layout/workspace-fallback";
import { InlineTramiteField } from "@/components/tramites/inline-tramite-field";
import { ClientesWorkspace } from "@/components/clientes/clientes-workspace";
import { EditorLineas } from "@/components/facturacion/editor-lineas";
import type { BorradorRow } from "@/components/facturacion/facturacion-api";
import { ToastProvider } from "@/components/ui/toast";
import { RolProvider } from "@/lib/auth/rol-context";
function Demo() {
  const [value, setValue] = useState("Referencia inicial");
  const [attempt, setAttempt] = useState(0);
  const [borrador, setBorrador] = useState({id: "demo", tramiteId: "demo", comentariosCabecera: [], comision: "0", ivaComision: "0", retenciones: "0", totalFactura: "50000", lineasRevision: [{ id: "linea-demo", orden: 1, concepto: "Transporte de mercancía", valor: "50000", seccion: "TERCEROS", tipoFija: null, facturasVinculadas: [], nitTercero: null }]} as unknown as BorradorRow);
  const view = new URLSearchParams(location.search).get("view");
  return <RolProvider rol="ADMIN"><ToastProvider><AppShell rol="ADMIN" nombre="Equipo de operaciones" email="demo@example.test">
    {view === "clientes" ? <ClientesWorkspace /> : view === "facturacion" ? <EditorLineas borrador={borrador} tramiteId="demo" puedeEditar onBorradorActualizado={setBorrador} /> : <section className="mx-auto max-w-5xl space-y-5">
      <div><h1 className="text-2xl font-semibold">Operación del trámite</h1><p className="mt-1 text-sm text-slate-600">Revisa la información y actualiza lo que necesites.</p></div>
      <div className="rounded-xl border border-slate-200 bg-white p-5"><InlineTramiteField label="Referencia" type="text" value={value} onSave={async (next) => { await new Promise(r => setTimeout(r, 300)); setAttempt(attempt + 1); if (!attempt) throw new Error("No se pudo conectar. Tu cambio se conserva."); setValue(next); }} /></div>
      <ModuleState type="error" title="No pudimos cargar los documentos" detail="Revisa la conexión e inténtalo de nuevo." action={{label: "Reintentar", onClick() {}}} />
      <ModuleState type="empty" title="Todavía no hay documentos" detail="Los documentos que agregues a este trámite aparecerán aquí." />
      <WorkspaceFallback titulo="Cargando actividad" tarjetas={4} filtros={2} />
    </section>}
  </AppShell></ToastProvider></RolProvider>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
`);
const server = await createServer({ configFile: false, root: out, plugins: [react()], define: { "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify("http://127.0.0.1:4179") }, resolve: { alias: { "@": path.join(root, "src"), "next/navigation": path.join(out, "navigation.ts"), "next/link": path.join(out, "link.tsx") } }, css: { postcss: { plugins: [tailwind()] } }, server: { host: "127.0.0.1", port: 4179, strictPort: true, fs: { allow: [root] } } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4179");
  await page.getByLabel("Referencia", { exact: true }).fill("Nueva referencia");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await page.getByRole("button", { name: "Reintentar guardado" }).waitFor();
  assert.equal(await page.getByLabel("Referencia", { exact: true }).inputValue(), "Nueva referencia");
  await page.getByRole("button", { name: "Reintentar guardado" }).click();
  await page.getByRole("button", { name: "Guardando…" }).waitFor({ state: "hidden" });
  assert.equal(await page.getByLabel("Referencia", { exact: true }).inputValue(), "Nueva referencia");
  await page.screenshot({ path: path.join(out, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Abrir menú" }).click();
  const dialog = page.getByRole("dialog", { name: "Menú principal" });
  await dialog.waitFor();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, "Mobile navigation must retain keyboard focus");
  }
  await page.screenshot({ path: path.join(out, "mobile-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Abrir menú" }).evaluate(el => el === document.activeElement), true);
  const overflow = await page.locator("main").evaluate(el => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, "Mobile content must fit its scroll container");
  await page.screenshot({ path: path.join(out, "mobile.png"), fullPage: true });
  let request = 0;
  await page.route("**/api/clientes**", async route => {
    request++;
    if (request === 1) { await new Promise(r => setTimeout(r, 500)); await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Error de prueba" }) }); }
    else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ clientes: [] }) });
  });
  await page.goto("http://127.0.0.1:4179/?view=clientes");
  await page.getByRole("status", { name: "Cargando datos" }).waitFor();
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  await page.getByText("Aún no hay empresas", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Nueva empresa", exact: true }).count(), 1);
  await page.screenshot({ path: path.join(out, "clientes-empty-mobile.png"), fullPage: true });
  await page.unroute("**/api/clientes**");
  await page.route("**/api/clientes**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ clientes: [{ id: "demo", nombre: "Empresa de demostración", nit: "900000001", esCliente: true, activo: true, tarifas: [] }] }) }));
  await page.reload();
  await page.getByRole("link", { name: "Empresa de demostración" }).waitFor();
  await page.getByPlaceholder("Nombre, NIT o contacto").fill("inexistente");
  await page.getByText("No hay empresas que coincidan", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Limpiar filtros", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Limpiar filtros", exact: true }).click();
  await page.getByRole("link", { name: "Empresa de demostración" }).waitFor();
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  await page.screenshot({ path: path.join(out, "clientes-mobile.png"), fullPage: true });
  await page.route("**/api/tramites/demo/facturas-proveedor", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ facturas: [] }) }));
  await page.route("**/api/configuracion/siigo/productos**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ productos: [], total: 0, ultimaSync: null }) }));
  await page.goto("http://127.0.0.1:4179/?view=facturacion");
  await page.getByLabel("Concepto de la línea 1").waitFor();
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth > el.clientWidth + 1), false, "Invoice editor must contain wide tables on mobile");
  await page.screenshot({ path: path.join(out, "facturacion-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(out, "facturacion-desktop.png"), fullPage: true });
  assert.deepEqual(errors, [], "No unhandled browser errors");
  console.log(JSON.stringify({ passed: true, checks: ["failed save preserves input", "retry saves", "390x844 no overflow", "drawer traps and restores focus", "client error recovery and empty state", "client filter recovery without duplicate actions", "invoice editor responsive tables"], screenshots: out }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}


