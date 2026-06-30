"use client";

import { AlertTriangle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  type LibroPagosData,
  calcularSaldosCliente,
  fetchLibroPagos,
  formatCOP,
} from "@/components/pagos/pagos-api";

/**
 * Hoja del trámite — espejo de la hoja de Excel de Camila (GRUPO E PAPIS).
 *
 * Reúne en una sola visual, de solo lectura:
 *   1. Cabecera: DO + número de factura SIIGO + cliente.
 *   2. Anticipo(s) aplicado(s) con tipo de recaudo (canal).
 *   3. Libro de pagos con la columna SALDO corriente (verde a favor / rojo a cargo).
 *   4. Cola de la factura: comisión, IVA, 4x1000, costos bancarios — descontados del
 *      saldo corriente igual que en el Excel — hasta el SALDO FINAL y el TOTAL FACTURA.
 *
 * No edita nada: la edición vive en las pestañas Pagos / Anticipos / Facturación.
 */

// ─── Tipos ──────────────────────────────────────────────────────────────────

type AnticipoAplicado = {
  id: string;
  montoAplicado: string;
  anticipo: {
    monto: string;
    fecha: string;
    tipoRecaudo: string;
    costoRecaudo: string;
    verificadoBanco: boolean;
  };
};

type BorradorHoja = {
  id: string;
  estado: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  comision: string;
  /** Comisión interna Galcomex→Lucho (manual). Solo cruce, no factura. SOCIO_LM. */
  comisionInternaLM: string;
  /** Tipo de pago de la comisión interna LM. Exactamente uno set cuando aplica. */
  tipoRecaudoComisionInternaLM: string | null;
  canalPagoComisionInternaLM: string | null;
  /** Costo bancario snapshot del tipo de pago de la comisión interna LM. */
  costoComisionInternaLM: string;
  /** Saldo de la cuenta interna con LM (persistido por el servidor). */
  saldoLMInterno: string;
  ivaComision: string;
  impuesto4x1000: string;
  costosBancarios: string;
  /**
   * Total retenciones (RETE IVA + RETE FTE + RETE ICA).
   * Fallback a "0" si el endpoint no lo expone aún (deuda backend WS-A).
   */
  retenciones: string;
  totalFactura: string;
  saldoAFavorCliente: string;
  saldoACargoCliente: string;
  saldoAFavorLM: string;
  saldoACargoLM: string;
  createdAt: string;
};

type HojaData = {
  consecutivo: string;
  estado: string;
  doCliente: string | null;
  doAgencia: string | null;
  cliente: { nombre: string; nit: string; tipo: string };
  aplicacionesAnticipo: AnticipoAplicado[];
  borrador: BorradorHoja | null;
};

type LoadState = "loading" | "ready" | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = "0"): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

const CANAL_LABEL: Record<string, string> = {
  TRANSF_BANCOLOMBIA: "Transf. Bancolombia",
  PSE: "PSE",
  TRANSF_OTROS_BANCOS: "Transf. Otros Bancos",
};

const TIPO_RECAUDO_LABEL: Record<string, string> = {
  BANCOLOMBIA: "Bancolombia (digital)",
  OTROS_BANCOS: "Otros Bancos (digital)",
  SUCURSAL: "Sucursal Bancolombia",
  CORRESPONSAL: "Corresponsal Bancolombia",
  CAJERO: "Cajero Bancolombia",
};

function canalLabel(canal: string): string {
  return CANAL_LABEL[canal] ?? canal;
}

function tipoRecaudoLabel(tipo: string): string {
  return TIPO_RECAUDO_LABEL[tipo] ?? tipo;
}

/** Clase de color del saldo: verde > 0 (a favor), rojo < 0 (a cargo). */
function saldoColor(bigStr: string): string {
  try {
    const n = BigInt(bigStr);
    if (n > 0n) return "text-emerald-700";
    if (n < 0n) return "text-rose-600";
  } catch {
    /* noop */
  }
  return "text-slate-700";
}

function saldoBg(bigStr: string): string {
  try {
    const n = BigInt(bigStr);
    if (n > 0n) return "bg-emerald-50";
    if (n < 0n) return "bg-rose-50";
  } catch {
    /* noop */
  }
  return "";
}

function bigOrZero(bigStr: string): bigint {
  try {
    return BigInt(bigStr);
  } catch {
    return 0n;
  }
}

// ─── Carga de datos ─────────────────────────────────────────────────────────

