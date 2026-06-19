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
  estado: string;
  numFacturaSiigo: string | null;
  fechaFactura: string | null;
  comision: string;
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
  cliente: { nombre: string; nit: string };
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
        estado: str(b.estado, "BORRADOR"),
        numFacturaSiigo:
          typeof b.numFacturaSiigo === "string"
            ? b.numFacturaSiigo
            : factura && typeof factura.numSiigo === "string"
              ? factura.numSiigo
              : null,
        fechaFactura: typeof b.fechaFactura === "string" ? b.fechaFactura : null,
        comision: str(b.comision),
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
    cliente: { nombre: str(cliente.nombre, ""), nit: str(cliente.nit, "") },
    aplicacionesAnticipo: aplicaciones,
    borrador,
  };
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function HojaTramite({ tramiteId }: { tramiteId: string }) {
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

  // Totales dinámicos para el footer: replica la lógica de ColaFactura usando
  // datos en vivo para que reflejen todos los pagos actuales.
  const totalesDinamicos = (() => {
    if (!hoja.borrador) return null;
    const b = hoja.borrador;
    let sf =
      bigOrZero(saldoTrasPagos) -
      bigOrZero(b.comision) -
      bigOrZero(b.ivaComision) -
      bigOrZero(b.impuesto4x1000) -
      bigOrZero(costosBancariosTotalLive);
    const ret = bigOrZero(b.retenciones);
    if (ret > 0n) sf += ret;
    const montoLM = bigOrZero(b.saldoAFavorLM);
    const favor = sf > 0n ? sf - montoLM : 0n;
    const cargo = sf <= 0n ? -sf : 0n;
    const totalFactura = bigOrZero(libro.totalAnticipoAplicado) - favor;
    return {
      saldoAFavorCliente: favor.toString(),
      saldoACargoCliente: cargo.toString(),
      totalFactura: totalFactura.toString(),
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
        <TotalesFactura borrador={hoja.borrador} totales={totalesDinamicos} />
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
}: {
  borrador: BorradorHoja;
  totales: { saldoAFavorCliente: string; saldoACargoCliente: string; totalFactura: string };
}) {
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
      <SaldoChip label="Saldo LM" favor={borrador.saldoAFavorLM} cargo={borrador.saldoACargoLM} />
      <div className="border border-slate-200 bg-white px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Estado factura</p>
        <p className="mt-0.5 text-sm font-semibold text-slate-800">{borrador.estado}</p>
      </div>
    </div>
  );
}
