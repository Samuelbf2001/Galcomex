# PORTAR-B.md — qué trae la integración B y qué hay que adaptar a centavos (#4)

Para la sesión de centavos (#4). Rama `integracion-2026-09-29` (sobre `ebae965` = master + Diseño A).
Hoy TODO el dinero de B es `BigInt` en **pesos enteros** (COP, sin decimales), tolerancia 0.
Cuando #4 llegue (`valorServicio` y demás columnas a centavos), lo de abajo es lo que hay que
multiplicar por 100 o revisar. Regla general: las sumas y comparaciones puras (`+`, `−`, `máx`,
`===`) no cambian; lo que cambia es **dónde entra un valor en pesos** (config, formularios, texto),
**dónde se formatea**, y **cualquier redondeo al peso** (IVA por línea).

## Migraciones nuevas (orden de aplicación) — ninguna con columna de dinero

| Orden | Migración | Qué agrega |
|---|---|---|
| 1 | `20260929000100_siigo_envio_idempotente` | Siigo (no dinero) |
| 2 | `20260929000200_usuarios_admin` | Usuarios (no dinero) |
| 3 | `20260929000300_documento_requisito` | Eventos/documentos (no dinero) |
| 4 | `20260929001000_espejo_por_proveedor` | B6: `tarifa_item.nitProveedorCosto`, `.productoCosto` (TEXT) |
| 5 | `20260929001200_tarifario_servicio_otros` | B2: `tarifario.conceptoServicioCodigo` (FK a `concepto_venta`) |
| 6 | `20260929002000_comision_liquidacion` | B10: `comision_tramite.liquidacionTramiteId` (FK a `tramite_do`), `.liquidadaEn` |

La migración de centavos que ya exista en la sesión #4 debe ir DESPUÉS o ANTES sin chocar: B no toca
ninguna columna monetaria. Si #4 convierte `tramite_do.valorServicio` (BigInt, viene de la migración
base `20260927090000_otros_servicios_simple`) a centavos, las filas ya creadas por B10 quedan
convertidas con el resto.

## B6 — Registro VUCE: máx(mínimo, lo pagado) por registro (espejo por proveedor)

Archivos: `src/lib/tarifas/espejo-por-proveedor.ts` (lógica pura), `src/lib/tarifas/motor.ts`
(rama nueva antes de `calcularItem`), `src/lib/tarifas/service.ts` (carga las facturas de proveedor
con NIT, producto, número, ordenadas por fecha y número), `src/lib/validations/tarifas.ts`
(NIT 6–12 dígitos, no manual), `src/lib/pdf/tarifario-pdf.tsx`, `src/components/clientes/seccion-tarifario.tsx`,
`src/components/clientes/tarifas-api.ts`.

Lógica de dinero: por cada factura de proveedor que coincide (NIT y producto Siigo), la línea cobra
`valor = max(item.valor /*mínimo*/, factura.valor)`; si `valor <= 0` no hay línea. El detalle dice
"Pago X; se cobra el mínimo Y" o "Igual a lo pagado X".

Con centavos:
- `item.valor` (mínimo, en pesos en `tarifa_item.valor`) y `facturaProveedor.valor` deben estar en la
  MISMA unidad al hacer `max`. Si #4 deja `tarifa_item.valor` en pesos y `factura_proveedor.valor` en
  centavos (o al revés), hay que convertir aquí. Revisar `motor.ts` (`minimo: item.valor`).
- `formatoCOP` local de `espejo-por-proveedor.ts` (`toString` + puntos de miles) imprime centavos
  como si fueran pesos: cambiarlo por el formateador común de centavos.
- El resto no cambia (solo `max` y comparaciones).
- Tests: `tarifas/__tests__/espejo-por-proveedor.test.ts`, `espejo-por-proveedor-service.test.ts`,
  `contexto-asesoria.test.ts` (valores 150.000 / 280.000 / pagos reales del registro VUCE ×100).

## B4 — La factura debe cuadrar con la orden de compra (freno en el servidor)

Archivos: `src/lib/borradores/orden-compra.ts` (regla pura), `orden-compra-service.ts` (BD),
`service.ts` (`transicionarBorrador` frena EN_REVISION → APROBADO), `consulta.ts`,
`src/app/api/borradores/[id]/route.ts`, `src/app/api/tramites/[id]/borrador/route.ts`,
`src/lib/validations/borradores.ts`, `src/lib/capacidades/catalogo.ts`,
`src/components/facturacion/aviso-orden-compra.tsx`, `aprobar-sin-cuadre-oc-modal.tsx`,
`revisor-borrador.tsx`, `facturacion-api.ts`.