async function fetchHojaData(tramiteId: string, signal?: AbortSignal): Promise<HojaData> {
  const res = await fetch(`/api/tramites/${tramiteId}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const payload: unknown = await res.json();
      if (isRecord(payload) && typeof payload.error === "string") msg = payload.error;
    } catch {
      /* noop */
    }
    throw new Error(msg);
  }

  const payload: unknown = await res.json();
  if (!isRecord(payload) || !isRecord(payload.tramite)) {
    throw new Error("Respuesta inesperada del servidor.");
  }
  const t = payload.tramite;
  const cliente = isRecord(t.cliente) ? t.cliente : {};

  const aplicaciones: AnticipoAplicado[] = Array.isArray(t.aplicacionesAnticipo)
    ? t.aplicacionesAnticipo.filter(isRecord).map((a) => {
        const anticipo = isRecord(a.anticipo) ? a.anticipo : {};
        return {
          id: str(a.id, ""),
          montoAplicado: str(a.montoAplicado),
          anticipo: {
            monto: str(anticipo.monto),
            fecha: str(anticipo.fecha, ""),
            tipoRecaudo: str(anticipo.tipoRecaudo, "BANCOLOMBIA"),
            costoRecaudo: str(anticipo.costoRecaudo, "0"),
            verificadoBanco: Boolean(anticipo.verificadoBanco),
          },
        };
      })
    : [];

  // El borrador más reciente (el array ya viene ordenado desc por createdAt).
  const borradores = Array.isArray(t.borradores) ? t.borradores.filter(isRecord) : [];
  const b = borradores[0];
  const factura = b && isRecord(b.factura) ? b.factura : null;

  const borrador: BorradorHoja | null = b
    ? {
        id: str(b.id, ""),
        estado: str(b.estado, "BORRADOR"),
        numFacturaSiigo:
          typeof b.numFacturaSiigo === "string"
            ? b.numFacturaSiigo
            : factura && typeof factura.numSiigo === "string"
              ? factura.numSiigo
              : null,
        fechaFactura: typeof b.fechaFactura === "string" ? b.fechaFactura : null,
        comision: str(b.comision),
        comisionInternaLM: str(b.comisionInternaLM),
        tipoRecaudoComisionInternaLM:
          typeof b.tipoRecaudoComisionInternaLM === "string"
            ? b.tipoRecaudoComisionInternaLM
            : null,
        canalPagoComisionInternaLM:
          typeof b.canalPagoComisionInternaLM === "string"
            ? b.canalPagoComisionInternaLM
            : null,
        costoComisionInternaLM: str(b.costoComisionInternaLM),
        saldoLMInterno: str(b.saldoLMInterno),
        ivaComision: str(b.ivaComision),
        impuesto4x1000: str(b.impuesto4x1000),
        costosBancarios: str(b.costosBancarios),
        // retenciones: fallback a "0" si el endpoint no lo expone (deuda: WS-A debe incluirlo)
        retenciones: str(b.retenciones, "0"),
        totalFactura: str(factura?.totalFactura ?? b.totalFactura),
        saldoAFavorCliente: str(factura?.saldoAFavorCliente ?? b.saldoAFavorCliente),
        saldoACargoCliente: str(factura?.saldoACargoCliente ?? b.saldoACargoCliente),
        saldoAFavorLM: str(factura?.saldoAFavorLM ?? b.saldoAFavorLM),
        saldoACargoLM: str(factura?.saldoACargoLM ?? b.saldoACargoLM),
        createdAt: str(b.createdAt, ""),
      }
    : null;

  return {
    consecutivo: str(t.consecutivo, ""),
    estado: str(t.estado, ""),
    doCliente: typeof t.doCliente === "string" ? t.doCliente : null,
    doAgencia: typeof t.doAgencia === "string" ? t.doAgencia : null,
    cliente: {
      nombre: str(cliente.nombre, ""),
      nit: str(cliente.nit, ""),
      tipo: str(cliente.tipo, "PROPIO"),
    },
    aplicacionesAnticipo: aplicaciones,
    borrador,
  };
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function HojaTramite({
  tramiteId,
  userRol = "OPERATIVO",
}: {
  tramiteId: string;
  userRol?: string;
}) {
  const [hoja, setHoja] = useState<HojaData | null>(null);
  const [libro, setLibro] = useState<LibroPagosData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError(null);
      const [hojaData, libroData] = await Promise.all([
        fetchHojaData(tramiteId, controller.signal),
        fetchLibroPagos(tramiteId, controller.signal),
      ]);
      setHoja(hojaData);
      setLibro(libroData);
      setLoadState("ready");
    }

    load().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(caught instanceof Error ? caught.message : "Error al cargar la hoja.");
      setLoadState("error");
    });

    return () => controller.abort();
  }, [tramiteId, reloadKey]);

  if (loadState === "loading") {
    return (
      <div className="flex min-h-40 items-center gap-3 border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-600">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" aria-hidden="true" />
        <span className="font-medium text-slate-900">Cargando hoja del trámite…</span>
      </div>
    );
  }

  if (loadState === "error" || !hoja || !libro) {
    return (
      <div className="flex min-h-40 items-start gap-3 border border-dashed border-rose-300 bg-rose-50 px-4 py-5 text-sm text-rose-700">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">No fue posible cargar la hoja</p>
          {loadError ? <p className="mt-1">{loadError}</p> : null}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-3 inline-flex h-9 items-center gap-2 border border-rose-300 bg-white px-3 text-sm font-medium text-rose-700 transition hover:bg-rose-50"
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  // Saldo corriente por fila de pago (mismo cálculo que el libro de pagos).
  const saldosPagos = calcularSaldosCliente(
    libro.totalAnticipoAplicado,
    libro.pagos.map((p) => p.valor),
  );
  const saldoTrasPagos =
    saldosPagos.length > 0 ? saldosPagos[saldosPagos.length - 1]! : libro.totalAnticipoAplicado;

  // Costos bancarios en vivo (anticipo + pagos actuales, incluyendo pagos añadidos
  // después de crear el borrador que aún no están en borrador.costosBancarios).
  const costosBancariosTotalLive = (
    bigOrZero(libro.costosBancarios) + bigOrZero(libro.costosBancariosAnticipo)
  ).toString();

  // Totales del cliente: autoritativos de la FACTURA (mismo origen que cartera).
  // `b.totalFactura`/`b.saldoAFavorCliente`/`b.saldoACargoCliente` ya prefieren los
  // valores de la factura cuando existe (ver fetchHojaData). NO re-derivar en vivo:
  // el recálculo anterior restaba `saldoAFavorLM` y desviaba el saldo del cliente
  // (mostraba 2.096.500 en vez de 1.946.500 en CTG26-0118).
  const totalesDinamicos = (() => {
    if (!hoja.borrador) return null;
    const b = hoja.borrador;
    return {
      saldoAFavorCliente: b.saldoAFavorCliente,
      saldoACargoCliente: b.saldoACargoCliente,
      totalFactura: b.totalFactura,
    };
  })();

  // Detalle del cruce Cliente / Luis Martínez (solo SOCIO_LM).
  // Dos niveles (modelo del Excel GRUPO E PAPIS):
  //   Cara al cliente:  saldoAFavorCliente = anticipo − total factura (line-driven).
  //   Cuenta interna LM: saldoLMInterno = anticipo − Σpagos − comisiónInternaLM
  //                       − IVA − 4x1000 interno (base anticipo) − costos.
  //   Cruce final:      saldoLM = saldoLMInterno − saldoAFavorCliente
  //                     (negativo ⇒ LM debe a Galcomex; positivo ⇒ Galcomex debe a LM).
  // La comisión interna es DISTINTA de la de factura: solo afecta este cruce.
  const cruceLM = (() => {
    if (hoja.cliente.tipo !== "SOCIO_LM" || !hoja.borrador) return null;
    const b = hoja.borrador;
    const anticipo = bigOrZero(libro.totalAnticipoAplicado);
    const totalPagos = anticipo - bigOrZero(saldoTrasPagos);
    const comisionInternaLM = bigOrZero(b.comisionInternaLM);
    const iva = bigOrZero(b.ivaComision);
    // 4x1000 interno: base = anticipo (GMF 0.4% fijo). Igual que el motor.
    const cuatroXMilInterno = (anticipo * 4n) / 1000n;
    // Costos = pagos a terceros + recaudo anticipo + costo bancario del tipo de
    // pago de la comisión interna LM (snapshot persistido en el borrador, se
    // suma al `costosBancarios` del servicio para que cuadre con el saldo
    // persistido en la BD — ver service.ts:actualizarComisionInternaLM).
    const costoComisionLM = bigOrZero(b.costoComisionInternaLM);
    const costos = bigOrZero(costosBancariosTotalLive) + costoComisionLM;
    const saldoLMInterno =
      bigOrZero(saldoTrasPagos) - comisionInternaLM - iva - cuatroXMilInterno - costos;
    // Lado cliente: autoritativo de la FACTURA (igual que cartera). `b.saldoAFavorCliente`
    // y `b.totalFactura` ya vienen del factura cuando existe (ver fetchHojaData).
    // NO usar el recálculo live (totalesDinamicos): difiere del facturado.
    const saldoAFavorCliente = bigOrZero(b.saldoAFavorCliente);
    const saldoLM = saldoLMInterno - saldoAFavorCliente;
    return {
      anticipo: anticipo.toString(),
      totalPagos: totalPagos.toString(),
      comisionInternaLM: comisionInternaLM.toString(),
      tipoRecaudoComisionInternaLM: b.tipoRecaudoComisionInternaLM,
      canalPagoComisionInternaLM: b.canalPagoComisionInternaLM,
      costoComisionInternaLM: costoComisionLM.toString(),
      iva: iva.toString(),
      cuatroXMil: cuatroXMilInterno.toString(),
      costos: costos.toString(),
      saldoLMInterno: saldoLMInterno.toString(),
      saldoAFavorCliente: b.saldoAFavorCliente,
      totalFactura: b.totalFactura,
      saldoLM: saldoLM.toString(),
    };
  })();

  const numFactura = hoja.borrador?.numFacturaSiigo ?? null;

  return (
    <div className="space-y-5">
      {/* ── Cabecera tipo Excel ─────────────────────────────────────────── */}
      <div className="grid gap-px overflow-hidden border border-slate-300 bg-slate-300 sm:grid-cols-[1fr_1fr_auto]">
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cliente / DO</p>
          <p className="mt-0.5 text-lg font-bold text-slate-950">{hoja.consecutivo}</p>
          <p className="text-sm text-slate-700">
            {hoja.cliente.nombre} <span className="text-slate-400">· {hoja.cliente.nit}</span>
          </p>
          {hoja.doCliente ? (
            <p className="text-xs text-slate-500">DO cliente: {hoja.doCliente}</p>
          ) : null}
        </div>
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Factura</p>
          {numFactura ? (
            <p className="mt-0.5 text-lg font-bold text-rose-600">{numFactura}</p>
          ) : (
            <p className="mt-0.5 text-sm text-slate-400">Sin factura generada</p>
          )}
          {hoja.borrador ? (
            <p className="text-xs text-slate-500">
              Estado: {hoja.borrador.estado}
              {hoja.borrador.fechaFactura ? ` · ${formatDate(hoja.borrador.fechaFactura)}` : ""}
            </p>
          ) : null}
        </div>
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estado DO</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">
            {hoja.estado.replace(/_/g, " ")}
          </p>
        </div>
      </div>

      {/* ── Anticipos aplicados ─────────────────────────────────────────── */}
      <div className="overflow-hidden border border-slate-300 bg-white">
        <div className="bg-emerald-100 px-4 py-2">
          <p className="text-sm font-bold uppercase tracking-wide text-emerald-900">Anticipo</p>
        </div>
        {hoja.aplicacionesAnticipo.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">Sin anticipos aplicados a este DO.</p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2">Fecha</th>
                <th className="border-b border-slate-200 px-4 py-2 text-right">Monto anticipo</th>
                <th className="border-b border-slate-200 px-4 py-2 text-right">Aplicado al DO</th>
                <th className="border-b border-slate-200 px-4 py-2">Tipo de recaudo</th>
                <th className="border-b border-slate-200 px-4 py-2 text-center">Verif.</th>
              </tr>
            </thead>
            <tbody>
              {hoja.aplicacionesAnticipo.map((ap) => (
                <tr key={ap.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-4 py-2 text-slate-600">{formatDate(ap.anticipo.fecha)}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-800">
                    {formatCOP(ap.anticipo.monto)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-semibold text-emerald-700">
                    {formatCOP(ap.montoAplicado)}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">{tipoRecaudoLabel(ap.anticipo.tipoRecaudo)}</td>
                  <td className="px-4 py-2 text-center">
                    {ap.anticipo.verificadoBanco ? (
                      <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" aria-hidden="true" />
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="px-4 py-2 text-slate-700">TOTAL anticipo aplicado</td>
                <td />
                <td className="px-4 py-2 text-right font-mono text-slate-900">
                  {formatCOP(libro.totalAnticipoAplicado)}
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* ── Comisión interna Galcomex→Lucho (solo SOCIO_LM) ──────────────── */}
      {hoja.cliente.tipo === "SOCIO_LM" && hoja.borrador ? (
        <ComisionInternaBlock
          borradorId={hoja.borrador.id}
          comisionInternaLM={hoja.borrador.comisionInternaLM}
          tipoRecaudoComisionInternaLM={hoja.borrador.tipoRecaudoComisionInternaLM}
          canalPagoComisionInternaLM={hoja.borrador.canalPagoComisionInternaLM}
          costoComisionInternaLM={hoja.borrador.costoComisionInternaLM}
          editable={
            (userRol === "ADMIN" || userRol === "REVISOR") &&
            (hoja.borrador.estado === "BORRADOR" ||
              hoja.borrador.estado === "EN_REVISION")
          }
          onUpdated={() => setReloadKey((k) => k + 1)}
        />
      ) : null}

      {/* ── Pagos + cola de factura, con saldo corriente ────────────────── */}
      <div className="overflow-hidden border border-slate-300 bg-white">
        <div className="bg-orange-100 px-4 py-2">
          <p className="text-sm font-bold uppercase tracking-wide text-orange-900">Pagos y saldo</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-3 py-2 w-8">#</th>
                <th className="border-b border-slate-200 px-3 py-2">Pago</th>
                <th className="border-b border-slate-200 px-3 py-2">Factura / soporte</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Valor</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Saldo</th>
                <th className="border-b border-slate-200 px-3 py-2">Chequeo</th>
                <th className="border-b border-slate-200 px-3 py-2 text-right">Costo</th>
              </tr>
            </thead>
            <tbody>
              {/* Fila de anticipo como punto de partida del saldo */}
              <tr className="border-b border-slate-100 bg-emerald-50/40">
                <td className="px-3 py-2 text-xs text-slate-400">0</td>
                <td className="px-3 py-2 font-medium text-slate-700">Anticipo aplicado</td>
                <td className="px-3 py-2 text-slate-400">—</td>
                <td className="px-3 py-2 text-right font-mono text-slate-400">—</td>
                <td
                  className={`px-3 py-2 text-right font-mono font-semibold ${saldoColor(libro.totalAnticipoAplicado)} ${saldoBg(libro.totalAnticipoAplicado)}`}
                >
                  {formatCOP(libro.totalAnticipoAplicado)}
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
              </tr>

              {libro.pagos.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-slate-500">
                    Sin pagos registrados.
                  </td>
                </tr>
              ) : null}

              {libro.pagos.map((p, idx) => {
                const saldo = saldosPagos[idx] ?? "0";
                return (
                  <tr key={p.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="px-3 py-2 text-xs text-slate-400">{idx + 1}</td>
                    <td className="px-3 py-2 text-slate-800">
                      {p.concepto}
                      {p.beneficiarios && p.beneficiarios.length > 0 ? (
                        <span className="block text-xs text-slate-400">
                          {p.beneficiarios.map((b) => b.nombre).join(", ")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{p.numSoporte ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-900">{formatCOP(p.valor)}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono font-semibold ${saldoColor(saldo)} ${saldoBg(saldo)}`}
                    >
                      {formatCOP(saldo)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{canalLabel(p.canalPago)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-slate-500">
                      {bigOrZero(p.costoBancario) > 0n ? formatCOP(p.costoBancario) : "—"}
                    </td>
                  </tr>
                );
              })}

              {/* ── Cola de factura: descuentos sobre el saldo corriente ── */}
              {hoja.borrador ? (
                <ColaFactura
                  borrador={hoja.borrador}
                  saldoTrasPagos={saldoTrasPagos}
                  costosBancariosTotalLive={costosBancariosTotalLive}
                />
              ) : (
                <tr className="bg-slate-50">
                  <td colSpan={7} className="px-4 py-3 text-center text-xs text-slate-500">
                    Aún no hay borrador de factura. La comisión, IVA, 4x1000 y costos
                    aparecerán aquí al generarla en la pestaña Facturación.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Totales finales ─────────────────────────────────────────────── */}
      {hoja.borrador && totalesDinamicos ? (
        <TotalesFactura
          borrador={hoja.borrador}
          totales={totalesDinamicos}
          saldoLM={cruceLM?.saldoLM ?? null}
        />
      ) : null}

      {/* ── Detalle del cruce con Luis Martínez (solo SOCIO_LM) ─────────── */}
      {cruceLM && hoja.borrador ? (
        <CruceLM
          cruce={cruceLM}
          borradorId={hoja.borrador.id}
          editable={
            (userRol === "ADMIN" || userRol === "REVISOR") &&
            (hoja.borrador.estado === "BORRADOR" ||
              hoja.borrador.estado === "EN_REVISION")
          }
          onUpdated={() => setReloadKey((k) => k + 1)}
        />
      ) : null}

      <p className="text-xs text-slate-400">
        Vista de solo lectura. Para editar pagos, anticipos o la factura usa las pestañas
        correspondientes.
      </p>
    </div>
  );
}

