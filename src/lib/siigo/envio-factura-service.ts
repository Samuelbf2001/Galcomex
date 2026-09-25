/**
 * Servicio de envío de borradores aprobados a la API de SIIGO **como borrador
 * (DRAFT)**.
 *
 * La factura NO se factura desde Galcomex: se crea en Siigo con stamp.send=false
 * para que quede como borrador, y un usuario superior la valida y la estampa
 * manualmente desde el portal Siigo. El consecutivo definitivo llega después
 * por "Sincronizar desde SIIGO" o por el flujo manual de "Marcar facturado".
 *
 * Configuración leída desde BD (tabla Parametro):
 *   SIIGO_TIPO_COMPROBANTE_ID  → ID numérico del tipo de documento Siigo
 *   SIIGO_VENDEDOR_ID          → ID numérico del vendedor (usuario Siigo)
 *   SIIGO_PRODUCTO_COMISION_ID → UUID del SiigoProducto para línea de comisión
 *
 * ── Una factura, un solo POST (auditoría 25-sep-2026) ────────────────────────
 * Cada POST /v1/invoices crea un documento que, estampado, es una factura legal
 * ante la DIAN. Por eso:
 *
 * 1. Antes de llamar a Siigo el borrador se RECLAMA con un UPDATE condicional
 *    (APROBADO, sin siigoDraftId, envío null|ERROR → ENVIANDO + intentoId). Si
 *    no se actualiza ninguna fila, otro envío ganó o ya se envió →
 *    `EnvioSiigoBloqueadoError` (409). Dos clics simultáneos = un solo POST.
 * 2. El resultado se clasifica (`clasificarFalloEnvioSiigo`):
 *    - 2xx con id → ENVIADO (siigoDraftId guardado). AuditLog SIIGO_ENVIAR_OK.
 *    - Rechazo definitivo de Siigo antes de crear (400/401/403/404/422/429) o
 *      fallo antes del POST (credenciales, token) → ERROR: se puede reintentar.
 *      AuditLog SIIGO_ENVIAR_ERROR.
 *    - Timeout, error de red, 5xx, 2xx ilegible o sin consecutivo, o fallo de
 *      la BD tras un 2xx → INCIERTO: reintento BLOQUEADO hasta que un ADMIN
 *      revise en Siigo (`resolver-envio-service.ts`). AuditLog
 *      SIIGO_ENVIAR_INCIERTO. Si el 2xx traía id, se guarda igual.
 * 3. El POST jamás se reintenta automáticamente, y un borrador con
 *    siigoDraftId nunca se vuelve a enviar (ya no existe «Reenviar»).
 * 4. Un ENVIANDO de más de 10 minutos se presenta como INCIERTO
 *    (`estado-envio.ts`); no se reintenta solo.
 *
 * El borrador sigue en APROBADO en todos los casos.
 */

import { randomUUID } from "node:crypto";

import { EstadoBorrador, Prisma, SiigoEnvioEstado } from "@prisma/client";

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
  SiigoRespuestaInvalidaError,
  TIMEOUT_SIIGO_MS,
  type SiigoFacturaItemDto,
  type SiigoFacturaPostDto,
  type SiigoFacturaPostResponse,
} from "./client";
import { BorradorSiigoNoEncontradoError, EnvioSiigoBloqueadoError } from "./errores-envio";
import {
  detalleEnvioBloqueado,
  puedeEnviarASiigo,
  type SiigoEnvioEstadoValor,
} from "./estado-envio";
import { ivaDelProducto } from "./impuestos-producto";
import { construirItemsSiigo, identificacionSiigo, lineasQueVanComoItem } from "./items-factura";

// ─── Resultado tipado ─────────────────────────────────────────────────────────

export type EnvioSiigoResult =
  | { ok: true; siigoDraftId: string; enviadoEn: string; siigoEnvioEstado: "ENVIADO" }
  | {
      ok: false;
      /** `incierto`: no sabemos si Siigo creó la factura; no reintentar. */
      tipo: "estado" | "validacion" | "config" | "api" | "incierto" | "db";
      error: string;
      /** Estado del envío tras el intento (ausente si no se llegó a reclamar). */
      siigoEnvioEstado?: SiigoEnvioEstadoValor | null;
      siigoDraftId?: string | null;
    };

