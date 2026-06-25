"use client";

import { CheckCircle, Send } from "lucide-react";
import { FormEvent, useState } from "react";

type Estado = "idle" | "enviando" | "exito" | "error";

const ciudadOpciones = [
  { value: "BAQ", label: "Barranquilla (BAQ)" },
  { value: "CTG", label: "Cartagena (CTG)" },
  { value: "BUN", label: "Buenaventura (BUN)" },
  { value: "SMR", label: "Santa Marta (SMR)" },
];

const agenciaOpciones = [
  { value: "MOVIADUANAS", label: "Moviaduanas" },
  { value: "COLDEX", label: "Coldex" },
  { value: "AR_LOGISTY", label: "AR Logisty" },
];

export function SolicitudForm() {
  const [estado, setEstado] = useState<Estado>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [consecutivo, setConsecutivo] = useState<string | null>(null);
  const [clienteNombre, setClienteNombre] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEstado("enviando");
    setErrorMsg(null);

    const formData = new FormData(event.currentTarget);

    const body = {
      nit: String(formData.get("nit") ?? "").trim(),
      ciudad: String(formData.get("ciudad") ?? ""),
      agenciaAduanas: String(formData.get("agenciaAduanas") ?? ""),
      proveedorCliente: String(formData.get("proveedorCliente") ?? "").trim() || null,
      eta: String(formData.get("eta") ?? "").trim() || null,
      comentarios: String(formData.get("comentarios") ?? "").trim() || null,
    };

    // Convertir fecha a ISO si se proporcionó
    if (body.eta) {
      body.eta = new Date(body.eta).toISOString();
    }

    try {
      const res = await fetch("/api/solicitudes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await res.json()) as {
        consecutivo?: string;
        cliente?: string;
        error?: string;
        errors?: { field: string; message: string }[];
      };

      if (!res.ok) {
        if (data.errors && data.errors.length > 0) {
          setErrorMsg(data.errors.map((e) => e.message).join(". "));
        } else {
          setErrorMsg(data.error ?? "Error al enviar la solicitud. Intente nuevamente.");
        }
        setEstado("error");
        return;
      }

      setConsecutivo(data.consecutivo ?? null);
      setClienteNombre(data.cliente ?? null);
      setEstado("exito");
    } catch {
      setErrorMsg("No se pudo conectar con el servidor. Verifique su conexión.");
      setEstado("error");
    }
  }

  if (estado === "exito") {
    return (
      <div className="space-y-4 text-center">
        <div className="flex justify-center">
          <CheckCircle className="h-12 w-12 text-emerald-600" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Solicitud registrada
          </h3>
          {clienteNombre ? (
            <p className="mt-1 text-sm text-slate-600">Cliente: {clienteNombre}</p>
          ) : null}
        </div>
        <div className="border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase text-emerald-700">
            Número de radicado
          </p>
          <p className="mt-1 text-2xl font-bold tracking-wide text-emerald-900">
            {consecutivo}
          </p>
        </div>
        <p className="text-sm text-slate-500">
          El equipo de Galcomex revisará su solicitud y se pondrá en contacto
          con usted pronto.
        </p>
        <button
          type="button"
          onClick={() => {
            setEstado("idle");
            setConsecutivo(null);
            setClienteNombre(null);
          }}
          className="text-sm text-cyan-700 underline underline-offset-2 hover:text-cyan-900"
        >
          Registrar otra solicitud
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* NIT */}
      <div className="space-y-1.5">
        <label htmlFor="nit" className="text-sm font-medium text-slate-700">
          NIT del cliente <span className="text-red-500">*</span>
        </label>
        <input
          id="nit"
          name="nit"
          type="text"
          placeholder="900123456-7"
          autoComplete="off"
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600"
          required
        />
        <p className="text-xs text-slate-500">
          Ingrese el NIT con el que está registrado en Galcomex.
        </p>
      </div>

      {/* Ciudad */}
      <div className="space-y-1.5">
        <label htmlFor="ciudad" className="text-sm font-medium text-slate-700">
          Ciudad de destino <span className="text-red-500">*</span>
        </label>
        <select
          id="ciudad"
          name="ciudad"
          className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-cyan-600"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Seleccione una ciudad
          </option>
          {ciudadOpciones.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>
      </div>

      {/* Agencia de aduanas */}
      <div className="space-y-1.5">
        <label htmlFor="agenciaAduanas" className="text-sm font-medium text-slate-700">
          Agencia de aduanas <span className="text-red-500">*</span>
        </label>
        <select
          id="agenciaAduanas"
          name="agenciaAduanas"
          className="h-10 w-full border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-cyan-600"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Seleccione una agencia
          </option>
          {agenciaOpciones.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>
      </div>

      {/* Proveedor / mercancía */}
      <div className="space-y-1.5">
        <label htmlFor="proveedorCliente" className="text-sm font-medium text-slate-700">
          Proveedor / descripción de la mercancía
        </label>
        <input
          id="proveedorCliente"
          name="proveedorCliente"
          type="text"
          placeholder="Ej. Proveedor XYZ — materias primas"
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600"
        />
      </div>

      {/* ETA */}
      <div className="space-y-1.5">
        <label htmlFor="eta" className="text-sm font-medium text-slate-700">
          ETA — fecha estimada de llegada
        </label>
        <input
          id="eta"
          name="eta"
          type="date"
          className="h-10 w-full border border-slate-300 px-3 text-sm outline-none transition focus:border-cyan-600"
        />
      </div>

      {/* Comentarios */}
      <div className="space-y-1.5">
        <label htmlFor="comentarios" className="text-sm font-medium text-slate-700">
          Observaciones
        </label>
        <textarea
          id="comentarios"
          name="comentarios"
          rows={3}
          placeholder="Información adicional relevante para el trámite..."
          className="w-full border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-cyan-600"
        />
      </div>

      {estado === "error" && errorMsg ? (
        <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMsg}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={estado === "enviando"}
        className="inline-flex h-10 w-full items-center justify-center gap-2 bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
        {estado === "enviando" ? "Enviando solicitud…" : "Enviar solicitud"}
      </button>
    </form>
  );
}
