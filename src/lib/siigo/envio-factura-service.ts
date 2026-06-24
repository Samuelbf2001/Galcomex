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
 */

import { EstadoBorrador, Prisma } from "@prisma/client";

import { ensureLineasFijas } from "@/lib/borradores/lineas-fijas";
import { recalcularTotalBorrador } from "@/lib/borradores/recalculo";
import { prisma } from "@/lib/db/prisma";

import {
  getToken,
  postFactura,
  SiigoApiError,
  SiigoConfigError,
  type SiigoFacturaItemDto,
  type SiigoFacturaPostDto,
} from "./client";

// ─── Resultado tipado ─────────────────────────────────────────────────────────

export type EnvioSiigoResult =
  | { ok: true; siigoDraftId: string; enviadoEn: string }
  | {
      ok: false;
      tipo: "estado" | "validacion" | "config" | "api" | "db";
      error: string;
    };

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
): string {
  const comentarios = Array.isArray(comentariosCabecera)
    ? (comentariosCabecera as unknown[]).filter(
        (c): c is string => typeof c === "string" && c.trim().length > 0,
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
      ? `SALDO A SU FAVOR\t\t\t ${formatCOP(totales.saldoAFavorCliente)}`
      : totales.saldoACargoCliente > 0n
        ? `SALDO A SU CARGO\t\t\t ${formatCOP(totales.saldoACargoCliente)}`
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
 * Decide el NIT que va como tercero en la línea 4x1000.
 *
 * Política:
 *  1. Si TODOS los pagos del trámite son TRANSF_BANCOLOMBIA → usa el NIT del
 *     Beneficiario Bancolombia asociado al primer pago (auto-fill al crear).
 *  2. Si hay algún pago con canal distinto → usa el NIT del banco del primer
 *     pago non-Bancolombia que tenga banco asignado.
 *  3. Fallback: el NIT DIAN configurado (compatibilidad con datos previos).
 */
export function resolverNit4x1000(
  pagos: PagoParaNit4x1000[],
  nitDianFallback: string | null,
): string | null {
  if (pagos.length === 0) return nitDianFallback;

  const todosBancolombia = pagos.every(
    (p) => p.canalPago === "TRANSF_BANCOLOMBIA",
  );

  if (todosBancolombia) {
    const conNit = pagos.find((p) => p.bancoBeneficiario?.nit?.trim());
    if (conNit?.bancoBeneficiario?.nit) {
      return conNit.bancoBeneficiario.nit.trim();
    }
    return nitDianFallback;
  }

  // Mixto u otros bancos: tomamos el primer non-Bancolombia con NIT.
  const otroBanco = pagos.find(
    (p) =>
      p.canalPago !== "TRANSF_BANCOLOMBIA" &&
      p.bancoBeneficiario?.nit?.trim(),
  );
  if (otroBanco?.bancoBeneficiario?.nit) {
    return otroBanco.bancoBeneficiario.nit.trim();
  }

  return nitDianFallback;
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
                include: { impuesto: { select: { id: true, tipo: true } } },
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
  const lineasFacturables = borrador.lineasRevision.filter((l) => l.valor > 0n);

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

  // Validar que líneas TERCEROS manuales (sin tipoFija) tengan NIT de proveedor.
  // Las fijas IMPUESTO_4X1000 y COSTOS_BANCARIOS resuelven su tercero aparte
  // (4x1000 → banco GMF; costos → no requiere tercero específico).
  const lineasTercerosSinNit = lineasFacturables
    .filter((l) => l.seccion === "TERCEROS" && !l.tipoFija)
    .filter((l) => {
      const primeraFactura = l.facturas[0]?.factura ?? null;
      const nit =
        primeraFactura?.beneficiario?.nit?.trim() ||
        primeraFactura?.proveedorNit?.trim() ||
        null;
      return nit === null;
    })
    .map((l) => {
      const sinFactura = l.facturas.length === 0;
      return `#${l.orden} "${l.concepto}"${sinFactura ? " (sin factura proveedor)" : " (proveedor sin NIT)"}`;
    });

  if (lineasTercerosSinNit.length > 0) {
    return {
      ok: false,
      tipo: "validacion",
      error: `Líneas TERCEROS sin NIT de proveedor: ${lineasTercerosSinNit.join(", ")}. Registra el NIT en Configuración → Beneficiarios.`,
    };
  }

  // ── 5. Construir items para SIIGO ───────────────────────────────────────────
  // Orden: TERCEROS primero, OPERACIONAL después; dentro de cada sección por
  // `orden`. Las fijas TERCEROS (COSTOS_BANCARIOS=990, IMPUESTO_4X1000=995) van
  // al final del bloque de terceros y las fijas OPERACIONAL (COMISION=991,
  // IVA_COMISION=992) al final del bloque operacional.
  const PESO_SECCION = { TERCEROS: 0, OPERACIONAL: 1 } as const;
  const lineasOrdenadas = [...lineasFacturables].sort((a, b) => {
    const peso =
      PESO_SECCION[a.seccion as keyof typeof PESO_SECCION] -
      PESO_SECCION[b.seccion as keyof typeof PESO_SECCION];
    return peso !== 0 ? peso : a.orden - b.orden;
  });

  // NIT del banco GMF: lo calculamos una sola vez y se aplica solo a la línea
  // IMPUESTO_4X1000.
  const nit4x1000 = resolverNit4x1000(borrador.tramite.pagos, config.nitDian);

  // Helper: NIT del proveedor real de una línea TERCEROS manual (para "Id.
  // Tercero" en el PDF). Para TERCEROS preferimos el NIT del beneficiario
  // (más confiable que el del proveedor que escribió quien capturó la factura).
  function nitTerceroDe(
    l: (typeof lineasFacturables)[number],
  ): string | null {
    const factura = l.facturas[0]?.factura ?? null;
    return (
      factura?.beneficiario?.nit?.trim() ||
      factura?.proveedorNit?.trim() ||
      null
    );
  }

  const items: SiigoFacturaItemDto[] = [];

  for (const l of lineasOrdenadas) {
    // Determinar el customer (tercero) según el tipo de línea:
    //   - IMPUESTO_4X1000 → banco que retuvo el GMF (resolverNit4x1000).
    //   - TERCEROS manual → NIT del proveedor de la factura vinculada.
    //   - Resto (COMISION / IVA_COMISION / COSTOS_BANCARIOS / OPERACIONAL) →
    //     sin customer; son ingresos / costos propios del prestador.
    let customerNit: string | null = null;
    if (l.tipoFija === "IMPUESTO_4X1000") {
      customerNit = nit4x1000;
    } else if (l.seccion === "TERCEROS" && !l.tipoFija) {
      customerNit = nitTerceroDe(l);
    }

    items.push({
      code: l.siigoProducto!.codigo,
      description: l.concepto,
      quantity: 1,
      price: bigintToPrice(l.valor),
      // Crítico: NO enviamos `taxes` para que Siigo no aplique IVA por encima
      // del price. El IVA va como su propia línea IVA_COMISION.
      ...(customerNit
        ? { customer: { identification: customerNit, branch_office: 0 } }
        : {}),
    });
  }

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
  );

  const dto: SiigoFacturaPostDto = {
    document: { id: config.tipoComprobanteId },
    date: fechaEnvio,
    customer: { identification: nitCliente, branch_office: 0 },
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
    // Crítico: queda como BORRADOR en Siigo. Un superior valida y estampa.
    stamp: { send: false },
  };

  // ── 6. Llamar a SIIGO ───────────────────────────────────────────────────────
  let respuesta;
  try {
    const token = await getToken();
    respuesta = await postFactura(token, dto);
  } catch (err) {
    return persistirErrorSiigo(borrador.id, borrador.tramite.id, usuarioId, err);
  }

  // ── 7. Persistir éxito ──────────────────────────────────────────────────────
  const enviadoEn = new Date();
  try {
    await prisma.$transaction([
      prisma.borradorFactura.update({
        where: { id: borrador.id },
        data: {
          siigoDraftId: respuesta.id,
          enviadoASiigoEn: enviadoEn,
          ultimoErrorSiigo: null,
          ultimoIntentoSiigo: enviadoEn,
        },
      }),
      prisma.auditLog.create({
        data: {
          entidad: "BorradorFactura",
          entidadId: borrador.id,
          accion: "SIIGO_ENVIAR_OK",
          usuarioId,
          tramiteId: borrador.tramite.id,
          antes: { siigoDraftIdAnterior: borrador.siigoDraftId },
          despues: {
            siigoDraftId: respuesta.id,
            enviadoASiigoEn: enviadoEn.toISOString(),
            siigoConsecutivoBorrador: respuesta.name,
          } as Prisma.InputJsonValue,
        },
      }),
    ]);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "Error de persistencia";
    return { ok: false, tipo: "db", error: mensaje };
  }

  return { ok: true, siigoDraftId: respuesta.id, enviadoEn: enviadoEn.toISOString() };
}

async function persistirErrorSiigo(
  borradorId: string,
  tramiteId: string,
  usuarioId: string,
  err: unknown,
): Promise<EnvioSiigoResult> {
  const tipo: "config" | "api" =
    err instanceof SiigoConfigError ? "config" : "api";
  const status =
    err instanceof SiigoApiError ? err.status : tipo === "config" ? 503 : 502;
  const mensaje =
    err instanceof Error ? err.message : "Error desconocido enviando a SIIGO";

  try {
    await prisma.$transaction([
      prisma.borradorFactura.update({
        where: { id: borradorId },
        data: {
          ultimoErrorSiigo: mensaje,
          ultimoIntentoSiigo: new Date(),
        },
      }),
      prisma.auditLog.create({
        data: {
          entidad: "BorradorFactura",
          entidadId: borradorId,
          accion: "SIIGO_ENVIAR_ERROR",
          usuarioId,
          tramiteId,
          despues: { error: mensaje, status, tipo } as Prisma.InputJsonValue,
        },
      }),
    ]);
  } catch {
    // No bloqueamos el error original si la persistencia falla.
  }

  return { ok: false, tipo, error: mensaje };
}