// ─── Clasificación del resultado ─────────────────────────────────────────────

/**
 * Códigos con los que Siigo rechaza el POST SIN crear la factura (validación,
 * credenciales, límite de peticiones). Cualquier otro (408, 409, 5xx…) es
 * dudoso.
 */
export const STATUS_RECHAZO_DEFINITIVO: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 422, 429,
]);

/**
 * ¿El fallo deja la factura con certeza SIN crear (ERROR, se puede reintentar)
 * o pudo haberse creado (INCIERTO, bloqueado)? Pura.
 *
 * @param postIntentado  true si el POST /v1/invoices llegó a salir.
 */
export function clasificarFalloEnvioSiigo(
  err: unknown,
  postIntentado: boolean,
): "ERROR" | "INCIERTO" {
  if (!postIntentado) return "ERROR";
  if (err instanceof SiigoConfigError) return "ERROR";
  if (err instanceof SiigoApiError && STATUS_RECHAZO_DEFINITIVO.has(err.status)) return "ERROR";
  return "INCIERTO";
}

function esTimeoutOAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

const INSTRUCCION_INCIERTO =
  "No la reenvíes: puede que SIIGO sí la haya creado. Un ADMIN debe usar «Revisar en SIIGO».";

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

  // Aviso temprano (con el motivo concreto); la comprobación que cuenta es el
  // reclamo atómico del paso 6.
  if (!puedeEnviarASiigo(borrador)) {
    throw new EnvioSiigoBloqueadoError(detalleEnvioBloqueado(borrador));
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

  // ── 6. Reclamar el envío ANTES de tocar Siigo ───────────────────────────────
  // UPDATE condicional atómico: de dos envíos simultáneos solo uno actualiza la
  // fila; el otro recibe 409 sin llamar a Siigo.
  const intentoId = randomUUID();
  const iniciadoEn = new Date();
  const reclamo = await prisma.borradorFactura.updateMany({
    where: {
      id: borrador.id,
      estado: EstadoBorrador.APROBADO,
      siigoDraftId: null,
      OR: [{ siigoEnvioEstado: null }, { siigoEnvioEstado: SiigoEnvioEstado.ERROR }],
    },
    data: {
      siigoEnvioEstado: SiigoEnvioEstado.ENVIANDO,
      siigoEnvioIniciadoAt: iniciadoEn,
      siigoEnvioIntentoId: intentoId,
      ultimoIntentoSiigo: iniciadoEn,
    },
  });

  if (reclamo.count === 0) {
    const actual = await prisma.borradorFactura.findUnique({
      where: { id: borrador.id },
      select: {
        estado: true,
        siigoDraftId: true,
        siigoEnvioEstado: true,
        siigoEnvioIniciadoAt: true,
      },
    });
    if (!actual) throw new BorradorSiigoNoEncontradoError();
    if (actual.estado !== EstadoBorrador.APROBADO) {
      return {
        ok: false,
        tipo: "estado",
        error: `El borrador debe estar APROBADO para enviarse a SIIGO (estado actual: ${actual.estado})`,
      };
    }
    throw new EnvioSiigoBloqueadoError(detalleEnvioBloqueado(actual));
  }

  // ── 7. Llamar a Siigo (una sola vez) y registrar el resultado ──────────────
  const contexto: ContextoIntento = {
    borradorId: borrador.id,
    tramiteId: borrador.tramite.id,
    usuarioId,
    intentoId,
  };

  let respuesta: SiigoFacturaPostResponse;
  let postIntentado = false;
  try {
    const token = await getToken();
    postIntentado = true;
    respuesta = await postFactura(token, dto);
  } catch (err) {
    return registrarFalloEnvio(contexto, err, postIntentado);
  }
  return registrarExitoEnvio(contexto, respuesta);
}

// ─── Registro del resultado ───────────────────────────────────────────────────

type ContextoIntento = {
  borradorId: string;
  tramiteId: string;
  usuarioId: string;
  /** Id del reclamo: solo este intento puede escribir su resultado. */
  intentoId: string;
};

