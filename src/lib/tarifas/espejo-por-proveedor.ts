/**
 * Espejo de costo "por proveedor" (B6, Diseño B, 29-sep-2026) — función PURA.
 *
 * Caso real: el registro VUCE. Galcomex cobra "elaboración del registro" y, por
 * CADA registro, el mayor entre un mínimo (150.000; CW ASIA 280.000) y lo que
 * pagó al Ministerio de Comercio (NIT 830115297) por ese registro. Ni `FIJO`
 * (cobra siempre el mínimo) ni el espejo por texto (toma solo el primer costo,
 * sin mínimo y sin distinguir Ministerio de INVIMA) lo logran.
 *
 * Un ítem `ESPEJO_DE_COSTO` con `nitProveedorCosto` y/o `productoCosto` entra
 * en este modo: se espeja CADA factura de proveedor del DO (las que se le
 * cobran al cliente) que sea de ese NIT y de ese producto Siigo, y por cada una
 * se cobra `máx(mínimo, pagado)`. El mínimo es el `valor` del ítem (0 = espejo
 * puro). Nunca se cobra a medias en silencio: con el disparador EVENTO el
 * número de pagos tiene que ser igual a la cantidad marcada.
 *
 * Sin BD, BigInt, sin unidades monetarias implícitas (la aritmética es solo
 * `máx`, así que no choca con la fase de centavos).
 */

export interface CostoProveedor {
  valor: bigint;
  /** Clave del proveedor de la factura: `NIT:<nitBase>` o `BEN:<id>`. */
  proveedorClave: string | null;
  /** Código del producto Siigo de la factura de proveedor. */
  productoCodigo: string | null;
  /** Número de la factura del proveedor (para el detalle y los mensajes). */
  referencia: string;
}

export type ResultadoEspejo =
  | {
      ok: true;
      /** Una línea por pago; 0 líneas = no aplica (solo con disparador SIEMPRE). */
      lineas: { valor: bigint; detalle: string }[];
    }
  | { ok: false; motivo: string; causa: "COSTO_PROVEEDOR" };

function formatoCOP(valor: bigint): string {
  return valor.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function descripcionProveedor(nit: string | null, producto: string | null): string {
  if (nit && producto) return `proveedor NIT ${nit} (producto Siigo ${producto})`;
  if (nit) return `proveedor NIT ${nit}`;
  return `producto Siigo ${producto ?? ""}`.trim();
}

function referenciasDe(costos: CostoProveedor[]): string {
  const refs = costos.map((c) => c.referencia).filter((r) => r.length > 0);
  return refs.length ? ` (facturas ${refs.join(", ")})` : "";
}

export function espejarPorProveedor(a: {
  /** Mínimo por cada pago, en COP (`valor` del ítem). 0 = sin mínimo. */
  minimo: bigint;
  /** NIT base (solo dígitos) del proveedor; null = sin filtro por proveedor. */
  nitProveedor: string | null;
  /** Código de producto Siigo; null = sin filtro por producto. */
  producto: string | null;
  /** Facturas de proveedor que se cobran al cliente, ya ordenadas (fecha, número). */
  costos: CostoProveedor[];
  /** Cantidad del evento marcado; `null` = disparador SIEMPRE. */
  cantidadEvento: number | null;
  nombreItem: string;
}): ResultadoEspejo {
  const { minimo, nitProveedor, producto, costos, cantidadEvento, nombreItem } = a;
  const claveNit = nitProveedor ? `NIT:${nitProveedor}` : null;

  const coinciden = costos.filter(
    (c) => (!claveNit || c.proveedorClave === claveNit) && (!producto || c.productoCodigo === producto),
  );

  if (cantidadEvento !== null) {
    const quien = descripcionProveedor(nitProveedor, producto);
    if (coinciden.length === 0) {
      return {
        ok: false,
        causa: "COSTO_PROVEEDOR",
        motivo: `Marcaste «${nombreItem}» pero no hay factura del ${quien} que se le cobre al cliente. Regístrala en el DO con la ficha de ese proveedor.`,
      };
    }
    if (coinciden.length !== cantidadEvento) {
      return {
        ok: false,
        causa: "COSTO_PROVEEDOR",
        motivo: `Marcaste ${cantidadEvento} ${cantidadEvento === 1 ? "registro" : "registros"} («${nombreItem}») y hay ${coinciden.length} ${coinciden.length === 1 ? "pago" : "pagos"} al ${quien}${referenciasDe(coinciden)}. Corrige la cantidad del evento o las facturas.`,
      };
    }
  }

  const lineas: { valor: bigint; detalle: string }[] = [];
  for (const c of coinciden) {
    const valor = c.valor > minimo ? c.valor : minimo;
    if (valor <= 0n) continue;
    const ref = c.referencia ? ` ${c.referencia}` : "";
    const detalle =
      valor > c.valor
        ? `Pago${ref} ${formatoCOP(c.valor)}; se cobra el mínimo ${formatoCOP(minimo)}`
        : `Igual a lo pagado${ref} ${formatoCOP(c.valor)}`;
    lineas.push({ valor, detalle });
  }

  return { ok: true, lineas };
}
