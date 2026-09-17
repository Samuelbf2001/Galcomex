"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  updateBeneficiario,
  type BeneficiarioRow,
} from "@/components/beneficiarios/beneficiario-api";
import {
  catalogoBeneficiarios,
  invalidarCatalogos,
} from "@/components/configuracion/catalogos-cache";
import { ModuleState } from "@/components/layout/module-state";
import { TableSkeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";
import { usePermiso } from "@/lib/auth/rol-context";

type EditState = {
  id: string;
  field: "nit" | "nombre";
  value: string;
};

type LoadState = "loading" | "ready" | "error";

export function BeneficiariosConfig() {
  // `PATCH /api/beneficiarios/[id]` → requireRole(["ADMIN", "OPERATIVO"]).
  const puedeEditar = usePermiso(["ADMIN", "OPERATIVO"]);
  const { toast } = useToast();

  const [beneficiarios, setBeneficiarios] = useState<BeneficiarioRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null); // id en guardado
  const [errorGuardado, setErrorGuardado] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelado = false;
    // Catálogo compartido con "Configuración de envío Siigo": una sola petición
    // aunque las dos secciones monten a la vez.
    catalogoBeneficiarios()
      .then((rows) => {
        if (cancelado) return;
        setBeneficiarios(rows);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelado) return;
        setLoadError(describirError(caught, "No fue posible cargar los beneficiarios."));
        setLoadState("error");
      });
    return () => {
      cancelado = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (edit) inputRef.current?.focus();
  }, [edit]);

  function recargar() {
    invalidarCatalogos("beneficiarios");
    setLoadState("loading");
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }

  function iniciarEdicion(id: string, field: "nit" | "nombre", valorActual: string | null) {
    if (!puedeEditar || edit || guardando) return;
    setEdit({ id, field, value: valorActual ?? "" });
    setErrorGuardado(null);
  }

  function cancelarEdicion() {
    setEdit(null);
    setErrorGuardado(null);
  }

  async function guardar() {
    if (!edit || guardando) return;
    setGuardando(edit.id);
    setErrorGuardado(null);
    try {
      const updated = await updateBeneficiario(edit.id, {
        [edit.field]: edit.value.trim() || null,
      });
      setBeneficiarios((prev) =>
        prev.map((b) => (b.id === updated.id ? updated : b)),
      );
      // La otra sección (selects Siigo) debe ver el nombre/NIT nuevo.
      invalidarCatalogos("beneficiarios");
      toast({
        title: edit.field === "nit" ? "NIT actualizado" : "Nombre actualizado",
        description: updated.nombre,
        variant: "success",
      });
      setEdit(null);
    } catch (caught) {
      const mensaje = describirError(caught, "Error al guardar.");
      setErrorGuardado(mensaje);
      toast({ title: "No se pudo guardar el beneficiario", description: mensaje, variant: "error" });
    } finally {
      setGuardando(null);
    }
  }

  const sinNit = beneficiarios.filter((b) => !b.nit).length;

  function renderEditor(b: BeneficiarioRow, field: "nit" | "nombre") {
    if (!edit || edit.id !== b.id || edit.field !== field) return null;
    const enGuardado = guardando === b.id;
    return (
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          value={edit.value}
          onChange={(e) => setEdit({ ...edit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void guardar();
            if (e.key === "Escape") cancelarEdicion();
          }}
          disabled={enGuardado}
          placeholder={field === "nit" ? "900123456-7" : undefined}
          aria-label={field === "nit" ? `NIT de ${b.nombre}` : `Nombre del beneficiario ${b.nombre}`}
          aria-invalid={errorGuardado ? true : undefined}
          className={`rounded border px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 ${
            field === "nit" ? "w-36 font-mono" : "w-48"
          } ${errorGuardado ? "border-rose-500" : "border-slate-300"}`}
        />
        <button
          type="button"
          onClick={() => void guardar()}
          disabled={enGuardado}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 disabled:opacity-50"
        >
          {enGuardado ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          {enGuardado ? "Guardando…" : "Guardar"}
        </button>
        <button
          type="button"
          onClick={cancelarEdicion}
          disabled={enGuardado}
          className="text-xs text-slate-400 disabled:opacity-50"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Beneficiarios / Proveedores</h2>
          <p className="text-xs text-slate-500">
            NIT requerido para generar facturas electrónicas en Siigo.
            {puedeEditar ? " Haz clic en un nombre o NIT para editarlo." : ""}
          </p>
        </div>
        {sinNit > 0 && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            {sinNit} sin NIT
          </span>
        )}
      </div>

      {errorGuardado ? (
        <p role="alert" className="text-sm text-red-600">
          {errorGuardado}
        </p>
      ) : null}

      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={3} rowHeight={37} />
      ) : loadState === "error" ? (
        <ModuleState
          type="error"
          title="No se pudieron cargar los beneficiarios"
          detail={loadError ?? undefined}
          action={{ label: "Reintentar", onClick: recargar }}
        />
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-white">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="border-b border-slate-200 px-4 py-2">Nombre</th>
                <th className="border-b border-slate-200 px-4 py-2">NIT</th>
                <th className="border-b border-slate-200 px-4 py-2">Banco</th>
              </tr>
            </thead>
            <tbody>
              {beneficiarios.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center text-slate-400">
                    <ModuleState type="empty" title="No hay beneficiarios registrados" detail="Los proveedores y beneficiarios que registres aparecerán aquí para completar sus datos." />
                  </td>
                </tr>
              )}
              {beneficiarios.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  {/* Nombre */}
                  <td className="px-4 py-2">
                    {renderEditor(b, "nombre") ??
                      (puedeEditar ? (
                        <button
                          type="button"
                          disabled={edit !== null}
                          onClick={() => iniciarEdicion(b.id, "nombre", b.nombre)}
                          className="text-left hover:underline"
                          title="Editar nombre"
                          aria-label={`Editar nombre de ${b.nombre}`}
                        >
                          {b.nombre}
                        </button>
                      ) : (
                        <span>{b.nombre}</span>
                      ))}
                  </td>

                  {/* NIT */}
                  <td className="px-4 py-2">
                    {renderEditor(b, "nit") ??
                      (puedeEditar ? (
                        <button
                          type="button"
                          disabled={edit !== null}
                          onClick={() => iniciarEdicion(b.id, "nit", b.nit)}
                          className={`font-mono text-sm ${
                            b.nit
                              ? "text-slate-700 hover:underline"
                              : "text-amber-600 hover:underline"
                          }`}
                          title="Editar NIT"
                          aria-label={`Editar NIT de ${b.nombre}`}
                        >
                          {b.nit ?? "— Sin NIT —"}
                        </button>
                      ) : (
                        <span className={`font-mono text-sm ${b.nit ? "text-slate-700" : "text-amber-600"}`}>
                          {b.nit ?? "— Sin NIT —"}
                        </span>
                      ))}
                  </td>

                  {/* Banco */}
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {b.banco ?? "—"}
                    {b.numCuenta ? ` · ${b.numCuenta}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
