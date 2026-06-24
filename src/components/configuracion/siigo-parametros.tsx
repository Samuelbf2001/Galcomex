"use client";

import { CheckCircle2, Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ModuleState } from "@/components/layout/module-state";
import {
  fetchParametrosSiigo,
  guardarParametrosSiigo,
  type ClaveSiigo,
  type ParametroSiigoRow,
} from "@/components/configuracion/siigo-parametros-api";
import {
  fetchSiigoFormasPago,
  fetchSiigoProductos,
  fetchSiigoTiposComprobante,
  fetchSiigoVendedores,
  type SiigoFormaPagoRow,
  type SiigoProductoRow,
  type SiigoTipoComprobanteRow,
  type SiigoVendedorRow,
} from "@/components/configuracion/siigo-productos-api";
import {
  fetchBeneficiarios,
  type BeneficiarioRow,
} from "@/components/beneficiarios/beneficiario-api";

type LoadState = "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "success" | "error";

// ─── Definición declarativa de los 6 campos ──────────────────────────────────
//
// Cada campo describe cómo se renderiza el select y de qué fuente saca las
// opciones. Mantener este array sincronizado con CLAVES_SIIGO del endpoint.

type FuenteCampo =
  | "tipoComprobante"
  | "vendedor"
  | "formaPago"
  | "producto"
  | "beneficiario";

interface DefCampo {
  clave: ClaveSiigo;
  label: string;
  ayuda: string;
  fuente: FuenteCampo;
}

const CAMPOS: DefCampo[] = [
  {
    clave: "SIIGO_TIPO_COMPROBANTE_ID",
    label: "Tipo de comprobante",
    ayuda: "Tipo de documento Siigo (factura de venta) que se usa al enviar.",
    fuente: "tipoComprobante",
  },
  {
    clave: "SIIGO_VENDEDOR_ID",
    label: "Vendedor",
    ayuda: "Usuario Siigo que figura como vendedor en la factura.",
    fuente: "vendedor",
  },
  {
    clave: "SIIGO_FORMA_PAGO_DEFAULT_ID",
    label: "Forma de pago por defecto",
    ayuda:
      "Forma de pago que se asigna al generar cada borrador. El admin la puede cambiar antes de enviar a Siigo.",
    fuente: "formaPago",
  },
  {
    clave: "SIIGO_PRODUCTO_COMISION_ID",
    label: "Producto · Comisión Galcomex",
    ayuda:
      "Producto Siigo usado para la línea de comisión. Recordá vincularle el IVA 19% en la sección Productos.",
    fuente: "producto",
  },
  {
    clave: "SIIGO_PRODUCTO_4X1000_ID",
    label: "Producto · Impuesto 4x1000",
    ayuda: "Producto Siigo asignado por defecto a la línea auto-fija de 4x1000.",
    fuente: "producto",
  },
  {
    clave: "SIIGO_PRODUCTO_COSTOS_BANCARIOS_ID",
    label: "Producto · Costos bancarios",
    ayuda:
      "Producto Siigo asignado por defecto a la línea auto-fija de costos bancarios.",
    fuente: "producto",
  },
  {
    clave: "SIIGO_BENEFICIARIO_BANCOLOMBIA_ID",
    label: "Banco · Bancolombia (4x1000)",
    ayuda:
      "Beneficiario que representa a Bancolombia. Se auto-asigna como tercero del 4x1000 a los pagos con canal Bancolombia.",
    fuente: "beneficiario",
  },
];

// ─── Helpers de renderizado de opciones por fuente ───────────────────────────

