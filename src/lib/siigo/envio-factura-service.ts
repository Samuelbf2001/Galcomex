/**
 * Servicio de envío de borradores aprobados a la API de SIIGO **como borrador
 * (DRAFT)**.
 *
 * La factura NO se factura desde Galcomex: se crea en Siigo con stamp.send=false
 * para que quede como borrador, y un usuario superior la valida y la estampa
 * manualmente desde el portal Siigo. El consecutivo definitivo llega después
 * por el flujo manual de "Marcar facturado" (PATCH /api/borradores/[id]).
 *
 * Configuración leída desde BD (tabla Parametro):
 *   SIIGO_TIPO_COMPROBANTE_ID  → ID numérico del tipo de documento Siigo
 *   SIIGO_VENDEDOR_ID          → ID numérico del vendedor (usuario Siigo)
 *   SIIGO_PRODUCTO_COMISION_ID → UUID del SiigoProducto para línea de comisión
 *
 * El IVA de la comisión se resuelve desde SiigoProductoImpuesto del producto
 * de comisión. La forma de pago viene de BorradorFactura.formaPagoSiigoId.
 * Los productos de 4x1000 y costos bancarios vienen de su LineaRevision.siigoProductoId.
 *
 * En éxito:
 * - Borrador se mantiene en estado APROBADO.
 * - Se persisten siigoDraftId, enviadoASiigoEn, ultimoIntentoSiigo.
 * - Se limpia ultimoErrorSiigo.
 * - AuditLog accion="SIIGO_ENVIAR_OK".
 *
 * En fallo:
 * - Borrador se mantiene en estado APROBADO.
 * - Se persisten ultimoErrorSiigo + ultimoIntentoSiigo.
 * - AuditLog accion="SIIGO_ENVIAR_ERROR".
 *
 * Regla anti-duplicado (cada POST crea un documento en Siigo, y estampado es
 * una factura legal):
 * - Un borrador con `siigoDraftId` NO se vuelve a enviar salvo reenvío
 *   explícito (`reenviar: true`) que nombre el `siigoDraftIdAnterior` que el
 *   usuario vio; si ya no coincide con el guardado, alguien reenvió en medio y
 *   se rechaza (así un doble clic en "Reenviar" no crea dos borradores).
 * - Los envíos del mismo borrador se serializan con el advisory lock
 *   `siigo_envio:<id>` (try-lock: el segundo recibe "envío en curso" sin
 *   esperar). La comprobación y el guardado del id ocurren bajo ese lock.
 */

import { EstadoBorrador, Prisma } from "@prisma/client";

import { esObservacionDevolucion } from "@/lib/borradores/devolver";
import { ensureLineasFijas } from "@/lib/borradores/lineas-fijas";
import { FORMATO_CONCEPTOS_IVA } from "@/lib/borradores/formato-conceptos";
import { recalcularTotalBorrador } from "@/lib/borradores/recalculo";
import { getParametrosSistema } from "@/lib/parametros/service";
import { prisma } from "@/lib/db/prisma";

import {
  getToken,
  postFactura,
  SiigoApiError,
  SiigoConfigError,
  type SiigoFacturaItemDto,
  type SiigoFacturaPostDto,
  type SiigoFacturaPostResponse,
} from "./client";
import { ivaDelProducto } from "./impuestos-producto";
import { construirItemsSiigo, identificacionSiigo, lineasQueVanComoItem } from "./items-factura";

// ─── Resultado tipado ─────────────────────────────────────────────────────────

export type EnvioSiigoResult =
  | { ok: true; siigoDraftId: string; enviadoEn: string }
  | {
      ok: false;
      tipo: "estado" | "validacion" | "config" | "api" | "db";
      error: string;
    };

export interface OpcionesEnvioSiigo {
  /** Reenvío explícito ("Reenviar a SIIGO"): crea OTRO borrador en Siigo. */
  reenviar?: boolean;
  /** `siigoDraftId` que el usuario vio al confirmar el reenvío. */
  siigoDraftIdAnterior?: string | null;
}

