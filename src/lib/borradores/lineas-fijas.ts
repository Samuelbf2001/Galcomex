/**
 * Líneas fijas del borrador de factura — Galcomex
 *
 * Modela los cuatro conceptos siempre presentes en la factura de venta como
 * `LineaRevision` con `tipoFija`, en lugar de campos sueltos de `BorradorFactura`:
 *
 *   COMISION         (OPERACIONAL, orden 991) — comisión Galcomex
 *   IVA_COMISION     (OPERACIONAL, orden 992) — IVA 19% de la comisión
 *   COSTOS_BANCARIOS (TERCEROS,    orden 990) — costos bancarios del trámite
 *   IMPUESTO_4X1000  (TERCEROS,    orden 995) — GMF
 *
 * Así el DTO enviado a Siigo es 1:1 con las líneas del borrador y `Σ items.price`
 * = `borrador.totalFactura − retenciones`, sin posibilidad de divergencia.
 *
 * `ensureLineasFijas` es idempotente: para cada concepto con valor > 0 que NO
 * tenga línea, crea una nueva con `siigoProductoId` resuelto desde parámetros.
 * Las líneas existentes nunca se sobreescriben (preserva ediciones previas).
 */

import { type Prisma, SeccionLinea } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type Tx = Prisma.TransactionClient;

export type TipoFija =
  | "COMISION"
  | "IVA_COMISION"
  | "COSTOS_BANCARIOS"
  | "IMPUESTO_4X1000";

interface DefinicionLineaFija {
  tipoFija: TipoFija;
  seccion: SeccionLinea;
  orden: number;
  concepto: string;
}

const DEFS: DefinicionLineaFija[] = [
  {
    tipoFija: "COSTOS_BANCARIOS",
    seccion: SeccionLinea.TERCEROS,
    orden: 990,
    concepto: "COSTOS BANCARIOS",
  },
  {
    tipoFija: "COMISION",
    seccion: SeccionLinea.OPERACIONAL,
    orden: 991,
    concepto: "COMISION GALCOMEX",
  },
  {
    tipoFija: "IVA_COMISION",
    seccion: SeccionLinea.OPERACIONAL,
    orden: 992,
    concepto: "IVA COMISION",
  },
  {
    tipoFija: "IMPUESTO_4X1000",
    seccion: SeccionLinea.TERCEROS,
    orden: 995,
    concepto: "IMPUESTO 4X1000",
  },
];

export interface ProductosLineasFijas {
  productoComisionId: string | null;
  productoIvaComisionId: string | null;
  productoCostosBancariosId: string | null;
  producto4x1000Id: string | null;
}

/**
 * Resuelve los siigoProductoId asociados a las 4 líneas fijas leyendo parámetros
 * de `Parametro` y verificando contra `SiigoProducto`. Si un parámetro no está
 * configurado o el FK ya no existe, devuelve null para esa línea (el revisor lo
 * asigna manualmente desde el editor).
 *
 * IVA comisión cae en el mismo producto que la comisión cuando no hay un
 * `SIIGO_PRODUCTO_IVA_COMISION_ID` propio configurado (replica el fallback
 * histórico del flujo previo).
 */
export async function resolverProductosLineasFijas(
  tx: Tx | typeof prisma = prisma,
): Promise<ProductosLineasFijas> {
  const claves = [
    "SIIGO_PRODUCTO_COMISION_ID",
    "SIIGO_PRODUCTO_IVA_COMISION_ID",
    "SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID",
    "SIIGO_PRODUCTO_4X1000_ID",
  ];

  const params = await tx.parametro.findMany({
    where: { clave: { in: claves } },
    select: { clave: true, valor: true },
  });
  const map = Object.fromEntries(
    params.map((p) => [p.clave, p.valor?.trim() || ""]),
  );

  const ids = Object.values(map).filter((v) => v.length > 0);
  const existentes = await tx.siigoProducto.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const existentesSet = new Set(existentes.map((p) => p.id));
  const valido = (id: string | undefined): string | null =>
    id && existentesSet.has(id) ? id : null;

  const productoComisionId = valido(map["SIIGO_PRODUCTO_COMISION_ID"]);
  const productoIvaComisionId =
    valido(map["SIIGO_PRODUCTO_IVA_COMISION_ID"]) ?? productoComisionId;

  return {
    productoComisionId,
    productoIvaComisionId,
    productoCostosBancariosId: valido(map["SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID"]),
    producto4x1000Id: valido(map["SIIGO_PRODUCTO_4X1000_ID"]),
  };
}

function productoFijoIdPara(
  tipo: TipoFija,
  productos: ProductosLineasFijas,
): string | null {
  switch (tipo) {
    case "COMISION":
      return productos.productoComisionId;
    case "IVA_COMISION":
      return productos.productoIvaComisionId;
    case "COSTOS_BANCARIOS":
      return productos.productoCostosBancariosId;
    case "IMPUESTO_4X1000":
      return productos.producto4x1000Id;
  }
}

interface ValoresLineasFijas {
  comision: bigint;
  ivaComision: bigint;
  costosBancarios: bigint;
  impuesto4x1000: bigint;
}

