"use client";

import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type InputHTMLAttributes,
} from "react";

/**
 * Campo de dinero en COP: mientras se escribe, muestra separador de miles
 * ("200.000"). El valor real (`value` / `onValueChange`) siempre son dígitos
 * ("200000"), nunca el texto formateado — así el resto de la app sigue
 * trabajando en pesos enteros (BigInt) sin tocar el formato.
 *
 *   <CampoMoneda value={montoRaw} onValueChange={setMontoRaw} placeholder="5.800.000" />
 *
 * Con `name`, además agrega un `<input type="hidden">` con los dígitos para
 * que los formularios basados en `FormData` (sin `value`/`onValueChange`
 * controlados) sigan funcionando: el input visible no lleva `name`.
 */

export type CampoMonedaProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "name"
> & {
  /** Valor controlado: solo dígitos ("200000"), con "-" al inicio si permitirNegativo. "" = vacío. */
  value?: string;
  /** Valor inicial sin controlar, mismo formato. */
  defaultValue?: string;
  /** Recibe siempre los dígitos crudos, nunca el texto formateado. */
  onValueChange?: (digitos: string) => void;
  /** Si se da, agrega <input type="hidden" name={name}> para formularios con FormData. */
  name?: string;
  /** Permite un "-" inicial (montos negativos). Por defecto false. */
  permitirNegativo?: boolean;
  /** Muestra "$" dentro del campo. Por defecto true. */
  prefijo?: boolean;
  /** Clases para el <span> contenedor (el input conserva `className`). */
  wrapperClassName?: string;
};

// useLayoutEffect en el servidor genera warning (Next hace SSR de client
// components); en el navegador sí lo necesitamos para mover el caret antes
// del paint.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** "1234567" -> "1.234.567", "-45712" -> "-45.712", "" -> "" */
export function formatearMilesCOP(digitos: string): string {
  if (!digitos) return "";
  const negativo = digitos.startsWith("-");
  const soloDigitos = negativo ? digitos.slice(1) : digitos;
  if (!soloDigitos) return negativo ? "-" : "";
  const agrupado = soloDigitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return negativo ? `-${agrupado}` : agrupado;
}

/**
 * Extrae dígitos de texto escrito o pegado: "$ 200.000,50" -> "200000" (la
 * coma es separador decimal, los decimales se descartan), quita ceros a la
 * izquierda ("007" -> "7", "0" -> "0") y limita a 15 dígitos.
 */
export function digitosDesdeTextoCOP(texto: string, permitirNegativo = false): string {
  if (!texto) return "";
  const negativo = permitirNegativo && texto.includes("-");
  const parteEntera = texto.split(",")[0] ?? "";
  const soloDigitos = parteEntera.replace(/\D/g, "");
  const sinCerosIniciales = soloDigitos.replace(/^0+(?=\d)/, "");
  const limitado = sinCerosIniciales.slice(0, 15);
  if (!limitado) return negativo ? "-" : "";
  return negativo ? `-${limitado}` : limitado;
}

/** Cuenta dígitos y el signo "-" (los únicos caracteres que sobreviven al formateo). */
function contarSignificativos(texto: string): number {
  return (texto.match(/[-\d]/g) ?? []).length;
}

/** Posición en `texto` justo después del n-ésimo dígito/signo. */
function posicionTrasSignificativos(texto: string, n: number): number {
  if (n <= 0) return 0;
  let contados = 0;
  for (let i = 0; i < texto.length; i++) {
    if (/[-\d]/.test(texto[i])) {
      contados++;
      if (contados >= n) return i + 1;
    }
  }
  return texto.length;
}

export const CampoMoneda = forwardRef<HTMLInputElement, CampoMonedaProps>(function CampoMoneda(
  {
    value,
    defaultValue,
    onValueChange,
    name,
    permitirNegativo = false,
    prefijo = true,
    wrapperClassName,
    style,
    className,
    ...rest
  },
  ref,
) {
  const controlado = value !== undefined;
  const [interno, setInterno] = useState(() =>
    digitosDesdeTextoCOP(defaultValue ?? "", permitirNegativo),
  );
  const digitos = controlado ? digitosDesdeTextoCOP(value ?? "", permitirNegativo) : interno;
  const formateado = formatearMilesCOP(digitos);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const caretPendiente = useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (caretPendiente.current === null) return;
    const el = inputRef.current;
    if (el) {
      const pos = posicionTrasSignificativos(formateado, caretPendiente.current);
      el.setSelectionRange(pos, pos);
    }
    caretPendiente.current = null;
  }, [formateado]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const texto = event.target.value;
    const caret = event.target.selectionStart ?? texto.length;
    caretPendiente.current = contarSignificativos(texto.slice(0, caret));

    const nuevosDigitos = digitosDesdeTextoCOP(texto, permitirNegativo);
    if (!controlado) setInterno(nuevosDigitos);
    onValueChange?.(nuevosDigitos);
  }

  function setRefs(node: HTMLInputElement | null) {
    inputRef.current = node;
    if (typeof ref === "function") {
      ref(node);
    } else if (ref && "current" in ref) {
      (ref as { current: HTMLInputElement | null }).current = node;
    }
  }

  const estiloInput: CSSProperties | undefined = prefijo ? { ...style, paddingLeft: "1.75rem" } : style;

  return (
    // `block` (no `inline-block`): así un input con `w-full` sigue ocupando todo
    // el ancho de su celda. En filas flex, pasar `wrapperClassName="flex-1"`.
    <span className={`relative block${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
      {prefijo ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500"
        >
          $
        </span>
      ) : null}
      <input
        {...rest}
        ref={setRefs}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={formateado}
        onChange={handleChange}
        className={className}
        style={estiloInput}
      />
      {name !== undefined ? <input type="hidden" name={name} value={digitos} /> : null}
    </span>
  );
});
