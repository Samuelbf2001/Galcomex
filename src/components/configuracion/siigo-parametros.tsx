"use client";

import { CheckCircle2, ChevronDown, Loader2, Save } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { BeneficiarioRow } from "@/components/beneficiarios/beneficiario-api";
import {
  catalogoBeneficiarios,
  catalogoFormasPago,
  catalogoProductos,
  catalogoTiposComprobante,
  catalogoVendedores,
} from "@/components/configuracion/catalogos-cache";
import {
  fetchParametrosSiigo,
  guardarParametrosSiigo,
  type ClaveSiigo,
  type ParametroSiigoRow,
} from "@/components/configuracion/siigo-parametros-api";
import type {
  SiigoFormaPagoRow,
  SiigoProductoRow,
  SiigoTipoComprobanteRow,
  SiigoVendedorRow,
} from "@/components/configuracion/siigo-productos-api";
import { ModuleState } from "@/components/layout/module-state";
import { Skeleton } from "@/components/ui/skeleton";
import { describirError, useToast } from "@/components/ui/toast";

type LoadState = "idle" | "loading" | "ready" | "error";
type SaveState = "idle" | "saving" | "success" | "error";

// ─── Definición declarativa de los 7 campos ──────────────────────────────────
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
      "Producto Siigo usado para la línea de comisión. Recuerda vincularle el IVA 19% en la sección Productos.",
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

function valoresVacios(): Record<ClaveSiigo, string> {
  return Object.fromEntries(CAMPOS.map((c) => [c.clave, ""])) as Record<ClaveSiigo, string>;
}

function fechasVacias(): Record<ClaveSiigo, string | null> {
  return Object.fromEntries(CAMPOS.map((c) => [c.clave, null])) as Record<
    ClaveSiigo,
    string | null
  >;
}

function desglosarParametros(params: ParametroSiigoRow[]) {
  const valores = valoresVacios();
  const actualizadoEn = fechasVacias();
  for (const p of params) {
    valores[p.clave] = p.valor ?? "";
    actualizadoEn[p.clave] = p.updatedAt;
  }
  return { valores, actualizadoEn };
}

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