function renderOpciones(
  fuente: FuenteCampo,
  tiposComprobante: SiigoTipoComprobanteRow[],
  vendedores: SiigoVendedorRow[],
  productos: SiigoProductoRow[],
  formasPago: SiigoFormaPagoRow[],
  beneficiarios: BeneficiarioRow[],
): { value: string; label: string }[] {
  switch (fuente) {
    case "tipoComprobante":
      return tiposComprobante
        .filter((t) => t.activo)
        .map((t) => ({
          value: String(t.id),
          label: `${t.nombre} (code ${t.code})`,
        }));
    case "vendedor":
      return vendedores
        .filter((v) => v.activo)
        .map((v) => ({
          value: String(v.id),
          label: `${v.nombre ?? v.username ?? `Usuario ${v.id}`} · ${v.email ?? ""}`.trim(),
        }));
    case "formaPago":
      return formasPago
        .filter((fp) => fp.activo)
        .map((fp) => ({
          value: String(fp.id),
          label: fp.tipo ? `${fp.nombre} (${fp.tipo})` : fp.nombre,
        }));
    case "producto":
      return productos
        .filter((p) => p.activo)
        .map((p) => ({
          value: p.id,
          label: `${p.codigo} · ${p.nombre}`,
        }));
    case "beneficiario":
      return beneficiarios.map((b) => ({
        value: b.id,
        label: b.nit ? `${b.nombre} · NIT ${b.nit}` : b.nombre,
      }));
  }
}

// ─── Componente principal ────────────────────────────────────────────────────