// ─── Cola de factura (filas de descuento) ──────────────────────────────────────

function ColaFactura({
  borrador,
  saldoTrasPagos,
  costosBancariosTotalLive,
}: {
  borrador: BorradorHoja;
  saldoTrasPagos: string;
  costosBancariosTotalLive: string;
}) {
  // Igual que el Excel: el saldo sigue bajando con cada descuento.
  // costosBancariosTotalLive se usa en vez de borrador.costosBancarios para que
  // los pagos añadidos tras crear el borrador queden reflejados correctamente.
  let saldo = bigOrZero(saldoTrasPagos);
  const filas: { label: string; valor: string; isAddition?: boolean }[] = [
    { label: "Comisión Galcomex", valor: borrador.comision },
    { label: "IVA comisión", valor: borrador.ivaComision },
    { label: "Impuesto 4x1000", valor: borrador.impuesto4x1000 },
    { label: "Costos bancarios", valor: costosBancariosTotalLive },
  ];

  // Si hay retenciones, se suman al saldo (reducen el pago del cliente)
  const retencionesVal = bigOrZero(borrador.retenciones);
  if (retencionesVal > 0n) {
    filas.push({ label: "MENOS RETENCIONES", valor: borrador.retenciones, isAddition: true });
  }

  return (
    <>
      {filas.map((f, i) => {
        if (f.isAddition) {
          saldo += bigOrZero(f.valor);
        } else {
          saldo -= bigOrZero(f.valor);
        }
        const saldoStr = saldo.toString();
        return (
          <tr
            key={f.label}
            className={`border-b border-slate-100 ${i === 0 ? "border-t-2 border-t-slate-300" : ""} ${f.isAddition ? "bg-emerald-50/30" : ""}`}
          >
            <td className="px-3 py-2" />
            <td className="px-3 py-2 font-medium uppercase text-xs tracking-wide text-slate-600">
              {f.label}
            </td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-right font-mono text-rose-600">
              {f.isAddition ? (
                bigOrZero(f.valor) > 0n ? (
                  <span className="text-emerald-600">+{formatCOP(f.valor)}</span>
                ) : null
              ) : (
                bigOrZero(f.valor) > 0n ? `−${formatCOP(f.valor)}` : formatCOP("0")
              )}
            </td>
            <td className={`px-3 py-2 text-right font-mono font-semibold ${saldoColor(saldoStr)} ${saldoBg(saldoStr)}`}>
              {formatCOP(saldoStr)}
            </td>
            <td className="px-3 py-2" />
            <td className="px-3 py-2" />
          </tr>
        );
      })}
    </>
  );
}

