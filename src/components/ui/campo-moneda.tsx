"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent,
  type InputHTMLAttributes,
} from "react";

import {
  MENSAJE_DINERO_USUARIO,
  centavosDeTexto,
  centavosDeTextoUsuario,
  formatoEdicion,
  formatoPesos,
  mensajeComaAmbigua,
  redondearAPeso,
  textoCanonicoDeCentavos,
  type Centavos,
  type MotivoDineroUsuario,
} from "@/lib/dinero";

/**
 * Campo de dinero en COP con centavos (fase centavos, diseño A.8).
 *
 * - `value` / `defaultValue`: PESOS como texto de máquina, el mismo que habla
 *   la API: "502801.45", "200000", "502801.00" (también se acepta el entero
 *   heredado). "" = vacío.
 * - `onValueChange(texto, detalle)`: emite pesos texto CANÓNICO ("200000",
 *   "502801.45"), listo para mandar a la API; "" si está vacío o si lo escrito
 *   no es válido (y `detalle.ok = false` con el motivo). Nunca trunca: "1,500"
 *   o "1,5055" quedan marcados como error, no se recortan.
 * - Mientras se edita, el campo muestra el texto tal cual se escribe (sin
 *   puntos de miles, para que borrar un dígito no convierta "1.500" en
 *   "1.50") y una ayuda con el monto interpretado ("$ 1.500.000"); al salir
 *   muestra "502.801,45" / "1.500.000".
 * - Acepta lo que escribe o pega una persona (tabla de A.5): "502.801,45",
 *   "502801,45", "502801.45" (pegado de Excel), "$ 1.500.000".
 * - `decimales={false}`: solo pesos enteros (p. ej. comisión LM).
 * - Con `name`, agrega `<input type="hidden" name>` con el texto canónico
 *   (para formularios con FormData); el input visible no lleva `name`.
 * - «Vacío» e «inválido» emiten el mismo "" pero NO son lo mismo: lo escrito
 *   inválido marca el input visible con `setCustomValidity(mensaje)`, así un
 *   `<form onSubmit>` no se envía (el navegador muestra el mensaje). Los flujos
 *   que guardan sin `<form>` (botón con onClick, guardado al salir del campo)
 *   deben mirar `detalle.ok`; `useErroresMoneda()` lo lleva por campo.
 *
 *   <CampoMoneda value={monto} onValueChange={setMonto} placeholder="5.800.000" />
 */

export type DetalleCampoMoneda =
  | { ok: true; centavos: Centavos | null }
  | { ok: false; motivo: MotivoDineroUsuario | "CON_CENTAVOS"; mensaje: string };

export type CampoMonedaProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "name"
> & {
  /** Valor controlado: pesos texto de máquina ("502801.45", "200000"); "" = vacío. */
  value?: string;
  /** Valor inicial sin controlar, mismo formato. */
  defaultValue?: string;
  /** Recibe pesos texto canónico ("200000", "502801.45") o "" (vacío o inválido; ver `detalle`). */
  onValueChange?: (texto: string, detalle: DetalleCampoMoneda) => void;
  /** Si se da, agrega <input type="hidden" name={name}> para formularios con FormData. */
  name?: string;
  /** Permite montos negativos. Por defecto false. */
  permitirNegativo?: boolean;
  /** Permite centavos (hasta 2 decimales). Por defecto true; false = solo pesos enteros. */
  decimales?: boolean;
  /** Muestra "$" dentro del campo. Por defecto true. */
  prefijo?: boolean;
  /** Muestra el mensaje de error bajo el campo. Por defecto true. */
  mostrarError?: boolean;
  /** Clases para el <span> contenedor (el input conserva `className`). */
  wrapperClassName?: string;
};

const MENSAJE_CON_CENTAVOS = "Solo pesos enteros, sin centavos";

type Evaluacion = { texto: string; detalle: DetalleCampoMoneda };

/** Interpreta lo que escribió la persona. */
function evaluar(texto: string, permitirNegativo: boolean, decimales: boolean): Evaluacion {
  const r = centavosDeTextoUsuario(texto, { permitirNegativo });
  if (!r.ok) {
    if (r.motivo === "VACIO") return { texto: "", detalle: { ok: true, centavos: null } };
    const mensaje = r.motivo === "FORMATO" ? mensajeComaAmbigua(texto) : MENSAJE_DINERO_USUARIO[r.motivo];
    return { texto: "", detalle: { ok: false, motivo: r.motivo, mensaje } };
  }
  if (!decimales && redondearAPeso(r.valor) !== r.valor) {
    return { texto: "", detalle: { ok: false, motivo: "CON_CENTAVOS", mensaje: MENSAJE_CON_CENTAVOS } };
  }
  return { texto: textoCanonicoDeCentavos(r.valor), detalle: { ok: true, centavos: r.valor } };
}

/** Lee el `value` que da el padre (texto de máquina). null = vacío; undefined = ilegible. */
function leerValor(texto: string): Centavos | null | undefined {
  const limpio = texto.trim();
  if (limpio === "") return null;
  try {
    return centavosDeTexto(limpio);
  } catch {
    return undefined;
  }
}

