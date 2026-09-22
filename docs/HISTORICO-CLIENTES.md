# Histórico 2026 de todos los clientes — segunda entrega (2026-09-21)

> **En palabras simples.** Camila entregó por Drive las carpetas 2026 de los 11
> clientes (9 ZIP, 19,6 GB). Litoplas ya estaba cargada desde el 16-sep, así
> que de ella solo entran los archivos nuevos. Del resto entra todo: cada
> carpeta de DO se vuelve un trámite **Histórico** de su empresa y cada archivo
> queda en la bodega con su categoría, **conservando las subcarpetas que cada
> cliente ya usa**. Lo que ninguna regla supo clasificar lo decidió una IA
> barata (Haiku) y lo verificó otra (Jev); lo que ni así quedó claro se queda
> en "Otro" para que Camila lo ordene desde la app.

Primera entrega (solo Litoplas) y decisiones D1–D6: `docs/HISTORICO-LITOPLAS.md`.

## Dónde quedan los archivos

```
tramites/<DO>/<CATEGORIA>/<subcarpetas del cliente>/<nombre original>
tramites/DO-CTG26-0067/FACTURA_PROVEEDOR/FACTURAS MSC/FLP919393.pdf
tramites/DO-BAQ26-0045/FOTO_RECONOCIMIENTO/REGISTRO FOTOGRAFICO/CASA HONG KONG/20.jpeg

clientes/<CLIENTE>/<ruta original>          ← fuera de un DO (solo explorador, sin registro)
clientes/POLYREC-ZF/AÑO 2026/CONCILIACION 2025-2026/FACTURA CONCILIACION PZFN-2651.pdf
```

Por eso `actualizarDocumento` cambia el **tercer** segmento de la clave al
recategorizar (antes tomaba "el anterior al nombre", que ahora puede ser una
subcarpeta del cliente).

Fuera de un DO van también: los `DO.EXP26-…` de exportación de Coldex, los
`DO.ANULADO`, los `0XXX` en curso sin número y los sueltos a nivel de cliente
(certificados de Pierco, conciliaciones de Polyrec, registros nuevos de CW).

## Empresas y agencia

| Carpeta | Empresa en producción | Agencia |
|---|---|---|
| LITOPLAS | LITOPLAS SA | Moviaduanas |
| COLDEX | AGENCIA DE ADUANAS COLDEX S.A.S NIVEL DOS (cliente intermediario: el cliente final va en la referencia externa) | Coldex |
| CW ASIA, POLYREC SAS, POLYREC ZF, SESDERMA | las de producción | Coldex |
| PIERCO, ORTHOFRACT, INVERSIONES TRIPLEX, INVERSIONES KASANA | se crean con el NIT de Siigo (`historico-clientes-2026/nits.json`) | Coldex |
| DISTRIBUIDORA EL TAPICERO | se crea con `PENDIENTE-NIT-…` (no está en Siigo) | Coldex |

Mapeo y reglas en `scripts/historico-clientes/reglas.ts`.

## Paso a paso

1. **Descomprimir** los 9 ZIP en una sola carpeta `C:\Users\samue\Downloads\Archivos clientes\<CLIENTE>\…`
   (hecho el 21-sep: 20.796 archivos; `tar` se salta nombres con chino/flechas, se extrajeron con .NET).
2. **Clasificar en seco** (SHA-256 para duplicados dentro de la misma subcarpeta):
   ```bash
   npx tsx scripts/historico-clientes/clasificar.ts
   ```
   Deja `../historico-clientes-2026/manifiesto.csv`, `resumen-dos.csv`, `resumen-clientes.csv`.
   Marca `YA_CARGADO` lo que estaba en el manifiesto de Litoplas del 16-sep.
3. **IA para lo que quedó en OTRO** (solo esas filas; nunca reclasifica lo que ya tiene categoría):
   ```bash
   npx tsx scripts/historico-clientes/clasificar-ia.ts --exportar          # lotes para subagentes Haiku
   #   (o con llave de luna: --env <archivo .env con LLM_API_KEY>)
   npx tsx scripts/historico-clientes/clasificar-ia.ts --importar          # junta los lote-N.resultado.json
   npx tsx scripts/historico-clientes/verificar-jev.ts --env ../openrouter-llave.env   # Jev verifica
   npx tsx scripts/historico-clientes/clasificar.ts                        # aplica ia-manifiesto.csv
   ```
   Lo mismo con `--prod prod-otro-litoplas.csv` para los documentos que ya estaban en
   producción en OTRO → `ia-prod.csv` → `aplicar-reclasificacion.ts` dentro del contenedor.
4. **Subir a R2** desde el PC (no pasa por el VPS):
   ```bash
   npx tsx --env-file=../r2-llaves.env scripts/historico-clientes/importar.ts --fase subir --paralelo 6
   ```
5. **Registrar** dentro del contenedor (una sola sesión SSH; copiar `manifiesto.csv`, `nits.json` y la carpeta de scripts):
   ```bash
   docker exec <app> npx tsx scripts/historico-clientes/importar.ts --fase registrar --manifiesto /app/manifiesto.csv --nits /app/nits.json --crear-clientes --sin-verificar
   ```
   Los DOs de **Bogotá** salen `PENDIENTE_BGT` hasta que se despliegue la migración
   `20260921120000_ciudad_bgt`; se vuelve a correr y los toma.
6. **Simulaciones contra DOs reales** por cliente: `../historico-clientes-2026/validacion/`
   (registro `.md` + script `_validacion-<cliente>.ts` que se corre en el contenedor como los de Litoplas).

## Cifras del 21-sep

173 DOs nuevos (323 numerados en total; 162 son los históricos de Litoplas ya en
producción, que solo reciben archivos nuevos; 0 choques con otros clientes).
8.672 archivos a subir en DO + 406 sueltos (6,4 GB); 11.339 ya cargados; 116
duplicados; 263 basura. Categorías por reglas: 96 %; Haiku+Jev resolvieron 289
de los 348 restantes (quedan 58 en OTRO, 0,7 %). En producción, de los 272
"Otro" de Litoplas quedaron 79 (193 reclasificados con AuditLog).

## Cómo cruzan Haiku y Jev

Haiku propone categoría + confianza con el prompt de `clasificar-ia.ts`; Jev
(`~typesafe/jev-latest`, OpenRouter `alpha/decisions`, `choice` con criterios)
responde lo mismo sin ver a Haiku. Coinciden → se aplica. Difieren → Haiku si
su confianza ≥ 0,80; si no, Jev si su probabilidad ≥ 0,60; si no, OTRO. Costo
medido: US$0,03 por 620 archivos en Jev; Haiku corre como subagente.

## Pendiente

- Desplegar `20260921120000_ciudad_bgt` y registrar los 21 DOs BGT de Sesderma.
- NIT de Distribuidora El Tapicero (Camila).
- Fase 2 (plata) sigue fuera del alcance: las simulaciones cargan solo los DOs elegidos.
