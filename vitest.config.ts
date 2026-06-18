import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Los tests de integración comparten una sola BD (:5433) y algunos mutan
    // datos de referencia (matriz de pagos). Ejecutar los archivos en serie
    // evita carreras sobre ese estado compartido.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        // El motor de cálculo debe tener ≥95% cobertura de ramas (A1-T7)
        branches: 95,
        functions: 90,
        lines: 90,
      },
      include: ["src/lib/calculations/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
