"use client";

import { FileText, Loader2, Paperclip, Receipt } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";

import { subirArchivoDirecto } from "@/components/documentos/documentos-api";
import { claseCampo } from "@/components/clientes/form-campos";
import {
  registrarMovimiento,
  type CuentaCorriente,
} from "@/components/clientes/cuenta-api";
import { nombreCortoEmpresa } from "@/lib/cuenta-corriente/nombre-corto";
import { CampoMoneda } from "@/components/ui/campo-moneda";
import { ModalShell } from "@/components/ui/modal-shell";
import { hoyBogota } from "@/lib/cuenta-corriente/hoy-bogota";
import { describirError, useToast } from "@/components/ui/toast";

const CONCEPTOS_SUGERIDOS = ["Servicios aduaneros", "Quincenas", "Primas"];

function formatCOP(valor: string | bigint): string {
  let entero: bigint;
  try {
    entero = typeof valor === "bigint" ? valor : BigInt(valor);
  } catch {
    return String(valor);
  }
  const negativo = entero < 0n;
  const absoluto = (negativo ? -entero : entero).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "−" : ""}$ ${absoluto}`;
}

/**
 * "Registrar factura" (M5, capacidad `cargos_manuales_contraparte`; caso
 * piloto Coldex): la factura que la contraparte le cobra a Galcomex por fuera
 * de los trámites (mensualidad, quincenas, primas). Siempre ABONO + PROVEEDOR
 * + CARGO_MANUAL + TRAMITE: suma a lo que le debemos. El botón "Otro ajuste"
 * (antes "Registrar movimiento") sigue existiendo para todo lo demás.
 */
export function RegistrarFacturaContraparteModal({
  clienteId,
  cuenta,
  onClose,
  onGuardado,
}: {
  clienteId: string;
  cuenta: CuentaCorriente;
  onClose: () => void;
  onGuardado: (cuenta: CuentaCorriente) => void;
}) {
  const { toast } = useToast();
  const corto = nombreCortoEmpresa(cuenta.empresa.nombre);

  const [concepto, setConcepto] = useState("");
  const [numeroFactura, setNumeroFactura] = useState("");
  const [valor, setValor] = useState("");
  const [fecha, setFecha] = useState(hoyBogota());
  const [archivo, setArchivo] = useState<File | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputArchivoRef = useRef<HTMLInputElement>(null);

  const conceptosUsados = useMemo(() => {
    const usados = cuenta.movimientos
      .filter((m) => m.fuente === "CARGO_MANUAL")
      .map((m) => m.concepto);
    return [...new Set([...CONCEPTOS_SUGERIDOS, ...usados])];
  }, [cuenta.movimientos]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guardando) return;
    setError(null);

    if (!concepto.trim() || !numeroFactura.trim() || !valor || !fecha) {
      setError("Completa concepto, N° de factura, valor y fecha.");
      return;
    }

    setGuardando(true);
    try {
      let soporte: { key: string; nombre: string; mime: string } | undefined;

      if (archivo) {
        const response = await fetch(`/api/clientes/${clienteId}/cuenta/soporte`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            fileName: archivo.name,
            contentType: archivo.type,
            sizeBytes: archivo.size,
          }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const mensaje =
            body && typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : "No fue posible preparar la subida del PDF.";
          throw new Error(mensaje);
        }
        const { uploadUrl, key } = body as { uploadUrl: string; key: string };
        await subirArchivoDirecto(uploadUrl, archivo);
        soporte = { key, nombre: archivo.name, mime: archivo.type };
      }

      const actualizada = await registrarMovimiento(clienteId, {
        rol: "PROVEEDOR",
        tipo: "ABONO",
        origen: "CARGO_MANUAL",
        lineaServicio: "TRAMITE",
        concepto: concepto.trim(),
        numeroFactura: numeroFactura.trim(),
        valor: valor.replace(/\D/g, ""),
        // Día del calendario tal cual (AAAA-MM-DD): el servidor lo ancla al
        // mediodía de Bogotá para que no se muestre como el día anterior.
        fecha,
        soporte,
      });

      if (actualizada) {
        onGuardado(actualizada);
        toast({
          title: `Factura ${numeroFactura.trim()} registrada`,
          description: `Ahora le debemos a ${corto}: ${formatCOP(actualizada.pendienteProveedor)}`,
          variant: "success",
        });
      }
      onClose();
    } catch (caught: unknown) {
      setError(describirError(caught, "No fue posible registrar la factura."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Registrar factura"
      description={
        <>
          <span className="block font-medium text-slate-700">de {corto}</span>
          <span className="mt-0.5 block">
            Factura que {corto} le cobra a Galcomex y que no pertenece a ningún trámite (por
            ejemplo una mensualidad). Suma a lo que le debemos.
          </span>
        </>
      }
      size="md"
      dismissible={!guardando}
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-600">Concepto *</span>
          <input
            list="conceptos-factura-contraparte"
            value={concepto}
            onChange={(e) => setConcepto(e.target.value)}
            required
            placeholder="Servicios aduaneros"
            className={claseCampo(false)}
          />
          <datalist id="conceptos-factura-contraparte">
            {conceptosUsados.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">N° de factura *</span>
            <input
              value={numeroFactura}
              onChange={(e) => setNumeroFactura(e.target.value)}
              required
              placeholder="FE-1234"
              className={claseCampo(false)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">Valor (COP) *</span>
            <CampoMoneda value={valor} onValueChange={setValor} required placeholder="4.500.000" className={claseCampo(false, "font-mono")} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-600">Fecha de la factura *</span>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required className={claseCampo(false)} />
          </label>
        </div>

        <div className="block space-y-1">
          <span className="text-xs font-medium text-slate-600">PDF de la factura (opcional)</span>
          <input
            ref={inputArchivoRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => inputArchivoRef.current?.click()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-slate-300 bg-slate-100 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-200"
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
              Adjuntar PDF
            </button>
            <span className="min-w-0 flex-1 break-words text-xs text-slate-600">
              {archivo ? (
                <span className="inline-flex items-center gap-1">
                  <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {archivo.name}
                </span>
              ) : (
                "Ningún archivo"
              )}
            </span>
            {archivo ? (
              <button
                type="button"
                onClick={() => {
                  setArchivo(null);
                  if (inputArchivoRef.current) inputArchivoRef.current.value = "";
                }}
                className="inline-flex h-7 shrink-0 items-center border border-slate-300 bg-white px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
              >
                Quitar
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={guardando} className="inline-flex h-9 items-center border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Cancelar
          </button>
          <button type="submit" disabled={guardando} className="inline-flex h-9 items-center gap-1.5 border border-slate-950 bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
            {guardando ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Receipt className="h-3.5 w-3.5" aria-hidden="true" />}
            Registrar factura
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
