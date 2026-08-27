"use client";

import { useState } from "react";

export type MatrizRecaudoRow = {
  id: string;
  tipoRecaudo: string;
  grupo: string;
  descripcion: string;
  /** BigInt serializado como string (COP enteros). */
  costoFijo: string;
};

export type MatrizPagoRow = {
  id: string;
  canalPago: string;
  descripcion: string;
  /** BigInt serializado como string (COP enteros). */
  costoFijo: string;
};

const LABELS_RECAUDO: Record<string, string> = {
  BANCOLOMBIA: "Bancolombia",
  OTROS_BANCOS: "Otros bancos",
  SUCURSAL: "Sucursal",
  CORRESPONSAL: "Corresponsal",
  CAJERO: "Cajero",
};

const LABELS_PAGO: Record<string, string> = {
  TRANSF_BANCOLOMBIA: "Transferencia Bancolombia",
  PSE: "PSE",
  TRANSF_OTROS_BANCOS: "Transferencia otros bancos",
};

/** Formatea BigInt-como-string a COP: $5.200 */
function formatCOP(value: string): string {
  try {
    const n = BigInt(value);
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return value;
  }
}

/**
 * Sección "Costos bancarios": costo fijo por tipo de recaudo (MatrizRecaudo)
 * y por canal de pago (MatrizPago). Solo lectura para roles distintos de
 * ADMIN. ADMIN puede editar el costoFijo inline.
 *
 * OJO: cambiar un costo aquí solo afecta a los anticipos/pagos que se
 * registren después — los ya guardados conservan su costo snapshoteado
 * (Anticipo.costoRecaudo / PagoTramite.costoBancario) y NO se recalculan.
 */
export function MatricesConfig({
  matrizRecaudo,
  matrizPago,
  esAdmin,
}: {
  matrizRecaudo: MatrizRecaudoRow[];
  matrizPago: MatrizPagoRow[];
  esAdmin: boolean;
}) {
  const [recaudo, setRecaudo] = useState(matrizRecaudo);
  const [pago, setPago] = useState(matrizPago);
  // `${"recaudo"|"pago"}:${clave}` de la fila en edición.
  const [editando, setEditando] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function abrir(tabla: "recaudo" | "pago", clave: string, costoFijo: string) {
    setEditando(`${tabla}:${clave}`);
    setValor(costoFijo);
    setError(null);
  }

  function cerrar() {
    setEditando(null);
    setValor("");
    setError(null);
  }

  function validarValor(): string | null {
    const trimmed = valor.trim();
    if (!/^\d+$/.test(trimmed)) {
      setError("Ingresa un número entero en COP (sin puntos ni signos)");
      return null;
    }
    return trimmed;
  }

  async function guardarRecaudo(tipoRecaudo: string) {
    setError(null);
    const costoFijo = validarValor();
    if (costoFijo === null) return;

    setGuardando(true);
    const res = await fetch(`/api/matrices/recaudo/${tipoRecaudo}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ costoFijo }),
    });
    setGuardando(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "No fue posible guardar el costo");
      return;
    }

    setRecaudo((prev) =>
      prev.map((m) => (m.tipoRecaudo === tipoRecaudo ? { ...m, costoFijo } : m)),
    );
    cerrar();
  }

  async function guardarPago(canalPago: string) {
    setError(null);
    const costoFijo = validarValor();
    if (costoFijo === null) return;

    setGuardando(true);
    const res = await fetch(`/api/matrices/pago/${canalPago}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ costoFijo }),
    });
    setGuardando(false);

    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "No fue posible guardar el costo");
      return;
    }

    setPago((prev) =>
      prev.map((m) => (m.canalPago === canalPago ? { ...m, costoFijo } : m)),
    );
    cerrar();
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Costos bancarios</h2>
        <p className="text-sm text-slate-600">
          Costo fijo por tipo de recaudo y canal de pago. Cambiar un valor solo
          afecta a los movimientos nuevos: los anticipos y pagos ya registrados
          conservan su costo snapshoteado.
        </p>
      </div>

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-500">
          Tipos de recaudo
        </div>
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3">Tipo</th>
              <th className="border-b border-slate-200 px-4 py-3">Descripción</th>
              <th className="border-b border-slate-200 px-4 py-3">Costo fijo</th>
              {esAdmin ? (
                <th className="border-b border-slate-200 px-4 py-3 text-right">
                  Acción
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {recaudo.map((m) => {
              const key = `recaudo:${m.tipoRecaudo}`;
              return (
                <tr key={m.id} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-3 font-medium">
                    {LABELS_RECAUDO[m.tipoRecaudo] ?? m.tipoRecaudo}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{m.descripcion}</td>
                  <td className="px-4 py-3">
                    {esAdmin && editando === key ? (
                      <div className="flex flex-col gap-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={valor}
                          onChange={(e) => setValor(e.target.value)}
                          autoFocus
                          className="h-8 w-32 border border-slate-300 px-2 text-sm outline-none focus:border-cyan-600"
                        />
                        {error ? (
                          <span className="text-xs text-red-600">{error}</span>
                        ) : null}
                      </div>
                    ) : (
                      formatCOP(m.costoFijo)
                    )}
                  </td>
                  {esAdmin ? (
                    <td className="px-4 py-3 text-right">
                      {editando === key ? (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={cerrar}
                            className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() => void guardarRecaudo(m.tipoRecaudo)}
                            disabled={guardando}
                            className="h-8 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                          >
                            {guardando ? "Guardando" : "Guardar"}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => abrir("recaudo", m.tipoRecaudo, m.costoFijo)}
                          className="inline-flex h-8 items-center gap-1.5 border border-slate-300 px-3 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          Editar
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase text-slate-500">
          Canales de pago
        </div>
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="border-b border-slate-200 px-4 py-3">Canal</th>
              <th className="border-b border-slate-200 px-4 py-3">Descripción</th>
              <th className="border-b border-slate-200 px-4 py-3">Costo fijo</th>
              {esAdmin ? (
                <th className="border-b border-slate-200 px-4 py-3 text-right">
                  Acción
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {pago.map((m) => {
              const key = `pago:${m.canalPago}`;
              return (
                <tr key={m.id} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-3 font-medium">
                    {LABELS_PAGO[m.canalPago] ?? m.canalPago}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{m.descripcion}</td>
                  <td className="px-4 py-3">
                    {esAdmin && editando === key ? (
                      <div className="flex flex-col gap-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={valor}
                          onChange={(e) => setValor(e.target.value)}
                          autoFocus
                          className="h-8 w-32 border border-slate-300 px-2 text-sm outline-none focus:border-cyan-600"
                        />
                        {error ? (
                          <span className="text-xs text-red-600">{error}</span>
                        ) : null}
                      </div>
                    ) : (
                      formatCOP(m.costoFijo)
                    )}
                  </td>
                  {esAdmin ? (
                    <td className="px-4 py-3 text-right">
                      {editando === key ? (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={cerrar}
                            className="h-8 border border-slate-300 px-3 text-xs text-slate-600 hover:bg-slate-100"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() => void guardarPago(m.canalPago)}
                            disabled={guardando}
                            className="h-8 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                          >
                            {guardando ? "Guardando" : "Guardar"}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => abrir("pago", m.canalPago, m.costoFijo)}
                          className="inline-flex h-8 items-center gap-1.5 border border-slate-300 px-3 text-xs text-slate-700 hover:bg-slate-100"
                        >
                          Editar
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
