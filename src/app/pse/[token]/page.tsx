"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, AlertTriangle } from "lucide-react";

type Estado = "cargando" | "listo" | "expirado" | "usado" | "enviado" | "error";

export default function PsePage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [consecutivo, setConsecutivo] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>("cargando");
  const [codigo, setCodigo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    params.then(({ token: t }) => {
      setToken(t);
      fetch(`/api/pse/${t}`)
        .then(async (r) => {
          if (r.status === 404 || r.status === 410) { setEstado("expirado"); return; }
          if (r.status === 409) { setEstado("usado"); return; }
          if (!r.ok) { setEstado("error"); return; }
          const data = (await r.json()) as { consecutivo: string };
          setConsecutivo(data.consecutivo);
          setEstado("listo");
        })
        .catch(() => setEstado("error"));
    }).catch(() => setEstado("error"));
  }, [params]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !codigo.trim()) return;
    setEnviando(true);
    setErrorMsg(null);
    try {
      const r = await fetch(`/api/pse/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codigo: codigo.trim() }),
      });
      if (r.status === 409) { setEstado("usado"); return; }
      if (r.status === 410) { setEstado("expirado"); return; }
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Error al enviar el código.");
      }
      setEstado("enviado");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Error inesperado.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm border border-slate-200 bg-white p-8 shadow-sm">
        {/* Logo / marca */}
        <p className="mb-6 text-center text-xs font-semibold uppercase tracking-widest text-slate-400">
          Galcomex · Pagos PSE
        </p>

        {estado === "cargando" && (
          <div className="flex flex-col items-center gap-3 py-8 text-slate-500">
            <Loader2 className="h-7 w-7 animate-spin" />
            <span className="text-sm">Verificando link…</span>
          </div>
        )}

        {estado === "listo" && (
          <>
            <h1 className="mb-1 text-lg font-semibold text-slate-900">Ingresar código PSE</h1>
            {consecutivo && (
              <p className="mb-6 text-sm text-slate-500">
                Trámite: <span className="font-medium text-slate-700">{consecutivo}</span>
              </p>
            )}
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-slate-700">Código PSE *</span>
                <input
                  type="text"
                  placeholder="Ej. E11027"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  autoFocus
                  required
                  className="h-11 w-full border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-950"
                />
              </label>

              {errorMsg && (
                <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {errorMsg}
                </div>
              )}

              <button
                type="submit"
                disabled={!codigo.trim() || enviando}
                className="inline-flex h-11 w-full items-center justify-center gap-2 bg-slate-950 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
              >
                {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
                Enviar código
              </button>
            </form>
          </>
        )}

        {estado === "enviado" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-semibold text-slate-900">¡Código enviado!</p>
            <p className="text-sm text-slate-500">
              El operador ya puede continuar con el pago. Puedes cerrar esta página.
            </p>
          </div>
        )}

        {(estado === "expirado" || estado === "usado" || estado === "error") && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-500" />
            <p className="font-semibold text-slate-900">
              {estado === "expirado" && "Link expirado"}
              {estado === "usado" && "Link ya utilizado"}
              {estado === "error" && "Link inválido"}
            </p>
            <p className="text-sm text-slate-500">
              {estado === "expirado" && "Este link ha expirado. Pide al operador que solicite uno nuevo."}
              {estado === "usado" && "El código ya fue enviado anteriormente."}
              {estado === "error" && "No se pudo verificar el link. Revisa la URL."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