export const CampoMoneda = forwardRef<HTMLInputElement, CampoMonedaProps>(function CampoMoneda(
  {
    value,
    defaultValue,
    onValueChange,
    name,
    permitirNegativo = false,
    decimales = true,
    prefijo = true,
    mostrarError = true,
    wrapperClassName,
    style,
    className,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const asignarRef = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const controlado = value !== undefined;
  const [interno, setInterno] = useState(() => {
    const c = leerValor(defaultValue ?? "");
    return c === null || c === undefined ? (defaultValue ?? "").trim() : textoCanonicoDeCentavos(c);
  });
  const valorActual = controlado ? (value ?? "") : interno;

  /** Texto tal como lo escribió la persona; null = se muestra el valor formateado. */
  const [textoUsuario, setTextoUsuario] = useState<string | null>(null);
  const [enfocado, setEnfocado] = useState(false);
  const [ultimoEmitido, setUltimoEmitido] = useState<string | null>(null);
  const [valorPrevio, setValorPrevio] = useState(valorActual);

  // Si el padre cambia `value` por su cuenta (reset, carga de datos), se
  // descarta lo que la persona tenía escrito.
  if (valorActual !== valorPrevio) {
    setValorPrevio(valorActual);
    if (valorActual !== ultimoEmitido) setTextoUsuario(null);
  }

  const centavos = leerValor(valorActual);
  const evaluacion = textoUsuario !== null ? evaluar(textoUsuario, permitirNegativo, decimales) : null;
  const error = evaluacion && !evaluacion.detalle.ok ? evaluacion.detalle.mensaje : null;

  let mostrado: string;
  if (textoUsuario !== null) mostrado = textoUsuario;
  else if (centavos === null) mostrado = "";
  else if (centavos === undefined) mostrado = valorActual;
  else mostrado = formatoEdicion(centavos, { miles: !enfocado });

  const ayuda =
    enfocado && evaluacion && evaluacion.detalle.ok && evaluacion.detalle.centavos !== null
      ? formatoPesos(evaluacion.detalle.centavos)
      : null;
  const errorVisible = mostrarError && error !== null && !enfocado;

  // Lo escrito inválido deja el input en estado inválido para el formulario:
  // un `<form onSubmit>` no se envía con este campo así (no se confunde con vacío).
  useEffect(() => {
    inputRef.current?.setCustomValidity(error ?? "");
  }, [error]);

  const idBase = useId();
  const idError = `${idBase}-error`;
  const idAyuda = `${idBase}-ayuda`;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const texto = event.target.value;
    setTextoUsuario(texto);
    const r = evaluar(texto, permitirNegativo, decimales);
    setUltimoEmitido(r.texto);
    if (!controlado) setInterno(r.texto);
    onValueChange?.(r.texto, r.detalle);
  }

  function handleFocus(event: FocusEvent<HTMLInputElement>) {
    setEnfocado(true);
    onFocus?.(event);
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    setEnfocado(false);
    // Válido: se vuelve a mostrar formateado desde el valor. Inválido: se
    // conserva lo escrito para que la persona vea qué corregir.
    if (textoUsuario !== null && evaluar(textoUsuario, permitirNegativo, decimales).detalle.ok) {
      setTextoUsuario(null);
    }
    onBlur?.(event);
  }

  const estiloInput: CSSProperties | undefined = prefijo ? { ...style, paddingLeft: "1.75rem" } : style;
  const describedBy =
    [rest["aria-describedby"], errorVisible ? idError : null, ayuda ? idAyuda : null].filter(Boolean).join(" ") ||
    undefined;
  const valorOculto = centavos === null || centavos === undefined ? "" : textoCanonicoDeCentavos(centavos);

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
        ref={asignarRef}
        type="text"
        inputMode={decimales ? "decimal" : "numeric"}
        autoComplete="off"
        value={mostrado}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        aria-invalid={errorVisible ? true : rest["aria-invalid"]}
        aria-describedby={describedBy}
        className={className}
        style={estiloInput}
      />
      {ayuda ? (
        <span
          id={idAyuda}
          data-campo-moneda="ayuda"
          className="pointer-events-none absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600 shadow-sm"
        >
          {ayuda}
        </span>
      ) : null}
      {errorVisible ? (
        <span id={idError} role="alert" data-campo-moneda="error" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      ) : null}
      {name !== undefined ? <input type="hidden" name={name} value={valorOculto} /> : null}
    </span>
  );
});

/**
 * Lleva, por campo, si lo escrito en un `CampoMoneda` es inválido. Sirve para
 * los flujos que guardan sin `<form>` nativo, o para dar un mensaje propio:
 *
 *   const errores = useErroresMoneda();
 *   <CampoMoneda onValueChange={(t, d) => { setCif(t); errores.registrar("Valor CIF", d); }} />
 *   if (errores.primerError) { setError(errores.primerError); return; }   // no guardar
 *
 * `primerError` = "Valor CIF: <mensaje del campo>" o null.
 */
export function useErroresMoneda() {
  const [errores, setErrores] = useState<Readonly<Record<string, string>>>({});

  const registrar = useCallback((campo: string, detalle: DetalleCampoMoneda) => {
    setErrores((prev) => {
      if (detalle.ok) return sinCampo(prev, campo);
      if (prev[campo] === detalle.mensaje) return prev;
      return { ...prev, [campo]: detalle.mensaje };
    });
  }, []);

  /** Olvida el error de un campo (al cancelar la edición o quitar la fila). */
  const quitar = useCallback((campo: string) => setErrores((prev) => sinCampo(prev, campo)), []);

  const limpiar = useCallback(() => setErrores({}), []);

  const primero = Object.entries(errores)[0];
  const primerError = primero ? `${primero[0]}: ${primero[1]}` : null;
  return { errores, primerError, registrar, quitar, limpiar };
}

function sinCampo(prev: Readonly<Record<string, string>>, campo: string): Readonly<Record<string, string>> {
  if (!(campo in prev)) return prev;
  const resto = { ...prev };
  delete resto[campo];
  return resto;
}
