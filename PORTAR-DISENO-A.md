# Portar Diseño A a `feat/centavos`

Diseño A (B1 restar agenciamiento + B3 tarifario por ciudad + B8 anticipo por
factura, 27/28-sep-2026) se construyó sobre `origen/master = 91cc5af`, ANTES
de que `feat/centavos` se rebase. Este documento es la lista de lo que hay que
tocar al rebasar centavos encima de A (o al fusionar A después de que
centavos ya esté en `master`). Fuente completa del diseño y de las 3
decisiones de negocio de Ernesto: `simulacion-camila-27sep/DISENO-A.md`.

**Por qué A choca poco:** ninguna columna de dinero nueva (el agenciamiento
vive en `Parametro` como texto en pesos, igual que centavos ya trata
`Parametro`); toda la lógica nueva vive en 3 archivos nuevos
(`tarifas/resta-agenciamiento.ts`, `tarifas/agenciamiento.ts`,
`borradores/anticipo-disponible.ts`); los tipos del motor son opcionales; los
`detalle` de línea usan siempre `formatoCOP` del motor (nunca `.toString()` a
mano).

## Lista de cambios al portar (10 puntos del diseño, §9)

1. **`anticipo-disponible.ts`:** `montoAplicado` → `montoAplicadoCentavos`,
   `totalAnticipo` → `totalAnticipoCentavos` (columna `BorradorFactura` y
   variable en `borradores/service.ts`). Las funciones `anticipoAsignable` y
   `anticipoDelTramite` no cambian de forma, solo los nombres de campo que
   leen/agregan.
2. **`agenciamiento.ts`:** `BigInt(valor)` → `centavosDeTexto(valor)` (el
   parámetro sigue en pesos como texto; centavos define el conversor). El
   validador `AGENCIAMIENTO_*` en `parametros/service.ts` debe aceptar hasta 2
   decimales (hoy solo dígitos enteros).
3. **Ruta `PATCH /api/borradores/[id]/anticipo`:** leer `anticipo` del
   payload con `centavosDeTexto` (no `BigInt` directo) y responder con el
   serializador de centavos (`aJsonPlano`), igual que las demás rutas de
   dinero después de centavos.
4. **`motor.ts`:** conflicto de texto en la rama `PORCENTAJE_MIN` — A añade
   `porcentaje` / `minimo` al resultado de `calcularItem` (usados por
   `restarAgenciamiento`); centavos cambia `minimoDe` para devolver
   `{ ok, valor }`. Al fusionar: usar `lectura.valor` en vez del `bigint`
   plano que A escribió. `calcularLineasTarifa` conserva tal cual la llamada
   a `restarAgenciamiento` (misma firma, solo cambian las unidades por dentro
   si centavos también cambia `porcentajeSobre`).
5. **`validations/tarifas.ts` y `tarifas/service.ts`:** conflictos de texto —
   los campos nuevos de A (`restaAgenciamiento`, `minimoEsDelTotal`,
   `ciudades`) quedan junto a los cambios de centavos (`cop` →
   `dineroNoNegativoSchema`, `copString` → con `centavosDeTexto`).
   `copiarItemsDeTarifario` debe seguir copiando los dos booleanos nuevos
   además de convertir los montos a centavos.
6. **`schema.prisma`:** conflicto de texto en `Tarifario` (`ciudades`),
   `TarifaItem` (`restaAgenciamiento`, `minimoEsDelTotal`) y
   `BorradorFactura` (`anticipoManual`, `anticipoMotivo`) — todas conviven
   sin problema con el renombrado `…Centavos` de las columnas de dinero.
7. **Migraciones:** la de centavos (`20260926100000_centavos` o la que
   resulte del rebase) debe llevar fecha POSTERIOR a
   `20260928100000_diseno_a_agencia_ciudad_anticipo` (que ya va después de
   `20260927090000_otros_servicios_simple`). A no le agrega ninguna columna
   de dinero que centavos tenga que convertir — el orden solo importa por
   consistencia del historial de migraciones.
8. **Tests de A** (`src/lib/tarifas/__tests__/motor-resta-agenciamiento.test.ts`,
   `diseno-a-service.test.ts`, `src/lib/tramites/__tests__/diseno-a-ciudad.test.ts`,
   `src/lib/borradores/__tests__/diseno-a-b8-anticipo.test.ts`,
   `src/lib/validations/__tests__/tarifas-diseno-a.test.ts`): el helper local
   `const $ = (n: number) => BigInt(n)` se cambia por el `pesos()`/equivalente
   de centavos; los esperados de `simulacion-camila-27sep/DISENO-A.md` §6 se
   multiplican ×100 donde el test compare centavos en vez de pesos.
