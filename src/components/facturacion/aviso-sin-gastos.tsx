/**
 * Aviso ámbar (NO bloqueante) para quien revisa el borrador: el DO es de una
 * empresa sin anticipos y no tiene gastos pagados por Galcomex registrados
 * (M2 de la revisión INTEG-B, 29-sep-2026).
 *
 * El servidor manda el texto en `borrador.avisoSinGastos` (ver
 * `lib/borradores/aviso-sin-gastos.ts`), solo mientras el borrador sigue por
 * revisar. Aquí solo se pinta: no cambia montos ni impide aprobar; su único fin
 * es que, si Galcomex pagó algo por el cliente (VUCE, puerto, transporte) y no se
 * registró, se registre ANTES de aprobar. Nunca va a comentariosCabecera (viaja
 * a Siigo y lo ve el cliente).
 */

import { AlertTriangle } from "lucide-react";

export function AvisoSinGastos({ aviso }: { aviso: string | null | undefined }) {
  if (!aviso) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      <p>{aviso}</p>
    </div>
  );
}