/** Filas fantasma con la misma rejilla que el formulario real (≈ 90 px cada una). */
function FormularioSkeleton() {
  return (
    <div
      className="border border-slate-200 bg-white"
      role="status"
      aria-live="polite"
      aria-label="Cargando configuración Siigo"
    >
      <div className="divide-y divide-slate-100">
        {CAMPOS.map((campo) => (
          <div
            key={campo.clave}
            className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-[2fr_3fr] md:items-center"
          >
            <div>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-2 h-3 w-72 max-w-full" />
              <Skeleton className="mt-2 h-2.5 w-40" />
            </div>
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end border-t border-slate-200 bg-slate-50 px-5 py-3">
        <Skeleton className="h-8 w-36" />
      </div>
      <span className="sr-only">Cargando…</span>
    </div>
  );
}

// ─── Componente principal ────────────────────────────────────────────────────

/**
 * Sección plegable: los catálogos (productos, formas de pago, tipos de
 * comprobante, vendedores, beneficiarios) se piden SOLO al expandirla y vienen
 * del caché compartido con "Catálogos Siigo", así abrir /configuracion ya no
 * dispara estas 6 llamadas.
 */
export function SiigoParametros() {
  const { toast } = useToast();
  const panelId = useId();

  const [expandido, setExpandido] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [valores, setValores] = useState<Record<ClaveSiigo, string>>(valoresVacios);
  const [actualizadoEn, setActualizadoEn] = useState<Record<ClaveSiigo, string | null>>(fechasVacias);

  const [productos, setProductos] = useState<SiigoProductoRow[]>([]);
  const [formasPago, setFormasPago] = useState<SiigoFormaPagoRow[]>([]);
  const [tiposComprobante, setTiposComprobante] = useState<SiigoTipoComprobanteRow[]>([]);
  const [vendedores, setVendedores] = useState<SiigoVendedorRow[]>([]);
  const [beneficiarios, setBeneficiarios] = useState<BeneficiarioRow[]>([]);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Un solo efecto de carga: todo desde BD local — Siigo nunca se consulta aquí.
  useEffect(() => {
    if (version === 0) return;
    let cancelado = false;

    Promise.all([
      fetchParametrosSiigo(),
      catalogoProductos(),
      catalogoFormasPago(),
      catalogoTiposComprobante(),
      catalogoVendedores(),
      catalogoBeneficiarios(),
    ])
      .then(([params, prods, fps, tipos, vends, benefs]) => {
        if (cancelado) return;
        const desglose = desglosarParametros(params);
        setValores(desglose.valores);
        setActualizadoEn(desglose.actualizadoEn);
        setProductos(prods.productos);
        setFormasPago(fps.formasPago);
        setTiposComprobante(tipos.tiposComprobante);
        setVendedores(vends.vendedores);
        setBeneficiarios(benefs);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelado) return;
        setLoadError(describirError(caught, "Error al cargar."));
        setLoadState("error");
      });

    return () => {
      cancelado = true;
    };
  }, [version]);

  function cargar() {
    setLoadState("loading");
    setLoadError(null);
    setVersion((v) => v + 1);
  }

  function alternar() {
    const abrir = !expandido;
    setExpandido(abrir);
    if (abrir && loadState === "idle") cargar();
  }

  function handleChange(clave: ClaveSiigo, valor: string) {
    setValores((prev) => ({ ...prev, [clave]: valor }));
    setDirty(true);
    if (saveState !== "idle") setSaveState("idle");
    setSaveMessage(null);
  }

  async function handleGuardar() {
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

    setSaveState("saving");
    setSaveMessage(null);
    try {
      const result = await guardarParametrosSiigo(payload);
      if (!result.ok) {
        throw new Error(result.error);
      }
      const n = result.actualizados.length;
      const mensaje = `${n} parámetro${n === 1 ? "" : "s"} actualizado${n === 1 ? "" : "s"}.`;
      setSaveState("success");
      setSaveMessage(mensaje);
      setDirty(false);
      toast({ title: "Configuración Siigo guardada", description: mensaje, variant: "success" });

      // Refresca solo las fechas de actualización (sin volver a pedir catálogos).
      try {
        const desglose = desglosarParametros(await fetchParametrosSiigo());
        setActualizadoEn(desglose.actualizadoEn);
      } catch {
        /* no es crítico: el guardado ya fue confirmado */
      }
    } catch (caught) {
      const mensaje = describirError(caught, "No fue posible guardar los parámetros.");
      setSaveState("error");
      setSaveMessage(mensaje);
      toast({ title: "No se pudo guardar la configuración Siigo", description: mensaje, variant: "error" });
    }
  }

  const faltanCatalogos =
    loadState === "ready" && (tiposComprobante.length === 0 || vendedores.length === 0);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={alternar}
        aria-expanded={expandido}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 border border-slate-200 bg-white px-5 py-3 text-left transition hover:bg-slate-50"
      >
        <div>
          <h2 className="text-base font-semibold">Configuración de envío Siigo</h2>
          <p className="text-xs text-slate-500">
            Define los IDs y productos que se usan al enviar facturas a Siigo.
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-500 transition ${expandido ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {expandido ? (
        <div id={panelId} className="space-y-2">
          {loadState === "loading" || loadState === "idle" ? (
            <FormularioSkeleton />
          ) : loadState === "error" ? (
            <ModuleState
              type="error"
              title="No se pudo cargar la configuración"
              detail={loadError ?? undefined}
              action={{ label: "Reintentar", onClick: cargar }}
            />
          ) : (
            <>
              {faltanCatalogos ? (
                <div className="border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  Faltan catálogos sincronizados:{" "}
                  {tiposComprobante.length === 0 ? "tipos de comprobante" : ""}
                  {tiposComprobante.length === 0 && vendedores.length === 0 ? " y " : ""}
                  {vendedores.length === 0 ? "vendedores" : ""}. Ve a la sección
                  &quot;Catálogos Siigo&quot; arriba y pulsa &quot;Sincronizar&quot; en cada uno.
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
                    const fecha = actualizadoEn[campo.clave];

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
                            disabled={saveState === "saving"}
                            onChange={(e) => handleChange(campo.clave, e.target.value)}
                            className="h-9 border border-slate-300 bg-white px-2 text-sm text-slate-800 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-60"
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
                          {fecha ? (
                            <p className="text-[10px] text-slate-400">
                              Última actualización:{" "}
                              {new Date(fecha).toLocaleString("es-CO", {
                                dateStyle: "short",
                                timeStyle: "short",
                              })}
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
                        role={saveState === "error" ? "alert" : "status"}
                        className={`flex items-center gap-2 text-xs ${
                          saveState === "success" ? "text-emerald-700" : "text-rose-700"
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
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
