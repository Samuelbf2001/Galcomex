"use client";

import { AlertTriangle, Banknote, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { BeneficiarioSeleccion } from "@/components/beneficiarios/beneficiario-combobox";
import { ModuleState } from "@/components/layout/module-state";
import { PagoMultiDOModal } from "@/components/pagos/pago-multi-do-modal";
import {
  fetchFacturasElegiblesMultiDO,
  formatCOP,
  formatDate,
  type FacturaElegibleMultiDORow,
} from "@/components/pagos/pagos-global-api";
import { EnlaceCliente, EnlaceTramite } from "@/components/ui/enlace-entidad";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type LoadState = "loading" | "ready" | "error";

type BeneficiarioRow = { id: string; nombre: string; nit: string | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function fetchBeneficiariosDeEmpresa(empresaId: string, signal?: AbortSignal): Promise<BeneficiarioRow[]> {
  const res = await fetch(`/api/beneficiarios?empresaId=${encodeURIComponent(empresaId)}`, { signal });
  if (!res.ok) throw new Error(`No fue posible cargar las fichas de pago (${res.status}).`);
  const body: unknown = await res.json();
  const lista = isRecord(body) && Array.isArray(body.beneficiarios) ? body.beneficiarios : [];
  return lista
    .filter(isRecord)
    .filter((b) => typeof b.id === "string")
    .map((b) => ({ id: String(b.id), nombre: typeof b.nombre === "string" ? b.nombre : "", nit: typeof b.nit === "string" ? b.nit : null }));
}

type FacturaConBeneficiario = FacturaElegibleMultiDORow & { beneficiario: BeneficiarioRow };

/**
 * Facturas pendientes de pago a esta empresa como proveedor, de TODOS los
 * trámites, con el pago en bloque del caso Karina/Occidente a un clic.
 * Aparece solo en fichas con `esProveedor`. El puente es
 * `Beneficiario.empresaId`: sin fichas de pago enlazadas no hay nada que listar.
 */
export function SeccionPagosProveedor({ empresaId, nombreEmpresa }: { empresaId: string; nombreEmpresa: string }) {
  // POST /api/pagos/multi es ADMIN u OPERATIVO.
  const puedePagar = usePermiso(["ADMIN", "OPERATIVO"]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [beneficiarios, setBeneficiarios] = useState<BeneficiarioRow[]>([]);
  const [facturas, setFacturas] = useState<FacturaConBeneficiario[]>([]);
  const [modal, setModal] = useState<BeneficiarioSeleccion | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      const fichas = await fetchBeneficiariosDeEmpresa(empresaId, controller.signal);
      const porFicha = await Promise.all(
        fichas.map(async (b) => (await fetchFacturasElegiblesMultiDO(b.id, controller.signal)).map((f) => ({ ...f, beneficiario: b }))),
      );
      setBeneficiarios(fichas);
      setFacturas(porFicha.flat());
      setLoadState("ready");
    })().catch((caught: unknown) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError(describirError(caught, "Error al cargar las facturas pendientes."));
      setLoadState("error");
    });

    return () => controller.abort();
  }, [empresaId, reloadKey]);

  const grupos = useMemo(() => {
    const map = new Map<
      string,
      { tramiteId: string; consecutivo: string; clienteId: string; clienteNombre: string; tieneAnticipoAplicado: boolean; facturas: FacturaConBeneficiario[] }
    >();
    for (const f of facturas) {
      const g = map.get(f.tramiteId) ?? {
        tramiteId: f.tramiteId,
        consecutivo: f.tramiteConsecutivo,
        clienteId: f.clienteId,
        clienteNombre: f.clienteNombre,
        tieneAnticipoAplicado: f.tieneAnticipoAplicado,
        facturas: [],
      };
      g.facturas.push(f);
      map.set(f.tramiteId, g);
    }
    return [...map.values()];
  }, [facturas]);

  const total = facturas.reduce((acc, f) => {
    try {
      return acc + BigInt(f.valor);
    } catch {
      return acc;
    }
  }, 0n);

  const recargar = () => {
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Pagos pendientes a {nombreEmpresa}</p>
          <p className="text-xs text-slate-500">
            {loadState === "ready"
              ? `${facturas.length} factura${facturas.length === 1 ? "" : "s"} de proveedor sin pagar en ${grupos.length} trámite${grupos.length === 1 ? "" : "s"} · ${formatCOP(total.toString())}`
              : "Todas las facturas de proveedor REGISTRADA, de todos los trámites, para pagarlas en bloque."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {puedePagar && beneficiarios.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                const b = beneficiarios[0];
                setModal({ id: b.id, nombre: b.nombre, nit: b.nit });
              }}
              disabled={facturas.length === 0}
              className="inline-flex h-9 items-center gap-1.5 border border-slate-950 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
              Pagar en bloque
            </button>
          ) : null}
          <button type="button" onClick={recargar} className="inline-flex h-9 items-center border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-50" aria-label="Refrescar pagos pendientes">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="p-4">
        {loadState === "loading" ? (
          <TableSkeleton rows={3} cols={4} rowHeight={40} />
        ) : loadState === "error" ? (
          <ModuleState type="error" title="No fue posible cargar los pagos pendientes" detail={loadError ?? undefined} action={{ label: "Reintentar", onClick: recargar }} />
        ) : beneficiarios.length === 0 ? (
          <ModuleState
            type="empty"
            title="Sin ficha de pago enlazada"
            detail="Para ver lo que se le debe a esta empresa, su beneficiario (Configuración → Beneficiarios) debe estar enlazado a esta ficha."
          />
        ) : grupos.length === 0 ? (
          <ModuleState type="empty" title="Nada pendiente" detail="No hay facturas de proveedor en estado REGISTRADA en ningún trámite." />
        ) : (
          <div className="space-y-3">
            {beneficiarios.length > 1 ? (
              <p className="text-xs text-slate-500">
                Esta empresa tiene {beneficiarios.length} fichas de pago; el pago en bloque usa la primera ({beneficiarios[0].nombre}). Las demás se pagan desde el libro de pagos.
              </p>
            ) : null}
            {grupos.map((g) => (
              <div key={g.consecutivo} className="border border-slate-200">
                <div className={`flex items-center justify-between px-3 py-2 text-sm ${g.tieneAnticipoAplicado ? "bg-slate-50" : "bg-amber-50"}`}>
                  <div>
                    <span className="font-semibold text-slate-900">
                      <EnlaceTramite id={g.tramiteId} tab="facturas-proveedor">{g.consecutivo}</EnlaceTramite>
                    </span>
                    <span className="ml-2 text-slate-500">
                      <EnlaceCliente id={g.clienteId}>{g.clienteNombre}</EnlaceCliente>
                    </span>
                  </div>
                  {!g.tieneAnticipoAplicado ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700" title="Sin anticipo aplicado no se puede pagar desde este DO.">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      Sin anticipo aplicado
                    </span>
                  ) : null}
                </div>
                <table className="w-full text-left text-sm">
                  <tbody>
                    {g.facturas.map((f) => (
                      <tr key={f.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium text-slate-900">{f.numFactura}</td>
                        <td className="px-3 py-2 text-slate-500">{formatDate(f.fecha)}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{f.beneficiario.nombre}</td>
                        <td className="px-3 py-2 text-right font-mono text-slate-900">{formatCOP(f.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      {modal ? (
        <PagoMultiDOModal
          beneficiarioInicial={modal}
          beneficiarioFijo
          onClose={() => setModal(null)}
          onCreated={() => {
            setModal(null);
            recargar();
          }}
        />
      ) : null}
    </div>
  );
}