function valorPara(tipo: TipoFija, valores: ValoresLineasFijas): bigint {
  switch (tipo) {
    case "COMISION":
      return valores.comision;
    case "IVA_COMISION":
      return valores.ivaComision;
    case "COSTOS_BANCARIOS":
      return valores.costosBancarios;
    case "IMPUESTO_4X1000":
      return valores.impuesto4x1000;
  }
}

/**
 * Lista de inputs Prisma listos para `lineasRevision.create` en `generarBorrador`.
 * Solo incluye conceptos con `valor > 0n` (Siigo rechaza items con price 0).
 */
export function definirLineasFijasParaCreate(
  valores: ValoresLineasFijas,
  productos: ProductosLineasFijas,
): Array<{
  concepto: string;
  valor: bigint;
  orden: number;
  seccion: SeccionLinea;
  tipoFija: TipoFija;
  siigoProductoId: string | null;
}> {
  return DEFS.filter((def) => valorPara(def.tipoFija, valores) > 0n).map((def) => ({
    concepto: def.concepto,
    valor: valorPara(def.tipoFija, valores),
    orden: def.orden,
    seccion: def.seccion,
    tipoFija: def.tipoFija,
    siigoProductoId: productoFijoIdPara(def.tipoFija, productos),
  }));
}

/**
 * Idempotente: garantiza que el borrador tenga las líneas fijas correspondientes
 * a sus campos `comision`/`ivaComision`/`costosBancarios`/`impuesto4x1000`.
 *
 * Caso típico:
 *   - Borrador generado **antes** de este modelo de líneas (solo tenía 4x1000 +
 *     costos bancarios como líneas fijas, no COMISION ni IVA_COMISION) — al
 *     primer `enviarBorradorASiigo` o `actualizarComisionBorrador` se crean
 *     las líneas faltantes a partir de los campos del borrador.
 *   - Borrador nuevo — `generarBorrador` ya las sembró; no-op.
 *
 * No actualiza valores existentes ni crea líneas para conceptos con valor 0.
 */
export async function ensureLineasFijas(tx: Tx, borradorId: string): Promise<void> {
  const borrador = await tx.borradorFactura.findUniqueOrThrow({
    where: { id: borradorId },
    select: {
      comision: true,
      ivaComision: true,
      costosBancarios: true,
      impuesto4x1000: true,
      lineasRevision: {
        where: { tipoFija: { not: null } },
        select: { tipoFija: true },
      },
    },
  });

  const presentes = new Set(
    borrador.lineasRevision
      .map((l) => l.tipoFija)
      .filter((t): t is string => t !== null),
  );

  const productos = await resolverProductosLineasFijas(tx);
  const valores: ValoresLineasFijas = {
    comision: borrador.comision,
    ivaComision: borrador.ivaComision,
    costosBancarios: borrador.costosBancarios,
    impuesto4x1000: borrador.impuesto4x1000,
  };

  const aCrear = DEFS.filter((def) => {
    if (presentes.has(def.tipoFija)) return false;
    return valorPara(def.tipoFija, valores) > 0n;
  });

  if (aCrear.length === 0) return;

  await tx.lineaRevision.createMany({
    data: aCrear.map((def) => ({
      borradorId,
      concepto: def.concepto,
      valor: valorPara(def.tipoFija, valores),
      orden: def.orden,
      origen: "AUTO" as const,
      seccion: def.seccion,
      tipoFija: def.tipoFija,
      siigoProductoId: productoFijoIdPara(def.tipoFija, productos),
    })),
  });
}

/**
 * Reemplaza el valor de las líneas COMISION + IVA_COMISION (o las crea si no
 * existen). Usado por `actualizarComisionBorrador` desde el editor.
 *
 * El IVA se calcula como `comision * tasaIva / 100n` (BigInt, truncado), idéntico
 * al cálculo del motor histórico.
 */
export async function actualizarLineasComision(
  tx: Tx,
  borradorId: string,
  nuevaComision: bigint,
  tasaIva: bigint,
): Promise<void> {
  const nuevoIva = (nuevaComision * tasaIva) / 100n;
  const productos = await resolverProductosLineasFijas(tx);

  for (const tipo of ["COMISION", "IVA_COMISION"] as const) {
    const def = DEFS.find((d) => d.tipoFija === tipo)!;
    const valor = tipo === "COMISION" ? nuevaComision : nuevoIva;

    const existente = await tx.lineaRevision.findFirst({
      where: { borradorId, tipoFija: tipo },
      select: { id: true },
    });

    if (valor === 0n) {
      if (existente) {
        await tx.lineaRevision.delete({ where: { id: existente.id } });
      }
      continue;
    }

    if (existente) {
      await tx.lineaRevision.update({
        where: { id: existente.id },
        data: { valor },
      });
    } else {
      await tx.lineaRevision.create({
        data: {
          borradorId,
          concepto: def.concepto,
          valor,
          orden: def.orden,
          origen: "AUTO",
          seccion: def.seccion,
          tipoFija: tipo,
          siigoProductoId: productoFijoIdPara(tipo, productos),
        },
      });
    }
  }
}