async function registrarExitoEnvio(
  ctx: ContextoIntento,
  respuesta: SiigoFacturaPostResponse,
): Promise<EnvioSiigoResult> {
  let ultimoError: unknown = null;

  // La BD pudo fallar justo después de que Siigo creara la factura: se intenta
  // guardar dos veces antes de rendirse.
  for (let intento = 1; intento <= 2; intento += 1) {
    const enviadoEn = new Date();
    try {
      const aplicado = await prisma.$transaction(async (tx) => {
        const r = await tx.borradorFactura.updateMany({
          where: { id: ctx.borradorId, siigoEnvioIntentoId: ctx.intentoId },
          data: {
            siigoDraftId: respuesta.id,
            siigoEnvioEstado: SiigoEnvioEstado.ENVIADO,
            enviadoASiigoEn: enviadoEn,
            ultimoErrorSiigo: null,
            ultimoIntentoSiigo: enviadoEn,
          },
        });
        if (r.count === 0) return false;
        await tx.auditLog.create({
          data: {
            entidad: "BorradorFactura",
            entidadId: ctx.borradorId,
            accion: "SIIGO_ENVIAR_OK",
            usuarioId: ctx.usuarioId,
            tramiteId: ctx.tramiteId,
            antes: { siigoEnvioEstado: SiigoEnvioEstado.ENVIANDO, siigoDraftId: null },
            despues: {
              siigoEnvioEstado: SiigoEnvioEstado.ENVIADO,
              siigoDraftId: respuesta.id,
              enviadoASiigoEn: enviadoEn.toISOString(),
              siigoConsecutivoBorrador: respuesta.name,
              intentoId: ctx.intentoId,
            } as Prisma.InputJsonValue,
          },
        });
        return true;
      });

      if (!aplicado) {
        // El reclamo ya no es de este intento (un ADMIN lo liberó mientras Siigo
        // tardaba). La factura existe en Siigo: se deja rastro y no se pisa nada.
        const mensaje = `SIIGO creó el borrador ${respuesta.name} (id ${respuesta.id}) con un envío que ya había sido reemplazado. Revisa en el portal de SIIGO si quedó duplicada y anula la sobrante.`;
        console.error(`[siigo] ${mensaje} borrador=${ctx.borradorId} intento=${ctx.intentoId}`);
        await auditarSinFallar(ctx, "SIIGO_ENVIAR_INCIERTO", {
          error: mensaje,
          siigoDraftIdHuerfano: respuesta.id,
          intentoId: ctx.intentoId,
        });
        return { ok: false, tipo: "incierto", error: mensaje };
      }

      return {
        ok: true,
        siigoDraftId: respuesta.id,
        enviadoEn: enviadoEn.toISOString(),
        siigoEnvioEstado: "ENVIADO",
      };
    } catch (err) {
      ultimoError = err;
    }
  }

  // No se pudo guardar como ENVIADO. Último recurso: guardar al menos el id
  // (sin AuditLog, por si era éste el que fallaba) y dejarlo INCIERTO.
  const detalle = ultimoError instanceof Error ? ultimoError.message : "Error de persistencia";
  const mensaje = `SIIGO creó el borrador ${respuesta.name} (id ${respuesta.id}), pero Galcomex no pudo guardarlo: ${detalle}. No lo reenvíes: anota el id y avisa a soporte.`;
  console.error(`[siigo] ${mensaje} borrador=${ctx.borradorId} intento=${ctx.intentoId}`);
  let idGuardado = false;
  try {
    const r = await prisma.borradorFactura.updateMany({
      where: { id: ctx.borradorId, siigoEnvioIntentoId: ctx.intentoId },
      data: {
        siigoDraftId: respuesta.id,
        siigoEnvioEstado: SiigoEnvioEstado.INCIERTO,
        ultimoErrorSiigo: mensaje,
        ultimoIntentoSiigo: new Date(),
      },
    });
    idGuardado = r.count > 0;
  } catch {
    // La fila queda en ENVIANDO y a los 10 minutos se presenta como INCIERTO.
  }
  await auditarSinFallar(ctx, "SIIGO_ENVIAR_INCIERTO", {
    error: mensaje,
    siigoDraftId: respuesta.id,
    intentoId: ctx.intentoId,
  });
  return {
    ok: false,
    tipo: "db",
    error: mensaje,
    siigoEnvioEstado: "INCIERTO",
    siigoDraftId: idGuardado ? respuesta.id : null,
  };
}

