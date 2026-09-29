"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
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

type Campo = "nit" | "nombre" | "nombreCorto";

type EditState = {
  id: string;
  field: Campo;
  value: string;
  /** Solo cuando field === "nit": dígito de verificación (opcional). */
  dv: string;
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

  function iniciarEdicion(b: BeneficiarioRow, field: Campo) {
    if (!puedeEditar || edit || guardando) return;
    const valorActual = field === "nit" ? (b.nitBase ?? b.nit) : field === "nombreCorto" ? b.nombreCorto : b.nombre;
    const dvActual = field === "nit" && b.nit?.includes("-") ? b.nit.split("-")[1] ?? "" : "";
    setEdit({ id: b.id, field, value: valorActual ?? "", dv: dvActual });
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
      const input =
        edit.field === "nit"
          ? { nit: edit.value.trim() || null, dv: edit.dv.trim() || null }
          : { [edit.field]: edit.value.trim() || null };
      const updated = await updateBeneficiario(edit.id, input);
      setBeneficiarios((prev) =>
        prev.map((b) => (b.id === updated.id ? updated : b)),
      );
      // La otra sección (selects Siigo) debe ver el nombre/NIT nuevo.
      invalidarCatalogos("beneficiarios");
      toast({
        title:
          edit.field === "nit" ? "NIT actualizado" : edit.field === "nombreCorto" ? "Nombre corto actualizado" : "Nombre actualizado",
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

  async function toggleNumFacturaConEspacio(b: BeneficiarioRow) {
    if (!puedeEditar || guardando) return;
    setGuardando(b.id);
    setErrorGuardado(null);
    try {
      const updated = await updateBeneficiario(b.id, { numFacturaConEspacio: !b.numFacturaConEspacio });
      setBeneficiarios((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      invalidarCatalogos("beneficiarios");
    } catch (caught) {
      toast({ title: "No se pudo guardar", description: describirError(caught, "Error al guardar."), variant: "error" });
    } finally {
      setGuardando(null);
    }
  }

  const sinNit = beneficiarios.filter((b) => !b.nit).length;
  // Fase 3: todo proveedor pertenece a una empresa (salvo la ficha del socio).
  const sinEmpresa = beneficiarios.filter((b) => !b.empresa && !b.esFichaSocio).length;

  function renderEditor(b: BeneficiarioRow, field: Campo) {
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
          placeholder={field === "nit" ? "900123456" : field === "nombreCorto" ? "ALMACARGA" : undefined}
          aria-label={
            field === "nit"
              ? `NIT (sin DV) de ${b.nombre}`
              : field === "nombreCorto"
                ? `Nombre corto de ${b.nombre}`
                : `Nombre del beneficiario ${b.nombre}`
          }
          aria-invalid={errorGuardado ? true : undefined}
          className={`rounded border px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 ${
            field === "nit" ? "w-32 font-mono" : "w-40"
          } ${errorGuardado ? "border-rose-500" : "border-slate-300"}`}
        />
        {field === "nit" ? (
          <input
            value={edit.dv}
            onChange={(e) => setEdit({ ...edit, dv: e.target.value.replace(/[^0-9]/g, "").slice(0, 1) })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void guardar();
              if (e.key === "Escape") cancelarEdicion();
            }}
            disabled={enGuardado}
            placeholder="DV"
            aria-label={`Dígito de verificación de ${b.nombre}`}
            className="w-12 rounded border border-slate-300 px-2 py-0.5 text-center text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        ) : null}
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
        <div className="flex gap-2">
          {sinEmpresa > 0 && (
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              {sinEmpresa} sin empresa
            </span>
          )}
          {sinNit > 0 && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {sinNit} sin NIT
            </span>
          )}
        </div>
      </div>

      {sinEmpresa > 0 ? (
        <p role="status" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {sinEmpresa === 1 ? "Hay 1 proveedor" : `Hay ${sinEmpresa} proveedores`} sin empresa. Todo proveedor debe
          pertenecer a una empresa: mientras no la tenga, sus datos no se pueden editar.
        </p>
      ) : null}

      {errorGuardado ? (
        <p role="alert" className="text-sm text-red-600">
          {errorGuardado}
        </p>
      ) : null}

      {loadState === "loading" ? (
        <TableSkeleton rows={6} cols={6} rowHeight={37} />
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
                <th className="border-b border-slate-200 px-4 py-2">Empresa</th>
                <th className="border-b border-slate-200 px-4 py-2">NIT</th>
                <th className="border-b border-slate-200 px-4 py-2">Banco</th>
                <th className="border-b border-slate-200 px-4 py-2">Nombre corto (factura de venta)</th>
                <th className="border-b border-slate-200 px-4 py-2">Numerar &quot;FE 11298&quot;</th>
              </tr>
            </thead>
            <tbody>
              {beneficiarios.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-slate-400">
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
                          onClick={() => iniciarEdicion(b, "nombre")}
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

                  {/* Empresa (fase 3) */}
                  <td className="px-4 py-2 text-sm">
                    {b.empresa ? (
                      <Link href={`/clientes/${b.empresa.id}`} className="text-cyan-700 hover:underline">
                        {b.empresa.nombre}
                      </Link>
                    ) : b.esFichaSocio ? (
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600" title="Ficha de pago del socio: no es una empresa">
                        Socio
                      </span>
                    ) : (
                      <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Sin empresa</span>
                    )}
                  </td>

                  {/* NIT (sin DV) + DV */}
                  <td className="px-4 py-2">
                    {renderEditor(b, "nit") ??
                      (puedeEditar ? (
                        <button
                          type="button"
                          disabled={edit !== null}
                          onClick={() => iniciarEdicion(b, "nit")}
                          className={`font-mono text-sm ${
                            b.nit
                              ? "text-slate-700 hover:underline"
                              : "text-amber-600 hover:underline"
                          }`}
                          title="Editar NIT y dígito de verificación"
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

                  {/* Nombre corto */}
                  <td className="px-4 py-2">
                    {renderEditor(b, "nombreCorto") ??
                      (puedeEditar ? (
                        <button
                          type="button"
                          disabled={edit !== null}
                          onClick={() => iniciarEdicion(b, "nombreCorto")}
                          className="text-left text-xs text-slate-600 hover:underline"
                          title='Nombre como sale en la línea de terceros ("ALMACARGA")'
                          aria-label={`Editar nombre corto de ${b.nombre}`}
                        >
                          {b.nombreCorto ?? <span className="text-slate-300">—</span>}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-600">{b.nombreCorto ?? "—"}</span>
                      ))}
                  </td>

                  {/* Numerar "FE 11298" */}
                  <td className="px-4 py-2">
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={b.numFacturaConEspacio}
                        disabled={!puedeEditar || guardando === b.id}
                        onChange={() => void toggleNumFacturaConEspacio(b)}
                        className="h-3.5 w-3.5"
                        aria-label={`Numerar las facturas de ${b.nombre} como "FE 11298"`}
                      />
                      {guardando === b.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                    </label>
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
