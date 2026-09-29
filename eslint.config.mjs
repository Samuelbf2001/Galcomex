import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import dinero from "./eslint-rules/index.mjs";

/**
 * Fase centavos (diseño D.1): el dinero solo se convierte en `src/lib/dinero`.
 * Pruebas, scripts y el propio núcleo quedan fuera de estas reglas.
 */
const ARCHIVOS_FUERA_DE_REGLAS_DINERO = [
  "src/lib/dinero/**",
  "scripts/**",
  "eslint-rules/**",
  "**/__tests__/**",
  "**/*.test.{ts,tsx,js,mjs}",
  "**/*.spec.{ts,tsx,js,mjs}",
  "e2e/**",
  "tests/**",
];

export const CONFIG_REGLA_CON_TIPOS = {
  name: "dinero/no-bigint-a-texto (con tipos)",
  files: ["src/**/*.{ts,tsx}"],
  ignores: ARCHIVOS_FUERA_DE_REGLAS_DINERO,
  plugins: { dinero },
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "dinero/no-bigint-a-texto": "error",
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "dinero/sin-conversiones-fuera-del-nucleo",
    files: ["**/*.{ts,tsx,mts,js,jsx,mjs}"],
    ignores: ARCHIVOS_FUERA_DE_REGLAS_DINERO,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='BigInt']",
          message:
            "Dinero: no uses BigInt() fuera de src/lib/dinero. Pesos texto → centavosDeTexto/centavosDeTextoApi; pesos enteros → pesos(); cantidades → enteroNoDinero(); tasas → tasaDeTexto() (@/lib/dinero).",
        },
        {
          selector: "MemberExpression[object.name='Intl'][property.name='NumberFormat']",
          message:
            "Dinero: no uses Intl.NumberFormat fuera de src/lib/dinero. Usa formatoPesos / formatoUsd / formatoTrm (@/lib/dinero).",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/components/ui/campo-moneda",
              importNames: ["digitosDesdeTextoCOP", "formatearMilesCOP"],
              message:
                "Se borraron en la fase centavos: usa centavosDeTextoUsuario / formatoEdicion de @/lib/dinero.",
            },
          ],
          patterns: [
            {
              group: ["**/campo-moneda"],
              importNames: ["digitosDesdeTextoCOP", "formatearMilesCOP"],
              message:
                "Se borraron en la fase centavos: usa centavosDeTextoUsuario / formatoEdicion de @/lib/dinero.",
            },
          ],
        },
      ],
    },
  },
  CONFIG_REGLA_CON_TIPOS,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