async function registrarFalloEnvio(
  ctx: ContextoIntento,
  err: unknown,
  postIntentado: boolean,
): Promise<EnvioSiigoResult> {
  const clase = clasificarFalloEnvioSiigo(err, postIntentado);
  const idRecuperado = err instanceof SiigoRespuestaInvalidaError ? err.idRecuperado : null;
  const sinRespuesta = esTimeoutOAbort(err);
  const status =
    err instanceof SiigoApiError || err instanceof SiigoRespuestaInvalidaError
      ? err.status
      : err instanceof SiigoConfigError
        ? 503
        : sinRespuesta
          ? 504
          : 502;

  const base = sinRespuesta
    ? `SIIGO no respondió en ${TIMEOUT_SIIGO_MS / 1000} s`
    : err instanceof Error
      ? err.message
      : "Error desconocido enviando a SIIGO";
  const mensaje =
    clase === "ERROR"
      ? base
      : idRecuperado
        ? `${base}. SIIGO devolvió el id ${idRecuperado} y quedó guardado; un ADMIN debe confirmarlo con «Revisar en SIIGO».`
        : `${base}. ${INSTRUCCION_INCIERTO}`;

  const estado = clase === "ERROR" ? SiigoEnvioEstado.ERROR : SiigoEnvioEstado.INCIERTO;
  let idGuardado = false;
  let registrado = false;
  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.borradorFactura.updateMany({
        where: { id: ctx.borradorId, siigoEnvioIntentoId: ctx.intentoId },
        data: {
          siigoEnvioEstado: estado,
          ultimoErrorSiigo: mensaje,
          ultimoIntentoSiigo: new Date(),
          ...(idRecuperado ? { siigoDraftId: idRecuperado } : {}),
        },
      });
      registrado = r.count > 0;
      idGuardado = Boolean(idRecuperado) && registrado;
      await tx.auditLog.create({
        data: {
          entidad: "BorradorFactura",
          entidadId: ctx.borradorId,
          accion: clase === "ERROR" ? "SIIGO_ENVIAR_ERROR" : "SIIGO_ENVIAR_INCIERTO",
          usuarioId: ctx.usuarioId,
          tramiteId: ctx.tramiteId,
          antes: { siigoEnvioEstado: SiigoEnvioEstado.ENVIANDO },
          despues: {
            siigoEnvioEstado: estado,
            error: mensaje,
            status,
            postIntentado,
            siigoDraftIdRecuperado: idRecuperado,
            intentoId: ctx.intentoId,
            aplicado: r.count > 0,
          } as Prisma.InputJsonValue,
        },
      });
    });
  } catch (errDb) {
    // Si no se pudo registrar, la fila queda en ENVIANDO: a los 10 minutos se
    // presenta como INCIERTO (bloqueado). Nunca queda libre para reenviar.
    idGuardado = false;
    registrado = false;
    console.error(
      `[siigo] no se pudo registrar el fallo del envío borrador=${ctx.borradorId} intento=${ctx.intentoId}:`,
      errDb,
    );
  }

  if (!registrado) {
    // Sin el resultado guardado el envío sigue reclamado (ENVIANDO → INCIERTO):
    // bloqueado aunque el fallo fuera un rechazo definitivo. Lo decide un ADMIN.
    return {
      ok: false,
      tipo: clase === "INCIERTO" ? "incierto" : "db",
      error: `${mensaje}. Galcomex no pudo guardar el resultado: el envío queda bloqueado hasta que un ADMIN lo revise.`,
      siigoEnvioEstado: "ENVIANDO",
      siigoDraftId: null,
    };
  }

  return {
    ok: false,
    tipo: clase === "INCIERTO" ? "incierto" : err instanceof SiigoConfigError ? "config" : "api",
    error: mensaje,
    siigoEnvioEstado: estado,
    siigoDraftId: idGuardado ? idRecuperado : null,
  };
}

async function auditarSinFallar(
  ctx: ContextoIntento,
  accion: string,
  despues: Record<string, string | null>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        entidad: "BorradorFactura",
        entidadId: ctx.borradorId,
        accion,
        usuarioId: ctx.usuarioId,
        tramiteId: ctx.tramiteId,
        despues: despues as Prisma.InputJsonValue,
      },
    });
  } catch {
    // El rastro principal ya quedó en el log del servidor.
  }
}