export function SiigoParametros() {
  const [valores, setValores] = useState<Record<ClaveSiigo, string>>(() =>
    Object.fromEntries(CAMPOS.map((c) => [c.clave, ""])) as Record<
      ClaveSiigo,
      string
    >,
  );
  const [actualizadoEn, setActualizadoEn] = useState<
    Record<ClaveSiigo, string | null>
  >(() => Object.fromEntries(CAMPOS.map((c) => [c.clave, null])) as Record<
    ClaveSiigo,
    string | null
  >);

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [productos, setProductos] = useState<SiigoProductoRow[]>([]);
  const [formasPago, setFormasPago] = useState<SiigoFormaPagoRow[]>([]);
  const [tiposComprobante, setTiposComprobante] = useState<SiigoTipoComprobanteRow[]>([]);
  const [vendedores, setVendedores] = useState<SiigoVendedorRow[]>([]);
  const [beneficiarios, setBeneficiarios] = useState<BeneficiarioRow[]>([]);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const cargar = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      // Todo desde BD local — Siigo nunca se consulta aquí.
      const [params, prods, fps, tipos, vends, benefs] = await Promise.all([
        fetchParametrosSiigo(),
        fetchSiigoProductos(),
        fetchSiigoFormasPago(),
        fetchSiigoTiposComprobante(),
        fetchSiigoVendedores(),
        fetchBeneficiarios(),
      ]);

      const nuevosValores = Object.fromEntries(
        CAMPOS.map((c) => [c.clave, ""]),
      ) as Record<ClaveSiigo, string>;
      const nuevosUpdated = Object.fromEntries(
        CAMPOS.map((c) => [c.clave, null]),
      ) as Record<ClaveSiigo, string | null>;
      for (const p of params as ParametroSiigoRow[]) {
        nuevosValores[p.clave] = p.valor ?? "";
        nuevosUpdated[p.clave] = p.updatedAt;
      }
      setValores(nuevosValores);
      setActualizadoEn(nuevosUpdated);
      setProductos(prods.productos);
      setFormasPago(fps.formasPago);
      setTiposComprobante(tipos.tiposComprobante);
      setVendedores(vends.vendedores);
      setBeneficiarios(benefs);
      setLoadState("ready");
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : "Error al cargar.",
      );
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function handleChange(clave: ClaveSiigo, valor: string) {
    setValores((prev) => ({ ...prev, [clave]: valor }));
    setDirty(true);
    if (saveState !== "idle") setSaveState("idle");
    setSaveMessage(null);
  }

  async function handleGuardar() {
    setSaveState("saving");
    setSaveMessage(null);

    // Solo enviamos los campos con valor (vacío = no tocar)
    const payload = CAMPOS.map((c) => ({
      clave: c.clave,
      valor: valores[c.clave]?.trim() ?? "",
    })).filter((p) => p.valor.length > 0);

    if (payload.length === 0) {
      setSaveState("error");
      setSaveMessage("No hay cambios para guardar.");
      return;
    }

    const result = await guardarParametrosSiigo(payload);
    if (result.ok) {
      setSaveState("success");
      setSaveMessage(
        `${result.actualizados.length} parámetro${result.actualizados.length === 1 ? "" : "s"} actualizado${result.actualizados.length === 1 ? "" : "s"}.`,
      );
      setDirty(false);
      // Recargar updatedAt
      void cargar();
    } else {
      setSaveState("error");
      setSaveMessage(result.error);
    }
  }

  if (loadState === "loading") {
    return (
      <div className="border border-slate-200 bg-white px-5 py-8">
        <ModuleState type="loading" title="Cargando configuración Siigo" />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="border border-slate-200 bg-white px-5 py-8">
        <ModuleState
          type="error"
          title="No se pudo cargar la configuración"
          detail={loadError ?? undefined}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Configuración de envío Siigo</h2>
        <p className="text-xs text-slate-500">
          Define los IDs y productos que se usan al enviar facturas a Siigo.
        </p>
      </div>

      {tiposComprobante.length === 0 || vendedores.length === 0 ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Faltan catálogos sincronizados:{" "}
          {tiposComprobante.length === 0 ? "tipos de comprobante" : ""}
          {tiposComprobante.length === 0 && vendedores.length === 0 ? " y " : ""}
          {vendedores.length === 0 ? "vendedores" : ""}. Andá a la sección
          &quot;Catálogos Siigo&quot; arriba y aprietá &quot;Sincronizar&quot; en cada uno.
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white">
        <div className="divide-y divide-slate-100">
          {CAMPOS.map((campo) => {
            const opciones = renderOpciones(
              campo.fuente,
              tiposComprobante,
              vendedores,
              productos,
              formasPago,
              beneficiarios,
            );
            const valorActual = valores[campo.clave];
            const valorPresenteEnOpciones =
              !valorActual || opciones.some((o) => o.value === valorActual);

            return (
              <div
                key={campo.clave}
                className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-[2fr_3fr] md:items-center"
              >
                <div>
                  <label
                    htmlFor={`siigo-param-${campo.clave}`}
                    className="block text-sm font-medium text-slate-800"
                  >
                    {campo.label}
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">{campo.ayuda}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase text-slate-400">
                    {campo.clave}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <select
                    id={`siigo-param-${campo.clave}`}
                    value={valorActual}
                    onChange={(e) => handleChange(campo.clave, e.target.value)}
                    className="h-9 border border-slate-300 bg-white px-2 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-cyan-400"
                  >
                    <option value="">— seleccionar —</option>
                    {!valorPresenteEnOpciones && valorActual ? (
                      <option value={valorActual}>
                        (Valor actual: {valorActual} — no está en el catálogo
                        local)
                      </option>
                    ) : null}
                    {opciones.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {actualizadoEn[campo.clave] ? (
                    <p className="text-[10px] text-slate-400">
                      Última actualización:{" "}
                      {new Date(actualizadoEn[campo.clave]!).toLocaleString(
                        "es-CO",
                        { dateStyle: "short", timeStyle: "short" },
                      )}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div>
            {saveMessage ? (
              <div
                className={`flex items-center gap-2 text-xs ${
                  saveState === "success"
                    ? "text-emerald-700"
                    : "text-rose-700"
                }`}
              >
                {saveState === "success" ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                ) : null}
                {saveMessage}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void handleGuardar()}
            disabled={!dirty || saveState === "saving"}
            className="inline-flex items-center gap-2 bg-slate-950 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            {saveState === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {saveState === "saving" ? "Guardando…" : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}