// ─── Anti-duplicado ───────────────────────────────────────────────────────────

/** Serializa los envíos de un borrador (distinta de `borrador_lineas:`, que es de edición). */
export function lockKeyEnvioSiigo(borradorId: string): string {
  return `siigo_envio:${borradorId}`;
}

export const MENSAJE_ENVIO_EN_CURSO =
  "Ya hay un envío a SIIGO en curso para esta factura. Espera unos segundos y recarga la página antes de volver a intentarlo.";

/** Tope de espera a Siigo (token + POST); por debajo del timeout de la transacción. */
const TIMEOUT_SIIGO_MS = 45_000;
const TIMEOUT_TX_ENVIO_MS = TIMEOUT_SIIGO_MS + 30_000;

/**
 * Regla anti-duplicado, pura: devuelve el motivo de rechazo o null si se puede
 * enviar. Primer envío: el borrador no debe tener `siigoDraftId`. Reenvío: el
 * `siigoDraftIdAnterior` del cliente debe ser exactamente el guardado.
 */
export function motivoRechazoEnvioSiigo(
  actual: { siigoDraftId: string | null },
  opciones: OpcionesEnvioSiigo = {},
): string | null {
  if (!opciones.reenviar) {
    if (actual.siigoDraftId) {
      return `Esta factura ya se envió a SIIGO (borrador ${actual.siigoDraftId}). Para crear otro borrador usa «Reenviar a SIIGO» y descarta el anterior en el portal de SIIGO si no se ha estampado.`;
    }
    return null;
  }

  const anterior = opciones.siigoDraftIdAnterior?.trim() || null;
  if (!anterior) {
    return "Para reenviar a SIIGO hay que indicar cuál borrador de SIIGO se reemplaza.";
  }
  if (actual.siigoDraftId !== anterior) {
    return actual.siigoDraftId
      ? `Mientras tanto la factura se volvió a enviar a SIIGO (borrador actual ${actual.siigoDraftId}). Recarga la página y revisa el portal de SIIGO antes de reenviar.`
      : "Esta factura no tiene un envío previo a SIIGO. Recarga la página y usa «Enviar a SIIGO».";
  }
  return null;
}

function esTimeoutOAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bigintToPrice(valor: bigint): number {
  if (valor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Valor excede MAX_SAFE_INTEGER: ${valor.toString()}`);
  }
  return Number(valor);
}

function fechaHoy(): string {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, "0");
  const d = String(hoy.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Formatea un BigInt de COP al estilo "$ 26.844.137,00" — igual al usado en
 * las facturas reales de Galcomex (BAQ-18582, BAQ-18575, etc.).
 */
function formatCOP(valor: bigint): string {
  const formatted = new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(valor));
  return `$ ${formatted}`;
}

interface TotalesBorrador {
  totalFactura: bigint;
  totalAnticipo: bigint;
  saldoAFavorCliente: bigint;
  saldoACargoCliente: bigint;
}

function observacionesDesdeBorrador(
  comentariosCabecera: unknown,
  consecutivoDO: string | undefined,
  totales: TotalesBorrador,
  /** Las facturas de Galcomex propio dicen "SALDO A FAVOR/A CARGO"; las de Lucho "A SU FAVOR/A SU CARGO". */
  conSu = true,
): string {
  // Las notas "DEVUELTO POR …" son de revisión interna (lib/borradores/devolver.ts):
  // viven en comentariosCabecera para que se vean en la ficha, pero NO pueden
  // salir impresas en la factura del cliente.
  const comentarios = Array.isArray(comentariosCabecera)
    ? (comentariosCabecera as unknown[]).filter(
        (c): c is string =>
          typeof c === "string" && c.trim().length > 0 && !esObservacionDevolucion(c),
      )
    : [];

  // Header de comentarios (formato Lucho) o fallback con consecutivo del DO
  const header =
    comentarios.length > 0
      ? comentarios.join("\n")
      : consecutivoDO
        ? `DO ${consecutivoDO}`
        : "";

  // Bloque de totales (TOTAL FACTURA / VALOR ANTICIPO / SALDO A SU FAVOR|CARGO)
  // Replica el formato del PDF de Siigo. Tabs entre etiqueta y valor.
  const lineaTotal = `TOTAL FACTURA \t\t\t ${formatCOP(totales.totalFactura)}`;
  const lineaAnticipo = `VALOR ANTICIPO \t\t\t ${formatCOP(totales.totalAnticipo)}`;
  const lineaSaldo =
    totales.saldoAFavorCliente > 0n
      ? `SALDO A ${conSu ? "SU " : ""}FAVOR\t\t\t ${formatCOP(totales.saldoAFavorCliente)}`
      : totales.saldoACargoCliente > 0n
        ? `SALDO A ${conSu ? "SU " : ""}CARGO\t\t\t ${formatCOP(totales.saldoACargoCliente)}`
        : null;

  const bloqueTotales = [lineaTotal, lineaAnticipo, lineaSaldo]
    .filter((l): l is string => l !== null)
    .join("\n");

  // Header y totales separados por una línea en blanco (igual al PDF real)
  return [header, bloqueTotales].filter((p) => p.length > 0).join("\n\n");
}

// ─── Configuración desde BD ───────────────────────────────────────────────────

interface ConfigSiigo {
  tipoComprobanteId: number;
  idVendedor: number;
  /** NIT de la DIAN para enviar como tercero en la línea auto-fija de 4x1000. */
  nitDian: string | null;
}

async function leerConfigSiigo(): Promise<ConfigSiigo | { error: string }> {
  const clavesObligatorias = ["SIIGO_TIPO_COMPROBANTE_ID", "SIIGO_VENDEDOR_ID"];
  // SIIGO_NIT_DIAN es opcional; si no está, la línea 4x1000 sale sin tercero.
  // SIIGO_PRODUCTO_COMISION_ID / SIIGO_PRODUCTO_IVA_COMISION_ID /
  // SIIGO_PRODUCTO_4X1000_ID / SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID se validan
  // indirectamente cuando una línea fija queda sin `siigoProducto` asignado
  // (ver paso 4 — "Líneas sin producto SIIGO asignado").
  const clavesOpcionales = ["SIIGO_NIT_DIAN"];

  const params = await prisma.parametro.findMany({
    where: { clave: { in: [...clavesObligatorias, ...clavesOpcionales] } },
    select: { clave: true, valor: true },
  });

  const map = Object.fromEntries(params.map((p) => [p.clave, p.valor]));

  const faltantes = clavesObligatorias.filter((c) => !map[c]?.trim());
  if (faltantes.length > 0) {
    return {
      error: `Parámetros Siigo no configurados: ${faltantes.join(", ")}. Configúralos en Configuración → Siigo.`,
    };
  }

  const tipoNum = Number(map["SIIGO_TIPO_COMPROBANTE_ID"]);
  const vendedorNum = Number(map["SIIGO_VENDEDOR_ID"]);

  if (Number.isNaN(tipoNum) || Number.isNaN(vendedorNum)) {
    return {
      error: "SIIGO_TIPO_COMPROBANTE_ID y SIIGO_VENDEDOR_ID deben ser numéricos",
    };
  }

  return {
    tipoComprobanteId: tipoNum,
    idVendedor: vendedorNum,
    nitDian: map["SIIGO_NIT_DIAN"]?.trim() || null,
  };
}

// ─── Tercero del 4x1000 ───────────────────────────────────────────────────────

type PagoParaNit4x1000 = {
  canalPago: string;
  valor: bigint;
  bancoBeneficiario: { nit: string | null; nombre: string | null } | null;
};

/**
 * NIT fijo del Banco de Occidente S.A. — beneficiario del GMF (impuesto 4x1000).
 * La DIAN recauda el gravamen a través de los bancos; para Galcomex el banco
 * donde se concentran los movimientos del socio LM es Banco de Occidente.
 * Se usa SIEMPRE, independientemente del canal de pago del trámite.
 *
 * Política actualizada (C3): siempre Banco de Occidente (890300279).
 * La lógica condicional previa (Bancolombia vs otro banco) fue eliminada.
 */
export const NIT_BANCO_OCCIDENTE = "890300279";

/**
 * Devuelve el NIT del tercero para la línea 4x1000 del borrador.
 * SIEMPRE retorna el NIT del Banco de Occidente (890300279).
 * Los parámetros se mantienen en la firma para compatibilidad de call-sites existentes.
 */
export function resolverNit4x1000(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _pagos: PagoParaNit4x1000[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _nitFallback: string | null,
): string {
  return NIT_BANCO_OCCIDENTE;
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function enviarBorradorASiigo(
  borradorId: string,
  usuarioId: string,
  opciones: OpcionesEnvioSiigo = {},
): Promise<EnvioSiigoResult> {
  // ── 0. Backfill líneas fijas (idempotente, también para borradores APROBADO) ──
  // Borradores generados antes del modelo "4 conceptos = LineaRevision" pueden
  // no tener las líneas COMISION / IVA_COMISION / COSTOS_BANCARIOS /
  // IMPUESTO_4X1000. Se crean a partir de los campos `borrador.comision` /
  // `ivaComision` / `costosBancarios` / `impuesto4x1000` para que `Σ items =
  // totalFactura`. La operación no altera totales (recalcular espeja los mismos
  // valores) ni reabre el snapshot del borrador.
  try {
    await prisma.$transaction(async (tx) => {
      // Crea líneas: mismo lock que la edición de líneas, para que dos envíos
      // simultáneos no dupliquen las fijas antes de llegar al lock de envío.
      const lockLineas = `borrador_lineas:${borradorId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockLineas}))`;
      await ensureLineasFijas(tx, borradorId);
      await recalcularTotalBorrador(tx, borradorId);
    });
  } catch (err) {
    // Si el borrador no existe, lo manejamos abajo con findUnique. Otros errores
    // del backfill se propagan al persistirErrorSiigo.
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")
    ) {
      throw err;
    }
  }

  // ── 1. Cargar borrador con todo lo necesario ────────────────────────────────
  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    include: {
      tramite: {
        select: {
          id: true,
          consecutivo: true,
          cliente: { select: { nit: true, nombre: true } },
          // Pagos del trámite para resolver el tercero del 4x1000:
          // Bancolombia (todos los pagos con TRANSF_BANCOLOMBIA) → NIT
          // Bancolombia; cualquier otro canal → NIT del banco asociado al pago.
          pagos: {
            orderBy: { orden: "asc" },
            select: {
              canalPago: true,
              valor: true,
              bancoBeneficiario: { select: { nit: true, nombre: true } },
            },
          },
        },
      },
      formaPago: true,
      lineasRevision: {
        orderBy: { orden: "asc" },
        include: {
          siigoProducto: {
            select: {
              id: true,
              codigo: true,
              clasificacionIva: true,
              impuestos: {
                include: {
                  impuesto: { select: { id: true, tipo: true, porcentaje: true } },
                },
              },
            },
          },
          facturas: {
            select: {
              factura: {
                select: {
                  proveedorNit: true,
                  beneficiario: { select: { nit: true, nombre: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!borrador) {
    return { ok: false, tipo: "estado", error: "Borrador no encontrado" };
  }

  if (borrador.estado !== EstadoBorrador.APROBADO) {
    return {
      ok: false,
      tipo: "estado",
      error: `El borrador debe estar APROBADO para enviarse a SIIGO (estado actual: ${borrador.estado})`,
    };
  }

  // Aviso temprano; la comprobación que cuenta se repite bajo el lock (paso 6).
  const rechazoTemprano = motivoRechazoEnvioSiigo(borrador, opciones);
  if (rechazoTemprano) {
    return { ok: false, tipo: "estado", error: rechazoTemprano };
  }

  const nitCliente = borrador.tramite.cliente?.nit?.trim();
  if (!nitCliente) {
    return {
      ok: false,
      tipo: "validacion",
      error: "El cliente del trámite no tiene NIT registrado",
    };
  }

  if (!borrador.formaPagoSiigoId) {
    return {
      ok: false,
      tipo: "validacion",
      error: "Selecciona la forma de pago (contado o crédito) antes de enviar a SIIGO.",
    };
  }

  // ── 2. Leer configuración desde BD ─────────────────────────────────────────
  const config = await leerConfigSiigo();
  if ("error" in config) {
    return { ok: false, tipo: "config", error: config.error };
  }

  // ── 4. Validar líneas de revisión ───────────────────────────────────────────
  // Las 4 conceptos fijos (COMISION, IVA_COMISION, COSTOS_BANCARIOS,
  // IMPUESTO_4X1000) son LineaRevision con `tipoFija`. Junto con las líneas
  // manuales TERCEROS / OPERACIONAL forman la totalidad de los items que se
  // envían a Siigo. La invariante crítica es:
  //
  //   Σ items.price = totalFactura − retenciones
  //
  // Por eso TODAS las líneas con valor > 0 deben tener `siigoProducto.codigo`
  // y los items se mandan SIN `taxes` auto (el IVA va como su propia línea
  // IVA_COMISION para que Siigo no recalcule por encima).
  const conceptosIva = borrador.formatoFactura === FORMATO_CONCEPTOS_IVA;
  // En CONCEPTOS_IVA la línea IVA_COMISION no viaja: Siigo liquida el IVA por ítem.
  const lineasFacturables = lineasQueVanComoItem(
    borrador.lineasRevision,
    borrador.formatoFactura,
  );

  const lineasSinProducto = lineasFacturables
    .filter((l) => !l.siigoProducto?.codigo)
    .map((l) => `#${l.orden} "${l.concepto}"`);

  if (lineasSinProducto.length > 0) {
    return {
      ok: false,
      tipo: "validacion",
      error: `Líneas sin producto SIIGO asignado: ${lineasSinProducto.join(", ")}. Configura los parámetros SIIGO_PRODUCTO_* o asigna el producto en el editor.`,
    };
  }

  // Validar que líneas TERCEROS manuales (sin tipoFija) tengan NIT de tercero.
  // El NIT puede venir de tres fuentes (en orden de preferencia):
  //   1. `linea.nitTercero` — capturado a mano en el editor cuando no hay factura.
  //   2. `factura.beneficiario.nit` — para líneas con factura de proveedor vinculada.
  //   3. `factura.proveedorNit` — fallback histórico del legacy.
  // Las fijas IMPUESTO_4X1000 y COSTOS_BANCARIOS resuelven su tercero aparte
  // (4x1000 → banco GMF; costos → no requiere tercero específico).
  const lineasTercerosSinNit = lineasFacturables
    .filter((l) => l.seccion === "TERCEROS" && !l.tipoFija)
    .filter((l) => {
      if (l.nitTercero?.trim()) return false;
      const primeraFactura = l.facturas[0]?.factura ?? null;
      const nit =
        primeraFactura?.beneficiario?.nit?.trim() ||
        primeraFactura?.proveedorNit?.trim() ||
        null;
      return nit === null;
    })
    .map((l) => {
      const sinFactura = l.facturas.length === 0;
      return `#${l.orden} "${l.concepto}"${sinFactura ? " (sin factura ni NIT manual)" : " (proveedor sin NIT)"}`;
    });

  if (lineasTercerosSinNit.length > 0) {
    return {
      ok: false,
      tipo: "validacion",
      error: `Líneas TERCEROS sin NIT de tercero: ${lineasTercerosSinNit.join(", ")}. Captura un NIT manualmente o vincula una factura con beneficiario.`,
    };
  }

  // ── 5. Construir items para SIIGO ───────────────────────────────────────────
  // Orden: TERCEROS primero, OPERACIONAL después; dentro de cada sección por
  // `orden` (ver `construirItemsSiigo`, con casos de prueba contra BAQ-18385).

  // NIT del banco GMF: lo calculamos una sola vez y se aplica solo a la línea
  // IMPUESTO_4X1000.
  const nit4x1000 = resolverNit4x1000(borrador.tramite.pagos, config.nitDian);

  // Helper: NIT del tercero para una línea TERCEROS manual (para "Id. Tercero"
  // en el PDF). Orden de preferencia:
  //   1. `linea.nitTercero` — capturado a mano (líneas sin factura).
  //   2. `factura.beneficiario.nit` — más confiable que el proveedor.
  //   3. `factura.proveedorNit` — fallback histórico.
  function nitTerceroDe(
    l: (typeof lineasFacturables)[number],
  ): string | null {
    if (l.nitTercero?.trim()) return l.nitTercero.trim();
    const factura = l.facturas[0]?.factura ?? null;
    return (
      factura?.beneficiario?.nit?.trim() ||
      factura?.proveedorNit?.trim() ||
      null
    );
  }

  // CONCEPTOS_IVA: IVA por ítem y ReteIVA a nivel de factura, por id de impuesto
  // Siigo (catálogo sincronizado en `siigo_impuesto`).
  let ivaTaxId: number | null = null;
  /** Tasa con la que el motor liquidó el IVA; solo se acepta el impuesto del producto si coincide. */
  let tasaIvaFactura: bigint | null = null;
  let retentions: Array<{ id: number }> | undefined;
  if (conceptosIva) {
    const [params, impuestos] = await Promise.all([
      getParametrosSistema(),
      prisma.siigoImpuesto.findMany({
        where: { activo: true, tipo: { in: ["IVA", "ReteIVA"] } },
        select: { id: true, tipo: true, porcentaje: true },
      }),
    ]);
    const buscar = (tipo: string, porcentaje: number) =>
      impuestos.find((i) => i.tipo === tipo && Number(i.porcentaje) === porcentaje)?.id ?? null;

    tasaIvaFactura = params.tasaIva;
    ivaTaxId = buscar("IVA", Number(params.tasaIva));
    if (
      ivaTaxId === null &&
      lineasFacturables.some(
        (l) =>
          l.aplicaIva &&
          ivaDelProducto(
            (l.siigoProducto?.impuestos ?? []).map((i) => i.impuesto),
            params.tasaIva,
          ) === null,
      )
    ) {
      return {
        ok: false,
        tipo: "config",
        error: `No está el impuesto "IVA ${params.tasaIva}%" en el catálogo Siigo. Sincroniza los impuestos en Configuración → Siigo.`,
      };
    }

    if (borrador.retenciones > 0n) {
      if (borrador.reteIvaPorcentaje === null) {
        return {
          ok: false,
          tipo: "validacion",
          error:
            "Las retenciones se capturaron a mano y Siigo necesita saber cuál es. Configura el % de ReteIVA en la función de la empresa y vuelve a generar el borrador.",
        };
      }
      const reteIvaId = buscar("ReteIVA", borrador.reteIvaPorcentaje);
      if (reteIvaId === null) {
        return {
          ok: false,
          tipo: "config",
          error: `No está el impuesto "ReteIVA ${borrador.reteIvaPorcentaje}%" en el catálogo Siigo. Sincroniza los impuestos en Configuración → Siigo.`,
        };
      }
      retentions = [{ id: reteIvaId }];
    }
  }

  const items: SiigoFacturaItemDto[] = construirItemsSiigo(
    lineasFacturables.map((l) => ({
      concepto: l.concepto,
      valor: l.valor,
      orden: l.orden,
      seccion: l.seccion,
      tipoFija: l.tipoFija,
      aplicaIva: l.aplicaIva,
      productoCodigo: l.siigoProducto?.codigo ?? null,
      nitTercero: l.seccion === "TERCEROS" && !l.tipoFija ? nitTerceroDe(l) : null,
      // El IVA configurado en el propio producto Siigo manda sobre el global.
      ivaProductoId:
        tasaIvaFactura === null
          ? null
          : ivaDelProducto(
              (l.siigoProducto?.impuestos ?? []).map((i) => i.impuesto),
              tasaIvaFactura,
            ),
    })),
    { formato: borrador.formatoFactura, ivaTaxId, nit4x1000 },
  );

  const fechaEnvio = fechaHoy();
  const observaciones = observacionesDesdeBorrador(
    borrador.comentariosCabecera,
    borrador.tramite.consecutivo,
    {
      totalFactura: borrador.totalFactura,
      totalAnticipo: borrador.totalAnticipo,
      saldoAFavorCliente: borrador.saldoAFavorCliente,
      saldoACargoCliente: borrador.saldoACargoCliente,
    },
    !conceptosIva,
  );

  const dto: SiigoFacturaPostDto = {
    document: { id: config.tipoComprobanteId },
    date: fechaEnvio,
    customer: { identification: identificacionSiigo(nitCliente), branch_office: 0 },
    seller: config.idVendedor,
    observations: observaciones || undefined,
    items,
    payments: [
      {
        id: borrador.formaPagoSiigoId!,
        value: bigintToPrice(borrador.totalFactura),
        due_date: fechaEnvio,
      },
    ],
    ...(retentions ? { retentions } : {}),
    // Crítico: queda como BORRADOR en Siigo. Un superior valida y estampa.
    stamp: { send: false },
  };

  // ── 6. Bajo lock: re-validar, llamar a SIIGO y guardar el id ────────────────
  // El lock se mantiene durante el POST: un envío simultáneo recibe "envío en
  // curso" y uno posterior ya ve el siigoDraftId guardado (regla anti-duplicado
  // en la cabecera del archivo).
  const lockKey = lockKeyEnvioSiigo(borrador.id);
  const tramiteId = borrador.tramite.id;
  // Holders: se asignan dentro del callback y se leen en el catch externo.
  const enviado: { respuesta: SiigoFacturaPostResponse | null } = { respuesta: null };
  const fallido: { resultado: EnvioSiigoResult | null } = { resultado: null };

  try {
    return await prisma.$transaction(
      async (tx): Promise<EnvioSiigoResult> => {
        const [fila] = await tx.$queryRaw<Array<{ tomado: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS tomado`;
        if (!fila?.tomado) {
          return { ok: false, tipo: "estado", error: MENSAJE_ENVIO_EN_CURSO };
        }

        const actual = await tx.borradorFactura.findUnique({
          where: { id: borrador.id },
          select: { estado: true, siigoDraftId: true },
        });
        if (!actual) {
          return { ok: false, tipo: "estado", error: "Borrador no encontrado" };
        }
        if (actual.estado !== EstadoBorrador.APROBADO) {
          return {
            ok: false,
            tipo: "estado",
            error: `El borrador debe estar APROBADO para enviarse a SIIGO (estado actual: ${actual.estado})`,
          };
        }
        const rechazo = motivoRechazoEnvioSiigo(actual, opciones);
        if (rechazo) {
          return { ok: false, tipo: "estado", error: rechazo };
        }

        let respuesta: SiigoFacturaPostResponse;
        try {
          const signal = AbortSignal.timeout(TIMEOUT_SIIGO_MS);
          const token = await getToken({ signal });
          respuesta = await postFactura(token, dto, { signal });
          enviado.respuesta = respuesta;
        } catch (err) {
          fallido.resultado = await persistirErrorSiigo(tx, borrador.id, tramiteId, usuarioId, err);
          return fallido.resultado;
        }

        const enviadoEn = new Date();
        await persistirExitoSiigo(tx, {
          borradorId: borrador.id,
          tramiteId,
          usuarioId,
          respuesta,
          enviadoEn,
          siigoDraftIdAnterior: actual.siigoDraftId,
          reenvio: Boolean(opciones.reenviar),
        });
        return { ok: true, siigoDraftId: respuesta.id, enviadoEn: enviadoEn.toISOString() };
      },
      { maxWait: 10_000, timeout: TIMEOUT_TX_ENVIO_MS },
    );
  } catch (err) {
    const respuesta = enviado.respuesta;
    if (respuesta) {
      // Siigo SÍ creó el borrador pero la transacción falló: guardar el id
      // aunque sea sin lock, para que nadie lo reenvíe a ciegas.
      const enviadoEn = new Date();
      try {
        await prisma.$transaction((tx) =>
          persistirExitoSiigo(tx, {
            borradorId: borrador.id,
            tramiteId,
            usuarioId,
            respuesta,
            enviadoEn,
            siigoDraftIdAnterior: borrador.siigoDraftId,
            reenvio: Boolean(opciones.reenviar),
          }),
        );
        return { ok: true, siigoDraftId: respuesta.id, enviadoEn: enviadoEn.toISOString() };
      } catch (errGuardado) {
        const detalle = errGuardado instanceof Error ? errGuardado.message : "Error de persistencia";
        return {
          ok: false,
          tipo: "db",
          error: `SIIGO creó el borrador ${respuesta.name} (id ${respuesta.id}), pero Galcomex no pudo guardarlo: ${detalle}. No lo reenvíes: anota el id y avisa a soporte.`,
        };
      }
    }
    if (fallido.resultado) return fallido.resultado;
    throw err;
  }
}

async function persistirExitoSiigo(
  db: Prisma.TransactionClient,
  datos: {
    borradorId: string;
    tramiteId: string;
    usuarioId: string;
    respuesta: SiigoFacturaPostResponse;
    enviadoEn: Date;
    siigoDraftIdAnterior: string | null;
    reenvio: boolean;
  },
): Promise<void> {
  await db.borradorFactura.update({
    where: { id: datos.borradorId },
    data: {
      siigoDraftId: datos.respuesta.id,
      enviadoASiigoEn: datos.enviadoEn,
      ultimoErrorSiigo: null,
      ultimoIntentoSiigo: datos.enviadoEn,
    },
  });
  await db.auditLog.create({
    data: {
      entidad: "BorradorFactura",
      entidadId: datos.borradorId,
      accion: "SIIGO_ENVIAR_OK",
      usuarioId: datos.usuarioId,
      tramiteId: datos.tramiteId,
      antes: { siigoDraftIdAnterior: datos.siigoDraftIdAnterior },
      despues: {
        siigoDraftId: datos.respuesta.id,
        enviadoASiigoEn: datos.enviadoEn.toISOString(),
        siigoConsecutivoBorrador: datos.respuesta.name,
        reenvio: datos.reenvio,
      } as Prisma.InputJsonValue,
    },
  });
}

async function persistirErrorSiigo(
  db: Prisma.TransactionClient,
  borradorId: string,
  tramiteId: string,
  usuarioId: string,
  err: unknown,
): Promise<EnvioSiigoResult> {
  const tipo: "config" | "api" =
    err instanceof SiigoConfigError ? "config" : "api";
  const sinRespuesta = esTimeoutOAbort(err);
  const status =
    err instanceof SiigoApiError ? err.status : tipo === "config" ? 503 : sinRespuesta ? 504 : 502;
  const mensaje = sinRespuesta
    ? `SIIGO no respondió en ${TIMEOUT_SIIGO_MS / 1000} s. Antes de reintentar, revisa en el portal de SIIGO si el borrador alcanzó a crearse.`
    : err instanceof Error
      ? err.message
      : "Error desconocido enviando a SIIGO";

  try {
    await db.borradorFactura.update({
      where: { id: borradorId },
      data: {
        ultimoErrorSiigo: mensaje,
        ultimoIntentoSiigo: new Date(),
      },
    });
    await db.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: borradorId,
        accion: "SIIGO_ENVIAR_ERROR",
        usuarioId,
        tramiteId,
        despues: { error: mensaje, status, tipo } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // No bloqueamos el error original si la persistencia falla.
  }

  return { ok: false, tipo, error: mensaje };
}
