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
  productoComisionId: string;
  /** NIT de la DIAN para enviar como tercero en la línea auto-fija de 4x1000. */
  nitDian: string | null;
}

async function leerConfigSiigo(): Promise<ConfigSiigo | { error: string }> {
  const clavesObligatorias = [
    "SIIGO_TIPO_COMPROBANTE_ID",
    "SIIGO_VENDEDOR_ID",
    "SIIGO_PRODUCTO_COMISION_ID",
  ];
  // SIIGO_NIT_DIAN es opcional; si no está, la línea 4x1000 sale sin tercero.
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
    productoComisionId: map["SIIGO_PRODUCTO_COMISION_ID"]!,
    nitDian: map["SIIGO_NIT_DIAN"]?.trim() || null,
  };
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function enviarBorradorASiigo(
  borradorId: string,
  usuarioId: string,
): Promise<EnvioSiigoResult> {
  // ── 1. Cargar borrador con todo lo necesario ────────────────────────────────
  const borrador = await prisma.borradorFactura.findUnique({
    where: { id: borradorId },
    include: {
      tramite: {
        select: {
          id: true,
          consecutivo: true,
          cliente: { select: { nit: true, nombre: true } },
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

  // ── 3. Cargar producto de comisión y sus impuestos ──────────────────────────
  const productoComision = await prisma.siigoProducto.findUnique({
    where: { id: config.productoComisionId },
    select: {
      codigo: true,
      impuestos: {
        include: { impuesto: { select: { id: true, tipo: true } } },
      },
    },
  });

  if (!productoComision) {
    return {
      ok: false,
      tipo: "config",
      error: `El producto de comisión configurado (${config.productoComisionId}) no existe en el catálogo Siigo local.`,
    };
  }

  const taxesComision = productoComision.impuestos
    .filter((pi) => pi.impuesto.tipo === "IVA")
    .map((pi) => ({ id: pi.impuesto.id }));

  // ── 4. Validar líneas de revisión ───────────────────────────────────────────
  const lineasNormales = borrador.lineasRevision.filter((l) => !l.tipoFija);
  // Nota: lineaCostos NO se envía a Siigo (ver paso 5), pero se sigue creando
  // en el borrador local. No la incluimos en la validación de producto.
  const linea4x1000 = borrador.lineasRevision.find(
    (l) => l.tipoFija === "IMPUESTO_4X1000",
  );

  const lineasSinProducto = lineasNormales
    .filter((l) => !l.siigoProducto?.codigo)
    .map((l) => `#${l.orden} "${l.concepto}"`);

  if (lineasSinProducto.length > 0) {
    return {
      ok: false,
      tipo: "validacion",
      error: `Líneas sin producto SIIGO asignado: ${lineasSinProducto.join(", ")}`,
    };
  }

  if (linea4x1000 && !linea4x1000.siigoProducto?.codigo) {
    return {
      ok: false,
      tipo: "validacion",
      error: `La línea "IMPUESTO 4X1000" no tiene producto SIIGO asignado. Asígnalo en el revisor antes de enviar.`,
    };
  }

  // Validar que líneas TERCEROS tengan NIT de proveedor
  const lineasTercerosSinNit = lineasNormales
    .filter((l) => l.seccion === "TERCEROS")
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
  // Orden: TERCEROS → OPERACIONAL → comisión (OPERACIONAL) con IVA.
  // 4x1000 y costos bancarios son LineaRevision en TERCEROS (orden 990/995).
  const PESO_SECCION = { TERCEROS: 0, OPERACIONAL: 1 } as const;
  const lineasOrdenadas = [...lineasNormales].sort((a, b) => {
    const peso =
      PESO_SECCION[a.seccion as keyof typeof PESO_SECCION] -
      PESO_SECCION[b.seccion as keyof typeof PESO_SECCION];
    return peso !== 0 ? peso : a.orden - b.orden;
  });

  const items: SiigoFacturaItemDto[] = [];

  // Helper: extrae el NIT del proveedor real de una línea (para "Id. Tercero").
  // Para TERCEROS preferimos el NIT del beneficiario (más confiable que el del
  // proveedor que escribió quien capturó la factura). Devuelve null si no hay.
  function nitTerceroDe(l: (typeof lineasNormales)[number]): string | null {
    const factura = l.facturas[0]?.factura ?? null;
    return (
      factura?.beneficiario?.nit?.trim() ||
      factura?.proveedorNit?.trim() ||
      null
    );
  }

  // Líneas normales (TERCEROS y OPERACIONAL)
  for (const l of lineasOrdenadas) {
    if (l.valor <= 0n) continue;
    const taxesLinea = (l.siigoProducto?.impuestos ?? [])
      .filter((pi) => pi.impuesto.tipo === "IVA")
      .map((pi) => ({ id: pi.impuesto.id }));
    // Solo TERCEROS llevan customer por línea (las OPERACIONAL son ingresos propios).
    // El campo `customer.identification` es lo que Siigo necesita para "Ingresos
    // recibidos para terceros" — aparece como "Id. Tercero" en el PDF.
    const nitTercero = l.seccion === "TERCEROS" ? nitTerceroDe(l) : null;
    items.push({
      code: l.siigoProducto!.codigo,
      description: l.concepto,
      quantity: 1,
      price: bigintToPrice(l.valor),
      ...(taxesLinea.length > 0 ? { taxes: taxesLinea } : {}),
      ...(nitTercero
        ? { customer: { identification: nitTercero, branch_office: 0 } }
        : {}),
    });
  }

  // Costos bancarios NO se envían a Siigo: son un costo operativo interno de
  // Galcomex (descuentos de bancos por canal de pago) que afecta el saldo del
  // cliente pero no es un servicio facturable. Se mantiene como campo del
  // borrador (visible en el PDF interno y en cartera).

  // 4x1000 (LineaRevision tipoFija, sección TERCEROS).
  // Tercero contable: DIAN — se envía con el NIT configurado en SIIGO_NIT_DIAN.
  if (linea4x1000 && linea4x1000.valor > 0n) {
    items.push({
      code: linea4x1000.siigoProducto!.codigo,
      description: linea4x1000.concepto,
      quantity: 1,
      price: bigintToPrice(linea4x1000.valor),
      ...(config.nitDian
        ? { customer: { identification: config.nitDian, branch_office: 0 } }
        : {}),
    });
  }

  // Comisión Galcomex (campo del borrador) — con IVA desde SiigoProductoImpuesto
  if (borrador.comision > 0n) {
    items.push({
      code: productoComision.codigo,
      description: "COMISION GALCOMEX",
      quantity: 1,
      price: bigintToPrice(borrador.comision),
      ...(taxesComision.length > 0 ? { taxes: taxesComision } : {}),
    });
  }

  // IVA de comisión como línea separada solo si el producto no tiene IVA asociado
  if (borrador.ivaComision > 0n && taxesComision.length === 0) {
    items.push({
      code: productoComision.codigo,
      description: "IVA COMISION",
      quantity: 1,
      price: bigintToPrice(borrador.ivaComision),
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
