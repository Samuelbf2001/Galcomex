<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Dinero (fase centavos, 2026-09)

- En BD y en código: `BigInt` en **CENTAVOS** de COP (columnas `…Centavos`). Cero flotantes.
- Todo texto de dinero (API, MCP, JSON guardados, `Parametro`, CSV) son **PESOS** con punto decimal y hasta 2 decimales: `"502801.45"`, `"150000"`. Las respuestas de la API llevan siempre 2 decimales (`"502801.00"`).
- Solo `src/lib/dinero` convierte, formatea (`formatoPesos`) y redondea (`porcentajeDe`, `dividirRedondeando`). En pantallas, los montos se escriben con `CampoMoneda`: un monto mal escrito NO es un campo vacío (mira `detalle.ok` o usa `useErroresMoneda`).
- Guía completa: `docs/DINERO-CENTAVOS.md`. Reglas de proyecto: `CLAUDE.md`.