// ─── Bloque de totales ──────────────────────────────────────────────────────

function SaldoChip({
  label,
  favor,
  cargo,
}: {
  label: string;
  favor: string;
  cargo: string;
}) {
  const fav = bigOrZero(favor);
  const car = bigOrZero(cargo);
  let texto: string;
  let clase: string;
  if (fav > 0n) {
    texto = `+${formatCOP(favor)}`;
    clase = "text-emerald-700";
  } else if (car > 0n) {
    texto = `−${formatCOP(cargo)}`;
    clase = "text-rose-600";
  } else {
    texto = formatCOP("0");
    clase = "text-slate-500";
  }
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${clase}`}>{texto}</p>
    </div>
  );
}

function TotalesFactura({
  borrador,
  totales,
  saldoLM,
}: {
  borrador: BorradorHoja;
  totales: { saldoAFavorCliente: string; saldoACargoCliente: string; totalFactura: string };
  // Saldo LM del cruce (negativo ⇒ LM debe a Galcomex). Si null, usa los campos
  // legacy del borrador (PROPIO no tiene cruce LM).
  saldoLM: string | null;
}) {
  // El cruce expresa el saldo LM con signo: <0 ⇒ a cargo de LM, >0 ⇒ a favor de LM.
  const lmFavor =
    saldoLM !== null ? (bigOrZero(saldoLM) > 0n ? saldoLM : "0") : borrador.saldoAFavorLM;
  const lmCargo =
    saldoLM !== null ? (bigOrZero(saldoLM) < 0n ? (-bigOrZero(saldoLM)).toString() : "0") : borrador.saldoACargoLM;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="border border-slate-300 bg-slate-900 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Total factura</p>
        <p className="mt-0.5 font-mono text-base font-bold text-white">
          {formatCOP(totales.totalFactura)}
        </p>
      </div>
      <SaldoChip
        label="Saldo cliente"
        favor={totales.saldoAFavorCliente}
        cargo={totales.saldoACargoCliente}
      />
      <SaldoChip label="Saldo LM" favor={lmFavor} cargo={lmCargo} />
      <div className="border border-slate-200 bg-white px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estado factura</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-800">{borrador.estado}</p>
      </div>
    </div>
  );
}

// ─── Detalle del cruce Cliente / Luis Martínez (SOCIO_LM) ───────────────────────

type CruceData = {
  anticipo: string;
  totalPagos: string;
  comisionInternaLM: string;
  tipoRecaudoComisionInternaLM: string | null;
  canalPagoComisionInternaLM: string | null;
  costoComisionInternaLM: string;
  iva: string;
  cuatroXMil: string;
  costos: string;
  saldoLMInterno: string;
  saldoAFavorCliente: string;
  totalFactura: string;
  saldoLM: string;
};

function CruceRow({
  label,
  valor,
  sign,
  emphasis,
}: {
  label: string;
  valor: string;
  sign?: "plus" | "minus";
  emphasis?: boolean;
}) {
  const prefijo = sign === "minus" ? "−" : sign === "plus" ? "+" : "";
  return (
    <div
      className={`flex items-center justify-between px-3 py-1.5 ${emphasis ? "border-t-2 border-t-slate-300 bg-slate-50 font-semibold" : "border-t border-slate-100"}`}
    >
      <span className={`text-xs ${emphasis ? "uppercase tracking-wide text-slate-700" : "text-slate-600"}`}>
        {label}
      </span>
      <span className={`font-mono text-sm ${sign === "minus" ? "text-rose-600" : "text-slate-800"}`}>
        {prefijo}
        {formatCOP(valor)}
      </span>
    </div>
  );
}

function CruceLM({
  cruce,
  borradorId,
  editable,
  onUpdated,
}: {
  cruce: CruceData;
  borradorId: string;
  editable: boolean;
  onUpdated: () => void;
}) {
  const saldoLM = bigOrZero(cruce.saldoLM);
  // saldoLM = saldoLMInterno − saldoAFavorCliente.
  // > 0 ⇒ Galcomex debe a LM · < 0 ⇒ LM debe a Galcomex · = 0 ⇒ saldado.
  const lmTexto =
    saldoLM > 0n
      ? "Galcomex debe a Luis Martínez"
      : saldoLM < 0n
        ? "Luis Martínez debe a Galcomex"
        : "Cuenta saldada";
  const lmClase = saldoLM > 0n ? "text-emerald-700" : saldoLM < 0n ? "text-rose-600" : "text-slate-600";
  const saldoLMAbs = (saldoLM < 0n ? -saldoLM : saldoLM).toString();

  return (
    <div className="border border-slate-300 bg-white">
      <div className="border-b border-slate-200 bg-slate-100 px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          Cruce con Luis Martínez (socio)
        </p>
        <p className="text-xs text-slate-500">
          Cuenta interna de Lucho frente a lo facturado al cliente. La comisión
          interna es independiente de la comisión de la factura.
        </p>
      </div>
      <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
        {/* Cuenta interna de LM */}
        <div className="bg-white">
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Cuenta interna Lucho
          </p>
          <CruceRow label="Anticipo LM" valor={cruce.anticipo} />
          <CruceRow label="Pagos a terceros" valor={cruce.totalPagos} sign="minus" />
          <ComisionInternaRow
            valor={cruce.comisionInternaLM}
            tipoRecaudo={cruce.tipoRecaudoComisionInternaLM}
            canalPago={cruce.canalPagoComisionInternaLM}
            costoBancario={cruce.costoComisionInternaLM}
            borradorId={borradorId}
            editable={editable}
            onUpdated={onUpdated}
          />
          <CruceRow label="IVA comisión" valor={cruce.iva} sign="minus" />
          <CruceRow label="Impuesto 4x1000 (interno)" valor={cruce.cuatroXMil} sign="minus" />
          <CruceRow label="Costos bancarios" valor={cruce.costos} sign="minus" />
          <CruceRow label="Saldo interno LM" valor={cruce.saldoLMInterno} emphasis />
        </div>
        {/* Cruce final */}
        <div className="bg-white">
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Cruce final
          </p>
          <CruceRow label="Total factura (cliente)" valor={cruce.totalFactura} />
          <CruceRow label="Saldo a favor cliente" valor={cruce.saldoAFavorCliente} sign="minus" />
          <CruceRow label="Saldo interno LM" valor={cruce.saldoLMInterno} />
          <div className="flex items-center justify-between border-t-2 border-t-slate-300 bg-slate-50 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-700">Saldo LM</span>
            <span className={`font-mono text-sm font-bold ${lmClase}`}>
              {saldoLM > 0n ? "+" : saldoLM < 0n ? "−" : ""}
              {formatCOP(saldoLMAbs)}
            </span>
          </div>
          <p className={`px-3 py-1.5 text-xs font-medium ${lmClase}`}>{lmTexto}</p>
        </div>
      </div>
    </div>
  );
}

/** Mismo catálogo que cartera-api.OPCIONES_RECAUDO_PAGO, redeclarado local
 *  para evitar acoplar este componente al módulo de cartera. Costos en COP
 *  enteros (referencia estática; el servidor resuelve el costo definitivo
 *  desde matriz_recaudo / matriz_pago al persistir). */
type OpcionTipoPago =
  | { grupo: "RECAUDO"; value: string; label: string; costo: number }
  | { grupo: "PAGO"; value: string; label: string; costo: number };

const OPCIONES_TIPO_PAGO_COMISION_LM: OpcionTipoPago[] = [
  { grupo: "RECAUDO", value: "BANCOLOMBIA", label: "Bancolombia (digital)", costo: 1950 },
  { grupo: "RECAUDO", value: "OTROS_BANCOS", label: "Otros bancos (digital)", costo: 2200 },
  { grupo: "RECAUDO", value: "SUCURSAL", label: "Sucursal (físico)", costo: 11290 },
  { grupo: "RECAUDO", value: "CORRESPONSAL", label: "Corresponsal (físico)", costo: 6190 },
  { grupo: "RECAUDO", value: "CAJERO", label: "Cajero (físico)", costo: 5200 },
  { grupo: "PAGO", value: "TRANSF_BANCOLOMBIA", label: "Transf. Bancolombia", costo: 3900 },
  { grupo: "PAGO", value: "PSE", label: "PSE", costo: 0 },
  { grupo: "PAGO", value: "TRANSF_OTROS_BANCOS", label: "Transf. Otros Bancos", costo: 7300 },
];

function opcionKey(o: { grupo: string; value: string }): string {
  return `${o.grupo}:${o.value}`;
}

const COMISION_INTERNA_LM_MINIMO_COP = 150_000n;

/**
 * Fila de la comisión interna Galcomex→Lucho. Solo lectura por defecto; con
 * `editable` muestra un botón "Editar" que abre un modal con monto + tipo
 * de pago (cuyo costo bancario se suma al cruce LM).
 */
function ComisionInternaRow({
  valor,
  tipoRecaudo,
  canalPago,
  costoBancario,
  borradorId,
  editable,
  onUpdated,
}: {
  valor: string;
  tipoRecaudo: string | null;
  canalPago: string | null;
  costoBancario: string;
  borradorId: string;
  editable: boolean;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);

  const opcionPersistida =
    OPCIONES_TIPO_PAGO_COMISION_LM.find(
      (o) =>
        (o.grupo === "RECAUDO" && o.value === tipoRecaudo) ||
        (o.grupo === "PAGO" && o.value === canalPago),
    ) ?? null;

  const canalLabel = opcionPersistida
    ? `${opcionPersistida.label} · costo ${formatCOP(costoBancario)}`
    : "Sin tipo de pago configurado";
  const canalClase = opcionPersistida ? "text-slate-500" : "text-amber-700";

  const detalle = (
    <div className="border-t border-slate-100 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-xs text-slate-600">Comisión interna Galcomex</span>
          <span className={`text-[11px] ${canalClase}`}>{canalLabel}</span>
        </div>
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm text-rose-600">−{formatCOP(valor)}</span>
          {editable ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-[11px] font-medium text-sky-700 underline-offset-2 hover:underline"
            >
              Editar
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );

  return (
    <>
      {detalle}
      {open ? (
        <ComisionInternaModal
          borradorId={borradorId}
          valorInicial={valor}
          opcionInicial={opcionPersistida}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onUpdated();
          }}
        />
      ) : null}
    </>
  );
}

function ComisionInternaModal({
  borradorId,
  valorInicial,
  opcionInicial,
  onClose,
  onSaved,
}: {
  borradorId: string;
  valorInicial: string;
  opcionInicial: OpcionTipoPago | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [monto, setMonto] = useState(valorInicial);
  const [opcionKeySel, setOpcionKeySel] = useState<string>(
    opcionInicial ? opcionKey(opcionInicial) : "",
  );
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opcion = OPCIONES_TIPO_PAGO_COMISION_LM.find((o) => opcionKey(o) === opcionKeySel);
  const montoLimpio = monto.replace(/\D/g, "");
  const montoBig = (() => {
    if (montoLimpio.length === 0) return null;
    try {
      return BigInt(montoLimpio);
    } catch {
      return null;
    }
  })();
  const montoValido = montoBig !== null && montoBig >= COMISION_INTERNA_LM_MINIMO_COP;
  const opcionValida = opcion !== undefined;
  const puedeGuardar = montoValido && opcionValida && !guardando;

  async function guardar() {
    if (!montoBig || !opcion) return;
    setGuardando(true);
    setError(null);
    try {
      const body =
        opcion.grupo === "RECAUDO"
          ? { comisionInternaLM: montoBig.toString(), tipoRecaudoComisionInternaLM: opcion.value }
          : { comisionInternaLM: montoBig.toString(), canalPagoComisionInternaLM: opcion.value };
      const res = await fetch(`/api/borradores/${borradorId}/comision-interna-lm`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try {
          const payload: unknown = await res.json();
          if (isRecord(payload) && typeof payload.error === "string") msg = payload.error;
        } catch {
          /* noop */
        }
        throw new Error(msg);
      }
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 px-4 py-8">
      <div className="w-full max-w-md border border-slate-300 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Comisión interna Galcomex→Lucho
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Mínimo {formatCOP(COMISION_INTERNA_LM_MINIMO_COP.toString())}. El costo
              bancario del tipo de pago se suma al cruce LM.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={guardando}
            className="ml-2 inline-flex h-8 w-8 items-center justify-center border border-slate-300 text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">
              Comisión (COP) *
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              disabled={guardando}
              placeholder="150.000"
              className="h-10 w-full border border-slate-300 px-3 text-right font-mono text-sm outline-none focus:border-sky-500"
            />
            {montoBig !== null ? (
              <p
                className={`text-xs ${montoValido ? "text-slate-500" : "text-rose-600"}`}
              >
                {formatCOP(montoBig.toString())}
                {!montoValido
                  ? ` · debe ser ≥ ${formatCOP(COMISION_INTERNA_LM_MINIMO_COP.toString())}`
                  : ""}
              </p>
            ) : null}
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">Tipo de pago *</span>
            <select
              value={opcionKeySel}
              onChange={(e) => setOpcionKeySel(e.target.value)}
              disabled={guardando}
              className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none focus:border-sky-500"
            >
              <option value="" disabled>
                Selecciona un tipo de pago…
              </option>
              <optgroup label="Recaudo (entra plata)">
                {OPCIONES_TIPO_PAGO_COMISION_LM.filter((o) => o.grupo === "RECAUDO").map(
                  (o) => (
                    <option key={opcionKey(o)} value={opcionKey(o)}>
                      {o.label} — ${o.costo.toLocaleString("es-CO")}
                    </option>
                  ),
                )}
              </optgroup>
              <optgroup label="Pago (sale plata)">
                {OPCIONES_TIPO_PAGO_COMISION_LM.filter((o) => o.grupo === "PAGO").map(
                  (o) => (
                    <option key={opcionKey(o)} value={opcionKey(o)}>
                      {o.label} — ${o.costo.toLocaleString("es-CO")}
                    </option>
                  ),
                )}
              </optgroup>
            </select>
            {opcion ? (
              <p className="text-xs text-slate-500">
                Costo bancario:{" "}
                <span className="font-medium text-slate-700">
                  {formatCOP(String(opcion.costo))}
                </span>
              </p>
            ) : null}
          </label>

          {error ? (
            <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={guardando}
              className="h-10 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void guardar()}
              disabled={!puedeGuardar}
              className="inline-flex h-10 items-center gap-2 bg-sky-600 px-4 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
            >
              {guardando ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Bloque Comisión interna (debajo del Anticipo, solo SOCIO_LM) ─────────────

/**
 * Visualiza y dispara la configuración de la comisión interna Galcomex→Lucho
 * desde la cabecera de la Hoja. Reutiliza `ComisionInternaModal` (el mismo que
 * se usa en la pestaña Cruce con Luis Martínez), así que monto + tipo de pago
 * + costo bancario se persisten en el mismo endpoint
 * (`PATCH /api/borradores/[id]/comision-interna-lm`).
 */
function ComisionInternaBlock({
  borradorId,
  comisionInternaLM,
  tipoRecaudoComisionInternaLM,
  canalPagoComisionInternaLM,
  costoComisionInternaLM,
  editable,
  onUpdated,
}: {
  borradorId: string;
  comisionInternaLM: string;
  tipoRecaudoComisionInternaLM: string | null;
  canalPagoComisionInternaLM: string | null;
  costoComisionInternaLM: string;
  editable: boolean;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);

  const opcionPersistida =
    OPCIONES_TIPO_PAGO_COMISION_LM.find(
      (o) =>
        (o.grupo === "RECAUDO" && o.value === tipoRecaudoComisionInternaLM) ||
        (o.grupo === "PAGO" && o.value === canalPagoComisionInternaLM),
    ) ?? null;

  const sinCanal = opcionPersistida === null;

  return (
    <div className="overflow-hidden border border-slate-300 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-violet-100 px-4 py-2">
        <p className="text-sm font-bold uppercase tracking-wide text-violet-900">
          Comisión interna Galcomex→Lucho
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!editable}
          title={!editable ? "Solo ADMIN/REVISOR mientras el borrador esté en BORRADOR o EN_REVISION" : undefined}
          className="inline-flex h-9 items-center gap-1.5 border border-violet-700 bg-white px-3 text-xs font-semibold text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Configurar comisión
        </button>
      </div>
      <div className="grid gap-px bg-slate-200 sm:grid-cols-3">
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Monto
          </p>
          <p className="mt-0.5 font-mono text-base font-semibold text-slate-900">
            {formatCOP(comisionInternaLM)}
          </p>
          <p className="text-[11px] text-slate-500">
            Mínimo {formatCOP(COMISION_INTERNA_LM_MINIMO_COP.toString())}
          </p>
        </div>
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Tipo de pago
          </p>
          <p
            className={`mt-0.5 text-sm font-medium ${sinCanal ? "text-amber-700" : "text-slate-900"}`}
          >
            {opcionPersistida ? opcionPersistida.label : "Sin configurar"}
          </p>
          {opcionPersistida ? (
            <p className="text-[11px] text-slate-500">
              {opcionPersistida.grupo === "RECAUDO"
                ? "Recaudo (entra plata)"
                : "Pago (sale plata)"}
            </p>
          ) : null}
        </div>
        <div className="bg-white px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Costo bancario
          </p>
          <p className="mt-0.5 font-mono text-sm font-semibold text-rose-600">
            {bigOrZero(costoComisionInternaLM) > 0n
              ? `−${formatCOP(costoComisionInternaLM)}`
              : "—"}
          </p>
          <p className="text-[11px] text-slate-500">Se suma al cruce LM</p>
        </div>
      </div>

      {open ? (
        <ComisionInternaModal
          borradorId={borradorId}
          valorInicial={comisionInternaLM}
          opcionInicial={opcionPersistida}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onUpdated();
          }}
        />
      ) : null}
    </div>
  );
}