9. **UI:** el campo de valor del modal de anticipo
   (`AnticipoModal` en `revisor-borrador.tsx`) debe usar el `CampoMoneda` de
   centavos en vez de un `<input inputMode="numeric">` con dígitos crudos.
10. **Comparador:** correr `scripts/comparar-api-centavos/` incluyendo
    `GET /api/tramites/[id]/tarifa` — el `detalle` de las líneas con resta de
    agenciamiento cambia de formato solo por pasar de `formatoCOP` a
    `formatoPesos` (los números en pesos no cambian, solo la función que los
    imprime).

## Qué NO hay que tocar

- La regla de negocio de B1/B3/B8 no cambia: solo los tipos de dato del
  dinero y el conversor de texto.
- El MCP compartido (`galcomex-mcp/server.mjs`) sigue igual hasta el paso 10
  del diseño (después de desplegar A) — no se toca aquí.
- `PORTAR-COLDEX-EN-CXP-V2.md`, `PORTAR-ABONOS-Y-FACTURADO.md` y
  `PORTAR-CUENTA-CORRIENTE-AJUSTES.md` (en la raíz de `Galcomex/`) son guías
  equivalentes de otras ramas; este documento solo cubre Diseño A.

## Pendientes de la revisión de código (28-sep-2026) — quedan fuera de esta tanda

`REVISION-CODIGO-DISENO-A.md` (`simulacion-camila-27sep/`) encontró 9 hallazgos
BAJO. Se corrigieron el 1, 3, 4, 5 y 9 (ver commit de esta tanda). Los
siguientes quedan pendientes a propósito — no bloquean el despliegue, pero hay
que anotarlos para no perderlos:

- **BAJO 2 — M15 no es "igual que sin resta" con 0 unidades:** con
  agenciamiento 0 y 0 contenedores, el ítem con `restaAgenciamiento` queda
  `pendiente` (bloquea el borrador); sin la casilla, la línea simplemente no
  sale (se omite en silencio). Caso raro (agenciamiento configurado en 0 Y
  0 contenedores a la vez); documentar la diferencia o tratarla como "sin
  línea" cuando se retome.
- **BAJO 6 — SOCIO_LM en CONCEPTOS_IVA:** `src/lib/borradores/service.ts:582`
  calcula el cruce interno con `totalAnticipo` (todo lo aplicado), no con
  `totalAnticipoBorrador` (lo asignado a ESTA factura); `actualizarComisionInternaLM`
  hereda el mismo dato. Hoy ningún socio usa CONCEPTOS_IVA (Lucho y Grupo E
  Papis siguen en COMISION, fuera de alcance de B8) así que no hay bug
  observable todavía; corregir a `totalAnticipoBorrador` por coherencia el
  día que un SOCIO_LM pase a CONCEPTOS_IVA.
- **BAJO 7 — Falta la ayuda en vivo del editor de ítem y pruebas de
  componente:** `seccion-tarifario.tsx` no trae la ayuda dinámica prevista en
  `DISENO-A.md` §1.3 ("Hoy: COLDEX 145.000 · MOVIADUANAS sin valor",
  con `GET /api/parametros`), solo un texto fijo. Tampoco hay pruebas de
  componente (React Testing Library) para la casilla "restar agenciamiento",
  los chips de ciudad ni el modal de anticipo — el diseño pedía una por
  control (`DISENO-A.md` paso 6). Cubierto hoy solo por los tests de
  servicio/motor (BD e integración) y por la verificación manual en `:3028`.
- **BAJO 8 — la suite omite en silencio los tests de BD si no se exporta
  `DATABASE_URL`:** los tests usan `dotenv/config` (lee `.env`, no
  `.env.local`); con `npx vitest run` a secas los tests que dependen de
  Postgres local salen "skipped" y la corrida queda en verde igual. Para
  validar de verdad hay que exportar `DATABASE_URL` a mano antes de correr la
  suite (así se corrió la revisión del 28-sep y la implementación de esta
  tanda). Pendiente: hacer que la suite falle (o avise fuerte) si
  `DATABASE_URL` falta en vez de saltar en silencio.

## Si Ernesto decide que centavos va ANTES que A

Construir A directamente con las convenciones de centavos desde el inicio
(lector `centavosDeTexto`, columnas `…Centavos`, `pesos()` en los tests,
`formatoPesos` en los `detalle`) — los 10 puntos de arriba no aplican porque
nunca hubo nada que portar.
