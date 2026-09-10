/**
 * Piezas mínimas para pintar errores de validación del servidor junto al
 * campo (Zod `details` → `erroresPorCampo`). Sin lógica: solo clases y texto.
 */

const BASE_INPUT =
  "h-10 w-full border px-3 text-sm outline-none transition focus:border-cyan-600";

/** Clases del input/select; con error el borde va en rojo. */
export function claseCampo(invalido: boolean, extra = ""): string {
  return `${BASE_INPUT} ${
    invalido ? "border-rose-500 bg-rose-50/40" : "border-slate-300"
  } ${extra}`.trim();
}

/** Mensaje bajo el campo. `id` enlaza con `aria-describedby` del input. */
export function MensajeCampo({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} className="text-xs text-rose-600" role="alert">
      {error}
    </p>
  );
}