Lógica de dinero: `baseParaOc(desglose, config)` = servicio (líneas OPERACIONAL sin `tipoFija`)
+ terceros (TERCEROS sin `tipoFija`, si `base = SERVICIO_Y_TERCEROS`) + 4x1000 (línea fija
`IMPUESTO_4X1000`, solo si `incluye4x1000`). Sin IVA ni ReteIVA. `diferencia = base − ordenCompraValor`;
CUADRA solo si es exactamente 0. Columna leída: `tramite_do.ordenCompraValor` (BigInt, "COP sin IVA
tal como viene en la OC").

Con centavos:
- `ordenCompraValor` pasa a centavos con el resto de columnas; lo que se escribe en el DO es en
  pesos: revisar el punto donde se guarda (validación del PATCH del trámite / formulario del DO) para
  que ×100 quede en una sola frontera.
- Las líneas del borrador (`lineasRevision.valor`) ya estarán en centavos: la comparación exacta
  sigue válida si ambos lados están en centavos. **No hay que tocar la resta**; sí revisar que la
  tolerancia 0 no se vuelva un problema por céntimos (redondeo del IVA no entra a la base, así que
  no debería).
- Formato: `formatoPesos` (importado de `@/lib/cxp/saldos`) en `mensajeFrenoOc`, y `formatCOP` con
  `.toString()` en `aviso-orden-compra.tsx` (`valorOc`, `base`, `diferencia`, desglose vienen como
  string de BigInt): dependen del formateador de centavos que defina #4.
- `aviso-orden-compra.tsx` recalcula la evaluación en el navegador con `BigInt(l.valor)` desde el
  JSON: debe leer el mismo formato (string de centavos) que el servidor.
- El motivo de excepción (mín. 10 caracteres) y `bloqueaAprobacion` no son dinero.
- Tests: `orden-compra.test.ts`, `orden-compra-service.test.ts`, `route-orden-compra.test.ts`,
  `aviso-orden-compra.test.tsx` (OC10944 = 1.901.939, OC11104 = 539.000, etc. ×100).

## B7 — Cotización / solicitud de fondos por DO (PDF)

Archivos: `src/lib/cotizacion/calculo.ts` (cuenta pura), `service.ts` (BD),
`src/app/api/tramites/[id]/cotizacion/route.ts` y `pdf/route.ts`, `src/lib/pdf/cotizacion-pdf.tsx`,
`src/components/tramites/boton-cotizacion-pdf.tsx`, botón dentro de `seccion-eventos-tramite.tsx`.

Lógica de dinero: usa la MISMA cuenta que la factura CONCEPTOS_IVA (`calcularFacturaConceptos`,
`ivaDeItem`): IVA por concepto redondeado al peso, terceros sin IVA con su 4x1000
(`tasa4x1000 = 400n` sobre 100.000), ReteIVA sobre el IVA, `totalAGirar` = total de la factura sin
restar anticipos. «Valor para su orden de compra» = `desgloseParaOc` + `baseParaOc` de B4 (la misma
regla del freno; en integración se eliminó el lector propio). Nota de agencia:
`Parametro AGENCIAMIENTO_<AGENCIA>` + su IVA.

Con centavos:
- **Redondeo del IVA al peso** (`ivaDeItem`) es lo más delicado: hoy la cotización, el borrador y la
  factura redondean igual porque comparten la función. Al pasar a centavos, esa función decide si el
  IVA se redondea al peso o al centavo; **la cotización debe seguir usando la misma función** para que
  siga cuadrando con la factura (no duplicar el redondeo).
- `service.ts`: `valor: BigInt(t.valor)` de los terceros (facturas de proveedor) y la lectura del
  parámetro `AGENCIAMIENTO_*` (pesos escritos por Camila): convertir en la frontera.
- Formato de texto: `cop()` en `textoNotaAgencia` (`calculo.ts`) y `formatoCOP`/`toString` con puntos
  de miles en `cotizacion-pdf.tsx` (línea ~50) imprimen enteros: pasar al formateador de centavos
  (con o sin decimales, según decida #4).
- La API devuelve BigInt serializado (`jsonResponse`): el contrato ya es string; queda igual.
- Tests: `cotizacion/__tests__/calculo.test.ts`, `service.integration.test.ts`,
  `pdf/__tests__/cotizacion-pdf.test.ts`, `api/.../cotizacion/__tests__/route.test.ts` (casos dorados
  BAQ-18385 = 1.487.623, DO.26-0171 = 472.730, DO.BGT26-0228 = 925.715, ×100).

## B10 — Facturar comisiones de LTRANS como un «Otros»

Archivos: `src/lib/comisiones/liquidacion.ts` (nuevo), `calculo.ts` (`valorUnitarioDe`,
`configLiquidacionDe`, `referenciaLiquidacion`), `service.ts` (`subtotal = unidades × valorUnitario`
en la ficha por DO y por empresa; comisión ya facturada no se edita), `src/lib/tramites/service.ts`
(gancho `alCrear` en `createTramite`; bloqueo de valor/concepto de un «Otros» de comisiones),
`src/app/api/clientes/[id]/comisiones/liquidar/route.ts`, `src/lib/validations/comisiones.ts`,
`src/components/comisiones/seccion-comisiones-empresa.tsx`, `seccion-comision-tramite.tsx`,
`comisiones-api.ts`, `src/lib/mcp/paridad-excepciones.ts`.

Lógica de dinero:
- `total = Σ (comision.unidades × valorUnitario)` → se guarda como **`tramite_do.valorServicio`** del
  «Otros» (sin IVA); el IVA lo pone la factura del «Otros» (flujo corto normal).
- `valorUnitario` sale de la config JSON de `comision_por_evento`, campo `valor` (**string de pesos**,
  regex `^\d{1,12}$`, `valorUnitarioDe` en `calculo.ts`).
- AuditLog `LIQUIDAR_COMISIONES` guarda `valorUnitario` y `total` (BigInt → normalizeSerializable).
- Sin columna de dinero nueva: el valor facturado vive en `valorServicio` y en el AuditLog.

Con centavos:
- `valorServicio` ×100 (ya está en el plan de #4): en `liquidacion.ts` la línea `total = … BigInt(c.unidades) * valorUnitario`
  es correcta si `valorUnitario` ya está en centavos; **el punto a cambiar es `valorUnitarioDe`**: hoy
  parsea un entero en pesos; debe pasar a aceptar pesos con hasta 2 decimales (o seguir aceptando
  pesos enteros y multiplicar ×100) y devolver centavos. El editor de esa config en Funciones
  (`Comisión a cobrar por contenedor`) escribe el mismo string.
- `service.ts` (ficha): `subtotal`, `iva` y `total` (líneas ~168 y ~431) y `FilaComisionFacturada.otros.valorServicio`
  viajan al navegador; `seccion-comisiones-empresa.tsx` los recalcula en el cliente
  (`BigInt(datos.valorUnitario)`, `BigInt(datos.tasaIva)` y `formatCOP`): actualizar formateo y el
  cálculo local del IVA (mismo redondeo que el servidor).
- Comisiones ya liquidadas antes de #4: el «Otros» conserva su `valorServicio` (convertido por la
  migración de #4); no se recalcula (a propósito: «el valor por contenedor pudo cambiar después»).
- Tests: `comisiones/__tests__/calculo.test.ts`, `liquidacion.integration.test.ts`,
  `api/.../comisiones/liquidar/__tests__/route.test.ts` (5 DOs = 1.350.000; 1.606.500 con IVA;
  17 contenedores = 1.820.700; ×100).

## B2 — «Otros servicios» con tarifa por servicio (menor)

Archivos: `src/lib/tarifas/service.ts`, `campos-tarifa.ts`, `src/lib/tramites/flujo-corto.ts`
(`resolverFacturableFlujoCorto`: valor a mano en `tramite_do.valorServicio` o el de la tarifa por
servicio), `src/components/tramites/seccion-eventos-tramite.tsx` (prop `flujoCorto`),
`tramite-detalle.tsx`, `tramites-workspace.tsx`, `src/components/clientes/seccion-tarifario.tsx`.
Sin cuentas nuevas: solo dónde se toma el valor. Con centavos: el valor escrito a mano del «Otros»
(`valorServicio`) se convierte en la frontera del formulario; la tarifa por servicio hereda lo que
haga #4 con `tarifa_item.valor`. Tests: `otros-por-servicio.test.ts`, `campos-tarifa.test.ts`.

## Polyrec-1 — Solicitar facturación sin pagos para empresas a crédito

Archivos: `src/lib/facturas-proveedor/service.ts` (`exigePagosParaFacturar`: exige ≥ 1 pago solo si
la empresa tiene la capacidad `anticipos_cliente`), tests en `facturas-proveedor/__tests__/service.test.ts`
(+3), 3 líneas en `CLAUDE.md`.
**No hay dinero** en este cambio: no requiere adaptación a centavos.

## Convenciones para no pisar la fusión

- Los cuatro puntos de contacto con otros trabajos son `prisma/schema.prisma`, `CLAUDE.md`,
  `src/lib/mcp/paridad-excepciones.ts` y `src/lib/tramites/service.ts`; B solo AGREGA (sin
  reformatear).
- Único cambio B tocando código de otro bloque: `baseParaOc` nueva en `borradores/orden-compra.ts`
  (la usan el freno de B4 y la cotización de B7). Si #4 cambia la base de la OC, se cambia ahí y los
  dos siguen iguales.
- Sparse-checkout de este worktree: los merges dejan fuera `documentos referencia /` (ruta inválida
  en Windows). Hay que recrear el árbol con `git mktree` + `git commit-tree` y `git update-ref`, y
  reponer el índice con `git -c core.protectNTFS=false read-tree HEAD` +
  `git -c core.protectNTFS=false sparse-checkout reapply`. Verificar siempre con
  `git ls-tree -r HEAD --name-only | grep -c "documentos referencia"` (debe ser 3).
